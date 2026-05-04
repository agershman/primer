/**
 * Quiz routes — assembly point.
 *
 * The handlers live in two sub-files keyed by surface:
 *
 *   - [`./quiz/inline.ts`](./quiz/inline.ts) — per-question
 *     calibration on the briefing page (next / answer / assessment /
 *     skip).
 *   - [`./quiz/baseline.ts`](./quiz/baseline.ts) — multi-question
 *     batch flow used during onboarding and from the per-trail
 *     "Calibrate this trail" CTA.
 *
 * Both surfaces share helpers (notification kinds, the assessment
 * runner, etc.) from [`./quiz/shared.ts`](./quiz/shared.ts).
 *
 * The split exists so each file fits comfortably in one
 * `Read`/context-window — pre-fix this was a single 945-line file
 * that any change had to load entirely. See [the architecture
 * overview](../../../dev-docs/architecture.md#worker-routes) for
 * the route-folder convention.
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../types.js";
import { quizBaselineRoutes } from "./quiz/baseline.js";
import { quizInlineRoutes } from "./quiz/inline.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const quizRoutes = new Hono<AppEnv>();
quizRoutes.route("/", quizInlineRoutes);
quizRoutes.route("/", quizBaselineRoutes);
