import { Hono } from "hono";
import { TTS_MODELS } from "../config/constants.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const analyticsRoutes = new Hono<AppEnv>();

const STEP_ORDER = [
  "work_context",
  "slack_filter",
  "concepts",
  "adjacent",
  "selecting",
  "generating_pieces",
  "teaching_piece",
  "quiz",
  "finishing",
];

interface TimingRow {
  id: string;
  briefing_id: string;
  step_key: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  items_processed: number | null;
  model_used: string | null;
  metadata: string | null;
}

/**
 * GET /api/analytics/briefings
 *
 * Recent briefings with their step-level timings, suitable for showing a
 * timeline of recent runs. Joins `briefings` with `briefing_timings`.
 */
analyticsRoutes.get("/analytics/briefings", async (c) => {
  const user = c.get("user");
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);

  const briefings = await c.env.DB.prepare(
    `SELECT id, briefing_date, status, generated_at, created_at, updated_at, models_used
     FROM briefings
     WHERE user_id = ?
     ORDER BY briefing_date DESC
     LIMIT ?`,
  )
    .bind(user.userId, limit)
    .all<{
      id: string;
      briefing_date: string;
      status: string;
      generated_at: string | null;
      created_at: string;
      updated_at: string;
      models_used: string | null;
    }>();

  const ids = briefings.results.map((b) => b.id);
  if (ids.length === 0) return c.json({ briefings: [] });

  const placeholders = ids.map(() => "?").join(",");
  const timings = await c.env.DB.prepare(
    `SELECT id, briefing_id, step_key, started_at, finished_at, duration_ms,
            items_processed, model_used, metadata
     FROM briefing_timings
     WHERE briefing_id IN (${placeholders})
     ORDER BY started_at ASC`,
  )
    .bind(...ids)
    .all<TimingRow>();

  const byBriefing = new Map<string, TimingRow[]>();
  for (const t of timings.results) {
    if (!byBriefing.has(t.briefing_id)) byBriefing.set(t.briefing_id, []);
    byBriefing.get(t.briefing_id)!.push(t);
  }

  return c.json({
    briefings: briefings.results.map((b) => {
      const ts = byBriefing.get(b.id) ?? [];
      const totalMs = ts.reduce((s, t) => s + t.duration_ms, 0);
      return {
        id: b.id,
        briefingDate: b.briefing_date,
        status: b.status,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        generatedAt: b.generated_at,
        modelsUsed: b.models_used ? JSON.parse(b.models_used) : {},
        totalMs,
        steps: ts.map((t) => ({
          stepKey: t.step_key,
          // Expose absolute start/finish timestamps so the frontend can
          // render a true trace-waterfall view: each row's horizontal
          // offset comes from `startedAt - briefingStartedAt`, and width
          // comes from `durationMs`. Without these the chart can only
          // show stacked durations, which hides parallelism (e.g. five
          // teaching pieces generating concurrently).
          startedAt: t.started_at,
          finishedAt: t.finished_at,
          durationMs: t.duration_ms,
          itemsProcessed: t.items_processed,
          modelUsed: t.model_used,
          metadata: t.metadata ? JSON.parse(t.metadata) : null,
        })),
      };
    }),
  });
});

/**
 * GET /api/analytics/performance
 *
 * Aggregate per-step duration stats over a window, broken down by model.
 * Lets you see whether switching Sonnet→Haiku for a given operation
 * actually changes the average duration.
 */
analyticsRoutes.get("/analytics/performance", async (c) => {
  const user = c.get("user");
  const days = Math.min(parseInt(c.req.query("days") || "30", 10), 365);

  const rows = await c.env.DB.prepare(
    `SELECT step_key, model_used, duration_ms, items_processed, started_at
     FROM briefing_timings
     WHERE user_id = ?
       AND created_at > datetime('now', '-' || ? || ' days')
     ORDER BY started_at ASC`,
  )
    .bind(user.userId, days)
    .all<{
      step_key: string;
      model_used: string | null;
      duration_ms: number;
      items_processed: number | null;
      started_at: string;
    }>();

  // Aggregate by (step_key, model_used).
  const buckets = new Map<
    string,
    { stepKey: string; modelUsed: string | null; durations: number[]; itemsTotal: number; runs: number }
  >();
  for (const r of rows.results) {
    const key = `${r.step_key}::${r.model_used ?? ""}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        stepKey: r.step_key,
        modelUsed: r.model_used,
        durations: [],
        itemsTotal: 0,
        runs: 0,
      });
    }
    const b = buckets.get(key)!;
    b.durations.push(r.duration_ms);
    b.itemsTotal += r.items_processed ?? 0;
    b.runs += 1;
  }

  const stepStats = Array.from(buckets.values()).map((b) => {
    const sorted = [...b.durations].sort((a, b) => a - b);
    const sum = sorted.reduce((s, d) => s + d, 0);
    return {
      stepKey: b.stepKey,
      modelUsed: b.modelUsed,
      runs: b.runs,
      itemsTotal: b.itemsTotal,
      avgMs: Math.round(sum / sorted.length),
      p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
    };
  });

  // Sort by canonical step order, then by model.
  stepStats.sort((a, b) => {
    const ai = STEP_ORDER.indexOf(a.stepKey);
    const bi = STEP_ORDER.indexOf(b.stepKey);
    if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return (a.modelUsed ?? "").localeCompare(b.modelUsed ?? "");
  });

  // Per-briefing total trend (last N briefings).
  const totals = await c.env.DB.prepare(
    `SELECT b.id, b.briefing_date, COALESCE(SUM(t.duration_ms), 0) as total_ms
     FROM briefings b
     LEFT JOIN briefing_timings t ON t.briefing_id = b.id
     WHERE b.user_id = ?
       AND b.created_at > datetime('now', '-' || ? || ' days')
       AND b.status IN ('generated', 'partial')
     GROUP BY b.id
     ORDER BY b.briefing_date ASC`,
  )
    .bind(user.userId, days)
    .all<{ id: string; briefing_date: string; total_ms: number }>();

  // Cost trend from the unified usage_events ledger.
  // We pull per-(day, provider, modality) buckets so the frontend can
  // render stacked bars without a second query. The total per day is
  // recomputed JS-side rather than asking SQLite for a ROLLUP, which
  // keeps the query simple and the result set small.
  const cost = await c.env.DB.prepare(
    `SELECT date(created_at) as day,
            provider,
            modality,
            SUM(estimated_cost_usd) as cost_usd,
            SUM(input_tokens + output_tokens + reasoning_tokens) as tokens,
            SUM(audio_chars) as chars
     FROM usage_events
     WHERE user_id = ?
       AND created_at > datetime('now', '-' || ? || ' days')
     GROUP BY day, provider, modality
     ORDER BY day ASC`,
  )
    .bind(user.userId, days)
    .all<{
      day: string;
      provider: string;
      modality: string;
      cost_usd: number | null;
      tokens: number | null;
      chars: number | null;
    }>();

  // Roll up the per-bucket rows into per-day records with provider +
  // modality breakdowns. Stacked-bar friendly shape so the chart can
  // render without re-aggregating.
  type DailyCost = {
    day: string;
    costUsd: number;
    tokens: number;
    audioChars: number;
    byProvider: Record<string, number>;
    byModality: Record<string, number>;
  };
  const byDay = new Map<string, DailyCost>();
  for (const r of cost.results) {
    let day = byDay.get(r.day);
    if (!day) {
      day = { day: r.day, costUsd: 0, tokens: 0, audioChars: 0, byProvider: {}, byModality: {} };
      byDay.set(r.day, day);
    }
    const c = r.cost_usd ?? 0;
    day.costUsd += c;
    day.tokens += r.tokens ?? 0;
    day.audioChars += r.chars ?? 0;
    day.byProvider[r.provider] = (day.byProvider[r.provider] ?? 0) + c;
    day.byModality[r.modality] = (day.byModality[r.modality] ?? 0) + c;
  }
  const costByDay = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));

  // Monthly summary cards (for the overview panel above the trendline).
  // Computed from the same window, not strictly month-to-date — the
  // frontend treats this as "spend over the analytics window" so the
  // two totals match what the trendline shows below.
  const monthlyByProvider: Record<string, number> = {};
  const monthlyByModality: Record<string, number> = {};
  for (const r of cost.results) {
    const c = r.cost_usd ?? 0;
    monthlyByProvider[r.provider] = (monthlyByProvider[r.provider] ?? 0) + c;
    monthlyByModality[r.modality] = (monthlyByModality[r.modality] ?? 0) + c;
  }

  return c.json({
    windowDays: days,
    stepStats,
    briefingTotals: totals.results.map((t) => ({
      briefingId: t.id,
      briefingDate: t.briefing_date,
      totalMs: t.total_ms,
    })),
    costByDay,
    monthlyByProvider,
    monthlyByModality,
  });
});

/**
 * GET /api/analytics/learning
 *
 * Concept growth, depth distribution, quiz accuracy, and feedback volume.
 */
analyticsRoutes.get("/analytics/learning", async (c) => {
  const user = c.get("user");
  const days = Math.min(parseInt(c.req.query("days") || "30", 10), 365);

  // Total concepts and current depth distribution.
  const conceptCount = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM concepts WHERE user_id = ?`)
    .bind(user.userId)
    .first<{ count: number }>();

  // depth_score and confidence live in concept_depth, not concepts.
  const depthDistRows = await c.env.DB.prepare(
    `SELECT CAST(ROUND(COALESCE(cd.depth_score, 0)) AS INTEGER) as bucket, COUNT(*) as count
     FROM concepts c
     LEFT JOIN concept_depth cd ON cd.concept_id = c.id AND cd.user_id = c.user_id
     WHERE c.user_id = ?
     GROUP BY bucket
     ORDER BY bucket ASC`,
  )
    .bind(user.userId)
    .all<{ bucket: number; count: number }>();

  // Concepts added per day in the window.
  const addedByDay = await c.env.DB.prepare(
    `SELECT date(c.created_at) as day, COUNT(*) as count
     FROM concepts c
     WHERE c.user_id = ?
       AND c.created_at > datetime('now', '-' || ? || ' days')
     GROUP BY day
     ORDER BY day ASC`,
  )
    .bind(user.userId, days)
    .all<{ day: string; count: number }>();

  // Concept depth movers — concepts whose current depth differs most from
  // their depth at the start of the window. Uses concept_depth_history
  // (recorded on every change) to find the baseline value.
  const movers = await c.env.DB.prepare(
    `SELECT c.id, c.canonical_name, cd.depth_score, cd.confidence,
            (
              SELECT depth_score FROM concept_depth_history
              WHERE concept_id = c.id AND user_id = ?
                AND recorded_at <= datetime('now', '-' || ? || ' days')
              ORDER BY recorded_at DESC LIMIT 1
            ) as baseline
     FROM concepts c
     LEFT JOIN concept_depth cd ON cd.concept_id = c.id AND cd.user_id = c.user_id
     WHERE c.user_id = ?`,
  )
    .bind(user.userId, days, user.userId)
    .all<{
      id: string;
      canonical_name: string;
      depth_score: number | null;
      confidence: number | null;
      baseline: number | null;
    }>();

  const moversWithDelta = movers.results
    .map((m) => ({
      id: m.id,
      name: m.canonical_name,
      currentDepth: m.depth_score ?? 0,
      confidence: m.confidence ?? 0,
      delta: m.baseline != null ? (m.depth_score ?? 0) - m.baseline : null,
    }))
    .filter((m) => m.delta !== null && Math.abs(m.delta!) > 0.001) as Array<{
    id: string;
    name: string;
    currentDepth: number;
    confidence: number;
    delta: number;
  }>;

  moversWithDelta.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // Quiz completion + cumulative depth gain attributed to quizzes.
  const quizzes = await c.env.DB.prepare(
    `SELECT status, completed_at
     FROM calibration_quizzes
     WHERE user_id = ?
       AND completed_at IS NOT NULL
       AND completed_at > datetime('now', '-' || ? || ' days')
     ORDER BY completed_at ASC`,
  )
    .bind(user.userId, days)
    .all<{ status: string; completed_at: string }>();

  const quizCount = quizzes.results.length;

  // Sum positive depth changes recorded with change_source = 'quiz'.
  // Use a subquery to avoid SQLite ambiguity between MAX() aggregate and
  // MAX() scalar when nested inside SUM().
  const quizGainRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(gain), 0) as total FROM (
       SELECT CASE WHEN depth_score > 0 THEN depth_score ELSE 0 END as gain
       FROM concept_depth_history
       WHERE user_id = ?
         AND change_source = 'quiz'
         AND recorded_at > datetime('now', '-' || ? || ' days')
     )`,
  )
    .bind(user.userId, days)
    .first<{ total: number }>();
  const quizGain = quizGainRow?.total ?? 0;

  // Feedback volume.
  const feedback = await c.env.DB.prepare(
    `SELECT feedback, COUNT(*) as count
     FROM teaching_pieces
     WHERE user_id = ?
       AND feedback IS NOT NULL
       AND created_at > datetime('now', '-' || ? || ' days')
     GROUP BY feedback`,
  )
    .bind(user.userId, days)
    .all<{ feedback: string; count: number }>();

  const feedbackByType: Record<string, number> = {};
  for (const f of feedback.results) feedbackByType[f.feedback] = f.count;

  return c.json({
    windowDays: days,
    totalConcepts: conceptCount?.count ?? 0,
    depthDistribution: depthDistRows.results,
    conceptsAddedByDay: addedByDay.results,
    topMovers: moversWithDelta.slice(0, 10),
    quizzes: {
      completed: quizCount,
      cumulativeDepthGain: quizGain,
    },
    feedback: {
      positive: feedbackByType.positive ?? 0,
      negative: feedbackByType.negative ?? 0,
    },
  });
});

/**
 * GET /api/analytics/usage
 *
 * Token + audio-character breakdowns from the unified `usage_events`
 * ledger. The `/performance` endpoint surfaces a per-day cost trend
 * (high-level "are we trending up?" signal); this endpoint surfaces
 * the underlying volume so the user can:
 *
 *   1. Tune — see which operation × model combo is consuming the
 *      most tokens or characters per call. Concept extraction at
 *      4× the chars-per-call of teaching pieces is a clear "make
 *      that prompt tighter" signal.
 *
 *   2. Control costs — see which operations are the bulk of spend,
 *      and decide whether to swap a model down a tier (e.g. if
 *      `chat_title` is using Sonnet but only consumes ~30 output
 *      tokens, Haiku is fine).
 *
 *   3. Project costs — for TTS specifically, project what spend
 *      WOULD be if we swapped all character volume to a different
 *      provider (ElevenLabs Turbo vs OpenAI tts-1 vs Cloudflare
 *      Aura). The math is straightforward (chars × per-1k rate);
 *      we ship the candidate catalog so the frontend can render
 *      a comparison table without a second fetch.
 *
 * Response shape:
 *   - totals: aggregate across all rows in window.
 *   - byOperation: per-operation row (operation × modality).
 *   - byModel: per-(provider, model) row.
 *   - byOperationModel: per-(operation, provider, model) row —
 *     most granular cut, drives "drill down by use case".
 *   - byDay: per-day rollup (token + char + cost) for the
 *     time-series chart.
 *   - ttsCatalog: { id, label, provider, costPer1kChars } so the
 *     frontend can render TTS provider projections.
 *   - currentTtsCharsInWindow: total TTS chars in the window —
 *     the input to the projection calc on the client.
 */
analyticsRoutes.get("/analytics/usage", async (c) => {
  const user = c.get("user");
  const days = Math.min(parseInt(c.req.query("days") || "30", 10), 365);

  // Single query — group by every dimension we'll need on the
  // client side, JS-side aggregation rolls those into the
  // operation / model / day cuts. Cheaper than 4 separate queries
  // and keeps the SQL readable.
  const rows = await c.env.DB.prepare(
    `SELECT operation, modality, provider, model, voice,
            date(created_at) as day,
            COUNT(*) as calls,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(reasoning_tokens) as reasoning_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(cache_write_tokens) as cache_write_tokens,
            SUM(audio_chars) as audio_chars,
            SUM(estimated_cost_usd) as cost_usd
     FROM usage_events
     WHERE user_id = ?
       AND created_at > datetime('now', '-' || ? || ' days')
     GROUP BY operation, modality, provider, model, voice, day
     ORDER BY day ASC`,
  )
    .bind(user.userId, days)
    .all<{
      operation: string;
      modality: string;
      provider: string;
      model: string;
      voice: string | null;
      day: string;
      calls: number;
      input_tokens: number | null;
      output_tokens: number | null;
      reasoning_tokens: number | null;
      cache_read_tokens: number | null;
      cache_write_tokens: number | null;
      audio_chars: number | null;
      cost_usd: number | null;
    }>();

  interface UsageMetrics {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    audioChars: number;
    costUsd: number;
  }
  const blank = (): UsageMetrics => ({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    audioChars: 0,
    costUsd: 0,
  });
  function add(target: UsageMetrics, row: (typeof rows.results)[number]): void {
    target.calls += row.calls;
    target.inputTokens += row.input_tokens ?? 0;
    target.outputTokens += row.output_tokens ?? 0;
    target.reasoningTokens += row.reasoning_tokens ?? 0;
    target.cacheReadTokens += row.cache_read_tokens ?? 0;
    target.cacheWriteTokens += row.cache_write_tokens ?? 0;
    target.audioChars += row.audio_chars ?? 0;
    target.costUsd += row.cost_usd ?? 0;
  }

  const totals = blank();
  const byOperation = new Map<string, UsageMetrics & { operation: string; modality: string }>();
  const byModel = new Map<string, UsageMetrics & { provider: string; model: string; modality: string }>();
  const byOperationModel = new Map<
    string,
    UsageMetrics & { operation: string; provider: string; model: string; modality: string }
  >();
  const byDay = new Map<string, UsageMetrics & { day: string }>();

  let currentTtsCharsInWindow = 0;
  for (const r of rows.results) {
    add(totals, r);
    if (r.modality === "tts") currentTtsCharsInWindow += r.audio_chars ?? 0;

    const opKey = `${r.operation}::${r.modality}`;
    const opBucket = byOperation.get(opKey) ?? {
      operation: r.operation,
      modality: r.modality,
      ...blank(),
    };
    add(opBucket, r);
    byOperation.set(opKey, opBucket);

    const modelKey = `${r.provider}::${r.model}::${r.modality}`;
    const modelBucket = byModel.get(modelKey) ?? {
      provider: r.provider,
      model: r.model,
      modality: r.modality,
      ...blank(),
    };
    add(modelBucket, r);
    byModel.set(modelKey, modelBucket);

    const opModelKey = `${r.operation}::${r.provider}::${r.model}`;
    const opModelBucket = byOperationModel.get(opModelKey) ?? {
      operation: r.operation,
      provider: r.provider,
      model: r.model,
      modality: r.modality,
      ...blank(),
    };
    add(opModelBucket, r);
    byOperationModel.set(opModelKey, opModelBucket);

    const dayBucket = byDay.get(r.day) ?? { day: r.day, ...blank() };
    add(dayBucket, r);
    byDay.set(r.day, dayBucket);
  }

  // Sort each cut by cost desc so the user immediately sees the
  // biggest contributors. Day rollup stays in chronological order
  // for the trend chart.
  const sortByCost = <T extends { costUsd: number }>(arr: T[]): T[] => arr.sort((a, b) => b.costUsd - a.costUsd);

  // TTS catalog ships only the fields needed for the projection
  // table — id, human label, provider, per-1k char rate. The full
  // catalog (with description / tier / voice id) is already fetched
  // separately by `/api/tts-models` for the Settings panel.
  const ttsCatalog = TTS_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    costPer1kChars: m.costPer1kChars,
  }));

  return c.json({
    windowDays: days,
    totals,
    byOperation: sortByCost(Array.from(byOperation.values())),
    byModel: sortByCost(Array.from(byModel.values())),
    byOperationModel: sortByCost(Array.from(byOperationModel.values())),
    byDay: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    currentTtsCharsInWindow,
    ttsCatalog,
  });
});
