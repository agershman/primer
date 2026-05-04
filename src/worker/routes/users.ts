/**
 * User-management routes — admin-only surfaces for listing users
 * and toggling their admin status.
 *
 * Pre-existed only as a D1-CLI recipe; this file replaces that
 * workflow with a server-gated UI. The boundary is enforced
 * server-side via `requireAdmin` middleware (every route in this
 * file 403s for non-admins). The UsersPanel in the Settings modal
 * is the consumer.
 *
 * Out of scope: deleting users (no UI surface, no operational
 * pressure), changing email addresses (the email IS the identity —
 * if the upstream auth proxy returns a new email, the user-context
 * middleware INSERT-IGNOREs a new row), bulk operations.
 */

import { Hono } from "hono";
import { requireAdmin } from "../middleware/require-admin.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const userRoutes = new Hono<AppEnv>();

userRoutes.use("/users", requireAdmin);
userRoutes.use("/users/*", requireAdmin);

userRoutes.get("/users", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, email, display_name, is_admin, created_at, welcomed_as_admin_at
     FROM users
     ORDER BY created_at ASC`,
  ).all<{
    id: string;
    email: string;
    display_name: string | null;
    is_admin: number | null;
    created_at: string;
    welcomed_as_admin_at: string | null;
  }>();

  const users = rows.results.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: (row.is_admin ?? 0) === 1,
    createdAt: row.created_at,
    welcomedAsAdminAt: row.welcomed_as_admin_at,
  }));

  return c.json({ users });
});

userRoutes.patch("/users/:id", async (c) => {
  const targetId = c.req.param("id");
  const caller = c.get("user");
  const body = await c.req.json<{ isAdmin?: boolean }>();

  if (typeof body.isAdmin !== "boolean") {
    return c.json({ error: "Body must include `isAdmin: boolean`" }, 400);
  }

  // Ensure the target exists. Surfaces 404 separately from 409 so
  // the frontend can render a different error state.
  const target = await c.env.DB.prepare("SELECT id, is_admin FROM users WHERE id = ?")
    .bind(targetId)
    .first<{ id: string; is_admin: number | null }>();
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }

  const targetIsCurrentlyAdmin = (target.is_admin ?? 0) === 1;

  // Last-admin demotion guard. Without this, a single-admin
  // deployment could lock itself out by toggling its only admin off
  // — recovery would require D1 SQL access, which contradicts the
  // whole point of having the UI. Self-demotion is fine as long as
  // another admin exists.
  if (targetIsCurrentlyAdmin && body.isAdmin === false) {
    const adminCountRow = await c.env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE is_admin = 1").first<{
      count: number;
    }>();
    const adminCount = adminCountRow?.count ?? 0;
    if (adminCount <= 1) {
      return c.json(
        {
          error: "Last admin",
          reason: "This user is the only remaining admin. Promote another user to admin before demoting them.",
        },
        409,
      );
    }
  }

  await c.env.DB.prepare(`UPDATE users SET is_admin = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(body.isAdmin ? 1 : 0, targetId)
    .run();

  // Return the updated row in the same shape `GET /users` returns
  // so the frontend can patch its local list optimistically.
  const updated = await c.env.DB.prepare(
    `SELECT id, email, display_name, is_admin, created_at, welcomed_as_admin_at
     FROM users WHERE id = ?`,
  )
    .bind(targetId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      is_admin: number | null;
      created_at: string;
      welcomed_as_admin_at: string | null;
    }>();

  return c.json({
    user: {
      id: updated!.id,
      email: updated!.email,
      displayName: updated!.display_name,
      isAdmin: (updated!.is_admin ?? 0) === 1,
      createdAt: updated!.created_at,
      welcomedAsAdminAt: updated!.welcomed_as_admin_at,
    },
    // Surfaces in the UI so a self-demoting admin sees their settings
    // panels collapse on the next /api/me poll. The frontend can use
    // this to refresh their own context immediately.
    selfDemoted: targetId === caller.userId && targetIsCurrentlyAdmin && body.isAdmin === false,
  });
});
