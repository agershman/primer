/**
 * Baseline calibration quiz routes — the multi-question batch flow
 * for new users (or users adding new concepts) to anchor their
 * starting depth scores. Pairs with the per-question inline flow in
 * [`./inline.ts`](./inline.ts); both share helpers from
 * [`./shared.ts`](./shared.ts).
 *
 * Endpoints:
 *
 *   - GET  `/quiz/baseline`         — fetch the pending batch
 *   - GET  `/quiz/baseline/status`  — read-only state for the
 *                                     calibration page (idle /
 *                                     generating / ready /
 *                                     assessing / complete)
 *   - POST `/quiz/baseline/prepare` — kick off async generation
 *                                     (notification-driven)
 *   - POST `/quiz/baseline/batch`   — submit answers for the batch
 *
 * @see ../quiz.ts — assembly entry point
 */

import { Hono } from "hono";
import { resolveModel } from "../../config/models.js";
import type { Env, UserContext } from "../../types.js";
import {
  BASELINE_NOTIFICATION_KIND,
  BATCH_LIMIT,
  createNotification,
  generateBaselineQuestions,
  hasInFlightBaselinePrep,
  loadInFlightBaselineNotification,
  loadRecentBaselineBatch,
  runAssessment,
  safeJsonParse,
  transitionNotification,
} from "./shared.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const quizBaselineRoutes = new Hono<AppEnv>();

quizBaselineRoutes.get("/quiz/baseline", async (c) => {
  const user = c.get("user");

  // Check for existing pending baseline questions first.
  let questions = await c.env.DB.prepare(
    `SELECT q.*, c.canonical_name as concept_name, cd.depth_score
     FROM calibration_quizzes q
     JOIN concepts c ON q.concept_id = c.id
     LEFT JOIN concept_depth cd ON q.concept_id = cd.concept_id
     WHERE q.user_id = ? AND q.quiz_type = 'baseline' AND q.status = 'pending'
     ORDER BY cd.depth_score ASC
     LIMIT 6`,
  )
    .bind(user.userId)
    .all();

  if (questions.results.length === 0) {
    // Race-avoidance: if there's an async prep job in flight (the
    // user clicked "Start calibration" on the Concepts page), tell
    // the client to keep polling rather than firing a duplicate
    // inline generation. The two paths would otherwise both pick
    // the same set of low-depth concepts and produce duplicate
    // rows.
    if (await hasInFlightBaselinePrep(c.env.DB, user.userId)) {
      return c.json({ questions: [], generating: true });
    }

    // No prep job in flight — fall back to inline generation. Keeps
    // the direct-navigation path (Concepts → /calibrate without the
    // notification flow) working as before.
    try {
      const spec = resolveModel(
        user.settings?.signalSurfaceMap as Record<string, unknown> | null | undefined,
        "quizGeneration",
      );
      await generateBaselineQuestions(c.env, user.userId, spec, user.aboutStatement);

      questions = await c.env.DB.prepare(
        `SELECT q.*, c.canonical_name as concept_name, cd.depth_score
         FROM calibration_quizzes q
         JOIN concepts c ON q.concept_id = c.id
         LEFT JOIN concept_depth cd ON q.concept_id = cd.concept_id
         WHERE q.user_id = ? AND q.quiz_type = 'baseline' AND q.status = 'pending'
         ORDER BY cd.depth_score ASC
         LIMIT 6`,
      )
        .bind(user.userId)
        .all();
    } catch (err) {
      console.error("[quiz] Baseline generation failed:", err);
    }
  }

  return c.json({
    questions: questions.results.map((q) => ({
      id: q.id,
      concept: q.concept_name,
      conceptId: q.concept_id,
      currentDepth: (q.depth_score as number) ?? 0,
      question: q.question,
    })),
    generating: false,
  });
});

/**
 * Read-only status endpoint for baseline calibration. Mounts on:
 *   - the Concepts page "Start calibration" button (so the
 *     "generating" / "ready" view survives navigation)
 *   - the /calibrate page itself (so the "assessing" / "complete"
 *     view of a recently-submitted batch survives navigation too)
 *
 * Status is one of five values:
 *   - `idle`       — nothing to do.
 *   - `generating` — async prep job alive (no pending rows yet).
 *   - `ready`      — pending baseline rows exist (questions
 *                    generated, waiting for the user to take them).
 *   - `assessing`  — user submitted answers; one or more rows are
 *                    `status='answered'` AND `assessed_depth IS NULL`.
 *                    LLM assessment is running in the background.
 *   - `complete`   — recently-answered batch with all rows assessed.
 *                    Surfaces results when the user navigates back
 *                    after assessment finished.
 *
 * The `recent` field accompanies `assessing` / `complete` and gives
 * the page everything it needs to render the per-question view
 * without a separate fetch.
 *
 * Self-heal: if pending rows exist *and* a stale in_progress
 * notification is still around, the `transitionNotification` call
 * inside the prepare endpoint's `waitUntil` was lost (worker
 * terminated mid-flight, transient D1 hiccup, etc.). Flip the
 * notification to ready right here so the bell catches up.
 */
quizBaselineRoutes.get("/quiz/baseline/status", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const pending = await db
    .prepare(
      `SELECT COUNT(*) as count FROM calibration_quizzes
       WHERE user_id = ? AND quiz_type = 'baseline' AND status = 'pending'`,
    )
    .bind(user.userId)
    .first<{ count: number }>();
  const pendingCount = pending?.count ?? 0;

  const notif = await loadInFlightBaselineNotification(db, user.userId);

  // Coverage breakdown — counts of "still needs calibration"
  // (depth < 2 AND not currently pending in this user's quiz queue)
  // both globally and per category. The CTA copy uses these to
  // communicate things like "6 of 30 calibrated. Run another batch
  // for the next 6." and to enable per-trail entry points only when
  // a trail actually has unverified concepts.
  const unverifiedRows = await db
    .prepare(
      `SELECT COALESCE(c.category, 'uncategorized') as category, COUNT(*) as count
       FROM concepts c
       LEFT JOIN concept_depth cd ON c.id = cd.concept_id
       WHERE c.user_id = ? AND COALESCE(cd.depth_score, 0) < 2
       GROUP BY COALESCE(c.category, 'uncategorized')`,
    )
    .bind(user.userId)
    .all<{ category: string; count: number }>();
  const byTrail: Record<string, number> = {};
  let unverifiedTotal = 0;
  for (const row of unverifiedRows.results ?? []) {
    byTrail[row.category] = row.count;
    unverifiedTotal += row.count;
  }

  const coverage = { unverifiedTotal, byTrail, batchLimit: BATCH_LIMIT };

  if (pendingCount > 0 && notif) {
    // Stuck in_progress notification → self-heal so the bell catches up.
    await transitionNotification(db, user.userId, notif.id, {
      status: "ready",
      title: `Calibration ready: ${pendingCount} question${pendingCount === 1 ? "" : "s"}`,
      body: "Click to start.",
    });
    return c.json({ status: "ready", conceptCount: pendingCount, coverage });
  }

  if (pendingCount > 0) {
    return c.json({ status: "ready", conceptCount: pendingCount, coverage });
  }

  if (notif) {
    return c.json({ status: "generating", startedAt: notif.createdAt, coverage });
  }

  // No pending questions, no in-flight prep job → check for a
  // recently-submitted batch. If any answered row in the window has
  // a NULL assessed_depth → "assessing"; else if all are assessed
  // → "complete"; else fall through to "idle".
  const recent = await loadRecentBaselineBatch(db, user.userId);
  if (recent.length > 0) {
    const pendingAssessment = recent.filter((r) => r.assessed_depth == null).length;
    const recentPayload = {
      questions: recent.map((r) => ({
        id: r.id,
        conceptId: r.concept_id,
        concept: r.concept_name,
        assessedDepth: r.assessed_depth,
        previousDepth: r.previous_depth,
        // Reasoning artifacts inline so the page can render
        // "Why this score?" expansions without a per-row fetch.
        // Null for still-pending rows; the polling effect fills
        // them in from `/quiz/:id/assessment` as each lands.
        reasoning: r.assessment_reasoning,
        gaps: safeJsonParse<{ summary: string; specifics: string[] }>(r.assessment_gaps, {
          summary: "",
          specifics: [],
        }),
        learningPath: safeJsonParse<Array<{ action: string; resource?: { title: string; url: string } }>>(
          r.assessment_learning_path,
          [],
        ),
      })),
      pendingCount: pendingAssessment,
      submittedAt: recent[0]?.completed_at ?? null,
    };
    return c.json({
      status: pendingAssessment > 0 ? "assessing" : "complete",
      recent: recentPayload,
      coverage,
    });
  }

  return c.json({ status: "idle", coverage });
});

/**
 * Async prep endpoint for baseline calibration.
 *
 * The Concepts page "Start calibration" buttons hit this so the user
 * can navigate away while questions generate. Mirrors the deep-dive
 * notification flow:
 *   - Idempotent: if there are already pending baseline rows OR an
 *     in-flight prep notification, returns success without duplicating
 *     work.
 *   - Otherwise creates an in_progress notification and kicks off
 *     generation via `ctx.waitUntil` so the client can disconnect.
 *   - When generation finishes, the notification flips to ready (or
 *     failed) and the bell icon picks it up via its existing polling.
 *
 * Body shape (all fields optional):
 *   - `category` — scope this batch to one trail (e.g. "infrastructure").
 *     Without this, the batch picks the lowest-depth concepts across
 *     ALL trails. The `BATCH_LIMIT` cap (6 per session) applies either
 *     way; with 30 concepts in a trail, the user runs ~5 sessions.
 *
 * Clicking the bell row navigates to `/calibrate` where the GET
 * endpoint above returns the now-existing pending rows.
 *
 * The companion GET `/quiz/baseline/status` is what the
 * StartCalibrationButton mounts against to reconcile its UI with
 * server-side state, so the user's progress survives navigation.
 */
quizBaselineRoutes.post("/quiz/baseline/prepare", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  let body: { category?: string } = {};
  try {
    // Empty bodies are valid — the cross-trail "Start calibration"
    // CTA POSTs `{}`. A missing or unparseable body shouldn't throw.
    body = (await c.req.json<{ category?: string }>().catch(() => ({}))) ?? {};
  } catch {
    body = {};
  }
  const category = body.category?.trim() || undefined;

  // Idempotency check — pending rows already exist from a prior call.
  // Scoped global, not per-category: while ANY pending baseline rows
  // exist for the user, we don't start another batch. The user is
  // expected to take or skip the open batch first; otherwise we'd
  // pile up duplicate questions across scopes and the
  // `/calibrate` UI would show a confusing mixed list.
  const existing = await db
    .prepare(
      `SELECT COUNT(*) as count FROM calibration_quizzes
       WHERE user_id = ? AND quiz_type = 'baseline' AND status = 'pending'`,
    )
    .bind(user.userId)
    .first<{ count: number }>();
  if ((existing?.count ?? 0) > 0) {
    return c.json({ status: "ready", conceptCount: existing?.count ?? 0 });
  }

  // Idempotency check — an async prep job is already running.
  if (await hasInFlightBaselinePrep(db, user.userId)) {
    return c.json({ status: "in_progress" });
  }

  // Sanity check there are concepts to calibrate against in the
  // requested scope. We re-run the same low-depth query in the
  // background generator, but doing a quick count here lets us
  // return a meaningful error to the user immediately rather than
  // via a notification that says "ready: 0 questions".
  const countParams: (string | number)[] = [user.userId];
  let countCategoryClause = "";
  if (category) {
    countCategoryClause = "AND c.category = ?";
    countParams.push(category);
  }
  const lowDepth = await db
    .prepare(
      `SELECT COUNT(*) as count FROM concepts c
       LEFT JOIN concept_depth cd ON c.id = cd.concept_id
       WHERE c.user_id = ? AND COALESCE(cd.depth_score, 0) < 2 ${countCategoryClause}`,
    )
    .bind(...countParams)
    .first<{ count: number }>();
  const conceptCount = Math.min(lowDepth?.count ?? 0, BATCH_LIMIT);
  if (conceptCount === 0) {
    return c.json(
      {
        status: "no_concepts",
        error: category
          ? `No low-depth concepts to calibrate in this trail.`
          : "No low-depth concepts to calibrate against — generate a briefing first.",
      },
      400,
    );
  }

  const spec = resolveModel(
    user.settings?.signalSurfaceMap as Record<string, unknown> | null | undefined,
    "quizGeneration",
  );

  let notificationId: string | null = null;
  try {
    const n = await createNotification(db, user.userId, {
      kind: BASELINE_NOTIFICATION_KIND,
      title: category
        ? `Preparing ${category} calibration: ${conceptCount} question${conceptCount === 1 ? "" : "s"}`
        : `Preparing calibration: ${conceptCount} question${conceptCount === 1 ? "" : "s"}`,
      body: "We'll notify you when the questions are ready.",
      actionUrl: "/calibrate",
      status: "in_progress",
      payload: { conceptCount, category: category ?? null },
    });
    notificationId = n.id;
  } catch (err) {
    console.warn("[baseline-prep] Failed to create notification:", err);
  }

  // Pin generation to the worker via waitUntil so a client disconnect
  // (user navigates away — the whole point of this flow) doesn't
  // cancel the work. The notification row is the source of truth for
  // "is this still running" — the bell polls and surfaces ready /
  // failed when the promise resolves.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const generated = await generateBaselineQuestions(c.env, user.userId, spec, user.aboutStatement, {
          category,
        });
        if (notificationId) {
          if (generated > 0) {
            await transitionNotification(db, user.userId, notificationId, {
              status: "ready",
              title: category
                ? `${category} calibration ready: ${generated} question${generated === 1 ? "" : "s"}`
                : `Calibration ready: ${generated} question${generated === 1 ? "" : "s"}`,
              body: "Click to start.",
            });
          } else {
            await transitionNotification(db, user.userId, notificationId, {
              status: "failed",
              title: "Calibration prep failed",
              body: "No questions could be generated. Try again later.",
            });
          }
        }
      } catch (err) {
        console.error("[baseline-prep] Generation failed:", err);
        if (notificationId) {
          await transitionNotification(db, user.userId, notificationId, {
            status: "failed",
            title: "Calibration prep failed",
            body: String(err).slice(0, 200),
          });
        }
      }
    })(),
  );

  return c.json({ status: "in_progress", notificationId, conceptCount, category: category ?? null });
});

quizBaselineRoutes.post("/quiz/baseline/batch", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    answers: Array<{ quizId: string; answer: string }>;
  }>();

  const assessments = [];
  for (const { quizId, answer } of body.answers) {
    await c.env.DB.prepare(
      `UPDATE calibration_quizzes SET user_answer = ?, status = 'answered',
       completed_at = datetime('now') WHERE id = ? AND user_id = ?`,
    )
      .bind(answer, quizId, user.userId)
      .run();

    try {
      const result = await runAssessment(
        c.env,
        c.env.DB,
        user.userId,
        quizId,
        answer,
        user.settings?.signalSurfaceMap as Record<string, unknown> | null,
      );
      assessments.push({ quizId, ...result });
    } catch (err) {
      console.error(`[quiz] Batch assessment failed for ${quizId}:`, err);
      assessments.push({
        quizId,
        assessedDepth: 0,
        previousDepth: 0,
        reasoning: "Assessment could not be completed",
        gaps: { summary: "", specifics: [] },
        learningPath: [],
        conceptUpdated: false,
      });
    }
  }

  return c.json({ assessments });
});
