/**
 * Shared building blocks for the briefing-generation pipeline.
 *
 * Centralised here so each step file can reach for the same retry,
 * cancellation, and progress-reporting primitives without crossing
 * into the orchestrator. The orchestrator in
 * [`../briefing-generator.ts`](../briefing-generator.ts) re-exports
 * the public bits so existing callers keep compiling.
 *
 * Adding or modifying a step? Read
 * [`.cursor/skills/add-pipeline-step/SKILL.md`](../../../../.cursor/skills/add-pipeline-step/SKILL.md)
 * BEFORE making changes. Every step must hold these four invariants:
 *
 *   - `await checkCancelled(db, briefingId)` at entry
 *   - `await updateProgress(...)` for the live status panel
 *   - `await safeStep("<id>", async () => { … })` to wrap risky work
 *   - `recordTiming(...)` for the analytics waterfall
 *
 * Skip any of these and you get subtle bugs: stuck-looking UI, the
 * whole briefing failing on a transient LLM 500, the analytics
 * waterfall missing a bar. None of them fail loudly.
 */

import { RETRY_CONFIG, retryDelay } from "../../config/constants.js";
import { listSourceInstances } from "../../db/source-instance-queries.js";
import type { SourceProvider, WorkContextItem } from "../../sources/index.js";

// Path is relative to `src/worker/services/briefing-generator/shared.ts`.
//
// The helper intentionally lives in a sibling directory keyed off
// the parent file's basename — `services/briefing-generator.ts`
// (assembly) + `services/briefing-generator/*.ts` (split bodies).
// Test helpers like `readSplitSource` rely on this naming convention
// when concatenating source-text contracts across the split.

export interface BriefingResult {
  briefingId: string;
  status: "generated" | "partial" | "failed";
  pieceCount: number;
  errors: string[];
}

/**
 * Sentinel error thrown by `checkCancelled` when the briefing's
 * `cancel_requested` flag has been flipped. The orchestrator
 * catches this in its top-level `try/catch` and converts it into
 * a clean `failed` row + early return — without it the cancel
 * would surface as a generic exception to the caller.
 */
export class CancelledError extends Error {
  constructor() {
    super("Briefing generation was cancelled");
    this.name = "CancelledError";
  }
}

export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      console.error(`[briefing] ${label} attempt ${attempt + 1} failed:`, err);
      if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }
  }
  throw lastError;
}

export async function safeStep<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<{ data: T; error: string | null }> {
  try {
    const data = await withRetry(label, fn);
    return { data, error: null };
  } catch (err) {
    console.error(`[briefing] ${label} failed permanently:`, err);
    return { data: fallback, error: label };
  }
}

export async function checkCancelled(db: D1Database, briefingId: string): Promise<void> {
  const row = await db
    .prepare("SELECT cancel_requested FROM briefings WHERE id = ?")
    .bind(briefingId)
    .first<{ cancel_requested: number }>();
  if (row && Number(row.cancel_requested) === 1) {
    throw new CancelledError();
  }
}

export async function updateProgress(
  db: D1Database,
  briefingId: string,
  step: string,
  stepLabel: string,
  details?: string[],
  waitingOnAi = false,
) {
  await checkCancelled(db, briefingId);
  await db
    .prepare("UPDATE briefings SET metadata = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(
      JSON.stringify({
        step,
        stepLabel,
        details: details ?? [],
        waitingOnAi,
        stepStartedAt: new Date().toISOString(),
      }),
      briefingId,
    )
    .run();
}

export function summarizeWorkContextSources(items: WorkContextItem[]) {
  const byType = new Map<string, WorkContextItem[]>();
  for (const item of items) {
    const list = byType.get(item.type) ?? [];
    list.push(item);
    byType.set(item.type, list);
  }
  const sources = [];
  for (const [type, typeItems] of byType) {
    sources.push({
      type,
      label: `${typeItems.length} ${type.replace(/_/g, " ")}${typeItems.length !== 1 ? "s" : ""}`,
      count: typeItems.length,
      items: typeItems.slice(0, 10).map((i) => ({ id: i.id, title: i.title, url: i.url })),
    });
  }
  return sources;
}

/**
 * Builds a parenthetical "(HN, CNCF, ArXiv…)" suffix for the
 * adjacent-scan progress strings, naming the user's actually-configured
 * feed instances rather than a hardcoded "HN, CNCF, ArXiv, AWS, GCP".
 *
 * Picks the first `max` enabled instance labels (alphabetical, matching
 * the order `listSourceInstances` returns) and appends `…` when there
 * are more configured than we're listing. Returns an empty string when
 * no feeds are enabled, so the caller can fall back to a plain "feeds"
 * mention without an awkward empty parenthetical.
 */
export async function summarizeFeedSources(
  db: D1Database,
  max = 3,
): Promise<{ labels: string[]; total: number; suffix: string }> {
  const instances = await listSourceInstances(db, { onlyEnabled: true });
  const labels = instances.slice(0, max).map((s) => s.label);
  const total = instances.length;
  if (total === 0 || labels.length === 0) {
    return { labels, total, suffix: "" };
  }
  const ellipsis = total > labels.length ? "…" : "";
  return { labels, total, suffix: ` (${labels.join(", ")}${ellipsis})` };
}

/**
 * Filter the registry's singleton providers down to those the user
 * has opted in to via `enabledSourceIds`. Pulled out as a pure
 * helper so the briefing-pipeline gate is testable without
 * standing up the full pipeline (D1, LLM, settings row, etc.) —
 * see `tests/unit/briefing-pipeline-gate.test.ts`.
 *
 * Semantics:
 *   - `undefined` enabled list = nothing is filtered (preserves
 *     pre-feature behaviour for any test or codepath that hasn't
 *     loaded settings yet).
 *   - empty array = nothing fans out. Caller's downstream pipeline
 *     handles the empty `workContext` case.
 *   - any provider whose id is in the list is kept.
 *
 * Type note: `enabledSourceIds` is `SourceId[]` upstream but
 * provider.id is generic `string`, so we widen to `Set<string>`
 * for the membership check. Runtime semantics are identical.
 */
export function selectEnabledSingletons(
  providers: SourceProvider[],
  enabledSourceIds: readonly string[] | undefined,
): SourceProvider[] {
  if (enabledSourceIds === undefined) return providers;
  const enabled: Set<string> = new Set(enabledSourceIds);
  return providers.filter((p) => enabled.has(p.id));
}
