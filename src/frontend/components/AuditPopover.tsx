/**
 * Floating popover anchored to a clicked `.audit-mark` span. Shows
 * the verdict pill, the auditor's reasoning, cited refs (resolved to
 * titles when available), web evidence (when grounded-web), and the
 * diff (when patched).
 *
 * Subscribes to `audit-mark-clicked` from the typed event bus and
 * resolves the matching `AuditClaim` against the trail this piece's
 * `AuditTrailPanel` (or the popover host itself) has already loaded.
 * One popover is mounted per piece; clicking a different mark
 * re-anchors rather than stacking modals.
 *
 * Keyboard a11y: ESC closes. Outside-click closes. Focus returns to
 * the anchor on close.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { onPrimerEvent } from "../lib/events";
import type { AuditClaim, AuditTrail, SourceDescriptor } from "../types";

interface AuditPopoverProps {
  /** The piece (or quiz) this popover services. Filters incoming
   *  `audit-mark-clicked` events to this target. */
  targetKind: "piece" | "deep_dive" | "quiz";
  targetId: string;
  /** The full trail the panel/popover share. Null = not loaded yet
   *  (popover stays closed; the indicator's "View full audit trail"
   *  path triggers the load). */
  trail: AuditTrail | null;
  /** Source bundle so the cited refs (e.g. `linear_issue:CIN-1234`)
   *  resolve to human-readable titles. Optional — falls back to the
   *  raw enrichment id when a source isn't found. */
  sources?: SourceDescriptor[];
}

interface PopoverPosition {
  top: number;
  left: number;
  arrow: "above" | "below";
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

export function AuditPopover({ targetKind, targetId, trail, sources }: AuditPopoverProps) {
  const [claim, setClaim] = useState<AuditClaim | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Build a quick lookup from claim_id → claim across all passes so
  // the click handler is O(1).
  const claimsById = useMemo(() => {
    const out = new Map<string, AuditClaim>();
    if (!trail) return out;
    for (const pass of trail.passes) {
      for (const c of pass.claims) out.set(c.id, c);
    }
    return out;
  }, [trail]);

  useEffect(() => {
    return onPrimerEvent("audit-mark-clicked", (detail) => {
      if (detail.targetKind !== targetKind || detail.targetId !== targetId) return;
      const found = claimsById.get(detail.claimId);
      if (!found) return;
      anchorRef.current = detail.anchor;
      setClaim(found);
      const rect = detail.anchor.getBoundingClientRect();
      // Default placement: below the anchor. Flip above if the
      // viewport doesn't have room.
      const popoverHeight = 320; // generous worst-case for layout sizing
      const below = rect.bottom + 8;
      const above = rect.top - popoverHeight - 8;
      const wantsAbove = below + popoverHeight > window.innerHeight && above > 0;
      setPosition({
        top: wantsAbove ? rect.top - 8 : rect.bottom + 8,
        left: rect.left,
        arrow: wantsAbove ? "below" : "above",
      });
    });
  }, [claimsById, targetKind, targetId]);

  useEffect(() => {
    if (!claim) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setClaim(null);
        anchorRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        // Don't close when clicking another audit mark — let that
        // event re-anchor naturally.
        const target = e.target as HTMLElement | null;
        if (target?.closest?.(".audit-mark")) return;
        setClaim(null);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [claim]);

  if (!claim || !position) return null;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Audit details for this claim"
      className="fixed z-50 max-w-md rounded-lg border border-border bg-surface p-4 shadow-xl"
      style={{
        top: position.arrow === "above" ? position.top : undefined,
        bottom: position.arrow === "below" ? window.innerHeight - position.top : undefined,
        left: position.left,
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${VERDICT_PILL[claim.verdict]}`}>
          {VERDICT_LABEL[claim.verdict]}
        </span>
        <button
          type="button"
          className="text-text-dim hover:text-text-primary"
          onClick={() => setClaim(null)}
          aria-label="Close audit details"
        >
          ✕
        </button>
      </div>

      {claim.reasoning ? (
        <p className="mb-2 text-sm text-text-secondary">{claim.reasoning}</p>
      ) : null}

      {claim.resolution === "patched" && claim.patched_text ? (
        <div className="mb-2 rounded border border-warning-dim bg-bg-warm p-2 text-sm">
          <div className="mb-1 text-xs font-medium text-warning">Patched</div>
          <div className="mb-1 text-text-dim line-through">{claim.claim_text}</div>
          <div className="text-text-primary">{claim.patched_text}</div>
        </div>
      ) : null}

      {claim.resolution === "dropped" ? (
        <div className="mb-2 rounded border border-negative-dim bg-bg-warm p-2 text-sm">
          <div className="mb-1 text-xs font-medium text-negative">Dropped</div>
          <div className="text-text-dim line-through">{claim.claim_text}</div>
        </div>
      ) : null}

      {claim.web_evidence && claim.web_evidence.length > 0 ? (
        <div className="mb-2">
          <div className="mb-1 text-xs font-medium text-text-dim">Web evidence</div>
          <ul className="space-y-1">
            {claim.web_evidence.map((ev) => (
              <li key={ev.url}>
                <a
                  href={ev.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-accent hover:text-link-hover"
                >
                  {ev.title}
                </a>
                {ev.snippet ? <div className="text-xs text-text-dim">{ev.snippet}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {claim.cited_refs.length > 0 && !claim.web_evidence ? (
        <div>
          <div className="mb-1 text-xs font-medium text-text-dim">Cited sources</div>
          <ul className="space-y-0.5">
            {claim.cited_refs.map((ref) => (
              <li key={ref} className="text-sm text-text-secondary">
                {resolveRefTitle(ref, sources)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function resolveRefTitle(ref: string, sources?: SourceDescriptor[]): string {
  if (!sources) return ref;
  // ref format is `type:id` (or `type:url` as fallback). Match either.
  const idx = ref.indexOf(":");
  if (idx < 0) return ref;
  const type = ref.slice(0, idx);
  const key = ref.slice(idx + 1);
  for (const s of sources) {
    if (s.type !== type) continue;
    if (s.id === key || s.url === key) {
      return s.title ? `${s.title} (${ref})` : ref;
    }
  }
  return ref;
}
