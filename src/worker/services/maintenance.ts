import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { reapStuckNotifications } from "../db/notifications-queries.js";
import { recordTokenUsage } from "../db/queries.js";
import { llmClient } from "../integrations/llm/dispatcher.js";
import type { ModelSpec } from "../integrations/llm/types.js";
import type { Env } from "../types.js";
import { runDecayJob } from "./depth-manager.js";

function maintenanceSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.chat);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.chat };
}

export async function runMaintenanceJob(
  db: D1Database,
  userId: string,
  retentionDays: number,
  nearMissRetentionDays = 30,
  env?: Env,
): Promise<void> {
  await runDecayJob(db, userId);

  await db
    .prepare(
      `DELETE FROM near_misses
       WHERE user_id = ? AND created_at < datetime('now', '-' || ? || ' days')`,
    )
    .bind(userId, nearMissRetentionDays)
    .run();

  await db
    .prepare(
      `DELETE FROM discovered_items
       WHERE user_id = ? AND discovered_at < datetime('now', '-' || ? || ' days')`,
    )
    .bind(userId, nearMissRetentionDays)
    .run();

  // Sweep stuck in-progress notifications. A row that hasn't moved in
  // 5+ minutes almost certainly means the worker died mid-flight —
  // flipping it to `failed` unblocks the user (the bell shows a
  // "deep dive failed" they can dismiss and retry) instead of
  // leaving the spinner forever.
  try {
    await reapStuckNotifications(db, userId, 5);
  } catch (err) {
    console.warn(`[maintenance] notification reap failed for ${userId}:`, err);
  }

  await compactDepthHistory(db, userId, retentionDays);

  await pruneOldBriefingContent(db, userId, retentionDays);

  await compactChatThreads(db, userId, env);
}

async function compactDepthHistory(db: D1Database, userId: string, retentionDays: number): Promise<void> {
  const cutoff = `datetime('now', '-${retentionDays} days')`;

  const concepts = await db
    .prepare(
      `SELECT DISTINCT concept_id FROM concept_depth_history
       WHERE user_id = ? AND recorded_at < ${cutoff}`,
    )
    .bind(userId)
    .all<{ concept_id: string }>();

  for (const { concept_id } of concepts.results) {
    const months = await db
      .prepare(
        `SELECT strftime('%Y-%m', recorded_at) as month,
                AVG(depth_score) as avg_depth,
                AVG(confidence) as avg_confidence,
                COUNT(*) as entry_count,
                MIN(recorded_at) as first_recorded
         FROM concept_depth_history
         WHERE user_id = ? AND concept_id = ? AND recorded_at < ${cutoff}
         GROUP BY strftime('%Y-%m', recorded_at)
         HAVING entry_count > 1`,
      )
      .bind(userId, concept_id)
      .all<{
        month: string;
        avg_depth: number;
        avg_confidence: number;
        entry_count: number;
        first_recorded: string;
      }>();

    for (const month of months.results) {
      await db
        .prepare(
          `DELETE FROM concept_depth_history
           WHERE user_id = ? AND concept_id = ?
             AND strftime('%Y-%m', recorded_at) = ?
             AND recorded_at < ${cutoff}
             AND id NOT IN (
               SELECT id FROM concept_depth_history
               WHERE user_id = ? AND concept_id = ?
                 AND strftime('%Y-%m', recorded_at) = ?
                 AND recorded_at < ${cutoff}
               ORDER BY recorded_at ASC LIMIT 1
             )`,
        )
        .bind(userId, concept_id, month.month, userId, concept_id, month.month)
        .run();

      await db
        .prepare(
          `UPDATE concept_depth_history
           SET depth_score = ?, confidence = ?,
               change_detail = 'compacted monthly summary (' || ? || ' entries)'
           WHERE user_id = ? AND concept_id = ?
             AND strftime('%Y-%m', recorded_at) = ?
             AND recorded_at < ${cutoff}`,
        )
        .bind(
          Math.round(month.avg_depth * 100) / 100,
          Math.round(month.avg_confidence * 100) / 100,
          month.entry_count,
          userId,
          concept_id,
          month.month,
        )
        .run();
    }
  }
}

async function pruneOldBriefingContent(db: D1Database, userId: string, retentionDays: number): Promise<void> {
  await db
    .prepare(
      `UPDATE teaching_pieces SET content = '[]'
       WHERE user_id = ?
         AND briefing_id IN (
           SELECT id FROM briefings
           WHERE user_id = ? AND briefing_date < date('now', '-' || ? || ' days')
         )
         AND content != '[]'`,
    )
    .bind(userId, userId, retentionDays)
    .run();
}

async function compactChatThreads(db: D1Database, userId: string, env?: Env): Promise<void> {
  const staleThreads = await db
    .prepare(
      `SELECT t.id, t.summary
       FROM chat_threads t
       WHERE t.user_id = ?
         AND t.updated_at < datetime('now', '-30 days')
         AND t.summary IS NULL
         AND EXISTS (
           SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id
         )`,
    )
    .bind(userId)
    .all<{ id: string; summary: string | null }>();

  if (env?.ANTHROPIC_API_KEY) {
    const client = llmClient(env);
    const spec = maintenanceSpec();

    for (const thread of staleThreads.results) {
      const messages = await db
        .prepare(
          `SELECT role, content FROM chat_messages
           WHERE thread_id = ? AND user_id = ?
           ORDER BY created_at ASC`,
        )
        .bind(thread.id, userId)
        .all<{ role: string; content: string }>();

      const transcript = messages.results.map((m) => `${m.role}: ${m.content}`).join("\n\n");

      try {
        const response = await client.createMessage({
          spec,
          maxTokens: 512,
          system: "Summarize this conversation in 2-3 sentences, preserving key topics and outcomes.",
          messages: [{ role: "user", content: transcript }],
        });

        const firstText = response.content.find((b) => b.type === "text");
        const summary = firstText && firstText.type === "text" ? firstText.text : "";
        await recordTokenUsage(db, userId, "chat_compaction", spec, response.usage);

        await db
          .prepare(
            `UPDATE chat_threads SET summary = ?, compacted_at = datetime('now')
             WHERE id = ? AND user_id = ?`,
          )
          .bind(summary, thread.id, userId)
          .run();

        await db.prepare(`DELETE FROM chat_messages WHERE thread_id = ? AND user_id = ?`).bind(thread.id, userId).run();
      } catch (err) {
        console.error(`[maintenance] Failed to compact chat thread ${thread.id}:`, err);
      }
    }
  }

  await db
    .prepare(
      `DELETE FROM chat_messages
       WHERE user_id = ? AND thread_id IN (
         SELECT id FROM chat_threads
         WHERE user_id = ? AND updated_at < datetime('now', '-90 days')
       )`,
    )
    .bind(userId, userId)
    .run();

  await db
    .prepare(
      `DELETE FROM chat_threads
       WHERE user_id = ? AND updated_at < datetime('now', '-90 days')`,
    )
    .bind(userId, userId)
    .run();
}
