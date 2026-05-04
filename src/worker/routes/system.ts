/**
 * System routes — assembly point.
 *
 * The previous monolithic `system.ts` carried `/health`, `/me`,
 * stats, decay, focus + about versioning, and the prompt-refinement
 * endpoint. The handlers now live in sibling files under
 * `system/`:
 *
 *   - [`./system/health.ts`](./system/health.ts)  — `/health`
 *   - [`./system/me.ts`](./system/me.ts)          — `/me` GET/PATCH,
 *                                                   welcome-acknowledged,
 *                                                   onboarding/status
 *   - [`./system/stats.ts`](./system/stats.ts)    — `/stats`,
 *                                                   `/stats/weekly`,
 *                                                   `/decay/run`
 *   - [`./system/focus.ts`](./system/focus.ts)    — `/me/focus*`
 *   - [`./system/about.ts`](./system/about.ts)    — `/me/about*`
 *   - [`./system/refine.ts`](./system/refine.ts)  — `/me/refine-prompt`
 *
 * The split keeps each file fits comfortably in one
 * `Read`/context-window — pre-fix this was a single 879-line file.
 * See [the architecture overview](../../../dev-docs/architecture.md#worker-routes)
 * for the route-folder convention.
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../types.js";
import { systemAboutRoutes } from "./system/about.js";
import { systemFocusRoutes } from "./system/focus.js";
import { systemHealthRoutes } from "./system/health.js";
import { systemMeRoutes } from "./system/me.js";
import { systemRefineRoutes } from "./system/refine.js";
import { systemStatsRoutes } from "./system/stats.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemRoutes = new Hono<AppEnv>();
systemRoutes.route("/", systemHealthRoutes);
systemRoutes.route("/", systemMeRoutes);
systemRoutes.route("/", systemStatsRoutes);
systemRoutes.route("/", systemFocusRoutes);
systemRoutes.route("/", systemAboutRoutes);
systemRoutes.route("/", systemRefineRoutes);
