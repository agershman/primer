/**
 * Canonical registry of source kinds — the single source of truth for
 * the IDs that flow through:
 *
 *   • the briefing pipeline (filters singleton providers by id),
 *   • `user_settings.enabled_source_ids` (per-user opt-in),
 *   • the migration backfill in 0004,
 *   • the description map in `routes/sources.ts`,
 *   • the onboarding suggestion endpoint, and
 *   • the per-source panel `useSourceEnabled(<id>)` calls.
 *
 * The list lives in `shared/` because it's part of the JSON wire
 * contract between the worker and the frontend (PATCH /settings
 * accepts `enabledSourceIds: SourceId[]`, the Sources panel reads it
 * back, etc.). Drift between the two sides used to be a source of
 * silent bugs — the 0004 migration shipped with the typo
 * `"incident-io"` (hyphen) when the provider id is `"incident_io"`
 * (underscore), so backfilled users silently lost incident.io
 * fan-out. With a single literal union both sides import, that bug
 * becomes a tsc error before it ever leaves the editor.
 *
 * Adding a new source? Append the id to `SOURCE_IDS` (and to
 * `SOURCE_DESCRIPTIONS` below) AT THE SAME TIME the provider is
 * registered in `src/worker/sources/index.ts`. The consistency test
 * in `tests/unit/source-id-consistency.test.ts` will fail loudly if
 * any of the call sites drift.
 */

/**
 * The full ordered list. `as const` makes the elements literal types
 * so TypeScript can derive a string-literal union from them rather
 * than collapsing to `string`.
 *
 * Order is meaningful only for tests that pin the canonical list —
 * code that iterates this should not assume any particular order.
 */
export const SOURCE_IDS = ["linear", "slack", "github", "incident_io", "hn", "rss", "arxiv"] as const;

/**
 * Literal union derived from `SOURCE_IDS`. Use this anywhere a string
 * is supposed to be a source id (provider lookups, the user's
 * `enabledSourceIds` array, the onboarding suggestion handler, the
 * Settings panel `useSourceEnabled` calls). `string` is too loose;
 * a typo'd id with `string` typing compiles fine and silently drops
 * the source from briefings.
 */
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Type guard — narrows an arbitrary `string` to `SourceId` when it's
 * one of the canonical IDs. Used at trust boundaries (e.g. parsing
 * the JSON column out of D1, validating PATCH /settings input)
 * where the inbound value is `string` but downstream code wants
 * `SourceId`.
 */
export function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as readonly string[]).includes(value);
}

/**
 * Short, neutral one-liner per source. Surfaced in:
 *   • the LLM onboarding suggester (so the model can reason about fit),
 *   • the per-source Settings panel as helper text under the toggle,
 *   • the onboarding "sources" step rendering each suggestion.
 *
 * Kept in `shared/` so the worker and the frontend agree on the same
 * copy without the description being duplicated in two places.
 */
export const SOURCE_DESCRIPTIONS: Record<SourceId, string> = {
  linear: "Issues and projects from Linear — surfaces engineering work in flight.",
  slack: "Recent Slack threads — captures cross-team discussion and decisions.",
  github: "Recent GitHub PRs and issues — surfaces what your engineers are shipping.",
  incident_io: "Active and recent incidents from incident.io — high-signal context for SREs and platform engineers.",
  hn: "Hacker News story feeds — broad tech news and discussion.",
  rss: "Configured RSS / Atom feeds — vendor blogs, conference proceedings, newsletters.",
  arxiv: "ArXiv paper feeds — research-heavy, useful for ML / systems researchers.",
};
