import { DECAY_RULES, FEEDBACK_RULES } from "../config/constants.js";
import { recordDepthChange } from "../db/queries.js";

interface ConceptDepthRow {
  concept_id: string;
  user_id: string;
  depth_score: number;
  confidence: number;
  last_calibrated_at: string | null;
  last_exposed_at: string | null;
  exposure_count: number;
  decay_warned_at: string | null;
}

// --- Pure scoring functions (exported for testing) ---

export function computePositiveFeedback(
  currentDepth: number,
  currentConfidence: number,
): { newDepth: number; newConfidence: number } {
  const maxDepth = currentDepth + FEEDBACK_RULES.MAX_DEPTH_BUMP_ABOVE_CURRENT;
  const newDepth = Math.min(currentDepth + FEEDBACK_RULES.POSITIVE_DEPTH_DELTA, maxDepth, 5);
  const newConfidence = Math.min(currentConfidence + FEEDBACK_RULES.POSITIVE_CONFIDENCE_DELTA, 1);
  return { newDepth, newConfidence };
}

export function computeQuizResult(assessedDepth: number): { newDepth: number; newConfidence: number } {
  return { newDepth: Math.min(Math.max(assessedDepth, 0), 5), newConfidence: 0.8 };
}

export function computeQuizSkip(currentConfidence: number): { newConfidence: number } {
  return { newConfidence: Math.max(currentConfidence - 0.1, 0) };
}

export function computeDecay(
  depthScore: number,
  confidence: number,
  lastExposedAt: string | null,
  lastCalibratedAt: string | null,
  decayWarnedAt: string | null,
  now: Date,
): { action: "none" | "warn" | "decay" | "severe_decay"; newDepth: number; newConfidence: number } {
  if (depthScore < 2) return { action: "none", newDepth: depthScore, newConfidence: confidence };

  const lastActive = lastExposedAt ?? lastCalibratedAt;
  if (!lastActive) return { action: "none", newDepth: depthScore, newConfidence: confidence };

  const daysSinceActive = (now.getTime() - new Date(lastActive).getTime()) / 86_400_000;

  if (daysSinceActive >= DECAY_RULES.SEVERE_DECAY_AFTER_DAYS && decayWarnedAt) {
    let newDepth = depthScore - DECAY_RULES.DEPTH_DECAY_PER_PERIOD;
    const newConfidence = Math.max(confidence - DECAY_RULES.CONFIDENCE_DECAY_PER_PERIOD, 0);

    if (lastCalibratedAt) {
      newDepth = Math.max(newDepth, DECAY_RULES.FLOOR_IF_CALIBRATED);
    }
    newDepth = Math.max(newDepth, 0);

    return { action: "severe_decay", newDepth, newConfidence };
  }

  if (daysSinceActive >= DECAY_RULES.DECAY_AFTER_DAYS && decayWarnedAt) {
    let newDepth = depthScore - DECAY_RULES.DEPTH_DECAY_PER_PERIOD;
    const newConfidence = Math.max(confidence - DECAY_RULES.CONFIDENCE_DECAY_PER_PERIOD, 0);

    if (lastCalibratedAt) {
      newDepth = Math.max(newDepth, DECAY_RULES.FLOOR_IF_CALIBRATED);
    }
    newDepth = Math.max(newDepth, 0);

    return { action: "decay", newDepth, newConfidence };
  }

  if (daysSinceActive >= DECAY_RULES.WARN_AFTER_DAYS && !decayWarnedAt) {
    return { action: "warn", newDepth: depthScore, newConfidence: confidence };
  }

  return { action: "none", newDepth: depthScore, newConfidence: confidence };
}

// --- D1-backed operations ---

export async function applyPositiveFeedback(
  db: D1Database,
  userId: string,
  conceptId: string,
): Promise<{ newDepth: number; newConfidence: number }> {
  const row = await db
    .prepare("SELECT * FROM concept_depth WHERE concept_id = ? AND user_id = ?")
    .bind(conceptId, userId)
    .first<ConceptDepthRow>();

  if (!row) throw new Error(`No depth row for concept ${conceptId}`);

  const { newDepth, newConfidence } = computePositiveFeedback(row.depth_score, row.confidence);

  await db
    .prepare(
      `UPDATE concept_depth SET depth_score = ?, confidence = ?,
       updated_at = datetime('now') WHERE concept_id = ? AND user_id = ?`,
    )
    .bind(newDepth, newConfidence, conceptId, userId)
    .run();

  await recordDepthChange(db, userId, conceptId, newDepth, newConfidence, "feedback", "positive feedback");

  return { newDepth, newConfidence };
}

export async function applyQuizResult(
  db: D1Database,
  userId: string,
  conceptId: string,
  assessedDepth: number,
): Promise<{ newDepth: number; newConfidence: number }> {
  const { newDepth, newConfidence } = computeQuizResult(assessedDepth);

  await db
    .prepare(
      `UPDATE concept_depth SET depth_score = ?, confidence = ?,
       last_calibrated_at = datetime('now'), updated_at = datetime('now')
       WHERE concept_id = ? AND user_id = ?`,
    )
    .bind(newDepth, newConfidence, conceptId, userId)
    .run();

  await recordDepthChange(db, userId, conceptId, newDepth, newConfidence, "quiz", `assessed depth: ${assessedDepth}`);

  return { newDepth, newConfidence };
}

export async function applyQuizSkip(
  db: D1Database,
  userId: string,
  conceptId: string,
): Promise<{ newConfidence: number }> {
  const row = await db
    .prepare("SELECT confidence FROM concept_depth WHERE concept_id = ? AND user_id = ?")
    .bind(conceptId, userId)
    .first<{ confidence: number }>();

  if (!row) throw new Error(`No depth row for concept ${conceptId}`);

  const { newConfidence } = computeQuizSkip(row.confidence);

  await db
    .prepare(
      `UPDATE concept_depth SET confidence = ?, updated_at = datetime('now')
       WHERE concept_id = ? AND user_id = ?`,
    )
    .bind(newConfidence, conceptId, userId)
    .run();

  const depthRow = await db
    .prepare("SELECT depth_score FROM concept_depth WHERE concept_id = ? AND user_id = ?")
    .bind(conceptId, userId)
    .first<{ depth_score: number }>();

  await recordDepthChange(db, userId, conceptId, depthRow?.depth_score ?? 0, newConfidence, "quiz", "quiz skipped");

  return { newConfidence };
}

export async function runDecayJob(db: D1Database, userId: string): Promise<{ warned: string[]; decayed: string[] }> {
  const rows = await db
    .prepare(
      `SELECT cd.*, c.canonical_name
       FROM concept_depth cd
       JOIN concepts c ON cd.concept_id = c.id
       WHERE cd.user_id = ? AND cd.depth_score >= 2`,
    )
    .bind(userId)
    .all<ConceptDepthRow & { canonical_name: string }>();

  const now = new Date();
  const warned: string[] = [];
  const decayed: string[] = [];

  for (const row of rows.results) {
    const result = computeDecay(
      row.depth_score,
      row.confidence,
      row.last_exposed_at,
      row.last_calibrated_at,
      row.decay_warned_at,
      now,
    );

    if (result.action === "warn") {
      await db
        .prepare(
          `UPDATE concept_depth SET decay_warned_at = datetime('now'), updated_at = datetime('now')
           WHERE concept_id = ? AND user_id = ?`,
        )
        .bind(row.concept_id, userId)
        .run();
      warned.push(row.concept_id);
    } else if (result.action === "decay" || result.action === "severe_decay") {
      await db
        .prepare(
          `UPDATE concept_depth SET depth_score = ?, confidence = ?,
           updated_at = datetime('now') WHERE concept_id = ? AND user_id = ?`,
        )
        .bind(result.newDepth, result.newConfidence, row.concept_id, userId)
        .run();

      await recordDepthChange(
        db,
        userId,
        row.concept_id,
        result.newDepth,
        result.newConfidence,
        "decay",
        `${result.action}: ${row.depth_score} -> ${result.newDepth}`,
      );

      decayed.push(row.concept_id);
    }
  }

  return { warned, decayed };
}
