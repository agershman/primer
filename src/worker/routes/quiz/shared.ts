/**
 * Shared building blocks for the quiz routes.
 *
 * Why this lives in its own file: the quiz routes split into two
 * surfaces (inline calibration in [`./inline.ts`](./inline.ts) and
 * the baseline-batch flow in [`./baseline.ts`](./baseline.ts)), but
 * they overlap on a handful of constants and helpers — the
 * notification kinds, the batch-size cap, the assessment runner.
 * Centralising here keeps both files small and avoids accidental
 * drift if a constant changes.
 *
 * @see ../quiz.ts — the assembly entry point
 * @see .cursor/rules/api-routes.mdc — Hono route conventions
 */

import { resolveModel } from "../../config/models.js";
import { createNotification, transitionNotification } from "../../db/notifications-queries.js";
import { genId, recordDepthChange } from "../../db/queries.js";
import { llmClient } from "../../integrations/llm/dispatcher.js";
import { assessQuizAnswer, generateQuiz } from "../../services/quiz-assessor.js";
import type { Env } from "../../types.js";

/**
 * Notification kind for the async baseline-calibration prep flow.
 * Centralized so the GET endpoint and the prepare endpoint agree on
 * how to detect an in-flight job.
 */
export const BASELINE_NOTIFICATION_KIND = "baseline_calibration";

/**
 * Notification kind fired ONCE when all answered baseline quizzes in
 * a recent batch have finished LLM assessment. Surfaces the bell
 * green-state for users who navigated away during assessment per the
 * explicit "you can leave this page" affordance.
 */
export const BASELINE_ASSESSMENT_DONE_KIND = "baseline_assessment_complete";

/**
 * How many questions a single calibration "session" can include.
 * Sized so a typical user can finish in 5-10 minutes — past that,
 * answer quality drops and people abandon mid-batch. If the user
 * has more concepts to calibrate, they run another batch.
 */
export const BATCH_LIMIT = 6;

/**
 * How recent a fully-assessed batch has to be before we still surface
 * it under `status: "complete"`. The user's intent here is "I just
 * finished, navigated away, came back — show me my results." Two
 * hours is a comfortable upper bound on that flow without rendering
 * yesterday's calibration as if it were fresh.
 */
export const RECENT_BATCH_WINDOW = "-2 hours";

export async function maybeFireBaselineAssessmentCompleteNotification(db: D1Database, userId: string): Promise<void> {
  // Are there any answered-but-unassessed rows still outstanding for
  // this user? If yes, this isn't the last one — bail out.
  const stillPending = await db
    .prepare(
      `SELECT COUNT(*) as count FROM calibration_quizzes
       WHERE user_id = ? AND quiz_type = 'baseline'
         AND status = 'answered' AND assessed_depth IS NULL`,
    )
    .bind(userId)
    .first<{ count: number }>();
  if ((stillPending?.count ?? 0) > 0) return;

  // Count rows in the just-completed batch so the notification body
  // says something meaningful ("Calibration complete: 6 concepts
  // assessed").
  const finished = await db
    .prepare(
      `SELECT COUNT(*) as count FROM calibration_quizzes
       WHERE user_id = ? AND quiz_type = 'baseline'
         AND status = 'answered' AND assessed_depth IS NOT NULL
         AND completed_at >= datetime('now', '-2 hours')`,
    )
    .bind(userId)
    .first<{ count: number }>();
  const conceptCount = finished?.count ?? 0;
  if (conceptCount === 0) return;

  // Idempotency: skip if we already fired a complete-notification
  // for this user in the last minute. Two parallel runAssessment
  // calls finishing at the same instant would otherwise each get to
  // this point and double-fire.
  const recentDup = await db
    .prepare(
      `SELECT 1 FROM notifications
       WHERE user_id = ? AND kind = ?
         AND created_at >= datetime('now', '-60 seconds')
       LIMIT 1`,
    )
    .bind(userId, BASELINE_ASSESSMENT_DONE_KIND)
    .first();
  if (recentDup) return;

  try {
    await createNotification(db, userId, {
      kind: BASELINE_ASSESSMENT_DONE_KIND,
      status: "ready",
      title: `Calibration assessment complete — ${conceptCount} concept${conceptCount === 1 ? "" : "s"}`,
      body: "Click to see your results.",
      actionUrl: "/calibrate",
      payload: { conceptCount },
    });
  } catch (err) {
    console.warn("[baseline-assess] failed to create complete notification:", err);
  }
}

export interface GenerateBaselineOptions {
  /** Optional category filter — only consider concepts whose
   *  `concepts.category` matches. Used by the per-trail
   *  "Calibrate this trail" CTA so a user focused on one area can
   *  scope a batch to that area instead of grabbing the lowest-
   *  depth concepts globally. */
  category?: string;
}

/**
 * Generate baseline calibration questions for a user's lowest-depth
 * concepts and INSERT each into `calibration_quizzes` as it lands.
 *
 * Shared between the synchronous GET fallback (for users who navigate
 * straight to /calibrate) and the async prepare endpoint (for the
 * "click → navigate away → notification" flow). Both call sites pass
 * a pre-resolved spec + about-statement so the function doesn't need
 * to understand the user-context shape.
 *
 * Optionally scoped via `options.category` — when set, only concepts
 * in that trail are considered. The cap (BATCH_LIMIT) is the same
 * either way: a single session is bounded so the user can finish.
 *
 * Returns the count of successfully generated questions. Failures on
 * a single concept are logged + skipped — the rest of the batch
 * still goes through.
 */
export async function generateBaselineQuestions(
  env: Env,
  userId: string,
  spec: ReturnType<typeof resolveModel>,
  aboutStatement: string | null,
  options: GenerateBaselineOptions = {},
): Promise<number> {
  const params: (string | number)[] = [userId];
  let categoryClause = "";
  if (options.category) {
    categoryClause = "AND c.category = ?";
    params.push(options.category);
  }
  const sql = `SELECT c.id, c.canonical_name, COALESCE(cd.depth_score, 0) as depth_score
               FROM concepts c
               LEFT JOIN concept_depth cd ON c.id = cd.concept_id
               WHERE c.user_id = ? AND COALESCE(cd.depth_score, 0) < 2 ${categoryClause}
               ORDER BY cd.depth_score ASC NULLS FIRST
               LIMIT ${BATCH_LIMIT}`;
  const lowDepth = await env.DB.prepare(sql)
    .bind(...params)
    .all<{ id: string; canonical_name: string; depth_score: number }>();

  if (lowDepth.results.length === 0) return 0;

  const llm = llmClient(env);
  let inserted = 0;

  for (const concept of lowDepth.results) {
    try {
      const quiz = await generateQuiz(env.DB, userId, llm, concept.canonical_name, concept.depth_score, {
        modelSpec: spec,
        aboutStatement,
      });
      const quizId = genId("quiz");
      await env.DB.prepare(
        `INSERT INTO calibration_quizzes
         (id, user_id, concept_id, quiz_type, question, context,
          expected_depth_indicators, status, model_used, created_at)
         VALUES (?, ?, ?, 'baseline', ?, ?, ?, 'pending', ?, datetime('now'))`,
      )
        .bind(
          quizId,
          userId,
          concept.id,
          quiz.question,
          quiz.context,
          JSON.stringify(quiz.expectedDepthIndicators),
          quiz.modelUsed,
        )
        .run();
      inserted += 1;
    } catch (err) {
      console.error(`[quiz] Failed to generate baseline for ${concept.canonical_name}:`, err);
    }
  }

  return inserted;
}

/**
 * Detect an in-flight async baseline-prep job for this user. Used by
 * the GET endpoint to skip its inline-generate fallback so the two
 * paths don't generate duplicate questions concurrently.
 */
export async function hasInFlightBaselinePrep(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM notifications
       WHERE user_id = ? AND kind = ? AND status = 'in_progress'
       LIMIT 1`,
    )
    .bind(userId, BASELINE_NOTIFICATION_KIND)
    .first();
  return !!row;
}

/**
 * Look up the most recent in_progress baseline notification for a
 * user. Returns null when nothing's in flight. Used by the GET
 * status endpoint so we can:
 *   1. Surface a `startedAt` to the client (drives the spinner copy
 *      "Generating for 12s…" if we ever want it).
 *   2. Self-heal a stuck notification: if pending baseline rows
 *      already exist but the bell is still showing in_progress, the
 *      `transitionNotification` call inside `waitUntil` was lost
 *      (worker terminated, transient D1 hiccup, etc.). The status
 *      GET catches this and flips the row to ready right there.
 */
export async function loadInFlightBaselineNotification(
  db: D1Database,
  userId: string,
): Promise<{ id: string; createdAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT id, created_at FROM notifications
       WHERE user_id = ? AND kind = ? AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, BASELINE_NOTIFICATION_KIND)
    .first<{ id: string; created_at: string }>();
  return row ? { id: row.id, createdAt: row.created_at } : null;
}

export interface RecentBatchRow {
  id: string;
  concept_id: string;
  concept_name: string;
  user_answer: string | null;
  assessed_depth: number | null;
  previous_depth: number;
  completed_at: string | null;
  // Assessment artifacts pulled along so the page can render
  // "Why this score?" reasoning per row without a separate fetch.
  assessment_reasoning: string | null;
  assessment_gaps: string | null;
  assessment_learning_path: string | null;
}

export async function loadRecentBaselineBatch(db: D1Database, userId: string): Promise<RecentBatchRow[]> {
  const rows = await db
    .prepare(
      `SELECT q.id, q.concept_id, c.canonical_name as concept_name,
              q.user_answer, q.assessed_depth,
              q.assessment_reasoning, q.assessment_gaps, q.assessment_learning_path,
              COALESCE(cd.depth_score, 0) as previous_depth,
              q.completed_at
       FROM calibration_quizzes q
       JOIN concepts c ON q.concept_id = c.id
       LEFT JOIN concept_depth cd ON q.concept_id = cd.concept_id
       WHERE q.user_id = ?
         AND q.quiz_type = 'baseline'
         AND q.status = 'answered'
         AND q.completed_at >= datetime('now', ?)
       ORDER BY q.completed_at ASC`,
    )
    .bind(userId, RECENT_BATCH_WINDOW)
    .all<RecentBatchRow>();
  return rows.results ?? [];
}

export function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Run a single quiz assessment end-to-end: fetch the quiz row, score
 * the answer with the LLM, write back depth + reasoning + history,
 * and fire the "calibration assessment complete" notification when
 * appropriate.
 *
 * Used by both the inline `/quiz/:id/answer` POST (one quiz at a
 * time, fire-and-forget via `waitUntil`) and the batch
 * `/quiz/baseline/batch` POST (many quizzes synchronously). Both
 * paths share the same depth-update + notification logic so the
 * downstream behaviour stays consistent regardless of how the user
 * submitted answers.
 */
export async function runAssessment(
  env: Env,
  db: D1Database,
  userId: string,
  quizId: string,
  answer: string,
  settings?: Record<string, unknown> | null,
) {
  const quiz = await db
    .prepare(
      `SELECT q.*, c.canonical_name as concept_name, cd.depth_score, cd.confidence
       FROM calibration_quizzes q
       JOIN concepts c ON q.concept_id = c.id
       LEFT JOIN concept_depth cd ON q.concept_id = cd.concept_id
       WHERE q.id = ? AND q.user_id = ?`,
    )
    .bind(quizId, userId)
    .first<{
      id: string;
      concept_id: string;
      concept_name: string;
      question: string;
      expected_depth_indicators: string | null;
      depth_score: number;
      confidence: number;
    }>();

  if (!quiz) {
    return {
      assessedDepth: 0,
      previousDepth: 0,
      reasoning: "Quiz not found",
      gaps: { summary: "", specifics: [] },
      learningPath: [],
      conceptUpdated: false,
    };
  }

  const previousDepth = quiz.depth_score ?? 0;
  const llm = llmClient(env);
  const spec = resolveModel(settings as Record<string, unknown> | null | undefined, "quizAssessment");

  const result = await assessQuizAnswer(
    db,
    userId,
    llm,
    quiz.concept_name,
    previousDepth,
    quiz.question,
    answer,
    quiz.expected_depth_indicators ?? undefined,
    spec,
  );

  await db
    .prepare(
      `UPDATE calibration_quizzes
       SET assessed_depth = ?, assessment_reasoning = ?, assessment_gaps = ?,
           assessment_learning_path = ?, model_used = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      result.assessedDepth,
      result.reasoning,
      JSON.stringify(result.gaps),
      JSON.stringify(result.learningPath),
      result.modelUsed,
      quizId,
      userId,
    )
    .run();

  const newConfidence = Math.min((quiz.confidence ?? 0) + 0.15, 1.0);
  await db
    .prepare(
      `UPDATE concept_depth
       SET depth_score = ?, confidence = ?, last_calibrated_at = datetime('now'), updated_at = datetime('now')
       WHERE concept_id = ? AND user_id = ?`,
    )
    .bind(result.assessedDepth, newConfidence, quiz.concept_id, userId)
    .run();

  // Store FULL reasoning (no slice) so /concept/:id/history can
  // render the per-row "Why this score?" expansion against the
  // depth_history table without needing to JOIN back into
  // calibration_quizzes. The "Quiz <id>:" prefix is kept so client
  // code can still tease the quizId out for cross-references.
  await recordDepthChange(
    db,
    userId,
    quiz.concept_id,
    result.assessedDepth,
    newConfidence,
    "quiz_assessment",
    `Quiz ${quizId}: ${result.reasoning}`,
  );

  // After this UPDATE, check whether THIS quiz was the last
  // outstanding assessment in a recent baseline batch. If so, emit a
  // "calibration assessment complete" notification so the user knows
  // (via the bell) that results are in — they may have navigated
  // away mid-assessment per the explicit "you can leave this page"
  // affordance, and need a way back without manually polling.
  //
  // Idempotency: scoped by an LIKE check against `payload` rather
  // than a unique index. Two parallel runAssessment calls finishing
  // at the same instant could each see "0 remaining"; the
  // "skip if a recent complete-notification exists" gate is the
  // tie-breaker. The window is 60s — short enough that genuinely
  // separate calibration sessions still each get their notification,
  // long enough to absorb the 6-question parallel-finish case.
  await maybeFireBaselineAssessmentCompleteNotification(db, userId);

  return {
    assessedDepth: result.assessedDepth,
    previousDepth,
    reasoning: result.reasoning,
    gaps: result.gaps,
    learningPath: result.learningPath,
    conceptUpdated: true,
  };
}

export { createNotification, transitionNotification };
