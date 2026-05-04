/**
 * Briefing routes — assembly point.
 *
 * Includes the canonical "streaming response + ctx.waitUntil +
 * notification" pattern at `POST /briefing/generate`. New
 * long-running routes elsewhere in the codebase should pattern-match
 * against the implementation in [`./briefing/lifecycle.ts`](./briefing/lifecycle.ts).
 *
 * Handlers are split by concern under `briefing/`:
 *
 *   - [`./briefing/read.ts`](./briefing/read.ts)            — `today`,
 *                                                              `status`,
 *                                                              `:date`,
 *                                                              `dates`,
 *                                                              `briefings`
 *   - [`./briefing/lifecycle.ts`](./briefing/lifecycle.ts)  — `cancel`,
 *                                                              `reset`,
 *                                                              `generate`
 *   - [`./briefing/extra.ts`](./briefing/extra.ts)          — `:id/near-misses`,
 *                                                              `:id/work-context`
 *   - [`./briefing/shared.ts`](./briefing/shared.ts)        — common
 *                                                              helpers
 *                                                              (BRIEFING_NOTIFICATION_KIND,
 *                                                              isZombie,
 *                                                              parseRedundantDrafts,
 *                                                              todayFor)
 *
 * @see dev-docs/adrs/0005-streaming-plus-waituntil.md — why both
 *      streaming AND waitUntil (not just one)
 * @see .cursor/skills/add-route/SKILL.md — task playbook for new routes
 * @see .cursor/rules/api-routes.mdc — auto-surfaces when editing routes
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../types.js";
import { briefingExtraRoutes } from "./briefing/extra.js";
import { briefingLifecycleRoutes } from "./briefing/lifecycle.js";
import { briefingReadRoutes } from "./briefing/read.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const briefingRoutes = new Hono<AppEnv>();
briefingRoutes.route("/", briefingReadRoutes);
briefingRoutes.route("/", briefingLifecycleRoutes);
briefingRoutes.route("/", briefingExtraRoutes);
