import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

/**
 * Per-user source toggles. Migration 0004 adds an `enabled_source_ids`
 * JSON-array column to `user_settings` (default `'[]'`, backfilled
 * with all seven kinds for existing rows so installed deployments
 * don't suddenly start producing empty briefings). Briefing pipeline
 * filters singleton providers and adjacent source instances by this
 * list. PATCH /settings exposes it as a user-level field — distinct
 * from `signalSurfaceMap`, which remains admin-gated.
 */
describe("Migration 0004_user_enabled_source_ids.sql", () => {
  it("adds enabled_source_ids TEXT NOT NULL DEFAULT '[]'", async () => {
    const sql = await read("migrations/0004_user_enabled_source_ids.sql");
    expect(sql).toMatch(/ALTER TABLE user_settings\s+ADD COLUMN enabled_source_ids TEXT NOT NULL DEFAULT '\[\]'/);
  });

  it("backfills existing user_settings rows with all seven source IDs", async () => {
    const sql = await read("migrations/0004_user_enabled_source_ids.sql");
    // Backfill is required so the deployment owner who already has
    // every source configured doesn't suddenly land in an "all off"
    // state on tomorrow's briefing.
    expect(sql).toMatch(/UPDATE user_settings/);
    for (const id of ["linear", "slack", "github", "incident-io", "hn", "rss", "arxiv"]) {
      expect(sql).toContain(`"${id}"`);
    }
  });
});

describe("PATCH /api/settings exposes enabledSourceIds as user-level", () => {
  it("validates enabledSourceIds as an array of strings and persists it", async () => {
    const src = await read("src/worker/routes/settings.ts");
    expect(src).toMatch(/enabledSourceIds = body\.enabledSourceIds \?\? body\.enabled_source_ids/);
    expect(src).toMatch(/"enabledSourceIds must be an array of strings"/);
    expect(src).toMatch(/"enabledSourceIds must contain only strings"/);
    expect(src).toMatch(/enabled_source_ids = \?/);
  });

  it("filters unknown source IDs against the registry rather than rejecting them", async () => {
    const src = await read("src/worker/routes/settings.ts");
    // A typo or a removed provider must not brick the PATCH — drop
    // unknown IDs silently so settings keep persisting cleanly.
    expect(src).toMatch(/sourceRegistry\.getAll\(\)/);
    expect(src).toMatch(/knownIds\.has/);
  });

  it("keeps enabledSourceIds OUT of the admin-only fields gate", async () => {
    const src = await read("src/worker/routes/settings.ts");
    // The admin gate is the block that decides 403. Pulling
    // enabledSourceIds into it would make a regular user unable to
    // change their own opt-in list, defeating the feature.
    const block = src.match(/const adminFieldsPresent =[\s\S]+?;/);
    expect(block?.[0]).not.toMatch(/enabledSourceIds|enabled_source_ids/);
  });
});

describe("UserContext loads enabled_source_ids from user_settings", () => {
  it("middleware parses the JSON column and exposes it on settings", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    expect(src).toContain("enabled_source_ids");
    expect(src).toContain("enabledSourceIds");
  });

  it("UserSettings type carries enabledSourceIds", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toMatch(/enabledSourceIds\?:\s*string\[\]/);
  });
});

describe("Briefing pipeline gates on enabled source IDs", () => {
  it("singleton fan-out filters providers against the user's enabled list", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/userSettings\?\.enabledSourceIds/);
    expect(src).toMatch(/sourceRegistry[\s\S]{0,80}getSingletons\(env\)[\s\S]{0,200}\.filter/);
  });

  it("adjacent-scanner accepts an enabledSourceIds option and filters by instance kind", async () => {
    const src = await read("src/worker/services/adjacent-scanner.ts");
    expect(src).toMatch(/enabledSourceIds\?:\s*string\[\]/);
    expect(src).toMatch(/enabledKinds[\s\S]{0,80}\.filter\(\(s\) => enabledKinds\.has\(s\.kind\)\)/);
  });

  it("briefing-generator passes the user's enabledSourceIds into scanAdjacentSources", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/enabledSourceIds:\s*userSettings\?\.enabledSourceIds\s*\?\?\s*\[\]/);
  });
});

describe("suggestEnabledSources LLM helper", () => {
  it("recommends per-source on/off with a short rationale, JSON-only", async () => {
    const src = await read("src/worker/services/source-suggester.ts");
    expect(src).toContain("export async function suggestEnabledSources");
    expect(src).toMatch(/"recommended":\s*true \| false/);
    expect(src).toMatch(/"rationale":/);
    // The id MUST come from the provided list — the server validates
    // this defensively because the model occasionally hallucinates.
    expect(src).toMatch(/validIds\.has\(s\.id\)/);
  });

  it("falls back to an empty / non-recommended list when the LLM call fails", async () => {
    const src = await read("src/worker/services/source-suggester.ts");
    // Fail-safe: a network blip on the suggester must not block the
    // user from finishing onboarding.
    expect(src).toMatch(/enabled-sources LLM call failed/);
    expect(src).toMatch(/return \[\]/);
  });

  it("backfills sources the LLM dropped so the UI sees the full list", async () => {
    const src = await read("src/worker/services/source-suggester.ts");
    // The prompt asks for every source exactly once; a partial
    // response must still produce a deterministic list with the
    // missing entries flagged as not recommended.
    expect(src).toMatch(/Backfill any sources the LLM dropped/);
    expect(src).toMatch(/recommended: false/);
  });
});

describe("POST /sources/suggest-enabled route", () => {
  it("is reachable by any authenticated user (no admin gate)", async () => {
    const src = await read("src/worker/routes/sources.ts");
    // The route lives next to GET /sources and is intentionally
    // user-level — the suggestion is scoped to the caller's own
    // About + Focus, not deployment config.
    expect(src).toContain('post("/sources/suggest-enabled"');
    const block = src.match(/post\("\/sources\/suggest-enabled"[\s\S]+?\}\);/);
    expect(block?.[0]).not.toMatch(/assertAdmin|requireAdmin/);
  });

  it("returns an empty list when no LLM provider key is configured", async () => {
    const src = await read("src/worker/routes/sources.ts");
    // Soft-degrade: no key → no suggestions, but the request still
    // succeeds so the onboarding UI keeps moving.
    expect(src).toMatch(/!env\.ANTHROPIC_API_KEY && !env\.OPENAI_API_KEY/);
    expect(src).toMatch(/suggestions:\s*\[\]/);
  });
});

describe("Frontend FirstRunSetup.tsx — onboarding sources step", () => {
  it("adds 'sources' to the Step union", async () => {
    const src = await read("src/frontend/components/FirstRunSetup.tsx");
    expect(src).toMatch(/type Step = "intro" \| "about" \| "focus" \| "sources" \| "done"/);
  });

  it("loads suggestions on step entry but does NOT pre-check any boxes", async () => {
    const src = await read("src/frontend/components/FirstRunSetup.tsx");
    // `selectedSources` starts as an empty Set — every box unchecked.
    // The AI's role is purely advisory through the highlight class.
    expect(src).toMatch(/selectedSources[\s\S]{0,60}new Set/);
    expect(src).toMatch(/suggestionById/);
    expect(src).toContain("/api/sources/suggest-enabled");
  });

  it("PATCHes /api/settings with the chosen source IDs on finish", async () => {
    const src = await read("src/frontend/components/FirstRunSetup.tsx");
    expect(src).toMatch(/apiPatch\("\/api\/settings",\s*\{\s*enabledSourceIds:/);
  });
});

describe("Per-source panels carry the enabled toggle inline", () => {
  // The standalone SourcesOverviewPanel was removed because a
  // dedicated "Sources" menu item felt redundant once a user has
  // already done onboarding — the toggle belongs in each respective
  // source panel, with the rest of the per-source filters hidden
  // when the source is off.
  for (const [file, sourceId] of [
    ["src/frontend/components/settings/panels/LinearPanel.tsx", "linear"],
    ["src/frontend/components/settings/panels/SlackPanel.tsx", "slack"],
    ["src/frontend/components/settings/panels/GitHubPanel.tsx", "github"],
    ["src/frontend/components/settings/panels/IncidentIoPanel.tsx", "incident_io"],
  ] as const) {
    it(`${file.split("/").pop()} renders the SourceEnabledRow for "${sourceId}" and hides the body when off`, async () => {
      const src = await read(file);
      expect(src).toMatch(new RegExp(`useSourceEnabled\\("${sourceId}"\\)`));
      expect(src).toContain("SourceEnabledRow");
      // Conditional rendering on the toggle: when off, only the
      // toggle is visible and the rest of the panel is collapsed.
      expect(src).toMatch(/!enabled\s*\?/);
    });
  }

  it("FeedsPanel exposes per-kind toggles for rss, hn, and arxiv", async () => {
    const src = await read("src/frontend/components/settings/panels/FeedsPanel.tsx");
    expect(src).toMatch(/useSourceEnabled\("rss"\)/);
    expect(src).toMatch(/useSourceEnabled\("hn"\)/);
    expect(src).toMatch(/useSourceEnabled\("arxiv"\)/);
    // When all three kinds are off, the deployment-management UI
    // (Add by URL, Suggest, configured-feeds list) is hidden.
    expect(src).toMatch(/anyKindEnabled/);
  });
});

describe("Frontend SettingsModal — standalone Sources panel removed", () => {
  it("no longer registers a top-level 'sources' nav entry", async () => {
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(src).not.toMatch(/SourcesOverviewPanel/);
    // The 'sources' id is gone from STATIC_NAV — toggles live inline
    // on each per-source panel now.
    expect(src).not.toMatch(/id:\s*"sources",/);
  });

  it("non-admin users can reach each per-source panel + Feeds to flip their own toggle", async () => {
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    // Without these IDs in the regular-user allowlist, a non-admin
    // would have no way to toggle their own enabled sources after
    // onboarding.
    const m = src.match(/REGULAR_USER_PANEL_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    for (const id of ["linear", "slack", "github", "incident_io", "feeds"]) {
      expect(m![1]).toMatch(new RegExp(`"${id}"`));
    }
  });
});

describe("Migration 0005 fixes the incident_io ID typo from 0004", () => {
  it("rewrites the bogus 'incident-io' (hyphen) token back to 'incident_io' (underscore)", async () => {
    const sql = await read("migrations/0005_fix_incident_io_kind.sql");
    // The previous migration backfilled the wrong kind. Without
    // this fix every backfilled user silently lost incident.io
    // fan-out because the briefing pipeline filters by exact match
    // against `provider.id` (which is "incident_io", underscore).
    expect(sql).toMatch(/REPLACE\(enabled_source_ids,\s*'"incident-io"',\s*'"incident_io"'\)/);
    expect(sql).toMatch(/WHERE enabled_source_ids LIKE '%"incident-io"%'/);
  });
});
