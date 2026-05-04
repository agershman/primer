/**
 * `/me` and onboarding-status endpoints.
 *
 * - GET    `/me`                       — current user envelope
 * - POST   `/me/welcome-acknowledged`  — dismiss the bootstrap-admin
 *                                        welcome dialog
 * - PATCH  `/me`                       — update display name
 * - GET    `/onboarding/status`        — bootstrap progress for the
 *                                        first-run UX
 *
 * @see ../system.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemMeRoutes = new Hono<AppEnv>();

systemMeRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const ghUser = (user.settings.signalSurfaceMap?.github as Record<string, unknown> | undefined)?.username as
    | string
    | undefined;
  const avatarUrl = ghUser ? `https://github.com/${ghUser}.png?size=80` : null;
  return c.json({
    email: user.email,
    displayName: user.displayName,
    avatarUrl,
    focusStatement: user.focusStatement,
    focusVersionId: user.focusVersionId,
    aboutStatement: user.aboutStatement,
    aboutVersionId: user.aboutVersionId,
    settings: user.settings,
    identity: user.identity,
    // Drives the Settings nav filter + the per-piece "try different
    // model" / inline VoiceSwitcher visibility on the frontend. The
    // server still enforces gating on each admin-only mutation route
    // — this field is purely a UX hint, not a security boundary.
    isAdmin: user.isAdmin,
    // True when the user is admin and hasn't dismissed the bootstrap
    // welcome dialog yet. The frontend pops `<BootstrapAdminWelcome>`
    // when this flips on; "Got it" calls
    // `POST /api/me/welcome-acknowledged` which sets the timestamp
    // server-side, so the next /api/me poll returns false.
    needsBootstrapWelcome: user.isAdmin && user.welcomedAsAdminAt === null,
  });
});

// Sets `users.welcomed_as_admin_at` to "now" so the bootstrap-admin
// welcome dialog stops popping for this user. Idempotent — already-
// set rows aren't touched again. Available to any authenticated user
// (calling it before `isAdmin = 1` is harmless; the field is a
// dialog-dismissal signal, not a permission grant).
systemMeRoutes.post("/me/welcome-acknowledged", async (c) => {
  const user = c.get("user");
  await c.env.DB.prepare(
    `UPDATE users SET welcomed_as_admin_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND welcomed_as_admin_at IS NULL`,
  )
    .bind(user.userId)
    .run();
  return c.json({ ok: true });
});

systemMeRoutes.patch("/me", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ displayName?: string }>();

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.displayName !== undefined) {
    updates.push("display_name = ?");
    binds.push(body.displayName || null);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    binds.push(user.userId);
    await c.env.DB.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }

  const updated = await c.env.DB.prepare("SELECT id, email, display_name FROM users WHERE id = ?")
    .bind(user.userId)
    .first<{ id: string; email: string; display_name: string | null }>();

  const ghUser = (user.settings.signalSurfaceMap?.github as Record<string, unknown> | undefined)?.username as
    | string
    | undefined;
  const avatarUrl = ghUser ? `https://github.com/${ghUser}.png?size=80` : null;

  return c.json({
    email: updated?.email ?? user.email,
    displayName: updated?.display_name ?? null,
    avatarUrl,
  });
});

systemMeRoutes.get("/onboarding/status", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const conceptCount = await db
    .prepare("SELECT COUNT(*) as count FROM concepts WHERE user_id = ?")
    .bind(user.userId)
    .first<{ count: number }>();

  const hasConceptGraph = (conceptCount?.count ?? 0) > 0;

  const baselineCount = await db
    .prepare(
      `SELECT COUNT(*) as count FROM calibration_quizzes
       WHERE user_id = ? AND quiz_type = 'baseline' AND status = 'answered'`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  const hasBaseline = (baselineCount?.count ?? 0) > 0;

  const briefingCount = await db
    .prepare("SELECT COUNT(*) as count FROM briefings WHERE user_id = ?")
    .bind(user.userId)
    .first<{ count: number }>();

  const hasBriefings = (briefingCount?.count ?? 0) > 0;

  const lowDepthCount = await db
    .prepare(
      `SELECT COUNT(*) as count FROM concept_depth
       WHERE user_id = ? AND depth_score < 2`,
    )
    .bind(user.userId)
    .first<{ count: number }>();

  const suggestBaseline = (conceptCount?.count ?? 0) >= 3 && (lowDepthCount?.count ?? 0) >= 3;

  return c.json({
    isNewUser: !hasConceptGraph,
    hasConceptGraph,
    hasBaseline,
    hasBriefings,
    suggestBaseline,
  });
});
