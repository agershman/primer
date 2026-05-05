import { Hono } from "hono";
import {
  acknowledgeAllNotifications,
  acknowledgeNotification,
  dismissAllNotifications,
  dismissNotification,
  listActiveNotifications,
} from "../db/notifications-queries.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const notificationRoutes = new Hono<AppEnv>();

/**
 * Active notifications list — the bell dropdown's data source.
 *
 * Returns up to 50 newest-first rows that aren't dismissed plus
 * a couple of aggregate counts the bell uses for badging:
 *   - `unreadCount`     — rows with status in (ready,failed) AND
 *                         acknowledged_at IS NULL.
 *   - `inProgressCount` — rows still in flight.
 *
 * The frontend polls this endpoint; cadence backs off when nothing
 * is in progress so we don't burn requests when the user is idle.
 */
notificationRoutes.get("/notifications", async (c) => {
  const user = c.get("user");
  const notifications = await listActiveNotifications(c.env.DB, user.userId);
  let unreadCount = 0;
  let inProgressCount = 0;
  for (const n of notifications) {
    if (n.status === "in_progress") inProgressCount += 1;
    if ((n.status === "ready" || n.status === "failed") && !n.acknowledgedAt) {
      unreadCount += 1;
    }
  }
  return c.json({
    notifications,
    unreadCount,
    inProgressCount,
  });
});

notificationRoutes.post("/notifications/:id/acknowledge", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const ok = await acknowledgeNotification(c.env.DB, user.userId, id);
  return c.json({ ok });
});

notificationRoutes.post("/notifications/acknowledge-all", async (c) => {
  const user = c.get("user");
  const changed = await acknowledgeAllNotifications(c.env.DB, user.userId);
  return c.json({ ok: true, changed });
});

notificationRoutes.post("/notifications/:id/dismiss", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const ok = await dismissNotification(c.env.DB, user.userId, id);
  return c.json({ ok });
});

notificationRoutes.post("/notifications/dismiss-all", async (c) => {
  const user = c.get("user");
  const changed = await dismissAllNotifications(c.env.DB, user.userId);
  return c.json({ ok: true, changed });
});
