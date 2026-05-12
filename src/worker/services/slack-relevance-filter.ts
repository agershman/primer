/**
 * Slack relevance pre-filter — drops banter, off-topic personal chatter,
 * and irrelevant noise from the work-context list **before** it lands in
 * concept extraction or the briefing's work-context bar.
 *
 * Why this exists: the Slack source's existing pre-filters
 * (`isNoiseMessage`, the 30-char / 2-message floor, the "lone emoji"
 * regex) are length- and pattern-based — they catch one-line acks but
 * miss substantive-looking lines that are still off-topic for the
 * reader (think: "msft makes good dev tools. that is it" or "Justin
 * Bieber, Justin Beaver :laughing:"). Those lines are perfectly valid
 * English and clear the heuristics, then leak into the briefing.
 *
 * The fix is a small batched LLM call that scores each Slack thread
 * 0.0–1.0 against the user's About + Focus + global filterPrompt, and
 * drops anything below the threshold. Bookmarked threads (carrying
 * `item.bookmarked === true` — set by `slack.ts` for any thread with
 * a `:bookmark:` reaction) bypass the filter entirely because the
 * user has explicitly opted them in.
 *
 * Mirrors the prompt + bucket shape of `adjacent-scanner.ts` so future
 * generalization to other source types (Linear, GitHub, etc.) can fold
 * back into a shared scorer if needed.
 *
 * Cost: one Haiku call per briefing (a single batched JSON call over
 * up to ~20 threads); fail-open semantics — any error returns the
 * input unchanged so a flaky LLM call can't strip the user's whole
 * Slack work context.
 */

import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";
import type { WorkContextItem } from "../sources/index.js";

export interface SlackFilterOptions {
  /** Resolved model spec for the scoring call. Defaults to the catalog
   *  entry for `adjacentScoring` (Haiku 4.5 today) when omitted —
   *  same conceptual operation as scoring feed items for relevance. */
  modelSpec?: ModelSpec;
  /** "About me" persona — the strongest signal for what counts as
   *  on-topic vs. banter. */
  aboutStatement?: string | null;
  /** "Focus" statement — biases scoring toward currently-prioritized
   *  topics (a thread about Postgres replication is probably more
   *  interesting to someone whose Focus says "database scaling" than
   *  to a frontend reader). */
  focusStatement?: string | null;
  /** Global AI filter prompt. When set, applied as an additional
   *  criterion. Per-source overrides under `signalSurfaceMap.sourceFilterOverrides.slack`
   *  REPLACE this for the Slack bucket — same semantics as
   *  `adjacent-scanner` and `concept-extractor`. */
  filterPrompt?: string | null;
  /** Drop threshold. Defaults to 0.4 — same number as
   *  `RELEVANCE_THRESHOLD` so users tuning that one knob get
   *  consistent behavior across feed scoring and Slack filtering. */
  threshold?: number;
}

export interface DroppedSlackThread {
  id: string;
  title: string;
  score: number;
  reason: string;
}

export interface SlackFilterResult {
  /** Original `items` array minus any Slack threads that scored below
   *  the threshold. Non-Slack items pass through unchanged. */
  kept: WorkContextItem[];
  /** Slack threads that were dropped + why. Useful for analytics
   *  ("we filtered 3 noisy threads") and debugging. */
  dropped: DroppedSlackThread[];
  /** Slack thread count *before* filtering, for the briefing-pipeline
   *  progress label. */
  totalSlackCount: number;
  /** Slack thread count *after* filtering. */
  keptSlackCount: number;
  /** The model that ran the scoring call, for analytics attribution. */
  modelUsed: string;
  /** True when the LLM call failed and we fell open — caller can log
   *  this as a soft error without losing the work context. */
  failedOpen: boolean;
}

function defaultSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.adjacentScoring);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.adjacentScoring };
}

/**
 * Filter Slack threads in `items` against the user's About + Focus +
 * filter prompt. Bookmarked threads (`item.bookmarked === true`)
 * bypass scoring. Non-Slack items pass through unchanged.
 *
 * Returns the filtered items plus a per-dropped-thread reason list.
 * Fail-open: any LLM error returns the input unchanged with
 * `failedOpen: true` so the briefing pipeline never collapses on a
 * scoring outage.
 */
export async function filterSlackByRelevance(
  llm: LLMClient,
  db: D1Database,
  userId: string,
  items: WorkContextItem[],
  options: SlackFilterOptions = {},
): Promise<SlackFilterResult> {
  const spec = options.modelSpec ?? defaultSpec();
  const threshold = options.threshold ?? 0.4;

  const slackItems = items.filter((i) => i.type === "slack_thread");
  const totalSlackCount = slackItems.length;

  if (slackItems.length === 0) {
    return {
      kept: items,
      dropped: [],
      totalSlackCount: 0,
      keptSlackCount: 0,
      modelUsed: spec.model,
      failedOpen: false,
    };
  }

  // Bookmarked threads bypass — the user explicitly flagged them
  // with a `:bookmark:` reaction, which is a strong opt-in signal.
  // Treating that as overriding our LLM relevance pass matches how
  // the noise / brevity filters are bypassed for bookmarked content
  // in `slack.ts`.
  const bookmarked = slackItems.filter((i) => i.bookmarked);
  const candidates = slackItems.filter((i) => !i.bookmarked);

  if (candidates.length === 0) {
    return {
      kept: items,
      dropped: [],
      totalSlackCount,
      keptSlackCount: bookmarked.length,
      modelUsed: spec.model,
      failedOpen: false,
    };
  }

  const aboutBlock = options.aboutStatement?.trim()
    ? `\nABOUT THE READER (the strongest signal — banter unrelated to who they are scores low):\n${options.aboutStatement.trim()}\n`
    : "";

  const focusBlock = options.focusStatement?.trim()
    ? `\nUSER'S CURRENT FOCUS (threads intersecting these areas should score higher):\n${options.focusStatement.trim()}\n`
    : "";

  const filterBlock = options.filterPrompt?.trim()
    ? `\nRELEVANCE FILTER (apply as additional criteria — items that don't match should score lower):\n${options.filterPrompt.trim()}\n`
    : "";

  // The core instruction — calibrate the model toward "drop social
  // chatter, keep substantive technical / work content". Anchored
  // examples taken from real low-signal Slack content the user
  // flagged: idle banter, name jokes, personal logistics. We keep
  // the rubric explicit so the threshold is interpretable.
  const system = `You score Slack threads for relevance to a user's daily learning briefing.
${aboutBlock}${focusBlock}${filterBlock}
Score each thread 0.0 to 1.0:
- 0.0–0.2: Off-topic banter, social chatter, jokes, personal logistics, generic compliments. ("msft makes good dev tools", "Justin Bieber jokes", "I'm about to sit down with my kid")
- 0.3–0.5: Borderline — some substance but tangential to the user's stated About / Focus.
- 0.6–0.8: Substantive technical or work content that aligns with the user's About + Focus.
- 0.9–1.0: Highly on-topic — direct, substantive, would meaningfully inform a teaching piece.

Bias toward DROPPING marginal items. The user already filters by channel — anything noise-level here is wasted attention.

Return JSON: { "scores": [{"index": 0, "score": 0.7, "reason": "<short phrase>"}] }
Include EVERY thread, even ones below threshold (we drop client-side).`;

  const itemList = candidates
    .map((item, i) => {
      const desc = item.description ? ` — ${item.description.slice(0, 200)}` : "";
      return `[${i}] ${item.title}${desc}`;
    })
    .join("\n");

  const userMessage = `THREADS:\n${itemList}`;

  try {
    const { result, usage } = await llm.generateJson<{
      scores: Array<{ index: number; score: number; reason: string }>;
    }>({ spec, system, user: userMessage });

    await recordTokenUsage(db, userId, "slack_relevance_filter", spec, usage);

    const scoreByIndex = new Map<number, { score: number; reason: string }>();
    for (const s of result.scores ?? []) {
      if (typeof s.index === "number" && typeof s.score === "number") {
        scoreByIndex.set(s.index, { score: s.score, reason: s.reason ?? "" });
      }
    }

    const keptCandidates: WorkContextItem[] = [];
    const dropped: DroppedSlackThread[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const scored = scoreByIndex.get(i);
      if (!scored) {
        // Unscored — fail-open per item: keep the thread rather than
        // silently drop a thread the model just forgot to mention.
        keptCandidates.push(c);
        continue;
      }
      if (scored.score >= threshold) {
        keptCandidates.push(c);
      } else {
        dropped.push({
          id: c.id,
          title: c.title,
          score: scored.score,
          reason: scored.reason,
        });
      }
    }

    const keptSlack = new Set([...bookmarked, ...keptCandidates].map((i) => i.id));
    const kept = items.filter((i) => i.type !== "slack_thread" || keptSlack.has(i.id));

    return {
      kept,
      dropped,
      totalSlackCount,
      keptSlackCount: keptSlack.size,
      modelUsed: spec.model,
      failedOpen: false,
    };
  } catch (err) {
    // Fail-open: never let a scoring outage strip the user's Slack
    // work context. Surface the failure for logs but pass the input
    // through unchanged.
    console.error("[slack-relevance-filter] LLM scoring failed; passing items through:", err);
    return {
      kept: items,
      dropped: [],
      totalSlackCount,
      keptSlackCount: totalSlackCount,
      modelUsed: spec.model,
      failedOpen: true,
    };
  }
}
