import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Generic confirm dialog rendered into a portal at the body root so it
 * sits above modals, drawers, and any panel chrome. Modeled on the
 * existing `ResetConceptsConfirm` look so confirmation styling stays
 * consistent across the app.
 *
 * Usage:
 *
 *   const [pending, setPending] = useState<MyItem | null>(null);
 *   ...
 *   <ConfirmDialog
 *     open={pending !== null}
 *     title={`Remove "${pending?.label}"?`}
 *     description="This will stop scanning the feed in future briefings."
 *     confirmLabel="Remove"
 *     destructive
 *     onConfirm={() => { void remove(pending!); setPending(null); }}
 *     onCancel={() => setPending(null)}
 *   />
 *
 * Behavior matches a native `confirm()`:
 *   - Backdrop click cancels
 *   - Escape key cancels
 *   - Confirm button takes initial focus so Enter submits
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Optional body copy shown under the title. Renders as plain prose. */
  description?: string;
  /** Optional small warning line shown above the buttons (e.g. "This
   *  cannot be undone."). Rendered in the warning color. */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button uses the negative/danger color
   *  scheme. Defaults to false (accent button). */
  destructive?: boolean;
  /** When true, the buttons disable to indicate an in-flight action. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  warning,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Auto-focus confirm so Enter submits — matches native confirm()
  // semantics where keyboard users can dismiss-and-confirm without
  // reaching for the mouse.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  // ESC closes — symmetric to backdrop click. Stop the listener when
  // the dialog isn't open so unrelated ESC presses don't see ghost
  // handlers stacking up over time.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy) onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const confirmClass = destructive
    ? "px-3 py-1.5 rounded-md bg-negative text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
    : "px-3 py-1.5 rounded-md bg-accent text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50";

  return createPortal(
    <div
      // z-[110] sits above the SettingsModal (z-100), matching the
      // ResetConceptsConfirm precedent so confirms show on top of
      // whatever opened them.
      className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm grid place-items-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl bg-bg border border-border shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-text-primary mb-2">
          {title}
        </h2>
        {description && <p className="text-xs font-mono text-text-secondary leading-relaxed mb-4">{description}</p>}
        {warning && <p className="text-xs font-mono text-warning mb-4">{warning}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-border text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} disabled={busy} className={confirmClass}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
