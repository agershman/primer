import { type ReactNode } from "react";
import { vi } from "vitest";
import type { UseSettingsResult, UserSettingsData } from "../../src/frontend/hooks/useSettings";
import {
  SettingsProvider,
  type SettingsContextValue,
  type SettingsUserProp,
  type TtsModelDescriptor,
} from "../../src/frontend/components/settings/SettingsContext";

/**
 * Test fixtures for the per-source Settings panels. Stands up a
 * minimum-viable `SettingsContextValue` with stub callbacks so a
 * panel under test can mount without the real `useSettings` hook
 * (which talks to the network) or `useCurrentUser`. Overrides let
 * each test pin only the fields it cares about.
 *
 * The full `UseSettingsResult` shape is mostly slots the panel
 * doesn't read; we satisfy the type with safe stubs and override
 * `settings`, `updateSettings`, and (for the panels that read them)
 * `slackChannels` / `linearTeams` / `previewState`.
 */

const DEFAULT_SETTINGS: UserSettingsData = {
  budgetCapMonthly: 35,
  relevanceThreshold: 0.4,
  nearMissFloor: 0.25,
  signalSurfaceMap: {
    linear: {
      includeAssigned: true,
      includeSubscribed: true,
      includeTeamProjects: false,
      stateTypes: ["triage", "backlog", "unstarted", "started"],
      teamPrefixes: [],
      updatedWithinDays: 0,
    },
    slack: { channels: [], channelNames: [], historyDays: 7 },
    github: {
      repos: [],
      includeReviewRequested: true,
      includeAssigned: true,
      includeCommented: true,
      includeTeamReviews: false,
      teams: [],
      updatedWithinDays: 7,
    },
    models: {},
    externalSources: {},
  },
  filterPrompt: null,
  sourceFilterOverrides: {},
  enabledSourceIds: [],
};

const IDLE = {
  status: "idle" as const,
  data: null,
  elapsedMs: null,
  error: null,
  startedAt: null,
};

export function buildSettingsValue(
  overrides: {
    settings?: Partial<UserSettingsData>;
    updateSettings?: (partial: Partial<UserSettingsData>) => void;
    user?: Partial<SettingsUserProp>;
  } = {},
): SettingsContextValue {
  const merged: UserSettingsData = { ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) };
  const updateSettings = overrides.updateSettings ?? vi.fn();

  const settings: UseSettingsResult = {
    settings: merged,
    loading: false,
    saving: false,
    slackChannels: [],
    linearTeams: [],
    availableModels: [],
    modelDefaults: {
      conceptExtraction: "",
      adjacentScoring: "",
      teachingPiece: "",
      deepDive: "",
      quizGeneration: "",
      quizAssessment: "",
      chat: "",
    },
    previewState: {
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      linear: IDLE as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      slack: IDLE as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      incidents: IDLE as any,
      startedAt: null,
      completedAt: null,
    },
    loadSettings: vi.fn(async () => {}),
    updateSettings,
    loadSlackChannels: vi.fn(async () => {}),
    loadLinearTeams: vi.fn(async () => {}),
    loadModels: vi.fn(async () => {}),
    runPreview: vi.fn(async () => {}),
    resetPreview: vi.fn(),
  };

  const user: SettingsUserProp = {
    email: "test@example.com",
    displayName: "Test User",
    identity: { type: "dev-header" },
    isAdmin: true,
    ...(overrides.user ?? {}),
  };

  const ttsModels: TtsModelDescriptor[] = [];

  return {
    settings,
    user,
    ttsModels,
    onUserChanged: vi.fn(),
    onClose: vi.fn(),
  };
}

export function withSettings(value: SettingsContextValue, children: ReactNode) {
  return <SettingsProvider value={value}>{children}</SettingsProvider>;
}
