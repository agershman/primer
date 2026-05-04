/**
 * Per-briefing extras — small read endpoints scoped to a specific
 * `briefingId` rather than to "today" or to the briefing list.
 *
 * - GET `/briefing/:id/near-misses`   — items the relevance filter
 *                                       dropped below the floor
 * - GET `/briefing/:id/work-context`  — work-context source summary
 *                                       used by the briefing page
 *                                       header
 *
 * @see ../briefing.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const briefingExtraRoutes = new Hono<AppEnv>();

briefingExtraRoutes.get("/briefing/:id/near-misses", async (c) => {
  const user = c.get("user");
  const briefingId = c.req.param("id");

  const items = await c.env.DB.prepare(
    `SELECT title, source_type, source_label, relevance_score, exclusion_reason, url
     FROM near_misses WHERE briefing_id = ? AND user_id = ?
     ORDER BY relevance_score DESC`,
  )
    .bind(briefingId, user.userId)
    .all();

  return c.json({ items: items.results });
});

briefingExtraRoutes.get("/briefing/:id/work-context", async (c) => {
  const user = c.get("user");
  const briefingId = c.req.param("id");

  const briefing = await c.env.DB.prepare("SELECT work_context_sources FROM briefings WHERE id = ? AND user_id = ?")
    .bind(briefingId, user.userId)
    .first<{ work_context_sources: string }>();

  if (!briefing) {
    return c.json({ error: "Briefing not found" }, 404);
  }

  return c.json({
    sources: JSON.parse(briefing.work_context_sources || "[]"),
  });
});
