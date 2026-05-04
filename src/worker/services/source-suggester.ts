import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec, NormalizedUsage } from "../integrations/llm/types.js";

/**
 * AI-driven source-instance suggester.
 *
 * Given the user's About + Focus + the sources already configured,
 * Claude proposes a small set of RSS feeds that match the user's
 * interests. The output is intentionally conservative: well-known
 * publishers only, no fan blogs / personal sites we can't expect to
 * be alive next year, no GitHub user-feed firehoses.
 *
 * The suggester is the *primary* way admins populate the feed list
 * on a fresh deploy. There's no baked-in starter pack — a platform
 * engineer running it will land HN, CNCF, ArXiv, Kubernetes Blog,
 * Cloudflare Blog, etc.; a sales lead will land SaaStr, First Round
 * Review, OpenView, etc. Each is a one-click "Add" card; the
 * suggester won't duplicate sources already configured.
 *
 * Output shape: a flat list of `{label, url, kind, rationale}`. The
 * UI shows them as one-click "Add" cards with the rationale visible
 * as a tooltip.
 */

export interface SourceSuggestion {
  label: string;
  /** RSS feed URL. We tell the LLM to verify this is a real feed,
   *  but obviously can't enforce that without a fetch. The settings
   *  panel does a HEAD request before persisting. */
  url: string;
  /** Source kind. The model is instructed to use 'rss' unless it's
   *  proposing an HN-flavoured feed (rare). */
  kind: "rss" | "hn";
  /** One-sentence "why this matches your persona" explanation that
   *  becomes the `origin_note` on the persisted row. */
  rationale: string;
  /** Hint to the consumer: what kind of content to expect. We map
   *  these to the existing adjacent-source `source_type` enum. */
  contentType: "blog" | "release_notes" | "podcast" | "newsletter" | "other";
}

export interface SuggestSourceInstancesOptions {
  /** Resolved model spec for this operation. Defaults to the catalog
   *  entry for `adjacentScoring` when omitted. */
  modelSpec?: ModelSpec;
  aboutStatement?: string | null;
  focusStatement?: string | null;
  /** Sources the user already has (label or URL). The LLM is told
   *  to NOT propose duplicates so the suggestion list is always
   *  actionable. */
  existingSourceKeys?: string[];
  /** Cap on suggestions. Default 8 — fewer than 5 feels useless,
   *  more than 10 turns into a homework assignment. */
  limit?: number;
}

function defaultSuggestSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.adjacentScoring);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.adjacentScoring };
}

export async function suggestSourceInstances(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  options: SuggestSourceInstancesOptions = {},
): Promise<SourceSuggestion[]> {
  const limit = options.limit ?? 8;
  const spec = options.modelSpec ?? defaultSuggestSpec();
  const about = options.aboutStatement?.trim() ?? "";
  const focus = options.focusStatement?.trim() ?? "";
  const existing = options.existingSourceKeys ?? [];

  const aboutBlock = about
    ? `\nABOUT THE READER:\n${about}\n`
    : "\n(No About statement on file. Suggest broadly applicable engineering / product feeds.)\n";
  const focusBlock = focus ? `\nCURRENT FOCUS:\n${focus}\n` : "";
  const existingBlock =
    existing.length > 0
      ? `\nALREADY-CONFIGURED SOURCES (do NOT suggest these or near-duplicates):\n${existing.map((e) => `- ${e}`).join("\n")}\n`
      : "";

  const system = `You suggest content feeds (RSS, Atom, or Hacker News flavours) for a single technical
reader. The reader will use these to broaden their daily learning briefing beyond their immediate work.

Bias toward:
  - WELL-KNOWN, LONG-LIVED publishers (vendor blogs, conference proceedings, established newsletters,
    canonical engineering blogs at major companies).
  - URLs you are confident actually exist as RSS/Atom feeds. Most major engineering blogs publish
    one at /feed, /rss, or /feed.xml. NEVER guess a feed URL — only return feeds you have high
    confidence are real.
  - Variety across content types (blog, release_notes, podcast, newsletter) so the user gets a mix.

DO NOT propose:
  - Personal blogs or fan sites you can't verify are still active.
  - Generic news aggregators or vague "tech news" feeds.
  - Sources already in the user's list (see below).
  - Anything you'd rate below 0.5 confidence on the URL being correct.

Return at most ${limit} suggestions. Fewer is fine if the user's persona is narrow.

Output JSON with this exact shape (no other keys, no prose):
{
  "suggestions": [
    {
      "label": "Display name for the feed",
      "url": "https://example.com/feed",
      "kind": "rss" | "hn",
      "rationale": "One-sentence reason this matches the reader's persona.",
      "contentType": "blog" | "release_notes" | "podcast" | "newsletter" | "other"
    }
  ]
}`;

  const userMessage = `Suggest ${limit} content feeds for this reader.${aboutBlock}${focusBlock}${existingBlock}`;

  let result: { suggestions?: SourceSuggestion[] };
  let usage: NormalizedUsage;
  try {
    const response = await llm.generateJson<{ suggestions?: SourceSuggestion[] }>({
      spec,
      system,
      user: userMessage,
    });
    result = response.result;
    usage = response.usage;
  } catch (err) {
    console.warn("[source-suggester] LLM call failed:", err);
    return [];
  }

  await recordTokenUsage(db, userId, "ecosystem_suggest", spec, usage);

  const raw = Array.isArray(result.suggestions) ? result.suggestions : [];
  // Defensive normalisation — drop suggestions that are missing
  // required fields, or whose URL is obviously bogus. We don't fetch
  // the URL here (that lives in the route handler), but a non-URL
  // pattern is a clear signal the LLM hallucinated.
  const cleaned: SourceSuggestion[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.label !== "string" || s.label.trim().length === 0) continue;
    if (typeof s.url !== "string" || !/^https?:\/\//.test(s.url)) continue;
    const kind = s.kind === "hn" ? "hn" : "rss";
    const contentType =
      s.contentType === "release_notes" ||
      s.contentType === "podcast" ||
      s.contentType === "newsletter" ||
      s.contentType === "blog" ||
      s.contentType === "other"
        ? s.contentType
        : "other";
    cleaned.push({
      label: s.label.trim(),
      url: s.url.trim(),
      kind,
      rationale: typeof s.rationale === "string" ? s.rationale.trim() : "",
      contentType,
    });
  }
  return cleaned.slice(0, limit);
}
