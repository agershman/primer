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
  type: "linear" | "slack" | "incident" | "docs" | "article" | "pr" | "notion" | "google_doc" | "other";
}

/**
 * Polymorphic target kind for the content audit. Pieces and deep dives
 * both reference rows in `teaching_pieces` (different content columns);
 * quizzes reference `calibration_quizzes`.
 */
export type AuditTargetKind = "piece" | "deep_dive" | "quiz";

/**
 * Why a claim was flagged — and, if patched, how. The auditor's pass-1
 * call classifies every factual sentence; the web-search backstop can
 * upgrade `unsupported` to `grounded-web` when a trustworthy public
 * source corroborates the claim.
 */
export type AuditVerdict = "grounded" | "grounded-web" | "unsupported" | "hallucinated";

/** How a flagged claim was resolved by the patch step. `kept` is the
 *  default for `grounded` / `grounded-web` claims; `patched` and
 *  `dropped` apply to `unsupported` / `hallucinated`. */
export type AuditResolution = "kept" | "patched" | "dropped";

/** A web citation surfaced by the hosted `web_search` server tool when
 *  the auditor's backstop call invoked it. Always populated when a
 *  claim's `verdict` is `grounded-web`. */
export interface WebEvidence {
  url: string;
  title: string;
  snippet?: string;
}

/**
 * Per-claim audit record. The UI's inline `<mark>` overlay reads
 * `block_index` + `span_start` + `span_end` to locate the span in the
 * rendered ContentBlock[]; the popover reads everything else.
 */
export interface AuditClaim {
  id: string;
  block_index: number;
  span_start: number;
  span_end: number;
  claim_text: string;
  verdict: AuditVerdict;
  cited_refs: string[];
  web_evidence: WebEvidence[] | null;
  reasoning: string | null;
  resolution: AuditResolution | null;
  patched_text: string | null;
}

/**
 * Lightweight rollup carried inline on briefing/piece/quiz read
 * payloads — enough to render the `<AuditIndicator>` pill without an
 * extra round trip. Full trail lives behind `GET /api/.../audit`.
 */
export interface AuditSummary {
  status: "clean" | "patched" | "dropped" | "failed";
  audit_model: string;
  patch_model: string | null;
  used_web_search: boolean;
  total_claims: number;
  unsupported_count: number;
  hallucinated_count: number;
  grounded_web_count: number;
  patched_count: number;
  dropped_count: number;
}

/**
 * Full audit trail returned by the dedicated GET endpoints. Includes
 * both passes plus every classified span — used by the
 * `<AuditTrailPanel>` modal and the popover lookup keyed on
 * `audit_claims.id`.
 */
export interface AuditTrail {
  target_kind: AuditTargetKind;
  target_id: string;
  passes: Array<{
    pass: 1 | 2;
    summary: AuditSummary;
    claims: AuditClaim[];
  }>;
}
