-- 0002_user_admin.sql
-- Adds a simple admin / regular-user distinction.
--
-- Why one boolean instead of a roles table: the deployment pattern is
-- "one team or one person installs Primer, configures sources + AI
-- model picks + budget caps once, and everyone else just reads
-- briefings". A two-bucket flag covers that without the overhead of a
-- proper RBAC schema. We can promote to a `roles` table later if real
-- multi-tenant permissions land.
--
-- Bootstrap rules (enforced in `worker/middleware/user-context.ts`):
--   - The first user to provision (i.e. the one whose INSERT lands on
--     a previously-empty `users` table) gets `is_admin = 1`. Avoids a
--     chicken-and-egg where no one can configure the system on a fresh
--     install.
--   - Every subsequent user gets `is_admin = 0`. The admin can promote
--     others by hand (today: D1 console / SQL; future: an admin-only
--     UI surface).
--
-- Existing local DBs would otherwise have all rows at the default of
-- `0`, leaving the system with zero admins. The backfill below marks
-- the **earliest-created** existing user as admin so an installed
-- system on the previous schema upgrades cleanly without intervention.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET is_admin = 1
WHERE id = (
  SELECT id FROM users ORDER BY created_at ASC LIMIT 1
);
