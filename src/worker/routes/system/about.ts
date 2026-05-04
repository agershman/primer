/**
 * About-statement (versioned, persona) endpoints.
 *
 * - POST   `/me/about`                          — create new version
 * - GET    `/me/about/history`                  — list versions
 * - POST   `/me/about/:versionId/restore`       — restore an old version
 * - DELETE `/me/about/:versionId`               — delete a non-current version
 * - GET    `/me/about/:versionId/analytics`     — per-version impact metrics
 *
 * About is the persona / style signal injected into every
 * user-facing AI generation surface. We deliberately don't attribute
 * concepts/briefings to an About version because About is a
 * stylistic signal, not a topic-selection one — knowing "what
 * concepts came in under About v3" isn't actionable. Analytics here
 * are time-window-based: how many concepts / briefings / teaching
 * pieces were generated *during* this About's active period
 * (cross-referenced via `created_at` falling between version
 * timestamps).
 *
 * Pairs with the topic-selection Focus endpoints in
 * [`./focus.ts`](./focus.ts).
 *
 * @see ../system.ts — assembly entry point
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { parseBody, StatementVersionRequest } from "../../../shared/schemas.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemAboutRoutes = new Hono<AppEnv>();

interface AboutVersionRow {
  id: string;
  user_id: string;
  statement: string;
  note: string | null;
  created_at: string;
}

systemAboutRoutes.post("/me/about", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  // Validates body shape + length caps via the shared zod schema —
  // same schema the `/me/focus` POST uses since the wire shape is
  // identical. Trim + idempotency live here; everything else moves
  // to the contract.
  const parsed = await parseBody(c.req.raw, StatementVersionRequest);
  if (!parsed.ok) return c.json(parsed.error, 400);
  const trimmed = parsed.data.statement.trim();
  if (!trimmed) return c.json({ error: "statement is required" }, 400);

  // No-op short-circuit — identical statements return the existing
  // version unchanged.
  if (user.aboutStatement && user.aboutStatement.trim() === trimmed) {
    const current = await db
      .prepare("SELECT * FROM about_statement_versions WHERE id = ?")
      .bind(user.aboutVersionId)
      .first<AboutVersionRow>();
    return c.json({ version: current, isNew: false });
  }

  // `note` is no longer required — see /me/focus for the same
  // reasoning. The history view surfaces the textual diff between
  // consecutive versions, which is what users scan history for.
  const noteRaw = (parsed.data.note ?? "").trim();
  const note: string | null = noteRaw.length > 0 ? noteRaw : null;

  const versionId = `av_${nanoid(12)}`;
  await db
    .prepare(
      `INSERT INTO about_statement_versions (id, user_id, statement, note, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .bind(versionId, user.userId, trimmed, note)
    .run();
  await db
    .prepare("UPDATE users SET current_about_version_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(versionId, user.userId)
    .run();

  const created = await db
    .prepare("SELECT * FROM about_statement_versions WHERE id = ?")
    .bind(versionId)
    .first<AboutVersionRow>();
  return c.json({ version: created, isNew: true });
});

systemAboutRoutes.get("/me/about/history", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT id, statement, note, created_at
       FROM about_statement_versions
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
    isCurrent: r.id === user.aboutVersionId,
  }));
  return c.json({ versions, currentVersionId: user.aboutVersionId });
});

systemAboutRoutes.post("/me/about/:versionId/restore", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const sourceId = c.req.param("versionId");

  const source = await db
    .prepare("SELECT * FROM about_statement_versions WHERE id = ? AND user_id = ?")
    .bind(sourceId, user.userId)
    .first<AboutVersionRow>();
  if (!source) return c.json({ error: "version not found" }, 404);

  const newId = `av_${nanoid(12)}`;
  const note = `restored from ${source.id}`;
  await db
    .prepare(
      `INSERT INTO about_statement_versions (id, user_id, statement, note, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .bind(newId, user.userId, source.statement, note)
    .run();
  await db
    .prepare("UPDATE users SET current_about_version_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newId, user.userId)
    .run();

  const created = await db
    .prepare("SELECT * FROM about_statement_versions WHERE id = ?")
    .bind(newId)
    .first<AboutVersionRow>();
  return c.json({ version: created });
});

systemAboutRoutes.delete("/me/about/:versionId", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const versionId = c.req.param("versionId");

  if (versionId === user.aboutVersionId) {
    return c.json({ error: "cannot delete the current version; create a new version first" }, 409);
  }

  const exists = await db
    .prepare("SELECT id FROM about_statement_versions WHERE id = ? AND user_id = ?")
    .bind(versionId, user.userId)
    .first<{ id: string }>();
  if (!exists) return c.json({ error: "version not found" }, 404);

  // No attribution to clean up — About isn't stamped onto concepts/briefings.
  await db.prepare("DELETE FROM about_statement_versions WHERE id = ?").bind(versionId).run();
  return c.json({ ok: true });
});

systemAboutRoutes.get("/me/about/:versionId/analytics", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const versionId = c.req.param("versionId");

  const version = await db
    .prepare("SELECT id, statement, created_at FROM about_statement_versions WHERE id = ? AND user_id = ?")
    .bind(versionId, user.userId)
    .first<{ id: string; statement: string; created_at: string }>();
  if (!version) return c.json({ error: "version not found" }, 404);

  const nextVersion = await db
    .prepare(
      `SELECT created_at FROM about_statement_versions
       WHERE user_id = ? AND created_at > ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(user.userId, version.created_at)
    .first<{ created_at: string }>();
  const activeTo = nextVersion?.created_at ?? null;

  // Time-window aggregations: anything created between activeFrom and activeTo
  // (or "now" if activeTo is null because this is the current version).
  const upper = activeTo ?? new Date().toISOString();

  const conceptsCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM concepts
       WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .bind(user.userId, version.created_at, upper)
    .first<{ n: number }>();

  const briefingsCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM briefings
       WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .bind(user.userId, version.created_at, upper)
    .first<{ n: number }>();

  const piecesCount = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM teaching_pieces
       WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .bind(user.userId, version.created_at, upper)
    .first<{ n: number }>();

  const feedbackRow = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN feedback = 'positive' THEN 1 ELSE 0 END) AS pos,
        SUM(CASE WHEN feedback IS NOT NULL THEN 1 ELSE 0 END) AS total
       FROM teaching_pieces
       WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .bind(user.userId, version.created_at, upper)
    .first<{ pos: number | null; total: number | null }>();

  const totalFeedback = feedbackRow?.total ?? 0;
  const positive = feedbackRow?.pos ?? 0;

  return c.json({
    versionId: version.id,
    activeFrom: version.created_at,
    activeTo,
    isCurrent: versionId === user.aboutVersionId,
    conceptsCreated: conceptsCount?.n ?? 0,
    briefingsGenerated: briefingsCount?.n ?? 0,
    teachingPiecesGenerated: piecesCount?.n ?? 0,
    positiveFeedbackRate: totalFeedback > 0 ? positive / totalFeedback : null,
  });
});
