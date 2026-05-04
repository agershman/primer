/**
 * Inline calibration quiz routes — the per-question flow exposed on
 * the briefing page (next question → answer → assessment → skip).
 *
 * Pairs with [`./baseline.ts`](./baseline.ts) which handles the
 * larger calibration-batch flow. Both share helpers from
 * [`./shared.ts`](./shared.ts).
 *
 * @see ../quiz.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";
import { runAssessment } from "./shared.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const quizInlineRoutes = new Hono<AppEnv>();

quizInlineRoutes.get("/quiz/next", async (c) => {
  const user = c.get("user");

  const quiz = await c.env.DB.prepare(
    `SELECT q.*, c.canonical_name as concept_name, cd.depth_score
     FROM calibration_quizzes q
     JOIN concepts c ON q.concept_id = c.id
     LEFT JOIN concept_depth cd ON q.concept_id = cd.concept_id
     WHERE q.user_id = ? AND q.status = 'pending'
     ORDER BY cd.confidence ASC, cd.depth_score ASC
     LIMIT 1`,
  )
    .bind(user.userId)
    .first();

  if (!quiz) {
    return c.json({ quiz: null });
  }

  return c.json({
    quiz: {
      id: quiz.id,
      concept: quiz.concept_name,
      conceptId: quiz.concept_id,
      conceptDepth: (quiz.depth_score as number) ?? 0,
      question: quiz.question,
      context: quiz.context,
      type: quiz.quiz_type,
    },
  });
});

quizInlineRoutes.post("/quiz/:id/answer", async (c) => {
  const user = c.get("user");
  const quizId = c.req.param("id");
  const body = await c.req.json<{ answer: string }>();

  await c.env.DB.prepare(
    `UPDATE calibration_quizzes SET user_answer = ?, status = 'answered',
     completed_at = datetime('now') WHERE id = ? AND user_id = ?`,
  )
    .bind(body.answer, quizId, user.userId)
    .run();

  // Run assessment inline (waitUntil gets killed in local wrangler).
  // Return an immediate acknowledgment so the UI can advance, then
  // the assessment result is available via GET /quiz/:id/assessment.
  const env = c.env;
  const db = c.env.DB;
  const userId = user.userId;
  const settings = user.settings?.signalSurfaceMap as Record<string, unknown> | null;
  const answer = body.answer;

  // Fire-and-forget inline (will complete before the connection closes
  // in production; in local dev it runs synchronously in the same request
  // context but the client gets a fast response since we don't await it
  // on the response path when the sync flag is absent).
  const doAssess = async () => {
    try {
      await runAssessment(env, db, userId, quizId, answer, settings);
    } catch (err) {
      console.error("[quiz] Background assessment failed:", err);
    }
  };

  // Use waitUntil if available, otherwise run inline.
  try {
    c.executionCtx.waitUntil(doAssess());
  } catch {
    // waitUntil may not work in local dev — run inline as fallback.
    await doAssess();
  }

  return c.json({
    assessedDepth: 0,
    previousDepth: 0,
    reasoning: "Assessing your answer…",
    gaps: { summary: "", specifics: [] },
    learningPath: [],
    conceptUpdated: false,
    pending: true,
  });
});

quizInlineRoutes.get("/quiz/:id/assessment", async (c) => {
  const user = c.get("user");
  const quizId = c.req.param("id");

  const quiz = await c.env.DB.prepare(
    `SELECT assessed_depth, assessment_reasoning, assessment_gaps,
            assessment_learning_path, model_used
     FROM calibration_quizzes WHERE id = ? AND user_id = ?`,
  )
    .bind(quizId, user.userId)
    .first<{
      assessed_depth: number | null;
      assessment_reasoning: string | null;
      assessment_gaps: string | null;
      assessment_learning_path: string | null;
      model_used: string | null;
    }>();

  if (!quiz) {
    return c.json({ error: "Quiz not found" }, 404);
  }

  if (quiz.assessed_depth == null) {
    return c.json({ pending: true });
  }

  return c.json({
    assessedDepth: quiz.assessed_depth,
    reasoning: quiz.assessment_reasoning ?? "",
    gaps: quiz.assessment_gaps ? JSON.parse(quiz.assessment_gaps) : { summary: "", specifics: [] },
    learningPath: quiz.assessment_learning_path ? JSON.parse(quiz.assessment_learning_path) : [],
    pending: false,
  });
});

quizInlineRoutes.post("/quiz/:id/skip", async (c) => {
  const user = c.get("user");
  const quizId = c.req.param("id");

  await c.env.DB.prepare(
    `UPDATE calibration_quizzes SET status = 'skipped',
     completed_at = datetime('now') WHERE id = ? AND user_id = ?`,
  )
    .bind(quizId, user.userId)
    .run();

  return c.json({ ok: true });
});
