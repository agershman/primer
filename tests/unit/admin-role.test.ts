/**
 * Tests for the simple admin / regular-user distinction.
 *
 * Two-bucket model: `users.is_admin` is a single boolean. The first
 * user to provision a fresh deployment becomes admin (handled by the
 * atomic INSERT-SELECT in `worker/middleware/user-context.ts`); every
 * subsequent user is a regular user. Admins can configure deployment-
 * wide settings (sources, AI model picks, voice defaults, budget
 * caps); regular users can only adjust their own personalization
 * (About, Focus, relevance filter prompt + per-source overrides).
 *
 * Coverage:
 *   1. Migration shape — column exists with correct default + the
 *      backfill that marks the earliest existing user as admin so an
 *      installed system upgrades cleanly.
 *   2. Middleware — atomic INSERT-SELECT bootstraps admin only when
 *      `users` is empty; UserContext carries `isAdmin`.
 *   3. UserContext type carries `isAdmin: boolean`.
 *   4. /api/me returns `isAdmin`.
 *   5. PATCH /settings rejects admin-only fields (signalSurfaceMap /
 *      budgetCapMonthly / relevanceThreshold / nearMissFloor) for
 *      non-admins; allows filterPrompt + sourceFilterOverrides.
 *   6. Source-instance CRUD endpoints + `/piece/:id/regenerate` are
 *      gated on admin.
 *   7. SettingsModal filters nav for non-admins.
 *   8. Per-piece "↻ try different model" + inline VoiceSwitcher are
 *      wrapped in `<AdminOnly>` so non-admins don't see them.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("Migration 0002_user_admin.sql", () => {
  it("adds is_admin column with default 0", async () => {
    const src = await read("migrations/0002_user_admin.sql");
    expect(src).toMatch(
      /ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0/i,
    );
  });

  it("backfills the earliest existing user as admin so installed systems upgrade cleanly", async () => {
    const src = await read("migrations/0002_user_admin.sql");
    expect(src).toMatch(/UPDATE users\s*SET is_admin = 1/i);
    expect(src).toMatch(/ORDER BY created_at ASC LIMIT 1/i);
  });
});

describe("Migration 0003_user_admin_welcome.sql", () => {
  it("adds welcomed_as_admin_at TEXT column", async () => {
    const src = await read("migrations/0003_user_admin_welcome.sql");
    expect(src).toMatch(/ALTER TABLE users ADD COLUMN welcomed_as_admin_at TEXT/i);
  });

  it("backfills existing admins so the welcome dialog doesn't pop after upgrade", async () => {
    // Existing admins on an installed deployment know they're admin
    // already. Stamping their row at migration time means only
    // freshly-promoted users (post-migration) see the dialog.
    const src = await read("migrations/0003_user_admin_welcome.sql");
    expect(src).toMatch(/UPDATE users\s*SET welcomed_as_admin_at = datetime\('now'\)/i);
    expect(src).toMatch(/WHERE is_admin = 1/i);
  });
});

describe("Bootstrap admin welcome — server contract", () => {
  it("/api/me returns needsBootstrapWelcome computed from isAdmin + welcomedAsAdminAt", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(
      /needsBootstrapWelcome:\s*user\.isAdmin && user\.welcomedAsAdminAt === null/,
    );
  });

  it("POST /api/me/welcome-acknowledged sets the timestamp idempotently", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/post\("\/me\/welcome-acknowledged"/);
    expect(src).toMatch(/UPDATE users SET welcomed_as_admin_at = datetime\('now'\)/i);
    // Idempotency guard — already-set rows aren't touched again.
    expect(src).toMatch(/WHERE id = \? AND welcomed_as_admin_at IS NULL/i);
  });

  it("user-context middleware reads welcomed_as_admin_at and surfaces it on UserContext", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    expect(src).toMatch(/u\.welcomed_as_admin_at/);
    expect(src).toMatch(/welcomedAsAdminAt:\s*userRow\.welcomed_as_admin_at/);
  });

  it("UserContext type carries welcomedAsAdminAt: string | null", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toMatch(/welcomedAsAdminAt:\s*string \| null/);
  });
});

describe("Bootstrap admin welcome — frontend contract", () => {
  it("CurrentUser type carries needsBootstrapWelcome: boolean", async () => {
    const src = await read("src/frontend/hooks/useCurrentUser.tsx");
    expect(src).toMatch(/needsBootstrapWelcome:\s*boolean/);
  });

  it("App.tsx renders BootstrapAdminWelcome when needsBootstrapWelcome is true", async () => {
    const src = await read("src/frontend/App.tsx");
    expect(src).toContain("BootstrapAdminWelcome");
    expect(src).toMatch(/user\?\.needsBootstrapWelcome/);
    // Onboarding takes priority — a fresh-install admin sets up
    // About + Focus first, the admin welcome explains roles after.
    expect(src).toMatch(/!needsOnboarding && user\?\.needsBootstrapWelcome/);
  });

  it("BootstrapAdminWelcome calls /api/me/welcome-acknowledged on dismiss", async () => {
    const src = await read("src/frontend/components/BootstrapAdminWelcome.tsx");
    expect(src).toMatch(/apiPost\("\/api\/me\/welcome-acknowledged"/);
    // Names the Settings → Users surface so the user knows where
    // to go to manage other users.
    expect(src).toMatch(/Settings.*Users/);
  });
});

describe("Users routes — admin-only management surface", () => {
  it("GET /api/users is admin-gated via requireAdmin middleware", async () => {
    const src = await read("src/worker/routes/users.ts");
    expect(src).toMatch(/requireAdmin/);
    expect(src).toMatch(/userRoutes\.use\("\/users", requireAdmin\)/);
    expect(src).toMatch(/userRoutes\.use\("\/users\/\*", requireAdmin\)/);
  });

  it("PATCH /api/users/:id refuses to demote the last remaining admin", async () => {
    const src = await read("src/worker/routes/users.ts");
    // Last-admin protection is the load-bearing safety: without it,
    // a single-admin deployment could lock itself out via the UI.
    expect(src).toMatch(/SELECT COUNT\(\*\) as count FROM users WHERE is_admin = 1/i);
    expect(src).toMatch(/adminCount <= 1/);
    expect(src).toMatch(/"Last admin"/);
    expect(src).toMatch(/409/);
  });

  it("PATCH /api/users/:id flags self-demotion in the response", async () => {
    const src = await read("src/worker/routes/users.ts");
    // Frontend uses `selfDemoted` to refresh /api/me upstream so
    // the SettingsModal nav collapses immediately.
    expect(src).toMatch(/selfDemoted:\s*targetId === caller\.userId/);
  });

  it("userRoutes is mounted in worker/index.ts", async () => {
    const src = await read("src/worker/index.ts");
    expect(src).toContain('from "./routes/users.js"');
    expect(src).toMatch(/app\.route\("\/api", userRoutes\)/);
  });
});

describe("Users panel — Settings UI wiring", () => {
  it("SettingsModal registers the Users panel under General with the IconUsers glyph", async () => {
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(src).toMatch(/UsersPanel/);
    expect(src).toMatch(/IconUsers/);
    expect(src).toMatch(/id:\s*"users"[\s\S]{0,200}group:\s*"General"/);
  });

  it("Users panel is admin-only — not in REGULAR_USER_PANEL_IDS", async () => {
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    // Ordering pin: the regular-user whitelist must NOT include
    // "users" — adding it accidentally would expose the admin
    // surface to non-admins (server still 403s, but it's a UX bug).
    const regularSet = src.match(/REGULAR_USER_PANEL_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(regularSet).toBeTruthy();
    expect(regularSet![1]).not.toMatch(/"users"/);
  });

  it("UsersPanel shows promote/demote buttons and a confirmation dialog", async () => {
    const src = await read("src/frontend/components/settings/panels/UsersPanel.tsx");
    expect(src).toMatch(/Promote to admin/);
    expect(src).toMatch(/Demote to regular user/);
    expect(src).toMatch(/ConfirmRoleChange/);
    // Last-admin error is surfaced inline on the row, not silently
    // swallowed.
    expect(src).toMatch(/extractLastAdminReason/);
  });
});

describe("user-context middleware bootstrap", () => {
  it("uses an atomic INSERT-SELECT so the first user becomes admin without racing", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    // The CASE WHEN COUNT(*) = 0 evaluates inside the same write
    // transaction as the INSERT, so two concurrent first-time
    // provisions can't both stamp themselves admin.
    expect(src).toMatch(
      /INSERT INTO users[\s\S]{0,400}CASE WHEN \(SELECT COUNT\(\*\) FROM users\) = 0 THEN 1 ELSE 0 END/i,
    );
    // WHERE NOT EXISTS guards against re-login of an existing user.
    expect(src).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM users WHERE email = \?\)/);
  });

  it("reads is_admin back into UserContext as a boolean", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    // Selects the column …
    expect(src).toMatch(/u\.is_admin/);
    // … and coerces SQLite's 0/1 INTEGER to a real boolean for the rest
    // of the app.
    expect(src).toMatch(/isAdmin:\s*\(userRow\.is_admin\s*\?\?\s*0\)\s*===\s*1/);
  });

  it("runs the auth provider's allowlist BEFORE the admin-bootstrap INSERT (security invariant)", async () => {
    // ADR 0006 invariant. The allowlist runs inside
    // `provider.authenticate(...)`, which gates whether `auth.email`
    // even reaches the INSERT. Reversing this order would let a
    // non-allowlisted attacker on a fresh deploy capture admin
    // permanently — `INSERT INTO users ... CASE WHEN COUNT(*) = 0
    // THEN 1` runs before any allowlist check.
    const src = await read("src/worker/middleware/user-context.ts");
    const authenticateIdx = src.indexOf("provider.authenticate");
    const insertIdx = src.indexOf("INSERT INTO users");
    expect(authenticateIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(authenticateIdx).toBeLessThan(insertIdx);
  });
});

describe("UserContext + CurrentUser types", () => {
  it("UserContext (worker) declares isAdmin: boolean", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toMatch(/export interface UserContext\s*\{[\s\S]+?isAdmin:\s*boolean/);
  });

  it("CurrentUser (frontend) declares isAdmin: boolean", async () => {
    const src = await read("src/frontend/hooks/useCurrentUser.tsx");
    expect(src).toMatch(/export interface CurrentUser\s*\{[\s\S]+?isAdmin:\s*boolean/);
  });
});

describe("/api/me exposes isAdmin", () => {
  it("returns the user's admin flag in the JSON payload", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    // Inside the /me handler — the JSON response includes isAdmin
    // sourced from the request user-context.
    expect(src).toMatch(/get\("\/me"[\s\S]{0,1500}isAdmin:\s*user\.isAdmin/);
  });
});

describe("PATCH /api/settings admin gate", () => {
  it("rejects non-admin requests that touch deployment-wide fields", async () => {
    const src = await read("src/worker/routes/settings.ts");
    // The handler short-circuits with 403 when ANY of the admin-only
    // fields (budgetCapMonthly / relevanceThreshold / nearMissFloor /
    // signalSurfaceMap) is present and the caller isn't admin.
    expect(src).toMatch(/adminFieldsPresent/);
    expect(src).toMatch(/!user\.isAdmin/);
    expect(src).toMatch(/"Admin only"/);
    expect(src).toMatch(/403/);
  });

  it("permits filterPrompt + sourceFilterOverrides for non-admins (per-user fields)", async () => {
    const src = await read("src/worker/routes/settings.ts");
    // The admin-fields list does NOT include these two — they're
    // explicitly per-user personalization that any user can change.
    const adminBlock = src.match(/const adminFieldsPresent =[\s\S]+?;/);
    expect(adminBlock?.[0]).not.toMatch(/filterPrompt|sourceFilterOverrides/);
  });
});

describe("Source-instance + regenerate route gates", () => {
  it("POST /source-instances is admin-gated via assertAdmin", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toContain('from "../middleware/require-admin.js"');
    expect(src).toMatch(/post\("\/source-instances",[\s\S]{0,200}assertAdmin\(c\.get\("user"\)\)/);
  });

  it("PATCH /source-instances/:id is admin-gated", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toMatch(/patch\("\/source-instances\/:id",[\s\S]{0,200}assertAdmin\(c\.get\("user"\)\)/);
  });

  it("DELETE /source-instances/:id is admin-gated", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toMatch(/delete\("\/source-instances\/:id",[\s\S]{0,200}assertAdmin\(c\.get\("user"\)\)/);
  });

  it("POST /source-instances/suggest is admin-gated (it queues an LLM-suggestion call)", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toMatch(/post\("\/source-instances\/suggest",[\s\S]{0,200}assertAdmin/);
  });

  it("POST /piece/:id/regenerate is admin-gated (model swap is a deployment-wide concern)", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    // Tolerate either depth — pre-split the import resolves from
    // `routes/pieces.ts` (`../middleware/...`); post-split the
    // regenerate handler lives one folder deeper (`../../middleware/...`).
    expect(src).toMatch(/from "(\.\.\/)+middleware\/require-admin\.js"/);
    expect(src).toMatch(/post\("\/piece\/:id\/regenerate",[\s\S]{0,400}assertAdmin/);
  });
});

describe("requireAdmin middleware helper", () => {
  it("exports both a Hono middleware and an in-handler assertAdmin", async () => {
    const src = await read("src/worker/middleware/require-admin.ts");
    expect(src).toMatch(/export const requireAdmin/);
    expect(src).toMatch(/export function assertAdmin/);
    // Both paths return 403 when the user isn't admin.
    expect(src).toMatch(/403/);
    expect(src).toMatch(/!user\.isAdmin/);
  });
});

describe("Frontend nav + per-piece UI gates", () => {
  it("SettingsModal filters its nav for non-admins to Personalization + per-source toggles + Account", async () => {
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(src).toMatch(/REGULAR_USER_PANEL_IDS/);
    // Personalization (about / focus / filter) → per-source panels
    // (so non-admins can flip their own enabledSourceIds toggle on
    // each one) → the user's own Account row. The deployment-wide
    // config inside each source panel is still admin-gated server
    // side; non-admins only get to see the toggle.
    expect(src).toMatch(
      /"about"[\s\S]{0,400}"focus"[\s\S]{0,400}"filter"[\s\S]{0,400}"linear"[\s\S]{0,400}"feeds"[\s\S]{0,400}"account"/,
    );
    // Returns the unfiltered list when admin, filters down otherwise.
    expect(src).toMatch(/if \(isAdmin\) return all/);
    expect(src).toMatch(/all\.filter\(\(entry\) => REGULAR_USER_PANEL_IDS\.has/);
  });

  it("SettingsModal hides the Build full briefing preview button for non-admins", async () => {
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    // Wrapped in `{isAdmin && (…)}` since the preview spans every
    // source's filters and only admins can act on filter changes.
    expect(src).toMatch(/\{isAdmin && \([\s\S]{0,80}<button[\s\S]{0,500}previewLabel/);
  });

  it("AdminOnly + useIsAdmin helpers are exported from useCurrentUser", async () => {
    const src = await read("src/frontend/hooks/useCurrentUser.tsx");
    expect(src).toMatch(/export function AdminOnly/);
    expect(src).toMatch(/export function useIsAdmin/);
    expect(src).toMatch(/export function CurrentUserProvider/);
    expect(src).toMatch(/export function useCurrentUserContext/);
  });

  it("App.tsx wraps Routes in CurrentUserProvider so deep components can read isAdmin", async () => {
    const src = await read("src/frontend/App.tsx");
    expect(src).toContain("CurrentUserProvider");
    expect(src).toMatch(/<CurrentUserProvider user=\{user\}>/);
  });

  it("TeachingPiece wraps ↻ try different model in <AdminOnly>", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain('from "../hooks/useCurrentUser"');
    expect(src).toMatch(/<AdminOnly>[\s\S]{0,400}↻ try different model/);
  });

  it("TeachingPiece wraps the inline VoiceSwitcher in <AdminOnly>", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/<AdminOnly>[\s\S]{0,400}<VoiceSwitcher[\s\S]{0,200}surface="teachingPiece"/);
  });

  it("DeepDiveView wraps the inline VoiceSwitcher in <AdminOnly>", async () => {
    const src = await read("src/frontend/pages/DeepDiveView.tsx");
    expect(src).toMatch(/<AdminOnly>[\s\S]{0,200}<VoiceSwitcher[\s\S]{0,200}surface="deepDive"/);
  });

  it("ChatPanel wraps the inline VoiceSwitcher in <AdminOnly>", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    expect(src).toMatch(/<AdminOnly>[\s\S]{0,200}<VoiceSwitcher[\s\S]{0,200}surface="chat"/);
  });
});

describe("Role visibility — users see whether they're admin", () => {
  it("AccountPanel surfaces the role on the Identity card with a contextual hint", async () => {
    const src = await read("src/frontend/components/settings/panels/AccountPanel.tsx");
    // A "Role" InfoRow shows Admin / Regular user explicitly.
    expect(src).toMatch(/<InfoRow label="Role"\s+value=\{isAdmin \? "Admin" : "Regular user"\}/);
    // The Field hint demystifies what each role can / can't do so a
    // user reading the panel doesn't have to chase a help article.
    expect(src).toMatch(/As admin you can configure deployment-wide settings/);
    expect(src).toMatch(/Regular users can edit personalization/);
  });

  it("AvatarMenu shows an Admin pill in the identity strip for admins only", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Pill is conditional on isAdmin so regular users see no badge
    // (absence is implicit; a "Regular user" pill would be visual
    // noise for the majority case).
    expect(src).toMatch(/\{isAdmin && \(\s*\n\s*<span[\s\S]{0,400}>\s*Admin\s*</);
    // The pill carries a `title` tooltip explaining what admin
    // status enables — same context as the Account panel hint.
    expect(src).toMatch(/title="You can configure deployment-wide settings/);
  });

  it("AvatarMenu prop interface includes isAdmin and threads it through from Header", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Prop interface declares it.
    expect(src).toMatch(/interface AvatarMenuProps\s*\{[\s\S]+?isAdmin:\s*boolean/);
    // Header call site passes it from the resolved user.
    expect(src).toMatch(/<AvatarMenu[\s\S]{0,400}isAdmin=\{user\.isAdmin\}/);
  });
});
