import { CONTINUATION_LOOKBACK_DAYS, MAX_PREDECESSOR_CANDIDATES } from "../config/constants.js";
import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec, NormalizedUsage } from "../integrations/llm/types.js";
import type { ContentBlock } from "../types.js";

/**
 * Continuation classifier.
 *
 * Each fresh teaching-piece draft passes through this gate before it's
 * persisted. The classifier looks at a small set of recent predecessor
 * candidates and asks the LLM:
 *
 *   - NOVEL — the draft stands on its own; no meaningful overlap with
 *     any predecessor's claims. Persist as a standalone piece.
 *   - ADDITIVE_CONTINUATION — the draft genuinely builds on a specific
 *     predecessor (new movement in sources, new claims, a resolution
 *     that wasn't possible at the time of the predecessor). Persist
 *     as the next part of that predecessor's series.
 *   - REDUNDANT — the draft covers the same ground as a predecessor
 *     with no meaningfully new claims, sources, or actions. Skip
 *     emission entirely; we'll surface a "no new movement" chip in
 *     the briefing header so the user knows the topic was considered.
 *
 * Candidate selection uses a structural heuristic (concept overlap +
 * source overlap + 30-day window) to keep the LLM prompt cheap and
 * focused. Without this, every piece on a popular concept would fan
 * out into a long history of unrelated drafts.
 */

export type ContinuationClassification = "NOVEL" | "ADDITIVE_CONTINUATION" | "REDUNDANT";

export interface DraftPiece {
  title: string;
  content: ContentBlock[];
  /** Concept IDs the draft is about. Used both for predecessor recall
   *  and to give the LLM a clear signal about the draft's topic. */
  conceptIds: string[];
  /** Human-readable concept name surfaced to the LLM in the prompt
   *  (the IDs alone aren't human-meaningful). */
  conceptName: string;
  /** A subset of `SourceDescriptor` shape — only the keys the
   *  predecessor selector and classifier actually use. Keeping this
   *  narrow on purpose so the type contract is small and stable. */
  sources: Array<{
    type?: string;
    id?: string;
    title?: string;
    url?: string;
    summary?: string;
  }>;
}

/**
 * Predecessor row hydrated from the `teaching_pieces` table. Includes
 * just enough context for the classifier (title, content excerpt,
 * sources, series state) without bloating the prompt.
 */
export interface PredecessorCandidate {
  id: string;
  title: string;
  briefingDate: string;
  createdAt: string;
  conceptIds: string[];
  sources: Array<{
    type?: string;
    id?: string;
    title?: string;
    url?: string;
  }>;
  /** First ~600 chars of plain-text body, used as the LLM's signal of
   *  what the predecessor *actually said* — without this, the LLM
   *  sees only titles and tends to over-classify as continuation. */
  bodyExcerpt: string;
  seriesId: string | null;
  partNumber: number | null;
}

export interface ClassificationResult {
  classification: ContinuationClassification;
  /** Predecessor selected by the LLM. Null on NOVEL, populated on the
   *  other two outcomes (the strongest match by the LLM's assessment). */
  predecessor: PredecessorCandidate | null;
  /** One-sentence reason from the LLM. Stored on REDUNDANT entries
   *  so the briefing-header chip tooltip can show *why* we filtered. */
  reason: string;
}

interface PredecessorRow {
  id: string;
  title: string;
  briefing_date: string;
  created_at: string;
  concepts: string;
  source_context: string | null;
  content: string | null;
  series_id: string | null;
  part_number: number | null;
}

/**
 * Find recent predecessor pieces that plausibly cover the draft's
 * topic. The recall query unions two sources of overlap:
 *
 *   1. Concept overlap — any prior piece whose `concepts` JSON array
 *      contains at least one of the draft's concept IDs.
 *   2. Source overlap — any prior piece whose `source_context` JSON
 *      contains any of the draft's source IDs or URLs.
 *
 * Either signal is enough to surface a piece for the LLM to classify.
 * The LLM is the final arbiter of whether the overlap is *meaningful*
 * (continuation/redundant) or coincidental (novel despite overlap).
 *
 * Pieces older than `CONTINUATION_LOOKBACK_DAYS` are excluded — the
 * user has likely forgotten them and a callback would be jarring.
 */
export async function findCandidatePredecessors(
  db: D1Database,
  userId: string,
  draft: DraftPiece,
  lookbackDays: number = CONTINUATION_LOOKBACK_DAYS,
  limit: number = MAX_PREDECESSOR_CANDIDATES,
): Promise<PredecessorCandidate[]> {
  if (draft.conceptIds.length === 0 && draft.sources.length === 0) {
    return [];
  }

  // We pull candidates client-side and filter in JS rather than pushing
  // the JSON predicate into SQL. SQLite/D1's JSON operators are
  // available but pricier and noisier than scanning a small recent
  // window once per draft. The window is bounded by the lookback +
  // candidate cap, so cost stays predictable.
  const rows = await db
    .prepare(
      `SELECT tp.id, tp.title, b.briefing_date, tp.created_at, tp.concepts,
              tp.source_context, tp.content, tp.series_id, tp.part_number
       FROM teaching_pieces tp
       JOIN briefings b ON b.id = tp.briefing_id
       WHERE tp.user_id = ?
         AND tp.created_at >= datetime('now', ?)
       ORDER BY tp.created_at DESC
       LIMIT 100`,
    )
    .bind(userId, `-${lookbackDays} days`)
    .all<PredecessorRow>();

  const draftConceptSet = new Set(draft.conceptIds);
  // Build a set of stable source identities (id or url) for quick
  // intersection checks. We tolerate either field because different
  // source types populate them inconsistently (Linear has stable IDs,
  // adjacent articles only have URLs).
  const draftSourceKeys = new Set<string>();
  for (const src of draft.sources) {
    if (src.id) draftSourceKeys.add(`id:${src.id}`);
    if (src.url) draftSourceKeys.add(`url:${src.url}`);
  }

  const candidates: PredecessorCandidate[] = [];
  for (const row of rows.results ?? []) {
    let conceptIds: string[] = [];
    try {
      conceptIds = JSON.parse(row.concepts || "[]");
    } catch {
      /* skip */
    }

    let sources: PredecessorCandidate["sources"] = [];
    try {
      sources = JSON.parse(row.source_context || "[]");
    } catch {
      /* skip */
    }

    const conceptOverlap = conceptIds.some((id) => draftConceptSet.has(id));
    const sourceOverlap = sources.some(
      (s) => (s.id && draftSourceKeys.has(`id:${s.id}`)) || (s.url && draftSourceKeys.has(`url:${s.url}`)),
    );

    if (!conceptOverlap && !sourceOverlap) continue;

    let blocks: ContentBlock[] = [];
    try {
      blocks = JSON.parse(row.content || "[]");
    } catch {
      /* skip */
    }
    const bodyExcerpt = excerptFromBlocks(blocks, 600);

    candidates.push({
      id: row.id,
      title: row.title,
      briefingDate: row.briefing_date,
      createdAt: row.created_at,
      conceptIds,
      sources,
      bodyExcerpt,
      seriesId: row.series_id,
      partNumber: row.part_number,
    });

    if (candidates.length >= limit) break;
  }

  return candidates;
}

/**
 * Classify a draft against its candidate predecessors. Single
 * Anthropic JSON call: we want a discrete bucket and one reason
 * sentence, not free-form analysis.
 *
 * Short-circuits to NOVEL when there are no candidates — saves a
 * round trip and gives a deterministic outcome on the common case
 * (most drafts on most days have nothing to chain to).
 */
function defaultClassifierSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.continuationClassifier);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.continuationClassifier };
}

export async function classifyDraft(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  draft: DraftPiece,
  candidates: PredecessorCandidate[],
  options: { modelSpec?: ModelSpec } = {},
): Promise<ClassificationResult> {
  if (candidates.length === 0) {
    return {
      classification: "NOVEL",
      predecessor: null,
      reason: "No recent predecessors on overlapping concepts or sources.",
    };
  }

  const spec = options.modelSpec ?? defaultClassifierSpec();

  const system = `You are deciding whether a freshly drafted technical teaching piece is
  - NOVEL: stands on its own; no meaningful overlap of claims/findings with any predecessor.
  - ADDITIVE_CONTINUATION: genuinely builds on a SPECIFIC predecessor with new movement
      (new claims, new sources from a clearly later point in time, a resolution that
      wasn't possible when the predecessor was written, new code/PRs/decisions).
  - REDUNDANT: covers the same ground as a SPECIFIC predecessor with no meaningfully
      new claims, sources, or actions — basically a rewrite.

Be conservative. Lean toward NOVEL when uncertain. Only pick ADDITIVE_CONTINUATION when the
new draft would feel like Part 2 of a multi-part article, not a parallel exploration.
Only pick REDUNDANT when the new draft adds essentially nothing the predecessor didn't already say.

Respond with this exact JSON shape (no other keys, no prose):
{
  "classification": "NOVEL" | "ADDITIVE_CONTINUATION" | "REDUNDANT",
  "predecessor_id": "<id of the strongest predecessor> | null when NOVEL",
  "reason": "one sentence explaining the call"
}`;

  const draftBody = excerptFromBlocks(draft.content, 800);
  const candidateLines = candidates
    .map((c, i) => {
      const partLabel = c.seriesId && c.partNumber ? ` [series part ${c.partNumber}]` : "";
      const sourceSummary = c.sources
        .slice(0, 4)
        .map((s) => s.title || s.url || s.id || s.type || "?")
        .filter(Boolean)
        .join(" · ");
      return `[${i + 1}] id=${c.id} (${c.briefingDate})${partLabel}
Title: ${c.title}
Sources: ${sourceSummary || "—"}
Excerpt: ${c.bodyExcerpt.slice(0, 500)}`;
    })
    .join("\n\n");

  const draftSourceSummary = draft.sources
    .slice(0, 6)
    .map((s) => s.title || s.url || s.id || s.type || "?")
    .filter(Boolean)
    .join(" · ");

  const userMessage = `DRAFT (today)
Concept: ${draft.conceptName}
Title: ${draft.title}
Sources: ${draftSourceSummary || "—"}
Excerpt: ${draftBody.slice(0, 800)}

CANDIDATE PREDECESSORS (most recent first)
${candidateLines}

Decide whether the draft is NOVEL, an ADDITIVE_CONTINUATION of a specific candidate, or REDUNDANT against a specific candidate.`;

  let result: { classification: string; predecessor_id: string | null; reason: string };
  let usage: NormalizedUsage;
  try {
    const response = await llm.generateJson<{
      classification: string;
      predecessor_id: string | null;
      reason: string;
    }>({ spec, system, user: userMessage });
    result = response.result;
    usage = response.usage;
  } catch (err) {
    // Fail-open to NOVEL — when the classifier is broken we'd rather
    // have a slightly redundant briefing than a missing piece. This
    // keeps the gate from becoming an availability hazard for the
    // pipeline as a whole.
    console.warn("[continuation-classifier] LLM call failed, defaulting to NOVEL:", err);
    return {
      classification: "NOVEL",
      predecessor: null,
      reason: "Classifier failed; defaulting to standalone.",
    };
  }

  await recordTokenUsage(db, userId, "continuation_classification", spec, usage);

  const classification = normalizeClassification(result.classification);
  const predecessor =
    classification === "NOVEL" ? null : (candidates.find((c) => c.id === result.predecessor_id) ?? null);

  // If the LLM declared a continuation/redundancy but failed to point
  // at a real predecessor, demote to NOVEL — without a target row we
  // can't link a series, and silently dropping the piece would be the
  // wrong default.
  if (classification !== "NOVEL" && !predecessor) {
    return {
      classification: "NOVEL",
      predecessor: null,
      reason: "Classifier referenced an unknown predecessor; defaulting to standalone.",
    };
  }

  return {
    classification,
    predecessor,
    reason: typeof result.reason === "string" ? result.reason.trim() : "",
  };
}

function normalizeClassification(raw: string): ContinuationClassification {
  const upper = (raw || "").toUpperCase().trim();
  if (upper === "ADDITIVE_CONTINUATION" || upper === "REDUNDANT") return upper;
  return "NOVEL";
}

/**
 * Trim a piece body to a single paragraph-ish excerpt for prompt
 * context. We deliberately drop code/diagrams — they bloat the
 * prompt without telling the LLM much about whether two pieces
 * cover the same ground.
 */
function excerptFromBlocks(blocks: ContentBlock[], maxChars: number): string {
  if (!Array.isArray(blocks)) return "";
  const text = blocks
    .filter((b) => b && (b.type === "text" || b.type === "heading"))
    .map((b) => b.value || "")
    .join(" ")
    .replace(/\{\{(.+?)\|\|.+?\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + "…";
}
