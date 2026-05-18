/**
 * Regenerate-with-different-model endpoint.
 *
 * Admin-only — picking which model regenerates a piece is a
 * deployment-wide concern (it's how this Primer instance generates
 * content); only the admin can swap models. Non-admins listen / read
 * with whatever the admin picked from Settings → Intelligence → AI
 * models.
 *
 * @see ../pieces.ts — assembly entry point
 */

import { Hono } from "hono";
import { assertAdmin } from "../../middleware/require-admin.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const pieceRegenerateRoutes = new Hono<AppEnv>();

pieceRegenerateRoutes.post("/piece/:id/regenerate", async (c) => {
  const user = c.get("user");
  // Picking which model regenerates a piece is a deployment-wide
  // concern (it's how this Primer instance generates content); only
  // the admin can swap models. Non-admins listen / read with whatever
  // the admin picked from Settings → Intelligence → AI models.
  const block = assertAdmin(user);
  if (block) return block;
  const pieceId = c.req.param("id");
  const body = await c.req.json<{ model: string }>();
  const db = c.env.DB;

  const piece = await db
    .prepare(
      `SELECT tp.title, tp.piece_type, tp.source_type, tp.source_reference,
              tp.selection_reasoning, tp.concepts, tp.target_depth, tp.source_context,
              COALESCE(cd.depth_score, 0) as depth_score
       FROM teaching_pieces tp
       LEFT JOIN concept_depth cd ON cd.concept_id = (
         SELECT json_extract(tp.concepts, '$[0]')
       )
       WHERE tp.id = ? AND tp.user_id = ?`,
    )
    .bind(pieceId, user.userId)
    .first<{
      title: string;
      piece_type: string;
      source_type: string;
      source_reference: string | null;
      selection_reasoning: string | null;
      concepts: string;
      target_depth: number;
      source_context: string | null;
      depth_score: number;
    }>();

  if (!piece) {
    return c.json({ error: "Piece not found" }, 404);
  }

  const { isValidModel, lookupCatalogById } = await import("../../config/models.js");
  if (!isValidModel(body.model)) {
    return c.json({ error: "Invalid model" }, 400);
  }

  try {
    const { llmClient } = await import("../../integrations/llm/dispatcher.js");
    const { generateTeachingPiece } = await import("../../services/teaching-generator.js");

    const llm = llmClient(c.env);
    const conceptIds: string[] = JSON.parse(piece.concepts || "[]");

    // Original source bundle — surfaced to the writer for
    // company-internal grounding (the writer reaches for web_search
    // for external claims).
    const sourceContext: Array<{ type: string; id?: string; url?: string; title?: string; summary?: string }> =
      JSON.parse(piece.source_context ?? "[]");

    const target = {
      conceptName: piece.title,
      conceptId: conceptIds[0] ?? "",
      depthScore: piece.depth_score,
      sourceType: piece.source_type as "current-work" | "adjacent" | "readiness-gap" | "decay-recalibrate",
      sourceReference: piece.source_reference ?? undefined,
      selectionReasoning: piece.selection_reasoning ?? "Regenerated with different model",
      priority: 0,
      sourceContext,
    };

    // Translate the legacy bare-model-id from the request body into a
    // structured spec via the catalog so the dispatcher knows which
    // adapter to use.
    const entry = lookupCatalogById(body.model);
    const spec = entry
      ? { provider: entry.provider, model: entry.providerModel }
      : { provider: "anthropic" as const, model: body.model };

    const result = await generateTeachingPiece(db, user.userId, llm, target, {
      modelSpec: spec,
      aboutStatement: user.aboutStatement,
      sourceContext,
    });

    await db
      .prepare(
        `UPDATE teaching_pieces
         SET title = ?, piece_type = ?, content = ?, read_time_minutes = ?,
             model_used = ?, deep_dive_content = NULL, has_deep_dive = 0
         WHERE id = ? AND user_id = ?`,
      )
      .bind(
        result.title,
        result.pieceType,
        JSON.stringify(result.content),
        result.readTimeMinutes,
        result.modelUsed,
        pieceId,
        user.userId,
      )
      .run();

    // Invalidate bookmarks — content has changed, positions are stale.
    await db.prepare("DELETE FROM bookmarks WHERE piece_id = ? AND user_id = ?").bind(pieceId, user.userId).run();

    // Replace non-deep-dive resources.
    await db
      .prepare(
        "DELETE FROM piece_resources WHERE teaching_piece_id = ? AND user_id = ? AND (is_deep_dive_only = 0 OR is_deep_dive_only IS NULL)",
      )
      .bind(pieceId, user.userId)
      .run();

    const { genId } = await import("../../db/queries.js");
    for (let i = 0; i < result.resources.length; i++) {
      const res = result.resources[i];
      const resId = genId("pieceResource");
      await db
        .prepare(
          `INSERT INTO piece_resources
           (id, user_id, teaching_piece_id, label, url, resource_type, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        )
        .bind(resId, user.userId, pieceId, res.label, res.url, res.type, i)
        .run();
    }

    const resources = await db
      .prepare("SELECT * FROM piece_resources WHERE teaching_piece_id = ? ORDER BY position")
      .bind(pieceId)
      .all();

    return c.json({
      piece: {
        id: pieceId,
        title: result.title,
        piece_type: result.pieceType,
        content: result.content,
        read_time_minutes: result.readTimeMinutes,
        model_used: result.modelUsed,
        resources: resources.results,
      },
    });
  } catch (err) {
    console.error("[regenerate] Failed:", err);
    return c.json({ error: "Regeneration failed. Please try again." }, 500);
  }
});
