/**
 * Stats + decay endpoints used by the analytics surfaces.
 *
 * - GET  `/stats`         — top-line counters (concepts, depth,
 *                           briefings, monthly spend)
 * - GET  `/stats/weekly`  — last-7-days counters used by the
 *                           weekly-stats card
 * - POST `/decay/run`     — manual trigger for the decay pass
 *                           (otherwise scheduled via cron)
 *
 * @see ../system.ts — assembly entry point
 */

import { Hono } from "hono";
import { runDecayJob } from "../../services/depth-manager.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemStatsRoutes = new Hono<AppEnv>();

systemStatsRoutes.get("/stats", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const [conceptCount, briefingCount, quizCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) as count FROM concepts WHERE user_id = ?").bind(user.userId).first<{ count: number }>(),
    db
      .prepare("SELECT COUNT(*) as count FROM briefings WHERE user_id = ?")
      .bind(user.userId)
      .first<{ count: number }>(),
    db
      .prepare("SELECT COUNT(*) as count FROM calibration_quizzes WHERE user_id = ? AND status = 'answered'")
      .bind(user.userId)
      .first<{ count: number }>(),
  ]);

  const avgDepth = await db
    .prepare("SELECT AVG(cd.depth_score) as avg FROM concept_depth cd WHERE cd.user_id = ?")
    .bind(user.userId)
    .first<{ avg: number | null }>();

  const tokenTotal = await db
    .prepare(
      `SELECT SUM(estimated_cost_usd) as total FROM usage_events
       WHERE user_id = ? AND created_at >= datetime('now', 'start of month')`,
    )
    .bind(user.userId)
    .first<{ total: number | null }>();

  return c.json({
    totalConcepts: conceptCount?.count ?? 0,
    averageDepth: avgDepth?.avg ?? 0,
    briefingsGenerated: briefingCount?.count ?? 0,
    quizzesCompleted: quizCount?.count ?? 0,
    monthlySpend: tokenTotal?.total ?? 0,
    budgetCap: user.settings.budgetCapMonthly,
  });
});

systemStatsRoutes.get("/stats/weekly", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const briefingsRead = await db
    .prepare(
      `SELECT COUNT(*) as count FROM briefings
       WHERE user_id = ? AND status IN ('read', 'archived')
       AND briefing_date >= date('now', '-7 days')`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  const briefingsTotal = await db
    .prepare(
      `SELECT COUNT(*) as count FROM briefings
       WHERE user_id = ? AND briefing_date >= date('now', '-7 days')`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  const quizzesCompleted = await db
    .prepare(
      `SELECT COUNT(*) as count FROM calibration_quizzes
       WHERE user_id = ? AND status = 'answered'
       AND completed_at >= datetime('now', '-7 days')`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  const newConcepts = await db
    .prepare(
      `SELECT COUNT(*) as count FROM concepts
       WHERE user_id = ? AND created_at >= datetime('now', '-7 days')`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  const feedbackGiven = await db
    .prepare(
      `SELECT COUNT(*) as count FROM teaching_pieces
       WHERE user_id = ? AND feedback IS NOT NULL
       AND created_at >= datetime('now', '-7 days')`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  return c.json({
    briefingsRead: briefingsRead?.count ?? 0,
    outOf: briefingsTotal?.count ?? 0,
    quizzesCompleted: quizzesCompleted?.count ?? 0,
    newConcepts: newConcepts?.count ?? 0,
    feedbackGiven: feedbackGiven?.count ?? 0,
  });
});

systemStatsRoutes.post("/decay/run", async (c) => {
  const user = c.get("user");
  const result = await runDecayJob(c.env.DB, user.userId);
  return c.json({ warned: result.warned, decayed: result.decayed });
});
