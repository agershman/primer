/**
 * Pins the multi-scope calibration contract:
 *
 *   1. Top-level "Start calibration" — picks the lowest-depth
 *      concepts across ALL trails, capped at BATCH_LIMIT=6.
 *
 *   2. Per-trail "Calibrate trail (N) →" — scopes the batch to one
 *      trail (`category` filter), same cap. Wired via the
 *      `rightSlot` on TrailHeader so users on the trails view can
 *      calibrate one area at a time.
 *
 *   3. Single-batch-at-a-time rule — while ANY pending baseline
 *      rows exist for the user, the prepare endpoint short-circuits
 *      regardless of scope. Prevents duplicate questions piling up
 *      across scopes when a user clicks multiple Calibrate CTAs in
 *      quick succession.
 *
 *   4. Coverage payload on the status endpoint — `unverifiedTotal`
 *      + `byTrail` + `batchLimit` so the CTA copy can communicate
 *      the cap honestly ("X of N concepts" rather than letting the
 *      user guess why 30 concepts → 6 questions).
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
// `read` resolves a single file; `readSplitSource` additionally
// concatenates any sibling sub-directory of the same base name.
// Source-text contracts that target a route file split into a folder
// (e.g. `routes/quiz.ts` → `routes/quiz/{shared,inline,baseline}.ts`)
// should use the latter so a single regex still matches across the
// whole family.
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("server: BATCH_LIMIT is the single source of truth for session size", () => {
  it("defines BATCH_LIMIT = 6 once and uses it consistently", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/const BATCH_LIMIT = 6/);
    // Both the SQL LIMIT and the conceptCount cap should reference
    // the constant — drifting between them would let one path
    // generate 6 questions while the other promises 12.
    expect(src).toMatch(/LIMIT \$\{BATCH_LIMIT\}/);
    expect(src).toMatch(/Math\.min\([\s\S]{0,80}BATCH_LIMIT\)/);
  });
});

describe("server: prepare endpoint accepts an optional category scope", () => {
  it("parses { category } from the request body, defaulting to undefined", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/c\.req\.json<\s*\{\s*category\?:\s*string\s*\}\s*>/);
    // Empty / missing body must NOT throw — the cross-trail CTA
    // POSTs `{}` and a body-parse failure shouldn't break the flow.
    // The catch arm returns an empty object; check both the .catch
    // chain and the existence of the empty-object fallback.
    expect(src).toMatch(/\.catch\(\(\) => \(\{\}\)\)/);
  });

  it("threads category through generateBaselineQuestions via { category } option", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/interface GenerateBaselineOptions/);
    expect(src).toMatch(/options\.category/);
    expect(src).toMatch(/AND c\.category = \?/);
    // The waitUntil call passes the scope through. Tolerate either
    // the legacy bare-`{ category }` form OR the post-split form
    // where the helper signature was widened so `category` is wrapped
    // alongside other named options on a separate line.
    expect(src).toMatch(/generateBaselineQuestions\([\s\S]{0,400}\{\s*\n?\s*category[,:\s\n]/);
  });

  it("returns a scope-aware error when no concepts qualify", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Per-trail empty: "No low-depth concepts to calibrate in this trail."
    // Cross-trail empty: "No low-depth concepts to calibrate against — generate a briefing first."
    expect(src).toMatch(/No low-depth concepts to calibrate in this trail/);
    expect(src).toMatch(/No low-depth concepts to calibrate against — generate a briefing first/);
  });

  it("notification title + payload include the scope so the bell reads naturally", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/Preparing \$\{category\} calibration:/);
    expect(src).toMatch(/payload:\s*\{ conceptCount, category: category \?\? null \}/);
  });

  it("single-batch-at-a-time: pending rows in ANY scope short-circuit the next prepare", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The "while ANY pending baseline rows exist" gate is global,
    // not category-filtered. A trail-scoped POST while a cross-trail
    // batch is open returns `{ status: "ready" }` with the existing
    // count rather than starting a parallel batch.
    expect(src).toMatch(
      /quiz_type = 'baseline' AND status = 'pending'`,\s*\)\s*\.bind\(user\.userId\)[\s\S]{0,400}status: "ready"/,
    );
  });
});

describe("server: status endpoint ships coverage on every state", () => {
  it("returns coverage = { unverifiedTotal, byTrail, batchLimit }", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(
      /const coverage = \{ unverifiedTotal, byTrail, batchLimit: BATCH_LIMIT \}/,
    );
  });

  it("counts unverified per category for the byTrail breakdown", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The query GROUPs by category so the frontend can light up
    // per-trail "Calibrate (N)" CTAs without computing it client-side.
    expect(src).toMatch(
      /COALESCE\(c\.category, 'uncategorized'\) as category, COUNT\(\*\) as count[\s\S]{0,400}GROUP BY/,
    );
  });

  it("ALL exit branches (idle / generating / ready / assessing / complete) include coverage", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Each return inside the GET handler must spread `coverage` so
    // the StartCalibrationButton can render its cap-aware copy
    // regardless of which branch fired.
    const matches = src.match(/return c\.json\(\{ status: [^}]*coverage[^}]*\}\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("frontend: StartCalibrationButton supports per-scope rendering", () => {
  it("accepts category + unverifiedAvailable props", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/category\?:\s*string/);
    expect(src).toMatch(/unverifiedAvailable\?:\s*number/);
  });

  it("POSTs { category } when scoped to a trail, empty body otherwise", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(
      /const body: \{ category\?:\s*string \} = category \? \{ category \} : \{\}/,
    );
  });

  it("renders the per-session cap honestly — 'X of N' inline + tooltip", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    // The CTA label includes the count we'll generate this session.
    // This is the visible-on-page signal — concise enough to land on
    // every trail header without piling up repetitive copy.
    expect(src).toMatch(/Start calibration \(\$\{willGenerate\} of \$\{scopedAvailable\}\)/);
    // The previously-inline `<p>` helper that sat below every CTA
    // ("Up to 6 per session — finish this batch and start another
    // for the rest.") was repetitive across trails AND broke the
    // vertical alignment of trail-header rightSlots whenever a trail
    // exceeded the cap. It now lives on the button as a `title=`
    // tooltip — surfaced once on hover instead of repeated on every
    // overflowing trail row.
    expect(src).toMatch(
      /Calibrates up to \$\{batchLimit\} concepts per session — run another batch for the rest/,
    );
    // The pre-fix inline paragraph copy must NOT be in the source —
    // pin its absence so a future refactor can't silently
    // reintroduce the alignment-breaker.
    expect(src).not.toMatch(/Up to \{batchLimit\} per session — finish this batch/);
  });

  it("the button itself carries the tooltip, no inline helper paragraph", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    // The `title={tooltip}` attribute is what surfaces the cap copy
    // on hover; pin both that the button has it and that no <p> is
    // rendered as a sibling. Without the no-paragraph guard the
    // helper could come back without breaking the title test.
    expect(src).toMatch(/<button[\s\S]{0,400}title=\{tooltip\}/);
    expect(src).not.toMatch(/<p className="mt-1 font-ui text-xs text-text-faint">\s*Up to/);
  });

  it("renders an inert 'all caught up' line when scope has zero unverified", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(
      /scopedAvailable === 0[\s\S]{0,400}All concepts in this \{category \? "trail" : "graph"\} are calibrated/,
    );
  });

  it("trail-scoped CTA uses 'Calibrate trail (N)' phrasing", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/Calibrate trail \(\$\{willGenerate\}/);
  });
});

describe("frontend: TrailHeader exposes a rightSlot for the per-trail CTA", () => {
  it("supports a rightSlot prop and stops click propagation in it", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    expect(src).toMatch(/rightSlot\?:\s*ReactNode/);
    // Clicks inside the slot must NOT toggle the trail — clicking
    // the per-trail Calibrate CTA shouldn't collapse/expand the
    // trail it lives in.
    expect(src).toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it("inner toggle is a real <button> with aria-expanded", async () => {
    const src = await read("src/frontend/components/TrailHeader.tsx");
    // Refactored from a single <button> wrapping everything to a
    // <div> + inner toggle <button>, since the rightSlot can carry
    // its own interactive elements (you can't nest buttons).
    expect(src).toMatch(/<button[\s\S]{0,200}aria-expanded=\{expanded\}/);
  });
});

describe("frontend: ConceptsPage wires per-trail Calibrate CTAs into trail headers", () => {
  it("counts unverified-in-trail and only renders the CTA when > 0", async () => {
    const src = await read("src/frontend/pages/ConceptsPage.tsx");
    expect(src).toMatch(
      /const unverifiedInTrail = trail\.concepts\.filter\(\(c\) => \(c\.depth \?\? 0\) < 2\)\.length/,
    );
    // CTA renders inside the rightSlot conditional on unverified > 0.
    expect(src).toMatch(
      /unverifiedInTrail > 0 \? \([\s\S]{0,400}<StartCalibrationButton/,
    );
  });

  it("passes category + unverifiedAvailable + a count-aware label to the per-trail button", async () => {
    const src = await read("src/frontend/pages/ConceptsPage.tsx");
    expect(src).toMatch(/category=\{trail\.category\}/);
    expect(src).toMatch(/unverifiedAvailable=\{unverifiedInTrail\}/);
    expect(src).toMatch(/label=\{`Calibrate trail \(\$\{unverifiedInTrail\}\) →`\}/);
  });
});

describe("help: calibration/baseline.md documents the multi-scope flow", () => {
  it("explains the 6-question cap and links it to multi-session calibration", async () => {
    const src = await read("src/frontend/help/calibration/baseline.md");
    expect(src).toMatch(/6-question cap is intentional/);
    expect(src).toMatch(/run ~5 sessions/);
  });

  it("describes the per-trail CTA alongside the cross-trail one", async () => {
    const src = await read("src/frontend/help/calibration/baseline.md");
    expect(src).toMatch(/Calibration scopes/);
    expect(src).toMatch(/Per-trail/);
    expect(src).toMatch(/Cross-trail/);
  });
});
