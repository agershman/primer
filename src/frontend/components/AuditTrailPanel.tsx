/**
 * Modal panel that shows the full per-claim audit trail (both
 * passes, every classified span) for a piece, deep dive, or quiz.
 *
 * Opened from the `AuditIndicator` pill's "View full audit trail"
 * dropdown entry. Lazy-fetches via `apiGet` on mount; the popover
 * (`AuditPopover`) reuses the same trail when it's already loaded
 * on the page so we don't hit the endpoint twice.
 *
 * Layout: pass 1 first, then pass 2 (when present), claims grouped
 * by block_index. Each row shows verdict pill, the auditor's
 * reasoning, cited refs / web evidence, and the patch diff.
 *
 * Design tokens only.
 */

import { useEffect, useState } from "react";
import type { AuditClaim, AuditTrail, SourceDescriptor } from "../types";
import { apiGet } from "../utils/api";

interface AuditTrailPanelProps {
  open: boolean;
  onClose: () => void;
  targetKind: "piece" | "deep_dive" | "quiz";
  targetId: string;
  /** When the parent already fetched the trail (popover path), pass
   *  it here to skip the round trip. */
  preloadedTrail?: AuditTrail | null;
  sources?: SourceDescriptor[];
  /** Optional callback so the parent can cache the fetched trail
   *  (and hand it to the popover next time). */
  onTrailLoaded?: (trail: AuditTrail) => void;
}

const VERDICT_LABEL: Record<AuditClaim["verdict"], string> = {
  grounded: "Source-grounded",
  "grounded-web": "Web-verified",
  unsupported: "Unsupported",
  hallucinated: "Hallucinated",
};

const VERDICT_PILL: Record<AuditClaim["verdict"], string> = {
  grounded: "bg-positive-dim text-positive",
  "grounded-web": "bg-accent-dim text-accent",
  unsupported: "bg-warning-dim text-warning",
  hallucinated: "bg-negative-dim text-negative",
};

function endpointFor(targetKind: AuditTrailPanelProps["targetKind"], targetId: string): string {
  if (targetKind === "deep_dive") return `/api/piece/${targetId}/deep-dive/audit`;
  if (targetKind === "quiz") return `/api/quiz/${targetId}/audit`;
  return `/api/piece/${targetId}/audit`;
}

export function AuditTrailPanel({
  open,
  onClose,
  targetKind,
  targetId,
  preloadedTrail,
  sources,
  onTrailLoaded,
}: AuditTrailPanelProps) {
  const [trail, setTrail] = useState<AuditTrail | null>(preloadedTrail ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || preloadedTrail) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<AuditTrail>(endpointFor(targetKind, targetId))
      .then((data) => {
        if (cancelled) return;
        setTrail(data);
        onTrailLoaded?.(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, preloadedTrail, targetKind, targetId, onTrailLoaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Audit trail"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Audit trail</h2>
          <button type="button" className="text-text-dim hover:text-text-primary" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loading ? <p className="text-text-dim">Loading audit details…</p> : null}
        {error ? <p className="text-negative">Could not load audit trail: {error}</p> : null}

        {trail ? (
          trail.passes.length === 0 ? (
            <p className="text-text-dim">No audit ran on this content. It may pre-date the audit feature.</p>
          ) : (
            trail.passes.map((pass) => (
              <section key={pass.pass} className="mb-6">
                <h3 className="mb-2 text-sm font-medium text-text-secondary">
                  Pass {pass.pass} · {pass.summary.status} · {pass.summary.total_claims}{" "}
                  {pass.summary.total_claims === 1 ? "claim" : "claims"}
                </h3>
                <ul className="space-y-3">
                  {pass.claims.map((c) => (
                    <ClaimRow key={c.id} claim={c} sources={sources} />
                  ))}
                </ul>
              </section>
            ))
          )
        ) : null}
      </div>
    </div>
  );
}

function ClaimRow({ claim, sources }: { claim: AuditClaim; sources?: SourceDescriptor[] }) {
  return (
    <li className="rounded border border-border-subtle bg-bg-warm p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${VERDICT_PILL[claim.verdict]}`}>
          {VERDICT_LABEL[claim.verdict]}
        </span>
        {claim.resolution ? <span className="text-xs text-text-dim">{claim.resolution}</span> : null}
      </div>
      <p className="mb-1 text-sm text-text-primary">
        <span className="font-medium">Claim:</span> {claim.claim_text}
      </p>
      {claim.resolution === "patched" && claim.patched_text ? (
        <p className="mb-1 text-sm">
          <span className="font-medium text-warning">Patched to:</span>{" "}
          <span className="text-text-primary">{claim.patched_text}</span>
        </p>
      ) : null}
      {claim.reasoning ? <p className="mb-1 text-sm text-text-secondary">{claim.reasoning}</p> : null}
      {claim.web_evidence && claim.web_evidence.length > 0 ? (
        <div className="mt-1 text-xs">
          <span className="font-medium text-text-dim">Web evidence: </span>
          {claim.web_evidence.map((e, i) => (
            <span key={e.url}>
              {i > 0 ? ", " : null}
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-link-hover">
                {e.title}
              </a>
            </span>
          ))}
        </div>
      ) : null}
      {claim.cited_refs.length > 0 && !claim.web_evidence ? (
        <div className="mt-1 text-xs text-text-dim">
          <span className="font-medium">Cited: </span>
          {claim.cited_refs.map((r) => resolveRef(r, sources)).join(", ")}
        </div>
      ) : null}
    </li>
  );
}

function resolveRef(ref: string, sources?: SourceDescriptor[]): string {
  if (!sources) return ref;
  const idx = ref.indexOf(":");
  if (idx < 0) return ref;
  const type = ref.slice(0, idx);
  const key = ref.slice(idx + 1);
  for (const s of sources) {
    if (s.type !== type) continue;
    if (s.id === key || s.url === key) return s.title ?? ref;
  }
  return ref;
}
