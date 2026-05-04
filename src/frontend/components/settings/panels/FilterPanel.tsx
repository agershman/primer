import { useCallback, useEffect, useState } from "react";
import type { SourceDescriptor } from "../../../sources/types";
import { apiGet } from "../../../utils/api";
import { DictationButton } from "../../DictationButton";
import { useSettingsCtx } from "../SettingsContext";

/**
 * Self-contained textarea + dictation widget. Each instance owns its
 * own listening state so multiple filters on the same panel
 * (global + per-source) can dictate independently without interfering
 * with each other.
 *
 * Mirrors the StatementPanel / FocusEditor / quiz-answer dictation
 * pattern so the UX feels uniform across the app.
 */
function DictatableTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 4,
  size = "default",
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  /** "default" → larger global filter; "compact" → tighter per-source overrides. */
  size?: "default" | "compact";
}) {
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);

  const padding = size === "compact" ? "px-2.5 py-1.5 pr-9" : "px-3 py-2 pr-10";
  const textSize = size === "compact" ? "text-sm" : "text-sm";

  return (
    <div className="relative">
      <textarea
        value={dictating && interim ? `${value}${value ? " " : ""}${interim}` : value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={dictating ? "Listening — speak freely…" : placeholder}
        readOnly={dictating}
        rows={rows}
        className={`w-full rounded-md ${padding} ${textSize} font-ui text-text-primary placeholder:text-text-faint outline-none transition-colors resize-y ${
          dictating
            ? "bg-surface border border-accent ring-2 ring-accent/20 cursor-default"
            : "bg-surface border border-border focus:border-accent"
        }`}
        data-allow-typing=""
      />
      <div className={size === "compact" ? "absolute right-1.5 top-1.5" : "absolute right-2 top-2"}>
        <DictationButton
          onTranscript={(text) => onChange(value ? `${value} ${text}` : text)}
          onInterim={setInterim}
          onListeningChange={setDictating}
          continuous
          className={size === "compact" ? "h-7 w-7" : "h-8 w-8"}
        />
      </div>
      {dictating && (
        <p className="mt-1 font-ui text-[11px] text-accent">● Listening — pause for 5 s or tap the mic to stop.</p>
      )}
    </div>
  );
}

/**
 * Override row — what we actually render in the per-source list. We
 * flatten the API's tree (`provider → [instance]`) into a flat list
 * because users configure overrides per *configured source*, not per
 * provider category. So the list reads as the actual things they
 * have set up: "Linear", "Slack", "CNCF Blog", "Cloudflare Blog",
 * "Hacker News — Best", etc.
 *
 * `key` is what's persisted into `sourceFilterOverrides` — the
 * provider id for singletons, the instance id for instances. That
 * way a saved override survives the user adding/removing other
 * instances of the same provider kind.
 */
interface OverrideRow {
  key: string;
  label: string;
  /** Optional hint surfaced under the label (e.g. an RSS URL for
   *  feed instances). Helps the user disambiguate when two instances
   *  share a similar label. */
  hint?: string;
  /** Provider id (for singletons) or `${kind}:${instanceId}` so the
   *  user can see grouping in the rendered list. Drives the colored
   *  left-border accent style. */
  groupId: string;
}

export function FilterPanel() {
  const { settings: settingsHook } = useSettingsCtx();
  const { settings: data, updateSettings } = settingsHook;

  const [overrideRows, setOverrideRows] = useState<OverrideRow[]>([]);
  const [showOverrides, setShowOverrides] = useState(false);
  const [globalDraft, setGlobalDraft] = useState(data?.filterPrompt ?? "");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>(
    (data?.sourceFilterOverrides as Record<string, string>) ?? {},
  );

  useEffect(() => {
    // Routed through `apiGet` so the call carries the standard
    // X-Client-Timezone header. Was raw fetch pre-fix.
    apiGet<{ sources: (SourceDescriptor & { available: boolean })[] }>("/api/sources")
      .then((d) => {
        const rows: OverrideRow[] = [];
        for (const s of d.sources) {
          // Skip providers that aren't configured for this deploy
          // (e.g. GitHub when GITHUB_TOKEN isn't set).
          if (!s.available) continue;

          if (s.multiInstance) {
            // Expand into one row per *enabled* configured instance.
            // Disabled instances don't generate items either, so an
            // override there has no effect today — easier to just
            // hide them than to render visual noise.
            const instances = (s.instances ?? []).filter((inst) => inst.enabled);
            for (const inst of instances) {
              rows.push({
                key: inst.id,
                label: inst.label,
                hint: inst.url ?? undefined,
                groupId: s.id,
              });
            }
          } else {
            rows.push({
              key: s.id,
              label: s.name,
              groupId: s.id,
            });
          }
        }
        setOverrideRows(rows);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setGlobalDraft(data?.filterPrompt ?? "");
    setOverrideDrafts((data?.sourceFilterOverrides as Record<string, string>) ?? {});
  }, [data?.filterPrompt, data?.sourceFilterOverrides]);

  const saveGlobal = useCallback(() => {
    const trimmed = globalDraft.trim();
    updateSettings({ filterPrompt: trimmed || null });
  }, [globalDraft, updateSettings]);

  const saveOverride = useCallback(
    (key: string) => {
      const trimmed = overrideDrafts[key]?.trim() ?? "";
      const current = (data?.sourceFilterOverrides as Record<string, string>) ?? {};
      const next = { ...current };
      if (trimmed) {
        next[key] = trimmed;
      } else {
        delete next[key];
      }
      updateSettings({ sourceFilterOverrides: next });
    },
    [overrideDrafts, data?.sourceFilterOverrides, updateSettings],
  );

  const hasOverrides = Object.values(overrideDrafts).some((v) => v?.trim());

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-text-primary">Relevance filter</h3>
        <p className="text-sm text-text-dim mt-1">
          Describe what's relevant to you. This shapes which items from all sources make it into your briefings. Your
          About and Focus statements are already used — this adds specificity.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-text-primary mb-1.5">Global filter</label>
        <DictatableTextarea
          value={globalDraft}
          onChange={setGlobalDraft}
          onBlur={saveGlobal}
          placeholder="e.g. I care about infrastructure reliability, Kubernetes, and cost optimization. Skip frontend UI work unless it touches the design system API."
          rows={4}
        />
        <p className="text-xs text-text-faint mt-1">
          Applies to all sources. Add per-source overrides below for more specific criteria.
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowOverrides(!showOverrides)}
          className="text-sm text-accent hover:text-accent/80 flex items-center gap-1"
        >
          <span className={`inline-block transition-transform ${showOverrides ? "rotate-90" : ""}`}>▸</span>
          Per-source overrides
          {hasOverrides && (
            <span className="text-[10px] bg-accent-dim text-accent px-1.5 py-0.5 rounded-full ml-1">
              {Object.values(overrideDrafts).filter((v) => v?.trim()).length} active
            </span>
          )}
        </button>

        {showOverrides && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-text-dim">
              When set, a per-source filter replaces the global filter for that source. Leave empty to use the global
              filter.
            </p>
            {overrideRows.length === 0 ? (
              <p className="text-xs text-text-faint italic">
                No configured sources yet. Add feeds in Settings → Sources to see them here.
              </p>
            ) : (
              overrideRows.map((row) => (
                <div key={row.key} className="pl-3 border-l-2 border-border-subtle">
                  <label className="block text-sm font-medium text-text-primary mb-0.5">{row.label}</label>
                  {row.hint && <p className="text-[10px] font-mono text-text-faint mb-1 truncate">{row.hint}</p>}
                  <DictatableTextarea
                    value={overrideDrafts[row.key] ?? ""}
                    onChange={(next) => setOverrideDrafts((prev) => ({ ...prev, [row.key]: next }))}
                    onBlur={() => saveOverride(row.key)}
                    placeholder={`Filter criteria specific to ${row.label}…`}
                    rows={2}
                    size="compact"
                  />
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
