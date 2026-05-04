import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../../utils/api";
import { ConfirmDialog } from "../../ConfirmDialog";
import { Card, Field, PanelHeader, SourceEnabledRow, useSourceEnabled } from "../shared";

/**
 * Deployment-level feed manager (formerly per-user "ecosystem" panel).
 *
 * Three surfaces:
 *
 *   - List of currently-configured source instances, each with a toggle
 *     (enable/disable) and a remove button.
 *
 *   - Suggestions drawer — clicking "Get suggestions" calls
 *     `/api/source-instances/suggest` which returns ~8 candidate
 *     RSS feeds. Each is a one-click "Add" card.
 *
 *   - Add-by-URL form — paste a feed URL, type a label, submit.
 */

interface SourceInstance {
  id: string;
  kind: "rss" | "hn" | "arxiv";
  label: string;
  url: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  sources: SourceInstance[];
}

interface Suggestion {
  label: string;
  url: string;
  kind: "rss" | "hn";
  rationale: string;
  contentType: "blog" | "release_notes" | "podcast" | "newsletter" | "other";
}

export function FeedsPanel() {
  const rssToggle = useSourceEnabled("rss");
  const hnToggle = useSourceEnabled("hn");
  const arxivToggle = useSourceEnabled("arxiv");
  const anyKindEnabled = rssToggle.enabled || hnToggle.enabled || arxivToggle.enabled;

  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addLabel, setAddLabel] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestErr, setSuggestErr] = useState<string | null>(null);

  // Confirm-removal dialog state. We hold the source pending removal
  // so the dialog can quote its label, and a `removing` flag so the
  // dialog can show "Working…" + disable buttons while the DELETE is
  // in flight.
  const [pendingRemoval, setPendingRemoval] = useState<SourceInstance | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<ListResponse>("/api/source-instances");
      setSources(data.sources);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sources");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (s: SourceInstance) => {
    try {
      const data = await apiPatch<{ source: SourceInstance }>(`/api/source-instances/${s.id}`, { enabled: !s.enabled });
      setSources((prev) => prev.map((x) => (x.id === data.source.id ? data.source : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update source");
    }
  };

  const confirmRemoval = async () => {
    const s = pendingRemoval;
    if (!s) return;
    setRemoving(true);
    try {
      await apiDelete(`/api/source-instances/${s.id}`);
      setSources((prev) => prev.filter((x) => x.id !== s.id));
      setPendingRemoval(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove source");
      // Close the dialog on failure too — surface the error in the
      // panel-level error banner where the user is already looking.
      setPendingRemoval(null);
    } finally {
      setRemoving(false);
    }
  };

  const submitAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const label = addLabel.trim();
    const url = addUrl.trim();
    if (!label || !url) return;
    setAdding(true);
    try {
      const data = await apiPost<{ source: SourceInstance }>("/api/source-instances", {
        kind: "rss",
        label,
        url,
        config: { limit: 20, source_type: "blog" },
      });
      setSources((prev) => [data.source, ...prev]);
      setAddLabel("");
      setAddUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setAdding(false);
    }
  };

  const fetchSuggestions = async () => {
    setSuggesting(true);
    setSuggestErr(null);
    setSuggestions(null);
    try {
      const data = await apiPost<{ suggestions: Suggestion[] }>("/api/source-instances/suggest");
      setSuggestions(data.suggestions);
    } catch (err) {
      setSuggestErr(err instanceof Error ? err.message : "Failed to suggest sources");
    } finally {
      setSuggesting(false);
    }
  };

  const acceptSuggestion = async (sg: Suggestion) => {
    try {
      const data = await apiPost<{ source: SourceInstance }>("/api/source-instances", {
        kind: sg.kind,
        label: sg.label,
        url: sg.url,
        config: { limit: 20, source_type: sg.contentType === "release_notes" ? "release_notes" : "blog" },
      });
      setSources((prev) => [data.source, ...prev]);
      setSuggestions((prev) => prev?.filter((s) => s.url !== sg.url) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add suggested source");
    }
  };

  return (
    <div>
      <PanelHeader
        title="Feeds"
        description="Blogs, release notes, newsletters, and other external feeds Primer scans when generating briefings. Starts empty — paste an RSS URL below, or click ✨ Suggest sources to have Claude propose feeds tailored to your About + Focus."
      />

      <Field
        label="Include in my briefings"
        hint="Each kind is independently togglable. Off by default — turn on to start fanning these into your daily briefing."
      >
        <SourceEnabledRow
          enabled={rssToggle.enabled}
          onChange={rssToggle.setEnabled}
          label="RSS / Atom feeds"
          hint="Vendor blogs, conference proceedings, newsletters, anything with a feed URL."
        />
        <SourceEnabledRow
          enabled={hnToggle.enabled}
          onChange={hnToggle.setEnabled}
          label="Hacker News"
          hint="HN front page and topic-tagged feeds."
        />
        <SourceEnabledRow
          enabled={arxivToggle.enabled}
          onChange={arxivToggle.setEnabled}
          label="ArXiv papers"
          hint="Subject-area paper feeds — useful for ML / systems research."
        />
      </Field>

      {!anyKindEnabled ? (
        <div className="text-[11px] font-mono text-text-dim italic">
          All feed kinds are off for your briefings. Toggle one on above to manage the deployment's configured feeds.
        </div>
      ) : (
        <>
          <Field
            label="Suggest sources from your persona"
            hint="Claude reads your About + Focus and proposes well-known feeds it thinks match. One click to add."
          >
            <Card>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={fetchSuggestions}
                  disabled={suggesting}
                  className="px-3 py-1.5 rounded-md bg-accent text-white border border-accent text-xs font-mono font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {suggesting ? "Thinking…" : "✨ Suggest sources"}
                </button>
                <span className="text-[11px] font-mono text-text-dim">
                  Won't duplicate anything already configured.
                </span>
              </div>
              {suggestErr && <div className="mt-2 text-[11px] font-mono text-negative">{suggestErr}</div>}
              {suggestions && suggestions.length === 0 && !suggesting && (
                <div className="mt-2 text-[11px] font-mono text-text-dim italic">
                  No suggestions right now — try adjusting your About / Focus statement and asking again.
                </div>
              )}
              {suggestions && suggestions.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {suggestions.map((sg) => (
                    <li
                      key={sg.url}
                      className="rounded-md border border-border-subtle bg-bg p-2.5 flex items-start gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono text-text-primary truncate">{sg.label}</span>
                          <span className="text-[10px] font-mono text-text-dim uppercase tracking-wider">
                            {sg.contentType}
                          </span>
                        </div>
                        {sg.rationale && (
                          <div className="text-[11px] font-mono text-text-dim mt-0.5 leading-snug">{sg.rationale}</div>
                        )}
                        <a
                          href={sg.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] font-mono text-accent hover:underline truncate block mt-0.5"
                        >
                          {sg.url}
                        </a>
                      </div>
                      <button
                        type="button"
                        onClick={() => acceptSuggestion(sg)}
                        className="shrink-0 px-2.5 py-1 rounded-md bg-accent text-white text-[11px] font-mono font-medium hover:opacity-90 transition-opacity"
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Field>

          <Field
            label="Add a source by feed URL"
            hint="RSS 2.0 and Atom 1.0 are both supported. Most blogs publish a feed at /feed, /rss, /feed.xml, or /atom.xml."
          >
            <Card>
              <form onSubmit={submitAdd} className="space-y-2">
                <input
                  type="text"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="Display name (e.g. SRE Weekly)"
                  className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                  maxLength={120}
                  disabled={adding}
                />
                <input
                  type="url"
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="https://example.com/feed"
                  className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-faint outline-none focus:border-accent transition-colors"
                  maxLength={500}
                  disabled={adding}
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={adding || !addLabel.trim() || !addUrl.trim()}
                    className="px-3 py-1 rounded-md bg-accent text-white text-[11px] font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {adding ? "Adding…" : "Add source"}
                  </button>
                </div>
              </form>
            </Card>
          </Field>

          <Field
            label="Configured feeds"
            hint={`${sources.filter((s) => s.enabled).length} active · ${sources.filter((s) => !s.enabled).length} disabled`}
          >
            {loading && <div className="text-[11px] font-mono text-text-dim italic">Loading…</div>}
            {error && <div className="text-[11px] font-mono text-negative mb-2">{error}</div>}
            {!loading && sources.length === 0 && (
              <div className="text-[11px] font-mono text-text-dim italic">
                No sources yet. Use ✨ Suggest above or add one by URL.
              </div>
            )}
            {sources.length > 0 && (
              <ul className="space-y-1.5">
                {sources.map((s) => (
                  <li
                    key={s.id}
                    className={`rounded-md border px-3 py-2 ${
                      s.enabled ? "border-border-subtle bg-surface" : "border-border-subtle bg-bg-warm/40 opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="shrink-0 inline-flex items-center rounded-md bg-bg-warm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-dim border border-border-subtle">
                        {s.kind}
                      </span>
                      <span className="flex-1 min-w-0 text-xs font-mono text-text-primary truncate">{s.label}</span>
                      <button
                        type="button"
                        onClick={() => toggle(s)}
                        className="shrink-0 px-2 py-0.5 rounded-md border border-border text-[10px] font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                      >
                        {s.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingRemoval(s)}
                        aria-label={`Remove ${s.label}`}
                        className="shrink-0 px-2 py-0.5 rounded-md border border-border text-[10px] font-mono text-text-dim hover:text-negative hover:border-negative/30 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                    {s.url && (
                      <div className="mt-1 text-[10px] font-mono text-text-dim">
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-text-dim hover:text-accent truncate"
                        >
                          {s.url}
                        </a>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <ConfirmDialog
            open={pendingRemoval !== null}
            title={pendingRemoval ? `Remove "${pendingRemoval.label}"?` : ""}
            description="Future briefings will stop scanning this feed. You can re-add it any time from the panel above — Primer doesn't keep deleted history."
            confirmLabel="Remove"
            destructive
            busy={removing}
            onConfirm={confirmRemoval}
            onCancel={() => {
              if (!removing) setPendingRemoval(null);
            }}
          />
        </>
      )}
    </div>
  );
}
