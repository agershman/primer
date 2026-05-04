import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../utils/api";

export interface BriefingTiming {
  id: string;
  briefingDate: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
  modelsUsed: Record<string, string>;
  totalMs: number;
  steps: Array<{
    stepKey: string;
    /**
     * Absolute ISO timestamp the step began executing (UTC). Used by the
     * waterfall view to compute each step's horizontal offset relative to
     * the earliest step in the briefing.
     */
    startedAt: string;
    /** Absolute ISO timestamp the step finished. */
    finishedAt: string;
    durationMs: number;
    itemsProcessed: number | null;
    modelUsed: string | null;
    metadata: Record<string, unknown> | null;
  }>;
}

export interface StepStat {
  stepKey: string;
  modelUsed: string | null;
  runs: number;
  itemsTotal: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface BriefingTotal {
  briefingId: string;
  briefingDate: string;
  totalMs: number;
}

export interface CostByDay {
  day: string;
  costUsd: number;
  tokens: number;
}

export interface PerformanceData {
  windowDays: number;
  stepStats: StepStat[];
  briefingTotals: BriefingTotal[];
  costByDay: CostByDay[];
}

export interface LearningData {
  windowDays: number;
  totalConcepts: number;
  depthDistribution: Array<{ bucket: number; count: number }>;
  conceptsAddedByDay: Array<{ day: string; count: number }>;
  topMovers: Array<{
    id: string;
    name: string;
    currentDepth: number;
    confidence: number;
    delta: number;
  }>;
  quizzes: { completed: number; cumulativeDepthGain: number };
  feedback: { positive: number; negative: number };
}

/**
 * Common usage metrics shape. Every cut on the usage endpoint
 * returns this same set of counters so the frontend can iterate
 * uniformly. `audioChars` is 0 for `text` modality rows; the token
 * counters are 0 for `tts` rows.
 */
export interface UsageMetrics {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  audioChars: number;
  costUsd: number;
}

export interface UsageData {
  windowDays: number;
  totals: UsageMetrics;
  byOperation: Array<UsageMetrics & { operation: string; modality: "text" | "tts" }>;
  byModel: Array<UsageMetrics & { provider: string; model: string; modality: "text" | "tts" }>;
  byOperationModel: Array<
    UsageMetrics & { operation: string; provider: string; model: string; modality: "text" | "tts" }
  >;
  byDay: Array<UsageMetrics & { day: string }>;
  currentTtsCharsInWindow: number;
  ttsCatalog: Array<{ id: string; label: string; provider: string; costPer1kChars: number }>;
}

export function useAnalytics(initialDays = 30) {
  const [days, setDays] = useState(initialDays);
  const [briefings, setBriefings] = useState<BriefingTiming[]>([]);
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [learning, setLearning] = useState<LearningData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, p, l, u] = await Promise.all([
        apiGet<{ briefings: BriefingTiming[] }>(`/api/analytics/briefings?limit=30`),
        apiGet<PerformanceData>(`/api/analytics/performance?days=${days}`),
        apiGet<LearningData>(`/api/analytics/learning?days=${days}`),
        apiGet<UsageData>(`/api/analytics/usage?days=${days}`),
      ]);
      setBriefings(b.briefings);
      setPerformance(p);
      setLearning(l);
      setUsage(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { days, setDays, briefings, performance, learning, usage, loading, error, reload };
}
