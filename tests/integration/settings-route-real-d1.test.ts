import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { settingsRoutes } from "../../src/worker/routes/settings";
import { buildTestApp, request } from "../helpers/test-app";

// Per-test row cleanup. The pool doesn't enable isolated storage
// by default for arbitrary D1 bindings, and `reset()` would also
// drop the migrations the setup file applied — so we explicitly
// truncate the few tables this file inserts into. Order matters
// because of the FK from user_settings.user_id → users.id.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user_settings").run();
  await env.DB.prepare("DELETE FROM users").run();
});

/**
 * Real-D1 integration tests for `/api/settings`.
 *
 * Sibling of the SQLite-via-better-sqlite3 tests in
 * `tests/unit/settings-route-integration.test.ts`. Same route
 * handler, same migration files, same assertions — but executed
 * inside workerd via `@cloudflare/vitest-pool-workers`, with
 * `env.DB` provisioned by miniflare as a real D1 binding.
 *
 * What this tier catches that the FakeD1 tier can't:
 *
 *   • `D1PreparedStatement` semantics that differ from raw SQLite
 *     (e.g. `.run()` returning the canonical `D1Result` shape, the
 *     way `.bind()` returns a *new* prepared statement rather than
 *     mutating the receiver).
 *   • Migration application — D1 enforces statement boundaries and
 *     transactional semantics that better-sqlite3 doesn't always
 *     match. If a future migration uses something D1-specific
 *     (e.g. a CHECK constraint that D1 parses but SQLite at our
 *     pinned version doesn't), the workerd tier surfaces it.
 *   • The actual binding plumbing — `c.env.DB` here is a real
 *     workerd object, not a hand-rolled adapter. If the route ever
 *     starts depending on D1-only features (`.batch()`, exec
 *     semantics, etc.), this tier will exercise them.
 *
 * Migrations are applied once per file by the setup file
 * `apply-migrations.ts`; per-test-file isolation is enforced by
 * the pool, so `usr_test` rows seeded in one file don't leak into
 * another.
 */

async function seedTestUser(opts: { isAdmin?: boolean } = {}): Promise<void> {
  // Mirrors the bootstrap rows the production `userContext`
  // middleware would insert. We do this in each test rather than
  // in a setup file because we want the row state to be obvious
  // at the call site — test reads better when "the user exists,
  // they're an admin, their settings row is empty" lives next to
  // the assertion.
  await env.DB.prepare(
    `INSERT INTO users (id, email, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind("usr_test", "test@example.com", opts.isAdmin === false ? 0 : 1)
    .run();
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, budget_cap_monthly, relevance_threshold, near_miss_floor, retention_days, source_config, created_at, updated_at)
     VALUES (?, 35, 0.4, 0.25, 365, '{}', datetime('now'), datetime('now'))`,
  )
    .bind("usr_test")
    .run();
}

async function makeApp(opts: { isAdmin?: boolean } = {}) {
  await seedTestUser(opts);
  const testApp = buildTestApp({
    db: env.DB,
    user: { isAdmin: opts.isAdmin !== false },
    mount: [(a) => a.route("/api", settingsRoutes)],
  });
  return testApp;
}

describe("PATCH /api/settings — real D1 (workerd pool)", () => {
  it("admin can set enabledSourceIds and the value round-trips through real D1", async () => {
    const testApp = await makeApp({ isAdmin: true });
    const { status, json } = await request<{ settings: { enabledSourceIds: string[] } }>(
      testApp,
      "PATCH",
      "/api/settings",
      { enabledSourceIds: ["linear", "github"] },
    );
    expect(status).toBe(200);
    expect(json.settings.enabledSourceIds.sort()).toEqual(["github", "linear"]);

    // Read straight back through the D1 binding to confirm the
    // value persisted, not just round-tripped through the response.
    const row = await env.DB.prepare("SELECT enabled_source_ids FROM user_settings WHERE user_id = ?")
      .bind("usr_test")
      .first<{ enabled_source_ids: string }>();
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.enabled_source_ids).sort()).toEqual(["github", "linear"]);
  });

  it("non-admin can set enabledSourceIds (per-user field, not 403'd)", async () => {
    const testApp = await makeApp({ isAdmin: false });
    const { status, json } = await request<{ settings: { enabledSourceIds: string[] } }>(
      testApp,
      "PATCH",
      "/api/settings",
      { enabledSourceIds: ["slack"] },
    );
    expect(status).toBe(200);
    expect(json.settings.enabledSourceIds).toEqual(["slack"]);
  });

  it("non-admin still gets 403 when sending signalSurfaceMap", async () => {
    const testApp = await makeApp({ isAdmin: false });
    const { status, json } = await request<{ error: string }>(testApp, "PATCH", "/api/settings", {
      signalSurfaceMap: { linear: { includeAssigned: false } },
    });
    expect(status).toBe(403);
    expect(json.error).toBe("Admin only");
  });

  it("unknown source IDs are dropped silently, including the 0004 typo", async () => {
    const testApp = await makeApp({ isAdmin: true });
    const { status, json } = await request<{ settings: { enabledSourceIds: string[] } }>(
      testApp,
      "PATCH",
      "/api/settings",
      // The exact typo migration 0004 shipped with — must be
      // dropped because it isn't a canonical SourceId.
      { enabledSourceIds: ["rss", "incident-io", "phantom_kind", "linear"] },
    );
    expect(status).toBe(200);
    expect(json.settings.enabledSourceIds.sort()).toEqual(["linear", "rss"]);
  });
});

describe("Migration chain — real D1 ends up with the canonical IDs", () => {
  it("after the full migration chain, a backfilled user has 'incident_io' (not 'incident-io')", async () => {
    // Simulate the state migration 0004 left us in: a user_settings
    // row where the JSON column carries the bad token. 0005 would
    // already have run by setup-file time, so we apply the bad
    // value AFTER setup and then re-run 0005's REPLACE manually
    // to mirror what happens on a real upgrade path.
    await env.DB.prepare(
      `INSERT INTO users (id, email, created_at, updated_at)
       VALUES ('u1', 'u1@example.com', datetime('now'), datetime('now'))`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, budget_cap_monthly, relevance_threshold, near_miss_floor, retention_days, source_config, enabled_source_ids, created_at, updated_at)
       VALUES ('u1', 35, 0.4, 0.25, 365, '{}', '["linear","slack","github","incident-io","hn","rss","arxiv"]', datetime('now'), datetime('now'))`,
    ).run();
    // D1's `exec()` splits on newlines and treats each line as a
    // separate statement; multi-line SQL breaks it with
    // "incomplete input". `prepare(...).run()` doesn't have that
    // constraint and is what production code uses everywhere
    // anyway, so use it here too.
    await env.DB.prepare(
      `UPDATE user_settings SET enabled_source_ids = REPLACE(enabled_source_ids, '"incident-io"', '"incident_io"') WHERE enabled_source_ids LIKE '%"incident-io"%'`,
    ).run();
    const row = await env.DB.prepare("SELECT enabled_source_ids FROM user_settings WHERE user_id = 'u1'").first<{
      enabled_source_ids: string;
    }>();
    expect(row).toBeTruthy();
    const ids = JSON.parse(row!.enabled_source_ids);
    expect(ids).toContain("incident_io");
    expect(ids).not.toContain("incident-io");
  });
});
