-- 0005_fix_incident_io_kind.sql
-- Repair the backfill from migration 0004.
--
-- The previous migration backfilled `enabled_source_ids` with the
-- string `"incident-io"` (hyphen), but the live provider's id is
-- `"incident_io"` (underscore — see src/worker/sources/incident-io.ts).
-- Because the briefing pipeline filters singleton providers by
-- exact-match against the user's enabled set, every user that came
-- through the 0004 backfill silently lost incident.io fan-out — the
-- intent was preservation of behaviour, the effect was a regression.
--
-- This migration is a targeted JSON-string rewrite. We do it in SQL
-- (rather than dropping + re-backfilling) so deployments that have
-- since edited their list — for instance an admin who toggled some
-- sources off — keep their edits and only the bad token is replaced.
--
-- Idempotent: re-running over already-fixed rows is a no-op because
-- the `LIKE` filter excludes them and `REPLACE` only fires on the
-- exact substring.
UPDATE user_settings
SET enabled_source_ids = REPLACE(enabled_source_ids, '"incident-io"', '"incident_io"')
WHERE enabled_source_ids LIKE '%"incident-io"%';
