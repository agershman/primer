-- 0003_user_admin_welcome.sql
-- Adds the bootstrap-admin welcome acknowledgement column.
--
-- Why this exists: the first user to provision a fresh deployment is
-- silently promoted to admin (atomic INSERT-SELECT in
-- `worker/middleware/user-context.ts`, see migration 0002). They had
-- no way to discover that fact short of opening Settings → Account
-- and noticing the "Role: Admin" row. The frontend now shows a
-- one-time welcome dialog explaining what admin status enables —
-- this column tracks whether the user has dismissed that dialog so
-- it doesn't re-pop on every login.
--
-- Trigger semantics (enforced in `/api/me`):
--   - `needsBootstrapWelcome` is true when `is_admin = 1` AND
--     `welcomed_as_admin_at IS NULL`.
--   - Set when the user clicks "Got it" on the dialog (POST
--     /api/me/welcome-acknowledged), or via the backfill below for
--     pre-existing admins.
--
-- Backfill: existing admins on an already-installed deployment know
-- they're admin. Stamping their row at migration time means they
-- don't see the dialog after this migration applies — a freshly
-- promoted user (post-migration) is the only path that surfaces it.
ALTER TABLE users ADD COLUMN welcomed_as_admin_at TEXT;

UPDATE users
SET welcomed_as_admin_at = datetime('now')
WHERE is_admin = 1;
