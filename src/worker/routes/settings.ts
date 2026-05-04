import { Hono } from "hono";
import { isSourceId, type SourceId } from "../../shared/sources.js";
import { createLinearClient, fetchTeams } from "../integrations/linear.js";
import { SlackClient } from "../integrations/slack.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings", async (c) => {
  const user = c.get("user");
  return c.json({ settings: user.settings });
});

settingsRoutes.patch("/settings", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await c.req.json<Record<string, unknown>>();

  const updates: string[] = [];
  const binds: unknown[] = [];

  // Accept both camelCase (from frontend) and snake_case
  const budgetCap = body.budgetCapMonthly ?? body.budget_cap_monthly;
  const relevanceThreshold = body.relevanceThreshold ?? body.relevance_threshold;
  const nearMissFloor = body.nearMissFloor ?? body.near_miss_floor;
  const signalSurfaceMap = body.signalSurfaceMap ?? body.source_config;

  // Admin-only fields. `filterPrompt` and `sourceFilterOverrides`
  // remain user-level (they personalize what's relevant for THIS user
  // without changing what the deployment fetches), but every other
  // PATCHable field — budget cap, thresholds, source filters, AI
  // model picks, voice defaults — is deployment-wide and gated to
  // the admin. Reject the whole request if a non-admin tries to set
  // any of them so the client gets a clear 403 rather than a silent
  // no-op.
  const adminFieldsPresent =
    budgetCap !== undefined ||
    relevanceThreshold !== undefined ||
    nearMissFloor !== undefined ||
    signalSurfaceMap !== undefined;
  if (adminFieldsPresent && !user.isAdmin) {
    return c.json(
      {
        error: "Admin only",
        reason:
          "Sources, AI model picks, voice defaults, and limits are deployment-wide settings. Only the admin can change them.",
      },
      403,
    );
  }

  if (budgetCap !== undefined) {
    const val = Number(budgetCap);
    if (isNaN(val) || val < 0) return c.json({ error: "budgetCapMonthly must be a non-negative number" }, 400);
    updates.push("budget_cap_monthly = ?");
    binds.push(val);
  }

  if (relevanceThreshold !== undefined) {
    const val = Number(relevanceThreshold);
    if (isNaN(val) || val < 0 || val > 1) return c.json({ error: "relevanceThreshold must be between 0 and 1" }, 400);
    updates.push("relevance_threshold = ?");
    binds.push(val);
  }

  if (nearMissFloor !== undefined) {
    const val = Number(nearMissFloor);
    if (isNaN(val) || val < 0 || val > 1) return c.json({ error: "nearMissFloor must be between 0 and 1" }, 400);
    updates.push("near_miss_floor = ?");
    binds.push(val);
  }

  if (signalSurfaceMap !== undefined) {
    const incoming = signalSurfaceMap;
    if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming))
      return c.json({ error: "source_config must be a JSON object" }, 400);

    try {
      JSON.stringify(incoming);
    } catch {
      return c.json({ error: "source_config contains invalid JSON" }, 400);
    }

    const existing = user.settings.signalSurfaceMap as Record<string, unknown>;
    const merged = deepMerge(existing, incoming as Record<string, unknown>);
    updates.push("source_config = ?");
    binds.push(JSON.stringify(merged));
  }

  const filterPrompt = body.filterPrompt ?? body.filter_prompt;
  if (filterPrompt !== undefined) {
    if (filterPrompt !== null && typeof filterPrompt !== "string")
      return c.json({ error: "filterPrompt must be a string or null" }, 400);
    updates.push("filter_prompt = ?");
    binds.push(filterPrompt);
  }

  const sourceFilterOverrides = body.sourceFilterOverrides ?? body.source_filter_overrides;
  if (sourceFilterOverrides !== undefined) {
    if (
      typeof sourceFilterOverrides !== "object" ||
      sourceFilterOverrides === null ||
      Array.isArray(sourceFilterOverrides)
    )
      return c.json({ error: "sourceFilterOverrides must be a JSON object" }, 400);
    updates.push("source_filter_overrides = ?");
    binds.push(JSON.stringify(sourceFilterOverrides));
  }

  // Per-user opt-in list of source IDs. User-level on purpose: this
  // governs what shows up in THIS user's briefing, not what the
  // deployment fetches. Validate against the live registry so a typo
  // can't quietly disable a real source — unknown IDs are dropped
  // rather than rejected, because the registry can shrink (a provider
  // file gets removed) and we don't want stale entries to brick the
  // settings PATCH.
  const enabledSourceIds = body.enabledSourceIds ?? body.enabled_source_ids;
  if (enabledSourceIds !== undefined) {
    if (!Array.isArray(enabledSourceIds)) return c.json({ error: "enabledSourceIds must be an array of strings" }, 400);
    if (!enabledSourceIds.every((v) => typeof v === "string"))
      return c.json({ error: "enabledSourceIds must contain only strings" }, 400);
    // Validate against the canonical literal union from
    // `shared/sources.ts` rather than the live registry — they're
    // the same set, but the literal union is the contract the
    // frontend types against, so checking the same list keeps the
    // two trust boundaries in lockstep. Unknown IDs are dropped
    // (rather than rejected) for the same reason migration 0004's
    // backfill would have been: a deployment can shrink its source
    // list and we don't want stale entries to brick the PATCH.
    const cleaned: SourceId[] = Array.from(
      new Set((enabledSourceIds as string[]).filter((id): id is SourceId => isSourceId(id))),
    );
    updates.push("enabled_source_ids = ?");
    binds.push(JSON.stringify(cleaned));
  }

  if (updates.length === 0) {
    return c.json({ settings: user.settings });
  }

  updates.push("updated_at = datetime('now')");
  binds.push(user.userId);

  await db
    .prepare(`UPDATE user_settings SET ${updates.join(", ")} WHERE user_id = ?`)
    .bind(...binds)
    .run();

  const settingsRow = await db.prepare("SELECT * FROM user_settings WHERE user_id = ?").bind(user.userId).first<{
    budget_cap_monthly: number;
    briefing_cron: string;
    relevance_threshold: number;
    near_miss_floor: number;
    retention_days: number;
    source_config: string;
    filter_prompt: string | null;
    source_filter_overrides: string | null;
    enabled_source_ids: string | null;
  }>();

  let overrides: Record<string, string> = {};
  try {
    if (settingsRow?.source_filter_overrides) overrides = JSON.parse(settingsRow.source_filter_overrides);
  } catch {
    /* ignore */
  }

  let updatedEnabledSourceIds: SourceId[] = [];
  try {
    if (settingsRow?.enabled_source_ids) {
      const parsed = JSON.parse(settingsRow.enabled_source_ids);
      if (Array.isArray(parsed)) {
        updatedEnabledSourceIds = parsed.filter((v): v is SourceId => typeof v === "string" && isSourceId(v));
      }
    }
  } catch {
    /* ignore */
  }

  const updatedSettings = {
    budgetCapMonthly: settingsRow?.budget_cap_monthly ?? user.settings.budgetCapMonthly,
    briefingCron: settingsRow?.briefing_cron ?? user.settings.briefingCron,
    relevanceThreshold: settingsRow?.relevance_threshold ?? user.settings.relevanceThreshold,
    nearMissFloor: settingsRow?.near_miss_floor ?? user.settings.nearMissFloor,
    retentionDays: settingsRow?.retention_days ?? user.settings.retentionDays,
    signalSurfaceMap: settingsRow?.source_config
      ? JSON.parse(settingsRow.source_config)
      : user.settings.signalSurfaceMap,
    filterPrompt: settingsRow?.filter_prompt ?? null,
    sourceFilterOverrides: overrides,
    enabledSourceIds: updatedEnabledSourceIds,
  };

  return c.json({ settings: updatedSettings });
});

settingsRoutes.get("/slack/channels", async (c) => {
  const client = new SlackClient(c.env.SLACK_TOKEN);
  try {
    const channels = await client.listChannels();
    return c.json({ channels });
  } catch (err) {
    console.error("[settings] Failed to list Slack channels:", err);
    return c.json({ channels: [] });
  }
});

settingsRoutes.get("/linear/teams", async (c) => {
  const client = createLinearClient(c.env.LINEAR_API_KEY);
  try {
    const teams = await fetchTeams(client);
    return c.json({ teams });
  } catch (err) {
    console.error("[settings] Failed to list Linear teams:", err);
    return c.json({ teams: [] });
  }
});

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}
