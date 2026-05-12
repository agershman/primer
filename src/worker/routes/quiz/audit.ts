/**
 * Quiz audit-trail endpoint — `GET /quiz/:id/audit`.
 *
 * Mirrors the piece audit endpoint shape (see ../pieces/audit.ts).
 * Quizzes have a single text span (the question), so the trail
 * always has exactly one block_index=0 claim per pass when audit
 * ran successfully. Web-search-driven verdicts are common here
 * since the quiz generator has no local source bundle to ground
 * the question against.
 *
 * @see ../quiz.ts — assembly entry point
 */

import { Hono } from "hono";
import type { AuditClaim, AuditResolution, AuditVerdict, Env, UserContext, WebEvidence } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const quizAuditRoutes = new Hono<AppEnv>();

quizAuditRoutes.get("/quiz/:id/audit", async (c) => {
  const user = c.get("user");
  const quizId = c.req.param("id");

  const owns = await c.env.DB.prepare("SELECT id FROM calibration_quizzes WHERE id = ? AND user_id = ?")
    .bind(quizId, user.userId)
    .first<{ id: string }>();
  if (!owns) return c.json({ error: "Quiz not found" }, 404);

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

  const audits = await c.env.DB.prepare(
    `SELECT id, pass, status, audit_model, patch_model, used_web_search,
              total_claims, unsupported_count, hallucinated_count, grounded_web_count,
              patched_count, dropped_count
       FROM audits
       WHERE user_id = ? AND target_kind = 'quiz' AND target_id = ?
       ORDER BY pass ASC`,
  )
    .bind(user.userId, quizId)
    .all<AuditRow>();

  if (!audits.results || audits.results.length === 0) {
    return c.json({ target_kind: "quiz" as const, target_id: quizId, passes: [] });
  }

  const auditIds = audits.results.map((a) => a.id);
  const placeholders = auditIds.map(() => "?").join(",");
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
  const claims = await c.env.DB.prepare(
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

  return c.json({
    target_kind: "quiz" as const,
    target_id: quizId,
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
  });
});
