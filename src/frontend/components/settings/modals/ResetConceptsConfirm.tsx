import { createPortal } from "react-dom";

export function ResetConceptsConfirm({
  working,
  onConfirm,
  onCancel,
}: {
  working: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm grid place-items-center p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-xl bg-bg border border-border shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-text-primary mb-2">Reset all concepts?</h2>
        <p className="text-xs font-mono text-text-secondary leading-relaxed mb-4">
          This deletes every concept in your graph along with depth scores, exposure counts, and calibration history.
          Past briefings and teaching pieces are kept for the audit trail. The next briefing rebuilds the graph from
          scratch using your current focus statement and the new extraction rules.
        </p>
        <p className="text-xs font-mono text-warning mb-4">This cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={working}
            className="px-3 py-1.5 rounded-md border border-border text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={working}
            className="px-3 py-1.5 rounded-md bg-negative text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {working ? "Resetting…" : "Yes, reset everything"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
