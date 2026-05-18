import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceId } from "../../shared/sources";
import { apiGet, apiPatch, apiPost } from "../utils/api";

export interface LinearSourceSettings {
  includeAssigned: boolean;
  includeSubscribed: boolean;
  includeTeamProjects: boolean;
  stateTypes: string[];
  teamPrefixes: string[];
  updatedWithinDays: number;
}

export interface SlackSourceSettings {
  channels: string[];
  channelNames: string[];
  historyDays: number;
}

export type ModelOperation =
  | "conceptExtraction"
  | "adjacentScoring"
  | "teachingPiece"
  | "deepDive"
  | "quizGeneration"
  | "quizAssessment"
  | "chat";

export interface ModelsSettings {
  conceptExtraction?: string;
  adjacentScoring?: string;
  teachingPiece?: string;
  deepDive?: string;
  quizGeneration?: string;
  quizAssessment?: string;
  chat?: string;
  /**
   * Continuation classifier — decides whether a fresh draft is novel,
   * an additive continuation, or redundant. Cheap by design (defaults
   * to Haiku); the field is here so users can override it from the
   * AI Models panel.
   */
  continuationClassifier?: string;
  /**
   * Default TTS voice id — used as the catch-all when an operation
   * doesn't have its own override below. Belongs alongside the LLM
   * model picks because the user thinks of it as "the voice that reads
   * my articles" — same conceptual surface as "the model that writes
   * them". Stored as the voice id from `/api/tts-models`.
   */
  ttsModel?: string;
  /**
   * Per-operation TTS voice overrides. Mirrors how per-operation LLM
   * picks (`teachingPiece` / `deepDive` / `chat`) work — set any of
   * these to scope a different voice to that surface; leave unset to
   * fall back to `ttsModel` (the global default). Resolution lives in
   * `worker/services/tts.ts → resolveTtsModel`.
   */
  ttsModelTeachingPiece?: string;
  ttsModelDeepDive?: string;
  ttsModelChat?: string;
}

export interface GitHubSourceSettings {
  repos: string[];
  includeReviewRequested: boolean;
  includeAssigned: boolean;
  includeCommented: boolean;
  includeTeamReviews: boolean;
  teams: string[];
  updatedWithinDays: number;
}

/**
 * `signalSurfaceMap` carries the well-known per-source settings
 * (linear / slack / github / models / externalSources) plus —
 * critically — arbitrary additional keys for dynamically-registered
 * source instances (e.g. multi-instance feed sources keyed by their
 * source id like `feed-rss-abc123`). Pre-fix, this was modelled as
 * a fixed-key union and the `handleSourceConfigChange` call site in
 * `SettingsModal` cast the spread through `as any` to satisfy the
 * type checker — papering over the fact that the runtime shape is
 * fixed-keys-PLUS-arbitrary-string-keys.
 *
 * The intersection type below makes this honest: known sub-shapes
 * are still typed strictly, and unknown keys carry `unknown`
 * (forcing call sites that read those values to do a runtime
 * shape check instead of trusting the type).
 */
export type SignalSurfaceMap = {
  linear: LinearSourceSettings;
  slack: SlackSourceSettings;
  github: GitHubSourceSettings;
  models: ModelsSettings;
  externalSources: Record<string, unknown>;
} & {
  // Allow extra source-id keys for instance-based sources (RSS
  // feeds, etc). The `unknown` value type forces consumers to
  // narrow before reading, so we don't lose runtime safety.
  [extraSourceId: string]: unknown;
};

export interface UserSettingsData {
  budgetCapMonthly: number;
  relevanceThreshold: number;
  nearMissFloor: number;
  signalSurfaceMap: SignalSurfaceMap;
  filterPrompt: string | null;
  sourceFilterOverrides: Record<string, string>;
  /**
   * Per-user opt-in list of source IDs (e.g. `["linear", "rss"]`).
   * Sources not in this list don't fan into the user's briefing.
   * Brand-new users land on `[]`; existing users were backfilled
   * with everything in migration 0004. Typed as `SourceId[]` so a
   * typo'd id is a compile error rather than a silent runtime
   * miss — see `shared/sources.ts` for the canonical list.
   */
  enabledSourceIds: SourceId[];
}

export interface AvailableModel {
  id: string;
  label: string;
  tier: "fast" | "balanced" | "quality";
  description: string;
  /** Provider id — Anthropic today; PR 4 adds OpenAI / Google / etc. */
  provider?: string;
  /** Reasoning capability — `"none"` (no toggle), `"effort"` (low/med/high
   *  enum like OpenAI), or `"budget"` (token budget like Anthropic
   *  extended thinking / Gemini thinking). PR 4 surfaces this as a
   *  third dropdown in the per-use-case row. */
  reasoning?: "none" | "effort" | "budget";
  supportsTools?: boolean;
  contextWindow?: number;
  pricing?: {
    inputPer1M: number;
    outputPer1M: number;
  };
}

interface ModelsResponse {
  models: AvailableModel[];
  defaults: Record<ModelOperation, string>;
}

export interface SlackChannel {
  id: string;
  name: string;
  memberCount: number;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

interface SettingsResponse {
  settings: UserSettingsData;
}

interface SlackChannelsResponse {
  channels: SlackChannel[];
}

interface LinearTeamsResponse {
  teams: LinearTeam[];
}

export interface LinearPreviewPayload {
  total: number;
  issues: Array<{ identifier: string; title: string; url: string; reason: string }>;
  elapsedMs?: number;
  error?: string;
}

export interface SlackPreviewPayload {
  channelCount: number;
  historyDays: number;
  channels: Array<{ id: string; name: string }>;
  elapsedMs?: number;
}

export interface IncidentsPreviewPayload {
  total: number;
  elapsedMs?: number;
  error?: string;
}

export interface PreviewData {
  linear: Omit<LinearPreviewPayload, "elapsedMs" | "error">;
  slack: Omit<SlackPreviewPayload, "elapsedMs">;
  incidents: Pick<IncidentsPreviewPayload, "total">;
}

export type PreviewSourceStatus = "idle" | "loading" | "ready" | "error";

export interface PreviewSourceState<T> {
  status: PreviewSourceStatus;
  data: T | null;
  elapsedMs: number | null;
  error: string | null;
  startedAt: number | null;
}

export interface PreviewState {
  linear: PreviewSourceState<LinearPreviewPayload>;
  slack: PreviewSourceState<SlackPreviewPayload>;
  incidents: PreviewSourceState<IncidentsPreviewPayload>;
  startedAt: number | null;
  completedAt: number | null;
}

export interface UseSettingsResult {
  settings: UserSettingsData | null;
  loading: boolean;
  saving: boolean;
  slackChannels: SlackChannel[];
  linearTeams: LinearTeam[];
  availableModels: AvailableModel[];
  modelDefaults: Record<ModelOperation, string>;
  previewState: PreviewState;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<UserSettingsData>) => void;
  loadSlackChannels: () => Promise<void>;
  loadLinearTeams: () => Promise<void>;
  loadModels: () => Promise<void>;
  runPreview: (filters: UserSettingsData["signalSurfaceMap"]) => Promise<void>;
  resetPreview: () => void;
}

const IDLE_SOURCE: PreviewSourceState<never> = {
  status: "idle",
  data: null,
  elapsedMs: null,
  error: null,
  startedAt: null,
};

const INITIAL_PREVIEW: PreviewState = {
  linear: IDLE_SOURCE as PreviewSourceState<LinearPreviewPayload>,
  slack: IDLE_SOURCE as PreviewSourceState<SlackPreviewPayload>,
  incidents: IDLE_SOURCE as PreviewSourceState<IncidentsPreviewPayload>,
  startedAt: null,
  completedAt: null,
};

const DEFAULT_SETTINGS: UserSettingsData = {
  budgetCapMonthly: 35,
  relevanceThreshold: 0.4,
  nearMissFloor: 0.25,
  signalSurfaceMap: {
    linear: {
      updatedWithinDays: 0,
      includeAssigned: true,
      includeSubscribed: true,
      includeTeamProjects: false,
      stateTypes: ["triage", "backlog", "unstarted", "started"],
      teamPrefixes: [],
    },
    slack: {
      channels: [],
      channelNames: [],
      historyDays: 7,
    },
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

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<UserSettingsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([]);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelDefaults, setModelDefaults] = useState<Record<ModelOperation, string>>({
    conceptExtraction: "",
    adjacentScoring: "",
    teachingPiece: "",
    deepDive: "",
    quizGeneration: "",
    quizAssessment: "",
    chat: "",
  });
  const [previewState, setPreviewState] = useState<PreviewState>(INITIAL_PREVIEW);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdate = useRef<Partial<UserSettingsData> | null>(null);
  // Stable ref-to-latest-flushSave so the unmount + beforeunload
  // listeners can call the freshest `flushSave` without re-arming on
  // every render. Initialised null and populated in the effect below.
  const flushSaveRef = useRef<((merged: UserSettingsData) => Promise<void>) | null>(null);

  const normalize = useCallback((s: Partial<UserSettingsData> | null | undefined): UserSettingsData => {
    if (!s) return DEFAULT_SETTINGS;
    const map = (s.signalSurfaceMap ?? {}) as Partial<UserSettingsData["signalSurfaceMap"]>;
    return {
      budgetCapMonthly: s.budgetCapMonthly ?? DEFAULT_SETTINGS.budgetCapMonthly,
      relevanceThreshold: s.relevanceThreshold ?? DEFAULT_SETTINGS.relevanceThreshold,
      nearMissFloor: s.nearMissFloor ?? DEFAULT_SETTINGS.nearMissFloor,
      signalSurfaceMap: {
        linear: { ...DEFAULT_SETTINGS.signalSurfaceMap.linear, ...(map.linear ?? {}) },
        slack: { ...DEFAULT_SETTINGS.signalSurfaceMap.slack, ...(map.slack ?? {}) },
        github: { ...DEFAULT_SETTINGS.signalSurfaceMap.github, ...(map.github ?? {}) },
        models: { ...DEFAULT_SETTINGS.signalSurfaceMap.models, ...(map.models ?? {}) },
        externalSources: map.externalSources ?? {},
      },
      filterPrompt: s.filterPrompt ?? null,
      sourceFilterOverrides: s.sourceFilterOverrides ?? {},
      // The wire shape comes back as `SourceId[]` already (settings
      // route filters unknown IDs out), but defensively narrow on
      // read in case an older deploy persisted a malformed value.
      enabledSourceIds: Array.isArray(s.enabledSourceIds)
        ? (s.enabledSourceIds.filter((v): v is SourceId => typeof v === "string") as SourceId[])
        : [],
    };
  }, []);

  const flushSave = useCallback(
    async (merged: UserSettingsData) => {
      setSaving(true);
      try {
        const resp = await apiPatch<SettingsResponse>("/api/settings", merged);
        setSettings(normalize(resp.settings));
      } catch {
        // Revert optimistic update on failure — leave current state so user can retry
      } finally {
        setSaving(false);
      }
    },
    [normalize],
  );

  // Pin the latest `flushSave` into a ref so the unmount + unload
  // listeners (declared once below) always call the current
  // function, not a stale closure. Without this, those listeners
  // would close over the first-render flushSave and miss any later
  // change to its `normalize` dependency.
  useEffect(() => {
    flushSaveRef.current = flushSave;
  }, [flushSave]);

  /**
   * Flush a pending debounced save right now — used by:
   *   1. Component unmount (e.g. user closes the Settings modal
   *      mid-debounce). Without this, a 500 ms pending edit dies
   *      with the modal and the user discovers their toggle didn't
   *      stick on the next page load.
   *   2. The `beforeunload` listener below — same logic, but for
   *      tab-close / navigate-away rather than React unmount.
   *
   * Cheap and safe to call even with no pending update: the inner
   * `pendingUpdate.current === null` branch makes it a no-op.
   */
  const flushPendingSave = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    const pending = pendingUpdate.current;
    if (pending) {
      pendingUpdate.current = null;
      void flushSaveRef.current?.(pending as UserSettingsData);
    }
  }, []);

  // Unmount-time flush: when the consumer (typically SettingsModal)
  // unmounts, drain any in-flight debounce so the user's last edit
  // actually lands. The `beforeunload` companion below covers the
  // tab-close path. Together these eliminate the data-loss window
  // that previously existed between a keystroke and the 500 ms
  // debounce flush.
  useEffect(() => {
    return () => {
      flushPendingSave();
    };
  }, [flushPendingSave]);

  // Tab-close / navigate-away flush. `beforeunload` fires
  // synchronously, so we can't await the network call here — we
  // kick off `flushPendingSave` and let the browser's
  // keep-alive-while-unloading window handle the in-flight POST.
  // The `apiPatch` helper uses fetch with the default keepalive
  // config, which is sufficient for a small JSON body.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeUnload = () => {
      flushPendingSave();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flushPendingSave]);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<SettingsResponse>("/api/settings");
      setSettings(normalize(data.settings));
    } catch {
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setLoading(false);
    }
  }, [normalize]);

  const updateSettings = useCallback(
    (partial: Partial<UserSettingsData>) => {
      setSettings((prev) => {
        const base = prev ?? DEFAULT_SETTINGS;
        const merged = { ...base, ...partial };

        if (partial.signalSurfaceMap) {
          merged.signalSurfaceMap = {
            ...base.signalSurfaceMap,
            ...partial.signalSurfaceMap,
            linear: {
              ...base.signalSurfaceMap.linear,
              ...(partial.signalSurfaceMap.linear ?? {}),
            },
            slack: {
              ...base.signalSurfaceMap.slack,
              ...(partial.signalSurfaceMap.slack ?? {}),
            },
          };
        }

        pendingUpdate.current = merged;

        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
          if (pendingUpdate.current) {
            flushSave(pendingUpdate.current as UserSettingsData);
            pendingUpdate.current = null;
          }
        }, 500);

        return merged;
      });
    },
    [flushSave],
  );

  const loadSlackChannels = useCallback(async () => {
    try {
      const data = await apiGet<SlackChannelsResponse>("/api/slack/channels");
      setSlackChannels(data.channels);
    } catch {
      // Non-critical — channels may not be available
    }
  }, []);

  const loadLinearTeams = useCallback(async () => {
    try {
      const data = await apiGet<LinearTeamsResponse>("/api/linear/teams");
      setLinearTeams(data.teams);
    } catch {
      // Non-critical — teams may not be available
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const data = await apiGet<ModelsResponse>("/api/models");
      setAvailableModels(data.models);
      setModelDefaults(data.defaults);
    } catch {
      // Non-critical
    }
  }, []);

  const resetPreview = useCallback(() => {
    setPreviewState(INITIAL_PREVIEW);
  }, []);

  const runPreview = useCallback(async (filters: UserSettingsData["signalSurfaceMap"]) => {
    const startedAt = Date.now();
    const loading = <T>(): PreviewSourceState<T> => ({
      status: "loading",
      data: null,
      elapsedMs: null,
      error: null,
      startedAt,
    });

    setPreviewState({
      linear: loading<LinearPreviewPayload>(),
      slack: loading<SlackPreviewPayload>(),
      incidents: loading<IncidentsPreviewPayload>(),
      startedAt,
      completedAt: null,
    });

    const linearPromise = apiPost<LinearPreviewPayload>("/api/settings/preview/linear", {
      linear: filters.linear,
    })
      .then((data) =>
        setPreviewState((prev) => ({
          ...prev,
          linear: {
            status: data.error ? "error" : "ready",
            data,
            elapsedMs: data.elapsedMs ?? Date.now() - startedAt,
            error: data.error ?? null,
            startedAt,
          },
        })),
      )
      .catch((err: Error) =>
        setPreviewState((prev) => ({
          ...prev,
          linear: {
            status: "error",
            data: null,
            elapsedMs: Date.now() - startedAt,
            error: err.message ?? "Linear fetch failed",
            startedAt,
          },
        })),
      );

    const slackPromise = apiPost<SlackPreviewPayload>("/api/settings/preview/slack", {
      slack: filters.slack,
    })
      .then((data) =>
        setPreviewState((prev) => ({
          ...prev,
          slack: {
            status: "ready",
            data,
            elapsedMs: data.elapsedMs ?? Date.now() - startedAt,
            error: null,
            startedAt,
          },
        })),
      )
      .catch((err: Error) =>
        setPreviewState((prev) => ({
          ...prev,
          slack: {
            status: "error",
            data: null,
            elapsedMs: Date.now() - startedAt,
            error: err.message ?? "Slack preview failed",
            startedAt,
          },
        })),
      );

    const incidentsPromise = apiGet<IncidentsPreviewPayload>("/api/settings/preview/incidents")
      .then((data) =>
        setPreviewState((prev) => ({
          ...prev,
          incidents: {
            status: data.error ? "error" : "ready",
            data,
            elapsedMs: data.elapsedMs ?? Date.now() - startedAt,
            error: data.error ?? null,
            startedAt,
          },
        })),
      )
      .catch((err: Error) =>
        setPreviewState((prev) => ({
          ...prev,
          incidents: {
            status: "error",
            data: null,
            elapsedMs: Date.now() - startedAt,
            error: err.message ?? "incident.io fetch failed",
            startedAt,
          },
        })),
      );

    await Promise.allSettled([linearPromise, slackPromise, incidentsPromise]);
    setPreviewState((prev) => ({ ...prev, completedAt: Date.now() }));
  }, []);

  return {
    settings,
    loading,
    saving,
    slackChannels,
    linearTeams,
    availableModels,
    modelDefaults,
    previewState,
    loadSettings,
    updateSettings,
    loadSlackChannels,
    loadLinearTeams,
    loadModels,
    runPreview,
    resetPreview,
  };
}
