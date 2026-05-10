import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../utils/api";
import { DictationButton } from "./DictationButton";
import { RefineDialog } from "./RefineDialog";

/**
 * Compact modal for updating the user's Focus statement directly from
 * the briefing page (or anywhere else outside Settings). The Settings
 * panel has the full versioning + history UI; this editor is the
 * "quick capture" surface for when you notice mid-briefing that your
 * focus has drifted and you don't want to navigate away to fix it.
 *
 * Behavior:
 *   • Pre-fills with the current focus statement.
 *   • ✨ Refine with AI → opens the shared `RefineDialog` and writes
 *     the accepted output back into the textarea.
 *   • 🎙 Refine with instruction → opens the same dialog in
 *     instruction mode, letting the user type or dictate a targeted
 *     edit ("shorter", "add X", "remove Y") instead of an unconstrained
 *     tighten.
 *   • Save → POST `/api/me/focus`, which is idempotent: if the user
 *     hits Save without changing the statement, it returns the
 *     existing version rather than minting a duplicate.
 *   • After save, calls `onSaved` so the parent can refresh
 *     `useCurrentUser` and show a confirmation toast.
 *   • Heads-up message: today's briefing was generated against the
 *     OLD focus, so the new statement won't take effect until the
 *     next briefing run. We surface this in the modal so the user
 *     isn't surprised that today's content didn't change.
 *
 * No "what changed?" free-text input. The version history modal
 * already surfaces the textual diff between consecutive versions —
 * that's what users actually scan history for. Asking the user to
 * also type intent on every save was friction with no real payoff.
 *
 * The modal is portal'd onto document.body so it sits above any
 * other slide-out panels (chat, settings, etc.) without stacking-
 * context bugs.
 */

interface FocusEditorProps {
  /** Current focus statement (null/empty if the user hasn't set one). */
  currentFocus: string | null;
  /** Called after a successful save with the persisted statement. */
  onSaved: (newStatement: string) => void;
  /** Called when the user closes the modal without saving. */
  onCancel: () => void;
}

export function FocusEditor({ currentFocus, onSaved, onCancel }: FocusEditorProps) {
  const [draft, setDraft] = useState(currentFocus ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `null` = closed; otherwise the dialog opens in the named mode.
  // Two entry points share the same dialog: the original "tighten my
  // draft" flow and the instruction-driven flow ("apply this edit"),
  // matching the Settings panel's UX so both surfaces stay consistent.
  const [refineMode, setRefineMode] = useState<"tighten" | "instruction" | null>(null);
  // Live dictation state — same continuous voice-mode pattern used on
  // quiz answer textareas and the chat input. Tap mic, talk freely,
  // pauses are fine, auto-stops after 5 s of silence (or tap again).
  // Live transcript appears in the textarea while listening.
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);

  // Escape key closes — but only when the refine dialog isn't on top
  // of us. The shared RefineDialog handles its own dismissal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !refineMode) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, refineMode]);

  const dirty = draft.trim().length > 0 && draft.trim() !== (currentFocus ?? "").trim();
  const canSave = dirty && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // No `note` field on the wire — the history view surfaces the
      // textual diff between consecutive versions, which is what
      // users actually scan history for.
      await apiPost("/api/me/focus", { statement: draft.trim() });
      onSaved(draft.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/50 backdrop-blur-sm grid place-items-center p-4" onClick={onCancel}>
      <div
        className="w-full max-w-2xl rounded-xl bg-bg border border-border shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Update your focus</h2>
            <p className="font-mono text-[10px] text-text-faint mt-0.5">
              Saves as a new version. Today's briefing already ran — your update will shape the next one.
            </p>
          </div>
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

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-3">
          <label className="block">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-faint">Current focus</span>
            <div className="relative mt-1">
              <textarea
                value={dictating && interim ? `${draft}${draft ? " " : ""}${interim}` : draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={5}
                autoFocus
                readOnly={dictating}
                placeholder={
                  dictating
                    ? "Listening — speak freely…"
                    : "What do you want to learn about right now? E.g. 'Building reliable distributed systems on Cloudflare Workers — Durable Objects, KV, and how to design for eventual consistency.'"
                }
                className={`w-full rounded-md border bg-surface px-3 py-2 pr-10 font-mono text-xs text-text-primary leading-relaxed focus:outline-none transition-colors resize-y ${
                  dictating ? "border-accent ring-2 ring-accent/20 cursor-default" : "border-border focus:border-accent"
                }`}
                data-allow-typing=""
              />
              <div className="absolute right-1.5 top-1.5">
                <DictationButton
                  onTranscript={(text) => setDraft((prev) => (prev ? `${prev} ${text}` : text))}
                  onInterim={setInterim}
                  onListeningChange={setDictating}
                  continuous
                  className="h-7 w-7"
                />
              </div>
              {dictating && (
                <p className="mt-1 font-ui text-[10px] text-accent">
                  ● Listening — pause for 5 s or tap the mic to stop.
                </p>
              )}
            </div>
          </label>

          {error && (
            <div className="rounded-md bg-negative-dim border border-negative/20 p-3 text-xs font-mono text-negative">
              {error}
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 py-3 border-t border-border-subtle flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setRefineMode("tighten")}
            disabled={draft.trim().length < 10}
            className="px-3 py-1.5 rounded-md border border-border-subtle text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={draft.trim().length < 10 ? "Write a sentence first" : "Ask Claude to tighten your draft"}
          >
            ✨ Refine with AI
          </button>
          <button
            type="button"
            onClick={() => setRefineMode("instruction")}
            disabled={draft.trim().length < 10}
            className="px-3 py-1.5 rounded-md border border-border-subtle text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              draft.trim().length < 10
                ? "Write a sentence first"
                : "Tell Claude how to refine your draft (type or dictate)"
            }
          >
            🎙 Refine with instruction
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs font-mono text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            title={!dirty ? "No changes to save" : undefined}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : "Save as new version"}
          </button>
        </div>
      </div>

      {refineMode && (
        <RefineDialog
          kind="focus"
          draft={draft}
          mode={refineMode}
          onCancel={() => setRefineMode(null)}
          onAccept={(refined) => {
            setDraft(refined);
            setRefineMode(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}
