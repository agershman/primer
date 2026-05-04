import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPost } from "../../../utils/api";

interface StatementVersion {
  id: string;
  statement: string;
  note: string | null;
  createdAt: string;
  isCurrent: boolean;
}

/**
 * Generic analytics payload — Focus carries the full set (suppression,
 * category distribution); About carries a smaller subset. Optional
 * fields are rendered conditionally so the same modal handles both.
 */
interface VersionAnalytics {
  versionId: string;
  conceptsCreated: number;
  conceptsSuppressed?: number;
  suppressionRate?: number;
  briefingsGenerated: number;
  teachingPiecesGenerated: number;
  categoryDistribution?: Record<string, number>;
  positiveFeedbackRate: number | null;
}

export type StatementKind = "focus" | "about";

const KIND_COPY: Record<
  StatementKind,
  { title: string; emptyText: string; highSuppressionWarning?: string; deleteWarning: string }
> = {
  focus: {
    title: "Focus statement history",
    emptyText: "No focus history yet. Save your first focus statement to start the timeline.",
    highSuppressionWarning:
      "High suppression rate suggests this focus statement isn't filtering well — consider refining it.",
    deleteWarning: "Delete this version from history? Concepts attributed to it will become untagged.",
  },
  about: {
    title: "About / persona history",
    emptyText: "No About history yet. Save your first About statement to start the timeline.",
    deleteWarning: "Delete this version from history?",
  },
};

export function StatementHistoryModal({
  kind,
  currentVersionId,
  onClose,
  onChanged,
}: {
  kind: StatementKind;
  currentVersionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [versions, setVersions] = useState<StatementVersion[]>([]);
  const [analytics, setAnalytics] = useState<Record<string, VersionAnalytics>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const copy = KIND_COPY[kind];

  // The currentVersionId prop is accepted for symmetry with how the
  // settings panel passes user state; the modal itself relies on the
  // server's `isCurrent` flag in the response, so this prop is just a
  // hint that lets callers force a re-render when the active version
  // flips elsewhere.
  void currentVersionId;

  const load = async () => {
    setLoading(true);
    try {
      // All four endpoints (list / per-version analytics /
      // restore / delete) now route through the shared `api`
      // helpers so they pick up the standard X-Client-Timezone
      // header and 503 retry semantics. Pre-fix this used raw
      // `fetch` with `credentials: "include"` — the helpers
      // already include credentials by default for same-origin
      // requests, so the explicit option is no longer needed.
      const data = await apiGet<{ versions: StatementVersion[] }>(`/api/me/${kind}/history`);
      setVersions(data.versions);
      const entries = await Promise.all(
        data.versions.map(async (v) => {
          try {
            const analytics = await apiGet<VersionAnalytics>(`/api/me/${kind}/${v.id}/analytics`);
            return [v.id, analytics] as const;
          } catch {
            return null;
          }
        }),
      );
      setAnalytics(Object.fromEntries(entries.filter((x): x is readonly [string, VersionAnalytics] => x !== null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl rounded-xl bg-bg border border-border shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-text-primary">{copy.title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-dim hover:text-text-secondary p-1.5 rounded-md hover:bg-surface-hover transition-colors"
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

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
          {loading && <div className="text-xs font-mono text-text-dim">Loading…</div>}
          {error && <div className="text-xs font-mono text-negative">{error}</div>}
          {!loading && versions.length === 0 && !error && (
            <div className="text-xs font-mono text-text-dim italic">{copy.emptyText}</div>
          )}
          {versions.map((v, idx) => {
            const prev = versions[idx + 1];
            const a = analytics[v.id];
            return (
              <div key={v.id} className="rounded-lg border border-border-subtle bg-bg-warm p-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold ${v.isCurrent ? "bg-accent-dim text-accent" : "bg-surface-hover text-text-dim"}`}
                    >
                      {v.isCurrent ? "current" : `v${versions.length - idx}`}
                    </span>
                    <span className="font-mono text-[10px] text-text-faint">{formatRelativeOrDate(v.createdAt)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {!v.isCurrent && (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await apiPost(`/api/me/${kind}/${v.id}/restore`);
                              onChanged();
                              await load();
                            } catch (err) {
                              alert(`Restore failed: ${err instanceof Error ? err.message : "unknown"}`);
                            }
                          }}
                          className="font-mono text-[10px] text-accent hover:underline"
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!confirm(copy.deleteWarning)) return;
                            try {
                              await apiDelete(`/api/me/${kind}/${v.id}`);
                              await load();
                            } catch (err) {
                              alert(`Delete failed: ${err instanceof Error ? err.message : "unknown"}`);
                            }
                          }}
                          className="font-mono text-[10px] text-negative hover:underline"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {v.note && <div className="font-mono text-[10px] text-text-dim italic mb-2">note: {v.note}</div>}
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-primary leading-relaxed mb-2">
                  {v.statement}
                </pre>
                {prev && (
                  <details className="mb-2">
                    <summary className="font-mono text-[10px] text-text-dim hover:text-accent cursor-pointer select-none">
                      Diff vs previous version
                    </summary>
                    <FocusDiff before={prev.statement} after={v.statement} />
                  </details>
                )}
                {a && (
                  <div className="mt-2 pt-2 border-t border-border-subtle grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-mono">
                    <Stat label="concepts" value={a.conceptsCreated} />
                    <Stat label="briefings" value={a.briefingsGenerated} />
                    <Stat label="pieces" value={a.teachingPiecesGenerated} />
                    {a.suppressionRate !== undefined ? (
                      <Stat
                        label="suppressed"
                        value={`${(a.suppressionRate * 100).toFixed(0)}%`}
                        flag={a.conceptsCreated >= 5 && a.suppressionRate > 0.25}
                      />
                    ) : a.positiveFeedbackRate !== null && a.positiveFeedbackRate !== undefined ? (
                      <Stat label="feedback +" value={`${(a.positiveFeedbackRate * 100).toFixed(0)}%`} />
                    ) : (
                      <span />
                    )}
                  </div>
                )}
                {a?.categoryDistribution && Object.keys(a.categoryDistribution).length > 0 && (
                  <div className="mt-2">
                    <CategoryBar dist={a.categoryDistribution} />
                  </div>
                )}
                {a?.suppressionRate !== undefined &&
                  a.conceptsCreated >= 5 &&
                  a.suppressionRate > 0.25 &&
                  copy.highSuppressionWarning && (
                    <div className="mt-2 text-[10px] font-mono text-warning">
                      {copy.highSuppressionWarning} ({(a.suppressionRate * 100).toFixed(0)}%)
                    </div>
                  )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Stat({ label, value, flag = false }: { label: string; value: string | number; flag?: boolean }) {
  return (
    <div className={`flex items-baseline gap-1 ${flag ? "text-warning" : "text-text-secondary"}`}>
      <span className={`tabular-nums font-semibold ${flag ? "text-warning" : "text-text-primary"}`}>{value}</span>
      <span className="text-text-dim">{label}</span>
    </div>
  );
}

function CategoryBar({ dist }: { dist: Record<string, number> }) {
  const entries = Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;
  return (
    <div className="space-y-0.5">
      {entries.map(([cat, n]) => {
        const pct = (n / total) * 100;
        return (
          <div key={cat} className="flex items-center gap-2">
            <div className="w-24 truncate text-[10px] font-mono text-text-dim">{cat}</div>
            <div className="flex-1 h-1.5 rounded-full bg-surface-active overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <div className="w-10 text-right tabular-nums text-[10px] font-mono text-text-faint">{pct.toFixed(0)}%</div>
          </div>
        );
      })}
    </div>
  );
}

function FocusDiff({ before, after }: { before: string; after: string }) {
  const beforeLines = before.split(/\n/);
  const afterLines = after.split(/\n/);
  // Simple line-level diff: any line not present in `before` is added; any line
  // not present in `after` is removed. Deliberately naive — focus statements
  // are short paragraphs, not source code.
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const removed = beforeLines.filter((l) => !afterSet.has(l));
  const added = afterLines.filter((l) => !beforeSet.has(l));
  return (
    <div className="mt-1 rounded-md border border-border-subtle bg-surface px-2 py-1 font-mono text-[11px] leading-relaxed">
      {removed.map((l, i) => (
        <div key={`r${i}`} className="text-negative">
          - {l}
        </div>
      ))}
      {added.map((l, i) => (
        <div key={`a${i}`} className="text-positive">
          + {l}
        </div>
      ))}
      {removed.length === 0 && added.length === 0 && <div className="text-text-dim italic">no textual change</div>}
    </div>
  );
}

function formatRelativeOrDate(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    const now = Date.now();
    const ms = now - d.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
