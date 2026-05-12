/**
 * Two-pass content auditor with a hosted-web-search backstop.
 *
 * What it does
 * ------------
 * Runs after every generator (teaching pieces, deep dives, calibration
 * quizzes) and classifies every factual sentence in the draft as
 * `grounded`, `unsupported`, or `hallucinated` against the source
 * bundle the writer was handed. Un-cited flagged claims optionally get
 * a web-search backstop (verdict can upgrade to `grounded-web`).
 * Remaining flagged spans are either patched (rewritten to a defensible
 * weaker form) or dropped (when no patch holds). Pass 2 re-audits
 * patched spans against local sources and drops any still-flagged.
 *
 * Fail-open
 * ---------
 * Any thrown LLM error in pass 1 or pass 2 returns the ORIGINAL
 * content unchanged and records one `audits` row with `status='failed'`.
 * Same pattern as the continuation classifier — the pipeline must
 * never lose a piece because the audit had a bad day.
 *
 * Span addressing
 * ---------------
 * `block_index` indexes the target `ContentBlock[]`. Offsets are
 * positions inside the block's `value` string. Only `text` and
 * `heading` blocks contribute claims (code/diagram blocks are
 * literal source material). Patches are applied right-to-left within
 * each block so offsets within the same block stay stable.
 *
 * See dev-docs/adrs/0006-content-audit.md for the design decisions.
 */

import { genId, recordTokenUsage } from "../db/queries.js";
import type {
  AuditClaim,
  AuditResolution,
  AuditSummary,
  AuditTargetKind,
  AuditTrail,
  AuditVerdict,
  ContentBlock,
  WebEvidence,
} from "../types.js";
import { checkClaimWithWebSearch, supportsWebSearch } from "../integrations/web-search.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";

/**
 * Subset of `SourceDescriptor` the auditor actually needs. Kept narrow
 * so callers can pass anything that looks source-like (work-context
 * items, deep-dive parent sources, adjacent articles) without
 * structural coupling.
 */
export interface AuditSource {
  type: string;
  id?: string;
  title?: string;
  url?: string;
  summary?: string;
}

export interface AuditContentArgs {
  db: D1Database;
  userId: string;
  llm: LLMClient;
  targetKind: AuditTargetKind;
  targetId: string;
  content: ContentBlock[];
  sources: AuditSource[];
  auditSpec: ModelSpec;
  patchSpec: ModelSpec;
  /**
   * When false, the web-search backstop is skipped even on un-cited
   * flagged claims. Used by callers that want a fast/cheap audit
   * (e.g. an admin retry path) or when the audit model doesn't
   * support hosted web search. Defaults to true when omitted at the
   * thin-wrapper call sites.
   */
  enableWebSearch?: boolean;
}

export interface AuditContentResult {
  /** Post-patch / post-drop content. When `audit.status === 'failed'`
   *  this is the unchanged input. */
  content: ContentBlock[];
  audit: AuditSummary;
  trail: AuditTrail;
}

interface RawClaim {
  block_index: number;
  span_start: number;
  span_end: number;
  claim_text: string;
  verdict: AuditVerdict;
  cited_refs: string[];
  reasoning: string;
}

interface ResolvedClaim extends RawClaim {
  id: string;
  resolution: AuditResolution | null;
  patched_text: string | null;
  web_evidence: WebEvidence[] | null;
}

interface PatchDecision {
  kind: "rewrite" | "drop";
  text?: string;
}

const CLEAN_RESOLUTIONS: Set<AuditVerdict> = new Set(["grounded", "grounded-web"]);

/**
 * Build the enrichment-id allowlist for a source bundle. Mirrors the
 * `${type}:${id}` convention writers use in `[[ref:...]]` tags. Sources
 * without a stable id fall back to their URL (matches the deep-dive +
 * adjacent flows where the URL is the natural primary key).
 */
function allowedRefs(sources: AuditSource[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const key = s.id ?? s.url;
    if (!key) continue;
    out.push(`${s.type}:${key}`);
  }
  return out;
}

function summarizeSourcesForPrompt(sources: AuditSource[]): string {
  if (sources.length === 0) return "(no source bundle for this content)";
  return sources
    .map((s) => {
      const key = s.id ?? s.url ?? "(unknown)";
      const title = s.title ?? "(untitled)";
      const summary = s.summary ? `\n     ${s.summary.slice(0, 300)}` : "";
      return `- ${s.type}:${key} — ${title}${summary}`;
    })
    .join("\n");
}

/**
 * Pass-1 classification call. Returns one record per factual sentence
 * the model identified in the block.
 *
 * The auditor is given the FULL block text + the source bundle and
 * the allowed ref list. It MUST emit offsets that index into the
 * block's `value` string (we validate + clip them on receipt).
 */
async function classifyBlock(
  llm: LLMClient,
  spec: ModelSpec,
  block: ContentBlock,
  blockIndex: number,
  sources: AuditSource[],
): Promise<{ claims: RawClaim[]; usage: { inputTokens: number; outputTokens: number } }> {
  const allowed = allowedRefs(sources);
  const system =
    "You are an editorial auditor. Read the passage and the source bundle, then identify every factual claim. " +
    "Classify each claim as exactly one of:\n" +
    "  - grounded: the source bundle directly supports the claim.\n" +
    "  - unsupported: the claim is plausible but the source bundle does NOT speak to it.\n" +
    "  - hallucinated: the claim appears to be invented or contradicts the sources.\n\n" +
    "Rules:\n" +
    "  - Only emit claims for sentences that make a verifiable factual assertion. Skip framing, transitions, and opinions.\n" +
    "  - Offsets MUST index into the passage's `text` string (start = first character of the claim, end = one past the last character — half-open [start, end)).\n" +
    "  - `cited_refs` MUST be drawn from the allowed list; any other value is invalid.\n" +
    "  - When the passage contains inline `[[ref:<id>]]` markers right after a sentence, treat that as the writer's claim of citation and check whether the matching source actually supports it.\n";

  const user = JSON.stringify({
    passage: {
      type: block.type,
      text: block.value,
    },
    allowed_refs: allowed,
    sources_summary: summarizeSourcesForPrompt(sources),
    response_schema: {
      claims: [
        {
          span_start: 0,
          span_end: 0,
          claim_text: "",
          verdict: "grounded | unsupported | hallucinated",
          cited_refs: ["..."],
          reasoning: "one short sentence",
        },
      ],
    },
  });

  const { result, usage } = await llm.generateJson<{ claims: Array<Partial<RawClaim>> }>({
    spec,
    system,
    user,
  });

  const allowedSet = new Set(allowed);
  const blockLen = block.value.length;
  const claims: RawClaim[] = [];
  for (const raw of result.claims ?? []) {
    const start = Math.max(0, Math.min(blockLen, Number(raw.span_start ?? 0)));
    const end = Math.max(start, Math.min(blockLen, Number(raw.span_end ?? start)));
    if (end <= start) continue;
    const verdict = (raw.verdict ?? "grounded") as AuditVerdict;
    if (!["grounded", "unsupported", "hallucinated"].includes(verdict)) continue;
    // Drop refs the auditor invented; keep ones from the allowlist.
    const refs = (raw.cited_refs ?? []).filter((r): r is string => typeof r === "string" && allowedSet.has(r));
    claims.push({
      block_index: blockIndex,
      span_start: start,
      span_end: end,
      claim_text: block.value.slice(start, end),
      verdict,
      cited_refs: refs,
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
    });
  }
  return {
    claims,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}

/**
 * Single-claim patch call. Returns either a rewrite that the calling
 * loop will substitute in place, or a drop signal that removes the
 * span entirely.
 */
async function patchClaim(
  llm: LLMClient,
  spec: ModelSpec,
  block: ContentBlock,
  claim: RawClaim,
  sources: AuditSource[],
  webEvidence: WebEvidence[] | null,
): Promise<{ decision: PatchDecision; usage: { inputTokens: number; outputTokens: number } }> {
  const system =
    "You rewrite a single sentence in a teaching piece so the surviving text is defensible against the supplied sources. " +
    "You MUST either:\n" +
    '  - rewrite: produce a shorter, qualified, source-anchored version (e.g. "Some teams report..." instead of "Most teams report..."). The rewrite stands in for ONLY the flagged span; do not rewrite the surrounding paragraph.\n' +
    "  - drop: signal that no truthful rewrite is possible and the span should be removed.\n\n" +
    "Match the voice and rhythm of the surrounding paragraph. Do NOT introduce new factual claims that the sources do not support. " +
    "Do NOT add new citations. If the sources don't cover it, drop the span.";

  const user = JSON.stringify({
    paragraph: block.value,
    flagged_span: {
      start: claim.span_start,
      end: claim.span_end,
      text: claim.claim_text,
    },
    why_flagged: claim.reasoning,
    sources_summary: summarizeSourcesForPrompt(sources),
    web_evidence: webEvidence ?? [],
    response_schema: {
      decision: 'rewrite | drop',
      text: 'new text for the span (only if decision="rewrite")',
    },
  });

  const { result, usage } = await llm.generateJson<{ decision: string; text?: string }>({
    spec,
    system,
    user,
  });

  if (result.decision === "rewrite" && typeof result.text === "string" && result.text.trim().length > 0) {
    return {
      decision: { kind: "rewrite", text: result.text },
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    };
  }
  return {
    decision: { kind: "drop" },
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}

/**
 * Apply the resolved per-block claim list to the block, right-to-left
 * so offsets within the block don't shift mid-update.
 *
 * Returns the post-patch block AND an updated claim list with
 * `resolution` + `patched_text` filled in. `kept` for grounded /
 * grounded-web (verdict didn't trigger a patch), `patched` for
 * spans that got a rewrite, `dropped` for spans removed entirely.
 */
function applyResolutions(
  block: ContentBlock,
  claims: Array<ResolvedClaim & { _patch?: PatchDecision }>,
): { block: ContentBlock; claims: ResolvedClaim[] } {
  let text = block.value;
  // Sort descending by span_start so we splice from the end first.
  const ordered = [...claims].sort((a, b) => b.span_start - a.span_start);
  const updated: ResolvedClaim[] = [];

  for (const c of ordered) {
    if (CLEAN_RESOLUTIONS.has(c.verdict)) {
      updated.push({ ...c, resolution: "kept" });
      continue;
    }
    const patch = c._patch;
    if (!patch) {
      // No patch decision was produced (verdict still unsupported but
      // we ran out of budget or the patch step threw). Drop to keep
      // the piece defensible.
      text = text.slice(0, c.span_start) + text.slice(c.span_end);
      updated.push({ ...c, resolution: "dropped", patched_text: null });
      continue;
    }
    if (patch.kind === "drop") {
      text = text.slice(0, c.span_start) + text.slice(c.span_end);
      updated.push({ ...c, resolution: "dropped", patched_text: null });
    } else if (patch.kind === "rewrite") {
      const newText = patch.text ?? "";
      text = text.slice(0, c.span_start) + newText + text.slice(c.span_end);
      updated.push({ ...c, resolution: "patched", patched_text: newText });
    }
  }

  // Restore original (ascending) order for the persisted claim list.
  updated.sort((a, b) => a.span_start - b.span_start);
  return { block: { ...block, value: text }, claims: updated };
}

function summaryFromClaims(
  status: AuditSummary["status"],
  claims: ResolvedClaim[],
  auditModel: string,
  patchModel: string | null,
  usedWebSearch: boolean,
): AuditSummary {
  let unsupported = 0;
  let hallucinated = 0;
  let groundedWeb = 0;
  let patched = 0;
  let dropped = 0;
  for (const c of claims) {
    if (c.verdict === "unsupported") unsupported++;
    else if (c.verdict === "hallucinated") hallucinated++;
    else if (c.verdict === "grounded-web") groundedWeb++;
    if (c.resolution === "patched") patched++;
    else if (c.resolution === "dropped") dropped++;
  }
  return {
    status,
    audit_model: auditModel,
    patch_model: patchModel,
    used_web_search: usedWebSearch,
    total_claims: claims.length,
    unsupported_count: unsupported,
    hallucinated_count: hallucinated,
    grounded_web_count: groundedWeb,
    patched_count: patched,
    dropped_count: dropped,
  };
}

/**
 * Persist one `audits` row + its child `audit_claims` rows.
 * Atomic-ish via D1's batch — pass-1 and pass-2 each get their own
 * batch so a pass-2 write failure doesn't roll back pass-1.
 */
async function persistAudit(
  db: D1Database,
  args: {
    userId: string;
    targetKind: AuditTargetKind;
    targetId: string;
    pass: 1 | 2;
    summary: AuditSummary;
    claims: ResolvedClaim[];
    durationMs: number;
  },
): Promise<string> {
  const auditId = genId("audit");
  const auditStmt = db
    .prepare(
      `INSERT INTO audits (
        id, user_id, target_kind, target_id, pass, status, audit_model, patch_model,
        used_web_search, total_claims, unsupported_count, hallucinated_count,
        grounded_web_count, patched_count, dropped_count, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(
      auditId,
      args.userId,
      args.targetKind,
      args.targetId,
      args.pass,
      args.summary.status,
      args.summary.audit_model,
      args.summary.patch_model,
      args.summary.used_web_search ? 1 : 0,
      args.summary.total_claims,
      args.summary.unsupported_count,
      args.summary.hallucinated_count,
      args.summary.grounded_web_count,
      args.summary.patched_count,
      args.summary.dropped_count,
      args.durationMs,
    );

  const claimStmts = args.claims.map((c) =>
    db
      .prepare(
        `INSERT INTO audit_claims (
          id, audit_id, block_index, span_start, span_end, claim_text, verdict,
          cited_refs, web_evidence, reasoning, resolution, patched_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .bind(
        c.id,
        auditId,
        c.block_index,
        c.span_start,
        c.span_end,
        c.claim_text,
        c.verdict,
        JSON.stringify(c.cited_refs),
        c.web_evidence ? JSON.stringify(c.web_evidence) : null,
        c.reasoning,
        c.resolution,
        c.patched_text,
      ),
  );

  await db.batch([auditStmt, ...claimStmts]);
  return auditId;
}

function auditableBlocks(content: ContentBlock[]): Array<{ block: ContentBlock; index: number }> {
  const out: Array<{ block: ContentBlock; index: number }> = [];
  content.forEach((block, index) => {
    if (block.type === "text" || block.type === "heading") {
      out.push({ block, index });
    }
  });
  return out;
}

/**
 * Public entry point. Most callers should use one of the thin
 * wrappers (`auditPiece`, `auditDeepDive`, `auditQuiz`) below — they
 * pin the `targetKind` and the operation tags for cost accounting.
 */
export async function auditContent(args: AuditContentArgs): Promise<AuditContentResult> {
  const startedAt = Date.now();
  const enableWebSearch = args.enableWebSearch !== false && supportsWebSearch(args.auditSpec);
  const opOperation = operationTagFor(args.targetKind);
  const patchOperation = "piece_audit_patch";
  const webSearchOperation = "piece_audit_websearch";

  try {
    // ── Pass 1: classify per block ──
    const passOneClaims: ResolvedClaim[] = [];
    const blockTexts = new Map<number, string>(); // post-patch text per block
    const blocks = auditableBlocks(args.content);
    for (const { block, index } of blocks) {
      blockTexts.set(index, block.value);
      const { claims, usage } = await classifyBlock(args.llm, args.auditSpec, block, index, args.sources);
      await recordTokenUsage(args.db, args.userId, opOperation, args.auditSpec, usage);
      // Attach a stable id to each claim before web-search/patch so
      // the popover lookup works after persistence.
      for (const c of claims) {
        passOneClaims.push({
          ...c,
          id: genId("auditClaim"),
          resolution: null,
          patched_text: null,
          web_evidence: null,
        });
      }
    }

    // ── Web-search backstop ──
    let usedWebSearch = false;
    if (enableWebSearch && passOneClaims.length > 0) {
      for (const claim of passOneClaims) {
        if (claim.verdict !== "unsupported" && claim.verdict !== "hallucinated") continue;
        if (claim.cited_refs.length > 0) continue; // gate: only check un-cited claims
        try {
          const { citations, verdictText, usage } = await checkClaimWithWebSearch(
            args.llm,
            args.auditSpec,
            claim.claim_text,
            // Pass the WHOLE block as disambiguation context — keeps
            // pronouns and continued references readable.
            blockTexts.get(claim.block_index) ?? claim.claim_text,
          );
          await recordTokenUsage(args.db, args.userId, webSearchOperation, args.auditSpec, usage);
          usedWebSearch = true;
          if (citations.length > 0 && /\bSUPPORTED\b/i.test(verdictText) && !/NOT_SUPPORTED/i.test(verdictText)) {
            claim.verdict = "grounded-web";
            claim.web_evidence = citations.map((c) => ({ url: c.url, title: c.title, snippet: c.snippet }));
            claim.cited_refs = [...new Set([...claim.cited_refs, ...citations.map((c) => c.url)])];
          }
        } catch (err) {
          console.warn("[piece-auditor] web-search step failed; leaving verdict unchanged:", err);
        }
      }
    }

    // ── Patch flagged spans ──
    type PatchedClaim = ResolvedClaim & { _patch?: PatchDecision };
    const patchedClaims: PatchedClaim[] = passOneClaims.map((c) => ({ ...c }));
    for (const claim of patchedClaims) {
      if (claim.verdict !== "unsupported" && claim.verdict !== "hallucinated") continue;
      try {
        const targetBlock = args.content[claim.block_index];
        if (!targetBlock) continue;
        const { decision, usage } = await patchClaim(
          args.llm,
          args.patchSpec,
          targetBlock,
          claim,
          args.sources,
          claim.web_evidence,
        );
        await recordTokenUsage(args.db, args.userId, patchOperation, args.patchSpec, usage);
        claim._patch = decision;
      } catch (err) {
        console.warn("[piece-auditor] patch step failed; dropping span:", err);
        claim._patch = { kind: "drop" };
      }
    }

    // ── Apply resolutions per block (right-to-left) ──
    const updatedContent: ContentBlock[] = [...args.content];
    const finalClaims: ResolvedClaim[] = [];
    const claimsByBlock = new Map<number, PatchedClaim[]>();
    for (const c of patchedClaims) {
      const list = claimsByBlock.get(c.block_index) ?? [];
      list.push(c);
      claimsByBlock.set(c.block_index, list);
    }
    for (const [blockIndex, blockClaims] of claimsByBlock.entries()) {
      const block = updatedContent[blockIndex];
      if (!block) continue;
      const { block: newBlock, claims: resolved } = applyResolutions(block, blockClaims);
      updatedContent[blockIndex] = newBlock;
      finalClaims.push(...resolved);
    }
    // Claims for blocks that had no flagged spans never enter the
    // patch loop; carry them through with resolution='kept'.
    for (const c of patchedClaims) {
      if (claimsByBlock.has(c.block_index)) continue;
      finalClaims.push({ ...c, resolution: "kept" });
    }

    const passOneStatus: AuditSummary["status"] =
      finalClaims.some((c) => c.resolution === "dropped")
        ? "dropped"
        : finalClaims.some((c) => c.resolution === "patched")
          ? "patched"
          : "clean";

    const passOneSummary = summaryFromClaims(
      passOneStatus,
      finalClaims,
      args.auditSpec.model,
      args.patchSpec.model,
      usedWebSearch,
    );
    await persistAudit(args.db, {
      userId: args.userId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      pass: 1,
      summary: passOneSummary,
      claims: finalClaims,
      durationMs: Date.now() - startedAt,
    });

    const trail: AuditTrail = {
      target_kind: args.targetKind,
      target_id: args.targetId,
      passes: [
        {
          pass: 1,
          summary: passOneSummary,
          claims: stripInternalFields(finalClaims),
        },
      ],
    };

    // ── Pass 2: re-audit patched spans ──
    const patchedSet = finalClaims.filter((c) => c.resolution === "patched");
    if (patchedSet.length > 0) {
      const passTwoStartedAt = Date.now();
      const passTwoClaims: ResolvedClaim[] = [];
      try {
        // Only audit blocks that had a patched span.
        const blockIndicesToReaudit = new Set(patchedSet.map((c) => c.block_index));
        for (const blockIndex of blockIndicesToReaudit) {
          const block = updatedContent[blockIndex];
          if (!block) continue;
          const { claims, usage } = await classifyBlock(args.llm, args.auditSpec, block, blockIndex, args.sources);
          await recordTokenUsage(args.db, args.userId, opOperation, args.auditSpec, usage);
          for (const c of claims) {
            passTwoClaims.push({
              ...c,
              id: genId("auditClaim"),
              resolution: null,
              patched_text: null,
              web_evidence: null,
            });
          }
        }
        // Drop any still-flagged spans (pass-2 fallback per spec).
        const updatedContentAfterPass2: ContentBlock[] = [...updatedContent];
        const finalPassTwoClaims: ResolvedClaim[] = [];
        const passTwoByBlock = new Map<number, ResolvedClaim[]>();
        for (const c of passTwoClaims) {
          const list = passTwoByBlock.get(c.block_index) ?? [];
          list.push(c);
          passTwoByBlock.set(c.block_index, list);
        }
        for (const [blockIndex, blockClaims] of passTwoByBlock.entries()) {
          const block = updatedContentAfterPass2[blockIndex];
          if (!block) continue;
          // For pass 2, every still-flagged claim is auto-dropped (no
          // patch retry). Grounded claims are kept as-is.
          const decorated: Array<ResolvedClaim & { _patch?: PatchDecision }> = blockClaims.map((c) =>
            CLEAN_RESOLUTIONS.has(c.verdict) ? { ...c } : { ...c, _patch: { kind: "drop" } },
          );
          const { block: newBlock, claims: resolved } = applyResolutions(block, decorated);
          updatedContentAfterPass2[blockIndex] = newBlock;
          finalPassTwoClaims.push(...resolved);
        }

        const passTwoStatus: AuditSummary["status"] = finalPassTwoClaims.some((c) => c.resolution === "dropped")
          ? "dropped"
          : "clean";

        const passTwoSummary = summaryFromClaims(
          passTwoStatus,
          finalPassTwoClaims,
          args.auditSpec.model,
          null,
          false,
        );
        await persistAudit(args.db, {
          userId: args.userId,
          targetKind: args.targetKind,
          targetId: args.targetId,
          pass: 2,
          summary: passTwoSummary,
          claims: finalPassTwoClaims,
          durationMs: Date.now() - passTwoStartedAt,
        });

        trail.passes.push({
          pass: 2,
          summary: passTwoSummary,
          claims: stripInternalFields(finalPassTwoClaims),
        });

        return { content: updatedContentAfterPass2, audit: passOneSummary, trail };
      } catch (err) {
        // Pass-2 failures don't poison pass-1's persisted result. Log
        // and return the post-pass-1 content + the pass-1 summary;
        // the UI shows "patched" without a pass-2 indication.
        console.warn("[piece-auditor] pass 2 failed; keeping pass-1 result:", err);
      }
    }

    return { content: updatedContent, audit: passOneSummary, trail };
  } catch (err) {
    console.warn("[piece-auditor] failed; returning original content unchanged:", err);
    const failedSummary: AuditSummary = {
      status: "failed",
      audit_model: args.auditSpec.model,
      patch_model: args.patchSpec.model,
      used_web_search: false,
      total_claims: 0,
      unsupported_count: 0,
      hallucinated_count: 0,
      grounded_web_count: 0,
      patched_count: 0,
      dropped_count: 0,
    };
    try {
      await persistAudit(args.db, {
        userId: args.userId,
        targetKind: args.targetKind,
        targetId: args.targetId,
        pass: 1,
        summary: failedSummary,
        claims: [],
        durationMs: Date.now() - startedAt,
      });
    } catch (writeErr) {
      console.error("[piece-auditor] failed to persist failure row:", writeErr);
    }
    return {
      content: args.content,
      audit: failedSummary,
      trail: {
        target_kind: args.targetKind,
        target_id: args.targetId,
        passes: [{ pass: 1, summary: failedSummary, claims: [] }],
      },
    };
  }
}

function operationTagFor(kind: AuditTargetKind): string {
  if (kind === "deep_dive") return "deep_dive_audit";
  if (kind === "quiz") return "quiz_audit";
  return "piece_audit";
}

function stripInternalFields(claims: ResolvedClaim[]): AuditClaim[] {
  return claims.map((c) => ({
    id: c.id,
    block_index: c.block_index,
    span_start: c.span_start,
    span_end: c.span_end,
    claim_text: c.claim_text,
    verdict: c.verdict,
    cited_refs: c.cited_refs,
    web_evidence: c.web_evidence,
    reasoning: c.reasoning,
    resolution: c.resolution,
    patched_text: c.patched_text,
  }));
}

// ── Thin wrappers for call-site clarity ──

export function auditPiece(
  args: Omit<AuditContentArgs, "targetKind" | "enableWebSearch"> & { enableWebSearch?: boolean },
): Promise<AuditContentResult> {
  return auditContent({ ...args, targetKind: "piece" });
}

export function auditDeepDive(
  args: Omit<AuditContentArgs, "targetKind" | "enableWebSearch"> & { enableWebSearch?: boolean },
): Promise<AuditContentResult> {
  return auditContent({ ...args, targetKind: "deep_dive" });
}

/**
 * Quizzes are a single text span (the question), so the caller wraps
 * it as a synthetic ContentBlock[]. Web search is the only credible
 * grounding source for a quiz question (the local source bundle is
 * empty by construction), so the wrapper forces `enableWebSearch=true`.
 */
export function auditQuiz(
  args: Omit<AuditContentArgs, "targetKind" | "enableWebSearch" | "sources"> & {
    sources?: AuditSource[];
  },
): Promise<AuditContentResult> {
  return auditContent({
    ...args,
    targetKind: "quiz",
    sources: args.sources ?? [],
    enableWebSearch: true,
  });
}
