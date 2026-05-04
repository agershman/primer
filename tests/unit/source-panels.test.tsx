// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubPanel } from "../../src/frontend/components/settings/panels/GitHubPanel";
import { IncidentIoPanel } from "../../src/frontend/components/settings/panels/IncidentIoPanel";
import { LinearPanel } from "../../src/frontend/components/settings/panels/LinearPanel";
import { SlackPanel } from "../../src/frontend/components/settings/panels/SlackPanel";
import { buildSettingsValue, withSettings } from "../helpers/settings-fixture";

/**
 * Behavioural tests for the per-source Settings panels. Replace the
 * shallow regex pins ("the file contains the toggle component") with
 * real render-and-click assertions:
 *
 *   1. When `enabledSourceIds` excludes the source, the panel renders
 *      only the toggle row + the "this source is off" hint — none of
 *      the per-source filters are visible.
 *   2. When `enabledSourceIds` includes the source, the filters render.
 *   3. Clicking the toggle calls `updateSettings` with a
 *      `enabledSourceIds` array that contains the source's id.
 *
 * Why this matters: a refactor that re-wires the toggle to the wrong
 * id, or accidentally inverts the conditional, would still pass the
 * regex pin (the file contains "useSourceEnabled" and "!enabled ?")
 * but would break the user-facing behaviour. RTL catches it.
 */

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LinearPanel — toggle integration", () => {
  it("hides the per-source filters when Linear is not in enabledSourceIds", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: [] } });
    render(withSettings(value, <LinearPanel />));

    // The "off" hint must be visible
    expect(screen.getByText(/off for your briefings/i)).toBeTruthy();
    // None of the filter sections should render — the "Issues"
    // and "Status filter" labels live inside the conditional body.
    expect(screen.queryByText("Issues")).toBeNull();
    expect(screen.queryByText("Status filter")).toBeNull();
  });

  it("shows the per-source filters when Linear is enabled", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: ["linear"] } });
    render(withSettings(value, <LinearPanel />));

    expect(screen.queryByText(/off for your briefings/i)).toBeNull();
    expect(screen.getByText("Issues")).toBeTruthy();
    expect(screen.getByText("Status filter")).toBeTruthy();
  });

  it("clicking the toggle while off calls updateSettings with linear added", async () => {
    const updateSettings = vi.fn();
    const value = buildSettingsValue({
      settings: { enabledSourceIds: [] },
      updateSettings,
    });
    render(withSettings(value, <LinearPanel />));

    const toggle = screen.getByLabelText(/Include in my briefings/i);
    await userEvent.click(toggle);

    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ enabledSourceIds: ["linear"] }));
  });

  it("clicking the toggle while on calls updateSettings removing linear", async () => {
    const updateSettings = vi.fn();
    const value = buildSettingsValue({
      settings: { enabledSourceIds: ["linear", "slack"] },
      updateSettings,
    });
    render(withSettings(value, <LinearPanel />));

    const toggle = screen.getByLabelText(/Include in my briefings/i);
    await userEvent.click(toggle);

    // Removed linear, kept slack — order matters less than the set,
    // but `Array.from(new Set(...))` happens to preserve insertion.
    expect(updateSettings).toHaveBeenCalledWith({ enabledSourceIds: ["slack"] });
  });
});

describe("SlackPanel — toggle integration", () => {
  it("collapses the channel-picker when Slack is disabled", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: [] } });
    render(withSettings(value, <SlackPanel />));
    expect(screen.queryByText("Channels")).toBeNull();
    expect(screen.getByText(/off for your briefings/i)).toBeTruthy();
  });

  it("renders the channel-picker when Slack is enabled", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: ["slack"] } });
    render(withSettings(value, <SlackPanel />));
    expect(screen.getByText("Channels")).toBeTruthy();
    expect(screen.getByText("History window")).toBeTruthy();
  });
});

describe("GitHubPanel — toggle integration", () => {
  it("collapses the PR filters when GitHub is disabled", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: [] } });
    render(withSettings(value, <GitHubPanel />));
    expect(screen.queryByText("Pull requests")).toBeNull();
    expect(screen.getByText(/off for your briefings/i)).toBeTruthy();
  });

  it("renders the PR filters when GitHub is enabled", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: ["github"] } });
    render(withSettings(value, <GitHubPanel />));
    expect(screen.getByText("Pull requests")).toBeTruthy();
  });
});

describe("IncidentIoPanel — toggle integration", () => {
  it("hides the in-scope preview when incident_io is disabled", () => {
    const value = buildSettingsValue({ settings: { enabledSourceIds: [] } });
    render(withSettings(value, <IncidentIoPanel />));
    expect(screen.getByText(/incident\.io is off/i)).toBeTruthy();
  });

  it("toggle uses the canonical incident_io id (not incident-io)", async () => {
    // Pin the actual id the panel writes — this is exactly the
    // class of bug 0004 → 0005 fixed: a panel writing "incident-io"
    // instead of "incident_io" would silently never make it past
    // the briefing-pipeline gate.
    const updateSettings = vi.fn();
    const value = buildSettingsValue({
      settings: { enabledSourceIds: [] },
      updateSettings,
    });
    render(withSettings(value, <IncidentIoPanel />));

    const toggle = screen.getByLabelText(/Include in my briefings/i);
    await userEvent.click(toggle);

    expect(updateSettings).toHaveBeenCalledWith({ enabledSourceIds: ["incident_io"] });
  });
});
