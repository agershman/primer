/**
 * Lightweight per-piece read + write endpoints — feedback, read
 * marker, series listing, and resources.
 *
 * The heavier pieces routes (deep-dive generation, regenerate-with-
 * model, audio) live in sibling files to keep this one small.
 *
 * @see ../pieces.ts — assembly entry point
 */

import { Hono } from "hono";
import { FEEDBACK_RULES } from "../../config/constants.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const pieceFeedbackReadRoutes = new Hono<AppEnv>();

pieceFeedbackReadRoutes.post("/piece/:id/feedback", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");
  const body = await c.req.json<{ feedback: "positive" | "negative" }>();
  const db = c.env.DB;

  await db
    .prepare("UPDATE teaching_pieces SET feedback = ? WHERE id = ? AND user_id = ?")
    .bind(body.feedback, pieceId, user.userId)
    .run();

  const conceptDeltas: Array<{
    conceptName: string;
    previousDepth: number;
    newDepth: number;
    delta: number;
  }> = [];

  if (body.feedback === "positive") {
    const piece = await db
      .prepare("SELECT concepts FROM teaching_pieces WHERE id = ? AND user_id = ?")
      .bind(pieceId, user.userId)
      .first<{ concepts: string }>();

    if (piece) {
      const conceptIds: string[] = JSON.parse(piece.concepts || "[]");
      for (const conceptId of conceptIds) {
        const depth = await db.prepare("SELECT * FROM concept_depth WHERE concept_id = ?").bind(conceptId).first<{
          depth_score: number;
          confidence: number;
        }>();

        if (depth) {
          const maxDepth = depth.depth_score + FEEDBACK_RULES.MAX_DEPTH_BUMP_ABOVE_CURRENT;
          const newDepth = Math.min(depth.depth_score + FEEDBACK_RULES.POSITIVE_DEPTH_DELTA, maxDepth, 5);
          const newConfidence = Math.min(depth.confidence + FEEDBACK_RULES.POSITIVE_CONFIDENCE_DELTA, 1);

          await db
            .prepare(
              `UPDATE concept_depth SET depth_score = ?, confidence = ?,
               last_calibrated_at = datetime('now'), updated_at = datetime('now')
               WHERE concept_id = ?`,
            )
            .bind(newDepth, newConfidence, conceptId)
            .run();

          const concept = await db
            .prepare("SELECT canonical_name FROM concepts WHERE id = ?")
            .bind(conceptId)
            .first<{ canonical_name: string }>();

          conceptDeltas.push({
            conceptName: concept?.canonical_name ?? conceptId,
            previousDepth: depth.depth_score,
            newDepth,
            delta: newDepth - depth.depth_score,
          });
        }
      }
    }
  }

  return c.json({ conceptDeltas });
});

pieceFeedbackReadRoutes.post("/piece/:id/read", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");
  const db = c.env.DB;

  await db
    .prepare("UPDATE teaching_pieces SET read_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(pieceId, user.userId)
    .run();

  const piece = await db
    .prepare("SELECT concepts FROM teaching_pieces WHERE id = ? AND user_id = ?")
    .bind(pieceId, user.userId)
    .first<{ concepts: string }>();

  if (piece) {
    const conceptIds: string[] = JSON.parse(piece.concepts || "[]");
    for (const conceptId of conceptIds) {
      await db
        .prepare(
          `UPDATE concept_depth SET last_exposed_at = datetime('now'),
           exposure_count = exposure_count + 1, updated_at = datetime('now')
           WHERE concept_id = ?`,
        )
        .bind(conceptId)
        .run();
    }
  }

  return c.json({ ok: true });
});

/**
 * Series-navigation endpoint.
 *
 * Given any piece id, returns the full ordered list of pieces in the
 * same series. The frontend lazy-fetches this when an expanded piece
 * (or the briefing card) needs to render the "previous part" /
 * "next part" links and the "Part N of M" badge.
 *
 * Returns an empty `parts` array (and `seriesId: null`) when the
 * piece is standalone (no series_id). The frontend uses that signal
 * to render no series chrome at all — the common case.
 *
 * Each part includes `briefing_date` so the frontend can build the
 * `/briefing/{date}#piece-{id}` anchor without a second round trip.
 */
pieceFeedbackReadRoutes.get("/piece/:id/series", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");

  const piece = await c.env.DB.prepare(`SELECT series_id FROM teaching_pieces WHERE id = ? AND user_id = ?`)
    .bind(pieceId, user.userId)
    .first<{ series_id: string | null }>();

  if (!piece) {
    return c.json({ error: "Piece not found" }, 404);
  }

  if (!piece.series_id) {
    return c.json({ seriesId: null, parts: [] });
  }

  const rows = await c.env.DB.prepare(
    `SELECT tp.id, tp.title, tp.part_number, tp.created_at, b.briefing_date
     FROM teaching_pieces tp
     JOIN briefings b ON b.id = tp.briefing_id
     WHERE tp.series_id = ? AND tp.user_id = ?
     ORDER BY tp.part_number ASC`,
  )
    .bind(piece.series_id, user.userId)
    .all<{
      id: string;
      title: string;
      part_number: number;
      created_at: string;
      briefing_date: string;
    }>();

  return c.json({
    seriesId: piece.series_id,
    parts: rows.results ?? [],
  });
});

pieceFeedbackReadRoutes.get("/piece/:id/resources", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");

  const resources = await c.env.DB.prepare(
    `SELECT label, url, resource_type, is_deep_dive_only
     FROM piece_resources WHERE teaching_piece_id = ? AND user_id = ?
     ORDER BY position`,
  )
    .bind(pieceId, user.userId)
    .all();

  return c.json({ resources: resources.results });
});
