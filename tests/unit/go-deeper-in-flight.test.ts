/**
 * Pins the in-flight progress indicator on the per-piece
 * "Go deeper" button.
 *
 * The user reported clicking "Go deeper", navigating away from the
 * deep-dive view, and coming back to the briefing with no signal
 * that generation was still running. We had the data — every active
 * deep-dive write creates a `deep_dive` notification with
 * `payload.pieceId` — but the briefing page wasn't surfacing it on
 * the originating button.
 *
 * The fix has three parts:
 *
 *   1. **BriefingPage subscribes to `useNotifications`** and derives
 *      a `Set<pieceId>` of currently-generating deep dives. The
 *      notification poll cadence (4s when anything is in_progress,
 *      30s otherwise, paused when tab hidden) drives the indicator
 *      live without any new HTTP traffic.
 *
 *   2. **`isDeepDiveGenerating` prop on `<TeachingPiece>`** lets
 *      the piece render a spinner + pulse when its id is in the set.
 *
 *   3. **The "Go deeper" link stays clickable while generating** —
 *      clicking jumps to the deep-dive view (which has the full
 *      progress UI). We don't disable the button; we just decorate
 *      it with `ring-1 ring-accent/40 animate-pulse` and a small
 *      inline ring spinner next to the label. `aria-busy` is set so
 *      AT users hear "Go deeper, busy" instead of just "Go deeper".
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("BriefingPage derives a Set of in-flight deep-dive piece ids", () => {
  it("imports useNotifications and uses it to feed the per-piece indicator", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).toContain('import { useNotifications } from "../hooks/useNotifications"');
    expect(src).toMatch(/const \{ notifications: appNotifications \} = useNotifications\(\)/);
  });

  it("filters notifications to in-progress `deep_dive` rows and reads `payload.pieceId`", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).toMatch(/n\.kind !== "deep_dive"/);
    expect(src).toMatch(/n\.status !== "in_progress"/);
    expect(src).toMatch(/\(n\.payload as \{ pieceId\?: unknown \}\)\?\.pieceId/);
    // typeof-check before adding so a malformed payload can't crash
    // the briefing page.
    expect(src).toMatch(/typeof pid === "string"/);
  });

  it("passes the per-piece flag down to <TeachingPiece>", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).toMatch(
      /<TeachingPiece[\s\S]{0,800}isDeepDiveGenerating=\{generatingDeepDiveIds\.has\(piece\.id\)\}/,
    );
  });
});

describe("<TeachingPiece> surfaces in-flight state on Go deeper", () => {
  it("accepts the new prop with a safe default", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/isDeepDiveGenerating\?:\s*boolean/);
    expect(src).toMatch(/isDeepDiveGenerating = false/);
  });

  it("decorates the Go deeper Link with ring-pulse and a small inline spinner", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // Pulse + ring tint applied conditionally on the prop. The
    // ring-1 + ring-accent/40 combo reads as "doing something"
    // without competing with the regular accent button styling.
    expect(src).toMatch(/isDeepDiveGenerating \? "ring-1 ring-accent\/40 animate-pulse" : ""/);
    // Inline ring spinner next to the label, only when generating.
    expect(src).toMatch(
      /isDeepDiveGenerating &&[\s\S]{0,300}border-2 border-accent border-t-transparent animate-spin/,
    );
  });

  it("link stays clickable while generating (no disabled / no preventDefault)", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // Specifically make sure the Link is not turned into a <span>
    // or wrapped with `pointer-events-none` while generating —
    // clicking through is the user's escape hatch to the full
    // deep-dive progress view.
    expect(src).not.toMatch(/pointer-events-none[\s\S]{0,200}isDeepDiveGenerating/);
    expect(src).not.toMatch(/disabled=\{isDeepDiveGenerating\}/);
  });

  it("sets aria-busy and a hover title while generating for accessibility", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/aria-busy=\{isDeepDiveGenerating \|\| undefined\}/);
    expect(src).toMatch(
      /title=\{[\s\S]{0,200}isDeepDiveGenerating[\s\S]{0,200}Deep dive is being generated/,
    );
  });

  it("hides the read-time pill while generating (it doesn't exist yet)", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The "· 5 min" suffix only renders for completed deep dives.
    // While generating, the spinner takes the visual real estate;
    // the read time would be misleading anyway since it isn't
    // populated until the deep-dive content lands.
    expect(src).toMatch(
      /!isDeepDiveGenerating && piece\.deep_dive_read_time \? \([\s\S]{0,200}deep_dive_read_time/,
    );
  });
});
