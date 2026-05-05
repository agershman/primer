import { genId } from "./queries.js";

/**
 * In-app notifications queries.
 *
 * The notifications table is a generic event log surfaced via a bell
 * icon in the header. The first feature to use it is deep-dive
 * generation (so users can navigate away mid-generation and still
 * get notified when content is ready), but the schema is feature-
 * agnostic — every future "background work that the user should know
 * about" feature lands here too.
 *
 * Notifications go through a small state machine:
 *   in_progress -> ready          (success path)
 *   in_progress -> failed         (error path)
 *   ready/failed -> dismissed     (user explicitly removes)
 *
 * `acknowledged_at` is independent of status — it tracks "user has
 * seen this row in the bell dropdown". A notification can be
 * acknowledged but not dismissed (the user opens the bell, knows
 * about it, but the row stays in the list as a record).
 */

export type NotificationKind = string; // open enum so new feature types don't need code changes here
export type NotificationStatus = "in_progress" | "ready" | "failed" | "dismissed";

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  status: NotificationStatus;
  title: string;
  body: string | null;
  action_url: string | null;
  progress: number | null;
  payload: string;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  kind: string;
  status: NotificationStatus;
  title: string;
  body: string | null;
  actionUrl: string | null;
  progress: number | null;
  payload: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToNotification(row: NotificationRow): Notification {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload || "{}");
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    actionUrl: row.action_url,
    progress: row.progress,
    payload,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateNotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  status?: NotificationStatus;
  progress?: number | null;
  payload?: Record<string, unknown>;
}

export async function createNotification(
  db: D1Database,
  userId: string,
  input: CreateNotificationInput,
): Promise<Notification> {
  const id = genId("notification");
  await db
    .prepare(
      `INSERT INTO notifications
         (id, user_id, kind, status, title, body, action_url, progress, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      userId,
      input.kind,
      input.status ?? "in_progress",
      input.title,
      input.body ?? null,
      input.actionUrl ?? null,
      input.progress ?? null,
      JSON.stringify(input.payload ?? {}),
    )
    .run();

  const row = await db
    .prepare(`SELECT * FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<NotificationRow>();
  if (!row) throw new Error("Failed to create notification");
  return rowToNotification(row);
}

/**
 * Update a notification's status (and optionally rewrite the title /
 * body / payload). Used by the deep-dive flow to flip a row from
 * `in_progress` to `ready` once generation finishes.
 *
 * Best-effort: if the row no longer exists (e.g. user dismissed
 * before generation finished), the UPDATE is a silent no-op.
 */
export interface TransitionNotificationInput {
  status: NotificationStatus;
  title?: string;
  body?: string | null;
  actionUrl?: string | null;
  progress?: number | null;
  payload?: Record<string, unknown>;
}

export async function transitionNotification(
  db: D1Database,
  userId: string,
  id: string,
  input: TransitionNotificationInput,
): Promise<Notification | null> {
  const existing = await db
    .prepare(`SELECT * FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<NotificationRow>();
  if (!existing) return null;

  const next = {
    status: input.status,
    title: input.title ?? existing.title,
    body: input.body !== undefined ? input.body : existing.body,
    action_url: input.actionUrl !== undefined ? input.actionUrl : existing.action_url,
    progress: input.progress !== undefined ? input.progress : existing.progress,
    payload: input.payload !== undefined ? JSON.stringify(input.payload) : existing.payload,
  };
  await db
    .prepare(
      `UPDATE notifications
         SET status = ?, title = ?, body = ?, action_url = ?, progress = ?, payload = ?,
             updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    )
    .bind(next.status, next.title, next.body, next.action_url, next.progress, next.payload, id, userId)
    .run();

  const row = await db
    .prepare(`SELECT * FROM notifications WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<NotificationRow>();
  return row ? rowToNotification(row) : null;
}

/**
 * List the user's active notifications (i.e. anything not yet
 * dismissed). Ordered newest first; capped at 50 because the
 * dropdown isn't designed for long histories — older content is
 * cleaned up by the maintenance cron.
 */
export async function listActiveNotifications(db: D1Database, userId: string, limit = 50): Promise<Notification[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM notifications
       WHERE user_id = ? AND status != 'dismissed'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<NotificationRow>();
  return (rows.results ?? []).map(rowToNotification);
}

export async function acknowledgeNotification(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE notifications SET acknowledged_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL`,
    )
    .bind(id, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function acknowledgeAllNotifications(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notifications SET acknowledged_at = datetime('now'), updated_at = datetime('now')
       WHERE user_id = ? AND acknowledged_at IS NULL AND status != 'dismissed'`,
    )
    .bind(userId)
    .run();
  return result.meta?.changes ?? 0;
}

export async function dismissNotification(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE notifications SET status = 'dismissed', updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Bulk-dismiss every bell-relevant row (status ready/failed). The
 * `in_progress` rows are intentionally excluded because they're
 * owned by the ActivityIndicator surface, not the bell — a user
 * "clearing" the bell shouldn't accidentally kill the live state of
 * an in-flight deep dive.
 */
export async function dismissAllNotifications(db: D1Database, userId: string): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notifications SET status = 'dismissed', updated_at = datetime('now')
       WHERE user_id = ? AND status IN ('ready', 'failed')`,
    )
    .bind(userId)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Stuck-row detection. Mirrors the briefing pipeline's zombie
 * detection: a notification stuck in `in_progress` for too long is
 * almost certainly a worker that died mid-flight (Cloudflare
 * eviction, network blip, abort). We flip the row to `failed` so
 * the bell shows the user that their work didn't complete and they
 * can retry.
 *
 * Called by the maintenance cron; cheap because the active set is
 * small (50 rows max per user).
 */
export async function reapStuckNotifications(db: D1Database, userId: string, staleMinutes = 5): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE notifications
         SET status = 'failed',
             body = COALESCE(body, '') || ' (timed out)',
             updated_at = datetime('now')
       WHERE user_id = ? AND status = 'in_progress'
         AND updated_at < datetime('now', '-' || ? || ' minutes')`,
    )
    .bind(userId, staleMinutes)
    .run();
  return result.meta?.changes ?? 0;
}
