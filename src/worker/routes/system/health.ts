/**
 * Health-check endpoint for the worker.
 *
 * Reports D1 connectivity (real probe: `SELECT 1`) plus the
 * presence of each integration's required env key. Optional
 * integrations (OpenAI / ElevenLabs TTS) are surfaced under a
 * separate `optional` map so the frontend health view can render
 * them as informational rows without flipping the overall status to
 * `degraded`.
 *
 * @see ../system.ts — assembly entry point
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemHealthRoutes = new Hono<AppEnv>();

systemHealthRoutes.get("/health", async (c) => {
  const checks: Record<string, "ok" | "error"> = {
    d1: "error",
    anthropic: "error",
    linear: "error",
    slack: "error",
    incident_io: "error",
  };

  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.d1 = "ok";
  } catch {
    /* d1 unreachable */
  }

  if (c.env.ANTHROPIC_API_KEY) checks.anthropic = "ok";
  if (c.env.LINEAR_API_KEY) checks.linear = "ok";
  if (c.env.SLACK_TOKEN) checks.slack = "ok";
  if (c.env.INCIDENT_IO_API_KEY) checks.incident_io = "ok";

  // Optional integrations — only show as `ok` when configured. Never
  // contributes to overall `degraded` status (the lack of an optional
  // key is not a problem). Returned as `optional` so the frontend
  // health view can render them as informational rows.
  const optional: Record<string, "ok" | "missing"> = {
    openai_tts: c.env.OPENAI_API_KEY ? "ok" : "missing",
    elevenlabs_tts: c.env.ELEVENLABS_API_KEY ? "ok" : "missing",
  };

  const allOk = Object.values(checks).every((v) => v === "ok");
  const status = allOk ? "ok" : "degraded";

  return c.json({ status, checks, optional });
});
