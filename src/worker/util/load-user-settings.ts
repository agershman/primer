import { isSourceId, type SourceId } from "../../shared/sources.js";
import { DEFAULT_SIGNAL_SURFACE_MAP } from "../config/signal-surfaces.js";
import type { UserSettings } from "../types.js";

/**
 * Load a user's `UserSettings` from the `user_settings` table.
 *
 * Mirrors the parsing the user-context middleware does on every API
 * request (auth boundary), but factored out so the scheduled cron
 * handler — which runs without a request context — can load the
 * same shape without re-implementing the JSON-column parsing.
 *
 * Returns `null` when the user has no `user_settings` row yet (a
 * brand-new user pre-onboarding). Callers can fall back to whatever
 * default behaviour they want; the briefing pipeline treats
 * `undefined` as "no settings, run with broad defaults" and that's
 * the lifecycle path's preference too.
 */
export async function loadUserSettingsFromDb(db: D1Database, userId: string): Promise<UserSettings | null> {
  const row = await db
    .prepare(
      `SELECT budget_cap_monthly, briefing_cron, relevance_threshold, near_miss_floor,
              retention_days, source_config, filter_prompt, source_filter_overrides,
              enabled_source_ids
       FROM user_settings WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{
      budget_cap_monthly: number | null;
      briefing_cron: string | null;
      relevance_threshold: number | null;
      near_miss_floor: number | null;
      retention_days: number | null;
      source_config: string | null;
      filter_prompt: string | null;
      source_filter_overrides: string | null;
      enabled_source_ids: string | null;
    }>();

  if (!row) return null;

  let sourceFilterOverrides: Record<string, string> = {};
  try {
    if (row.source_filter_overrides) {
      sourceFilterOverrides = JSON.parse(row.source_filter_overrides);
    }
  } catch {
    /* malformed JSON column — fall back to no overrides */
  }

  // Defensive narrowing at the trust boundary — the JSON column can in
  // principle hold any string (older deploys, bad PATCH input that
  // pre-dated validation, etc.). Drop anything that isn't a known
  // `SourceId` so downstream code can rely on the literal union.
  let enabledSourceIds: SourceId[] = [];
  try {
    if (row.enabled_source_ids) {
      const parsed = JSON.parse(row.enabled_source_ids);
      if (Array.isArray(parsed)) {
        enabledSourceIds = parsed.filter((v): v is SourceId => typeof v === "string" && isSourceId(v));
      }
    }
  } catch {
    /* malformed JSON — empty list means nothing fans out */
  }

  return {
    budgetCapMonthly: row.budget_cap_monthly ?? undefined,
    briefingCron: row.briefing_cron ?? undefined,
    relevanceThreshold: row.relevance_threshold ?? undefined,
    nearMissFloor: row.near_miss_floor ?? undefined,
    retentionDays: row.retention_days ?? undefined,
    signalSurfaceMap: row.source_config ? JSON.parse(row.source_config) : DEFAULT_SIGNAL_SURFACE_MAP,
    filterPrompt: row.filter_prompt ?? null,
    sourceFilterOverrides,
    enabledSourceIds,
  };
}
