/**
 * Pins the Tooltip alignment / nowrap escape hatches added so
 * triggers near a viewport edge don't render as a vertical
 * one-word-per-line column.
 *
 * The user reported the suppress (✕) button on the Concepts list
 * showing a tooltip with "Not interested — hide this concept and
 * stop re-extracting it" wrapped to ~10 lines because the
 * center-aligned tooltip got squeezed against the right edge of
 * the viewport. The fix:
 *
 *   - Tooltip gains `align="start" | "center" | "end"` so the
 *     caller can right-anchor (or left-anchor) the popover when the
 *     trigger is near a corresponding edge. Default stays "center"
 *     so the rest of the codebase isn't affected.
 *   - Tooltip gains a `noWrap` boolean for short, single-line
 *     labels — `whitespace-nowrap` overrides the width clamp.
 *   - ConceptList's suppress tooltip uses both: `align="end"` to
 *     anchor leftward, `noWrap` to stay on one line.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("Tooltip component supports edge-aware positioning", () => {
  it("declares `align` with start / center / end variants", async () => {
    const src = await read("src/frontend/components/Tooltip.tsx");
    expect(src).toMatch(/align\?:\s*"start" \| "center" \| "end"/);
  });

  it("maps each alignment to the correct positioning class", async () => {
    const src = await read("src/frontend/components/Tooltip.tsx");
    // start = left:0, end = right:0, center = left-1/2 + translate
    expect(src).toMatch(/align === "start"\s*\?\s*"left-0"/);
    expect(src).toMatch(/align === "end"[\s\S]{0,80}"right-0"/);
    expect(src).toMatch(/"left-1\/2 -translate-x-1\/2"/);
  });

  it("declares `noWrap` and uses whitespace-nowrap when set", async () => {
    const src = await read("src/frontend/components/Tooltip.tsx");
    expect(src).toMatch(/noWrap\?:\s*boolean/);
    // When noWrap=true, the width prop is overridden by
    // whitespace-nowrap so the tooltip grows to its natural width.
    expect(src).toMatch(/noWrap \? "whitespace-nowrap" : width/);
  });

  it("backwards compatible: default align is center, default noWrap is false", async () => {
    const src = await read("src/frontend/components/Tooltip.tsx");
    expect(src).toMatch(/align = "center"/);
    expect(src).toMatch(/noWrap = false/);
  });
});

describe("ConceptList suppress tooltip uses align=end + noWrap", () => {
  it("the suppress (✕) tooltip right-anchors and stays on one line", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    expect(src).toMatch(
      /<Tooltip[\s\S]{0,300}align="end"[\s\S]{0,200}noWrap[\s\S]{0,400}Not interested/,
    );
  });

  it("does NOT use the default center-aligned form here", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    // The pre-fix shape was a single-line `<Tooltip content={...}>`
    // with no align prop — that's exactly what triggered the
    // viewport-edge wrap. Make sure it's gone.
    expect(src).not.toMatch(
      /<Tooltip content=\{suppressed \? "Unsuppress[\s\S]{0,200}: "Not interested[\s\S]{0,200}\}>/,
    );
  });
});
