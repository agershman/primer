/**
 * Pins the per-stat hover-explainer + latest-assessment reveal on
 * the Concepts surface.
 *
 * The complaint that triggered this: a user opens a concept, sees
 * "Depth: 1.5  Confidence: 15%  Exposures: 0" and has no idea what
 * any of those numbers represent or why they got a 1.5. Pre-fix the
 * tooltips were single-line text ("Current depth score on a 0-5
 * scale") and the assessment reasoning lived only inside the
 * collapsed "Quiz history" rows on the full /concepts/:id page —
 * never visible without a click.
 *
 * The fix:
 *
 *   1. Three reusable rich-content guides — `<DepthGuide>`,
 *      `<ConfidenceGuide>`, `<ExposuresGuide>` — render structured
 *      explanations inside a Tooltip popover. The Depth one shows
 *      the full 0-5 rubric with the user's current bucket
 *      highlighted; the others give a focused 2-paragraph
 *      explanation. Each links to the matching help doc.
 *
 *   2. A `<ConceptStat>` wrapper renders the value + tooltipped
 *      label with an `ⓘ` glyph so the hover affordance reads
 *      before the user actually hovers.
 *
 *   3. A "Why this score" panel inline (no second expand) on both
 *      the inline-expanded list view AND the full /concepts/:id
 *      page, pulling the most recent quiz_assessment's reasoning
 *      out of `concept_depth_history` and stripping the
 *      "Quiz <id>: " prefix.
 *
 *   4. Single source of truth for the depth labels (in
 *      `ConceptStatGuide.tsx`); pinned to match the canonical
 *      0-5 rubric in `/help/concepts/depth-scale`.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("ConceptStatGuide module", () => {
  it("exports the three guide components + ConceptStat wrapper", async () => {
    const src = await read("src/frontend/components/ConceptStatGuide.tsx");
    expect(src).toMatch(/export function ConceptStat/);
    expect(src).toMatch(/export function DepthGuide/);
    expect(src).toMatch(/export function ConfidenceGuide/);
    expect(src).toMatch(/export function ExposuresGuide/);
  });

  it("ConceptStat wraps the label + ⓘ glyph in a Tooltip with the right width", async () => {
    const src = await read("src/frontend/components/ConceptStatGuide.tsx");
    expect(src).toMatch(/<Tooltip content=\{tooltip\} width=\{tooltipWidth\}>/);
    expect(src).toMatch(/<InfoIcon \/>/);
    // cursor-help on the trigger so users know the label is hoverable
    // even before the popover appears.
    expect(src).toMatch(/cursor-help/);
  });

  it("DepthGuide renders all six 0-5 rows with the matching rubric labels", async () => {
    const src = await read("src/frontend/components/ConceptStatGuide.tsx");
    // Pin the canonical rubric — same vocabulary used on the trail
    // header DepthBar tooltip and the help/concepts/depth-scale doc.
    expect(src).toMatch(/level: 0, label: "Unknown"/);
    expect(src).toMatch(/level: 1, label: "Aware"/);
    expect(src).toMatch(/level: 2, label: "Understands"/);
    expect(src).toMatch(/level: 3, label: "Applies"/);
    expect(src).toMatch(/level: 4, label: "Teaches"/);
    expect(src).toMatch(/level: 5, label: "Authoritative"/);
  });

  it("DepthGuide highlights the user's current bucket via Math.round(value)", async () => {
    const src = await read("src/frontend/components/ConceptStatGuide.tsx");
    expect(src).toMatch(/const rounded = Math\.round\(value\)/);
    expect(src).toMatch(/const active = row\.level === rounded/);
  });

  it("each guide links to the matching help doc", async () => {
    const src = await read("src/frontend/components/ConceptStatGuide.tsx");
    expect(src).toMatch(/to="\/help\/concepts\/depth-scale"/);
    expect(src).toMatch(/to="\/help\/concepts\/confidence"/);
  });

  it("matches the canonical depth rubric in /help/concepts/depth-scale", async () => {
    // Cross-doc consistency check — the labels in the popover MUST
    // align with the labels in the help page so the user reading
    // the popover and the user clicking through to the guide see
    // the same rubric.
    const doc = await read("src/frontend/help/concepts/depth-scale.md");
    expect(doc).toMatch(/0\s*—\s*Unknown/);
    expect(doc).toMatch(/1\s*—\s*Aware/);
    expect(doc).toMatch(/2\s*—\s*Understands/);
    expect(doc).toMatch(/3\s*—\s*Applies/);
    expect(doc).toMatch(/4\s*—\s*Teaches/);
    expect(doc).toMatch(/5\s*—\s*Authoritative/);
  });
});

describe("ConceptList — inline expansion uses the rich tooltips + reasoning panel", () => {
  it("imports + uses the shared ConceptStat / guide components", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    expect(src).toMatch(
      /import \{[\s\S]{0,400}ConceptStat[\s\S]{0,400}ConfidenceGuide[\s\S]{0,400}DepthGuide[\s\S]{0,400}ExposuresGuide[\s\S]{0,400}\} from "\.\/ConceptStatGuide"/,
    );
    expect(src).toMatch(/<ConceptStat\s+label="Depth"/);
    expect(src).toMatch(/<ConceptStat\s+label="Confidence"/);
    expect(src).toMatch(/<ConceptStat\s+label="Exposures"/);
  });

  it("does NOT keep duplicate guide implementations (single source of truth)", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    // The pre-fix file briefly held inline copies of the guides
    // before they were extracted to `ConceptStatGuide.tsx`. Pin
    // their absence so a future refactor doesn't accidentally
    // re-fork them.
    expect(src).not.toMatch(/^const DEPTH_LEGEND/m);
    expect(src).not.toMatch(/^function DepthGuide/m);
    expect(src).not.toMatch(/^function InfoIcon/m);
  });

  it("inline expansion surfaces the latest quiz assessment reasoning prominently", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    // Find the most recent quiz_assessment entry from the loaded
    // history. The `reverse().find()` pattern matters: history is
    // ASC-ordered from the API, so the LAST quiz row is the most
    // recent.
    expect(src).toMatch(
      /\[\.\.\.data\.history\]\.reverse\(\)\.find\(\(h\) => h\.source === "quiz_assessment"\)/,
    );
    // The "Quiz <id>: " prefix is stripped so the reasoning reads
    // as natural prose inside the panel.
    expect(src).toMatch(/replace\(\/\^Quiz \[\^:\]\+:\\s\*\/, ""\)/);
    // The panel header reads "Why this score" — same wording as
    // the per-history-row drilldown for vocabulary consistency.
    expect(src).toMatch(/Why this score/);
  });

  it("inline panel includes a 'View quiz history →' link to the full concept page", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    expect(src).toMatch(/View quiz history →/);
    expect(src).toMatch(/to=\{`\/concepts\/\$\{concept\.id\}`\}/);
  });
});

describe("ConceptDetail — same enrichment on the full /concepts/:id page", () => {
  it("imports + uses ConceptStat for Depth / Confidence / Exposures", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    expect(src).toMatch(
      /import \{[\s\S]{0,400}ConceptStat[\s\S]{0,400}\} from "\.\/ConceptStatGuide"/,
    );
    expect(src).toMatch(/<ConceptStat[\s\S]{0,400}label="Depth"/);
    expect(src).toMatch(/<ConceptStat[\s\S]{0,400}label="Confidence"/);
    expect(src).toMatch(/<ConceptStat[\s\S]{0,400}label="Exposures"/);
  });

  it("renders a <LatestAssessment> panel above the existing Quiz history", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    expect(src).toMatch(/<LatestAssessment history=\{history\} conceptId=\{concept\.id\}/);
    expect(src).toMatch(/function LatestAssessment/);
  });

  it("LatestAssessment scans newest-first for the most recent quiz_assessment row", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    // history is ASC; we reverse + find so the LATEST quiz row is
    // the one that drives the panel — matching the inline-expansion
    // behavior in ConceptList.
    expect(src).toMatch(
      /\[\.\.\.history\]\.reverse\(\)\.find\(\(h\) => h\.source === "quiz_assessment"\)/,
    );
  });

  it("LatestAssessment renders nothing when no quiz_assessment row exists yet", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    // Freshly-extracted concepts never calibrated should NOT show an
    // empty "Why this score" block.
    expect(src).toMatch(/if \(!latest\?\.detail\) return null/);
    expect(src).toMatch(/if \(!reasoning\.trim\(\)\) return null/);
  });
});
