import { useCallback, useEffect, useState } from "react";
import type { SourceDescriptor } from "../sources/types";
import { apiDelete, apiGet, apiPatch, apiPost } from "../utils/api";

/**
 * Admin sources page — manages instance-based sources (RSS feeds,
 * etc) and surfaces the connection state of singleton sources
 * (Linear, Slack, GitHub, incident.io). Lives at `/admin/sources`
 * and is gated to admin users by the route in `App.tsx`.
 *
 * Two refactors landed at once on this file:
 *
 *   1. Network calls now route through the shared `apiGet` /
 *      `apiPost` / `apiPatch` / `apiDelete` helpers. Pre-fix the
 *      page used raw `fetch("/api/...")` calls — this silently
 *      dropped the `X-Client-Timezone` header that the worker's
 *      user-context middleware reads, and skipped the helpers'
 *      uniform error handling + 503 retry behaviour.
 *
 *   2. Visual styling now uses design tokens (`bg-surface`,
 *      `text-text-dim`, `text-positive`, etc.) rather than raw
 *      Tailwind palette classes (`bg-zinc-900`, `text-emerald-400`,
 *      `bg-blue-900`). Pre-fix the page was the only one in the app
 *      bypassing the token system, which meant it stuck out
 *      visually and outright broke in light mode (zinc-900 is dark
 *      regardless of theme).
 */

interface SourceInstanceData {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SourceWithInstances extends SourceDescriptor {
  available: boolean;
  instances: SourceInstanceData[] | null;
}

function SourceCard({ source, onRefresh }: { source: SourceWithInstances; onRefresh: () => void }) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newLabel.trim()) return;
    setSaving(true);
    try {
      await apiPost("/api/source-instances", {
        kind: source.id,
        label: newLabel,
        url: newUrl || null,
      });
      setNewLabel("");
      setNewUrl("");
      setAdding(false);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await apiPatch(`/api/source-instances/${id}`, { enabled });
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    await apiDelete(`/api/source-instances/${id}`);
    onRefresh();
  };

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-warm p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-text-primary">{source.name}</h3>
          {source.available ? (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-positive-dim text-positive">
              connected
            </span>
          ) : (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface text-text-dim">
              not configured
            </span>
          )}
          {source.multiInstance && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent-dim text-accent">
              multi-instance
            </span>
          )}
        </div>
        {!source.available && source.settingsManifest && (
          <span className="text-xs text-text-dim">Requires: {source.settingsManifest.nav.keywords?.join(", ")}</span>
        )}
      </div>

      {source.multiInstance && source.instances && (
        <div className="space-y-2">
          {source.instances.length === 0 && !adding && (
            <p className="text-sm text-text-dim">No instances configured.</p>
          )}
          {source.instances.map((inst) => (
            <div key={inst.id} className="flex items-center justify-between py-1.5 px-3 rounded bg-surface text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => handleToggle(inst.id, !inst.enabled)}
                  className={`shrink-0 w-3 h-3 rounded-full border ${
                    inst.enabled ? "bg-positive border-positive" : "bg-surface-active border-border"
                  }`}
                  title={inst.enabled ? "Disable" : "Enable"}
                  aria-label={inst.enabled ? "Disable" : "Enable"}
                />
                <span className="truncate font-medium text-text-primary">{inst.label}</span>
                {inst.url && <span className="text-text-dim truncate text-xs">{inst.url}</span>}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(inst.id)}
                className="text-text-dim hover:text-negative text-xs shrink-0 ml-2"
              >
                remove
              </button>
            </div>
          ))}

          {adding ? (
            <div className="space-y-2 p-3 rounded bg-surface border border-border-subtle">
              <input
                type="text"
                placeholder="Label (e.g. CNCF Blog)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="w-full rounded bg-bg border border-border-subtle px-2 py-1.5 text-sm text-text-primary"
              />
              <input
                type="url"
                placeholder="URL (e.g. https://example.com/feed.xml)"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="w-full rounded bg-bg border border-border-subtle px-2 py-1.5 text-sm text-text-primary"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={saving || !newLabel.trim()}
                  className="px-3 py-1 rounded bg-accent text-bg text-xs font-medium hover:bg-accent/85 disabled:opacity-50"
                >
                  {saving ? "Adding…" : "Add"}
                </button>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="px-3 py-1 rounded bg-surface text-text-dim text-xs hover:text-text-primary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="text-xs text-accent hover:text-accent/85">
              + Add {source.name.toLowerCase()} instance
            </button>
          )}
        </div>
      )}

      {!source.multiInstance && source.available && (
        <p className="text-sm text-text-dim">
          Connected via environment variable. Configure user-level filters in Settings.
        </p>
      )}

      {!source.multiInstance && !source.available && (
        <p className="text-sm text-text-dim">
          Set the required environment variable{source.settingsManifest ? "" : "s"} to enable this source.
        </p>
      )}
    </div>
  );
}

export function AdminSourcesPage() {
  const [sources, setSources] = useState<SourceWithInstances[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ sources: SourceWithInstances[] }>("/api/sources");
      setSources(data.sources);
    } catch {
      // Non-fatal — leave the existing list intact rather than
      // wiping the screen on a transient network error.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <p className="text-text-dim">Loading sources…</p>
      </div>
    );
  }

  const singletons = sources.filter((s) => !s.multiInstance);
  const multiInstance = sources.filter((s) => s.multiInstance);

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Sources</h1>
        <p className="text-sm text-text-dim mt-1">
          Manage the data sources that feed into Primer briefings. Sources are shared across all users.
        </p>
      </div>

      {singletons.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-dim uppercase tracking-wide">Integrations</h2>
          {singletons.map((s) => (
            <SourceCard key={s.id} source={s} onRefresh={load} />
          ))}
        </section>
      )}

      {multiInstance.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-dim uppercase tracking-wide">Feeds</h2>
          {multiInstance.map((s) => (
            <SourceCard key={s.id} source={s} onRefresh={load} />
          ))}
        </section>
      )}
    </div>
  );
}
