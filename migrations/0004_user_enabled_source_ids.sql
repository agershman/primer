-- 0004_user_enabled_source_ids.sql
-- Adds a per-user list of opted-in source IDs.
--
-- Why this exists: every user on a deployment used to receive every
-- configured source (Linear, Slack, GitHub, incident.io, RSS, HN,
-- ArXiv) fanned into their daily briefing. That worked when Primer
-- was effectively single-user, but as soon as a deployment hosts
-- multiple roles — e.g. a salesperson alongside the engineer who set
-- it up — most sources are noise for most users. This column lets
-- each user opt in to the kinds they actually care about.
--
-- Semantics:
--   - Stored as a JSON array of source IDs that match
--     `SourceProvider.id` in `src/worker/sources/*.ts`.
--   - Empty array = nothing fans out into this user's briefing. The
--     downstream pipeline (briefing-generator, adjacent-scanner)
--     filters singleton providers and source_instances by
--     intersecting against this list.
--   - User-level (writable by the user themselves via PATCH
--     /settings) — distinct from the deployment-wide source_config
--     which remains admin-gated.
--
-- Default + backfill:
--   - Column default is '[]' so brand-new users land in the empty
--     state and are guided through onboarding (the new "sources"
--     wizard step suggests which ones to enable based on their
--     About + Focus).
--   - Existing users on an already-installed deployment had
--     everything implicitly enabled, so we backfill with the full
--     set of seven IDs. Without this, tomorrow's briefing for the
--     deployment owner would suddenly come back empty.
ALTER TABLE user_settings
  ADD COLUMN enabled_source_ids TEXT NOT NULL DEFAULT '[]';

UPDATE user_settings
SET enabled_source_ids = '["linear","slack","github","incident-io","hn","rss","arxiv"]'
WHERE enabled_source_ids = '[]';
