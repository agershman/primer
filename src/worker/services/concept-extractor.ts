import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import {
  addConceptAlias,
  createConcept,
  findConceptByName,
  getAllConcepts,
  recordDepthChange,
  recordTokenUsage,
} from "../db/queries.js";
import type { LLMClient, ModelSpec, NormalizedUsage } from "../integrations/llm/types.js";
import { singletonSourceKey } from "../types.js";

interface WorkContextItem {
  type: string;
  id: string;
  title: string;
  url?: string;
  description?: string;
  labels?: string[];
  /** Mirrors `WorkContextItem.bookmarked` in `sources/types.ts` — set
   *  by the Slack source when the message carries a `:bookmark:`
   *  reaction. Used here to annotate the LLM prompt so the extractor
   *  relaxes its substance bar on these explicitly-opted-in items. */
  bookmarked?: boolean;
}

interface ExtractedConcept {
  name: string;
  category?: string;
  description?: string;
  aliases?: string[];
}

interface ExtractionResult {
  newConceptIds: string[];
  existingConceptIds: string[];
  usage: NormalizedUsage;
}

export interface ExtractionProgress {
  totalBatches: number;
  completedBatches: number;
  conceptsFoundSoFar: number;
}

const BATCH_SIZE = 15;

function chunk<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

function formatBatch(items: WorkContextItem[]): string {
  return items
    .map((item) => {
      // Mark bookmarked items with an explicit, machine-readable
      // sentinel the system prompt knows to look for. The 🔖 prefix
      // already lives in the title for human display, but the LLM
      // needs a distinct, named signal so it doesn't mistake the
      // glyph for incidental decoration.
      const bookmarkTag = item.bookmarked ? " [USER-BOOKMARKED]" : "";
      const desc = item.description ? `\n  ${item.description.slice(0, 300)}` : "";
      const labels = item.labels?.length ? `\n  Labels: ${item.labels.join(", ")}` : "";
      return `[${item.type}]${bookmarkTag} ${item.title}${desc}${labels}`;
    })
    .join("\n\n");
}

/**
 * Build the system prompt for concept extraction.
 *
 * Design notes — this prompt embodies four hard rules that produce a clean
 * trail view rather than a noisy bag of phrases:
 *
 *   1. SUBSTANCE BAR: a concept must be teachable as standalone subject matter.
 *      Org/process/ritual nouns are explicitly excluded.
 *   2. UMBRELLA RULE: prefer one canonical concept with variants in `aliases`
 *      over enumerating close cousins as separate concepts.
 *   3. USER FOCUS BIAS: when the user has set a focus statement, extraction
 *      is biased toward concepts intersecting that focus. Off-focus technical
 *      concepts are still allowed but should be filtered against the focus.
 *   4. SUPPRESSION RESPECT: concept names the user has explicitly suppressed
 *      are never re-extracted, period.
 */
export function buildSystemPrompt(
  existingNames: string[],
  suppressedNames: string[],
  focusStatement: string | null,
  aboutStatement: string | null = null,
  filterPrompt: string | null = null,
): string {
  const aboutBlock = aboutStatement
    ? `ABOUT THE READER — who you are extracting concepts for:
${aboutStatement.trim()}

Use this only as a secondary signal — to gauge what level of granularity makes
sense (e.g. for a senior platform engineer, "kubernetes" is one concept, not
three). The ABOUT signal NEVER overrides the FOCUS filter below.

`
    : "";

  const focusBlock = focusStatement
    ? `USER FOCUS — the person reading the resulting concepts cares about:
${focusStatement.trim()}

Strongly bias extraction toward concepts that intersect this focus. If a
concept is technically valid but clearly outside the user's focus, OMIT it.
This is the most important filter: prefer fewer, more focus-aligned concepts
over thorough but off-target coverage.

`
    : "";

  const suppressedBlock =
    suppressedNames.length > 0
      ? `DO NOT EXTRACT — the user has explicitly marked these as not interesting (suppressed). Never include them, their aliases, or close synonyms:
${suppressedNames.join(", ")}

`
      : "";

  const filterBlock = filterPrompt
    ? `RELEVANCE FILTER — the user has specified additional criteria for what matters to them:
${filterPrompt.trim()}

Apply this filter alongside the FOCUS statement. Items and concepts that don't match
the filter criteria should be deprioritized or omitted.

`
    : "";

  return `${aboutBlock}${focusBlock}${filterBlock}${suppressedBlock}Extract substantive technical concepts from work items.

USER-BOOKMARKED ITEMS — items tagged \`[USER-BOOKMARKED]\` carry an
explicit opt-in from the reader (they reacted \`:bookmark:\` to the
Slack message). These are NOT optional inputs: you MUST emit at least
one concept per bookmarked item, even if the message text is short,
casual, or borderline against the substance bar below. The reader is
telling you "give me something to learn from this." Find the closest
underlying technology, technique, pattern, methodology, or domain
area the bookmarked content gestures at (drawn from the title, body,
or surrounding context), and emit it as a concept. If the only
substantive angle is broader than the message itself, use the
broader concept. The substance bar still applies to bookmarked items
in the sense that you should never emit an org/process/ritual noun —
but you must find SOMETHING teachable to anchor a piece on.

SUBSTANCE BAR — a concept MUST clear this bar to be extracted:
- It must be teachable as standalone subject matter — i.e. an experienced
  practitioner could write a short article about it that another engineer
  would benefit from reading.
- It must refer to a thing (technology, technique, pattern, methodology,
  domain area) — not a meeting, role, ritual, or organizational artifact.

DO NOT EXTRACT (these fail the substance bar even if they appear in the input):
- Meeting / cadence types: standup, retro, all-hands, sync, OKR review,
  weekly check-in, monthly plan, planning, kickoff, demo day.
- Ritual roles: retro lead, on-call rotation, scrum master, project manager.
- Process labels: weekly goals tracking, status updates, OKRs (the framework
  is fine if the user is focused on goal-setting, but not as a rote noun).
- Team / organization names, internal initiatives, project codenames,
  customer names — anything that is purely organizational rather than
  intellectually transferable.
- Generic verbs and bland nouns: "meeting", "discussion", "follow-up",
  "review", "implementation".

UMBRELLA RULE — prefer ONE canonical concept over close variants:
- If a batch yields "schema migration", "online migration", and "database
  migration", emit ONE concept (\`database migrations\`) with the others in
  \`aliases\`.
- If a batch yields "kubernetes pod", "k8s deployment", and "container
  orchestration", consider whether one umbrella term ("kubernetes" or
  "container orchestration") captures the substance — if so, use it.
- Bias hard toward fewer, broader concepts. Specific implementation details
  are fine ONLY when a source genuinely focuses on them.

OUTPUT FORMAT — for each NEW concept, provide:
- name: canonical lowercase name (the umbrella term, not a specific variant)
- category: "infrastructure" | "platform" | "security" | "observability" | "language" | "framework" | "pattern" | "domain" | "tool" | "methodology"
- description: one short sentence describing what the concept IS (not the
  user's relationship to it)
- aliases: array of alternative names / close variants the user might
  encounter (include the variants you would have otherwise extracted as
  separate concepts)

Existing concepts (do NOT re-create; you MAY extract these again only if
something in the input genuinely reinforces them, in which case use the same
canonical name so the existing concept is bumped):
${existingNames.length > 0 ? existingNames.join(", ") : "(none yet)"}

Return JSON: { "concepts": [{name, category, description, aliases?}] }
Keep the response tight. If a batch yields no substantive, focus-aligned
concepts, return { "concepts": [] }.`;
}

export interface ExtractionOptions {
  /** Resolved model spec for this operation. Defaults to the catalog
   *  entry for `conceptExtraction` when omitted. */
  modelSpec?: ModelSpec;
  focusStatement?: string | null;
  /** Active focus version id; stamped onto newly created concepts for attribution. */
  focusVersionId?: string | null;
  /** "About me" persona statement; influences extraction granularity. */
  aboutStatement?: string | null;
  /** Global AI filter prompt. Applied to items whose source has no
   *  override set in `sourceFilterOverrides`. */
  filterPrompt?: string | null;
  /** Per-source override map (`{ providerId: prompt }` for the
   *  singleton work-context items extraction sees — Linear, Slack,
   *  incident.io, GitHub). When an item's source has an entry here,
   *  that prompt REPLACES the global filter for the batch the item
   *  is in. */
  sourceFilterOverrides?: Record<string, string>;
  onProgress?: (progress: ExtractionProgress) => Promise<void>;
}

function defaultExtractionSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.conceptExtraction);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.conceptExtraction };
}

export async function extractConcepts(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  workContext: WorkContextItem[],
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  if (workContext.length === 0) {
    return { newConceptIds: [], existingConceptIds: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }

  const { modelSpec, focusStatement = null, focusVersionId = null, aboutStatement = null, onProgress } = options;
  const globalFilter = options.filterPrompt ?? null;
  const overrides = options.sourceFilterOverrides ?? {};

  // Pull existing (non-suppressed) and suppressed canonical names separately so
  // we can tell the model "don't re-extract these" vs "these exist, reuse them".
  const allExisting = await getAllConcepts(db, userId);
  const existingNames = allExisting.filter((c) => !c.suppressed_at).map((c) => c.canonical_name);
  const suppressedNames = allExisting.filter((c) => c.suppressed_at).map((c) => c.canonical_name);
  const spec = modelSpec ?? defaultExtractionSpec();

  // Group items by their effective filter. Items from sources with
  // a per-source override get their own bucket; everything else
  // shares the "global filter" bucket. Each bucket then chunks
  // independently into BATCH_SIZE-sized LLM calls.
  //
  // This way a Linear-specific override only shapes the Linear
  // extraction prompt, without polluting the prompt the model sees
  // for the Slack / incident.io / GitHub items in the same briefing.
  const buckets = new Map<string, { filter: string | null; items: WorkContextItem[] }>();
  const filterKeyFor = (filter: string | null): string => filter ?? "__global__";
  for (const item of workContext) {
    const sourceKey = singletonSourceKey(item.type);
    const override = sourceKey ? overrides[sourceKey] : undefined;
    const filter = override ?? globalFilter;
    const key = filterKeyFor(filter);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { filter, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
  }

  // Build the per-bucket batch list (chunk every bucket separately
  // so override-batches stay isolated from the global pool). Total
  // batch count is sum across buckets — used for progress reporting.
  const bucketBatches = [...buckets.values()].map((bucket) => ({
    filter: bucket.filter,
    batches: chunk(bucket.items, BATCH_SIZE),
  }));
  const totalBatches = bucketBatches.reduce((s, b) => s + b.batches.length, 0);
  let completedBatches = 0;
  const allConcepts: ExtractedConcept[] = [];
  const totalUsage: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

  await onProgress?.({ totalBatches, completedBatches: 0, conceptsFoundSoFar: 0 });

  // Flatten to a list of LLM-call promises so we can fire all
  // batches in parallel regardless of bucket. Each batch's prompt
  // uses the bucket's filter prompt.
  const batchPromises = bucketBatches.flatMap((bucket) =>
    bucket.batches.map(async (batch, idx) => {
      const contextSummary = formatBatch(batch);
      // Each batch sees existing concepts but not in-flight results from siblings
      // (acceptable: dedup happens on merge). First batch sees just D1 concepts;
      // later batches will see D1 concepts too, so dedup via findConceptByName on merge.
      const system = buildSystemPrompt(existingNames, suppressedNames, focusStatement, aboutStatement, bucket.filter);

      try {
        const { result, usage } = await llm.generateJson<{ concepts: ExtractedConcept[] }>({
          spec,
          system,
          user: contextSummary,
          maxTokens: 4096,
        });

        totalUsage.inputTokens += usage.inputTokens;
        totalUsage.outputTokens += usage.outputTokens;

        allConcepts.push(...(result.concepts ?? []));
        completedBatches++;
        await onProgress?.({
          totalBatches,
          completedBatches,
          conceptsFoundSoFar: allConcepts.length,
        });

        return { batchIdx: idx, count: result.concepts?.length ?? 0 };
      } catch (err) {
        console.error(`[concept-extraction] Batch ${idx + 1}/${totalBatches} failed:`, err);
        completedBatches++;
        await onProgress?.({
          totalBatches,
          completedBatches,
          conceptsFoundSoFar: allConcepts.length,
        });
        return { batchIdx: idx, count: 0 };
      }
    }),
  );

  await Promise.all(batchPromises);

  await recordTokenUsage(db, userId, "concept_extraction", spec, totalUsage);

  // Merge + persist concepts (dedupe by name across all batches)
  const newConceptIds: string[] = [];
  const existingConceptIds: string[] = [];
  const seenNames = new Set<string>();

  for (const concept of allConcepts) {
    const normalizedName = concept.name.toLowerCase().trim();
    if (seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);

    const found = await findConceptByName(db, userId, concept.name);

    if (found) {
      existingConceptIds.push(found.id);

      await db
        .prepare(
          `UPDATE concept_depth SET exposure_count = exposure_count + 1,
           last_exposed_at = datetime('now'), updated_at = datetime('now')
           WHERE concept_id = ? AND user_id = ?`,
        )
        .bind(found.id, userId)
        .run();

      for (const alias of concept.aliases ?? []) {
        await addConceptAlias(db, found.id, alias);
      }
    } else {
      const id = await createConcept(
        db,
        userId,
        concept.name,
        concept.category,
        concept.description,
        concept.aliases,
        focusVersionId,
      );
      newConceptIds.push(id);

      await recordDepthChange(db, userId, id, 0, 0, "extraction", `Extracted from work context`);
    }
  }

  return { newConceptIds, existingConceptIds, usage: totalUsage };
}
