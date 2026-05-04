import type { ReactNode } from "react";
import type { PreviewSourceState } from "../../hooks/useSettings";
import { useSettingsCtx } from "./SettingsContext";

/**
 * Shared building blocks for the settings panels.
 *
 * Why this lives here: the new sidenav-driven layout splits each
 * settings section into its own panel component (so the file doesn't
 * keep growing past 1700 lines). Every panel needs the same primitives
 * — a labelled section header, a tinted card, a toggle row, a select
 * summary, the status dots — so we centralise them once.
 */

export function PanelHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-0.5 text-xs font-mono text-text-dim leading-relaxed">{description}</p>
    </div>
  );
}

/**
 * Inline enable/disable switch for a single source kind. Drops into
 * the top of any per-source panel, binding directly to the user's
 * `enabledSourceIds` array via `useSettingsCtx`. Returns whether the
 * source is currently enabled so the caller can decide what to render
 * underneath — by convention, panels hide their per-source filters
 * (channels, repos, statuses) when the toggle is off, since those
 * settings are irrelevant if the source isn't fanning into briefings.
 */
export function useSourceEnabled(sourceId: string): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings } = settings;
  const enabled = (data?.enabledSourceIds ?? []).includes(sourceId);
  const setEnabled = (next: boolean) => {
    const current = new Set(data?.enabledSourceIds ?? []);
    if (next) current.add(sourceId);
    else current.delete(sourceId);
    updateSettings({ enabledSourceIds: Array.from(current) });
  };
  return { enabled, setEnabled };
}

export function SourceEnabledRow({
  enabled,
  onChange,
  label = "Include in my briefings",
  hint,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-4 rounded-lg border border-border-subtle bg-bg-warm p-3">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border accent-accent shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-text-primary">{label}</div>
          {hint && <div className="mt-0.5 text-[11px] font-mono text-text-dim leading-relaxed">{hint}</div>}
        </div>
      </label>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold text-text-primary mb-1">{label}</div>
      {hint && <div className="text-[10px] font-mono text-text-dim mb-2 leading-relaxed">{hint}</div>}
      {children}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-bg-warm border border-border-subtle p-4">{children}</div>;
}

export function ToggleRow({
  label,
  checked,
  onChange,
  last = false,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
}) {
  return (
    <label className={`flex items-center gap-3 py-2.5 cursor-pointer ${last ? "" : "border-b border-border-subtle"}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border accent-accent shrink-0"
      />
      <span className="text-xs font-mono text-text-primary">{label}</span>
    </label>
  );
}

export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border-subtle last:border-0">
      <span className="text-xs font-mono text-text-dim">{label}</span>
      <span className="text-xs font-mono text-text-primary">{value}</span>
    </div>
  );
}

export function SelectedSummary({
  items,
  onEdit,
  emptyLabel,
}: {
  items: string[];
  onEdit: () => void;
  emptyLabel: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex-1 flex flex-wrap gap-1.5 min-h-[28px]">
        {items.length === 0 ? (
          <span className="text-xs font-mono text-text-faint italic">{emptyLabel}</span>
        ) : (
          items.map((item) => (
            <span
              key={item}
              className="inline-flex items-center rounded-md bg-accent-dim border border-accent/20 px-2 py-1 text-xs font-mono text-accent leading-none"
            >
              {item}
            </span>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 px-2.5 py-1 rounded-md border border-border text-xs font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
      >
        Edit
      </button>
    </div>
  );
}

export function SourceStatusDot({ status }: { status: PreviewSourceState<unknown>["status"] }) {
  if (status === "loading") {
    return (
      <span className="relative inline-flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
    );
  }
  if (status === "ready") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-positive" />;
  }
  if (status === "error") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-negative" />;
  }
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-border" />;
}

/**
 * "In scope" subpanel header, used by every source panel that wants
 * to render a preview slice. The status text on the right ("Updated
 * just now" / "Run preview to see") matches the mockup language.
 */
export function ScopeHeader({ title, count, status }: { title: string; count: string; status: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-semibold text-text-primary">{title}</span>
        <span className="text-xs font-mono text-text-dim">· {count}</span>
      </div>
      <span className="text-[10px] font-mono text-text-dim">{status}</span>
    </div>
  );
}

export function getInitials(email: string, displayName: string | null): string {
  if (displayName) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0][0].toUpperCase();
  }
  return email[0].toUpperCase();
}

export function formatElapsed(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Generic `<select>` whose options are grouped by `provider` via
 * `<optgroup>` headers — the same pattern the Voice picker has used
 * since multi-provider TTS landed, now shared with the AI Models
 * picker so they read identically.
 *
 * The component is provider-agnostic: callers pass the order they
 * want providers to appear in (`providerOrder`), the labels for
 * each group header (`providerLabels`), and an optional
 * `renderLabel(m)` to customise the option text. Empty groups are
 * rendered as nothing — so a provider with no models (because its
 * env key isn't set) silently disappears from the picker rather
 * than rendering an empty header.
 *
 * Why a shared component: the alternative is the same 20-line
 * group-by-provider transform copy-pasted into every panel that
 * picks a model. That's how the Voice picker started; the
 * duplication grows linearly with each new model-picking surface
 * (a hypothetical embeddings picker would want it too). One
 * component, one place to fix bugs.
 */
export interface GroupedSelectModel {
  id: string;
  label: string;
  provider?: string;
  tier?: string;
}

export function ProviderGroupedSelect<T extends GroupedSelectModel>({
  models,
  value,
  onChange,
  providerOrder,
  providerLabels,
  renderLabel,
  className,
  loadingLabel = "Loading…",
}: {
  models: T[];
  value: string;
  onChange: (id: string) => void;
  providerOrder: readonly string[];
  providerLabels: Record<string, string>;
  /** Custom label renderer for each option. Defaults to
   *  `${m.label} (${m.tier})` when `tier` is set, else just
   *  `m.label`. */
  renderLabel?: (m: T) => string;
  className?: string;
  /** Text to show in a single disabled option while `models` is
   *  empty (initial /api/models fetch in flight). */
  loadingLabel?: string;
}) {
  const fallbackLabel = (m: T) => (m.tier ? `${m.label} (${m.tier})` : m.label);
  const labelOf = renderLabel ?? fallbackLabel;
  const cls =
    className ??
    "w-full bg-surface border border-border rounded-md px-3 py-1.5 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors";

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cls}>
      {models.length === 0 ? (
        <option value="">{loadingLabel}</option>
      ) : (
        providerOrder.map((provider) => {
          const group = models.filter((m) => m.provider === provider);
          if (group.length === 0) return null;
          return (
            <optgroup key={provider} label={providerLabels[provider] ?? provider}>
              {group.map((m) => (
                <option key={m.id} value={m.id}>
                  {labelOf(m)}
                </option>
              ))}
            </optgroup>
          );
        })
      )}
    </select>
  );
}

// ── Source nav icons ──
//
// Each source-provider icon is a small monochrome line-art glyph that
// evokes the brand's visual identity without being a literal logo
// reproduction. The previous Linear / Slack icons were generic
// shapes; the refreshed ones below pick up the recognizable motifs:
//   - Linear: stacked progressive-length bars (its app-icon gradient)
//   - Slack:  four-arm rounded pinwheel (its hash pinwheel mark)
//   - Feeds:  the universal RSS arc-and-dot
//
// Style stays consistent with the rest of the settings sidenav:
// 13×13 in a 16-unit viewBox, single-color stroke, 1.5 stroke width.

export const IconLinear = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
  >
    <line x1="3" y1="4" x2="13" y2="4" />
    <line x1="3" y1="8" x2="11" y2="8" />
    <line x1="3" y1="12" x2="8" y2="12" />
  </svg>
);

export const IconSlack = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Pinwheel of four offset rounded bars — the recognizable
        Slack hash arrangement in monochrome line-art. */}
    <rect x="9" y="2" width="2" height="6" rx="1" />
    <rect x="8" y="9" width="6" height="2" rx="1" />
    <rect x="5" y="8" width="2" height="6" rx="1" />
    <rect x="2" y="5" width="6" height="2" rx="1" />
  </svg>
);

export const IconGitHub = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export const IconIncidents = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8 2l6 11H2L8 2z" />
    <path d="M8 6v3" />
    <circle cx="8" cy="11" r="0.5" fill="currentColor" />
  </svg>
);

export const IconFeeds = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* The universal RSS / feed mark: dot in the corner with two
        concentric arcs radiating outward. Strong "external feed"
        signal — used by every news reader and feed aggregator. */}
    <circle cx="3.5" cy="12.5" r="1.2" fill="currentColor" stroke="none" />
    <path d="M3 8a5 5 0 015 5" />
    <path d="M3 3a10 10 0 0110 10" />
  </svg>
);

export const IconModels = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Sparkles — the universal modern signifier for AI / generative
        intelligence. A primary 4-point sparkle plus a smaller
        companion reads as "AI features" rather than "favorites"
        (which the previous star glyph implied). */}
    <path d="M7 2.5 L8.4 6.4 L12.3 7.8 L8.4 9.2 L7 13.1 L5.6 9.2 L1.7 7.8 L5.6 6.4 Z" />
    <path d="M12.5 1.5 L13 3 L14.5 3.5 L13 4 L12.5 5.5 L12 4 L10.5 3.5 L12 3 Z" />
  </svg>
);

export const IconVoice = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="6" y="2" width="4" height="9" rx="2" />
    <path d="M3 8a5 5 0 0010 0M8 13v2M5.5 15h5" />
  </svg>
);

export const IconFocus = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="3" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconAbout = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="6" r="3" />
    <path d="M2 14c0-3 3-5 6-5s6 2 6 5" strokeLinecap="round" />
  </svg>
);

export const IconLimits = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="3" />
    <path
      d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
      strokeLinecap="round"
    />
  </svg>
);

export const IconAccount = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="6" r="3" />
    <path d="M2 14c0-3 3-5 6-5s6 2 6 5" strokeLinecap="round" />
  </svg>
);

// Two overlapping silhouettes — distinguishes the admin Users panel
// from the per-user Account panel (single silhouette) at a glance.
export const IconUsers = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="6" cy="6" r="2.5" />
    <path d="M1 14c0-2.5 2.2-4 5-4s5 1.5 5 4" strokeLinecap="round" />
    <circle cx="11.5" cy="5" r="2" />
    <path d="M9 9.5c2.4-0.3 5 1.2 5 4" strokeLinecap="round" />
  </svg>
);

export const IconConcepts = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="4" cy="4" r="2" />
    <circle cx="12" cy="4" r="2" />
    <circle cx="8" cy="12" r="2" />
    <path d="M4 6l4 4M12 6l-4 4" strokeLinecap="round" />
  </svg>
);
