/**
 * Compact audit-status pill rendered next to the model attribution
 * on teaching pieces, deep dives, and quizzes.
 *
 * - clean / clean+grounded-web -> `bg-positive-dim text-positive`
 * - patched_count > 0 -> `bg-warning-dim text-warning`
 * - dropped_count > 0 -> `bg-negative-dim text-negative`
 * - status='failed'   -> `bg-bg-warm text-text-dim`
 *
 * Clicking opens a small dropdown menu: "Show audit marks" toggle
 * (per-piece eye icon) and "View full audit trail" (opens the modal
 * panel). The dropdown closes on outside click + ESC.
 *
 * Design tokens only — see AGENTS.md line 53; the matching
 * source-text contract test is tests/unit/audit-indicator.test.tsx.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditSummary } from "../types";
import { dispatchPrimerEvent } from "../lib/events";

interface AuditIndicatorProps {
  audit: AuditSummary | null | undefined;
  targetKind: "piece" | "deep_dive" | "quiz";
  targetId: string;
  /** True when the matching set of inline `.audit-mark` spans is
   *  rendered. The "Show audit marks" toggle in the dropdown reads +
   *  flips this. */
  marksVisible: boolean;
  /** Open the full audit trail panel. */
  onOpenPanel: () => void;
  /** Compact variant for the quiz card. */
  small?: boolean;
}

interface PillStyle {
  className: string;
  label: string;
}

function pillFor(audit: AuditSummary | null | undefined): PillStyle | null {
  if (!audit) return null;
  if (audit.status === "failed") {
    return { className: "bg-bg-warm text-text-dim", label: "Audit unavailable" };
  }
  if (audit.dropped_count > 0) {
    return {
      className: "bg-negative-dim text-negative",
      label: `Audited · ${audit.dropped_count} dropped`,
    };
  }
  if (audit.patched_count > 0) {
    return {
      className: "bg-warning-dim text-warning",
      label: `Audited · ${audit.patched_count} patched`,
    };
  }
  if (audit.grounded_web_count > 0) {
    return {
      className: "bg-positive-dim text-positive",
      label: `Audited · ${audit.grounded_web_count} web-verified`,
    };
  }
  return { className: "bg-positive-dim text-positive", label: "Audited · clean" };
}

export function AuditIndicator({
  audit,
  targetKind,
  targetId,
  marksVisible,
  onOpenPanel,
  small = false,
}: AuditIndicatorProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + ESC close.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleToggleMarks = useCallback(() => {
    dispatchPrimerEvent("audit-marks-visibility-changed", {
      targetKind,
      targetId,
      visible: !marksVisible,
    });
    setOpen(false);
  }, [marksVisible, targetKind, targetId]);

  const handleOpenPanel = useCallback(() => {
    setOpen(false);
    onOpenPanel();
  }, [onOpenPanel]);

  const pill = pillFor(audit);
  if (!pill) {
    // Piece predates the audit feature — render nothing rather than
    // a "no audit" badge that adds noise to the metadata row.
    return null;
  }

  const size = small ? "text-xs px-1.5 py-0.5" : "text-xs px-2 py-0.5";

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        className={`audit-indicator-pill inline-flex items-center gap-1 rounded ${size} ${pill.className} font-medium`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={pill.label}
      >
        <span aria-hidden>✓</span>
        <span>{pill.label}</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[14rem] rounded-md border border-border bg-surface shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
            onClick={handleToggleMarks}
          >
            {marksVisible ? "Hide audit marks" : "Show audit marks"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-hover"
            onClick={handleOpenPanel}
          >
            View full audit trail
          </button>
        </div>
      ) : null}
    </div>
  );
}
