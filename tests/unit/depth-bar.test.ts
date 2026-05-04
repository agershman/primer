/**
 * Pins the trail-header DepthBar's hover-detail contract.
 *
 * The previous implementation was a 6-segment flex bar with
 * equal-width "empty" placeholders + a native `title="Depth
 * distribution"` tooltip — visually it was ambiguous (you couldn't
 * read "6 unverified, 2 aware" at a glance) and on hover the user
 * just saw the literal string "Depth distribution" with no actual
 * detail.
 *
 * The fix shifts the bar to PROPORTIONAL widths (segments sized as
 * their share of the trail's total) and replaces the native title
 * with a rich popover that breaks down each of the 6 depth buckets
 * by label / count / percent. The directly-hovered segment is
 * highlighted in the popover so the bar slice and tooltip row read
 * as the same visual element.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("DepthBar visual encoding", () => {
  it("uses proportional widths (CSS `width: %`) instead of flex placeholders", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // The new code computes each segment's width from its share of
    // the total, NOT from a flex slot. The pre-fix `flex: pct > 0
    // ? pct : 0.5` line is gone.
    expect(src).toMatch(/width: `\$\{pct\}%`/);
    expect(src).not.toMatch(/flex:\s*pct\s*>\s*0\s*\?\s*pct\s*:\s*0\.5/);
  });

  it("skips empty buckets in the bar itself (no microscopic placeholder slivers)", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/if \(pct === 0\) return null/);
  });

  it("renders no bar at all when the trail has zero concepts", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/if \(total === 0\) return null/);
  });

  it("the unverified bucket (depth 0) reads as muted vs deep buckets", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // Depth 0 gets a flat 0.22 opacity so "unverified" doesn't
    // dominate the visual; depths 1–5 ramp 0.52 → 1.16 (clipped at
    // browser side to 1.0). The contrast makes deep concepts
    // visibly pop.
    expect(src).toMatch(/b === 0 \? 0\.22 : 0\.36 \+ b \* 0\.16/);
  });
});

describe("DepthBar hover tooltip", () => {
  it("opens on parent mouseenter and closes on mouseleave", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // The wrapper drives `open`; segments drive `hovered` for
    // per-row highlight inside the tooltip.
    expect(src).toMatch(/onMouseEnter=\{\(\) => setOpen\(true\)\}/);
    expect(src).toMatch(/onMouseLeave=\{\(\) => \{[\s\S]{0,200}setOpen\(false\)/);
  });

  it("renders a DepthBarTooltip helper, not a native `title` attribute", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/function DepthBarTooltip/);
    // Native `title="Depth distribution"` is gone in favor of an
    // aria-label on the bar + a real tooltip popover. Make sure
    // the old crutch isn't still sitting alongside.
    expect(src).not.toMatch(/title="Depth distribution"/);
  });

  it("uses role='tooltip' for accessibility", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/role="tooltip"/);
  });

  it("highlights the hovered segment in the tooltip rows", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // Tooltip rows highlight when their depth matches `hovered`,
    // so the bar slice and the tooltip row read as one element.
    expect(src).toMatch(/const isHighlighted = highlight === b/);
    expect(src).toMatch(/isHighlighted \? "bg-surface-hover" : ""/);
  });

  it("ships the FULL 0-5 breakdown in the tooltip, including buckets with count 0", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // Tooltip iterates `buckets` (the full 0-5 list) — empty
    // buckets render at "0" rather than being filtered out, so the
    // user can see the full distribution at a glance.
    expect(src).toMatch(/buckets\.map\(\(b, i\) => \{[\s\S]{0,200}const count = counts\[i\]/);
  });

  it("each tooltip row shows depth number, label, count, and percentage", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/DEPTH_LABELS\[b\]/);
    expect(src).toMatch(/pct\.toFixed\(0\)/);
    // The depth NUMBER (0/1/2/3/4/5) appears alongside the label so
    // users learning the rubric can correlate "depth 3" → "Applies".
    expect(src).toMatch(/className="font-mono text-\[10px\] text-text-faint shrink-0 w-3 text-right"[\s\S]{0,100}\{b\}/);
  });
});

describe("DepthBar accessibility", () => {
  it("declares an aria-label that reads as natural English (count + label)", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // e.g. "Depth distribution: 6 of 8 unknown, 2 of 8 aware".
    // Built dynamically from populated buckets so screen readers
    // hear the same content sighted users see.
    expect(src).toMatch(/of \$\{total\} \$\{DEPTH_LABELS\[b\]\.toLowerCase\(\)\}/);
    expect(src).toMatch(/Depth distribution: no concepts/);
    // The bar carries role="img" + the dynamic label.
    expect(src).toMatch(/role="img"\s+aria-label=\{ariaLabel\}/);
  });
});

describe("DEPTH_LABELS stays in sync with the help-doc rubric", () => {
  // The 0-5 scale is documented at /help/concepts/depth-scale.
  // If the labels here drift from the doc, users see one rubric
  // in the trail tooltip and a different one in the help page —
  // exactly the source of confusion the user reported the bar
  // creating in the first place. Pin both in the same test.
  it("matches the canonical 0=Unknown, 1=Aware, 2=Understands, 3=Applies, 4=Teaches, 5=Authoritative scale", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/0:\s*"Unknown"/);
    expect(src).toMatch(/1:\s*"Aware"/);
    expect(src).toMatch(/2:\s*"Understands"/);
    expect(src).toMatch(/3:\s*"Applies"/);
    expect(src).toMatch(/4:\s*"Teaches"/);
    expect(src).toMatch(/5:\s*"Authoritative"/);
  });

  it("the help doc still uses the same labels", async () => {
    const doc = await read("src/frontend/help/concepts/depth-scale.md");
    expect(doc).toMatch(/0\s*—\s*Unknown/);
    expect(doc).toMatch(/1\s*—\s*Aware/);
    expect(doc).toMatch(/2\s*—\s*Understands/);
    expect(doc).toMatch(/3\s*—\s*Applies/);
    expect(doc).toMatch(/4\s*—\s*Teaches/);
    expect(doc).toMatch(/5\s*—\s*Authoritative/);
  });
});
