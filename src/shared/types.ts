/**
 * Shared API contract types — consumed by both the Cloudflare Worker
 * (`src/worker/`) and the React frontend (`src/frontend/`).
 *
 * Adding a new shared type? Read [ADR 0004](../../dev-docs/adrs/0004-shared-types-module.md)
 * for the rationale. The TL;DR: types that travel over the wire
 * (request / response / SSE payloads) belong here. Worker-only and
 * frontend-only types stay in their respective `types.ts` files.
 * Re-export new shared types from `src/worker/types.ts` and
 * `src/frontend/types.ts` for backwards-compatible import paths.
 *
 * @see dev-docs/adrs/0004-shared-types-module.md — why this module exists
 * @see .cursor/rules/shared-types.mdc — auto-surfaces when editing this folder
 *
 * Why this file exists
 * --------------------
 *
 * Pre-extraction, types like `ContentBlock` and `Resource` were
 * declared identically in both `src/worker/types.ts` and
 * `src/frontend/types.ts`. They drifted twice in the project's
 * history — once when a new resource type ("notion") was added on
 * the worker side without updating the frontend literal union, and
 * once when a `code` content block landed on the frontend before
 * the worker schema knew about it. Both bugs surfaced as silently
 * dropped data in the wire shape.
 *
 * Centralizing these here means:
 *   1. A single source of truth for the JSON wire contract between
 *      the worker's `c.json(...)` and the frontend's `apiGet<T>`
 *      callers. If a literal union changes, both sides see it at
 *      type-check time.
 *   2. A natural home for any future zod / valibot schema we want
 *      to attach to the same shape — extracting validation later
 *      doesn't require moving types around.
 *   3. A clear "this is the API surface" boundary that AI agents
 *      and new contributors can audit without reading both worker
 *      and frontend type files.
 *
 * What goes here
 * --------------
 *
 *   - Types that travel over the wire (request / response bodies,
 *     query param shapes, SSE event payloads).
 *   - Domain enums and discriminated-union literals used by both
 *     sides (e.g. `Resource.type`, piece status, briefing status).
 *
 * What does NOT go here
 * ---------------------
 *
 *   - Worker-only types (Hono `Env`, middleware contexts, D1 row
 *     shapes) — keep in `src/worker/types.ts`.
 *   - Frontend-only types (React component prop interfaces,
 *     hook-internal state) — keep in `src/frontend/types.ts` or
 *     co-located with the component.
 *
 * IMPORTANT: this file MUST have zero runtime dependencies on
 * either side. No imports from `src/worker/` or `src/frontend/`.
 * Pure type definitions only — anything else gets bundled into
 * both worker and frontend output and bloats both.
 */

/**
 * One block of structured content in a teaching piece body.
 *
 * `type` discriminates how the frontend renders the block:
 *   - `text`     — paragraph / inline markdown
 *   - `heading`  — section heading (visually larger)
 *   - `diagram`  — Mermaid source rendered inline
 *   - `code`     — fenced code block, syntax-highlighted by
 *                  `language` if set
 *
 * `value` is the raw content. For `code` and `diagram`, this is the
 * exact source text the renderer should treat verbatim.
 *
 * `language` only applies to `type === "code"` (e.g. "ts", "py",
 * "bash"). Ignored for other block types.
 *
 * `label` is an optional short caption rendered above the block —
 * used today for diagrams and occasionally for code listings.
 */
export interface ContentBlock {
  type: "text" | "heading" | "diagram" | "code";
  value: string;
  language?: string;
  label?: string;
}

/**
 * A resource (link, doc, ticket) the user can click out to from a
 * teaching piece's "Related" section.
 *
 * `type` is the canonical source class — drives the icon, colour,
 * and label badge. New types must be added here AND in the
 * worker's `extractResourceType` heuristic so new wire values
 * don't fall through to the `"other"` rendering path.
 */
export interface Resource {
  label: string;
  url: string;
  type: "linear" | "slack" | "incident" | "docs" | "article" | "pr" | "notion" | "google_doc" | "web" | "other";
}

