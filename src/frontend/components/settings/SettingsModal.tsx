import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SignalSurfaceMap, UseSettingsResult } from "../../hooks/useSettings";
import { onPrimerEvent } from "../../lib/events";
import { GenericSourcePanel } from "../../sources/GenericSourcePanel";
import type { SourceDescriptor } from "../../sources/types";
import { apiGet } from "../../utils/api";
import { AboutPanel } from "./panels/AboutPanel";
import { AccountPanel } from "./panels/AccountPanel";
import { FeedsPanel } from "./panels/FeedsPanel";
import { FilterPanel } from "./panels/FilterPanel";
import { FocusPanel } from "./panels/FocusPanel";
import { GitHubPanel } from "./panels/GitHubPanel";
import { IncidentIoPanel } from "./panels/IncidentIoPanel";
import { LimitsPanel } from "./panels/LimitsPanel";
import { LinearPanel } from "./panels/LinearPanel";
import { ModelsPanel } from "./panels/ModelsPanel";
import { SlackPanel } from "./panels/SlackPanel";
import { SourcesOverviewPanel } from "./panels/SourcesOverviewPanel";
import { UsersPanel } from "./panels/UsersPanel";
import { VoicePanel } from "./panels/VoicePanel";
import { SettingsProvider, type SettingsUserProp, type TtsModelDescriptor } from "./SettingsContext";
import {
  getInitials,
  IconAccount,
  IconFeeds,
  IconFocus,
  IconGitHub,
  IconIncidents,
  IconLimits,
  IconLinear,
  IconModels,
  IconSlack,
  IconUsers,
  IconVoice,
} from "./shared";

interface SettingsModalProps {
  settings: UseSettingsResult;
  user: SettingsUserProp | null;
  onClose: () => void;
  onUserChanged?: () => void;
}

type PanelId = string;

interface NavEntry {
  id: PanelId;
  label: string;
  group: string;
  icon: ReactNode;
  Component: () => ReactNode;
  keywords?: string[];
}

const CUSTOM_SOURCE_PANELS: Record<string, () => ReactNode> = {
  linear: LinearPanel,
  slack: SlackPanel,
  github: GitHubPanel,
  incident_io: IncidentIoPanel,
};

// Per-source nav icons. Each known provider gets its own glyph so
// the sidenav reads as a quick visual "what's this?" rather than a
// uniform stack. Unknown / future sources fall back to the generic
// feeds icon at the call site.
const SOURCE_ICONS: Record<string, () => ReactNode> = {
  linear: IconLinear,
  slack: IconSlack,
  github: IconGitHub,
  incident_io: IconIncidents,
};

const STATIC_NAV: NavEntry[] = [
  {
    id: "sources",
    group: "Sources",
    label: "Sources",
    icon: <IconFeeds />,
    Component: SourcesOverviewPanel,
    keywords: ["sources", "enable", "disable", "toggle", "linear", "slack", "github", "rss", "hn", "arxiv", "incident"],
  },
  {
    id: "feeds",
    group: "Sources",
    label: "Feeds",
    icon: <IconFeeds />,
    Component: FeedsPanel,
    keywords: ["rss", "feeds", "blog", "external", "hacker news", "arxiv", "newsletter"],
  },
  {
    id: "models",
    group: "Intelligence",
    label: "AI models",
    icon: <IconModels />,
    Component: ModelsPanel,
    keywords: ["claude", "anthropic", "haiku", "sonnet", "opus"],
  },
  {
    id: "voice",
    group: "Intelligence",
    label: "Voice",
    icon: <IconVoice />,
    Component: VoicePanel,
    keywords: ["tts", "audio", "speech", "listen"],
  },
  {
    id: "about",
    group: "Personalization",
    label: "About you",
    icon: <IconAccount />,
    Component: AboutPanel,
    keywords: ["persona", "about", "voice", "tone"],
  },
  {
    id: "focus",
    group: "Personalization",
    label: "Current focus",
    icon: <IconFocus />,
    Component: FocusPanel,
    keywords: ["focus", "priorities", "topics"],
  },
  {
    id: "filter",
    group: "Personalization",
    label: "Relevance filter",
    icon: <IconFocus />,
    Component: FilterPanel,
    keywords: ["filter", "relevance", "criteria", "prompt", "ai filter"],
  },
  {
    id: "limits",
    group: "General",
    label: "Briefing limits",
    icon: <IconLimits />,
    Component: LimitsPanel,
    keywords: ["budget", "cost", "relevance", "threshold"],
  },
  {
    id: "users",
    group: "General",
    label: "Users",
    icon: <IconUsers />,
    Component: UsersPanel,
    keywords: ["users", "admin", "promote", "demote", "role", "permissions"],
  },
  {
    id: "account",
    group: "General",
    label: "Account",
    icon: <IconAccount />,
    Component: AccountPanel,
    keywords: ["reset", "danger", "auth"],
  },
];

function buildSourceNavEntries(
  sources: Array<SourceDescriptor & { available: boolean; userFields: unknown[] | null }>,
  sourceConfig: Record<string, unknown>,
  onConfigChange: (sourceId: string, patch: Record<string, unknown>) => void,
): NavEntry[] {
  return sources
    .filter((s) => s.available && s.userFields && s.userFields.length > 0)
    .map((s) => {
      const customPanel = CUSTOM_SOURCE_PANELS[s.id] as (() => ReactNode) | undefined;
      const manifest = s.settingsManifest;
      const fallbackPanel = () => (
        <GenericSourcePanel
          sourceId={s.id}
          manifest={manifest!}
          sourceConfig={sourceConfig}
          onConfigChange={onConfigChange}
        />
      );
      const SourceIcon = SOURCE_ICONS[s.id] ?? IconFeeds;
      return {
        id: s.id,
        group: "Sources",
        label: manifest?.nav.label ?? s.name,
        icon: <SourceIcon />,
        Component: customPanel ?? fallbackPanel,
        keywords: manifest?.nav.keywords ?? [],
      };
    });
}

const GROUP_ORDER = ["Sources", "Intelligence", "Personalization", "General"] as const;

export function SettingsModal({ settings, user, onClose, onUserChanged }: SettingsModalProps) {
  const [activePanel, setActivePanel] = useState<PanelId>("about");
  const [search, setSearch] = useState("");
  const [ttsModels, setTtsModels] = useState<TtsModelDescriptor[]>([]);
  const ttsLoadedRef = useRef(false);
  const [apiSources, setApiSources] = useState<
    Array<SourceDescriptor & { available: boolean; userFields: unknown[] | null }>
  >([]);

  const {
    settings: data,
    loading,
    saving,
    loadSettings,
    updateSettings,
    loadSlackChannels,
    loadLinearTeams,
    loadModels,
    runPreview,
    previewState,
  } = settings;

  const handleSourceConfigChange = useCallback(
    (sourceId: string, patch: Record<string, unknown>) => {
      // `SignalSurfaceMap` is now an intersection of the known
      // sub-shapes (linear / slack / github / models / etc.) AND
      // an index signature for arbitrary source-id keys (used by
      // instance-based sources). The cast we used to need (`as any`)
      // is gone — the spread over `current` is type-safe now that
      // the type explicitly allows extra string keys.
      const current = data?.signalSurfaceMap;
      updateSettings({
        signalSurfaceMap: {
          ...(current ?? ({} as SignalSurfaceMap)),
          [sourceId]: patch,
        },
      });
    },
    [data?.signalSurfaceMap, updateSettings],
  );

  useEffect(() => {
    loadSettings();
    loadSlackChannels();
    loadLinearTeams();
    loadModels();
    // `/api/sources` and `/api/tts-models` go through the shared
    // `apiGet` helper now (was raw fetch) — same TZ header + 503
    // retry semantics as the rest of the app.
    apiGet<{
      sources: Array<SourceDescriptor & { available: boolean; userFields: unknown[] | null }>;
    }>("/api/sources")
      .then((data) => setApiSources(data.sources))
      .catch(() => {
        // Non-fatal; the panel still renders with whatever's in
        // local state. Logging would spam dev tools on a flaky
        // network — silent failure is the right default for a
        // soft-fetch like this.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ttsLoadedRef.current) return;
    ttsLoadedRef.current = true;
    apiGet<{ models: TtsModelDescriptor[] }>("/api/tts-models")
      .then((json) => setTtsModels(json.models))
      .catch(() => {
        // Same soft-fetch semantics as `/api/sources` above.
      });
  }, []);

  // The per-article VoiceSwitcher dispatches `tts-voice-changed`
  // when the user picks a new default from a piece's Listen control.
  // We reload the settings here so the panel's voice dropdown reflects
  // the new value the next time the user opens it.
  useEffect(() => onPrimerEvent("tts-voice-changed", () => loadSettings()), [loadSettings]);

  // Esc closes the modal — matches the previous SettingsPanel behaviour
  // and is what the mockup implies (the `✕` button in the header is a
  // visual reinforcement of the same intent).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Track filter changes against the most recently-built preview so we
  // can show the user a "filters changed — rebuild" hint without auto-
  // rerunning. Cheap to compute; just a JSON serialisation of the
  // signal-surface map.
  const filtersKey = data
    ? JSON.stringify({
        linear: data.signalSurfaceMap.linear,
        slack: data.signalSurfaceMap.slack,
        github: (data.signalSurfaceMap as Record<string, unknown>).github,
      })
    : "";
  const previewFiltersKey = useRef("");
  const [previewStale, setPreviewStale] = useState(false);
  useEffect(() => {
    if (!filtersKey) return;
    if (previewState.startedAt === null) return;
    if (previewFiltersKey.current && previewFiltersKey.current !== filtersKey) {
      setPreviewStale(true);
    }
  }, [filtersKey, previewState.startedAt]);

  const handleRunPreview = async () => {
    if (!data) return;
    previewFiltersKey.current = filtersKey;
    setPreviewStale(false);
    await runPreview(data.signalSurfaceMap);
  };

  // Search filters the visible nav. We match on label + keywords. Empty
  // search shows everything. If the active panel is filtered out, the
  // first remaining match becomes active so the panel area never goes
  // blank mid-typing.
  const sourceConfig = (data?.signalSurfaceMap ?? {}) as Record<string, unknown>;

  const isAdmin = user?.isAdmin === true;

  // Regular users only see Personalization (About / Focus / Relevance
  // filter) plus their own Sources opt-in toggles plus Account —
  // everything else is a deployment-wide setting reserved for the
  // admin. The server enforces the same gates on the underlying
  // mutations, so hiding them client-side is a UX hint, not a
  // security boundary. `"sources"` is on the per-user list because
  // it's the new SourcesOverviewPanel that toggles `enabledSourceIds`
  // — a user-level field, distinct from the admin-only per-source
  // detail panels.
  const REGULAR_USER_PANEL_IDS = new Set(["about", "focus", "filter", "sources", "account"]);

  const NAV = useMemo(() => {
    const sourceEntries = buildSourceNavEntries(apiSources, sourceConfig, handleSourceConfigChange);
    const all = [...sourceEntries, ...STATIC_NAV];
    if (isAdmin) return all;
    return all.filter((entry) => REGULAR_USER_PANEL_IDS.has(entry.id));
  }, [apiSources, sourceConfig, handleSourceConfigChange, isAdmin]);

  const filteredNav = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.filter((n) => {
      if (n.label.toLowerCase().includes(q)) return true;
      if (n.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [search, NAV]);

  useEffect(() => {
    if (filteredNav.length === 0) return;
    if (filteredNav.some((n) => n.id === activePanel)) return;
    setActivePanel(filteredNav[0].id);
  }, [filteredNav, activePanel]);

  const ActivePanel = NAV.find((n) => n.id === activePanel)?.Component ?? NAV[0]?.Component ?? AboutPanel;

  const email = user?.email ?? "unknown";
  const displayName = user?.displayName ?? email.split("@")[0];
  const authMode = user?.identity?.type === "dev" ? "Development mode" : "Authenticated via Cloudflare Access";

  const previewRunning =
    previewState.linear.status === "loading" ||
    previewState.slack.status === "loading" ||
    previewState.incidents.status === "loading";
  const hasAnyPreview = previewState.startedAt !== null;
  const previewLabel = previewRunning
    ? "Running…"
    : !hasAnyPreview
      ? "Build full briefing preview"
      : previewStale
        ? "Rebuild — filters changed"
        : "Rebuild full briefing preview";

  if (loading || !data) {
    return createPortal(
      <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
        <div
          className="w-full max-w-xl rounded-xl bg-bg border border-border shadow-2xl p-8 text-center animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-sm font-mono text-text-dim">Loading settings…</span>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <SettingsProvider
      value={{
        settings,
        user,
        ttsModels,
        onUserChanged: () => onUserChanged?.(),
        onClose,
      }}
    >
      <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
        <div
          // Bumped to 5xl (1024px) so the "Relevance filter" label
          // fits without truncating in the sidenav. Pre-bump was 4xl
          // (896px) which clipped any sidenav label longer than ~14
          // chars given the 180px nav column.
          //
          // Height: fixed at min(85vh, 760px) instead of just a
          // `maxHeight` cap. Pre-fix the modal hugged the active
          // panel's content height — short panels like About/Focus
          // and Account felt cramped (the textarea sat right next to
          // the modal frame with no breathing room) while long
          // panels like Linear sources used the full 90vh. With a
          // floor in place every panel gets the same generous
          // canvas, the inner panel's own `overflow-y-auto` handles
          // long content (Linear, AI models), and short content
          // breathes. The 760px upper bound prevents the modal from
          // looking comically tall on 4K displays.
          className="w-full max-w-5xl rounded-xl bg-bg border border-border shadow-2xl overflow-hidden flex flex-col animate-fade-in"
          style={{ height: "min(85vh, 760px)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-border-subtle">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-dim text-accent font-ui text-sm font-semibold select-none overflow-hidden shrink-0">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                getInitials(email, user?.displayName ?? null)
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-text-primary leading-tight truncate">{displayName}</div>
              <div className="text-[11px] font-mono text-text-dim leading-snug truncate">{authMode}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="shrink-0 text-text-dim hover:text-text-secondary p-1.5 rounded-md hover:bg-surface-hover transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="shrink-0 px-4 py-2 border-b border-border-subtle">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search settings…"
              className="w-full h-8 bg-surface border border-border rounded-md px-2.5 text-xs font-mono text-text-primary placeholder:text-text-faint outline-none focus:border-accent transition-colors"
            />
          </div>

          {/* Body: nav + active panel. Sidenav is 200px so longer
              labels like "Relevance filter" fit without truncating
              alongside the icon + padding. */}
          <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[200px_1fr] md:divide-x md:divide-border-subtle">
            <SettingsNav
              groups={GROUP_ORDER}
              entries={filteredNav}
              activePanel={activePanel}
              onSelect={setActivePanel}
            />
            <div className="min-h-0 overflow-y-auto px-5 py-4">
              <ActivePanel />
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 border-t border-border-subtle bg-bg-warm">
            <span className="text-[11px] font-mono text-text-dim">
              {saving ? "Saving…" : "Settings auto-save on change."}
            </span>
            {/* The full-briefing preview runs every source's fetch in
                parallel; only the admin can change source filters, so
                only the admin sees the preview button (no point
                running it for users who can't act on it). */}
            {isAdmin && (
              <button
                type="button"
                onClick={handleRunPreview}
                disabled={previewRunning}
                className="px-3 py-1.5 rounded-md bg-accent text-white border border-accent text-xs font-mono font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {previewLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </SettingsProvider>,
    document.body,
  );
}

function SettingsNav({
  groups,
  entries,
  activePanel,
  onSelect,
}: {
  groups: readonly string[];
  entries: NavEntry[];
  activePanel: PanelId;
  onSelect: (id: PanelId) => void;
}) {
  return (
    <nav className="bg-bg-warm/40 px-2 py-3 overflow-y-auto">
      {groups.map((group) => {
        const groupEntries = entries.filter((e) => e.group === group);
        if (groupEntries.length === 0) return null;
        return (
          <div key={group} className="mb-3">
            <div className="px-2 mb-1 text-[10px] font-mono uppercase tracking-wider text-text-faint">{group}</div>
            <ul className="space-y-0.5">
              {groupEntries.map((entry) => {
                const isActive = entry.id === activePanel;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(entry.id)}
                      className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-mono text-left transition-colors ${
                        isActive
                          ? "bg-bg text-text-primary border border-border-subtle shadow-sm"
                          : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                      }`}
                    >
                      <span className="text-text-dim shrink-0">{entry.icon}</span>
                      <span className="truncate">{entry.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {entries.length === 0 && <div className="px-2 text-[11px] font-mono text-text-dim italic">No matches</div>}
    </nav>
  );
}
