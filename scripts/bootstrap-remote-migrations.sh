#!/usr/bin/env bash
# Bootstrap the d1_migrations tracking table on the REMOTE Primer D1 database.
#
# This is a ONE-TIME operation. It seeds the d1_migrations table that
# `wrangler d1 migrations apply` uses to track which migrations have already
# been run, so it doesn't try to re-apply migrations 0001-0010 (which would
# fail because the schema is already in place).
#
# Run this once after switching to the wrangler d1 migrations apply workflow.
# After it succeeds, future `bun run db:migrate:remote` (and CI) will Just Work
# — wrangler will see all existing migrations as already applied and only run
# new ones.
#
# Idempotent: re-running this script is safe. CREATE TABLE IF NOT EXISTS and
# INSERT OR IGNORE both no-op when the data already exists.
#
# Local DBs don't need this — `bun run db:reset` wipes local state and
# `db:migrate` from a fresh DB will apply everything cleanly through the new
# migration runner, populating d1_migrations as it goes.

set -euo pipefail

cd "$(dirname "$0")/.."

# All migrations that have ALREADY been applied to the remote database. Add
# new files here only AFTER they have been manually applied to remote — for
# new migrations going forward, the wrangler runner handles it automatically.
APPLIED_MIGRATIONS=(
  "0001_initial.sql"
  "0002_chat.sql"
  "0003_model_tracking.sql"
  "0004_cancel_tracking.sql"
  "0005_analytics.sql"
  "0006_source_provenance.sql"
  "0007_bookmarks.sql"
  "0008_github.sql"
  "0009_user_focus_and_concept_suppression.sql"
  "0010_user_about_statement.sql"
  "0011_teaching_piece_due_dates.sql"
  "0012_piece_series.sql"
  "0013_user_timezone.sql"
  "0014_user_ecosystem_sources.sql"
  "0015_notifications.sql"
)

# Build the SQL: create the tracking table if it doesn't exist, then insert
# one row per migration above. INSERT OR IGNORE handles re-runs cleanly.
SQL="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL);"
for migration in "${APPLIED_MIGRATIONS[@]}"; do
  SQL+=" INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${migration}');"
done

echo "==> Bootstrapping d1_migrations tracking on remote primer-db…"
echo "    Marking ${#APPLIED_MIGRATIONS[@]} migrations as already applied."
echo

bunx wrangler d1 execute primer-db \
  --remote \
  --config wrangler.api.toml \
  --command "$SQL"

echo
echo "==> Done. Verifying with: wrangler d1 migrations list…"
echo
bunx wrangler d1 migrations list primer-db --remote --config wrangler.api.toml || true

echo
echo "All marked migrations should appear under 'Already applied'."
echo "Future deploys can now run 'bun run db:migrate:remote' (or wrangler"
echo "d1 migrations apply) — pending migrations will apply automatically."
