/**
 * Shared zod schemas for the API contract.
 *
 * Why this module exists
 * ----------------------
 * Pre-zod, every route handler did `await c.req.json<{ ... }>()` —
 * a TypeScript-only assertion that gives zero runtime protection.
 * Malformed clients (third-party scripts, browser extensions, our
 * own bugs) could send any shape and the route would crash deep in
 * the handler with a confusing error, or worse silently coerce
 * `undefined` into the schema and write nonsense to D1.
 *
 * This module declares the schemas at the contract boundary so:
 *
 *   1. The worker validates incoming bodies once, at the edge.
 *   2. The frontend can re-use the inferred TypeScript types via
 *      `z.infer<typeof Schema>` — single source of truth for the
 *      JSON wire shape.
 *   3. Adding a new field is one diff, not three (route handler +
 *      worker types + frontend types).
 *
 * Adoption is gradual. New routes should validate via these schemas;
 * existing routes get migrated as they're touched. The
 * `validateBody` helper below standardises the success / 400 response
 * shape so the migration doesn't drift.
 *
 * @see src/shared/types.ts — non-runtime API contract types
 * @see .cursor/rules/api-routes.mdc — auto-surfaces when editing routes
 */

import { z } from "zod";

/**
 * `POST /api/me/refine-prompt` body — the AI-assisted refinement of
 * a user's About / Focus draft. Validated to keep the kind to the
 * exact two strings that have downstream prompt branches, and the
 * draft length within the LLM-budget caps.
 */
export const RefinePromptRequest = z.object({
  kind: z.enum(["about", "focus"]),
  draft: z.string().min(1, "draft is required").max(4000, "draft too long (max 4000 chars)"),
});
export type RefinePromptRequest = z.infer<typeof RefinePromptRequest>;

/**
 * `POST /api/me/about` and `POST /api/me/focus` body. Both endpoints
 * accept the same shape — a (versioned) statement plus an optional
 * note. Lengths match what the existing handlers enforced ad-hoc;
 * centralising the constants prevents a future PR from changing
 * one and not the other.
 */
export const StatementVersionRequest = z.object({
  statement: z.string().min(1, "statement is required").max(4000, "statement too long (max 4000 chars)"),
  note: z.string().max(300, "note too long (max 300 chars)").optional(),
});
export type StatementVersionRequest = z.infer<typeof StatementVersionRequest>;

/**
 * `POST /api/quiz/baseline/prepare` body — kicks off the async
 * baseline-calibration generation. `category` is optional so the
 * cross-trail "Start calibration" CTA can POST `{}` without a
 * 400.
 */
export const PrepareBaselineRequest = z.object({
  category: z.string().trim().optional(),
});
export type PrepareBaselineRequest = z.infer<typeof PrepareBaselineRequest>;

/**
 * Shape returned to the client when validation fails. Same shape
 * across every route so the frontend can render a single error
 * surface. Errors are pre-flattened via `error.flatten()` so the
 * client doesn't have to walk the zod tree.
 */
export interface ValidationErrorResponse {
  error: "Invalid request body";
  issues: Array<{ path: string; message: string }>;
}

/**
 * Parse a JSON body against a zod schema. Returns `{ ok: true, data }`
 * on success, `{ ok: false, error }` on validation failure. The
 * route handler returns the `error` directly via `c.json(error, 400)`
 * — see the consuming routes for the canonical pattern.
 *
 * Tolerates a missing / unparseable body by treating it as `{}`,
 * which lines up with the pre-zod `c.req.json().catch(() => ({}))`
 * pattern several handlers used.
 */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: ValidationErrorResponse }> {
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const result = schema.safeParse(raw);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  // Walk every issue once and emit a flat `{ path, message }`
  // list. The path string mirrors `.path.join(".")` so nested
  // fields read like `user.email`. A single frontend renderer
  // covers every endpoint.
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
  return {
    ok: false,
    error: {
      error: "Invalid request body",
      issues,
    },
  };
}
