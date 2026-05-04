import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../utils/api";

/**
 * Modal that calls `POST /api/me/refine-prompt` to ask Claude to tighten
 * a draft About / Focus statement into a prompt-ready paragraph, then
 * shows the user the original alongside the refined version with a
 * one-line rationale of what changed. The user accepts or keeps theirs.
 *
 * Extracted from SettingsPanel so the onboarding flow (FirstRunSetup)
 * and the briefing-page Focus editor (FocusEditor) can reuse the same
 * UX without duplicating the network code or the side-by-side layout.
 *
 * Behavior:
 *   • Mounts via React portal at the document body so it sits above
 *     every other modal/popover regardless of stacking context.
 *   • Backdrop click closes (treated as "keep mine").
 *   • Escape is handled by the parent — we don't want to fight other
 *     keyboard handlers in the chat panel etc.
 */

interface RefineDialogProps {
  /** Which kind of statement we're refining — controls the title and
   *  the API endpoint's `kind` parameter, which steers the prompt. */
  kind: "about" | "focus";
  /** The user's current draft to refine. */
  draft: string;
  /** Called when the user clicks Cancel / backdrop / "Keep mine". */
  onCancel: () => void;
  /** Called when the user accepts the refined version. The parent is
   *  responsible for actually saving (this dialog never persists). */
  onAccept: (refined: string) => void;
}

export function RefineDialog({ kind, draft, onCancel, onAccept }: RefineDialogProps) {
  const [loading, setLoading] = useState(true);
  const [refined, setRefined] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Routed through `apiPost` so the call carries the standard
        // `X-Client-Timezone` header and the helper's 503 retry
        // behaviour. Pre-fix this used raw `fetch` which silently
        // dropped the TZ header — not user-visible, but inconsistent
        // with the rest of the app and a footgun for future
        // request-context middleware.
        const data = await apiPost<{ refined: string; rationale: string }>("/api/me/refine-prompt", { kind, draft });
        if (cancelled) return;
        setRefined(data.refined);
        setRationale(data.rationale);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Refinement failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, draft]);

  const titleText = kind === "about" ? "Refine your About statement" : "Refine your Focus statement";

  return createPortal(
    <div className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm grid place-items-center p-4" onClick={onCancel}>
      <div
        className="w-full max-w-3xl rounded-xl bg-bg border border-border shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-text-primary">{titleText}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-dim hover:text-text-secondary p-1.5 rounded-md hover:bg-surface-hover transition-colors"
            aria-label="Close"
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
          {loading && (
            <div className="flex items-center gap-2 text-xs font-mono text-text-dim">
              <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              Asking Claude to tighten your draft…
            </div>
          )}
          {error && (
            <div className="rounded-md bg-negative-dim border border-negative/20 p-3 text-xs font-mono text-negative">
              {error}
            </div>
          )}
          {refined && (
            <>
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-text-faint mb-1">Your draft</div>
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-secondary leading-relaxed rounded-md border border-border-subtle bg-bg-warm p-3">
                  {draft}
                </pre>
              </div>
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-accent mb-1">Refined</div>
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-primary leading-relaxed rounded-md border border-accent/30 bg-accent-dim/20 p-3">
                  {refined}
                </pre>
              </div>
              {rationale && (
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-text-faint mb-1">Why</div>
                  <p className="font-mono text-[11px] text-text-dim leading-relaxed italic">{rationale}</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 px-6 py-3 border-t border-border-subtle flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono text-text-faint">
            Refine doesn't save. You can still edit the textarea after applying.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded-md border border-border text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors"
            >
              Keep mine
            </button>
            <button
              type="button"
              onClick={() => refined && onAccept(refined)}
              disabled={!refined || loading}
              className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              Use refined
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
