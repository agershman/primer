import { genId } from "./queries.js";

export interface SourceInstanceDbRow {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  config: string; // JSON
  enabled: number; // 0 / 1
  created_at: string;
  updated_at: string;
}

export interface SourceInstance {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToSource(row: SourceInstanceDbRow): SourceInstance {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(row.config || "{}");
  } catch {
    cfg = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    config: cfg,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * No defaults are seeded out of the box. Different users / teams have
 * different interests, and a curated platform/SRE-flavored starter
 * pack ("Hacker News, CNCF, ArXiv, AWS, GCP") was presumptuous —
 * it seeded the briefing pipeline with content that wasn't relevant
 * to most readers. Admins start with an empty Feeds panel and either
 *   - paste an RSS URL into "Add a source by RSS URL", or
 *   - click ✨ Suggest sources (which reads About + Focus and proposes
 *     ~8 candidates tailored to the actual reader).
 *
 * The constant + seed function are kept as no-ops so any future
 * "deployment-default" use case (e.g. a fresh-install wizard that
 * lets an admin opt into a starter pack) has a registered hook.
 */
export const DEFAULT_SOURCE_INSTANCES: Array<{
  kind: string;
  label: string;
  url: string | null;
  config: Record<string, unknown>;
}> = [];

export async function seedDefaultSourceInstancesIfEmpty(db: D1Database): Promise<void> {
  if (DEFAULT_SOURCE_INSTANCES.length === 0) return;

  const row = await db.prepare(`SELECT COUNT(*) AS n FROM source_instances`).first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return;

  for (const src of DEFAULT_SOURCE_INSTANCES) {
    const id = genId("sourceInstance");
    await db
      .prepare(
        `INSERT OR IGNORE INTO source_instances
           (id, kind, label, url, config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      )
      .bind(id, src.kind, src.label, src.url, JSON.stringify(src.config))
      .run();
  }
}

export async function listSourceInstances(
  db: D1Database,
  options: { onlyEnabled?: boolean } = {},
): Promise<SourceInstance[]> {
  const where = options.onlyEnabled ? "WHERE enabled = 1" : "";
  const rows = await db
    .prepare(
      `SELECT * FROM source_instances ${where}
       ORDER BY enabled DESC, label ASC`,
    )
    .all<SourceInstanceDbRow>();
  return (rows.results ?? []).map(rowToSource);
}

export interface SourceInstanceUpsertInput {
  kind: string;
  label: string;
  url: string | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export async function createSourceInstance(db: D1Database, input: SourceInstanceUpsertInput): Promise<SourceInstance> {
  const id = genId("sourceInstance");
  const config = JSON.stringify(input.config ?? {});
  await db
    .prepare(
      `INSERT INTO source_instances
         (id, kind, label, url, config, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, input.kind, input.label, input.url, config, input.enabled === false ? 0 : 1)
    .run();

  const row = await db.prepare(`SELECT * FROM source_instances WHERE id = ?`).bind(id).first<SourceInstanceDbRow>();
  if (!row) throw new Error("Failed to create source instance");
  return rowToSource(row);
}

export async function updateSourceInstance(
  db: D1Database,
  id: string,
  patch: Partial<SourceInstanceUpsertInput>,
): Promise<SourceInstance | null> {
  const existing = await db
    .prepare(`SELECT * FROM source_instances WHERE id = ?`)
    .bind(id)
    .first<SourceInstanceDbRow>();
  if (!existing) return null;

  const next = {
    label: patch.label ?? existing.label,
    url: patch.url !== undefined ? patch.url : existing.url,
    config: patch.config !== undefined ? JSON.stringify(patch.config) : existing.config,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
  };

  await db
    .prepare(
      `UPDATE source_instances
         SET label = ?, url = ?, config = ?, enabled = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(next.label, next.url, next.config, next.enabled, id)
    .run();

  const row = await db.prepare(`SELECT * FROM source_instances WHERE id = ?`).bind(id).first<SourceInstanceDbRow>();
  return row ? rowToSource(row) : null;
}

export async function deleteSourceInstance(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM source_instances WHERE id = ?`).bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}
