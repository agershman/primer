import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useBaseline } from "../hooks/useQuiz";
import { apiGet } from "../utils/api";
import { DepthIndicator } from "./DepthIndicator";
import { DictationButton } from "./DictationButton";
import { ScoringReasoning } from "./ScoringReasoning";

export function BaselineQuiz() {
  // ───────────── HOOKS — must always run, in the same order, every render ─────────────
  // Conditional early returns below depend on these states; if any hook is
  // declared *after* an early return, React error #310 will fire as soon as
  // the conditional flips. Keep all hooks above the first conditional return.
  const {
    questions,
    currentIndex,
    answers,
    assessments,
    loading,
    generating,
    submitting,
    done,
    resumed,
    fetchBaseline,
    submitBaselineAnswer,
    next,
    prev,
  } = useBaseline();
  const [answer, setAnswer] = useState("");
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);
  /**
   * Map of assessment artifacts that arrived via polling
   * (`/api/quiz/:id/assessment`) AFTER the initial mount. Carries
   * the same shape as the hook's resumed-batch assessments
   * (depth + reasoning + gaps + learning path) so the row-render
   * code can read from either source uniformly.
   */
  const [polledAssessments, setPolledAssessments] = useState<
    Map<
      string,
      {
        assessedDepth: number;
        reasoning?: string | null;
        gaps?: { summary?: string; specifics: string[] };
        learningPath?: Array<{ action: string; resource?: { title: string; url: string } }>;
      }
    >
  >(new Map());
  const pollingRef = useRef(false);

  useEffect(() => {
    fetchBaseline();
  }, [fetchBaseline]);

  const current = questions[currentIndex] ?? null;
  const previousAnswer = current ? answers.get(current.id) : undefined;

  useEffect(() => {
    setAnswer(previousAnswer ?? "");
    setInterim("");
  }, [currentIndex, previousAnswer]);

  // Polling for in-flight assessments.
  //
  // - Runs only when `done` is true (i.e. the user has submitted all
  //   answers OR the page resumed an in-flight batch via the status
  //   endpoint).
  // - Polls each pending quiz's `/assessment` endpoint every 3s.
  // - 30-round ceiling = 90s of foreground polling. Server-side
  //   assessment runs under `ctx.waitUntil` and isn't bounded by this
  //   loop — it will finish even if the user navigates away. The
  //   bell flips green via the `baseline_assessment_complete`
  //   notification fired from `runAssessment` once the last row in
  //   the batch lands.
  // - Cancellation flag protects against the user navigating mid-poll;
  //   without it, setState calls would still fire on stale closures.
  // - Early-exits as soon as everything's resolved so we don't keep
  //   hammering the API after a fast batch (10-15s) finishes.
  useEffect(() => {
    if (!done || pollingRef.current) return;
    pollingRef.current = true;
    const pending = questions.filter((q) => {
      const a = assessments.get(q.id);
      return a && a.assessedDepth < 0;
    });
    if (pending.length === 0) return;

    let cancelled = false;
    const pollAll = async () => {
      for (let round = 0; round < 30 && !cancelled; round++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelled) return;
        let stillPending = 0;
        for (const q of pending) {
          if (polledAssessments.has(q.id)) continue;
          try {
            const result = await apiGet<{
              pending?: boolean;
              assessedDepth?: number;
              reasoning?: string;
              gaps?: { summary?: string; specifics: string[] };
              learningPath?: Array<{ action: string; resource?: { title: string; url: string } }>;
            }>(`/api/quiz/${q.id}/assessment`);
            if (!result.pending && result.assessedDepth != null) {
              setPolledAssessments((prev) =>
                new Map(prev).set(q.id, {
                  assessedDepth: result.assessedDepth!,
                  reasoning: result.reasoning ?? null,
                  gaps: result.gaps ?? { summary: "", specifics: [] },
                  learningPath: result.learningPath ?? [],
                }),
              );
            } else {
              stillPending += 1;
            }
          } catch {
            stillPending += 1;
          }
        }
        if (stillPending === 0) return;
      }
    };
    pollAll();
    return () => {
      cancelled = true;
    };
  }, [done, questions, assessments, polledAssessments]);

  // ───────────── RENDER — conditional returns are fine below this point ─────────────

  if (loading) {
    // Two-tier loading UI:
    //
    //   - `generating` true → loud "10–20 seconds" treatment, used
    //     when the server is genuinely preparing questions
    //     (StartCalibrationButton kicked off prep, page is polling
    //     /api/quiz/baseline waiting for `generating: false`).
    //   - `generating` false → quiet generic spinner. This is the
    //     fast path: questions already exist server-side, we're
    //     just downloading them. Pre-fix the loud copy fired here
    //     too, which the user reported: "I clicked the 'ready'
    //     notification, briefly saw the loading progress, then the
    //     question." The notification said ready — there's nothing
    //     being generated, so the loud copy was a lie. The quiet
    //     spinner is honest about what's happening (a fetch) and
    //     resolves in 200–500 ms with no perception that anything
    //     is "loading" beyond the natural navigation flash.
    if (generating) {
      return (
        <div className="animate-fade-in">
          <div className="border border-border-subtle rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
              <p className="font-display text-base text-text-primary">Generating calibration questions</p>
            </div>
            <p className="font-ui text-sm text-text-dim mb-3">
              Creating personalized questions for your lowest-depth concepts. This takes 10–20 seconds…
            </p>
            <div className="h-1.5 w-full rounded-full bg-surface-active overflow-hidden">
              <div className="h-full rounded-full bg-accent animate-pulse" style={{ width: "60%" }} />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="animate-fade-in flex items-center gap-2 py-6 text-text-dim">
        <div className="h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
        <span className="font-mono text-xs">Loading…</span>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="animate-fade-in text-center py-12">
        <p className="font-ui text-sm text-text-dim mb-4">No baseline questions available.</p>
        <Link to="/" className="font-ui text-sm text-accent hover:text-accent/80 no-underline">
          ← Back to briefing
        </Link>
      </div>
    );
  }

  if (done) {
    const allResolved = questions.every((q) => {
      const a = assessments.get(q.id);
      return (a && a.assessedDepth >= 0) || polledAssessments.has(q.id);
    });
    const pendingCount = questions.filter((q) => {
      const a = assessments.get(q.id);
      return !((a && a.assessedDepth >= 0) || polledAssessments.has(q.id));
    }).length;

    return (
      <div className="animate-fade-in">
        {/*
         * Header treatment differs sharply between assessing and
         * complete so the user can read the state at a glance:
         *
         * - Assessing: a real spinner + a primary-weight headline +
         *   an explicit "you can leave this page" reassurance. The
         *   server runs the LLM assessment under `ctx.waitUntil`, so
         *   navigating away does NOT cancel it; the bell will turn
         *   green when results land. Coming back to /calibrate
         *   resumes this same view (the page is mount-aware via
         *   `useBaseline` hitting /quiz/baseline/status).
         *
         * - Complete: a checkmark + "Baseline complete" + a brief
         *   summary of what was assessed. Replaces the old single-
         *   line uppercase label which the user reported as too
         *   subtle to read as a state signal.
         */}
        {!allResolved ? (
          <div className="mb-6 rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
              <p className="font-display text-base text-text-primary">Assessing your answers</p>
            </div>
            <p className="font-ui text-sm text-text-secondary leading-relaxed mb-2">
              Primer is evaluating your responses against expected depth indicators for each concept. This usually takes
              10–30 seconds.
            </p>
            <p className="font-ui text-xs text-text-dim leading-relaxed">
              <span className="font-medium text-text-secondary">You can leave this page —</span> the work continues in
              the background. The bell{" "}
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="inline align-text-bottom"
                aria-hidden="true"
              >
                <path d="M3.5 11.5h9a1 1 0 0 0 .85-1.53A6 6 0 0 1 12 7V6a4 4 0 0 0-8 0v1a6 6 0 0 1-1.35 2.97 1 1 0 0 0 .85 1.53Z" />
                <path d="M6.5 13.5a1.5 1.5 0 0 0 3 0" />
              </svg>{" "}
              will turn green when results are ready, and you can come back here at any time to see what we've assessed
              so far.
            </p>
            <p className="font-ui text-[11px] text-text-faint mt-2">
              {pendingCount} of {questions.length} still being assessed…
            </p>
          </div>
        ) : (
          <div className="mb-6 rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div className="flex items-center gap-3">
              <span
                className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-bg shrink-0"
                aria-hidden="true"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              </span>
              <p className="font-display text-base text-text-primary">Baseline complete</p>
            </div>
            <p className="font-ui text-sm text-text-secondary leading-relaxed mt-1.5">
              Assessed {questions.length} concept{questions.length === 1 ? "" : "s"}.
              {resumed
                ? " Welcome back — these are the results from your most recent calibration."
                : " Your concept depths have been updated based on your answers."}
            </p>
          </div>
        )}

        <div className="space-y-2 mb-6">
          {questions.map((q) => {
            const a = assessments.get(q.id);
            const polled = polledAssessments.get(q.id);
            const depth = polled?.assessedDepth ?? (a && a.assessedDepth >= 0 ? a.assessedDepth : null);
            const isPending = depth == null;

            // Pending row: no reasoning yet, render a static row
            // with the Evaluating label so the user knows which
            // concepts haven't been scored yet.
            if (isPending) {
              return (
                <div key={q.id} className="flex items-center gap-3 px-1 py-0.5">
                  <span className="font-ui text-sm text-text-secondary flex-1">{q.concept}</span>
                  <span className="inline-flex items-center gap-2">
                    <span className="font-ui text-[11px] uppercase tracking-wider text-accent">Evaluating</span>
                    <span
                      className="inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
                      aria-hidden="true"
                    />
                  </span>
                </div>
              );
            }

            // Resolved row: prefer reasoning from polledAssessments
            // (which fills in as each row's `/assessment` lands)
            // and fall back to the hook's seed (only present when
            // the page resumed an existing batch from the status
            // endpoint).
            const reasoning = polled?.reasoning ?? a?.reasoning ?? null;
            const gaps = polled?.gaps ?? a?.gaps ?? { summary: "", specifics: [] };
            const learningPath = polled?.learningPath ?? a?.learningPath ?? [];
            const previousDepth = a?.previousDepth ?? null;

            return (
              <ScoringReasoning
                key={q.id}
                trigger={
                  <>
                    <span className="font-ui text-sm text-text-secondary flex-1 min-w-0 truncate">{q.concept}</span>
                    <DepthIndicator depth={depth} />
                    <span className="font-mono text-xs text-text-dim">{depth.toFixed(1)}</span>
                  </>
                }
                reasoning={reasoning}
                gaps={gaps}
                learningPath={learningPath}
                previousDepth={previousDepth}
                currentDepth={depth}
              />
            );
          })}
        </div>
        <Link
          to="/"
          className="min-h-[44px] inline-flex items-center font-ui text-sm font-medium text-accent bg-accent-dim hover:bg-accent/20 rounded-md px-4 py-2 transition-colors no-underline"
        >
          ← Back to briefing
        </Link>
      </div>
    );
  }

  const progress = (currentIndex / questions.length) * 100;

  return (
    <div className="animate-fade-in">
      <div className="h-1 w-full rounded-full bg-surface-active mb-6 overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>

      <p className="font-ui text-[10px] text-text-faint mb-1">
        Question {currentIndex + 1} of {questions.length}
      </p>

      <div className="flex items-center gap-3 mb-3">
        <span className="font-ui text-sm font-medium text-text-primary">{current.concept}</span>
        <DepthIndicator depth={current.currentDepth} />
      </div>

      <p className="font-display text-lg text-text-primary leading-snug mb-4">{current.question}</p>

      {
        <>
          <div className="relative">
            <textarea
              value={dictating && interim ? `${answer}${answer ? " " : ""}${interim}` : answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={dictating ? "Listening — start talking…" : "Type your answer or tap the mic to speak…"}
              rows={4}
              readOnly={dictating}
              className={`w-full rounded-lg border bg-surface px-4 py-3 pr-12 font-body text-sm text-text-primary placeholder:text-text-faint resize-y focus:outline-none focus:border-accent transition-colors ${
                dictating ? "border-accent ring-2 ring-accent/20 cursor-default" : "border-border"
              }`}
              data-allow-typing=""
            />
            <div className="absolute right-2 top-2">
              <DictationButton
                onTranscript={(text) => setAnswer((prev) => (prev ? `${prev} ${text}` : text))}
                onInterim={setInterim}
                onListeningChange={setDictating}
                continuous
                className="h-8 w-8"
              />
            </div>
            {dictating && (
              <p className="mt-1 font-ui text-[11px] text-accent">
                ● Listening — speak freely, pause to think, tap the mic again when you're done.
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-3 mt-3">
            {currentIndex > 0 && (
              <button
                onClick={() => prev()}
                className="min-h-[44px] rounded-md px-4 py-2 font-ui text-sm text-text-dim hover:text-text-primary hover:bg-surface-hover border border-border transition-colors"
              >
                ← Back
              </button>
            )}
            <button
              onClick={async () => {
                await submitBaselineAnswer(current.id, answer);
                setAnswer("");
                setInterim("");
                next();
              }}
              disabled={answer.trim().length === 0 || submitting}
              className={`min-h-[44px] rounded-md px-4 py-2 font-ui text-sm font-medium transition-colors ${
                answer.trim().length > 0 && !submitting
                  ? "bg-accent text-white hover:bg-accent/90"
                  : "bg-surface-active text-text-faint cursor-not-allowed"
              }`}
            >
              {submitting ? "Submitting…" : currentIndex < questions.length - 1 ? "Submit & next" : "Submit"}
            </button>
            <button
              onClick={async () => {
                await submitBaselineAnswer(current.id, "I don't know");
                setAnswer("");
                setInterim("");
                next();
              }}
              disabled={submitting}
              className="min-h-[44px] rounded-md px-4 py-2 font-ui text-sm text-text-dim hover:text-text-primary hover:bg-surface-hover border border-border transition-colors"
            >
              I don't know
            </button>
          </div>
        </>
      }
    </div>
  );
}
