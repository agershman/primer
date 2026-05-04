import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { SourceDescriptor } from "../sources/types";
import { apiGet, apiPatch, apiPost } from "../utils/api";
import { DictationButton } from "./DictationButton";
import { RefineDialog } from "./RefineDialog";

interface SourceSuggestion {
  id: string;
  recommended: boolean;
  rationale: string;
}

/**
 * First-run onboarding overlay.
 *
 * The very first time a user lands in Primer (no About statement and
 * no Focus statement), they see this two-step welcome wizard before
 * they can interact with the briefing. Without an About + Focus,
 * Primer's content is generic — extraction misses the user's actual
 * interests, briefings read like industry-news summaries, and the AI
 * voice has no calibration. Asking up front pays off enormously.
 *
 * Steps:
 *   1. About you — stable persona (role, experience, communication
 *      preferences). Tailors voice + depth across all of Primer's AI.
 *   2. Current focus — what you want to learn right now. Drives concept
 *      extraction; biases briefings toward your interests.
 *
 * Each step has:
 *   • A textarea pre-filled with example placeholder text.
 *   • A "✨ Refine with AI" button → shared `RefineDialog`.
 *   • A "Skip for now" escape hatch (one click, dismisses for the
 *     session via sessionStorage). The user can finish later via
 *     Settings; the briefing page also surfaces a callout when only
 *     one of the two is set.
 *
 * Mounting:
 *   The parent (typically `App.tsx`) decides when to render this. We
 *   trust it not to render us when the user has already set both —
 *   the dismissal logic lives outside this component.
 */

interface FirstRunSetupProps {
  /** Existing About statement, if any (e.g. user partially completed). */
  initialAbout?: string | null;
  /** Existing Focus statement, if any. */
  initialFocus?: string | null;
  /** Called once the user finishes (saves both, or skips). The parent
   *  refreshes useCurrentUser and removes this overlay. */
  onComplete: () => void;
  /** Called when the user picks "Skip for now". Parent typically sets a
   *  session flag so we don't reappear immediately. */
  onSkip: () => void;
}

type Step = "intro" | "about" | "focus" | "sources" | "done";

const ABOUT_PLACEHOLDER =
  "I'm a product manager with a design background. I've been in tech for 6 years and prefer clear, practical explanations — show me the 'why' and the trade-offs, not just the how. I learn best through concrete examples and analogies.";

const FOCUS_PLACEHOLDER =
  "I'm exploring how AI is changing product discovery workflows — user research automation, conversational interfaces, and when to use AI vs traditional UX patterns. Also keeping an eye on pricing strategy for usage-based SaaS models.";

export function FirstRunSetup({ initialAbout, initialFocus, onComplete, onSkip }: FirstRunSetupProps) {
  // If the user already has one of the two, start them on the missing
  // step rather than making them re-confirm what they already wrote.
  const initialStep: Step = !initialAbout ? "about" : !initialFocus ? "focus" : "done";
  const [step, setStep] = useState<Step>("intro");
  const [aboutDraft, setAboutDraft] = useState(initialAbout ?? "");
  const [focusDraft, setFocusDraft] = useState(initialFocus ?? "");
  // Live dictation state per textarea — same continuous voice mode
  // used on quiz answers and the chat input. Per-step state means
  // toggling between the About and Focus steps doesn't carry stale
  // interim text from one to the other.
  const [aboutInterim, setAboutInterim] = useState("");
  const [aboutDictating, setAboutDictating] = useState(false);
  const [focusInterim, setFocusInterim] = useState("");
  const [focusDictating, setFocusDictating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refineKind, setRefineKind] = useState<"about" | "focus" | null>(null);

  // Sources step state. We render every available source the
  // deployment exposes, with no checkbox pre-selected — the AI's role
  // is purely advisory through `suggestionById`, which highlights the
  // recommended ones and shows their rationale.
  const [availableSources, setAvailableSources] = useState<Array<SourceDescriptor & { available: boolean }>>([]);
  const [suggestionById, setSuggestionById] = useState<Record<string, SourceSuggestion>>({});
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [sourcesLoading, setSourcesLoading] = useState(false);

  // If the user already had something saved, skip past the intro.
  // Without this, a partial completion would always start at intro
  // even when the user just needs to finish step 2.
  useEffect(() => {
    if (initialStep === "done") {
      onComplete();
    }
  }, [initialStep, onComplete]);

  const aboutValid = aboutDraft.trim().length >= 30;
  const focusValid = focusDraft.trim().length >= 20;

  const saveAbout = async (): Promise<boolean> => {
    if (!aboutValid) return false;
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/me/about", {
        statement: aboutDraft.trim(),
        note: "Set during first-run onboarding",
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save About statement");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveFocus = async (): Promise<boolean> => {
    if (!focusValid) return false;
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/me/focus", {
        statement: focusDraft.trim(),
        note: "Set during first-run onboarding",
      });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Focus statement");
      return false;
    } finally {
      setSaving(false);
    }
  };

  // When the user lands on the sources step, fetch the available
  // sources and the AI's recommendations in parallel. Both are
  // soft-fetches: a registry-list failure or an LLM hiccup must not
  // block the user from finishing onboarding, so on error we simply
  // render an empty list (the user can pick sources later in
  // Settings → Sources).
  useEffect(() => {
    if (step !== "sources") return;
    setSourcesLoading(true);
    Promise.allSettled([
      apiGet<{ sources: Array<SourceDescriptor & { available: boolean }> }>("/api/sources"),
      apiPost<{ suggestions: SourceSuggestion[] }>("/api/sources/suggest-enabled", {}),
    ]).then((results) => {
      if (results[0].status === "fulfilled") {
        setAvailableSources(results[0].value.sources.filter((s) => s.available));
      }
      if (results[1].status === "fulfilled") {
        const map: Record<string, SourceSuggestion> = {};
        for (const s of results[1].value.suggestions) map[s.id] = s;
        setSuggestionById(map);
      }
      setSourcesLoading(false);
    });
  }, [step]);

  const toggleSource = (id: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveSources = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch("/api/settings", { enabledSourceIds: Array.from(selectedSources) });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save source selection");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const advance = async () => {
    if (step === "intro") {
      // If About is already set (rare partial state), jump straight to focus.
      setStep(initialAbout ? "focus" : "about");
      return;
    }
    if (step === "about") {
      const ok = await saveAbout();
      if (ok) setStep("focus");
      return;
    }
    if (step === "focus") {
      const ok = await saveFocus();
      if (ok) setStep("sources");
      return;
    }
    if (step === "sources") {
      const ok = await saveSources();
      if (ok) {
        setStep("done");
        onComplete();
      }
      return;
    }
  };

  if (step === "done") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm grid place-items-center p-4">
      <div
        className="w-full max-w-2xl rounded-xl bg-bg border border-border shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "90vh" }}
      >
        {/* Step indicator */}
        <div className="shrink-0 px-6 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2 mb-1">
            <Dot active={step === "intro"} done={false} />
            <div className="h-px flex-1 bg-border-subtle" />
            <Dot active={step === "about"} done={step === "focus" || step === "sources"} />
            <div className="h-px flex-1 bg-border-subtle" />
            <Dot active={step === "focus"} done={step === "sources"} />
            <div className="h-px flex-1 bg-border-subtle" />
            <Dot active={step === "sources"} done={false} />
          </div>
          <div className="flex items-center justify-between">
            <h1 className="font-display text-lg font-medium text-text-primary">
              {step === "intro" && "Welcome to Primer"}
              {step === "about" && "Tell us about you"}
              {step === "focus" && "What do you want to learn?"}
              {step === "sources" && "Pick your sources"}
            </h1>
            <button
              type="button"
              onClick={onSkip}
              className="font-mono text-[10px] text-text-faint hover:text-text-dim transition-colors"
            >
              Skip for now
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {step === "intro" && (
            <div className="space-y-4">
              <p className="font-body text-sm text-text-secondary leading-relaxed">
                Primer connects to your sources — project trackers, chat, repositories, feeds, and more — and turns them
                into a personalized daily learning briefing calibrated to what you already know.
              </p>
              <p className="font-body text-sm text-text-secondary leading-relaxed">
                Two short paragraphs you write here shape <em>everything</em> Primer produces. They take ~2 minutes
                total, and you can refine them anytime.
              </p>
              <div className="rounded-lg border border-border-subtle bg-bg-warm p-4 space-y-3">
                <div>
                  <div className="font-ui text-xs font-semibold text-text-primary mb-0.5">1. About you</div>
                  <p className="font-mono text-[11px] text-text-dim leading-relaxed">
                    A stable persona: who you are, your background, how you like to be communicated to. Tailors voice
                    and depth across every teaching piece, deep dive, chat reply, and quiz.
                  </p>
                </div>
                <div>
                  <div className="font-ui text-xs font-semibold text-text-primary mb-0.5">2. Current focus</div>
                  <p className="font-mono text-[11px] text-text-dim leading-relaxed">
                    What you want to learn <em>right now</em>. Shapes what Primer pays attention to and filters out
                    noise. Update it whenever your priorities shift — there's a quick-edit button right on the briefing
                    page.
                  </p>
                </div>
              </div>
              <p className="font-mono text-[11px] text-text-faint italic">
                Both are versioned — you'll see your full history later in Settings, with per-version analytics so you
                can see how a focus change affected your concept graph.
              </p>
            </div>
          )}

          {step === "about" && (
            <div className="space-y-3">
              <p className="font-mono text-[11px] text-text-dim leading-relaxed">
                Your background, what you're into, how you like to learn. Don't worry about polish — you can refine this
                later or right now with Claude (✨ Refine with AI), or tap the mic to dictate it instead of typing.
              </p>
              <div className="relative">
                <textarea
                  value={
                    aboutDictating && aboutInterim ? `${aboutDraft}${aboutDraft ? " " : ""}${aboutInterim}` : aboutDraft
                  }
                  onChange={(e) => setAboutDraft(e.target.value)}
                  rows={8}
                  autoFocus
                  readOnly={aboutDictating}
                  placeholder={aboutDictating ? "Listening — speak freely…" : ABOUT_PLACEHOLDER}
                  className={`w-full rounded-md border bg-surface px-3 py-2 pr-10 font-mono text-xs text-text-primary leading-relaxed focus:outline-none transition-colors resize-y ${
                    aboutDictating
                      ? "border-accent ring-2 ring-accent/20 cursor-default"
                      : "border-border focus:border-accent"
                  }`}
                  data-allow-typing=""
                />
                <div className="absolute right-1.5 top-1.5">
                  <DictationButton
                    onTranscript={(text) => setAboutDraft((prev) => (prev ? `${prev} ${text}` : text))}
                    onInterim={setAboutInterim}
                    onListeningChange={setAboutDictating}
                    continuous
                    className="h-7 w-7"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-text-faint">
                  {aboutDraft.trim().length < 30
                    ? `${30 - aboutDraft.trim().length} more characters to enable Save`
                    : `${aboutDraft.trim().length} characters — looking good`}
                </span>
                <button
                  type="button"
                  onClick={() => setRefineKind("about")}
                  disabled={aboutDraft.trim().length < 20}
                  className="font-mono text-[10px] text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ✨ Refine with AI
                </button>
              </div>
            </div>
          )}

          {step === "focus" && (
            <div className="space-y-3">
              <p className="font-mono text-[11px] text-text-dim leading-relaxed">
                What's the story you'd tell a smart colleague about what you're working on and curious about right now?
                Specific systems, technologies, problem spaces — the more concrete, the better. This is what makes
                briefings stop feeling generic. Talk it out with the mic if that's easier.
              </p>
              <div className="relative">
                <textarea
                  value={
                    focusDictating && focusInterim ? `${focusDraft}${focusDraft ? " " : ""}${focusInterim}` : focusDraft
                  }
                  onChange={(e) => setFocusDraft(e.target.value)}
                  rows={6}
                  autoFocus
                  readOnly={focusDictating}
                  placeholder={focusDictating ? "Listening — speak freely…" : FOCUS_PLACEHOLDER}
                  className={`w-full rounded-md border bg-surface px-3 py-2 pr-10 font-mono text-xs text-text-primary leading-relaxed focus:outline-none transition-colors resize-y ${
                    focusDictating
                      ? "border-accent ring-2 ring-accent/20 cursor-default"
                      : "border-border focus:border-accent"
                  }`}
                  data-allow-typing=""
                />
                <div className="absolute right-1.5 top-1.5">
                  <DictationButton
                    onTranscript={(text) => setFocusDraft((prev) => (prev ? `${prev} ${text}` : text))}
                    onInterim={setFocusInterim}
                    onListeningChange={setFocusDictating}
                    continuous
                    className="h-7 w-7"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-text-faint">
                  {focusDraft.trim().length < 20
                    ? `${20 - focusDraft.trim().length} more characters to enable Save`
                    : `${focusDraft.trim().length} characters — ready to save`}
                </span>
                <button
                  type="button"
                  onClick={() => setRefineKind("focus")}
                  disabled={focusDraft.trim().length < 15}
                  className="font-mono text-[10px] text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ✨ Refine with AI
                </button>
              </div>
            </div>
          )}

          {step === "sources" && (
            <div className="space-y-3">
              <p className="font-mono text-[11px] text-text-dim leading-relaxed">
                Pick the sources you want feeding your daily briefing. Based on what you wrote above, we've highlighted
                a few that look like a fit — but you decide. You can change this anytime in Settings.
              </p>
              {sourcesLoading ? (
                <div className="rounded-lg border border-border-subtle bg-bg-warm p-4 text-xs font-mono text-text-dim">
                  Loading sources…
                </div>
              ) : availableSources.length === 0 ? (
                <div className="rounded-lg border border-border-subtle bg-bg-warm p-4 text-xs font-mono text-text-dim">
                  No sources are configured on this deployment yet. You can skip this step and add them later.
                </div>
              ) : (
                <div className="space-y-2">
                  {availableSources.map((s) => {
                    const sug = suggestionById[s.id];
                    const recommended = sug?.recommended === true;
                    const isSelected = selectedSources.has(s.id);
                    return (
                      <label
                        key={s.id}
                        className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                          recommended
                            ? "border-accent/40 bg-accent/5 hover:bg-accent/10"
                            : "border-border-subtle bg-surface hover:bg-surface-hover"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSource(s.id)}
                          className="mt-0.5 h-4 w-4 rounded border-border accent-accent shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-text-primary">{s.name}</span>
                            {recommended && <span className="text-[10px] font-mono text-accent">✨ suggested</span>}
                          </div>
                          {recommended && sug?.rationale ? (
                            <div className="mt-0.5 text-[11px] font-mono text-text-dim leading-relaxed">
                              {sug.rationale}
                            </div>
                          ) : s.description ? (
                            <div className="mt-0.5 text-[11px] font-mono text-text-faint leading-relaxed">
                              {s.description}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-md bg-negative-dim border border-negative/20 p-3 text-xs font-mono text-negative">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-3 border-t border-border-subtle flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-text-faint">
            {step === "intro" && "Takes about 2 minutes."}
            {step === "about" && "Step 1 of 3"}
            {step === "focus" && "Step 2 of 3"}
            {step === "sources" && "Step 3 of 3 — almost done"}
          </span>
          <div className="flex items-center gap-2">
            {step === "focus" && (
              <button
                type="button"
                onClick={() => setStep("about")}
                disabled={saving}
                className="px-3 py-1.5 rounded-md text-xs font-mono text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors"
              >
                ← Back
              </button>
            )}
            {step === "sources" && (
              <button
                type="button"
                onClick={() => setStep("focus")}
                disabled={saving}
                className="px-3 py-1.5 rounded-md text-xs font-mono text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors"
              >
                ← Back
              </button>
            )}
            <button
              type="button"
              onClick={advance}
              disabled={saving || (step === "about" && !aboutValid) || (step === "focus" && !focusValid)}
              className="px-4 py-1.5 rounded-md bg-accent text-white text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {step === "intro" && "Get started →"}
              {step === "about" && (saving ? "Saving…" : "Continue →")}
              {step === "focus" && (saving ? "Saving…" : "Continue →")}
              {step === "sources" && (saving ? "Saving…" : "Finish & build my first briefing")}
            </button>
          </div>
        </div>
      </div>

      {refineKind && (
        <RefineDialog
          kind={refineKind}
          draft={refineKind === "about" ? aboutDraft : focusDraft}
          onCancel={() => setRefineKind(null)}
          onAccept={(refined) => {
            if (refineKind === "about") setAboutDraft(refined);
            else setFocusDraft(refined);
            setRefineKind(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function Dot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <span
      className={`h-2 w-2 rounded-full transition-colors ${active ? "bg-accent" : done ? "bg-positive" : "bg-border"}`}
    />
  );
}
