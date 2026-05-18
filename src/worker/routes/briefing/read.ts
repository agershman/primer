/**
 * Read-side briefing endpoints.
 *
 * - GET `/briefing/today`        — current-day briefing + pieces + quiz
 * - GET `/briefing/status`       — generation progress for "today"
 * - GET `/briefing/:date`        — a specific historical briefing
 * - GET `/briefings/dates`       — calendar/scrubber support payload
 * - GET `/briefings`             — paginated list with content summary
 *
 * @see ../briefing.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";
import { shiftDate, userToday } from "../../util/time.js";
import { isZombie, parseRedundantDrafts, todayFor } from "./shared.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const briefingReadRoutes = new Hono<AppEnv>();

briefingReadRoutes.get("/briefing/today", async (c) => {
  const user = c.get("user");
  const today = todayFor(user);

  // The worker is the single source of truth for "today" — derived
  // from the user's timezone (X-Client-Timezone header on the active
  // session, persisted on the user row for cron). We previously
  // accepted a `?date=` hint from the client, but that surfaced a
  // class of bugs where the client's date and the worker's date
  // disagreed (a client formatting UTC-as-local would drag the
  // briefing into "tomorrow" before midnight). With the TZ in hand
  // server-side, the client's "today" is whatever userToday(user) says.
  //
  // We look up by exact `briefing_date` only. If no row exists for
  // today, we fall back to the most recent briefing whose date is
  // already-passed (≤ today), so users on weekends still see Friday's
  // briefing. Future-dated rows are explicitly excluded — that was
  // the "Monday April 27 in the header while my clock says Sunday"
  // bug.
  //
  // The LEFT JOIN against `focus_statement_versions` gives the
  // historical focus that was active when the briefing was generated.
  // Pre-versioning briefings (migration 0009) have NULL focus_version_id
  // and produce NULL focus_statement_at_briefing on the response.
  let briefing = await c.env.DB.prepare(
    `SELECT b.*, fv.statement AS focus_statement_at_briefing
     FROM briefings b
     LEFT JOIN focus_statement_versions fv ON fv.id = b.focus_version_id
     WHERE b.user_id = ? AND b.briefing_date = ?`,
  )
    .bind(user.userId, today)
    .first();
  if (!briefing) {
    briefing = await c.env.DB.prepare(
      `SELECT b.*, fv.statement AS focus_statement_at_briefing
       FROM briefings b
       LEFT JOIN focus_statement_versions fv ON fv.id = b.focus_version_id
       WHERE b.user_id = ?
         AND b.briefing_date <= ?
         AND EXISTS (SELECT 1 FROM teaching_pieces tp WHERE tp.briefing_id = b.id)
       ORDER BY b.briefing_date DESC LIMIT 1`,
    )
      .bind(user.userId, today)
      .first();
  }

  if (!briefing) {
    return c.json({ briefing: null, pieces: [], quiz: null });
  }

  const pieces = await c.env.DB.prepare(`SELECT * FROM teaching_pieces WHERE briefing_id = ? ORDER BY position DESC`)
    .bind(briefing.id)
    .all();

  // A finalized briefing with zero pieces is the original
  // "missing briefing" surface area: the row exists, the first
  // query above matches it, and the UI used to render an empty
  // shell with no explanation. Promote `metadata.reason` (set by
  // the generator's finalize step + the budget-cap path) to a
  // top-level `noContentReason` so the UI can show an explicit
  // empty state. `null` when the briefing has pieces or is still
  // generating.
  const briefingMetadata = JSON.parse((briefing.metadata as string) || "{}");
  const isFinalized = briefing.status !== "generating";
  const noContentReason =
    isFinalized && pieces.results.length === 0 ? ((briefingMetadata.reason as string | undefined) ?? "unknown") : null;

  const quiz = await c.env.DB.prepare(
    `SELECT * FROM calibration_quizzes
     WHERE user_id = ? AND teaching_piece_id IN (
       SELECT id FROM teaching_pieces WHERE briefing_id = ?
     ) AND status = 'pending' LIMIT 1`,
  )
    .bind(user.userId, briefing.id)
    .first();

  const piecesWithResources = await Promise.all(
    pieces.results.map(async (piece) => {
      const resources = await c.env.DB.prepare(
        "SELECT * FROM piece_resources WHERE teaching_piece_id = ? ORDER BY position",
      )
        .bind(piece.id)
        .all();
      return {
        ...piece,
        content: JSON.parse((piece.content as string) || "[]"),
        concepts: JSON.parse((piece.concepts as string) || "[]"),
        resources: resources.results,
        model_used: (piece.model_used as string | null) ?? null,
        source_context: JSON.parse((piece.source_context as string) || "[]"),
      };
    }),
  );

  return c.json({
    briefing: {
      ...briefing,
      workContextSources: JSON.parse((briefing.work_context_sources as string) || "[]"),
      metadata: briefingMetadata,
      // Surface the historical focus statement under a camelCase alias
      // so the frontend doesn't have to know about the join column.
      // Pre-versioning briefings (focus_version_id is NULL) get null
      // here, which the UI uses to hide the "active when this briefing
      // ran" badge.
      focusStatementAtBriefing: (briefing.focus_statement_at_briefing as string | null) ?? null,
      // Drafts the continuation classifier filtered as REDUNDANT.
      // Empty list when nothing was filtered. The frontend uses this
      // to render a subtle "no new movement on these topics" header
      // chip with deep-links back to each predecessor piece.
      redundantDrafts: parseRedundantDrafts(briefing.redundant_drafts as string | null),
      noContentReason,
    },
    pieces: piecesWithResources,
    quiz,
  });
});

briefingReadRoutes.get("/briefing/status", async (c) => {
  const user = c.get("user");
  const today = todayFor(user);

  const briefing = await c.env.DB.prepare(
    "SELECT status, generated_at, created_at, updated_at, metadata, cancel_requested FROM briefings WHERE user_id = ? AND briefing_date = ?",
  )
    .bind(user.userId, today)
    .first<{
      status: string;
      generated_at: string;
      created_at: string;
      updated_at: string;
      metadata: string;
      cancel_requested: number;
    }>();

  const metadata = briefing?.metadata ? JSON.parse(briefing.metadata) : {};

  // Compute the average duration of recent successful briefings (last 10) for an adaptive ETA
  const durationsRow = await c.env.DB.prepare(
    `SELECT AVG((julianday(updated_at) - julianday(created_at)) * 86400) as avg_seconds
     FROM (
       SELECT created_at, updated_at FROM briefings
       WHERE user_id = ? AND status IN ('generated', 'partial') AND updated_at > created_at
       ORDER BY created_at DESC LIMIT 10
     )`,
  )
    .bind(user.userId)
    .first<{ avg_seconds: number | null }>();

  const avgSeconds = durationsRow?.avg_seconds ?? null;

  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC — convert to
  // ISO so the client (and Date parsers everywhere) treat it consistently.
  const toIso = (ts: string | null | undefined): string | null => {
    if (!ts) return null;
    if (ts.includes("T")) return ts;
    return ts.replace(" ", "T") + "Z";
  };

  const updatedAtIso = toIso(briefing?.updated_at);
  const stuck = briefing ? isZombie(briefing.status, briefing.updated_at, briefing.metadata) : false;

  return c.json({
    status: briefing?.status === "generating" ? "generating" : (briefing?.status ?? "idle"),
    step: metadata.step ?? null,
    stepLabel: metadata.stepLabel ?? null,
    details: metadata.details ?? [],
    waitingOnAi: metadata.waitingOnAi ?? false,
    stepStartedAt: metadata.stepStartedAt ?? null,
    startedAt: toIso(briefing?.created_at) ?? null,
    updatedAt: updatedAtIso,
    lastGenerated: toIso(briefing?.generated_at),
    averageDurationSeconds: avgSeconds,
    cancelRequested: Number(briefing?.cancel_requested ?? 0) === 1,
    stuck,
  });
});

briefingReadRoutes.get("/briefing/:date", async (c) => {
  const user = c.get("user");
  const date = c.req.param("date");

  // Same JOIN trick as `/briefing/today` — pull the focus statement that
  // was active when this specific briefing was generated, not the user's
  // current focus. Lets the UI render an honest "focus active when this
  // briefing ran" badge for past dates.
  const briefing = await c.env.DB.prepare(
    `SELECT b.*, fv.statement AS focus_statement_at_briefing
     FROM briefings b
     LEFT JOIN focus_statement_versions fv ON fv.id = b.focus_version_id
     WHERE b.user_id = ? AND b.briefing_date = ?`,
  )
    .bind(user.userId, date)
    .first();

  if (!briefing) {
    return c.json({ error: "No briefing for this date" }, 404);
  }

  const pieces = await c.env.DB.prepare(`SELECT * FROM teaching_pieces WHERE briefing_id = ? ORDER BY position DESC`)
    .bind(briefing.id)
    .all();

  const piecesWithResources = await Promise.all(
    pieces.results.map(async (piece) => {
      const resources = await c.env.DB.prepare(
        "SELECT * FROM piece_resources WHERE teaching_piece_id = ? ORDER BY position",
      )
        .bind(piece.id)
        .all();
      return {
        ...piece,
        content: JSON.parse((piece.content as string) || "[]"),
        concepts: JSON.parse((piece.concepts as string) || "[]"),
        resources: resources.results,
        model_used: (piece.model_used as string | null) ?? null,
        source_context: JSON.parse((piece.source_context as string) || "[]"),
      };
    }),
  );

  return c.json({
    briefing: {
      ...briefing,
      workContextSources: JSON.parse((briefing.work_context_sources as string) || "[]"),
      metadata: JSON.parse((briefing.metadata as string) || "{}"),
      focusStatementAtBriefing: (briefing.focus_statement_at_briefing as string | null) ?? null,
      redundantDrafts: parseRedundantDrafts(briefing.redundant_drafts as string | null),
    },
    pieces: piecesWithResources,
  });
});

/**
 * Lightweight calendar/timeline support endpoint.
 *
 * Returns just the set of dates this user has briefings for, along with the
 * user's retention window. The full briefings list endpoint is paginated and
 * returns greetings + status, which is overkill for rendering a vertical
 * scroll-timeline scrubber (briefing page) or a calendar navigator
 * (archive page) — both of which only need to know "what dates exist" and
 * "how far back can the user navigate".
 *
 * Payload is intentionally minimal: with the default 365-day retention and
 * one briefing per day, the result is at most ~365 short ISO date strings
 * (≈4 KB), so we don't bother paginating.
 */
briefingReadRoutes.get("/briefings/dates", async (c) => {
  const user = c.get("user");

  // Distinct dates the user has briefings for, newest first. The frontend
  // uses index 0 = newest when mapping scrubber position to a date.
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT briefing_date
     FROM briefings
     WHERE user_id = ?
     ORDER BY briefing_date DESC`,
  )
    .bind(user.userId)
    .all<{ briefing_date: string }>();

  const dates = (rows.results ?? []).map((r) => r.briefing_date);

  // "Today" and "earliest allowed" are both anchored to the user's
  // *local* today, not UTC. Without this, an 11 PM Sunday EDT user
  // sees the archive seed to UTC-Monday's empty week — even though
  // their wall clock still reads Sunday — and the "This week"
  // shortcut button vanishes (because UTC-Monday is the current
  // week from the worker's POV). Using `userToday` keeps the archive
  // aligned with the user's calendar.
  const retentionDays = user.settings?.retentionDays ?? 365;
  const todayDate = userToday(user.timezone);
  const earliestAllowed = shiftDate(todayDate, -retentionDays);
  const earliestRetained = dates.length > 0 ? dates[dates.length - 1] : null;

  return c.json({
    dates,
    retentionDays,
    earliestAllowed,
    earliestRetained,
    todayDate,
  });
});

briefingReadRoutes.get("/briefings", async (c) => {
  const user = c.get("user");
  const limit = parseInt(c.req.query("limit") || "10", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  // Deduplicate by date — only the most recent briefing per day.
  // The legacy `greeting` column lives on in the schema for old
  // rows, but the briefings list no longer surfaces it: the per-day
  // header (date + status) plus the piece titles + concept tags
  // already give the row a "what was this about" identity. Selecting
  // it here would only add bytes to the response and tempt
  // consumers to render it again.
  const briefingsResult = await c.env.DB.prepare(
    `SELECT b.id, b.briefing_date, b.status, b.generated_at, b.created_at
     FROM briefings b
     INNER JOIN (
       SELECT briefing_date, MAX(created_at) as latest
       FROM briefings WHERE user_id = ?
       GROUP BY briefing_date
     ) latest ON b.briefing_date = latest.briefing_date AND b.created_at = latest.latest
     WHERE b.user_id = ?
     ORDER BY b.briefing_date DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.userId, user.userId, limit, offset)
    .all<{
      id: string;
      briefing_date: string;
      status: string;
      generated_at: string | null;
      created_at: string;
    }>();

  const total = await c.env.DB.prepare("SELECT COUNT(DISTINCT briefing_date) as count FROM briefings WHERE user_id = ?")
    .bind(user.userId)
    .first<{ count: number }>();

  // Enrich each briefing with a content summary — piece titles + top
  // concept tags. The Archive page uses this to give each row a real
  // "what was this about" preview.
  // Two batched queries keep this O(2) round-trips no matter how many
  // briefings the user paginates through.
  const briefingIds = briefingsResult.results.map((b) => b.id);
  let summaries: Record<string, { pieceCount: number; pieceTitles: string[]; topConcepts: string[] }> = {};

  if (briefingIds.length > 0) {
    const placeholders = briefingIds.map(() => "?").join(",");

    // Pull every piece in one shot, ordered by position DESC so the
    // first-N titles we surface match the on-page reading order
    // (newest piece first within each briefing).
    const pieces = await c.env.DB.prepare(
      `SELECT briefing_id, title, position, concepts
       FROM teaching_pieces
       WHERE briefing_id IN (${placeholders}) AND user_id = ?
       ORDER BY briefing_id, position DESC`,
    )
      .bind(...briefingIds, user.userId)
      .all<{ briefing_id: string; title: string; position: number; concepts: string }>();

    // Collect every concept id referenced across the visible briefings
    // so we can resolve to canonical names with a single IN query.
    const allConceptIds = new Set<string>();
    for (const p of pieces.results) {
      try {
        const ids: string[] = JSON.parse(p.concepts || "[]");
        for (const id of ids) if (id) allConceptIds.add(id);
      } catch {
        // Malformed JSON — skip this piece's concepts. The titles
        // still make the row useful.
      }
    }

    let conceptNameById: Record<string, string> = {};
    if (allConceptIds.size > 0) {
      const conceptIds = [...allConceptIds];
      const conceptPlaceholders = conceptIds.map(() => "?").join(",");
      const concepts = await c.env.DB.prepare(
        `SELECT id, canonical_name FROM concepts
         WHERE id IN (${conceptPlaceholders}) AND user_id = ?`,
      )
        .bind(...conceptIds, user.userId)
        .all<{ id: string; canonical_name: string }>();
      conceptNameById = Object.fromEntries(concepts.results.map((c) => [c.id, c.canonical_name]));
    }

    // Roll up per-briefing: piece count, the first ~5 titles, and the
    // top-5 concepts by within-briefing frequency. Frequency tiebreaks
    // by first-mention order so "kubernetes" wins over equally-cited
    // "terraform" if it appeared in the lead piece.
    const grouped = new Map<string, { titles: string[]; concepts: Map<string, number> }>();
    for (const p of pieces.results) {
      let entry = grouped.get(p.briefing_id);
      if (!entry) {
        entry = { titles: [], concepts: new Map() };
        grouped.set(p.briefing_id, entry);
      }
      entry.titles.push(p.title);
      try {
        const ids: string[] = JSON.parse(p.concepts || "[]");
        for (const id of ids) {
          const name = conceptNameById[id];
          if (!name) continue;
          entry.concepts.set(name, (entry.concepts.get(name) ?? 0) + 1);
        }
      } catch {
        // skip
      }
    }

    summaries = Object.fromEntries(
      [...grouped.entries()].map(([briefingId, e]) => {
        const topConcepts = [...e.concepts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name]) => name);
        return [
          briefingId,
          {
            pieceCount: e.titles.length,
            // Cap to 5 titles so the archive row stays scannable; the
            // full piece list is one click away on the briefing page.
            pieceTitles: e.titles.slice(0, 5),
            topConcepts,
          },
        ];
      }),
    );
  }

  return c.json({
    briefings: briefingsResult.results.map((b) => {
      const s = summaries[b.id];
      return {
        ...b,
        pieceCount: s?.pieceCount ?? 0,
        pieceTitles: s?.pieceTitles ?? [],
        topConcepts: s?.topConcepts ?? [],
      };
    }),
    total: total?.count ?? 0,
    hasMore: offset + limit < (total?.count ?? 0),
  });
});
