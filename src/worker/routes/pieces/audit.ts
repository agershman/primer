/**
 * Audit-trail endpoints — full per-piece + per-deep-dive claim list.
 *
 * The lightweight `audit_summary` rollup arrives inline on the
 * briefing-read response (LEFT JOIN on `audits` with `pass=1`); these
 * endpoints serve the full trail (both passes, every classified
 * span) lazily when the user opens the `AuditTrailPanel` modal or
 * clicks a wavy-underline span to open the popover.
 *
 * Owner-scoped, NOT admin-gated — a regular user reading their own
 * briefing should be able to inspect why a span was flagged. The
 * pieces.ts mount and briefing/read.ts JOIN both follow the same
 * rule.
 *
 * @see ../pieces.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";
import type { AuditClaim, AuditResolution, AuditTrail, AuditVerdict, WebEvidence } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const pieceAuditRoutes = new Hono<AppEnv>();

interface AuditRow {
  id: string;
  pass: number;
  status: "clean" | "patched" | "dropped" | "failed";
  audit_model: string;
  patch_model: string | null;
  used_web_search: number;
  total_claims: number;
  unsupported_count: number;
  hallucinated_count: number;
  grounded_web_count: number;
  patched_count: number;
  dropped_count: number;
}

interface ClaimRow {
  id: string;
  audit_id: string;
  block_index: number;
  span_start: number;
  span_end: number;
  claim_text: string;
  verdict: AuditVerdict;
  cited_refs: string;
  web_evidence: string | null;
  reasoning: string | null;
  resolution: AuditResolution | null;
  patched_text: string | null;
}

async function loadTrail(
  db: D1Database,
  userId: string,
  targetKind: "piece" | "deep_dive" | "quiz",
  targetId: string,
): Promise<AuditTrail | null> {
  const audits = await db
    .prepare(
      `SELECT id, pass, status, audit_model, patch_model, used_web_search,
              total_claims, unsupported_count, hallucinated_count, grounded_web_count,
              patched_count, dropped_count
       FROM audits
       WHERE user_id = ? AND target_kind = ? AND target_id = ?
       ORDER BY pass ASC`,
    )
    .bind(userId, targetKind, targetId)
    .all<AuditRow>();

  if (!audits.results || audits.results.length === 0) return null;

  const auditIds = audits.results.map((a) => a.id);
  const placeholders = auditIds.map(() => "?").join(",");
  const claims = await db
    .prepare(
      `SELECT id, audit_id, block_index, span_start, span_end, claim_text, verdict,
              cited_refs, web_evidence, reasoning, resolution, patched_text
       FROM audit_claims
       WHERE audit_id IN (${placeholders})
       ORDER BY block_index ASC, span_start ASC`,
    )
    .bind(...auditIds)
    .all<ClaimRow>();

  const claimsByAudit = new Map<string, AuditClaim[]>();
  for (const row of claims.results ?? []) {
    let webEvidence: WebEvidence[] | null = null;
    if (row.web_evidence) {
      try {
        webEvidence = JSON.parse(row.web_evidence) as WebEvidence[];
      } catch {
        webEvidence = null;
      }
    }
    let citedRefs: string[] = [];
    try {
      citedRefs = JSON.parse(row.cited_refs ?? "[]") as string[];
    } catch {
      citedRefs = [];
    }
    const list = claimsByAudit.get(row.audit_id) ?? [];
    list.push({
      id: row.id,
      block_index: row.block_index,
      span_start: row.span_start,
      span_end: row.span_end,
      claim_text: row.claim_text,
      verdict: row.verdict,
      cited_refs: citedRefs,
      web_evidence: webEvidence,
      reasoning: row.reasoning,
      resolution: row.resolution,
      patched_text: row.patched_text,
    });
    claimsByAudit.set(row.audit_id, list);
  }

  return {
    target_kind: targetKind,
    target_id: targetId,
    passes: audits.results.map((a) => ({
      pass: a.pass === 2 ? 2 : 1,
      summary: {
        status: a.status,
        audit_model: a.audit_model,
        patch_model: a.patch_model,
        used_web_search: a.used_web_search === 1,
        total_claims: a.total_claims,
        unsupported_count: a.unsupported_count,
        hallucinated_count: a.hallucinated_count,
        grounded_web_count: a.grounded_web_count,
        patched_count: a.patched_count,
        dropped_count: a.dropped_count,
      },
      claims: claimsByAudit.get(a.id) ?? [],
    })),
  };
}

pieceAuditRoutes.get("/piece/:id/audit", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");

  // Cheap existence + ownership check before loading the trail.
  // Returns 404 even if the piece exists but belongs to another user
  // — leaks nothing about whether the id exists at all.
  const owns = await c.env.DB
    .prepare("SELECT id FROM teaching_pieces WHERE id = ? AND user_id = ?")
    .bind(pieceId, user.userId)
    .first<{ id: string }>();
  if (!owns) return c.json({ error: "Piece not found" }, 404);

  const trail = await loadTrail(c.env.DB, user.userId, "piece", pieceId);
  if (!trail) {
    // Piece predates the audit feature (or audit silently failed
    // before the failure-row write succeeded). Return an empty trail
    // so the frontend can render a "no audit available" state
    // without a second round trip.
    return c.json({
      target_kind: "piece" as const,
      target_id: pieceId,
      passes: [],
    });
  }
  return c.json(trail);
});

pieceAuditRoutes.get("/piece/:id/deep-dive/audit", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");
  const owns = await c.env.DB
    .prepare("SELECT id FROM teaching_pieces WHERE id = ? AND user_id = ?")
    .bind(pieceId, user.userId)
    .first<{ id: string }>();
  if (!owns) return c.json({ error: "Piece not found" }, 404);

  const trail = await loadTrail(c.env.DB, user.userId, "deep_dive", pieceId);
  if (!trail) {
    return c.json({
      target_kind: "deep_dive" as const,
      target_id: pieceId,
      passes: [],
    });
  }
  return c.json(trail);
});
