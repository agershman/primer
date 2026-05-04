import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_DESCRIPTIONS, SOURCE_IDS } from "../../src/shared/sources";
import { sourceRegistry } from "../../src/worker/sources/index";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

/**
 * One test file to catch every "source ID typo" class of bug. The
 * 0004 → 0005 incident_io regression cost a real PR because the
 * migration shipped with the wrong token (`incident-io` vs
 * `incident_io`) and nothing failed at write time. With the
 * canonical `SOURCE_IDS` tuple in `shared/sources.ts` and these
 * cross-cuts asserting every call site agrees with it, that class
 * of bug now fails CI before merge.
 *
 * Adding a new source? Append to `SOURCE_IDS` AND `SOURCE_DESCRIPTIONS`
 * in `shared/sources.ts`, then register the provider in
 * `src/worker/sources/index.ts` — the assertions below will tell
 * you which call sites still need updating.
 */
describe("Source ID consistency — single source of truth", () => {
  it("the registered providers' ids exactly match SOURCE_IDS", () => {
    // The runtime registry is the ground truth for what providers
    // exist; SOURCE_IDS is the static contract that should mirror
    // it. If they diverge, either a provider was added without
    // updating the canonical list (so frontend callers can't type
    // it) or the canonical list contains a phantom id (so calls
    // through it will silently no-op). Either is bad.
    const registered = new Set(sourceRegistry.getAll().map((p) => p.id));
    const canonical = new Set<string>(SOURCE_IDS);
    expect(registered).toEqual(canonical);
  });

  it("SOURCE_DESCRIPTIONS covers every SOURCE_IDS entry exactly once", () => {
    // The description map drives the LLM suggester prompt + UI
    // helper text. Missing entries silently degrade the prompt; an
    // extra key would be dead code. `Record<SourceId, string>`
    // already enforces this at compile time, but pin it explicitly
    // here so a refactor that loosens the type catches at test
    // time too.
    expect(new Set(Object.keys(SOURCE_DESCRIPTIONS))).toEqual(new Set<string>(SOURCE_IDS));
    for (const id of SOURCE_IDS) {
      expect(SOURCE_DESCRIPTIONS[id]).toBeTruthy();
    }
  });

  it("migrations 0004 + 0005 together backfill the canonical SOURCE_IDS set", async () => {
    // We apply the migrations in order rather than checking the
    // 0004 literal in isolation: 0004 actually shipped with
    // `incident-io` (hyphen) by mistake and 0005 fixes it via a
    // targeted REPLACE. What ends up in the column for
    // backfilled-and-then-fixed users is what matters, and that
    // must match SOURCE_IDS exactly. A future provider added to
    // the registry but not the backfill chain would fail this
    // assertion immediately.
    const sql0004 = await read("migrations/0004_user_enabled_source_ids.sql");
    const m0004 = sql0004.match(/SET enabled_source_ids = '(\[[^']+\])'/);
    expect(m0004, "0004 backfill JSON array literal not found").toBeTruthy();
    let backfill = m0004![1];

    // Apply 0005's REPLACE pair(s) — the migration is a series of
    // string-replace transforms. Parse them out and run them in
    // order against the 0004 literal.
    const sql0005 = await read("migrations/0005_fix_incident_io_kind.sql");
    const replaces = [...sql0005.matchAll(/REPLACE\(enabled_source_ids,\s*'([^']+)',\s*'([^']+)'\)/g)];
    expect(replaces.length, "0005 must contain at least one REPLACE").toBeGreaterThan(0);
    for (const r of replaces) {
      backfill = backfill.split(r[1]).join(r[2]);
    }

    const parsed = JSON.parse(backfill) as string[];
    expect(new Set(parsed)).toEqual(new Set<string>(SOURCE_IDS));
  });

  it("each per-source Settings panel calls useSourceEnabled with a canonical id", async () => {
    // The frontend hook is typed `(id: SourceId) => …`, so a typo
    // is a compile error already. This test pins the *coverage*:
    // every singleton source has a panel that registers the
    // toggle. If we add a new singleton and forget to wire its
    // panel, the user has no way to enable it.
    const expected: Record<string, string> = {
      "src/frontend/components/settings/panels/LinearPanel.tsx": "linear",
      "src/frontend/components/settings/panels/SlackPanel.tsx": "slack",
      "src/frontend/components/settings/panels/GitHubPanel.tsx": "github",
      "src/frontend/components/settings/panels/IncidentIoPanel.tsx": "incident_io",
    };
    for (const [file, sourceId] of Object.entries(expected)) {
      const src = await read(file);
      expect(src, `${file}: expected useSourceEnabled("${sourceId}")`).toMatch(
        new RegExp(`useSourceEnabled\\("${sourceId}"\\)`),
      );
    }
  });

  it("FeedsPanel registers a useSourceEnabled toggle for every multi-instance kind", async () => {
    const src = await read("src/frontend/components/settings/panels/FeedsPanel.tsx");
    const multiInstanceKinds = sourceRegistry
      .getAll()
      .filter((p) => p.multiInstance)
      .map((p) => p.id);
    expect(multiInstanceKinds.length, "expected at least one multi-instance source").toBeGreaterThan(0);
    for (const kind of multiInstanceKinds) {
      expect(src, `FeedsPanel.tsx: missing useSourceEnabled("${kind}")`).toMatch(
        new RegExp(`useSourceEnabled\\("${kind}"\\)`),
      );
    }
  });

  it("REGULAR_USER_PANEL_IDS includes every source-toggle panel", async () => {
    // Non-admin users need to be able to reach the panel that
    // hosts their toggle. Without this, a regular user on a
    // multi-user deployment has no way to opt out of, say, Linear
    // — they don't have permission to see the deployment-wide
    // configs but they should still see the toggle row at the top.
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    const m = src.match(/REGULAR_USER_PANEL_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    const required = ["linear", "slack", "github", "incident_io", "feeds"];
    for (const id of required) {
      expect(m![1], `REGULAR_USER_PANEL_IDS missing "${id}"`).toMatch(new RegExp(`"${id}"`));
    }
  });
});
