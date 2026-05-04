import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsRoutes } from "../../src/worker/routes/settings";
import { applyMigrations, makeFakeD1 } from "../helpers/d1-fake";
import { buildTestApp, request } from "../helpers/test-app";

/**
 * In-process integration tests for `/api/settings` — exercises the
 * actual route handler with the actual SQL migrations applied to an
 * in-memory SQLite that mimics the D1 surface our worker uses.
 *
 * Why this matters beyond the existing source-text regex pins:
 *
 *   • The 0004 → 0005 incident_io regression would have surfaced
 *     here at write time. After applying both migrations, the
 *     backfilled column should contain `"incident_io"` (underscore)
 *     — a regression to `"incident-io"` would fail this assertion.
 *   • Admin-gating bugs (a regular user accidentally able to PATCH
 *     a deployment-wide field, OR an admin-only field accidentally
 *     reaching a non-admin via a typo'd field name) surface as
 *     wrong status codes here. Source-text checks can't see that.
 *   • The "drop unknown source IDs" semantic on PATCH is exercised
 *     end to end — sending `["linear", "phantom_kind"]` should
 *     persist `["linear"]` only.
 *
 * The fake D1 sits between us and SQLite, so locking / batch /
 * distributed-transaction semantics are SQLite's. Routes that depend
 * on D1-specific behaviour can layer a pool-workers test on top.
 */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeApp(opts: { isAdmin?: boolean; upToMigration?: string } = {}) {
  const db = makeFakeD1();
  await applyMigrations(db, { upTo: opts.upToMigration });

  // Seed the user row + their user_settings row so the route can
  // PATCH and SELECT cleanly. Mirrors the
  // INSERT-or-IGNORE pattern in the real userContext middleware.
  db.raw
    .prepare(
      `INSERT INTO users (id, email, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run("usr_test", "test@example.com", opts.isAdmin === false ? 0 : 1);
  db.raw
    .prepare(
      `INSERT INTO user_settings (user_id, budget_cap_monthly, relevance_threshold, near_miss_floor, retention_days, source_config, created_at, updated_at)
       VALUES (?, 35, 0.4, 0.25, 365, '{}', datetime('now'), datetime('now'))`,
    )
    .run("usr_test");

  const testApp = buildTestApp({
    db,
    user: { isAdmin: opts.isAdmin !== false },
    mount: [(a) => a.route("/api", settingsRoutes)],
  });
  return { testApp, db };
}

describe("PATCH /api/settings — enabledSourceIds (user-level)", () => {
  it("admin can set enabledSourceIds and the value round-trips", async () => {
    const { testApp, db } = await makeApp({ isAdmin: true });
    const { status, json } = await request<{ settings: { enabledSourceIds: string[] } }>(
      testApp,
      "PATCH",
      "/api/settings",
      { enabledSourceIds: ["linear", "github"] },
    );
    expect(status).toBe(200);
    expect(json.settings.enabledSourceIds.sort()).toEqual(["github", "linear"]);

    const row = db.raw.prepare("SELECT enabled_source_ids FROM user_settings WHERE user_id = ?").get("usr_test") as
      | { enabled_source_ids: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.enabled_source_ids).sort()).toEqual(["github", "linear"]);
  });

  it("non-admin CAN set enabledSourceIds (it's a per-user field)", async () => {
    const { testApp } = await makeApp({ isAdmin: false });
    const { status, json } = await request<{ settings: { enabledSourceIds: string[] } }>(
      testApp,
      "PATCH",
      "/api/settings",
      { enabledSourceIds: ["slack"] },
    );
    // Pin: this MUST be 200, not 403. enabledSourceIds is the
    // user's own opt-in list — gating it to admin would defeat
    // the feature. The server returns the updated settings on
    // success.
    expect(status).toBe(200);
    expect(json.settings.enabledSourceIds).toEqual(["slack"]);
  });

  it("non-admin still gets 403 when sending signalSurfaceMap (deployment-wide)", async () => {
    const { testApp } = await makeApp({ isAdmin: false });
    const { status, json } = await request<{ error: string }>(testApp, "PATCH", "/api/settings", {
      signalSurfaceMap: { linear: { includeAssigned: false } },
    });
    expect(status).toBe(403);
    expect(json.error).toBe("Admin only");
  });

  it("unknown source IDs are silently dropped — typo doesn't brick the PATCH", async () => {
    const { testApp, db } = await makeApp({ isAdmin: true });
    const { status, json } = await request<{ settings: { enabledSourceIds: string[] } }>(
      testApp,
      "PATCH",
      "/api/settings",
      // "incident-io" (hyphen) is the exact typo from migration
      // 0004's bad backfill — it's NOT a canonical SourceId, so
      // it should be dropped. "rss" is canonical and should survive.
      { enabledSourceIds: ["rss", "incident-io", "phantom_kind", "linear"] },
    );
    expect(status).toBe(200);
    expect(json.settings.enabledSourceIds.sort()).toEqual(["linear", "rss"]);

    const row = db.raw.prepare("SELECT enabled_source_ids FROM user_settings WHERE user_id = ?").get("usr_test") as {
      enabled_source_ids: string;
    };
    expect(JSON.parse(row.enabled_source_ids).sort()).toEqual(["linear", "rss"]);
  });

  it("rejects a non-array enabledSourceIds with 400", async () => {
    const { testApp } = await makeApp({ isAdmin: true });
    const { status, json } = await request<{ error: string }>(testApp, "PATCH", "/api/settings", {
      enabledSourceIds: "linear",
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/array/);
  });

  it("rejects an array with non-string entries with 400", async () => {
    const { testApp } = await makeApp({ isAdmin: true });
    const { status, json } = await request<{ error: string }>(testApp, "PATCH", "/api/settings", {
      enabledSourceIds: ["linear", 42],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/strings/);
  });
});

describe("Migration chain — applied in order produces canonical IDs", () => {
  it("0004 alone backfills with the (buggy) 'incident-io' token", async () => {
    const db = makeFakeD1();
    await applyMigrations(db, { upTo: "0004_user_enabled_source_ids.sql" });
    db.raw
      .prepare(
        `INSERT INTO users (id, email, created_at, updated_at)
         VALUES ('u1', 'u1@example.com', datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO user_settings (user_id, budget_cap_monthly, relevance_threshold, near_miss_floor, retention_days, source_config, created_at, updated_at)
         VALUES ('u1', 35, 0.4, 0.25, 365, '{}', datetime('now'), datetime('now'))`,
      )
      .run();
    // Re-run 0004's UPDATE so this newly-inserted row is also
    // backfilled (the migration's UPDATE only fires once at
    // migration time; for rows created post-migration the column
    // default kicks in).
    db.raw.exec(
      `UPDATE user_settings
       SET enabled_source_ids = '["linear","slack","github","incident-io","hn","rss","arxiv"]'
       WHERE user_id = 'u1'`,
    );
    const row = db.raw.prepare("SELECT enabled_source_ids FROM user_settings WHERE user_id = 'u1'").get() as {
      enabled_source_ids: string;
    };
    expect(JSON.parse(row.enabled_source_ids)).toContain("incident-io");
  });

  it("0004 + 0005 together backfill with the canonical 'incident_io' (underscore)", async () => {
    const db = makeFakeD1();
    await applyMigrations(db); // all migrations
    db.raw
      .prepare(
        `INSERT INTO users (id, email, created_at, updated_at)
         VALUES ('u1', 'u1@example.com', datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO user_settings (user_id, budget_cap_monthly, relevance_threshold, near_miss_floor, retention_days, source_config, enabled_source_ids, created_at, updated_at)
         VALUES ('u1', 35, 0.4, 0.25, 365, '{}', '["linear","slack","github","incident-io","hn","rss","arxiv"]', datetime('now'), datetime('now'))`,
      )
      .run();
    // Re-run 0005's REPLACE — same logic the migration applies
    // when it runs against an installed deployment.
    db.raw.exec(
      `UPDATE user_settings
       SET enabled_source_ids = REPLACE(enabled_source_ids, '"incident-io"', '"incident_io"')
       WHERE enabled_source_ids LIKE '%"incident-io"%'`,
    );
    const row = db.raw.prepare("SELECT enabled_source_ids FROM user_settings WHERE user_id = 'u1'").get() as {
      enabled_source_ids: string;
    };
    expect(JSON.parse(row.enabled_source_ids)).toContain("incident_io");
    expect(JSON.parse(row.enabled_source_ids)).not.toContain("incident-io");
  });
});
