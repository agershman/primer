import { genId } from "../db/queries.js";

/**
 * Per-step timing capture for briefing generation analytics.
 *
 * The generator emits one row per pipeline step (work_context, concepts,
 * adjacent, etc.) and one row per teaching piece. Aggregations live in
 * /api/analytics/* — see routes/analytics.ts.
 *
 * Failure-safe: if a timing write fails, we log and swallow. We never want
 * analytics infrastructure to take down a real briefing run.
 */

export interface TimingRecord {
  briefingId: string;
  userId: string;
  stepKey: string;
  startedAt: number; // Date.now() value
  finishedAt?: number; // defaults to Date.now() at write time
  itemsProcessed?: number | null;
  modelUsed?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordTiming(db: D1Database, record: TimingRecord): Promise<void> {
  const finishedAt = record.finishedAt ?? Date.now();
  const durationMs = Math.max(0, finishedAt - record.startedAt);
  try {
    await db
      .prepare(
        `INSERT INTO briefing_timings
         (id, briefing_id, user_id, step_key, started_at, finished_at,
          duration_ms, items_processed, model_used, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .bind(
        genId("briefingTiming"),
        record.briefingId,
        record.userId,
        record.stepKey,
        new Date(record.startedAt).toISOString(),
        new Date(finishedAt).toISOString(),
        durationMs,
        record.itemsProcessed ?? null,
        record.modelUsed ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      )
      .run();
  } catch (err) {
    console.error("[timing] failed to record:", record.stepKey, err);
  }
}

/**
 * Convenience wrapper: time an async block and record on success or failure.
 */
export async function measureStep<T>(
  db: D1Database,
  briefingId: string,
  userId: string,
  stepKey: string,
  fn: () => Promise<T>,
  meta?: { modelUsed?: string; metadata?: Record<string, unknown> },
): Promise<{ result: T | null; itemsProcessed: number | null; ok: boolean }> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const itemsProcessed = inferItemCount(result);
    await recordTiming(db, {
      briefingId,
      userId,
      stepKey,
      startedAt,
      itemsProcessed,
      modelUsed: meta?.modelUsed ?? null,
      metadata: meta?.metadata ?? null,
    });
    return { result, itemsProcessed, ok: true };
  } catch (err) {
    await recordTiming(db, {
      briefingId,
      userId,
      stepKey,
      startedAt,
      itemsProcessed: null,
      modelUsed: meta?.modelUsed ?? null,
      metadata: { ...(meta?.metadata ?? {}), error: String(err) },
    });
    throw err;
  }
}

function inferItemCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.concepts)) return obj.concepts.length;
    if (Array.isArray(obj.items)) return obj.items.length;
    if (Array.isArray(obj.results)) return obj.results.length;
  }
  return null;
}
