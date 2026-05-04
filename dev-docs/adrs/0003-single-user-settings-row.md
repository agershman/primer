# 0003 — Single user_settings row instead of EAV

**Status:** accepted

## Context

User settings span ~25 fields across budget caps, retention windows, AI model picks, voice picks, source filters, per-source overrides, signal-surface configuration, etc. Two design options were on the table for the database schema:

- **Wide row.** One `user_settings` row per user, columns for each top-level category, JSON columns for flexible parts (`source_config`, etc.).
- **EAV (entity-attribute-value).** Tables like `user_settings_kv (user_id, key, value)` storing one row per setting, allowing arbitrary new settings without a migration.

## Decision

Wide row, with JSON columns for the flexible parts (`source_config`, `model_config`, etc.).

## Consequences

**Wins:**

- **Reads are one query.** The settings panel pulls everything in a single SELECT, no N+1 concern.
- **Migrations are explicit.** Adding a new top-level setting requires a migration, which forces a documented schema change. EAV would let new settings sneak in via app code without DB review.
- **Atomic writes.** Saving a settings update is a single UPDATE, so partial-state visibility under concurrent edits is impossible.
- **D1-friendly.** D1's read-replica behaviour and request size limits favour wide rows over many narrow ones.
- **Indexable.** Top-level columns (`budget_cap_monthly`, `relevance_threshold`) are queryable directly. EAV would require JSON path queries or joins for the same.

**Losses:**

- **Schema rigidity.** Every new top-level setting needs a migration. Acceptable cost — a single-user-per-deployment app evolves slowly enough that this isn't a churn point.
- **JSON columns hide structure.** `source_config` is a JSON blob with a typed shape on the app side. Drift between the type definition and the actual JSON in the DB is possible. Mitigated by `useSettings.ts`'s `normalize()` function, which always re-shapes on read.

## Alternatives considered

- **EAV.** Rejected as above. The flexibility wasn't needed and the read-side cost was real.
- **Per-source separate rows (e.g. `linear_settings`, `slack_settings`, …).** Considered when the source-provider pattern landed. Declined because it duplicates user_id everywhere and requires N joins to render the Settings panel.
- **One JSON column for everything.** Considered for simplicity. Declined because we lose the indexable / queryable budget cap, retention, and threshold columns — those are read by routes other than the settings panel (analytics, cron) and shouldn't require JSON parsing.

## See also

- `migrations/0001_initial.sql` — the user_settings DDL.
- `src/frontend/hooks/useSettings.ts` — the `normalize()` function that re-shapes on read.
- `src/worker/types.ts` — the `UserSettings` interface defining the in-memory shape.
