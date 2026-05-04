import { Hono } from "hono";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const conceptRoutes = new Hono<AppEnv>();

conceptRoutes.get("/concepts", async (c) => {
  const user = c.get("user");
  const sort = c.req.query("sort") || "depth";
  const order = c.req.query("order") || "desc";
  const category = c.req.query("category");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const includeSuppressed = c.req.query("include_suppressed") === "true";
  const focusVersionId = c.req.query("focus_version_id");

  let baseWhere = "WHERE c.user_id = ?";
  const params: unknown[] = [user.userId];

  if (!includeSuppressed) {
    baseWhere += " AND c.suppressed_at IS NULL";
  }
  if (category) {
    baseWhere += " AND c.category = ?";
    params.push(category);
  }
  if (focusVersionId) {
    baseWhere += " AND c.focus_version_id = ?";
    params.push(focusVersionId);
  }

  const sortCol = sort === "name" ? "c.canonical_name" : sort === "exposure" ? "cd.exposure_count" : "cd.depth_score";
  const orderClause = ` ORDER BY ${sortCol} ${order === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`;

  const query = `
    SELECT c.*, cd.depth_score, cd.confidence, cd.last_exposed_at,
           cd.exposure_count, cd.last_calibrated_at, cd.decay_warned_at
    FROM concepts c
    LEFT JOIN concept_depth cd ON c.id = cd.concept_id
    ${baseWhere}${orderClause}`;

  const concepts = await c.env.DB.prepare(query)
    .bind(...params, limit, offset)
    .all();

  const total = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM concepts c ${baseWhere}`)
    .bind(...params)
    .first<{ count: number }>();

  // Inline depth-history sparkline data per concept. We fetch all history
  // rows for the loaded concepts in a single round-trip rather than N+1
  // per-concept queries, then group + cap in JS. Drives the at-a-glance
  // sparklines on the concepts list view — previously those were
  // synthetic random data converging on the current depth, which was
  // misleading. Now they show real `concept_depth_history` movement.
  const conceptIds = concepts.results.map((r) => r.id as string);
  const historyByConcept = new Map<string, number[]>();
  if (conceptIds.length > 0) {
    const placeholders = conceptIds.map(() => "?").join(",");
    const historyRows = await c.env.DB.prepare(
      `SELECT concept_id, depth_score, recorded_at
       FROM concept_depth_history
       WHERE user_id = ? AND concept_id IN (${placeholders})
       ORDER BY recorded_at ASC`,
    )
      .bind(user.userId, ...conceptIds)
      .all<{ concept_id: string; depth_score: number; recorded_at: string }>();
    for (const row of historyRows.results) {
      const arr = historyByConcept.get(row.concept_id) ?? [];
      arr.push(row.depth_score);
      historyByConcept.set(row.concept_id, arr);
    }
    // Cap each concept's series at the most-recent 24 points so the
    // payload stays bounded for active concepts that have been quizzed
    // many times. Older points are visually compressed anyway in the
    // ~80×20px sparkline.
    for (const [id, arr] of historyByConcept) {
      if (arr.length > 24) historyByConcept.set(id, arr.slice(-24));
    }
  }

  return c.json({
    concepts: concepts.results.map((row) => {
      const id = row.id as string;
      const history = historyByConcept.get(id) ?? [];
      // If a concept has at least one history entry but no current depth
      // score, the history's last point is the current depth — that's
      // what the maintenance/extraction code maintains. We still expose
      // the raw `depth` field for compatibility; the sparkline rendering
      // itself reads from `depthHistory`.
      return {
        id,
        name: row.canonical_name,
        aliases: JSON.parse((row.aliases as string) || "[]"),
        category: row.category,
        description: row.description,
        depth: (row.depth_score as number) ?? 0,
        confidence: (row.confidence as number) ?? 0,
        lastExposed: row.last_exposed_at,
        lastCalibrated: row.last_calibrated_at,
        exposureCount: (row.exposure_count as number) ?? 0,
        decayWarning: !!row.decay_warned_at,
        suppressedAt: row.suppressed_at,
        focusVersionId: row.focus_version_id,
        depthHistory: history,
      };
    }),
    total: total?.count ?? 0,
    hasMore: offset + limit < (total?.count ?? 0),
  });
});

// Mark a concept as not-interesting. Hides it from the trails view, excludes
// it from the briefing pipeline, and the canonical name is fed to the
// extraction prompt as "do not re-extract".
conceptRoutes.post("/concept/:id/suppress", async (c) => {
  const user = c.get("user");
  const conceptId = c.req.param("id");
  const result = await c.env.DB.prepare(
    "UPDATE concepts SET suppressed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  )
    .bind(conceptId, user.userId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "concept not found" }, 404);
  return c.json({ ok: true, suppressedAt: new Date().toISOString() });
});

conceptRoutes.post("/concept/:id/unsuppress", async (c) => {
  const user = c.get("user");
  const conceptId = c.req.param("id");
  const result = await c.env.DB.prepare(
    "UPDATE concepts SET suppressed_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  )
    .bind(conceptId, user.userId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: "concept not found" }, 404);
  return c.json({ ok: true });
});

// Wipe the user's concept graph. Triggered from Settings ("Reset concepts").
// Deletes concepts, depth, history, and artifact links — calibration progress
// included. Briefings are preserved (they're an audit trail of what was
// generated) but their concept references will dangle.
conceptRoutes.post("/concepts/reset", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  // Delete in FK-safe order
  await db
    .prepare("DELETE FROM concept_artifacts WHERE concept_id IN (SELECT id FROM concepts WHERE user_id = ?)")
    .bind(user.userId)
    .run();
  await db
    .prepare("DELETE FROM concept_depth_history WHERE concept_id IN (SELECT id FROM concepts WHERE user_id = ?)")
    .bind(user.userId)
    .run();
  await db.prepare("DELETE FROM concept_relations WHERE user_id = ?").bind(user.userId).run();
  await db.prepare("DELETE FROM concept_depth WHERE user_id = ?").bind(user.userId).run();
  const deleted = await db.prepare("DELETE FROM concepts WHERE user_id = ?").bind(user.userId).run();

  return c.json({ ok: true, deletedConcepts: deleted.meta.changes ?? 0 });
});

conceptRoutes.get("/concept/:id", async (c) => {
  const user = c.get("user");
  const conceptId = c.req.param("id");

  const concept = await c.env.DB.prepare(
    `SELECT c.*, cd.depth_score, cd.confidence, cd.last_exposed_at,
            cd.exposure_count, cd.last_calibrated_at, cd.decay_warned_at
     FROM concepts c
     LEFT JOIN concept_depth cd ON c.id = cd.concept_id
     WHERE c.id = ? AND c.user_id = ?`,
  )
    .bind(conceptId, user.userId)
    .first();

  if (!concept) {
    return c.json({ error: "Concept not found" }, 404);
  }

  const relations = await c.env.DB.prepare(
    `SELECT cr.*, c2.canonical_name as target_name
     FROM concept_relations cr
     JOIN concepts c2 ON cr.target_concept_id = c2.id
     WHERE cr.source_concept_id = ? AND cr.user_id = ?`,
  )
    .bind(conceptId, user.userId)
    .all();

  const reverseRelations = await c.env.DB.prepare(
    `SELECT cr.*, c2.canonical_name as source_name
     FROM concept_relations cr
     JOIN concepts c2 ON cr.source_concept_id = c2.id
     WHERE cr.target_concept_id = ? AND cr.user_id = ?`,
  )
    .bind(conceptId, user.userId)
    .all();

  const artifacts = await c.env.DB.prepare("SELECT * FROM concept_artifacts WHERE concept_id = ? AND user_id = ?")
    .bind(conceptId, user.userId)
    .all();

  return c.json({
    concept: {
      id: concept.id,
      name: concept.canonical_name,
      aliases: JSON.parse((concept.aliases as string) || "[]"),
      category: concept.category,
      description: concept.description,
      depth: (concept.depth_score as number) ?? 0,
      confidence: (concept.confidence as number) ?? 0,
      lastExposed: concept.last_exposed_at,
      lastCalibrated: concept.last_calibrated_at,
      exposureCount: (concept.exposure_count as number) ?? 0,
      decayWarning: !!concept.decay_warned_at,
    },
    relations: relations.results,
    reverseRelations: reverseRelations.results,
    artifacts: artifacts.results,
  });
});

conceptRoutes.get("/concept/:id/history", async (c) => {
  const user = c.get("user");
  const conceptId = c.req.param("id");

  const history = await c.env.DB.prepare(
    `SELECT depth_score, confidence, change_source, change_detail, recorded_at
     FROM concept_depth_history
     WHERE concept_id = ? AND user_id = ?
     ORDER BY recorded_at ASC`,
  )
    .bind(conceptId, user.userId)
    .all();

  return c.json({
    history: history.results.map((row) => ({
      depth: row.depth_score,
      confidence: row.confidence,
      source: row.change_source,
      detail: row.change_detail,
      date: row.recorded_at,
    })),
  });
});

conceptRoutes.get("/concept/:id/articles", async (c) => {
  const user = c.get("user");
  const conceptId = c.req.param("id");

  const articles = await c.env.DB.prepare(
    `SELECT tp.id, tp.title, tp.piece_type, tp.created_at, tp.briefing_id
     FROM teaching_pieces tp
     WHERE tp.user_id = ? AND tp.concepts LIKE ?
     ORDER BY tp.created_at DESC`,
  )
    .bind(user.userId, `%${conceptId}%`)
    .all();

  return c.json({
    articles: articles.results.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.piece_type,
      date: row.created_at,
      briefingId: row.briefing_id,
    })),
  });
});

conceptRoutes.get("/concepts/graph", async (c) => {
  const user = c.get("user");

  const concepts = await c.env.DB.prepare(
    `SELECT c.id, c.canonical_name, c.category, cd.depth_score
     FROM concepts c
     LEFT JOIN concept_depth cd ON c.id = cd.concept_id
     WHERE c.user_id = ?`,
  )
    .bind(user.userId)
    .all();

  const relations = await c.env.DB.prepare(
    `SELECT source_concept_id, target_concept_id, relation_type
     FROM concept_relations WHERE user_id = ?`,
  )
    .bind(user.userId)
    .all();

  return c.json({
    nodes: concepts.results.map((r) => ({
      id: r.id,
      name: r.canonical_name,
      category: r.category,
      depth: (r.depth_score as number) ?? 0,
    })),
    edges: relations.results.map((r) => ({
      source: r.source_concept_id,
      target: r.target_concept_id,
      type: r.relation_type,
    })),
  });
});
