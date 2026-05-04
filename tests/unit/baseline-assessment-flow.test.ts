/**
 * Pins the post-submit assessment UX:
 *
 *   1. After answering the last baseline question, the page makes
 *      it OBVIOUS that work is happening: a real spinner + clear
 *      headline + an explicit "you can leave this page" reassurance
 *      with a bell-icon callout. (The pre-fix UI was a single
 *      uppercase line + 2px pulsing dots that the user reported as
 *      indistinguishable from the finished state.)
 *
 *   2. If the user navigates away mid-assessment, the work continues
 *      server-side via `waitUntil`. Coming back to /calibrate lands
 *      on the SAME assessing view (mount-aware via `useBaseline`
 *      hitting `/api/quiz/baseline/status` first).
 *
 *   3. When the LAST pending assessment in a batch finishes, the
 *      server fires a `baseline_assessment_complete` notification
 *      so the bell flips green even when the user has tab-closed
 *      the calibration surface. Idempotent — two parallel
 *      assessments finishing at the same instant don't double-fire.
 *
 *   4. Polling on the page is durable: 90-second ceiling, early-exits
 *      when all rows resolve, cancelled cleanly on unmount.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("server: GET /quiz/baseline/status reports assessing + complete states", () => {
  it("returns `assessing` when answered baseline rows have NULL assessed_depth", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Detection logic must filter on (status='answered' AND
    // assessed_depth IS NULL) to find pending assessments.
    expect(src).toMatch(/status:\s*pendingAssessment > 0 \? "assessing" : "complete"/);
    // The recent-batch query must scope to a recent window so we
    // don't rev up the "complete" view forever after a calibration.
    expect(src).toMatch(/RECENT_BATCH_WINDOW\s*=\s*"-2 hours"/);
    expect(src).toMatch(/loadRecentBaselineBatch/);
  });

  it("returns `complete` for a recently-submitted batch with all rows assessed", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/status:\s*pendingAssessment > 0 \? "assessing" : "complete"/);
  });

  it("ships per-question payload (id, conceptId, concept, assessedDepth, previousDepth)", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/recentPayload\s*=\s*\{[\s\S]*?questions:\s*recent\.map/);
    expect(src).toMatch(/assessedDepth:\s*r\.assessed_depth/);
    expect(src).toMatch(/previousDepth:\s*r\.previous_depth/);
  });
});

describe("server: assessment-complete notification fires once at end of batch", () => {
  it("declares a dedicated `baseline_assessment_complete` notification kind", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/BASELINE_ASSESSMENT_DONE_KIND\s*=\s*"baseline_assessment_complete"/);
  });

  it("runAssessment calls the helper after persisting results", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The fire-and-forget call comes AFTER the DB writes (UPDATE
    // calibration_quizzes / concept_depth) but BEFORE the function
    // returns, so the caller's `waitUntil` keeps it alive.
    expect(src).toMatch(
      /UPDATE concept_depth[\s\S]{0,2000}recordDepthChange\([\s\S]{0,2500}maybeFireBaselineAssessmentCompleteNotification/,
    );
  });

  it("only fires when this assessment was the LAST pending one in the batch", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The helper must early-return when there are still
    // (status='answered' AND assessed_depth IS NULL) rows for the
    // user. Without this, every assessment would fire its own
    // complete-notification mid-batch.
    expect(src).toMatch(
      /status = 'answered' AND assessed_depth IS NULL[\s\S]{0,300}stillPending\?\.count[\s\S]{0,200}> 0\) return/,
    );
  });

  it("idempotency-checks for a recent same-kind notification before firing", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Two parallel runAssessment calls finishing at the same instant
    // would both see "0 remaining" — the duplicate guard catches the
    // race so the user gets exactly one bell flip per batch.
    expect(src).toMatch(/created_at >= datetime\('now', '-60 seconds'\)/);
  });

  it("links the notification back to /calibrate so the bell click resumes the view", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/actionUrl:\s*"\/calibrate"/);
    expect(src).toMatch(
      /createNotification\([\s\S]{0,500}kind:\s*BASELINE_ASSESSMENT_DONE_KIND[\s\S]{0,300}status:\s*"ready"/,
    );
  });
});

describe("frontend: useBaseline resumes a recently-submitted batch on mount", () => {
  it("calls /api/quiz/baseline/status before the regular questions endpoint", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    // The status fetch must happen first so we can detect a resume
    // case (assessing/complete) BEFORE falling through to the
    // questions endpoint (which would otherwise try to start a new
    // calibration session for an empty pending list). The
    // intermediate distance grew when we added per-row reasoning
    // artifacts to the resumed-batch seed, so the regex window is
    // generous on purpose.
    expect(src).toMatch(/apiGet<BaselineStatusResponse>\("\/api\/quiz\/baseline\/status"\)/);
    expect(src).toMatch(
      /apiGet<BaselineStatusResponse>[\s\S]{0,3000}apiGet<\{ questions: BaselineQuestion\[\][\s\S]{0,400}"\/api\/quiz\/baseline"/,
    );
  });

  it("seeds questions + assessments from the status response and sets done=true", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toMatch(/status\.status === "assessing" \|\| status\.status === "complete"/);
    expect(src).toMatch(/setDone\(true\)/);
    expect(src).toMatch(/setResumed\(true\)/);
  });

  it("uses -1 as the 'still being assessed' sentinel so the page renders Evaluating rows", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    // The hook must translate `assessedDepth: null` from the wire
    // into `assessedDepth: -1` for in-memory state — the existing
    // BaselineQuiz polling effect uses `< 0` to detect "pending".
    expect(src).toMatch(/assessedDepth:\s*q\.assessedDepth \?\? -1/);
  });

  it("exposes a `resumed` flag on the hook so the UI can adjust copy", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toMatch(/resumed:\s*boolean/);
    expect(src).toMatch(/setResumed/);
  });
});

describe("frontend: BaselineQuiz post-submit view communicates state clearly", () => {
  it("renders a real spinner and 'Assessing your answers' headline (not the old uppercase label only)", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toMatch(/Assessing your answers/);
    // animate-spin class on the headline spinner — this is the
    // visual signal the user reported was missing.
    expect(src).toMatch(/border-t-transparent animate-spin shrink-0/);
  });

  it("includes the explicit 'you can leave this page' reassurance + bell callout", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toMatch(/You can leave this page/);
    // The bell svg sits inline so the user knows where the green
    // signal will appear.
    expect(src).toMatch(/will turn green when results are ready/);
  });

  it("renders per-row 'Evaluating' label + spinner (not just a 2px pulse dot)", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // The pre-fix code used a 2px (h-2 w-2) pulsing dot — too subtle.
    // The new pending state has a label AND a spinner.
    expect(src).toMatch(/Evaluating[\s\S]{0,400}border-t-transparent animate-spin/);
  });

  it("shows 'N of M still being assessed' progress copy", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toMatch(/of \{questions\.length\} still being assessed/);
  });

  it("the complete view changes copy when the user resumed (not first-finish)", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toMatch(/Welcome back/);
    expect(src).toMatch(/results from your most recent calibration/);
  });

  it("polling has a 90s ceiling, early-exits on full resolution, cancels on unmount", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // 30 rounds × 3000 ms = 90 s ceiling.
    expect(src).toMatch(/round < 30/);
    // Early exit: the inner loop counts stillPending and bails when 0.
    expect(src).toMatch(/if \(stillPending === 0\) return/);
    // Cleanup function flips a cancelled flag the loop reads.
    expect(src).toMatch(/let cancelled = false/);
    expect(src).toMatch(/cancelled = true/);
  });
});

describe("api-endpoints help doc covers the new states + notification", () => {
  it("documents `assessing` and `complete` on the status endpoint", async () => {
    const src = await read("src/frontend/help/reference/api-endpoints.md");
    expect(src).toMatch(/baseline\/status/);
    expect(src).toMatch(/assessing/);
    expect(src).toMatch(/complete/);
  });
});
