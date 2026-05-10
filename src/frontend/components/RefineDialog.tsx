import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiPost } from "../utils/api";
import { DictationButton } from "./DictationButton";

/**
 * Modal that calls `POST /api/me/refine-prompt` to ask Claude to refine
 * a draft About / Focus statement, then shows the user the original
 * alongside the refined version with a one-line rationale of what
 * changed. The user accepts or keeps theirs.
 *
 * Two modes:
 *   - "tighten" (default): on mount, immediately POST the draft and
 *     ask Claude to tighten it into a prompt-ready paragraph. Original
 *     behaviour, used by the "✨ Refine with AI" button.
 *   - "instruction": render a typed/dictated instruction input first
 *     ("shorter", "add that I love TypeScript", "remove Kubernetes"),
 *     then POST `{ draft, instruction }` once the user clicks Refine.
 *     Backed by the same endpoint and same response shape.
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
  /** Refinement mode. Defaults to "tighten" for backwards compatibility
   *  with existing call sites that pre-date instruction-mode. */
  mode?: "tighten" | "instruction";
  /** Called when the user clicks Cancel / backdrop / "Keep mine". */
  onCancel: () => void;
  /** Called when the user accepts the refined version. The parent is
   *  responsible for actually saving (this dialog never persists). */
  onAccept: (refined: string) => void;
}

export function RefineDialog({ kind, draft, mode = "tighten", onCancel, onAccept }: RefineDialogProps) {
  // In "tighten" mode we fire on mount; in "instruction" mode we wait
  // until the user submits the instruction. `submitted` controls the
  // transition from the instruction-input stage to the loading/diff
  // stage so the network call doesn't fire prematurely.
  const [submitted, setSubmitted] = useState(mode === "tighten");
  const [instruction, setInstruction] = useState("");
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);
  const [loading, setLoading] = useState(mode === "tighten");
  const [refined, setRefined] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!submitted) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Routed through `apiPost` so the call carries the standard
        // `X-Client-Timezone` header and the helper's 503 retry
        // behaviour. Pre-fix this used raw `fetch` which silently
        // dropped the TZ header — not user-visible, but inconsistent
        // with the rest of the app and a footgun for future
        // request-context middleware.
        const trimmedInstruction = instruction.trim();
        const body: { kind: "about" | "focus"; draft: string; instruction?: string } = { kind, draft };
        if (trimmedInstruction) body.instruction = trimmedInstruction;
        const data = await apiPost<{ refined: string; rationale: string }>("/api/me/refine-prompt", body);
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
    // `instruction` is captured at submit time; we deliberately don't re-fetch
    // when it changes after submission. `kind` and `draft` are stable for the
    // lifetime of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitted, kind, draft]);

  const titleText =
    mode === "instruction"
      ? kind === "about"
        ? "Refine your About statement with an instruction"
        : "Refine your Focus statement with an instruction"
      : kind === "about"
        ? "Refine your About statement"
        : "Refine your Focus statement";

  // Display value for the instruction textarea. Mirrors the live-transcript
  // pattern used in StatementPanel / FocusEditor: while dictating, append
  // the interim transcript to the existing text so the user can see what
  // the recognizer is hearing in real time.
  const instructionValue = dictating && interim ? `${instruction}${instruction ? " " : ""}${interim}` : instruction;
  const canSubmitInstruction = !submitted && instruction.trim().length >= 3;

  const handleInstructionSubmit = () => {
    if (!canSubmitInstruction) return;
    setSubmitted(true);
  };

  const handleBackToInstruction = () => {
    setSubmitted(false);
    setRefined(null);
    setRationale("");
    setError(null);
  };

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

        {mode === "instruction" && !submitted ? (
          // Instruction-input stage: capture how the user wants their
          // existing statement refined. Dictation reuses the same
          // continuous Web Speech API pattern used elsewhere in the app.
          <>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-text-faint mb-1">
                  Your current statement
                </div>
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-secondary leading-relaxed rounded-md border border-border-subtle bg-bg-warm p-3 max-h-40 overflow-y-auto">
                  {draft}
                </pre>
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase tracking-wider text-accent mb-1 block">
                  How should we refine it?
                </label>
                <div className="relative">
                  <textarea
                    value={instructionValue}
                    onChange={(e) => setInstruction(e.target.value)}
                    rows={5}
                    autoFocus
                    readOnly={dictating}
                    placeholder={
                      dictating
                        ? "Listening — speak freely…"
                        : kind === "about"
                          ? "e.g. 'Make it shorter and less hedging.' or 'Add that I prefer trade-off discussions over exhaustive overviews.'"
                          : "e.g. 'Add that I'm focused on Postgres performance.' or 'Remove the bit about Kubernetes — I'm not working on that anymore.'"
                    }
                    className={`w-full rounded-md border bg-surface px-3 py-2 pr-10 font-mono text-xs text-text-primary leading-relaxed focus:outline-none transition-colors resize-y ${
                      dictating
                        ? "border-accent ring-2 ring-accent/20 cursor-default"
                        : "border-border focus:border-accent"
                    }`}
                    maxLength={2000}
                    data-allow-typing=""
                  />
                  <div className="absolute right-1.5 top-1.5">
                    <DictationButton
                      onTranscript={(text) => setInstruction((prev) => (prev ? `${prev} ${text}` : text))}
                      onInterim={setInterim}
                      onListeningChange={setDictating}
                      continuous
                      className="h-7 w-7"
                    />
                  </div>
                </div>
                {dictating && (
                  <p className="mt-1 font-ui text-[10px] text-accent">
                    ● Listening — pause for 5 s or tap the mic to stop.
                  </p>
                )}
                <div className="mt-1 text-[10px] font-mono text-text-faint">
                  {instruction.length} / 2000 chars · type or dictate
                </div>
              </div>
            </div>

            <div className="shrink-0 px-6 py-3 border-t border-border-subtle flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono text-text-faint">
                Claude will apply your instruction and preserve the rest.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onCancel}
                  className="px-3 py-1.5 rounded-md border border-border text-xs font-mono text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInstructionSubmit}
                  disabled={!canSubmitInstruction}
                  title={!canSubmitInstruction ? "Type or dictate an instruction (at least 3 chars)" : undefined}
                  className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Refine
                </button>
              </div>
            </div>
          </>
        ) : (
          // Result stage: shared between tighten-mode (auto-fired on
          // mount) and instruction-mode (fired after user submits).
          <>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
              {loading && (
                <div className="flex items-center gap-2 text-xs font-mono text-text-dim">
                  <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                  {mode === "instruction"
                    ? "Asking Claude to apply your instruction…"
                    : "Asking Claude to tighten your draft…"}
                </div>
              )}
              {error && (
                <div className="rounded-md bg-negative-dim border border-negative/20 p-3 text-xs font-mono text-negative">
                  {error}
                </div>
              )}
              {refined && (
                <>
                  {mode === "instruction" && instruction.trim() && (
                    <div>
                      <div className="text-[10px] font-mono uppercase tracking-wider text-text-faint mb-1">
                        Your instruction
                      </div>
                      <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-secondary leading-relaxed rounded-md border border-border-subtle bg-bg-warm p-3">
                        {instruction.trim()}
                      </pre>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-text-faint mb-1">
                      {mode === "instruction" ? "Before" : "Your draft"}
                    </div>
                    <pre className="whitespace-pre-wrap font-mono text-[11px] text-text-secondary leading-relaxed rounded-md border border-border-subtle bg-bg-warm p-3">
                      {draft}
                    </pre>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-accent mb-1">
                      {mode === "instruction" ? "After" : "Refined"}
                    </div>
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
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-text-faint">
                  Refine doesn't save. You can still edit the textarea after applying.
                </span>
                {mode === "instruction" && !loading && (
                  <button
                    type="button"
                    onClick={handleBackToInstruction}
                    className="text-[10px] font-mono text-accent hover:underline"
                  >
                    ← Edit instruction
                  </button>
                )}
              </div>
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
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
