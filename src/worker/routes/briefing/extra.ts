/**
 * Per-briefing extras — small read endpoints scoped to a specific
 * `briefingId` rather than to "today" or to the briefing list.
 *
 * - GET `/briefing/:id/near-misses`   — items the relevance filter
 *                                       dropped below the floor
 * - GET `/briefing/:id/work-context`  — work-context source summary
 *                                       used by the briefing page
 *                                       header
 * - GET `/briefing/:id/pipeline`      — full per-briefing pipeline
 *                                       trace (timings, per-step
 *                                       kept/dropped items with
 *                                       reasons) for the debug panel
 *
 * @see ../briefing.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";
import { parseRedundantDrafts } from "./shared.js";

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

/**
 * Per-briefing pipeline trace.
 *
 * Stitches together everything the generator persisted about this
 * briefing's run — timings (one row per step), per-step metadata
 * (incl. dropped items / candidate outcomes / classifier verdicts
 * widened in this same change), near-misses, discovered (adjacent)
 * items, and a minimal per-piece rollup. Powers the "Generation
 * details" panel on the briefing page; the panel renders whichever
 * steps and source types actually appear in the data, so a
 * deployment with a different source mix renders correctly without
 * any frontend changes.
 *
 * Returns 404 for briefings the user doesn't own (same ownership
 * pattern as the sibling routes above).
 */
briefingExtraRoutes.get("/briefing/:id/pipeline", async (c) => {
  const user = c.get("user");
  const briefingId = c.req.param("id");

  const briefing = await c.env.DB.prepare(
    `SELECT id, status, briefing_date, created_at, updated_at, generated_at,
            work_context_sources, metadata, models_used, redundant_drafts
     FROM briefings WHERE id = ? AND user_id = ?`,
  )
    .bind(briefingId, user.userId)
    .first<{
      id: string;
      status: string;
      briefing_date: string;
      created_at: string;
      updated_at: string;
      generated_at: string | null;
      work_context_sources: string | null;
      metadata: string | null;
      models_used: string | null;
      redundant_drafts: string | null;
    }>();

  if (!briefing) {
    return c.json({ error: "Briefing not found" }, 404);
  }

  // Timings, in chronological order — same shape /analytics/briefings
  // returns so the existing BriefingWaterfall component can render
  // them without translation.
  const timings = await c.env.DB.prepare(
    `SELECT step_key, started_at, finished_at, duration_ms,
            items_processed, model_used, metadata
     FROM briefing_timings
     WHERE briefing_id = ? AND user_id = ?
     ORDER BY started_at ASC`,
  )
    .bind(briefingId, user.userId)
    .all<{
      step_key: string;
      started_at: string;
      finished_at: string;
      duration_ms: number;
      items_processed: number | null;
      model_used: string | null;
      metadata: string | null;
    }>();

  const steps = (timings.results ?? []).map((t) => ({
    stepKey: t.step_key,
    startedAt: t.started_at,
    finishedAt: t.finished_at,
    durationMs: t.duration_ms,
    itemsProcessed: t.items_processed,
    modelUsed: t.model_used,
    metadata: t.metadata ? JSON.parse(t.metadata) : null,
  }));

  // Adjacent step: kept (discovered) + dropped (near-miss) items.
  // `near_misses` already exposes the exclusion reason; `discovered_items`
  // is the kept half, keyed by `used_in_briefing_id`.
  const nearMisses = await c.env.DB.prepare(
    `SELECT title, source_type, source_label, relevance_score, exclusion_reason, url
     FROM near_misses WHERE briefing_id = ? AND user_id = ?
     ORDER BY relevance_score DESC`,
  )
    .bind(briefingId, user.userId)
    .all<{
      title: string;
      source_type: string;
      source_label: string | null;
      relevance_score: number | null;
      exclusion_reason: string | null;
      url: string | null;
    }>();

  const discovered = await c.env.DB.prepare(
    `SELECT title, source_type, url, summary, relevance_score, relevance_concepts
     FROM discovered_items
     WHERE used_in_briefing_id = ? AND user_id = ?
     ORDER BY relevance_score DESC`,
  )
    .bind(briefingId, user.userId)
    .all<{
      title: string;
      source_type: string;
      url: string;
      summary: string | null;
      relevance_score: number | null;
      relevance_concepts: string;
    }>();

  const pieces = await c.env.DB.prepare(
    `SELECT id, title, selection_reasoning, source_type,
            series_id, part_number, position, target_depth
       FROM teaching_pieces
      WHERE briefing_id = ? AND user_id = ?
      ORDER BY position ASC`,
  )
    .bind(briefingId, user.userId)
    .all<{
      id: string;
      title: string;
      selection_reasoning: string | null;
      source_type: string;
      series_id: string | null;
      part_number: number | null;
      position: number;
      target_depth: number | null;
    }>();

  const briefingMetadata = JSON.parse(briefing.metadata || "{}");

  return c.json({
    briefingId: briefing.id,
    status: briefing.status,
    briefingDate: briefing.briefing_date,
    createdAt: briefing.created_at,
    updatedAt: briefing.updated_at,
    generatedAt: briefing.generated_at,
    workContextSources: JSON.parse(briefing.work_context_sources || "[]"),
    modelsUsed: JSON.parse(briefing.models_used || "{}"),
    redundantDrafts: parseRedundantDrafts(briefing.redundant_drafts),
    finalize: {
      reason: briefingMetadata.reason ?? null,
      conceptsExtracted: briefingMetadata.conceptsExtracted ?? null,
      existingConceptsReferenced: briefingMetadata.existingConceptsReferenced ?? null,
      adjacentItemsScored: briefingMetadata.adjacentItemsScored ?? null,
      candidateCount: briefingMetadata.candidateCount ?? null,
      selectedCount: briefingMetadata.selectedCount ?? null,
      totalPieces: briefingMetadata.totalPieces ?? null,
      errors: Array.isArray(briefingMetadata.errors) ? briefingMetadata.errors : [],
    },
    steps,
    nearMisses: (nearMisses.results ?? []).map((n) => ({
      title: n.title,
      sourceType: n.source_type,
      sourceLabel: n.source_label,
      relevanceScore: n.relevance_score,
      exclusionReason: n.exclusion_reason,
      url: n.url,
    })),
    discovered: (discovered.results ?? []).map((d) => ({
      title: d.title,
      sourceType: d.source_type,
      url: d.url,
      summary: d.summary,
      relevanceScore: d.relevance_score,
      relevanceConcepts: (() => {
        try {
          const parsed = JSON.parse(d.relevance_concepts || "[]");
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      })(),
    })),
    pieces: (pieces.results ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      selectionReasoning: p.selection_reasoning,
      sourceType: p.source_type,
      seriesId: p.series_id,
      partNumber: p.part_number,
      position: p.position,
      targetDepth: p.target_depth,
    })),
  });
});
