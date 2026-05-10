import { describe, expect, it } from "vitest";
import { loadUserSettingsFromDb } from "../../src/worker/util/load-user-settings";
import { applyMigrations, makeFakeD1 } from "../helpers/d1-fake";

/**
 * The cron handler runs without a request context, so it can't piggy-
 * back on the user-context middleware's settings load. This loader
 * is the shared function the cron path now calls; the lifecycle
 * `/briefing/generate` route reuses `user.settings` (already loaded
 * by the middleware, which has its own JSON-parse logic).
 *
 * The case the test pins is the one that put users in the perpetual
 * "No new content today" loop: when `enabled_source_ids` was silently
 * dropped from the cron path's load, the briefing-generator's
 * adjacent-scanner gate received undefined → `?? []` → an empty Set
 * that matched zero source instances. Every cron run finalized as
 * `no_candidates`. The loader has to surface every column the
 * pipeline reads, not just `source_config`.
 */
describe("loadUserSettingsFromDb", () => {
  async function setupDb() {
    const db = makeFakeD1();
    await applyMigrations(db);
    db.raw
      .prepare(
        `INSERT INTO users (id, email, is_admin, created_at, updated_at)
         VALUES ('usr_test', 'test@example.com', 1, datetime('now'), datetime('now'))`,
      )
      .run();
    return db;
  }

  it("returns null when the user has no user_settings row yet", async () => {
    const db = await setupDb();
    const got = await loadUserSettingsFromDb(db as unknown as D1Database, "usr_test");
    expect(got).toBeNull();
  });

  it("surfaces enabledSourceIds, filterPrompt, sourceFilterOverrides — the columns the cron path used to drop", async () => {
    const db = await setupDb();
    db.raw
      .prepare(
        `INSERT INTO user_settings (
           user_id, budget_cap_monthly, relevance_threshold, near_miss_floor,
           retention_days, source_config, filter_prompt, source_filter_overrides,
           enabled_source_ids, created_at, updated_at
         ) VALUES (?, 35, 0.4, 0.25, 365, '{}', ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        "usr_test",
        "infra-only",
        JSON.stringify({ "src_inst_1": "infra-only" }),
        JSON.stringify(["linear", "hn", "rss"]),
      );

    const got = await loadUserSettingsFromDb(db as unknown as D1Database, "usr_test");
    expect(got).not.toBeNull();
    expect(got?.enabledSourceIds).toEqual(["linear", "hn", "rss"]);
    expect(got?.filterPrompt).toBe("infra-only");
    expect(got?.sourceFilterOverrides).toEqual({ src_inst_1: "infra-only" });
  });

  it("drops unknown source ids from enabled_source_ids (defensive narrowing)", async () => {
    const db = await setupDb();
    db.raw
      .prepare(
        `INSERT INTO user_settings (
           user_id, source_config, enabled_source_ids, created_at, updated_at
         ) VALUES (?, '{}', ?, datetime('now'), datetime('now'))`,
      )
      .run("usr_test", JSON.stringify(["linear", "phantom_kind", "deleted_provider"]));

    const got = await loadUserSettingsFromDb(db as unknown as D1Database, "usr_test");
    expect(got?.enabledSourceIds).toEqual(["linear"]);
  });

  it("returns an empty enabledSourceIds list rather than crashing on malformed JSON", async () => {
    const db = await setupDb();
    db.raw
      .prepare(
        `INSERT INTO user_settings (
           user_id, source_config, enabled_source_ids, created_at, updated_at
         ) VALUES (?, '{}', ?, datetime('now'), datetime('now'))`,
      )
      .run("usr_test", "{not-json");

    const got = await loadUserSettingsFromDb(db as unknown as D1Database, "usr_test");
    expect(got).not.toBeNull();
    expect(got?.enabledSourceIds).toEqual([]);
  });
});
