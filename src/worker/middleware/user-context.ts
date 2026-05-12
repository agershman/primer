import { createMiddleware } from "hono/factory";
import { nanoid } from "nanoid";
import { isSourceId, type SourceId } from "../../shared/sources.js";
import { DEFAULT_SIGNAL_SURFACE_MAP } from "../config/signal-surfaces.js";
import type { Env, UserContext, UserSettings } from "../types.js";
import { resolveRequestTimezone } from "../util/time.js";
import { type AuthContext, AuthError, createAuthProvider } from "./auth/index.js";

type Variables = { user: UserContext };

export const userContext = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  // The provider's `authenticate` runs the email allowlist before
  // returning. That ordering is load-bearing: the admin-bootstrap
  // INSERT below promotes the first row in `users` to admin, so a
  // non-allowlisted caller reaching this point on a fresh deploy
  // would permanently capture admin. Pinned by
  // tests/unit/auth/auth-providers-contract.test.ts.
  let auth: AuthContext;
  try {
    const provider = createAuthProvider(c.env);
    auth = await provider.authenticate(c.req.raw);
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ error: err.message }, err.status as 401 | 403);
    }
    throw err;
  }
  const db = c.env.DB;

  const userId = `usr_${nanoid(10)}`;

  // First-user-wins admin bootstrap. The CASE inside the SELECT
  // evaluates against the same write transaction as the INSERT, so two
  // concurrent first-time provisions can't both stamp themselves admin —
  // SQLite serializes writes and the second sees count = 1. The
  // `WHERE NOT EXISTS` guard makes the statement idempotent on a row
  // that already exists (re-login of an existing user).
  //
  // Why not split into "SELECT COUNT … then INSERT": that races on
  // simultaneous first-time provisions of two distinct emails and could
  // mark both admin. The atomic INSERT-SELECT closes the race.
  await db
    .prepare(
      `INSERT INTO users (id, email, is_admin, created_at, updated_at)
       SELECT ?, ?,
              CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END,
              datetime('now'), datetime('now')
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
    )
    .bind(userId, auth.email, auth.email)
    .run();

  const userRow = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name,
              u.current_focus_version_id, fv.statement AS focus_statement,
              u.current_about_version_id, av.statement AS about_statement,
              u.timezone, u.is_admin, u.welcomed_as_admin_at
       FROM users u
       LEFT JOIN focus_statement_versions fv ON fv.id = u.current_focus_version_id
       LEFT JOIN about_statement_versions av ON av.id = u.current_about_version_id
       WHERE u.email = ?`,
    )
    .bind(auth.email)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      current_focus_version_id: string | null;
      focus_statement: string | null;
      current_about_version_id: string | null;
      about_statement: string | null;
      timezone: string | null;
      is_admin: number | null;
      welcomed_as_admin_at: string | null;
    }>();

  if (!userRow) {
    return c.json({ error: "Failed to resolve user" }, 500);
  }

  // Resolve the request's timezone: header wins (validated), fall back
  // to the persisted column. Persist async if the header diverged from
  // the stored value — that's how travelers get cron-correct briefings
  // the next morning without any explicit "update timezone" action.
  // We don't block the request on the write; if it fails we just try
  // again on the next request.
  const headerTz = c.req.header("X-Client-Timezone");
  const { timezone, shouldPersist } = resolveRequestTimezone(headerTz, userRow.timezone);
  if (shouldPersist) {
    db.prepare(`UPDATE users SET timezone = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(timezone, userRow.id)
      .run()
      .catch((err) => {
        console.warn("[user-context] failed to persist user.timezone:", err);
      });
  }

  const defaultMap = JSON.stringify(DEFAULT_SIGNAL_SURFACE_MAP);
  await db
    .prepare(
      `INSERT OR IGNORE INTO user_settings (user_id, budget_cap_monthly, relevance_threshold, near_miss_floor, retention_days, source_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      userRow.id,
      parseFloat(c.env.BUDGET_CAP_MONTHLY || "35"),
      parseFloat(c.env.RELEVANCE_THRESHOLD || "0.4"),
      parseFloat(c.env.NEAR_MISS_FLOOR || "0.25"),
      parseInt(c.env.RETENTION_DAYS || "365", 10),
      defaultMap,
    )
    .run();

  const settingsRow = await db.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(userRow.id).first<{
    budget_cap_monthly: number;
    briefing_cron: string;
    relevance_threshold: number;
    near_miss_floor: number;
    retention_days: number;
    source_config: string;
    filter_prompt: string | null;
    source_filter_overrides: string | null;
    enabled_source_ids: string | null;
    show_audit_marks: number;
  }>();

  let sourceFilterOverrides: Record<string, string> = {};
  try {
    if (settingsRow?.source_filter_overrides) {
      sourceFilterOverrides = JSON.parse(settingsRow.source_filter_overrides);
    }
  } catch {
    /* ignore malformed JSON */
  }

  let enabledSourceIds: SourceId[] = [];
  try {
    if (settingsRow?.enabled_source_ids) {
      const parsed = JSON.parse(settingsRow.enabled_source_ids);
      if (Array.isArray(parsed)) {
        // Defensive narrowing at the trust boundary — the JSON
        // column can in principle hold any string (older deploys,
        // bad PATCH input that pre-dated validation, etc.). Drop
        // anything that isn't a known `SourceId` so downstream code
        // can rely on the literal union.
        enabledSourceIds = parsed.filter((v): v is SourceId => typeof v === "string" && isSourceId(v));
      }
    }
  } catch {
    /* ignore malformed JSON — empty list means nothing fans out */
  }

  const settings: UserSettings = {
    budgetCapMonthly: settingsRow?.budget_cap_monthly ?? 35,
    briefingCron: settingsRow?.briefing_cron ?? "0 5 * * *",
    relevanceThreshold: settingsRow?.relevance_threshold ?? 0.4,
    nearMissFloor: settingsRow?.near_miss_floor ?? 0.25,
    retentionDays: settingsRow?.retention_days ?? 365,
    signalSurfaceMap: settingsRow?.source_config ? JSON.parse(settingsRow.source_config) : DEFAULT_SIGNAL_SURFACE_MAP,
    filterPrompt: settingsRow?.filter_prompt ?? null,
    sourceFilterOverrides,
    enabledSourceIds,
    // Defaults FALSE when the column is null. The audit indicator
    // pill already surfaces "Audited · N dropped" prominently —
    // inline wavy underlines on top of that are distracting noise
    // for everyday reading. Users opt-in per piece via the
    // indicator dropdown's "Show audit marks" toggle.
    showAuditMarks: settingsRow?.show_audit_marks == null ? false : Number(settingsRow.show_audit_marks) === 1,
  };

  c.set("user", {
    userId: userRow.id,
    email: userRow.email,
    displayName: userRow.display_name,
    focusStatement: userRow.focus_statement,
    focusVersionId: userRow.current_focus_version_id,
    aboutStatement: userRow.about_statement,
    aboutVersionId: userRow.current_about_version_id,
    timezone,
    settings,
    identity: auth.identity,
    isDev: auth.isDev,
    // Coerce SQLite's 0/1 INTEGER → boolean for the rest of the app.
    isAdmin: (userRow.is_admin ?? 0) === 1,
    welcomedAsAdminAt: userRow.welcomed_as_admin_at,
  });

  await next();
});
