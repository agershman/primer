/**
 * Briefing-generation pipeline — the 9-step flow that produces a
 * user's daily briefing. This is the load-bearing dataflow of the
 * whole app:
 *
 *   1. fetch work context (Linear, Slack, incident.io, GitHub, feeds)
 *   1a. Slack relevance filter
 *   3. extract concepts
 *   5. scan adjacent sources
 *   6. select targets
 *   7. generate teaching pieces (+ continuation classifier)
 *   8. generate calibration quiz
 *   9. finalize
 *
 * See `dev-docs/architecture.md` for the mermaid diagram and
 * `src/frontend/help/briefings/how-generation-works.md` for the
 * user-facing version.
 *
 * Adding or modifying a step? Read
 * `.cursor/skills/add-pipeline-step/SKILL.md` BEFORE making changes.
 * It documents the four invariants every step must hold:
 *
 *   - `await checkCancelled(briefingId, db)` at entry
 *   - `await updateProgress(...)` for the live status panel
 *   - `await safeStep("<id>", async () => { … })` to wrap risky work
 *   - `recordTiming(timings, "<id>", elapsedMs)` for the analytics waterfall
 *
 * Skip any of these and you get subtle bugs: stuck-looking UI, the
 * whole briefing failing on a transient LLM 500, the analytics
 * waterfall missing a bar. None of them fail loudly.
 *
 * Heads-up: this file is still ~1100 lines and `generateDailyBriefing`
 * carries the bulk of the body. The shared helpers (`safeStep`,
 * `withRetry`, `updateProgress`, `checkCancelled`, `CancelledError`,
 * `summarize{FeedSources,WorkContextSources}`, `BriefingResult`) have
 * already been moved to [`./briefing-generator/shared.ts`](./briefing-generator/shared.ts).
 * Each pipeline step body is the next extraction target — see
 * `dev-docs/cleanup-roadmap.md` item 1 for the suggested layout.
 * Resist piling on more inline logic here; if you find yourself
 * adding > 100 lines, consider whether your work belongs in a new
 * sibling file under `briefing-generator/` rather than here.
 *
 * @see .cursor/skills/add-pipeline-step/SKILL.md — task playbook
 * @see .cursor/rules/briefing-pipeline.mdc — auto-surfaces when editing this file
 * @see dev-docs/architecture.md — the pipeline mermaid diagram
 * @see dev-docs/cleanup-roadmap.md item 1 — the remaining per-step extractions
 */

import { BRIEFING_RULES } from "../config/constants.js";
import { resolveModel } from "../config/models.js";
import {
  genId,
  getActiveConcepts,
  getAllConcepts,
  getRecentBriefingConceptIds,
  isBudgetExceeded,
  recordTokenUsage,
} from "../db/queries.js";
import { llmClient } from "../integrations/llm/dispatcher.js";
import type { ModelSpec } from "../integrations/llm/types.js";
import { type SourceFetchContext, sourceRegistry, type WorkContextItem } from "../sources/index.js";
import { type Env, singletonSourceKey, type UserSettings } from "../types.js";
import { userToday } from "../util/time.js";
import { scanAdjacentSources } from "./adjacent-scanner.js";
import {
  type BriefingResult,
  CancelledError,
  checkCancelled,
  classifyNoContentReason,
  safeStep,
  selectEnabledSingletons,
  summarizeFeedSources,
  summarizeWorkContextSources,
  updateProgress,
} from "./briefing-generator/shared.js";
import { extractConcepts } from "./concept-extractor.js";
import { type ClassificationResult, classifyDraft, findCandidatePredecessors } from "./continuation-classifier.js";
import { runDecayJob } from "./depth-manager.js";
import { type FocusScorerCandidate, scoreCandidatesAgainstFocus } from "./focus-scorer.js";
import { auditPiece, auditQuiz } from "./piece-auditor.js";
import { generateQuiz } from "./quiz-assessor.js";
import { filterSlackByRelevance } from "./slack-relevance-filter.js";
import { generateTeachingPiece } from "./teaching-generator.js";
import { recordTiming } from "./timing.js";

// Re-export shared helpers + types so existing callers continue to
// import them from this module's path. The implementations live in
// [`./briefing-generator/shared.ts`](./briefing-generator/shared.ts)
// — see the cleanup-roadmap note in the file header for the planned
// full split.
export { CancelledError, summarizeFeedSources } from "./briefing-generator/shared.js";

export async function generateDailyBriefing(
  db: D1Database,
  userId: string,
  env: Env,
  existingBriefingId?: string,
  userSettings?: UserSettings,
  // The IANA timezone to stamp the briefing's calendar day in. Only
  // consulted on the cron path (no `existingBriefingId`); the manual
  // /briefing/generate route inserts the row beforehand with the
  // correct date already, so the value is ignored there. Cron passes
  // the user's persisted `timezone` so the briefing's date matches
  // their wall clock — UTC fallback is the right default for the
  // bootstrap case where a brand-new user has never reported a TZ.
  timezone: string = "UTC",
): Promise<BriefingResult> {
  const errors: string[] = [];
  const today = userToday(timezone);
  const briefingId = existingBriefingId || genId("briefing");

  // Resolve the user's active focus AND about versions up front. Focus is
  // stamped on the briefing row + on every concept created during this run so
  // analytics can attribute outputs back to the focus statement that produced
  // them. About is persona context (style/voice/depth) — fed into prompts but
  // not stamped on rows since it doesn't change topic selection.
  const personaRow = await db
    .prepare(
      `SELECT u.email AS email,
              u.current_focus_version_id AS focus_version_id,
              fv.statement AS focus_statement,
              u.current_about_version_id AS about_version_id,
              av.statement AS about_statement
       FROM users u
       LEFT JOIN focus_statement_versions fv ON fv.id = u.current_focus_version_id
       LEFT JOIN about_statement_versions av ON av.id = u.current_about_version_id
       WHERE u.id = ?`,
    )
    .bind(userId)
    .first<{
      email: string | null;
      focus_version_id: string | null;
      focus_statement: string | null;
      about_version_id: string | null;
      about_statement: string | null;
    }>();
  const userEmail = personaRow?.email ?? "";
  const focusVersionId = personaRow?.focus_version_id ?? null;
  const focusStatement = personaRow?.focus_statement ?? null;
  const aboutStatement = personaRow?.about_statement ?? null;

  const budgetCap = parseFloat(env.BUDGET_CAP_MONTHLY || "35");
  if (await isBudgetExceeded(db, userId, budgetCap)) {
    // The cron path arrives here with no row pre-inserted, so a bare
    // UPDATE silently no-ops and the user just sees yesterday's
    // briefing with no explanation. INSERT-OR-REPLACE makes the
    // budget-cap state explicit on today's row so the read endpoint
    // can surface it.
    const budgetMetadata = JSON.stringify({
      step: "failed",
      stepLabel: "Monthly budget cap exceeded",
      reason: "monthly_budget_exceeded",
    });
    if (existingBriefingId) {
      await db
        .prepare(`UPDATE briefings SET status = 'failed', metadata = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(budgetMetadata, briefingId)
        .run();
    } else {
      await db
        .prepare(
          `INSERT OR REPLACE INTO briefings (id, user_id, briefing_date, generated_at, status, metadata, focus_version_id, created_at, updated_at)
           VALUES (?, ?, ?, datetime('now'), 'failed', ?, ?, datetime('now'), datetime('now'))`,
        )
        .bind(briefingId, userId, today, budgetMetadata, focusVersionId)
        .run();
    }

    return { briefingId, status: "failed" as const, pieceCount: 0, errors: ["Monthly budget cap exceeded"] };
  }

  if (!existingBriefingId) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO briefings (id, user_id, briefing_date, generated_at, status, metadata, focus_version_id, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), 'generating', ?, ?, datetime('now'), datetime('now'))`,
      )
      .bind(
        briefingId,
        userId,
        today,
        JSON.stringify({ step: "starting", stepLabel: "Starting generation..." }),
        focusVersionId,
      )
      .run();
  } else {
    await db
      .prepare("UPDATE briefings SET focus_version_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(focusVersionId, briefingId)
      .run();
  }

  const llm = llmClient(env);

  try {
    // Step boundary timestamps for analytics. We record one row per pipeline
    // step (and one per teaching piece) into briefing_timings; aggregations
    // live in /api/analytics/*.
    let stepStart = Date.now();
    await updateProgress(db, briefingId, "work_context", "Fetching Linear issues…");

    // Step 1: Fetch active work context via registered source providers
    let workContext: WorkContextItem[] = [];
    const contextDetails: string[] = [];

    const surfaceMap = (userSettings?.signalSurfaceMap ?? {}) as Record<string, unknown>;

    const conceptExtractionSpec = resolveModel(surfaceMap, "conceptExtraction");
    const adjacentScoringSpec = resolveModel(surfaceMap, "adjacentScoring");
    const teachingPieceSpec = resolveModel(surfaceMap, "teachingPiece");
    const quizGenerationSpec = resolveModel(surfaceMap, "quizGeneration");
    const continuationSpec = resolveModel(surfaceMap, "continuationClassifier");
    const focusScoringSpec = resolveModel(surfaceMap, "focusScoring");
    const auditSpec = resolveModel(surfaceMap, "audit");
    // Patch model defaults to the same model as the drafter (voice
    // consistency) but can be overridden in
    // Settings → Intelligence → AI models.
    const auditPatchSpec = resolveModel(surfaceMap, "auditPatch");
    // Persisted on the briefing row for analytics. Stored as a flat
    // `<operation>: <model>` map for backwards compatibility with older
    // briefings; PR 2 will widen this to capture provider + reasoning.
    const modelsUsed: Record<string, string> = {
      conceptExtraction: conceptExtractionSpec.model,
      adjacentScoring: adjacentScoringSpec.model,
      teachingPiece: teachingPieceSpec.model,
      quizGeneration: quizGenerationSpec.model,
      continuationClassifier: continuationSpec.model,
      focusScoring: focusScoringSpec.model,
      audit: auditSpec.model,
      auditPatch: auditPatchSpec.model,
    };

    await updateProgress(db, briefingId, "work_context", "Fetching work context…");

    // Per-user opt-in gate — disabled sources skip their fetch
    // entirely so we don't burn HTTP budget on data that gets
    // thrown away. The gate logic lives in `selectEnabledSingletons`
    // (see briefing-generator/shared.ts) so it's pinned by a unit
    // test that doesn't need the rest of the pipeline standing up.
    const allSingletons = sourceRegistry.getSingletons(env);
    const singletonProviders = selectEnabledSingletons(allSingletons, userSettings?.enabledSourceIds);
    const enabledIdSet = new Set(singletonProviders.map((p) => p.id));
    const fetchCtx: SourceFetchContext = {
      env,
      db,
      userId,
      userEmail,
      userSettings: userSettings ?? {},
      sourceConfig: surfaceMap,
      llm,
    };

    const sourceResults = await Promise.all(
      singletonProviders.map(async (provider) => {
        const step = await safeStep(provider.id, () => provider.fetch(fetchCtx), { items: [], details: [] });
        return { provider, step };
      }),
    );

    // Per-provider rollups for the pipeline trace. We capture the FULL
    // singleton registry (not just enabled) so the trace can show
    // "this source is configured but the user opted out" alongside
    // "this source ran but had nothing today" and "this source
    // errored". Sample items are titles/urls only (no descriptions)
    // so the JSON stays compact.
    const providerStats: Array<{
      id: string;
      name: string;
      enabled: boolean;
      fetched: boolean;
      itemCount: number;
      errored: boolean;
      sampleItems: Array<{ title: string; url?: string }>;
    }> = [];
    const resultsByProvider = new Map(sourceResults.map((r) => [r.provider.id, r]));
    for (const provider of allSingletons) {
      const enabled = enabledIdSet.has(provider.id);
      const result = resultsByProvider.get(provider.id);
      const items = (result?.step.data.items ?? []) as WorkContextItem[];
      providerStats.push({
        id: provider.id,
        name: provider.name,
        enabled,
        fetched: enabled && !!result,
        itemCount: items.length,
        errored: !!result?.step.error,
        sampleItems: items.slice(0, 5).map((i) => ({ title: i.title, url: i.url })),
      });
    }

    for (const { step } of sourceResults) {
      if (step.error) errors.push(step.error);
      for (const item of step.data.items as WorkContextItem[]) {
        workContext.push(item);
      }
      contextDetails.push(...step.data.details);
    }

    await updateProgress(db, briefingId, "work_context", `Found ${workContext.length} work items`, contextDetails);
    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "work_context",
      startedAt: stepStart,
      itemsProcessed: workContext.length,
      metadata: { providers: providerStats },
    });

    // Step 1.5: Slack relevance filter — drop banter / off-topic chatter
    // before it leaks into concept extraction or the work-context bar.
    // Reuses the `adjacentScoring` model (Haiku 4.5 by default) since
    // it's the same "score for relevance" operation, just applied to
    // Slack threads instead of feed items. Bookmarked threads bypass.
    // Fail-open: if scoring errors out, items pass through unchanged.
    const slackInputCount = workContext.filter((i) => i.type === "slack_thread").length;
    if (slackInputCount > 0) {
      stepStart = Date.now();
      await updateProgress(
        db,
        briefingId,
        "slack_filter",
        `Filtering ${slackInputCount} Slack thread${slackInputCount === 1 ? "" : "s"} against your About + Focus…`,
      );
      const filterStep = await safeStep(
        "slack_relevance_filter",
        () =>
          filterSlackByRelevance(llm, db, userId, workContext, {
            modelSpec: adjacentScoringSpec,
            aboutStatement,
            focusStatement,
            filterPrompt: userSettings?.filterPrompt ?? null,
            // RELEVANCE_THRESHOLD is the same number tuned in
            // `BriefingLimits` for adjacent feeds — keeps both
            // relevance gates calibrated against the user's one knob.
            threshold: userSettings?.relevanceThreshold ?? undefined,
          }),
        {
          kept: workContext,
          dropped: [],
          totalSlackCount: slackInputCount,
          keptSlackCount: slackInputCount,
          modelUsed: adjacentScoringSpec.model,
          failedOpen: true,
        },
      );
      if (filterStep.error) errors.push(filterStep.error);
      const filterResult = filterStep.data;
      workContext = filterResult.kept;
      const droppedCount = filterResult.dropped.length;
      const filterDetails = filterResult.dropped.slice(0, 5).map((d) => {
        const trimmed = d.title.length > 60 ? `${d.title.slice(0, 60)}…` : d.title;
        return `✕ ${trimmed} (${d.score.toFixed(2)} — ${d.reason || "off-topic"})`;
      });
      await updateProgress(
        db,
        briefingId,
        "slack_filter",
        droppedCount === 0
          ? filterResult.failedOpen
            ? `Slack scoring unavailable — kept all ${filterResult.keptSlackCount} threads`
            : `All ${filterResult.keptSlackCount} Slack threads passed the relevance bar`
          : `Filtered ${droppedCount} of ${filterResult.totalSlackCount} Slack threads as off-topic; kept ${filterResult.keptSlackCount}`,
        filterDetails,
      );
      await recordTiming(db, {
        briefingId,
        userId,
        stepKey: "slack_filter",
        startedAt: stepStart,
        itemsProcessed: filterResult.totalSlackCount,
        modelUsed: filterResult.modelUsed,
        metadata: {
          totalSlackCount: filterResult.totalSlackCount,
          keptSlackCount: filterResult.keptSlackCount,
          droppedCount,
          failedOpen: filterResult.failedOpen,
          // Capped at 20 — keeps the metadata blob small while still
          // covering typical days. `sourceType` keeps the shape
          // generic so future relevance gates can reuse this metadata
          // contract under their own step key.
          droppedItems: filterResult.dropped.slice(0, 20).map((d) => ({
            id: d.id,
            sourceType: "slack_thread",
            title: d.title,
            score: d.score,
            reason: d.reason,
          })),
        },
      });
    }

    const linearCount = workContext.filter((i) => i.type === "linear_issue").length;
    const slackCount = workContext.filter((i) => i.type === "slack_thread").length;
    const incCount = workContext.filter((i) => i.type === "incident").length;

    const batchSize = 15;
    const estimatedBatches = Math.max(1, Math.ceil(workContext.length / batchSize));
    stepStart = Date.now();
    await updateProgress(
      db,
      briefingId,
      "concepts",
      `Analyzing ${workContext.length} items in ${estimatedBatches} parallel ${estimatedBatches === 1 ? "batch" : "batches"} — ${linearCount} issues, ${slackCount} threads, ${incCount} incidents`,
      contextDetails,
      true,
    );

    // Step 3: Extract concepts (batched in parallel)
    const extractionProgressDetails: string[] = [];
    const extractionStep = await safeStep(
      "concept_extraction",
      async () => {
        return extractConcepts(db, userId, llm, workContext, {
          modelSpec: conceptExtractionSpec,
          focusStatement,
          focusVersionId,
          aboutStatement,
          filterPrompt: userSettings?.filterPrompt ?? null,
          // Per-source overrides (Settings → Personalization →
          // Relevance filter → Per-source overrides). Items from
          // a source with an entry here are extracted using that
          // override prompt instead of the global filter.
          sourceFilterOverrides: userSettings?.sourceFilterOverrides ?? {},
          onProgress: async (p) => {
            extractionProgressDetails.length = 0;
            extractionProgressDetails.push(
              `Batch ${p.completedBatches}/${p.totalBatches} complete — ${p.conceptsFoundSoFar} concepts found`,
            );
            await updateProgress(
              db,
              briefingId,
              "concepts",
              `Analyzing ${workContext.length} items (batch ${p.completedBatches}/${p.totalBatches})`,
              extractionProgressDetails,
              p.completedBatches < p.totalBatches,
            );
          },
        });
      },
      { newConceptIds: [], existingConceptIds: [], usage: { inputTokens: 0, outputTokens: 0 } },
    );
    if (extractionStep.error) errors.push(extractionStep.error);

    // Reconstruct the per-filter bucket layout the extractor used so
    // the trace can show "items from <source> were extracted under
    // the <override / global> filter". The extractor uses the same
    // logic at concept-extractor.ts:283-296; we don't have the
    // post-extraction concept count per bucket (extractor returns a
    // single rollup) but the routing is the most useful signal.
    const conceptBucketMap = new Map<string, { filterLabel: string; sourceTypes: Set<string>; itemCount: number }>();
    {
      const overrides = userSettings?.sourceFilterOverrides ?? {};
      const globalFilter = userSettings?.filterPrompt ?? null;
      for (const item of workContext) {
        const sourceKey = singletonSourceKey(item.type);
        const override = sourceKey ? overrides[sourceKey] : undefined;
        const filterText = override ?? globalFilter ?? null;
        const filterLabel = override ? `override:${sourceKey}` : globalFilter ? "global" : "none";
        const key = `${filterLabel}::${filterText ?? ""}`;
        let bucket = conceptBucketMap.get(key);
        if (!bucket) {
          bucket = { filterLabel, sourceTypes: new Set(), itemCount: 0 };
          conceptBucketMap.set(key, bucket);
        }
        bucket.sourceTypes.add(item.type);
        bucket.itemCount++;
      }
    }
    const conceptBuckets = [...conceptBucketMap.values()].map((b) => ({
      filterLabel: b.filterLabel,
      sourceTypes: [...b.sourceTypes],
      itemCount: b.itemCount,
    }));

    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "concepts",
      startedAt: stepStart,
      itemsProcessed: extractionStep.data.newConceptIds.length + extractionStep.data.existingConceptIds.length,
      modelUsed: conceptExtractionSpec.model,
      metadata: {
        workContextItems: workContext.length,
        newConceptIds: extractionStep.data.newConceptIds.length,
        existingConceptIds: extractionStep.data.existingConceptIds.length,
        tokensInput: extractionStep.data.usage.inputTokens,
        tokensOutput: extractionStep.data.usage.outputTokens,
        buckets: conceptBuckets,
      },
    });

    // Step 4: Read concept graph
    const allConcepts = await getAllConcepts(db, userId);
    const activeConcepts = await getActiveConcepts(db, userId);

    // Refresh detection: if the briefing already has teaching pieces,
    // we're refreshing in ADDITIVE mode — preserve existing pieces and
    // append new ones shaped by the current focus, instead of writing
    // a full fresh set. The lifecycle handler resets the briefing's
    // status from done/failed back to generating; pieces survive that
    // transition and signal additivity here.
    const existingPiecesRows = await db
      .prepare(`SELECT id, position, concepts FROM teaching_pieces WHERE briefing_id = ? AND user_id = ?`)
      .bind(briefingId, userId)
      .all<{ id: string; position: number; concepts: string }>();
    const existingPieces = existingPiecesRows.results ?? [];
    const isAdditiveRefresh = existingPieces.length > 0;
    const existingPieceConceptIds = new Set<string>();
    let maxExistingPosition = -1;
    for (const row of existingPieces) {
      if (row.position > maxExistingPosition) maxExistingPosition = row.position;
      try {
        const ids = JSON.parse(row.concepts) as string[];
        for (const id of ids) existingPieceConceptIds.add(id);
      } catch {
        // Tolerate a malformed concepts blob — it just means we won't
        // dedupe against this row's concept ids. Worst case the refresh
        // re-teaches a concept; it won't crash generation.
      }
    }

    // Run decay
    await runDecayJob(db, userId);

    stepStart = Date.now();
    const feedSummary = await summarizeFeedSources(db);
    await updateProgress(
      db,
      briefingId,
      "adjacent",
      `Scanning feeds${feedSummary.suffix} for ${activeConcepts.length} active concepts`,
      [
        `${extractionStep.data.newConceptIds.length} new concepts extracted`,
        `${extractionStep.data.existingConceptIds.length} existing concepts updated`,
      ],
      true,
    );

    // Step 5: Scan adjacent sources
    const conceptSummaries = activeConcepts.map((c) => ({
      id: c.id,
      name: c.canonical_name,
      depth: c.depth_score ?? 0,
    }));

    await updateProgress(
      db,
      briefingId,
      "adjacent",
      `Fetching feeds${feedSummary.suffix}…`,
      [`Scoring relevance against top 25 of ${activeConcepts.length} concepts`],
      true,
    );

    const adjacentStep = await safeStep(
      "adjacent_scan",
      async () => {
        return scanAdjacentSources(
          db,
          userId,
          llm,
          conceptSummaries,
          {
            modelSpec: adjacentScoringSpec,
            aboutStatement,
            focusStatement,
            filterPrompt: userSettings?.filterPrompt ?? null,
            // Per-source overrides keyed by source instance id (e.g.
            // CNCF Blog, Cloudflare Blog) — feeds with an override
            // get scored in their own bucket using that prompt.
            sourceFilterOverrides: userSettings?.sourceFilterOverrides ?? {},
            // Per-user opt-in: skip source instances whose kind the
            // user hasn't enabled. Pass through as-is so the
            // adjacent-scanner gets the same undefined-vs-array
            // semantics the singleton gate uses (undefined = no
            // gate, scan every enabled instance; empty array = the
            // user explicitly opted nothing in). The earlier `?? []`
            // collapsed both "settings weren't loaded" and "user
            // turned everything off" into the same "filter every
            // feed out" branch — the cron path's missing
            // `enabled_source_ids` load (now fixed) used to land
            // here and silently produce zero adjacent candidates.
            enabledSourceIds: userSettings?.enabledSourceIds,
          },
          env,
        );
      },
      { relevant: [], nearMisses: [], sourceErrors: [], modelUsed: adjacentScoringSpec.model },
    );
    if (adjacentStep.error) errors.push(adjacentStep.error);
    errors.push(...adjacentStep.data.sourceErrors);

    // Store adjacent sources. Batched into a single D1 round-trip
    // via `db.batch([...])` instead of awaiting one INSERT per row —
    // a typical adjacent scan turns up 10–30 items, and the
    // pre-batch loop spent the whole step on serial round-trip
    // latency. `INSERT OR IGNORE` keeps the dedupe semantics
    // (existing rows on the unique index get silently skipped).
    if (adjacentStep.data.relevant.length > 0) {
      const discoveredInsert = db.prepare(
        `INSERT OR IGNORE INTO discovered_items
         (id, user_id, source_type, url, title, summary, relevance_concepts, relevance_score, discovered_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+30 days'))`,
      );
      const discoveredStatements = adjacentStep.data.relevant.map((item) =>
        discoveredInsert.bind(
          genId("discoveredItem"),
          userId,
          item.source,
          item.url,
          item.title,
          item.summary ?? null,
          JSON.stringify(item.relevanceConcepts),
          item.relevanceScore,
        ),
      );
      await db.batch(discoveredStatements);
    }

    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "adjacent",
      startedAt: stepStart,
      itemsProcessed: adjacentStep.data.relevant.length + adjacentStep.data.nearMisses.length,
      modelUsed: adjacentScoringSpec.model,
      metadata: {
        relevant: adjacentStep.data.relevant.length,
        nearMisses: adjacentStep.data.nearMisses.length,
        sourceErrors: adjacentStep.data.sourceErrors.length,
      },
    });

    stepStart = Date.now();
    await updateProgress(db, briefingId, "selecting", "Selecting teaching targets...");

    // Step 6: Select teaching targets
    const recentConceptIds = await getRecentBriefingConceptIds(db, userId, BRIEFING_RULES.NO_REPEAT_WITHIN_DAYS);
    const recentSet = new Set(recentConceptIds);

    interface SourceDescriptor {
      type: string;
      id?: string;
      title?: string;
      url?: string;
      channel?: string;
      summary?: string;
      source?: string;
      /** ISO timestamp; copied from the underlying WorkContextItem so
       *  the teaching-piece insert can compute the soonest deadline
       *  across all of a piece's sources. */
      dueAt?: string | null;
      /** Human-readable rationale for the deadline (e.g. "Linear ticket
       *  CIN-1234 is due 2026-04-30"). Surfaced as the "Due in 3 days"
       *  badge tooltip on the frontend. */
      dueReason?: string | null;
    }

    interface TeachingTarget {
      conceptName: string;
      conceptId: string;
      depthScore: number;
      category?: string;
      sourceType: "current-work" | "adjacent" | "decay-recalibrate";
      sourceReference?: string;
      sourceDescription?: string;
      selectionReasoning: string;
      priority: number;
      sourceContext: SourceDescriptor[];
    }

    // Build a lookup of which work items mention each concept name so we can
    // attach provenance to current-work teaching pieces.
    function findRelatedWorkItems(conceptName: string): { sources: SourceDescriptor[]; bestDescription?: string } {
      const lower = conceptName.toLowerCase();
      const sources: SourceDescriptor[] = [];
      let bestDescription: string | undefined;
      let bestDescLen = 0;

      for (const item of workContext) {
        const text = `${item.title} ${item.description ?? ""}`.toLowerCase();
        if (text.includes(lower)) {
          sources.push({
            type: item.type,
            id: item.id,
            title: item.title,
            url: item.url,
            dueAt: item.dueAt ?? null,
            dueReason: item.dueReason ?? null,
          });

          const descLen = item.description?.length ?? 0;
          if (descLen > bestDescLen) {
            bestDescLen = descLen;
            bestDescription = item.description;
          }
        }
      }
      return { sources: sources.slice(0, 5), bestDescription };
    }

    const candidates: TeachingTarget[] = [];

    // P1 (bookmark): every bookmarked work item gets a candidate.
    // Bookmarks are an explicit user opt-in ("teach me from this")
    // and must reliably produce a piece — they bypass both the depth
    // filter (priority 2 requires `depth_score < 3`) and the
    // NO_REPEAT_WITHIN_DAYS recent-concept filter. The only dedupe
    // applied here is the additive-refresh `existingPieceConceptIds`
    // guard, which prevents a same-briefing duplicate insert.
    //
    // Concept selection per bookmark: pick the lowest-depth concept
    // whose canonical name appears in the bookmarked item's text. If
    // no extracted concept matches, fall back to a concept-less
    // candidate keyed off the bookmark's title — `generateTeachingPiece`
    // handles missing conceptIds gracefully (same path adjacent items
    // without a matched concept already use).
    const bookmarkedItems = workContext.filter((i) => i.bookmarked);
    const bookmarkConceptIds = new Set<string>();
    for (const item of bookmarkedItems) {
      // Build the source description shown to the teaching-piece
      // writer. When the thread has specifically-bookmarked messages
      // (the user flagged individual replies or the root with
      // `:bookmark:`), pre-pend them as an [EMPHASIS] block so the
      // writer leans on the user's explicit pick(s) instead of treating
      // every reply equally. Without this the writer only sees the
      // generic thread description and the in-thread emphasis is lost.
      const emphasisBlock =
        item.bookmarkedExcerpts && item.bookmarkedExcerpts.length > 0
          ? `[EMPHASIS — messages within this thread the reader explicitly bookmarked; weight them above the surrounding thread content]:\n${item.bookmarkedExcerpts
              .slice(0, 5)
              .map((e, i) => `${i + 1}. ${e.slice(0, 400)}`)
              .join("\n")}`
          : null;
      const enrichedDescription = emphasisBlock
        ? item.description
          ? `${emphasisBlock}\n\n${item.description}`
          : emphasisBlock
        : item.description;

      // Include the bookmarked excerpts in the concept-match haystack
      // so a thread whose excerpts call out a different concept than
      // the title can still anchor to the user's emphasis.
      const haystack =
        `${item.title} ${item.description ?? ""} ${(item.bookmarkedExcerpts ?? []).join(" ")}`.toLowerCase();
      const matched = activeConcepts
        .filter((c) => haystack.includes(c.canonical_name.toLowerCase()))
        .filter((c) => !existingPieceConceptIds.has(c.id))
        .sort((a, b) => (a.depth_score ?? 0) - (b.depth_score ?? 0));

      const sourceCtx: SourceDescriptor = {
        type: item.type,
        id: item.id,
        title: item.title,
        url: item.url,
        dueAt: item.dueAt ?? null,
        dueReason: item.dueReason ?? null,
      };

      if (matched.length > 0) {
        const concept = matched[0];
        if (bookmarkConceptIds.has(concept.id)) continue;
        bookmarkConceptIds.add(concept.id);
        candidates.push({
          conceptName: concept.canonical_name,
          conceptId: concept.id,
          depthScore: concept.depth_score ?? 0,
          sourceType: "current-work",
          sourceDescription: enrichedDescription,
          selectionReasoning: `Bookmarked source: "${item.title.slice(0, 80)}"`,
          priority: 1,
          sourceContext: [sourceCtx],
        });
      } else {
        // No extracted concept matched the bookmarked item — fall back
        // to a synthesized target so the bookmark still produces a
        // piece. `conceptId: ""` mirrors how adjacent items without a
        // matched concept are handled; downstream selection treats an
        // empty id as "no concept-graph dedupe key" without crashing.
        const fallbackName = item.title.replace(/^🔖\s*/, "").slice(0, 80) || "bookmarked-message";
        candidates.push({
          conceptName: fallbackName,
          conceptId: "",
          depthScore: 0,
          sourceType: "current-work",
          sourceDescription: enrichedDescription,
          selectionReasoning: `Bookmarked source (no matching concept): "${item.title.slice(0, 80)}"`,
          priority: 1,
          sourceContext: [sourceCtx],
        });
      }
    }

    // P2: Low-depth concepts from active work. On an additive refresh,
    // skip concepts that already have a piece on this briefing — the
    // whole point of preserving existing pieces is that we don't
    // re-teach what's already there. Also skip concepts already
    // claimed by the P1 bookmark tier so we don't double-book.
    const activeWorkConcepts = activeConcepts
      .filter(
        (c) =>
          !recentSet.has(c.id) &&
          (c.depth_score ?? 0) < 3 &&
          !existingPieceConceptIds.has(c.id) &&
          !bookmarkConceptIds.has(c.id),
      )
      .sort((a, b) => (a.depth_score ?? 0) - (b.depth_score ?? 0));

    for (const concept of activeWorkConcepts) {
      const { sources, bestDescription } = findRelatedWorkItems(concept.canonical_name);
      candidates.push({
        conceptName: concept.canonical_name,
        conceptId: concept.id,
        depthScore: concept.depth_score ?? 0,
        sourceType: "current-work",
        sourceDescription: bestDescription,
        selectionReasoning: `Active concept with depth ${(concept.depth_score ?? 0).toFixed(1)} — below fluency threshold`,
        priority: 2,
        sourceContext: sources,
      });
    }

    // P2: Adjacent external. Adjacent candidates whose matched concept
    // is already covered get filtered out on the additive path; an
    // adjacent without a matched concept still has no concept-id
    // dedupe key, so it passes through (acceptable — the article URL
    // dedupe is handled separately at insert time).
    for (const adj of adjacentStep.data.relevant.slice(0, 3)) {
      const matchedConcept = allConcepts.find((c) =>
        adj.relevanceConcepts.some((rc) => rc.toLowerCase() === c.canonical_name),
      );
      if (matchedConcept && existingPieceConceptIds.has(matchedConcept.id)) continue;
      candidates.push({
        conceptName: adj.relevanceConcepts[0] ?? adj.title,
        conceptId: matchedConcept?.id ?? "",
        depthScore: matchedConcept?.depth_score ?? 0,
        sourceType: "adjacent",
        sourceReference: adj.url,
        selectionReasoning: `Adjacent article "${adj.title}" (relevance: ${adj.relevanceScore.toFixed(2)})`,
        priority: 3,
        sourceContext: [
          {
            type: adj.source,
            title: adj.title,
            url: adj.url,
            summary: adj.summary,
            source: adj.source,
          },
        ],
      });
    }

    // P4: Decayed concepts. Same additive-refresh dedupe as above.
    const decayedConcepts = allConcepts
      .filter((c) => c.decay_warned_at && !recentSet.has(c.id) && !existingPieceConceptIds.has(c.id))
      .sort((a, b) => (a.depth_score ?? 0) - (b.depth_score ?? 0));

    for (const concept of decayedConcepts.slice(0, 2)) {
      candidates.push({
        conceptName: concept.canonical_name,
        conceptId: concept.id,
        depthScore: concept.depth_score ?? 0,
        sourceType: "decay-recalibrate",
        selectionReasoning: `Concept decaying from disuse — last exposed ${concept.last_exposed_at}`,
        priority: 4,
        sourceContext: [
          {
            type: "decay",
            title: concept.canonical_name,
            summary: `Last exposed ${concept.last_exposed_at ?? "unknown"}`,
          },
        ],
      });
    }

    // Score candidates against the user's current focus statement so
    // the focus actually steers selection — not just extraction. One
    // LLM call covers all candidates in this briefing. Skipped entirely
    // when the user has no focus set, in which case the sort below
    // falls back to the historical priority + depth ordering.
    //
    // Use the candidate's `conceptId` when present; for adjacent items
    // without a matched concept, fall back to a synthetic key built
    // from the candidate's array index so we can still re-rank them.
    let focusScores = new Map<string, number>();
    if (focusStatement && focusStatement.trim().length > 0 && candidates.length > 0) {
      const scorerInputs: FocusScorerCandidate[] = candidates.map((c, i) => ({
        id: c.conceptId || `__cand_${i}__`,
        name: c.conceptName,
        category: c.category,
        context: c.selectionReasoning,
      }));
      focusScores = await scoreCandidatesAgainstFocus(db, userId, llm, focusStatement, scorerInputs, focusScoringSpec);
    }
    const focusScoreFor = (c: TeachingTarget, i: number): number => {
      const key = c.conceptId || `__cand_${i}__`;
      // Missing scores default to 0.5 (neutral) so unscored candidates
      // don't get penalized to the bottom of their priority tier when
      // the LLM returns a partial response.
      return focusScores.get(key) ?? 0.5;
    };

    // Apply selection constraints. On the additive-refresh path the
    // cap shrinks to MAX_REFRESH_ADDITIONS so a chain of refreshes
    // doesn't grow a briefing without bound, and the
    // "must include 1 current-work piece" / MIN_PIECES invariants are
    // already satisfied by the preserved pieces — we don't re-enforce
    // them.
    const maxNewPieces = isAdditiveRefresh ? BRIEFING_RULES.MAX_REFRESH_ADDITIONS : BRIEFING_RULES.MAX_PIECES;
    const selected: TeachingTarget[] = [];
    const usedConceptIds = new Set<string>();
    let adjacentCount = 0;
    let decayCount = 0;
    let hasCurrentWork = false;

    // Sort by priority tier first (preserves P1/P2/P4 + min-current-work
    // invariants), then within each tier by focus relevance descending,
    // then by depth ascending (teach the weakest concept first). With
    // no focus statement, focusScoreFor returns 0.5 uniformly so this
    // collapses to today's priority + depth ordering.
    const indexed = candidates.map((c, i) => ({ c, i }));
    indexed.sort((a, b) => {
      if (a.c.priority !== b.c.priority) return a.c.priority - b.c.priority;
      const fa = focusScoreFor(a.c, a.i);
      const fb = focusScoreFor(b.c, b.i);
      if (fa !== fb) return fb - fa;
      return (a.c.depthScore ?? 0) - (b.c.depthScore ?? 0);
    });
    const sorted = indexed.map((x) => x.c);

    // Track why each candidate was kept or dropped, in pre-sort
    // order, for the pipeline trace. `selected: true` means it made
    // the final cut; otherwise `droppedReason` carries the first cap
    // it tripped. Order within the array mirrors the sorted order so
    // the trace renders highest-priority candidates first.
    type CandidateOutcome = {
      conceptName: string;
      conceptId: string;
      priority: number;
      depthScore: number;
      sourceType: string;
      focusScore: number;
      selected: boolean;
      droppedReason: string | null;
    };
    const candidateOutcomes: CandidateOutcome[] = [];
    const outcomeByCandidate = new Map<TeachingTarget, CandidateOutcome>();
    for (let i = 0; i < indexed.length; i++) {
      const c = indexed[i].c;
      const outcome: CandidateOutcome = {
        conceptName: c.conceptName,
        conceptId: c.conceptId,
        priority: c.priority,
        depthScore: c.depthScore,
        sourceType: c.sourceType,
        focusScore: focusScoreFor(c, indexed[i].i),
        selected: false,
        droppedReason: null,
      };
      candidateOutcomes.push(outcome);
      outcomeByCandidate.set(c, outcome);
    }

    for (const candidate of sorted) {
      const outcome = outcomeByCandidate.get(candidate);
      if (selected.length >= maxNewPieces) {
        if (outcome) outcome.droppedReason ??= "cap_max_pieces";
        continue;
      }
      if (candidate.conceptId && usedConceptIds.has(candidate.conceptId)) {
        if (outcome) outcome.droppedReason ??= "duplicate_concept";
        continue;
      }

      if (candidate.sourceType === "adjacent") {
        if (adjacentCount >= BRIEFING_RULES.MAX_ADJACENT_PIECES) {
          if (outcome) outcome.droppedReason ??= "cap_adjacent";
          continue;
        }
        adjacentCount++;
      }
      if (candidate.sourceType === "decay-recalibrate") {
        if (decayCount >= BRIEFING_RULES.MAX_DECAY_PIECES) {
          if (outcome) outcome.droppedReason ??= "cap_decay";
          continue;
        }
        decayCount++;
      }
      if (candidate.sourceType === "current-work") {
        hasCurrentWork = true;
      }

      selected.push(candidate);
      if (outcome) outcome.selected = true;
      if (candidate.conceptId) usedConceptIds.add(candidate.conceptId);
    }

    // Ensure at least 1 from current work — only on a fresh
    // generation. On an additive refresh the existing pieces already
    // satisfy this invariant, and the user explicitly wants the new
    // pieces to follow their current focus signal regardless of
    // source type.
    if (!isAdditiveRefresh && !hasCurrentWork && selected.length > 0 && activeWorkConcepts.length > 0) {
      const fallback = activeWorkConcepts.find((c) => !usedConceptIds.has(c.id));
      if (fallback) {
        if (selected.length >= maxNewPieces) selected.pop();
        const fallbackCtx = findRelatedWorkItems(fallback.canonical_name);
        selected.push({
          conceptName: fallback.canonical_name,
          conceptId: fallback.id,
          depthScore: fallback.depth_score ?? 0,
          sourceType: "current-work",
          sourceDescription: fallbackCtx.bestDescription,
          selectionReasoning: "Fallback: ensure at least one current-work piece",
          priority: 2,
          sourceContext: fallbackCtx.sources,
        });
      }
    }

    // Ensure minimum — only on a fresh generation. Additive refreshes
    // can legitimately produce zero new pieces (nothing in the user's
    // updated focus mapped to an uncovered concept), and that's fine
    // — the existing briefing remains intact.
    if (!isAdditiveRefresh) {
      while (selected.length < BRIEFING_RULES.MIN_PIECES && candidates.length > selected.length) {
        const next = sorted.find((c) => !selected.includes(c) && (!c.conceptId || !usedConceptIds.has(c.conceptId)));
        if (!next) break;
        selected.push(next);
        const nextOutcome = outcomeByCandidate.get(next);
        if (nextOutcome) {
          nextOutcome.selected = true;
          nextOutcome.droppedReason = null;
        }
        if (next.conceptId) usedConceptIds.add(next.conceptId);
      }
    }

    // Selecting is fast; record before kicking off generation.
    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "selecting",
      startedAt: stepStart,
      itemsProcessed: selected.length,
      metadata: {
        candidates: candidates.length,
        outcomes: candidateOutcomes,
      },
    });

    stepStart = Date.now();
    const piecesStart = Date.now();
    await updateProgress(db, briefingId, "generating_pieces", `Writing ${selected.length} teaching pieces…`);

    // Step 7: Generate teaching pieces (2 at a time for speed). On an
    // additive refresh, new pieces append after the highest existing
    // position so preserved pieces keep their order and new ones
    // appear at the end.
    let position = maxExistingPosition + 1;
    const pieceDetails: string[] = [];
    // Drafts the continuation classifier flagged as REDUNDANT — surfaced
    // to the briefing header as a "no new movement" chip so the user
    // knows the topic was considered (rather than silently dropped).
    // Each entry points at the predecessor piece so the chip can deep
    // link back to it.
    const redundantDrafts: Array<{
      predecessor_id: string;
      predecessor_title: string;
      predecessor_briefing_date: string;
      predecessor_series_id: string | null;
      predecessor_part_number: number | null;
      reason: string;
    }> = [];
    for (let ti = 0; ti < selected.length; ti += 2) {
      const batch = selected.slice(ti, ti + 2);
      const batchStart = ti + 1;
      const batchEnd = Math.min(ti + 2, selected.length);
      // "pieces 3 and 4 of 4" reads as plain English; the previous
      // "pieces 3–4 of 4" was ambiguous (range vs. fraction vs.
      // typo). Singular form drops the conjunction entirely on the
      // tail-end singleton ("piece 5 of 5").
      const range = batchStart === batchEnd ? `piece ${batchStart}` : `pieces ${batchStart} and ${batchEnd}`;
      await updateProgress(
        db,
        briefingId,
        "generating_pieces",
        `Writing ${range} of ${selected.length}: ${batch.map((t) => t.conceptName).join(", ")}`,
        pieceDetails,
        true,
      );

      await checkCancelled(db, briefingId);

      const batchResults = await Promise.all(
        batch.map(async (target) => {
          const pieceStartedAt = Date.now();
          const pieceStep = await safeStep(
            `teaching:${target.conceptName}`,
            async () => {
              return generateTeachingPiece(db, userId, llm, target, {
                modelSpec: teachingPieceSpec,
                aboutStatement,
                focusStatement,
                sourceContext: target.sourceContext,
              });
            },
            null,
          );
          return { target, pieceStep, pieceStartedAt };
        }),
      );

      // Writing is done for this batch; the inner loop now runs the
      // continuation classifier, optional regen, and the audit pass.
      // Update the progress label so the user sees "Auditing" rather
      // than a stale "Writing" while the audit (the slowest of the
      // three) is running.
      await updateProgress(
        db,
        briefingId,
        "generating_pieces",
        `Auditing ${range} of ${selected.length}: ${batch.map((t) => t.conceptName).join(", ")}`,
        pieceDetails,
        true,
      );

      for (const { target, pieceStep, pieceStartedAt } of batchResults) {
        // Pin the writer's wall-clock finish before the classifier
        // runs so the per-piece duration in the trace stays scoped
        // to the writer alone (audit + classifier get their own
        // accounting). The recordTiming call moves below so we can
        // fold in the classifier verdict; passing `finishedAt`
        // explicitly preserves the original duration.
        const writerFinishedAt = Date.now();

        if (pieceStep.error) {
          errors.push(pieceStep.error);
          pieceDetails.push(`✗ ${target.conceptName} — failed`);
          await recordTiming(db, {
            briefingId,
            userId,
            stepKey: "teaching_piece",
            startedAt: pieceStartedAt,
            finishedAt: writerFinishedAt,
            itemsProcessed: 0,
            modelUsed: teachingPieceSpec.model,
            metadata: {
              conceptName: target.conceptName,
              pieceType: null,
              targetDepth: target.depthScore,
              ok: false,
            },
          });
        } else if (pieceStep.data) {
          let piece = pieceStep.data;
          const conceptIds = target.conceptId ? [target.conceptId] : [];

          // Continuation gate: see if this draft is actually a follow-up
          // to a recent piece (or a near-duplicate). The classifier needs
          // both concept IDs and the source list to recall candidates,
          // and the draft body to make the additive-vs-redundant call.
          let classification: ClassificationResult | null = null;
          try {
            const candidates = await findCandidatePredecessors(db, userId, {
              title: piece.title,
              content: piece.content,
              conceptIds,
              conceptName: target.conceptName,
              sources: (target.sourceContext ?? []).map((s) => ({
                type: s.type,
                id: s.id,
                title: s.title,
                url: s.url,
                summary: s.summary,
              })),
            });
            if (candidates.length > 0) {
              classification = await classifyDraft(
                db,
                userId,
                llm,
                {
                  title: piece.title,
                  content: piece.content,
                  conceptIds,
                  conceptName: target.conceptName,
                  sources: (target.sourceContext ?? []).map((s) => ({
                    type: s.type,
                    id: s.id,
                    title: s.title,
                    url: s.url,
                    summary: s.summary,
                  })),
                },
                candidates,
                { modelSpec: continuationSpec },
              );
            }
          } catch (err) {
            // Fail-open: any classifier failure means we treat the draft
            // as NOVEL and persist normally. The pipeline must not lose a
            // piece because the continuation gate had a bad day.
            console.warn("[continuation-classifier] step failed; treating as NOVEL:", err);
          }

          // Record per-piece timing now that we know the classifier
          // verdict, but pin `finishedAt` to the writer's wall clock
          // so the duration in the trace is just the writer call
          // (audit + the optional continuation rewrite get their own
          // rows / fall under generating_pieces accounting).
          await recordTiming(db, {
            briefingId,
            userId,
            stepKey: "teaching_piece",
            startedAt: pieceStartedAt,
            finishedAt: writerFinishedAt,
            itemsProcessed: 1,
            modelUsed: teachingPieceSpec.model,
            metadata: {
              conceptName: target.conceptName,
              pieceType: piece.pieceType,
              targetDepth: target.depthScore,
              ok: true,
              continuation: classification
                ? {
                    classification: classification.classification,
                    predecessor_title: classification.predecessor?.title ?? null,
                    reason: classification.reason ?? null,
                  }
                : null,
            },
          });

          if (classification?.classification === "REDUNDANT" && classification.predecessor) {
            const pred = classification.predecessor;
            redundantDrafts.push({
              predecessor_id: pred.id,
              predecessor_title: pred.title,
              // Snapshot the predecessor's briefing date so the chip can
              // deep-link without a second query. Cheap because we already
              // pulled the row.
              predecessor_briefing_date: pred.briefingDate,
              predecessor_series_id: pred.seriesId,
              predecessor_part_number: pred.partNumber,
              reason: classification.reason,
            });
            pieceDetails.push(`↺ ${target.conceptName} — redundant with "${pred.title}"`);
            // Don't insert. Skip to next piece in the batch.
            continue;
          }

          // ADDITIVE: re-run teaching generation with the predecessor
          // context so the body opens with a real callback ("Last time we
          // looked at..."). Without this re-run, the body reads as a
          // standalone piece with a Part-N badge slapped on top — jarring.
          let seriesId: string | null = null;
          let partNumber: number | null = null;
          if (classification?.classification === "ADDITIVE_CONTINUATION" && classification.predecessor) {
            const pred = classification.predecessor;

            // Backfill the predecessor's series identity if it was a
            // standalone until now. The first time a series has more than
            // one part, we promote the predecessor to Part 1 retroactively.
            if (!pred.seriesId) {
              const newSeriesId = genId("pieceSeries");
              await db
                .prepare(`UPDATE teaching_pieces SET series_id = ?, part_number = 1 WHERE id = ? AND user_id = ?`)
                .bind(newSeriesId, pred.id, userId)
                .run();
              seriesId = newSeriesId;
              partNumber = 2;
            } else {
              seriesId = pred.seriesId;
              // The new piece is the next part after the highest existing
              // part number in the series. We re-query rather than
              // computing pred.partNumber + 1 because parallel drafts in
              // the same batch could otherwise collide on the same number.
              const maxRow = await db
                .prepare(`SELECT MAX(part_number) AS max_part FROM teaching_pieces WHERE series_id = ? AND user_id = ?`)
                .bind(seriesId, userId)
                .first<{ max_part: number | null }>();
              partNumber = (maxRow?.max_part ?? pred.partNumber ?? 1) + 1;
            }

            try {
              const continuationPiece = await generateTeachingPiece(db, userId, llm, target, {
                modelSpec: teachingPieceSpec,
                aboutStatement,
                focusStatement,
                continuation: {
                  predecessorTitle: pred.title,
                  predecessorDate: pred.briefingDate,
                  predecessorExcerpt: pred.bodyExcerpt,
                  newPartNumber: partNumber,
                },
              });
              piece = continuationPiece;
            } catch (err) {
              // If the rewrite fails, fall back to the original draft —
              // the Part-N badge will still appear, the body just won't
              // have a callback opener. That's a better failure mode than
              // dropping the piece outright.
              console.warn("[continuation] rewrite failed; using original draft:", err);
            }
          }

          pieceDetails.push(`✓ ${piece.title} (${piece.pieceType}, ${piece.readTimeMinutes}m)`);
          const pieceId = genId("teachingPiece");

          // ── Audit pass ──
          // Runs after the writer + continuation rewrite, BEFORE the
          // insert, so the persisted content reflects any patches /
          // drops the auditor applied. Audit rows are written to the
          // `audits` + `audit_claims` tables under the pieceId we just
          // minted. The auditor catches its own internal exceptions and
          // returns a status='failed' summary; this outer try/catch is
          // the belt to that suspenders — code paths in `auditContent`
          // run BEFORE its internal try (e.g. `withStrippedContent` and
          // the `audits` INSERT itself if the table is missing) can
          // still throw, and losing a whole briefing because the audit
          // tripped is the wrong failure mode. On a throw here, log and
          // publish the unaudited piece.
          const auditStartedAt = Date.now();
          try {
            const audited = await auditPiece({
              db,
              userId,
              llm,
              targetId: pieceId,
              content: piece.content,
              sources: target.sourceContext ?? [],
              auditSpec,
              patchSpec: auditPatchSpec,
            });
            piece = { ...piece, content: audited.content };
            await recordTiming(db, {
              briefingId,
              userId,
              stepKey: "piece_audit",
              startedAt: auditStartedAt,
              itemsProcessed: audited.audit.total_claims,
              modelUsed: auditSpec.model,
              metadata: {
                status: audited.audit.status,
                patched: audited.audit.patched_count,
                dropped: audited.audit.dropped_count,
                grounded_web: audited.audit.grounded_web_count,
                used_web_search: audited.audit.used_web_search,
              },
            });
          } catch (err) {
            console.warn("[briefing] audit step threw; publishing unaudited piece:", err);
            await recordTiming(db, {
              briefingId,
              userId,
              stepKey: "piece_audit",
              startedAt: auditStartedAt,
              itemsProcessed: 0,
              modelUsed: auditSpec.model,
              metadata: { status: "failed", threw: true },
            });
          }

          // Derive the piece's due_at + due_reason from its sources.
          // When multiple sources have deadlines, we pick the SOONEST as
          // the piece's deadline — the user should always see the most
          // urgent signal so they can prioritize. The reason is copied
          // from whichever source contributed that soonest date so the
          // tooltip explains *why* (e.g. "Linear ticket CIN-1234 is due
          // 2026-04-30").
          let pieceDueAt: string | null = null;
          let pieceDueReason: string | null = null;
          for (const src of target.sourceContext ?? []) {
            if (!src.dueAt) continue;
            if (pieceDueAt === null || src.dueAt < pieceDueAt) {
              pieceDueAt = src.dueAt;
              pieceDueReason = src.dueReason ?? null;
            }
          }

          await db
            .prepare(
              `INSERT INTO teaching_pieces
           (id, user_id, briefing_id, position, title, piece_type, source_type, source_reference,
            selection_reasoning, concepts, target_depth, content, read_time_minutes, model_used,
            source_context, due_at, due_reason, series_id, part_number, focus_version_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            )
            .bind(
              pieceId,
              userId,
              briefingId,
              position++,
              piece.title,
              piece.pieceType,
              target.sourceType,
              target.sourceReference ?? null,
              target.selectionReasoning,
              JSON.stringify(conceptIds),
              target.depthScore,
              JSON.stringify(piece.content),
              piece.readTimeMinutes,
              piece.modelUsed,
              JSON.stringify(target.sourceContext ?? []),
              pieceDueAt,
              pieceDueReason,
              seriesId,
              partNumber,
              focusVersionId,
            )
            .run();

          // Batched per-piece resource inserts. A teaching piece
          // typically carries 3–5 resources; serial INSERTs ran a
          // round-trip per row, batching collapses them into a single
          // D1 hop without changing semantics.
          if (piece.resources.length > 0) {
            const resourceInsert = db.prepare(
              `INSERT INTO piece_resources (id, user_id, teaching_piece_id, label, url, resource_type, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            );
            const resourceStatements = piece.resources.map((res, i) =>
              resourceInsert.bind(genId("pieceResource"), userId, pieceId, res.label, res.url, res.type, i),
            );
            await db.batch(resourceStatements);
          }
        }
      }
    }

    // Persist the redundant-drafts blob on the briefing in a single
    // write at the end of piece generation. Empty array still gets
    // written so the column transitions from NULL ("never set") to a
    // present-but-empty value once the pipeline has run; the frontend
    // distinguishes the two and only renders the chip when entries exist.
    if (redundantDrafts.length > 0) {
      await db
        .prepare(`UPDATE briefings SET redundant_drafts = ? WHERE id = ?`)
        .bind(JSON.stringify(redundantDrafts), briefingId)
        .run();
    }

    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "generating_pieces",
      startedAt: piecesStart,
      itemsProcessed: position,
      modelUsed: teachingPieceSpec.model,
      metadata: { selected: selected.length, generated: position },
    });

    stepStart = Date.now();
    await updateProgress(db, briefingId, "quiz", "Generating calibration quiz...");

    // Step 8: Generate calibration quiz for lowest-depth concept.
    // Skipped on additive refreshes — the briefing already has its
    // calibration quiz from the original generation, which still
    // points at a preserved teaching piece. Layering a second quiz
    // on top would be confusing noise.
    const lowestDepthTarget = isAdditiveRefresh
      ? undefined
      : selected.filter((t) => t.conceptId).sort((a, b) => a.depthScore - b.depthScore)[0];

    if (lowestDepthTarget?.conceptId) {
      const quizStep = await safeStep(
        "quiz_generation",
        async () => {
          return generateQuiz(db, userId, llm, lowestDepthTarget.conceptName, lowestDepthTarget.depthScore, {
            modelSpec: quizGenerationSpec,
            aboutStatement,
            focusStatement,
          });
        },
        null,
      );

      if (quizStep.data) {
        const quizId = genId("quiz");
        const pieceForConcept = await db
          .prepare(`SELECT id FROM teaching_pieces WHERE briefing_id = ? AND concepts LIKE ? LIMIT 1`)
          .bind(briefingId, `%${lowestDepthTarget.conceptId}%`)
          .first<{ id: string }>();

        // Audit the question text against the web-search backstop.
        // Quizzes have no local source bundle by construction — the
        // backstop is the only verification primitive available, so
        // `auditQuiz` forces `enableWebSearch=true` internally.
        // Same belt-and-suspenders rationale as the piece audit above:
        // an unhandled throw here used to sink the whole briefing.
        const quizAuditStartedAt = Date.now();
        let auditedQuestion = quizStep.data.question;
        try {
          const auditedQuiz = await auditQuiz({
            db,
            userId,
            llm,
            targetId: quizId,
            content: [{ type: "text", value: quizStep.data.question }],
            auditSpec,
            patchSpec: auditPatchSpec,
          });
          auditedQuestion =
            auditedQuiz.content[0]?.value && auditedQuiz.content[0].value.length > 0
              ? auditedQuiz.content[0].value
              : quizStep.data.question;
          await recordTiming(db, {
            briefingId,
            userId,
            stepKey: "quiz_audit",
            startedAt: quizAuditStartedAt,
            itemsProcessed: auditedQuiz.audit.total_claims,
            modelUsed: auditSpec.model,
            metadata: {
              status: auditedQuiz.audit.status,
              patched: auditedQuiz.audit.patched_count,
              dropped: auditedQuiz.audit.dropped_count,
            },
          });
        } catch (err) {
          console.warn("[briefing] quiz audit step threw; publishing unaudited question:", err);
          await recordTiming(db, {
            briefingId,
            userId,
            stepKey: "quiz_audit",
            startedAt: quizAuditStartedAt,
            itemsProcessed: 0,
            modelUsed: auditSpec.model,
            metadata: { status: "failed", threw: true },
          });
        }

        await db
          .prepare(
            `INSERT INTO calibration_quizzes
           (id, user_id, concept_id, teaching_piece_id, quiz_type, question, context,
            expected_depth_indicators, status, model_used, created_at)
           VALUES (?, ?, ?, ?, 'inline', ?, ?, ?, 'pending', ?, datetime('now'))`,
          )
          .bind(
            quizId,
            userId,
            lowestDepthTarget.conceptId,
            pieceForConcept?.id ?? null,
            auditedQuestion,
            quizStep.data.context,
            JSON.stringify(quizStep.data.expectedDepthIndicators),
            quizStep.data.modelUsed,
          )
          .run();
      }
      if (quizStep.error) errors.push(quizStep.error);
    }

    // Step 9: Store near misses. Batched into a single D1 round-trip
    // — up to 10 rows per briefing (the slice below caps the count),
    // each previously cost its own serial INSERT. `INSERT OR IGNORE`
    // keeps the dedupe semantics so a retry of the briefing
    // generation flow doesn't double-write.
    const nearMissBatch = adjacentStep.data.nearMisses.slice(0, 10);
    if (nearMissBatch.length > 0) {
      const nearMissInsert = db.prepare(
        `INSERT OR IGNORE INTO near_misses
         (id, user_id, briefing_id, source_type, title, url, source_label, relevance_score, exclusion_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      );
      const nearMissStatements = nearMissBatch.map((nm) =>
        nearMissInsert.bind(
          genId("nearMiss"),
          userId,
          briefingId,
          nm.source,
          nm.title,
          nm.url,
          nm.source,
          nm.relevanceScore,
          `Score ${nm.relevanceScore.toFixed(2)} below threshold 0.4`,
        ),
      );
      await db.batch(nearMissStatements);
    }

    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "quiz",
      startedAt: stepStart,
      itemsProcessed: lowestDepthTarget?.conceptId ? 1 : 0,
      modelUsed: quizGenerationSpec.model,
    });

    stepStart = Date.now();
    await updateProgress(db, briefingId, "finishing", "Finishing up...");

    // Greeting + work-context summary used to be generated here via a
    // dedicated chat-tier LLM call. Removed per user direction: the
    // greeting added visual noise to the briefing page and the
    // archive without offering navigation value (the date heading +
    // piece titles are already the "what is this" signal). The DB
    // columns (`greeting`, `work_context_summary`) remain in the
    // schema so existing rows still parse, but new briefings persist
    // them as NULL and the read paths no longer surface them.

    await recordTiming(db, {
      briefingId,
      userId,
      stepKey: "finishing",
      startedAt: stepStart,
      itemsProcessed: null,
    });

    // Finalize briefing.
    //
    // A briefing can finalize with zero teaching pieces in three
    // distinct ways; we tag the row with a structured `reason` so the
    // read endpoint and UI can show an explicit "why is this empty"
    // message instead of a silently-blank page (the original
    // missing-briefing bug):
    //   - no_candidates:    nothing surfaced from work + feeds + decay
    //   - all_pieces_failed: candidates existed but every LLM call errored
    //   - partial:           some pieces persisted but errors occurred
    // When pieces > 0 and no errors, no reason is set.
    const totalPieces = position;
    const status = errors.length > 0 ? "partial" : "generated";
    const noContentReason = classifyNoContentReason({
      totalPieces,
      selectedCount: selected.length,
      errorCount: errors.length,
    });

    await db
      .prepare(
        `UPDATE briefings SET status = ?, greeting = NULL, work_context_summary = NULL,
       work_context_sources = ?, metadata = ?, models_used = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
      )
      .bind(
        status,
        JSON.stringify(summarizeWorkContextSources(workContext)),
        JSON.stringify({
          conceptsExtracted: extractionStep.data.newConceptIds.length,
          existingConceptsReferenced: extractionStep.data.existingConceptIds.length,
          adjacentItemsScored: adjacentStep.data.relevant.length + adjacentStep.data.nearMisses.length,
          errors,
          totalPieces,
          candidateCount: candidates.length,
          selectedCount: selected.length,
          ...(noContentReason ? { reason: noContentReason } : {}),
        }),
        JSON.stringify(modelsUsed),
        briefingId,
        userId,
      )
      .run();

    return {
      briefingId,
      status,
      pieceCount: position,
      errors,
    };
  } catch (err) {
    if (err instanceof CancelledError) {
      console.log(`[briefing] Generation cancelled for ${briefingId}`);
      await db
        .prepare(`UPDATE briefings SET status = 'failed', metadata = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(JSON.stringify({ step: "cancelled", stepLabel: "Generation cancelled", reason: "cancelled" }), briefingId)
        .run();
      return { briefingId, status: "failed" as const, pieceCount: 0, errors: ["cancelled"] };
    }
    throw err;
  }
}
