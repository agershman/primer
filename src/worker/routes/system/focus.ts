/**
 * Focus-statement (versioned) endpoints.
 *
 * - POST   `/me/focus`                          — create new version
 * - GET    `/me/focus/history`                  — list versions
 * - POST   `/me/focus/:versionId/restore`       — restore an old version
 * - DELETE `/me/focus/:versionId`               — delete a non-current version
 * - GET    `/me/focus/:versionId/analytics`     — per-version impact metrics
 *
 * Focus is the topic-selection signal injected into the concept
 * extractor; pairs with the persona-style About endpoints in
 * [`./about.ts`](./about.ts).
 *
 * @see ../system.ts — assembly entry point
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { parseBody, StatementVersionRequest } from "../../../shared/schemas.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemFocusRoutes = new Hono<AppEnv>();

interface FocusVersionRow {
  id: string;
  user_id: string;
  statement: string;
  note: string | null;
  created_at: string;
}

// Create a new focus statement version. Idempotent: if the new statement is
// identical to the current one, returns the existing version (no spurious row).
systemFocusRoutes.post("/me/focus", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  // Body shape + length caps live in the shared zod schema —
  // single source of truth for the contract on both sides of the
  // wire. The schema already enforces statement non-empty + ≤4000
  // chars and note ≤300 chars; we only have to handle whitespace
  // trimming + idempotency afterwards.
  const parsed = await parseBody(c.req.raw, StatementVersionRequest);
  if (!parsed.ok) return c.json(parsed.error, 400);
  const trimmed = parsed.data.statement.trim();
  if (!trimmed) {
    return c.json({ error: "statement is required" }, 400);
  }

  // No-op if identical to current — return existing version unchanged.
  if (user.focusStatement && user.focusStatement.trim() === trimmed) {
    const current = await db
      .prepare("SELECT * FROM focus_statement_versions WHERE id = ?")
      .bind(user.focusVersionId)
      .first<FocusVersionRow>();
    return c.json({ version: current, isNew: false });
  }

  // `note` is no longer required. The version history view surfaces
  // the textual diff between consecutive versions (the "what
  // changed"), which is what users actually need when scanning
  // history. We still accept a note if a future surface (e.g. the
  // restore-from-version path below) wants to record one — the
  // column stays nullable. We just don't ask the user to type one.
  const noteRaw = (parsed.data.note ?? "").trim();
  const note: string | null = noteRaw.length > 0 ? noteRaw : null;

  const versionId = `fv_${nanoid(12)}`;
  await db
    .prepare(
      `INSERT INTO focus_statement_versions (id, user_id, statement, note, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .bind(versionId, user.userId, trimmed, note)
    .run();

  await db
    .prepare("UPDATE users SET current_focus_version_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(versionId, user.userId)
    .run();

  const created = await db
    .prepare("SELECT * FROM focus_statement_versions WHERE id = ?")
    .bind(versionId)
    .first<FocusVersionRow>();

  return c.json({ version: created, isNew: true });
});

systemFocusRoutes.get("/me/focus/history", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT id, statement, note, created_at
       FROM focus_statement_versions
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .bind(user.userId)
    .all<{ id: string; statement: string; note: string | null; created_at: string }>();

  const versions = (rows.results ?? []).map((r) => ({
    id: r.id,
    statement: r.statement,
    note: r.note,
    createdAt: r.created_at,
    isCurrent: r.id === user.focusVersionId,
  }));
  return c.json({ versions, currentVersionId: user.focusVersionId });
});

// Restore a previous version: creates a NEW version row with the same statement
// (and a note pointing back at the source version), then sets it as current.
// We don't just flip the pointer because we want history to remain a faithful
// timeline of "what the user actually had active and when".
systemFocusRoutes.post("/me/focus/:versionId/restore", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const sourceId = c.req.param("versionId");

  const source = await db
    .prepare("SELECT * FROM focus_statement_versions WHERE id = ? AND user_id = ?")
    .bind(sourceId, user.userId)
    .first<FocusVersionRow>();
  if (!source) return c.json({ error: "version not found" }, 404);

  const newId = `fv_${nanoid(12)}`;
  const note = `restored from ${source.id}`;
  await db
    .prepare(
      `INSERT INTO focus_statement_versions (id, user_id, statement, note, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .bind(newId, user.userId, source.statement, note)
    .run();
  await db
    .prepare("UPDATE users SET current_focus_version_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newId, user.userId)
    .run();

  const created = await db
    .prepare("SELECT * FROM focus_statement_versions WHERE id = ?")
    .bind(newId)
    .first<FocusVersionRow>();
  return c.json({ version: created });
});

// Delete a non-current historical version. Concepts/briefings tagged with this
// version get focus_version_id = NULL (kept for stats — they're now "untagged").
systemFocusRoutes.delete("/me/focus/:versionId", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const versionId = c.req.param("versionId");

  if (versionId === user.focusVersionId) {
    return c.json({ error: "cannot delete the current version; create a new version first" }, 409);
  }

  const exists = await db
    .prepare("SELECT id FROM focus_statement_versions WHERE id = ? AND user_id = ?")
    .bind(versionId, user.userId)
    .first<{ id: string }>();
  if (!exists) return c.json({ error: "version not found" }, 404);

  await db.prepare("UPDATE concepts SET focus_version_id = NULL WHERE focus_version_id = ?").bind(versionId).run();
  await db.prepare("UPDATE briefings SET focus_version_id = NULL WHERE focus_version_id = ?").bind(versionId).run();
  await db.prepare("DELETE FROM focus_statement_versions WHERE id = ?").bind(versionId).run();

  return c.json({ ok: true });
});

// Aggregations for a single focus version: how many concepts/briefings/pieces
// were created while this version was active, what the category mix looked
// like, and the suppression rate (% of concepts under this version that the
// user later marked as not-interested — a high rate signals the focus
// statement isn't filtering well).
systemFocusRoutes.get("/me/focus/:versionId/analytics", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const versionId = c.req.param("versionId");

  const version = await db
    .prepare("SELECT id, statement, created_at FROM focus_statement_versions WHERE id = ? AND user_id = ?")
    .bind(versionId, user.userId)
    .first<{ id: string; statement: string; created_at: string }>();
  if (!version) return c.json({ error: "version not found" }, 404);

  const nextVersion = await db
    .prepare(
      `SELECT created_at FROM focus_statement_versions
       WHERE user_id = ? AND created_at > ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(user.userId, version.created_at)
    .first<{ created_at: string }>();
  const activeTo = nextVersion?.created_at ?? null;

  const conceptsCount = await db
    .prepare("SELECT COUNT(*) AS n FROM concepts WHERE user_id = ? AND focus_version_id = ?")
    .bind(user.userId, versionId)
    .first<{ n: number }>();

  const suppressedCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM concepts
       WHERE user_id = ? AND focus_version_id = ? AND suppressed_at IS NOT NULL`,
    )
    .bind(user.userId, versionId)
    .first<{ n: number }>();

  const briefingsCount = await db
    .prepare("SELECT COUNT(*) AS n FROM briefings WHERE user_id = ? AND focus_version_id = ?")
    .bind(user.userId, versionId)
    .first<{ n: number }>();

  const piecesCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM teaching_pieces tp
       JOIN briefings b ON b.id = tp.briefing_id
       WHERE b.user_id = ? AND b.focus_version_id = ?`,
    )
    .bind(user.userId, versionId)
    .first<{ n: number }>();

  const categoryRows = await db
    .prepare(
      `SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS n
       FROM concepts
       WHERE user_id = ? AND focus_version_id = ?
       GROUP BY category
       ORDER BY n DESC`,
    )
    .bind(user.userId, versionId)
    .all<{ category: string; n: number }>();

  const sourceRows = await db
    .prepare(
      `SELECT tp.source_type AS source_type, COUNT(*) AS n
       FROM teaching_pieces tp
       JOIN briefings b ON b.id = tp.briefing_id
       WHERE b.user_id = ? AND b.focus_version_id = ?
       GROUP BY tp.source_type
       ORDER BY n DESC`,
    )
    .bind(user.userId, versionId)
    .all<{ source_type: string; n: number }>();

  const feedbackRow = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN tp.feedback = 'positive' THEN 1 ELSE 0 END) AS pos,
        SUM(CASE WHEN tp.feedback IS NOT NULL THEN 1 ELSE 0 END) AS total
       FROM teaching_pieces tp
       JOIN briefings b ON b.id = tp.briefing_id
       WHERE b.user_id = ? AND b.focus_version_id = ?`,
    )
    .bind(user.userId, versionId)
    .first<{ pos: number | null; total: number | null }>();

  const concepts = conceptsCount?.n ?? 0;
  const suppressed = suppressedCount?.n ?? 0;
  const totalFeedback = feedbackRow?.total ?? 0;
  const positive = feedbackRow?.pos ?? 0;

  return c.json({
    versionId: version.id,
    activeFrom: version.created_at,
    activeTo,
    isCurrent: versionId === user.focusVersionId,
    conceptsCreated: concepts,
    conceptsSuppressed: suppressed,
    suppressionRate: concepts > 0 ? suppressed / concepts : 0,
    briefingsGenerated: briefingsCount?.n ?? 0,
    teachingPiecesGenerated: piecesCount?.n ?? 0,
    categoryDistribution: Object.fromEntries((categoryRows.results ?? []).map((r) => [r.category, r.n])),
    sourceTypeDistribution: Object.fromEntries((sourceRows.results ?? []).map((r) => [r.source_type, r.n])),
    positiveFeedbackRate: totalFeedback > 0 ? positive / totalFeedback : null,
  });
});
