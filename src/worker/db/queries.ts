import { nanoid } from "nanoid";
import { ID_PREFIXES } from "../config/constants.js";
import { estimateLlmCost } from "../config/pricing.js";
import type { ModelSpec, NormalizedUsage } from "../integrations/llm/types.js";

type PrefixKey = keyof typeof ID_PREFIXES;

export function genId(prefix: PrefixKey): string {
  return `${ID_PREFIXES[prefix]}${nanoid(16)}`;
}

export async function createConcept(
  db: D1Database,
  userId: string,
  name: string,
  category?: string,
  description?: string,
  aliases?: string[],
  focusVersionId?: string | null,
): Promise<string> {
  const id = genId("concept");
  const canonicalName = name.trim().toLowerCase();

  await db
    .prepare(
      `INSERT INTO concepts (id, user_id, canonical_name, category, description, aliases, focus_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      userId,
      canonicalName,
      category ?? null,
      description ?? null,
      JSON.stringify(aliases ?? []),
      focusVersionId ?? null,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO concept_depth (concept_id, user_id, depth_score, confidence, created_at, updated_at)
       VALUES (?, ?, 0, 0, datetime('now'), datetime('now'))`,
    )
    .bind(id, userId)
    .run();

  return id;
}

export async function findConceptByName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<{
  id: string;
  canonical_name: string;
  aliases: string;
  category: string | null;
  description: string | null;
} | null> {
  return db
    .prepare("SELECT * FROM concepts WHERE user_id = ? AND canonical_name = ?")
    .bind(userId, name.trim().toLowerCase())
    .first();
}

interface ConceptWithDepthRow {
  id: string;
  canonical_name: string;
  aliases: string;
  category: string | null;
  description: string | null;
  suppressed_at: string | null;
  focus_version_id: string | null;
  depth_score: number;
  confidence: number;
  last_exposed_at: string | null;
  exposure_count: number;
  last_calibrated_at: string | null;
  decay_warned_at: string | null;
}

export async function getAllConcepts(db: D1Database, userId: string): Promise<ConceptWithDepthRow[]> {
  // `.all<T>()` is D1's typed all-rows accessor — we keep the row
  // shape on the prepared call instead of casting through `any`.
  // Pre-fix this returned `result.results as any`, which threw away
  // the type contract entirely; if the SELECT ever drifts (column
  // renamed, dropped) the call sites would silently keep typing
  // and only fail at runtime.
  const result = await db
    .prepare(
      `SELECT c.*, cd.depth_score, cd.confidence, cd.last_exposed_at,
              cd.exposure_count, cd.last_calibrated_at, cd.decay_warned_at
       FROM concepts c
       LEFT JOIN concept_depth cd ON c.id = cd.concept_id
       WHERE c.user_id = ?`,
    )
    .bind(userId)
    .all<ConceptWithDepthRow>();
  return result.results ?? [];
}

interface ActiveConceptRow {
  id: string;
  canonical_name: string;
  depth_score: number;
  confidence: number;
  last_exposed_at: string | null;
  exposure_count: number;
}

export async function getActiveConcepts(
  db: D1Database,
  userId: string,
  lookbackDays = 90,
): Promise<ActiveConceptRow[]> {
  const result = await db
    .prepare(
      `SELECT c.id, c.canonical_name, cd.depth_score, cd.confidence,
              cd.last_exposed_at, cd.exposure_count
       FROM concepts c
       LEFT JOIN concept_depth cd ON c.id = cd.concept_id
       WHERE c.user_id = ?
         AND c.suppressed_at IS NULL
         AND (cd.last_exposed_at >= datetime('now', '-' || ? || ' days')
              OR cd.depth_score >= 3
              OR cd.last_exposed_at IS NULL)`,
    )
    .bind(userId, lookbackDays)
    .all<ActiveConceptRow>();
  return result.results ?? [];
}

export async function addConceptAlias(db: D1Database, conceptId: string, alias: string): Promise<void> {
  const row = await db
    .prepare("SELECT aliases FROM concepts WHERE id = ?")
    .bind(conceptId)
    .first<{ aliases: string }>();

  if (!row) return;

  const aliases: string[] = JSON.parse(row.aliases || "[]");
  const normalized = alias.trim().toLowerCase();
  if (!aliases.includes(normalized)) {
    aliases.push(normalized);
    await db
      .prepare("UPDATE concepts SET aliases = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(aliases), conceptId)
      .run();
  }
}

export async function createRelation(
  db: D1Database,
  userId: string,
  sourceId: string,
  targetId: string,
  type: string,
): Promise<void> {
  const id = genId("conceptRelation");
  await db
    .prepare(
      `INSERT OR IGNORE INTO concept_relations (id, user_id, source_concept_id, target_concept_id, relation_type, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(id, userId, sourceId, targetId, type)
    .run();
}

export async function linkArtifact(
  db: D1Database,
  userId: string,
  conceptId: string,
  artifactType: string,
  artifactId: string,
  url?: string,
  title?: string,
): Promise<void> {
  const id = genId("conceptArtifact");
  await db
    .prepare(
      `INSERT OR IGNORE INTO concept_artifacts (id, user_id, concept_id, artifact_type, artifact_id, artifact_url, artifact_title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(id, userId, conceptId, artifactType, artifactId, url ?? null, title ?? null)
    .run();
}

export async function recordDepthChange(
  db: D1Database,
  userId: string,
  conceptId: string,
  depthScore: number,
  confidence: number,
  changeSource: string,
  changeDetail?: string,
): Promise<void> {
  const id = genId("depthHistory");
  await db
    .prepare(
      `INSERT INTO concept_depth_history (id, user_id, concept_id, depth_score, confidence, change_source, change_detail, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(id, userId, conceptId, depthScore, confidence, changeSource, changeDetail ?? null)
    .run();
}

export async function getRecentBriefingConceptIds(db: D1Database, userId: string, days = 5): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT DISTINCT tp.concepts
       FROM teaching_pieces tp
       JOIN briefings b ON tp.briefing_id = b.id
       WHERE tp.user_id = ? AND b.briefing_date >= date('now', '-' || ? || ' days')`,
    )
    .bind(userId, days)
    .all<{ concepts: string }>();

  const ids = new Set<string>();
  for (const row of result.results) {
    const parsed: string[] = JSON.parse(row.concepts || "[]");
    for (const id of parsed) ids.add(id);
  }
  return [...ids];
}

/**
 * Record an LLM call's token usage + cost into `usage_events`.
 *
 * Provider-aware shape: the caller passes a `ModelSpec` (so we know
 * which provider rate applies) and a `NormalizedUsage` (so reasoning +
 * cache tokens are captured even when the provider charges for them
 * separately). All four token-class columns persist; analytics +
 * budget enforcement read straight off the persisted row.
 *
 * Pre-computed `costUsd` lets the caller use the same number it
 * displayed to the user (no second pricing lookup); when omitted, the
 * helper computes it from the catalog so legacy callers don't have to.
 */
export async function recordTokenUsage(
  db: D1Database,
  userId: string,
  operation: string,
  spec: ModelSpec,
  usage: NormalizedUsage,
  costUsd?: number,
): Promise<void> {
  const id = genId("tokenUsage");
  const cost = typeof costUsd === "number" ? costUsd : estimateLlmCost(spec, usage);
  await db
    .prepare(
      `INSERT INTO usage_events (
        id, user_id, operation, modality, provider, model,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
        estimated_cost_usd, created_at
      )
      VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(
      id,
      userId,
      operation,
      spec.provider,
      spec.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.reasoningTokens ?? 0,
      usage.cacheReadTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
      cost,
    )
    .run();
}

/**
 * Record a TTS call's character count + cost.
 *
 * Same `usage_events` row shape as text — tokens are zero, audio_chars
 * captures the synthesis input length, voice carries the speaker id.
 * Pre-computed cost so the recorder doesn't have to re-derive the rate
 * from the catalog (the caller already did when displaying the cost
 * hint in the UI).
 */
export async function recordAudioUsage(
  db: D1Database,
  userId: string,
  operation: string,
  provider: string,
  model: string,
  voice: string | null,
  audioChars: number,
  costUsd: number,
): Promise<void> {
  const id = genId("tokenUsage");
  await db
    .prepare(
      `INSERT INTO usage_events (
        id, user_id, operation, modality, provider, model,
        audio_chars, voice, estimated_cost_usd, created_at
      )
      VALUES (?, ?, ?, 'tts', ?, ?, ?, ?, ?, datetime('now'))`,
    )
    // Bind order matches the SQL column order: provider, model,
    // audio_chars, voice, cost. (Modality is hard-coded in the VALUES
    // list, not bound.)
    .bind(id, userId, operation, provider, model, audioChars, voice, costUsd)
    .run();
}

export async function getMonthlySpend(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
       FROM usage_events
       WHERE user_id = ? AND created_at >= datetime('now', 'start of month')`,
    )
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function getMonthlySpendByProvider(db: D1Database, userId: string): Promise<Record<string, number>> {
  const rows = await db
    .prepare(
      `SELECT provider, COALESCE(SUM(estimated_cost_usd), 0) as total
       FROM usage_events
       WHERE user_id = ? AND created_at >= datetime('now', 'start of month')
       GROUP BY provider`,
    )
    .bind(userId)
    .all<{ provider: string; total: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results) out[r.provider] = r.total;
  return out;
}

export async function getMonthlySpendByModality(db: D1Database, userId: string): Promise<Record<string, number>> {
  const rows = await db
    .prepare(
      `SELECT modality, COALESCE(SUM(estimated_cost_usd), 0) as total
       FROM usage_events
       WHERE user_id = ? AND created_at >= datetime('now', 'start of month')
       GROUP BY modality`,
    )
    .bind(userId)
    .all<{ modality: string; total: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results) out[r.modality] = r.total;
  return out;
}

export async function isBudgetExceeded(db: D1Database, userId: string, capMonthly: number): Promise<boolean> {
  const spend = await getMonthlySpend(db, userId);
  return spend >= capMonthly;
}
