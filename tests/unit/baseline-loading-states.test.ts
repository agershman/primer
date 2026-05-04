/**
 * Pins the "two-tier loading state" contract for BaselineQuiz.
 *
 * Bug this test prevents regressing:
 *
 *   1. User clicks the "calibration ready" bell notification.
 *   2. Browser navigates to /calibrate.
 *   3. The page mounts, fetchBaseline kicks off a network round-trip
 *      to /api/quiz/baseline/status + /api/quiz/baseline (~200–500 ms).
 *   4. During those 200–500 ms the user sees the LOUD progress UI
 *      that says "Generating calibration questions / This takes
 *      10–20 seconds…" — even though nothing is being generated.
 *      The questions already exist server-side; we're just
 *      downloading them. The notification said READY, so the loud
 *      copy is a lie.
 *
 * Fix shape:
 *
 *   - `useBaseline` exposes a NEW `generating` flag, distinct from
 *     `loading`. It's true ONLY when the server reports
 *     `generating: true` and the hook is polling. A bare network
 *     fetch (notification click → fast-path) leaves it false.
 *   - `BaselineQuiz` renders the loud "10–20 seconds" copy only
 *     when `generating === true`. Plain `loading` (no generation
 *     in flight) renders a quiet generic "Loading…" spinner — no
 *     misleading verbiage, resolves in 200–500 ms with no
 *     perception of "stuck loading".
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("useBaseline — generating is distinct from loading", () => {
  it("UseBaselineResult exposes a `generating: boolean` field separate from `loading`", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    // Both fields must exist on the result type — losing either
    // collapses the two-tier loading UI back into the one-tier
    // (and re-introduces the misleading copy).
    expect(src).toMatch(
      /interface UseBaselineResult \{[\s\S]{0,1500}loading: boolean;[\s\S]{0,500}generating: boolean;/,
    );
  });

  it("`generating` only flips true when the server reports `data.generating`", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    // The `generating: true` polling path is the ONLY case where
    // we should claim "generating" in the UI. A regression that
    // sets `generating` true unconditionally would re-create the
    // bug.
    expect(src).toMatch(/if \(data\.generating\)\s*\{[\s\S]{0,400}setGenerating\(true\)/);
    // Cleared inside the same branch, after the polling loop, so
    // we don't leave the flag true after the questions land.
    expect(src).toMatch(/setGenerating\(false\);\s*\}/);
  });

  it("fetchBaseline resets `generating` at entry so a stale loop doesn't leak in", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    // Without the entry-time reset, a previous fetch that landed
    // in the polling branch could leave `generating: true` and
    // make every subsequent fast-path fetch flash the loud UI.
    expect(src).toMatch(
      /fetchBaseline = useCallback\(async \(\) => \{\s*setLoading\(true\);[\s\S]{0,400}setGenerating\(false\);/,
    );
  });

  it("the hook's return object includes `generating` in the public shape", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toMatch(
      /return \{[\s\S]{0,800}loading,\s*generating,\s*submitting,/,
    );
  });
});

describe("BaselineQuiz — loud generation copy is gated on `generating`, not `loading`", () => {
  it("destructures `generating` from useBaseline alongside `loading`", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toMatch(/loading,\s*generating,/);
  });

  it("renders the loud 'Generating calibration questions / 10–20 seconds' UI only inside an `if (generating)` branch", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // The `if (loading)` block must immediately gate on `if (generating)`
    // before showing the loud copy. Pin the structure so a future
    // refactor doesn't accidentally hoist the loud copy back to
    // the top-level `if (loading)` body.
    //
    // The comment block inside `if (loading)` is intentionally large
    // (it documents the bug this code fixes), so the inter-token
    // window is generous to accommodate it.
    expect(src).toMatch(
      /if \(loading\) \{[\s\S]{0,2500}if \(generating\) \{[\s\S]{0,2500}Generating calibration questions[\s\S]{0,500}This takes 10[–-]20\s*\n?\s*seconds/,
    );
  });

  it("renders a quiet 'Loading…' fallback when loading but not generating", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // The fast-path mount (e.g. arriving from a 'ready' bell
    // notification) lands here. The copy must NOT mention
    // "generating" or "10–20 seconds" — the questions already
    // exist, we're just downloading them.
    expect(src).toMatch(
      /if \(loading\) \{[\s\S]{0,4500}return \(\s*<div[^>]*>\s*<div[\s\S]{0,400}animate-spin[\s\S]{0,200}Loading…/,
    );
  });

  it("the user-facing 'This takes 10–20 seconds…' copy appears exactly once (gated on `generating`)", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // The JSX form of the loud copy is unique enough (matched here
    // via the `This takes` prefix + the ellipsis `…`) that we can
    // pin its multiplicity precisely. A regression that re-
    // introduces it in the loading fallback would bump the count
    // to 2 and fail this test.
    const matches = src.match(/This takes 10[–-]20\s*\n?\s*seconds…/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
