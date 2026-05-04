import { expect, test } from "@playwright/test";
import { mockApi } from "./api-mocks";

/**
 * E2E happy path for the per-user source toggle feature.
 *
 * Drives a real browser through the production Vite build, with
 * every `/api/*` call intercepted in the page so no Cloudflare
 * worker / wrangler / external creds are needed. Asserts the
 * wiring layer no other test covers:
 *
 *   • the React app boots, mounts FirstRunSetup when the user has
 *     no About/Focus, walks through About → Focus → Sources, and
 *     PATCHes /api/settings with the selected `enabledSourceIds`;
 *   • suggested sources are visually highlighted (sparkle badge +
 *     rationale) and NO checkbox is pre-checked — the AI is
 *     advisory.
 *
 * One-spec scope on purpose: a passing E2E here means the wiring
 * is sound. Per-feature regression coverage stays in the unit and
 * integration tiers — they're cheaper to run and easier to debug.
 */

test.describe("First-run onboarding → sources step → PATCH /api/settings", () => {
  test("walks the wizard and saves only the IDs the user actually checked", async ({ page }) => {
    // `mockApi` returns a recorder that captures every intercepted
    // call. We assert against it at the end of the flow rather
    // than inline — debugging "what did the app actually call?"
    // is much easier when it's all in one place.
    const recorder = await mockApi(page);

    await page.goto("/");

    // Onboarding overlay mounts because /api/me returns no
    // about/focus (DEFAULT_USER in api-mocks.ts).
    await expect(page.getByRole("heading", { name: /Welcome to Primer/ })).toBeVisible();
    await page.getByRole("button", { name: /Get started/ }).click();

    // About step — needs >= 30 chars. Each wizard step renders
    // exactly one textarea, so target it directly rather than via
    // `getByPlaceholder(/.*/)` which over-matches in chromium when
    // the page has any other placeholder-bearing input mounted.
    //
    // Wait for the step heading before filling — `setStep` schedules
    // a React commit, but Playwright's auto-wait on `.first()` will
    // happily resolve to the previous step's textarea if the commit
    // hasn't landed yet, leaving the new step's draft empty and the
    // Continue button disabled. Anchoring on the heading gives us a
    // sync point that only flips once React has actually rendered
    // the new step.
    await expect(page.getByRole("heading", { name: /Tell us about you/ })).toBeVisible();
    await page.locator("textarea").first().fill("I'm a platform engineer with six years of infra experience.");
    await page.getByRole("button", { name: /Continue/ }).click();

    // Focus step — needs >= 20 chars.
    await expect(page.getByRole("heading", { name: /What do you want to learn/ })).toBeVisible();
    await page.locator("textarea").first().fill("kubernetes operators, observability, distributed systems");
    await page.getByRole("button", { name: /Continue/ }).click();

    // Sources step — wait for the heading, then for the LLM-driven
    // suggestions to resolve and the four checkboxes to render.
    await expect(page.getByRole("heading", { name: /Pick your sources/ })).toBeVisible();
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(4, { timeout: 10_000 });

    // Suggested sources surface a "✨ suggested" badge.
    await expect(page.getByText(/suggested/i).first()).toBeVisible();

    // CRITICAL invariant: the AI is purely advisory. No checkbox
    // starts checked.
    const checkboxes = page.locator('input[type="checkbox"]');
    for (let i = 0; i < 4; i++) {
      await expect(checkboxes.nth(i)).not.toBeChecked();
    }

    // User picks one suggested (linear) + one un-suggested (slack)
    // — exercises the "I'll override the AI's recommendation" path.
    await checkboxes.nth(0).check(); // linear
    await checkboxes.nth(1).check(); // slack

    await page.getByRole("button", { name: /Finish/ }).click();

    // The PATCH must include exactly the IDs the user checked —
    // no leakage of un-checked suggestions, no canonical-list
    // dump.
    await expect(async () => {
      const settingsCall = recorder.byPath("/api/settings").find((c) => c.method === "PATCH");
      expect(settingsCall, "expected a PATCH /api/settings call after Finish").toBeTruthy();
      const ids = (settingsCall!.body as { enabledSourceIds: string[] }).enabledSourceIds;
      expect(ids.sort()).toEqual(["linear", "slack"]);
    }).toPass({ timeout: 5_000 });
  });
});
