import { type ReactNode, useState } from "react";
import type { PreviewSourceState } from "../../../hooks/useSettings";
import { ScopeHeader } from "../shared";

/**
 * Reusable "In scope" subpanel for source panels. Mirrors the mockup
 * — a count + status header, the rendered scope list, and (optional)
 * a collapsible "near misses" section explaining items that almost
 * matched the user's filters.
 *
 * Generic over the source's `data` payload so each source renders its
 * own row format (Linear issues, Slack channels, GitHub PRs, etc.)
 * without us inventing an intermediate row schema.
 */
export interface InScopePreviewProps<T> {
  source: PreviewSourceState<T>;
  /** Headline count for the header, e.g. "3 issues" or "2 channels". */
  count: string;
  /** Renders the list of in-scope items. Called only when status is "ready". */
  renderList: (data: T) => ReactNode;
  /** Optional near-misses block. Rendered as a collapsible details block.
   *  Returning `null` skips the section entirely. */
  renderNear?: (data: T) => { title: string; subtitle?: string; node: ReactNode } | null;
  /** Shown when the source is idle (preview never run). */
  idleHint?: ReactNode;
}

export function InScopePreview<T>({ source, count, renderList, renderNear, idleHint }: InScopePreviewProps<T>) {
  const [nearOpen, setNearOpen] = useState(false);

  const status =
    source.status === "loading" ? (
      <span className="text-accent">Fetching…</span>
    ) : source.status === "ready" ? (
      <span>Updated just now</span>
    ) : source.status === "error" ? (
      <span className="text-negative">Failed</span>
    ) : (
      <span>Run preview to see</span>
    );

  return (
    <div className="mt-6 pt-5 border-t border-border-subtle">
      <ScopeHeader title="In scope" count={count} status={status} />

      {source.status === "idle" && (
        <div className="text-xs font-mono text-text-dim italic">
          {idleHint ?? "Click Build full briefing preview at the bottom to see what's in scope here."}
        </div>
      )}

      {source.status === "loading" && <div className="text-xs font-mono text-text-dim italic">Loading…</div>}

      {source.status === "error" && (
        <div className="text-xs font-mono text-negative">{source.error ?? "Failed to load"}</div>
      )}

      {source.status === "ready" && source.data && (
        <>
          <div className="space-y-2">{renderList(source.data)}</div>
          {renderNear &&
            (() => {
              const near = renderNear(source.data);
              if (!near) return null;
              return (
                <div className="mt-4 rounded-md border border-dashed border-border bg-bg-warm/40">
                  <button
                    type="button"
                    onClick={() => setNearOpen((v) => !v)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors rounded-md"
                  >
                    <span className="font-semibold">{near.title}</span>
                    <span className="text-text-dim">
                      {near.subtitle ?? ""} {nearOpen ? "▴" : "▾"}
                    </span>
                  </button>
                  {nearOpen && <div className="px-3 pb-3 pt-1 space-y-1.5">{near.node}</div>}
                </div>
              );
            })()}
        </>
      )}
    </div>
  );
}

/**
 * Shared row primitive for "in scope" entries — a monospace ref pill
 * (e.g. "PLAT-4171" or "#eng-platform"), the title, and a meta row
 * underneath with match-reason chips.
 *
 * Keeping the visual identical across sources makes the panel feel
 * cohesive even though the underlying data shapes differ.
 */
export function ScopeRow({ ref, title, meta }: { ref: ReactNode; title: ReactNode; meta: ReactNode }) {
  return (
    <div className="rounded-md border border-border-subtle bg-surface px-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="shrink-0 inline-flex items-center rounded-md bg-accent-dim px-2 py-0.5 font-mono text-[11px] text-accent">
          {ref}
        </span>
        <span className="flex-1 truncate text-xs text-text-primary">{title}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-text-dim">{meta}</div>
    </div>
  );
}

export function MatchReason({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-text-secondary">
      <span className="text-positive font-bold text-[10px]">✓</span>
      {children}
    </span>
  );
}

export function MetaSep() {
  return <span className="text-border">·</span>;
}
