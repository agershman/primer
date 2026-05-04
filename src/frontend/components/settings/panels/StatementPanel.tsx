import { useEffect, useState } from "react";
import { apiPost } from "../../../utils/api";
import { DictationButton } from "../../DictationButton";
import { RefineDialog } from "../../RefineDialog";
import { StatementHistoryModal } from "../modals/StatementHistoryModal";
import { useSettingsCtx } from "../SettingsContext";
import { Card, PanelHeader } from "../shared";

interface CopyTable {
  title: string;
  description: string;
  placeholder: string;
  endpoint: string;
}

const COPY: Record<"about" | "focus", CopyTable> = {
  about: {
    title: "About you",
    description:
      "Who you are — your role, experience, and communication preferences. Used to tailor voice and depth across all of Primer's AI: teaching pieces, deep dives, chat, briefings, quizzes. Stable; changes rarely. Versioned with full history.",
    placeholder:
      "e.g. Senior platform engineer at a small B2B SaaS startup. ~12 years experience, comfortable with deep technical detail; assume I know the basics of Kubernetes, AWS, and Terraform. I learn best from concrete examples and trade-off discussions, not exhaustive overviews. Direct, slightly skeptical tone preferred — no MBA-speak.",
    endpoint: "/api/me/about",
  },
  focus: {
    title: "Current focus",
    description:
      "What you want to learn or focus on right now. Drives concept extraction — biases the system toward topics you care about. Changes more often than About. Versioned with per-version analytics.",
    placeholder:
      "e.g. Platform/infra engineer focused on Cloudflare Workers, multi-tenant Kubernetes, customer environment provisioning, and reliability. I don't care about people/process topics like standups or OKRs.",
    endpoint: "/api/me/focus",
  },
};

/**
 * Shared editor for About / Focus statements. Same UX on both:
 *
 *  - Textarea with continuous-mode dictation (mic + live interim)
 *  - "Refine with AI" button (Claude tightens the draft)
 *  - "Save as new version" button (creates a new versioned row)
 *  - Char count + "View history" link
 *
 * Both surfaces are versioned the same way, with the same history
 * modal — so factoring this once and parameterising over `kind` keeps
 * the two panels in lockstep.
 *
 * No "why this change?" free-text input. Earlier versions asked the
 * user to type the *intent* alongside every save, but in practice the
 * version history modal already infers the textual diff (added /
 * removed lines), and that turned out to be all the context the user
 * actually needs when scanning history. Asking for a free-text note
 * on every save was friction with no real payoff. The `note` column
 * stays in the schema as `NULL`able — the restore-from-version path
 * still writes a "restored from <id>" marker.
 */
export function StatementPanel({ kind }: { kind: "about" | "focus" }) {
  const { user, onUserChanged } = useSettingsCtx();
  const copy = COPY[kind];

  const initial = (kind === "about" ? user?.aboutStatement : user?.focusStatement) ?? "";
  const versionId = (kind === "about" ? user?.aboutVersionId : user?.focusVersionId) ?? null;

  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);

  // Resync the draft when the underlying statement changes (e.g.
  // restored from history elsewhere). Only when not actively dictating
  // — overwriting a live transcript would be jarring.
  useEffect(() => {
    if (!dictating) setDraft(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const trimmedDraft = draft.trim();
  const isDirty = trimmedDraft.length > 0 && trimmedDraft !== initial.trim();
  const canSave = isDirty && !saving;

  const handleSave = async () => {
    if (!trimmedDraft) {
      setError(`${copy.title} cannot be empty.`);
      return;
    }
    if (!isDirty) {
      setError("No changes to save.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // No `note` field on the wire — the history view already
      // surfaces the textual diff between consecutive versions,
      // which is what users actually scan history for.
      await apiPost(copy.endpoint, { statement: trimmedDraft });
      setFlash(true);
      setTimeout(() => setFlash(false), 1500);
      onUserChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PanelHeader title={copy.title} description={copy.description} />

      <Card>
        <div className="relative">
          <textarea
            value={dictating && interim ? `${draft}${draft ? " " : ""}${interim}` : draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={dictating ? "Listening — speak freely…" : copy.placeholder}
            readOnly={dictating}
            // Sized to take advantage of the now-fixed-height
            // Settings modal (`min(85vh, 760px)`). About / Focus
            // statements are typically 1500–4000 chars (the
            // 4000-char cap is the hard limit) — the previous
            // 5-row / 100 px textarea forced heavy scrolling
            // even on the 4-paragraph baseline statements most
            // users actually write.
            //
            // Why both `style` AND `className`: an earlier round
            // used only the Tailwind class `min-h-[360px]`, which
            // built into CSS correctly but was reported as not
            // taking effect in production (likely a CSS bundle
            // cache miss; possibly a browser-specific
            // textarea-rows-override quirk). The inline
            // `minHeight: 360px` guarantees the height regardless
            // of cache, specificity, or user-agent quirks. Belt
            // and suspenders.
            className={`w-full bg-surface border rounded-md p-2 pr-10 text-xs font-mono text-text-primary outline-none transition-colors resize-y ${
              dictating ? "border-accent ring-2 ring-accent/20 cursor-default" : "border-border focus:border-accent"
            }`}
            style={{ minHeight: "360px" }}
            rows={14}
            maxLength={4000}
            disabled={saving}
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
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setRefineOpen(true)}
            disabled={saving || draft.trim().length < 10}
            className="shrink-0 px-2 py-1 rounded-md border border-border text-[11px] font-mono text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
            title="Use AI to refine your draft into a tighter, prompt-ready paragraph"
          >
            ✨ Refine with AI
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            title={!isDirty ? "No changes to save" : undefined}
            className="shrink-0 px-3 py-1 rounded-md bg-accent text-white text-[11px] font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving…" : flash ? "Saved ✓" : "Save as new version"}
          </button>
        </div>

        {error && <div className="mt-2 text-[10px] font-mono text-negative">{error}</div>}

        <div className="mt-3 flex items-center justify-between text-[10px] font-mono text-text-dim">
          <span>{draft.length} / 4000 chars</span>
          <button type="button" onClick={() => setHistoryOpen(true)} className="text-accent hover:underline">
            View history →
          </button>
        </div>
      </Card>

      {historyOpen && (
        <StatementHistoryModal
          kind={kind}
          currentVersionId={versionId}
          onClose={() => setHistoryOpen(false)}
          onChanged={onUserChanged}
        />
      )}

      {refineOpen && (
        <RefineDialog
          kind={kind}
          draft={draft}
          onCancel={() => setRefineOpen(false)}
          onAccept={(refined) => {
            setDraft(refined);
            setRefineOpen(false);
          }}
        />
      )}
    </div>
  );
}
