import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two-project vitest setup.
 *
 *   • `node` — runs the existing source-text contracts, the
 *     in-memory-SQLite-via-better-sqlite3 integration tier
 *     (`tests/unit/settings-route-integration.test.ts`), and the
 *     React Testing Library component tests under jsdom. Pure
 *     node, no workerd.
 *
 *   • `workers` — runs `tests/integration/**` inside workerd via
 *     `@cloudflare/vitest-pool-workers`. Tests get a real D1
 *     binding (`env.DB`) backed by an in-memory miniflare-managed
 *     SQLite, with all migrations applied via the setup file
 *     `tests/integration/apply-migrations.ts`. This is the tier
 *     where D1-specific semantics (batch atomicity, prepared-
 *     statement caching, the actual `D1Result` shape) are real,
 *     not mocked.
 *
 * Why two projects rather than collapsing onto the workers pool:
 * the workers pool can't run jsdom (no DOM bindings), and most of
 * the existing tests don't NEED workerd — running them there would
 * just be slower. Splitting keeps the cheap unit tier fast and
 * scopes the workerd dependency to where it pays off.
 */
export default defineConfig(async () => {
  // Migrations loaded once at config time so both the workers pool
  // and any future tests can share the parsed list. `readD1Migrations`
  // sorts by filename (matching wrangler's apply order) and parses
  // each .sql file into a list of statements.
  const migrationsPath = path.join(__dirname, "migrations");
  const d1Migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      projects: [
        // ─────────────────────────────────────────────────────────
        // Node project (default). Inherits the previous config:
        // jsdom, the existing include / exclude patterns, and the
        // setup-files slot reserved for future jest-dom expects.
        // ─────────────────────────────────────────────────────────
        {
          test: {
            name: "node",
            globals: true,
            environment: "jsdom",
            include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
            // Exclusions:
            //   • `tests/e2e/**` runs under Playwright's own runner.
            //   • `tests/integration/**` is the workers project below.
            exclude: ["node_modules/**", "tests/e2e/**", "tests/integration/**"],
            setupFiles: [],
          },
        },
        // ─────────────────────────────────────────────────────────
        // Workers project. workerd-backed; tests can `import { env }
        // from "cloudflare:workers"` and exercise the real D1
        // binding. The `cloudflareTest` plugin wires up miniflare
        // from `wrangler.test.toml` and exposes the canonical
        // `applyD1Migrations` helper (used by the setup file).
        // ─────────────────────────────────────────────────────────
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.test.toml" },
              // Test-only binding the setup file reads to apply
              // migrations against `env.DB`. Doing it via a binding
              // (rather than re-reading the SQL files inside the
              // workerd test) keeps the SQL parser in node where it
              // can use the filesystem.
              miniflare: { bindings: { TEST_MIGRATIONS: d1Migrations } },
            }),
          ],
          test: {
            name: "workers",
            include: ["tests/integration/**/*.test.ts"],
            setupFiles: ["./tests/integration/apply-migrations.ts"],
          },
        },
      ],
    },
  };
});
