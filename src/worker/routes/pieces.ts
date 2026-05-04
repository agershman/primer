/**
 * Pieces routes — assembly point.
 *
 * Pre-fix this was a single 854-line file. The handlers now live in
 * sibling files under `pieces/`:
 *
 *   - [`./pieces/feedback-read.ts`](./pieces/feedback-read.ts) — feedback,
 *                                                                 read
 *                                                                 marker,
 *                                                                 series,
 *                                                                 resources
 *   - [`./pieces/deep-dive.ts`](./pieces/deep-dive.ts)         — deep-dive
 *                                                                 generation
 *                                                                 (canonical
 *                                                                 streaming
 *                                                                 example)
 *   - [`./pieces/regenerate.ts`](./pieces/regenerate.ts)       — admin-only
 *                                                                 regenerate-with-model
 *   - [`./pieces/audio.ts`](./pieces/audio.ts)                 — both
 *                                                                 audio
 *                                                                 endpoints
 *
 * @see dev-docs/adrs/0005-streaming-plus-waituntil.md — streaming pattern
 * @see .cursor/skills/add-route/SKILL.md — task playbook for new routes
 */

import { Hono } from "hono";
import type { Env, UserContext } from "../types.js";
import { pieceAudioRoutes } from "./pieces/audio.js";
import { pieceDeepDiveRoutes } from "./pieces/deep-dive.js";
import { pieceFeedbackReadRoutes } from "./pieces/feedback-read.js";
import { pieceRegenerateRoutes } from "./pieces/regenerate.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const pieceRoutes = new Hono<AppEnv>();
pieceRoutes.route("/", pieceFeedbackReadRoutes);
pieceRoutes.route("/", pieceDeepDiveRoutes);
pieceRoutes.route("/", pieceRegenerateRoutes);
pieceRoutes.route("/", pieceAudioRoutes);
