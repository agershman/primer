// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RTL behavioural test for the onboarding "sources" step. Validates:
 *
 *   1. Each suggested source is shown with a "✨ suggested" highlight
 *      AND its rationale.
 *   2. NO checkbox is pre-checked. The user always picks.
 *   3. Clicking a suggested checkbox + finishing PATCHes /settings
 *      with that source's id.
 *
 * Mocks all of `utils/api.ts` so the test never hits the network —
 * canned responses for `/api/sources` and `/api/sources/suggest-enabled`,
 * a recording stub for `apiPatch` so we can assert what got POSTed.
 *
 * Why this matters: the onboarding step is the single place where the
 * user decides their initial source set. A regression that pre-checks
 * suggested sources, swaps suggested+un-suggested visuals, or drops
 * the rationale would all be silent UX bugs the source-text contract
 * tests can't see.
 */

vi.mock("../../src/frontend/utils/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock("../../src/frontend/components/DictationButton", () => ({
  DictationButton: () => null,
}));

vi.mock("../../src/frontend/components/RefineDialog", () => ({
  RefineDialog: () => null,
}));

import { FirstRunSetup } from "../../src/frontend/components/FirstRunSetup";
import { apiGet, apiPatch, apiPost } from "../../src/frontend/utils/api";

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);
const mockApiPatch = vi.mocked(apiPatch);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SOURCES_RESPONSE = {
  sources: [
    { id: "linear", name: "Linear", multiInstance: false, available: true, settingsManifest: null },
    { id: "slack", name: "Slack", multiInstance: false, available: true, settingsManifest: null },
    { id: "github", name: "GitHub", multiInstance: false, available: true, settingsManifest: null },
    {
      id: "incident_io",
      name: "incident.io",
      multiInstance: false,
      available: true,
      settingsManifest: null,
    },
  ],
};

const SUGGESTIONS_RESPONSE = {
  suggestions: [
    { id: "linear", recommended: true, rationale: "You mentioned engineering work in your About." },
    { id: "github", recommended: true, rationale: "Your focus calls out shipping pull requests." },
    { id: "slack", recommended: false, rationale: "" },
    { id: "incident_io", recommended: false, rationale: "" },
  ],
};

describe("FirstRunSetup — sources step (already on it)", () => {
  it("renders every available source unchecked, with suggested ones highlighted", async () => {
    mockApiGet.mockResolvedValue(SOURCES_RESPONSE);
    mockApiPost.mockResolvedValue(SUGGESTIONS_RESPONSE);

    render(
      <FirstRunSetup
        initialAbout="I'm a platform engineer, six years in."
        initialFocus="kubernetes operators, observability"
        onComplete={() => {}}
        onSkip={() => {}}
      />,
    );

    // We pass `initialAbout` in props, so the wizard's `advance()`
    // skips the about step entirely (intro → focus → sources).
    // Two clicks total: "Get started" puts us on focus, "Continue"
    // saves the (already-set) focus and advances to sources.
    await userEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Continue/ })); // focus → sources

    // Wait for the sources fetch to resolve
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBe(4));

    // The suggested badge appears for the LLM-recommended ids only.
    const suggestedBadges = screen.getAllByText(/suggested/i);
    expect(suggestedBadges.length).toBe(2);

    // Rationales render for suggested sources, not for un-suggested.
    expect(screen.getByText(/engineering work in your About/i)).toBeTruthy();
    expect(screen.getByText(/shipping pull requests/i)).toBeTruthy();

    // CRITICAL: every checkbox starts unchecked. The AI is purely
    // advisory — the user decides.
    for (const cb of screen.getAllByRole("checkbox")) {
      expect((cb as HTMLInputElement).checked).toBe(false);
    }
  });

  it("PATCHes /api/settings with only the IDs the user actually checked", async () => {
    mockApiGet.mockResolvedValue(SOURCES_RESPONSE);
    mockApiPost.mockResolvedValue(SUGGESTIONS_RESPONSE);
    mockApiPatch.mockResolvedValue({});
    const onComplete = vi.fn();

    render(
      <FirstRunSetup
        initialAbout="I'm a platform engineer with six years of infra experience."
        initialFocus="kubernetes operators, observability, distributed systems"
        onComplete={onComplete}
        onSkip={() => {}}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBe(4));

    // User picks linear (suggested) + slack (NOT suggested) — i.e.
    // ignores one suggestion and adds one not suggested. This is
    // the case the AI's advisory model has to support.
    const checkboxes = screen.getAllByRole("checkbox");
    // Order in `availableSources` matches SOURCES_RESPONSE.sources
    // (filter preserves order). Linear is index 0, Slack index 1.
    await userEvent.click(checkboxes[0]);
    await userEvent.click(checkboxes[1]);

    await userEvent.click(screen.getByRole("button", { name: /Finish/ }));

    await waitFor(() => expect(mockApiPatch).toHaveBeenCalled());
    expect(mockApiPatch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ enabledSourceIds: expect.arrayContaining(["linear", "slack"]) }),
    );
    // Crucially, sources the user did NOT check don't sneak in.
    const callArg = mockApiPatch.mock.calls[0][1] as { enabledSourceIds: string[] };
    expect(callArg.enabledSourceIds).not.toContain("github");
    expect(callArg.enabledSourceIds).not.toContain("incident_io");
    expect(onComplete).toHaveBeenCalled();
  });
});
