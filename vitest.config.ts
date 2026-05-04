import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Playwright specs (`tests/e2e/*.spec.ts`) live in the same
    // tree but run under Playwright's own runner — exclude them
    // so vitest doesn't try to load `@playwright/test`'s
    // module-system shape, which would fail before the tests run.
    exclude: ["node_modules/**", "tests/e2e/**"],
    setupFiles: [],
  },
});
