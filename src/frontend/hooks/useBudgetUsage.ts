import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../utils/api";

export interface BudgetUsageOperation {
  operation: string;
  modality: "text" | "tts";
  costUsd: number;
  calls: number;
}

export interface BudgetUsageProvider {
  provider: string;
  costUsd: number;
  calls: number;
}

export interface BudgetUsageData {
  cap: number;
  spend: number;
  monthStart: string;
  byOperation: BudgetUsageOperation[];
  byProvider: BudgetUsageProvider[];
}

/**
 * Month-to-date spend vs. the user's cap, with the use-case and
 * provider breakdowns that power the "battery usage"–style display
 * inside the Briefing limits settings panel. Returns `null` until
 * the first fetch resolves so the panel can render a skeleton state.
 *
 * Refetches on demand via the returned `reload` — call it after the
 * user edits the cap so the percentage updates without a full page
 * reload.
 */
export function useBudgetUsage() {
  const [data, setData] = useState<BudgetUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiGet<BudgetUsageData>("/api/analytics/budget");
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load budget usage");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}
