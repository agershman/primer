import { env } from "cloudflare:test";
import { applyD1Migrations } from "cloudflare:test";

/**
 * Setup file for the `workers` vitest project.
 *
 * Runs once per test file (vitest setup-files semantics) and
 * applies every D1 migration the worker ships with against
 * `env.DB` — the real D1 binding miniflare provisions for the
 * test pool.
 *
 * Why this lives in a setup file and not inline in each test:
 *
 *   1. Setup files run OUTSIDE the per-test-file storage
 *      isolation that vitest-pool-workers enforces. That means
 *      the migration cost is paid once per file, not per test.
 *   2. `applyD1Migrations` is idempotent — internally it tracks
 *      which migrations have run via D1's
 *      `d1_migrations` bookkeeping table, the same table the real
 *      `wrangler d1 migrations apply` uses in production. Calling
 *      it from a setup file that may run multiple times is safe.
 *
 * The list of migrations comes from `TEST_MIGRATIONS`, a
 * test-only binding wired in `vitest.config.ts` from the result
 * of `readD1Migrations(migrations/)`. Doing the file-system read
 * in node (config time) and passing the parsed result through as
 * a binding sidesteps the fact that workerd has no fs access.
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
