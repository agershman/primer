import { useEffect, useState } from "react";
import type { SourceDescriptor } from "../../../sources/types";
import { apiGet } from "../../../utils/api";
import { useSettingsCtx } from "../SettingsContext";
import { Card, PanelHeader } from "../shared";

/**
 * Per-user source overview. Each row is one source (Linear, Slack,
 * GitHub, incident.io, RSS, HN, ArXiv) with a single toggle that
 * controls whether THAT user's briefing fans out to it. Distinct
 * from the per-source detail panels (LinearPanel, SlackPanel, etc.)
 * which configure deployment-wide filters / channels — those are
 * admin-only; this overview is user-level.
 *
 * Sources land here as soon as `/api/sources` reports them.
 * Unavailable sources (missing required env) render disabled with a
 * "needs configuration" hint so the user understands why they can't
 * flip them on.
 */
export function SourcesOverviewPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings } = settings;
  const [sources, setSources] = useState<Array<SourceDescriptor & { available: boolean }>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiGet<{ sources: Array<SourceDescriptor & { available: boolean }> }>("/api/sources")
      .then((resp) => {
        setSources(resp.sources);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const enabled = new Set(data?.enabledSourceIds ?? []);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(id);
    else next.delete(id);
    updateSettings({ enabledSourceIds: Array.from(next) });
  };

  return (
    <div>
      <PanelHeader
        title="Sources"
        description="Pick which sources fan into your daily briefing. Toggle the ones that match your role and interests — anything you turn off is skipped entirely for your briefings."
      />

      {!loaded && (
        <Card>
          <div className="text-xs font-mono text-text-dim">Loading sources…</div>
        </Card>
      )}

      {loaded && sources.length === 0 && (
        <Card>
          <div className="text-xs font-mono text-text-dim">No sources are registered on this deployment.</div>
        </Card>
      )}

      {loaded && sources.length > 0 && (
        <Card>
          <div className="divide-y divide-border-subtle">
            {sources.map((s) => {
              const isOn = enabled.has(s.id);
              const disabled = !s.available;
              return (
                <div key={s.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <input
                    type="checkbox"
                    checked={isOn}
                    disabled={disabled}
                    onChange={(e) => toggle(s.id, e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-border accent-accent shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label={`Enable ${s.name}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-text-primary">{s.name}</span>
                      {disabled && (
                        <span className="text-[10px] font-mono text-text-faint italic">(needs configuration)</span>
                      )}
                    </div>
                    {s.description && (
                      <div className="mt-0.5 text-[11px] font-mono text-text-dim leading-relaxed">{s.description}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
