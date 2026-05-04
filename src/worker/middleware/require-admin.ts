/**
 * Admin-only route guard.
 *
 * Runs after `userContext` (which populates `c.get("user")`). Returns
 * 403 with a small JSON error when the resolved user isn't admin —
 * non-admin users can't configure deployment-wide things like
 * sources, AI model picks, voice defaults, or budget caps.
 *
 * Use as middleware on individual routes that mutate admin-only state:
 *
 *   adminRoutes.use("/sources", requireAdmin);
 *   adminRoutes.post("/sources", ...);
 *
 * Or, when the same route mixes admin-only and user-allowed concerns
 * (e.g. `PATCH /settings` which accepts both `filterPrompt` — user —
 * and `signalSurfaceMap.models` — admin), call `assertAdmin(user)`
 * directly inside the handler so you can scope the rejection to just
 * the admin-only fields.
 */

import { createMiddleware } from "hono/factory";
import type { Env, UserContext } from "../types.js";

type Variables = { user: UserContext };

export const requireAdmin = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const user = c.get("user");
  if (!user.isAdmin) {
    return c.json({ error: "Admin only", reason: "This action requires the deployment admin." }, 403);
  }
  await next();
});

/**
 * In-handler version for routes that need to gate part of their input
 * (e.g. PATCH /settings, where some body fields are admin-only and
 * others are user-allowed). Returns the 403 Response when blocked, or
 * `null` when the caller is admin and the handler should proceed.
 *
 * Usage:
 *   const block = assertAdmin(c.get("user"));
 *   if (block) return block;
 */
export function assertAdmin(user: UserContext): Response | null {
  if (user.isAdmin) return null;
  return Response.json({ error: "Admin only", reason: "This action requires the deployment admin." }, { status: 403 });
}
