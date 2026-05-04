import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Primer frontend.
 *
 * Tests live under `tests/e2e/`. They run against the production
 * Vite build served by `vite preview` rather than `vite dev` —
 * preview is faster to start (no HMR overhead) and exercises the
 * exact bundle we ship to Cloudflare Pages.
 *
 * Crucially: NO worker / wrangler / Cloudflare account is required.
 * Every `/api/*` call is intercepted in the browser via
 * `page.route(...)` in the test setup, so the dev server only ever
 * serves static assets. This keeps E2E runnable on a stock GitHub
 * Actions ubuntu-latest runner.
 *
 * `webServer` makes Playwright start (and tear down) the preview
 * server itself before any spec runs, so `bun test:e2e` is the
 * single command developers and CI invoke.
 */
export default defineConfig({
  testDir: "tests/e2e",
  // Spec files live alongside helpers and assets under tests/e2e/
  // — match `*.spec.ts` only so unit fixtures don't get picked up.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    actionTimeout: 5_000,
  },
  projects: [
    // Only chromium for now — keeps the install footprint small
    // (we'll add firefox/webkit if a real cross-browser surface
    // emerges). The user-flow assertions don't depend on
    // browser-specific quirks.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "bun x vite build && bun x vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
