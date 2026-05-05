/**
 * Focus-scorer — single-call LLM relevance ranking for teaching-target
 * candidates against the user's current focus statement.
 *
 * Why this exists: the briefing pipeline used to rank candidates only by
 * `priority` tier and `depth_score`. Once a concept was extracted (under
 * any focus statement, possibly weeks ago), it could be teaching-target
 * candidate forever — so changing the focus statement had no observable
 * effect on which concepts were taught until the user manually reset
 * their concept graph. This scorer adds a focus-aware re-rank step
 * inside each priority tier so a fresh focus statement steers
 * selection on the next briefing without needing a graph wipe.
 *
 * Design contract:
 *   - One LLM call per briefing — all candidates in a single prompt.
 *   - When `focusStatement` is null/empty, callers should skip this
 *     entirely; the function still no-ops safely if invoked.
 *   - Failure mode: any LLM/parse error returns an empty Map. Callers
 *     fall back to depth-based ordering, which is today's behavior
 *     pre-change. This keeps the briefing pipeline shipping even when
 *     the scorer has a bad day.
 *   - Scoring scale: 0.0 (orthogonal) → 1.0 (perfect intersection).
 *     Missing candidates default to 0.5 in the caller (neutral) so an
 *     incomplete LLM response doesn't punish unscored candidates.
 */

import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";

export interface FocusScorerCandidate {
  /** Stable identifier (`conceptId`, or a synthetic id for adjacent
   *  candidates without a concept). The score map keys back to this. */
  id: string;
  /** Display name for the LLM — typically the concept's canonical name
   *  or, for adjacent items without a matching concept, the article title. */
  name: string;
  /** Optional category hint (`infrastructure`, `security`, etc.) for
   *  disambiguation. */
  category?: string;
  /** One-line context the scorer can use to disambiguate ambiguous
   *  names. Caller-supplied `selectionReasoning` works well. */
  context?: string;
}

function defaultFocusScoringSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.focusScoring);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.focusScoring };
}

/**
 * Score each candidate's relevance to the user's current focus statement.
 *
 * Returns a Map<candidateId, score>. Candidates the LLM didn't score
 * are omitted — caller chooses the fallback (typical: 0.5 neutral).
 *
 * Fails open: an LLM/parse error produces an empty Map and a logged
 * warning. The caller's downstream sort still works, just without the
 * focus signal — so a transient hiccup doesn't take down briefing
 * generation.
 */
export async function scoreCandidatesAgainstFocus(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  focusStatement: string,
  candidates: FocusScorerCandidate[],
  modelSpec?: ModelSpec,
): Promise<Map<string, number>> {
  if (!focusStatement.trim() || candidates.length === 0) {
    return new Map();
  }

  const spec = modelSpec ?? defaultFocusScoringSpec();

  const candidateLines = candidates
    .map((c, i) => {
      const cat = c.category ? ` [${c.category}]` : "";
      const ctx = c.context ? ` — ${c.context.slice(0, 120)}` : "";
      return `[${i}] ${c.name}${cat}${ctx}`;
    })
    .join("\n");

  const system = `You score how relevant each candidate teaching topic is to the reader's CURRENT FOCUS.

CURRENT FOCUS:
${focusStatement.trim()}

Score each candidate from 0.0 to 1.0:
- 1.0 — directly intersects the focus; teaching this advances the reader's stated direction.
- 0.5 — adjacent / weakly related; could connect with effort.
- 0.0 — orthogonal to the focus; unrelated to what the reader is steering toward.

Be discerning — most candidates should NOT be 1.0. Reserve high scores for clear intersections.

Return JSON: { "scores": [{"index": 0, "score": 0.8}, ...] }
Include EVERY candidate by index. Omit nothing.`;

  const userMessage = `CANDIDATES:\n${candidateLines}`;

  try {
    const { result, usage } = await llm.generateJson<{
      scores: Array<{ index: number; score: number }>;
    }>({ spec, system, user: userMessage });

    await recordTokenUsage(db, userId, "focus_scoring", spec, usage);

    const map = new Map<string, number>();
    for (const scored of result.scores ?? []) {
      const candidate = candidates[scored.index];
      if (!candidate) continue;
      const clamped = Math.max(0, Math.min(1, scored.score));
      map.set(candidate.id, clamped);
    }
    return map;
  } catch (err) {
    console.warn("[focus-scorer] scoring failed; falling back to depth-only order:", err);
    return new Map();
  }
}
