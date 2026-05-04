import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import {
  listSourceInstances,
  type SourceInstance,
  seedDefaultSourceInstancesIfEmpty,
} from "../db/source-instance-queries.js";
import type { FeedItem } from "../integrations/feeds.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";
import { sourceRegistry } from "../sources/index.js";
import type { Env } from "../types.js";

interface ConceptSummary {
  id: string;
  name: string;
  category?: string;
  depth: number;
}

interface ScoredItem {
  title: string;
  url: string;
  summary?: string;
  source: string;
  relevanceScore: number;
  relevanceConcepts: string[];
}

interface ScanResult {
  relevant: ScoredItem[];
  nearMisses: ScoredItem[];
  sourceErrors: string[];
  modelUsed: string;
}

async function safeFetch<T>(label: string, fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null };
  } catch (err) {
    console.error(`[adjacent-scanner] ${label} failed:`, err);
    return { data: null, error: label };
  }
}

export interface AdjacentScanOptions {
  /** Resolved model spec for this operation. Defaults to the catalog
   *  entry for `adjacentScoring` when omitted. */
  modelSpec?: ModelSpec;
  /** "About me" persona — informs what's actually relevant beyond raw concept overlap. */
  aboutStatement?: string | null;
  /** "Focus" statement — biases relevance scoring toward currently-prioritized topics. */
  focusStatement?: string | null;
  /** Global AI filter prompt. Applied to items whose source has no
   *  override set in `sourceFilterOverrides`. */
  filterPrompt?: string | null;
  /** Per-source override map (`{ instanceId | providerId: prompt }`).
   *  When an item's source has an entry here, that prompt REPLACES
   *  the global filter for the scoring batch the item is in. Lets
   *  users set "for CNCF Blog: only operator patterns; for
   *  Cloudflare Blog: ignore product launches" without polluting the
   *  global filter. */
  sourceFilterOverrides?: Record<string, string>;
}

function defaultAdjacentSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.adjacentScoring);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.adjacentScoring };
}

/**
 * Dispatch a single configured source row to its registered provider.
 * Falls back to an error if no provider is registered for the row's kind.
 *
 * Tags every returned item with `sourceInstanceId = src.id` so the
 * scoring stage can look up per-instance filter overrides. Provider
 * fetch helpers don't know about instance ids, so we stamp them
 * here.
 */
async function fetchOneSource(
  src: SourceInstance,
  env: Env,
  db: D1Database,
  userId: string,
  llm: LLMClient,
): Promise<{
  data: FeedItem[] | null;
  error: string | null;
}> {
  const provider = sourceRegistry.get(src.kind);
  if (!provider) {
    return { data: null, error: `unknown kind: ${src.kind}` };
  }

  return safeFetch(src.label, async () => {
    const result = await provider.fetch({
      env,
      db,
      userId,
      userSettings: {},
      sourceConfig: {},
      llm,
      instanceRow: {
        id: src.id,
        kind: src.kind,
        label: src.label,
        url: src.url,
        config: src.config,
        enabled: src.enabled,
      },
    });
    const items = result.items as FeedItem[];
    return items.map((item) => ({ ...item, sourceInstanceId: src.id }));
  });
}

/**
 * Scan enabled source instances, score each item against the user's
 * active concepts (with About + Focus context), and split into
 * relevant / near-miss buckets.
 *
 * Source list is deployment-level: we read from `source_instances`
 * and dispatch each enabled row to the right fetcher. A default
 * starter set (HN + CNCF + ArXiv + AWS + GCP) is seeded on first
 * use; everything is editable through the settings panel.
 */
export async function scanAdjacentSources(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  concepts: ConceptSummary[],
  options: AdjacentScanOptions = {},
  env?: Env,
): Promise<ScanResult> {
  const aboutStatement = options.aboutStatement ?? null;
  const focusStatement = options.focusStatement ?? null;
  const globalFilter = options.filterPrompt ?? null;
  const overrides = options.sourceFilterOverrides ?? {};
  const spec = options.modelSpec ?? defaultAdjacentSpec();

  await seedDefaultSourceInstancesIfEmpty(db);

  const sources = await listSourceInstances(db, { onlyEnabled: true });
  const sourceErrors: string[] = [];

  if (sources.length === 0) {
    return { relevant: [], nearMisses: [], sourceErrors, modelUsed: spec.model };
  }

  const fetchEnv = env ?? ({} as Env);
  const fetched = await Promise.all(sources.map((src) => fetchOneSource(src, fetchEnv, db, userId, llm)));

  const allItems: FeedItem[] = [];
  for (const result of fetched) {
    if (result.data) allItems.push(...result.data);
    if (result.error) sourceErrors.push(result.error);
  }

  if (allItems.length === 0) {
    return { relevant: [], nearMisses: [], sourceErrors, modelUsed: spec.model };
  }

  // Cap concepts to the 25 most relevant (lowest depth = most learning potential)
  // to keep the scoring prompt manageable. 94 concepts + 100 items overwhelms the model.
  const cappedConcepts = [...concepts].sort((a, b) => a.depth - b.depth).slice(0, 25);
  const conceptList = cappedConcepts.map((c) => `${c.name} (${c.category ?? "general"}, depth ${c.depth})`).join("\n");

  const aboutBlock = aboutStatement
    ? `\nABOUT THE READER (use to disambiguate ambiguous matches — e.g. "Kubernetes" hits more for a platform engineer than a frontend dev):\n${aboutStatement.trim()}\n`
    : "";

  const focusBlock = focusStatement
    ? `\nUSER'S CURRENT FOCUS (boost items intersecting these areas):\n${focusStatement.trim()}\n`
    : "";

  // Group items by the filter that applies to them. Items whose
  // source instance has an override land in their own bucket; the
  // rest share a "global filter" bucket. Each unique filter becomes
  // one LLM scoring call.
  //
  // Why bucket vs. one big batch with per-item filters: keeping the
  // prompt simple — the model sees one filter and one batch — gives
  // better calibration than asking it to juggle N different filter
  // criteria across items in a single prompt. The cost is N+1
  // calls in the worst case (where N = number of distinct override
  // prompts), which is bounded by how many unique overrides the
  // user has configured. In practice 0–3.
  const buckets = new Map<string, { filter: string | null; items: FeedItem[] }>();
  const filterKeyFor = (filter: string | null): string => filter ?? "__global__";
  for (const item of allItems) {
    const override = item.sourceInstanceId ? overrides[item.sourceInstanceId] : undefined;
    const filter = override ?? globalFilter;
    const key = filterKeyFor(filter);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { filter, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
  }

  // Score each bucket with its applicable filter prompt. We keep a
  // map back to the original `allItems` index so adjacent-source
  // storage downstream still looks up against the canonical item
  // list. (Earlier code used the LLM-returned index as an offset
  // into `allItems`; we preserve that contract bucket-by-bucket via
  // the local-to-canonical mapping.)
  const relevant: ScoredItem[] = [];
  const nearMisses: ScoredItem[] = [];

  for (const bucket of buckets.values()) {
    const filterBlock = bucket.filter
      ? `\nRELEVANCE FILTER (apply as additional criteria — items that don't match should score lower):\n${bucket.filter.trim()}\n`
      : "";

    const system = `You score the relevance of external articles/items to a person's technical concept graph.
${aboutBlock}${focusBlock}${filterBlock}
Score each item from 0.0 to 1.0 based on how relevant it is to the person's active concepts AND their stated focus / persona above.
Higher scores for items that directly address concepts they're working with or learning, AND that match the user's focus and background.

Return JSON: { "scores": [{"index": 0, "score": 0.7, "concepts": ["concept-name-1"]}] }
Only include items with score >= 0.25. Omit items below that threshold entirely.`;

    const itemList = bucket.items
      .map(
        (item, i) => `[${i}] ${item.title}${item.summary ? ` — ${item.summary.slice(0, 100)}` : ""} (${item.source})`,
      )
      .join("\n");

    const userMessage = `CONCEPTS:\n${conceptList}\n\nITEMS:\n${itemList}`;

    try {
      const { result, usage } = await llm.generateJson<{
        scores: Array<{ index: number; score: number; concepts: string[] }>;
      }>({ spec, system, user: userMessage });

      await recordTokenUsage(db, userId, "adjacent_scoring", spec, usage);

      for (const scored of result.scores ?? []) {
        const item = bucket.items[scored.index];
        if (!item) continue;

        const scoredItem: ScoredItem = {
          title: item.title,
          url: item.url,
          summary: item.summary,
          source: item.source,
          relevanceScore: scored.score,
          relevanceConcepts: scored.concepts,
        };

        if (scored.score >= 0.4) {
          relevant.push(scoredItem);
        } else if (scored.score >= 0.25) {
          nearMisses.push(scoredItem);
        }
      }
    } catch (err) {
      // One bucket failing shouldn't blow up the whole scan — log
      // and surface as a soft sourceError so the briefing can still
      // ship with whatever buckets succeeded.
      console.error("[adjacent-scanner] Bucket scoring failed:", err);
      sourceErrors.push(`adjacent_scoring(${bucket.filter ? "override" : "global"})`);
    }
  }

  relevant.sort((a, b) => b.relevanceScore - a.relevanceScore);
  nearMisses.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return { relevant, nearMisses, sourceErrors, modelUsed: spec.model };
}
