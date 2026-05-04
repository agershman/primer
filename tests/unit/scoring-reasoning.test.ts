/**
 * Pins the "Why this score?" reasoning surface — added so the
 * Baseline complete overview and the per-concept Quiz history both
 * let the user drill into the LLM's reasoning without leaving
 * context (the original UI showed depth dots + a number with no
 * affordance for *why*).
 *
 * Three layers of contract:
 *
 *   1. Server payload: `/api/quiz/baseline/status` and
 *      `/api/quiz/:id/assessment` ship `reasoning`, `gaps`,
 *      `learningPath` so the page can render expansions inline
 *      without an extra fetch per row.
 *
 *   2. <ScoringReasoning> component: a reusable inline-row
 *      expandable panel that surfaces reasoning + gaps + suggested
 *      next steps. Built with native `<details>` for keyboard +
 *      screen-reader accessibility.
 *
 *   3. Surfaces wired:
 *        - `BaselineQuiz` "Baseline complete" rows
 *        - `ConceptDetail` "Quiz history" rows (with the
 *          "Quiz <id>: " prefix stripped from change_detail)
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
// Use `readSrc` for any source file whose handlers may have moved
// into a sibling sub-directory (e.g. `routes/quiz.ts` →
// `routes/quiz/{shared,inline,baseline}.ts`). It transparently
// concatenates the assembly file with every sub-file so a single
// regex still matches across the whole family.
const readSrc = readSplitSource;

describe("server: baseline status payload carries reasoning artifacts per row", () => {
  it("loadRecentBaselineBatch SELECTs assessment_reasoning + gaps + learning_path", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(
      /q\.assessment_reasoning,\s*q\.assessment_gaps,\s*q\.assessment_learning_path/,
    );
  });

  it("recent.questions payload includes reasoning + parsed gaps + parsed learning path", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/reasoning:\s*r\.assessment_reasoning/);
    // Gaps + learningPath are JSON columns on the wire; the route
    // parses them with a defensive `safeJsonParse` so a malformed
    // row can't take the whole status fetch down.
    expect(src).toMatch(/safeJsonParse[\s\S]{0,200}r\.assessment_gaps/);
    expect(src).toMatch(/safeJsonParse[\s\S]{0,200}r\.assessment_learning_path/);
  });

  it("safeJsonParse falls back to a sane default rather than throwing", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/function safeJsonParse[\s\S]{0,300}return fallback/);
    expect(src).toMatch(/catch \{[\s\S]{0,100}return fallback/);
  });
});

describe("server: concept_depth_history preserves the FULL reasoning", () => {
  // Earlier code passed `result.reasoning.slice(0, 200)` — that
  // truncation prevented the Concept Detail history row from
  // rendering a meaningful "Why this score?" expansion. We dropped
  // the slice so newer rows carry the full text. (Older rows from
  // before this change still show truncated text; that's
  // acceptable given the SQL column is text.)
  it("recordDepthChange call no longer slices reasoning to 200 chars", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).not.toMatch(/result\.reasoning\.slice\(0, 200\)/);
    expect(src).toMatch(/`Quiz \$\{quizId\}: \$\{result\.reasoning\}`/);
  });
});

describe("hook: useBaseline carries assessment artifacts on resumed batches", () => {
  it("BaselineAssessmentDetail type widens to include reasoning + gaps + learningPath", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toMatch(/export interface BaselineAssessmentDetail/);
    expect(src).toMatch(/reasoning\?:\s*string \| null/);
    expect(src).toMatch(/gaps\?:\s*\{[\s\S]{0,200}specifics:\s*string\[\]/);
    expect(src).toMatch(/learningPath\?:\s*Array</);
  });

  it("seeds reasoning data into the assessments map when resuming", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toMatch(/reasoning:\s*q\.reasoning \?\? null/);
    expect(src).toMatch(/gaps:\s*q\.gaps \?\? \{ summary: "", specifics: \[\] \}/);
    expect(src).toMatch(/learningPath:\s*q\.learningPath \?\? \[\]/);
  });

  it("submitBaselineAnswer seeds an empty placeholder so the row shape is uniform", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    // Pending rows seeded by the submit path get the same shape as
    // resumed-batch rows (with -1 sentinel). Row-rendering code
    // can read either uniformly.
    expect(src).toMatch(
      /assessedDepth:\s*-1[\s\S]{0,200}reasoning:\s*null[\s\S]{0,200}gaps:\s*\{ summary:\s*"",\s*specifics:\s*\[\] \}/,
    );
  });
});

describe("<ScoringReasoning> component shape", () => {
  it("uses native <details>/<summary> for accessibility", async () => {
    const src = await read("src/frontend/components/ScoringReasoning.tsx");
    // The element class is a template literal so the JSX form is
    // `<details className={\`group ...`. Match on the element +
    // first class fragment regardless of attribute syntax.
    expect(src).toMatch(/<details className=\{`group rounded-md/);
    expect(src).toMatch(/<summary className="cursor-pointer list-none/);
  });

  it("renders three sections — Why this score, Where to sharpen, Suggested next steps", async () => {
    const src = await read("src/frontend/components/ScoringReasoning.tsx");
    expect(src).toMatch(/Why this score/);
    expect(src).toMatch(/Where to sharpen/);
    expect(src).toMatch(/Suggested next steps/);
  });

  it("degrades to a static row (no chevron) when there's nothing to expand", async () => {
    const src = await read("src/frontend/components/ScoringReasoning.tsx");
    // The fallback path renders a plain flex row WITHOUT the
    // <details> wrapper — keeps list density consistent between
    // rows that have reasoning and rows that don't. The className
    // is a template literal so we anchor on the class fragment
    // without requiring a particular quoting style.
    expect(src).toMatch(/if \(!expandable\)[\s\S]{0,300}flex items-center gap-3/);
  });

  it("animates the chevron via group-open:rotate-180 so the open/closed state reads visually", async () => {
    const src = await read("src/frontend/components/ScoringReasoning.tsx");
    expect(src).toMatch(/group-open:rotate-180/);
  });

  it("renders a previous → current delta when both depths are provided", async () => {
    const src = await read("src/frontend/components/ScoringReasoning.tsx");
    expect(src).toMatch(/function DeltaPanel/);
    expect(src).toMatch(/previous\.toFixed\(1\)[\s\S]{0,200}current\.toFixed\(1\)/);
  });

  it("links optional learning-path resources with target=_blank rel=noopener", async () => {
    const src = await read("src/frontend/components/ScoringReasoning.tsx");
    expect(src).toMatch(/target="_blank"\s+rel="noopener noreferrer"/);
  });
});

describe("BaselineQuiz: Baseline complete rows expand to show reasoning", () => {
  it("imports + uses <ScoringReasoning> for resolved rows", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toContain('import { ScoringReasoning } from "./ScoringReasoning"');
    expect(src).toMatch(/<ScoringReasoning/);
  });

  it("captures reasoning + gaps + learningPath from the polling response", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // The response type for /quiz/:id/assessment widens to include
    // reasoning fields, and the polling effect threads them into
    // polledAssessments so the row-render code can read them.
    expect(src).toMatch(/reasoning\?:\s*string/);
    expect(src).toMatch(/setPolledAssessments[\s\S]{0,400}reasoning:\s*result\.reasoning/);
  });

  it("prefers polled reasoning over hook-seeded reasoning when both are present", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // `polled` is the most-recently-fetched data (from
    // /assessment), `a` is the seed from the resumed-batch status
    // call. Polling keeps state fresh as each row lands so
    // polled-first is the correct precedence.
    expect(src).toMatch(/const reasoning = polled\?\.reasoning \?\? a\?\.reasoning \?\? null/);
  });

  it("pending rows (still being assessed) render WITHOUT the expansion affordance", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // Returns a static "Evaluating" row, separate from the
    // ScoringReasoning component, so users don't click into an
    // empty panel before the LLM has produced reasoning. The
    // returned JSX comes BEFORE the literal "Evaluating" string
    // (it's `return ( ... <span>Evaluating</span> ... )`).
    expect(src).toMatch(
      /if \(isPending\) \{[\s\S]{0,300}return \([\s\S]{0,800}Evaluating/,
    );
  });
});

describe("ConceptDetail: Quiz history rows expand to show reasoning", () => {
  it("imports + uses <ScoringReasoning> for each history row", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    expect(src).toContain('import { ScoringReasoning } from "./ScoringReasoning"');
    expect(src).toMatch(/<ScoringReasoning/);
  });

  it("strips the 'Quiz <id>: ' prefix from change_detail before rendering", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    // recordDepthChange writes "Quiz <id>: <reasoning>"; the row
    // shows just the reasoning in the expansion so it reads as
    // prose rather than as machine-tagged metadata.
    expect(src).toMatch(/replace\(\/\^Quiz \[\^:\]\+:\\s\*\/, ""\)/);
  });

  it("only treats source='quiz_assessment' rows as having reasoning", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    // Other history sources (extraction, decay, manual) shouldn't
    // produce a "Why this score?" panel — their detail is a
    // one-liner not a reasoning passage.
    expect(src).toMatch(/const isQuiz = entry\.source === "quiz_assessment"/);
  });

  it("computes a previous → current delta from the prior history entry", async () => {
    const src = await read("src/frontend/components/ConceptDetail.tsx");
    // The history table is ordered ASC, so entry[i-1] is the
    // previous depth for entry[i]. The first entry has no prior
    // and its previousDepth resolves to null (no delta rendered).
    expect(src).toMatch(/const previousDepth = i > 0 \? \(history\[i - 1\]\.depth \?\? null\) : null/);
  });
});
