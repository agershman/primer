import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AdminOnly, useCurrentUserContext } from "../hooks/useCurrentUser";
import { onPrimerEvent } from "../lib/events";
import type { AuditTrail, PieceSeriesPart, PieceSeriesResponse, SourceDescriptor, TeachingPieceData } from "../types";
import { apiGet, apiPost } from "../utils/api";
import { contentBlocksToSpokenText, estimateTtsDurationSeconds } from "../utils/audioEstimate";
import { cleanSlackText } from "../utils/text";
import { AudioPlayer } from "./AudioPlayer";
import { AuditIndicator } from "./AuditIndicator";
import { AuditPopover } from "./AuditPopover";
import { AuditTrailPanel } from "./AuditTrailPanel";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { DepthIndicator } from "./DepthIndicator";
import { FeedbackButtons } from "./FeedbackButtons";
import { ResourceList } from "./ResourceList";
import type { AuditHighlightRange } from "./RichText";
import { RichText } from "./RichText";
import { VoiceSwitcher } from "./VoiceSwitcher";

const SOURCE_TYPE_BADGES: Record<string, { label: string; color: string }> = {
  "current-work": { label: "From your work", color: "bg-positive-dim text-positive" },
  adjacent: { label: "From feeds", color: "bg-warning-dim text-warning" },
  "decay-recalibrate": { label: "Refresher", color: "bg-bg-warm text-text-dim" },
};

const SOURCE_ITEM_LABELS: Record<string, string> = {
  linear_issue: "Linear",
  slack_thread: "Slack",
  incident: "incident.io",
  github_pr: "GitHub PR",
  github_issue: "GitHub Issue",
  hn: "Hacker News",
  arxiv: "ArXiv",
  cncf: "CNCF",
  aws_changelog: "AWS",
  gcp_changelog: "GCP",
  rss: "RSS",
  decay: "Concept refresh",
};

interface AvailableModel {
  id: string;
  label: string;
  tier: string;
}

interface TeachingPieceProps {
  piece: TeachingPieceData;
  briefingDate: string;
  onFeedback: (pieceId: string, feedback: "positive" | "negative") => void;
  onRegenerated?: (pieceId: string, updated: Partial<TeachingPieceData>) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (pieceId: string) => void;
  bookmarkedBlock?: number | null;
  onBookmarkBlock?: (pieceId: string, blockIndex: number) => void;
  /**
   * True when there's an in-progress `deep_dive` notification
   * targeting this piece — i.e. someone (this user, in this tab or
   * another) clicked "Go deeper" recently and generation is
   * actively running server-side. Drives the inline spinner +
   * pulse on the "Go deeper" button. The button stays clickable
   * while generating; clicking jumps to the deep-dive view which
   * has the full progress UI. Derived in BriefingPage from
   * `useNotifications`.
   */
  isDeepDiveGenerating?: boolean;
}

export function TeachingPiece({
  piece,
  briefingDate,
  onFeedback,
  onRegenerated,
  isBookmarked = false,
  onToggleBookmark,
  bookmarkedBlock,
  onBookmarkBlock,
  isDeepDiveGenerating = false,
}: TeachingPieceProps) {
  const [whyExpanded, setWhyExpanded] = useState(false);
  // Voice override drives the audio URL. null = use the worker-side user-default fallback.
  // Sync to the typed `tts-voice-changed` bus for picks made on another teaching piece,
  // the Settings panel's teaching-piece row, or a global default change. Filter on
  // `surface` so a chat-surface or deep-dive pick doesn't bleed into this piece's audio.
  const [voiceId, setVoiceId] = useState<string | null>(null);
  useEffect(
    () =>
      onPrimerEvent("tts-voice-changed", (detail) => {
        if (!detail.voiceId) return;
        if (detail.surface && detail.surface !== "teachingPiece") return;
        setVoiceId(detail.voiceId);
      }),
    [],
  );

  // Series state. Lazy-fetched only for pieces actually in a series
  // (series_id is set), to avoid a per-piece round trip for the
  // standalone-only common case. The endpoint also tolerates
  // standalone pieces and returns an empty parts array, but skipping
  // the call entirely is cheaper.
  const isInSeries = !!piece.series_id;
  const [seriesParts, setSeriesParts] = useState<PieceSeriesPart[] | null>(null);
  useEffect(() => {
    if (!isInSeries) {
      setSeriesParts(null);
      return;
    }
    let cancelled = false;
    apiGet<PieceSeriesResponse>(`/api/piece/${piece.id}/series`)
      .then((data) => {
        if (cancelled) return;
        setSeriesParts(data.parts ?? []);
      })
      .catch(() => {
        if (!cancelled) setSeriesParts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [piece.id, isInSeries]);

  const badge = SOURCE_TYPE_BADGES[piece.source_type] ?? SOURCE_TYPE_BADGES["current-work"];
  const sources = piece.source_context ?? [];

  // ── Audit surface state ──
  // Inline marks visibility seeds from the user's
  // `settings.showAuditMarks` (default-false). The per-piece toggle
  // from the AuditIndicator dropdown overrides this via the typed
  // event bus without persisting — so flipping marks on for one
  // piece doesn't change the global default.
  const currentUser = useCurrentUserContext();
  const [marksVisible, setMarksVisible] = useState<boolean>(() => currentUser?.settings?.showAuditMarks ?? false);
  useEffect(
    () =>
      onPrimerEvent("audit-marks-visibility-changed", (detail) => {
        if (detail.targetKind !== "piece" || detail.targetId !== piece.id) return;
        setMarksVisible(detail.visible);
      }),
    [piece.id],
  );

  // Lazy-loaded full audit trail. Populated when the panel opens OR
  // when a wavy underline is clicked; cached in component state so
  // both surfaces share one fetch.
  const [auditTrail, setAuditTrail] = useState<AuditTrail | null>(null);
  const [auditPanelOpen, setAuditPanelOpen] = useState(false);
  useEffect(() => {
    if (!marksVisible || auditTrail) return;
    if (!piece.audit_summary) return;
    let cancelled = false;
    apiGet<AuditTrail>(`/api/piece/${piece.id}/audit`)
      .then((data) => {
        if (!cancelled) setAuditTrail(data);
      })
      .catch(() => {
        /* keep marks hidden if the trail fetch fails — the indicator pill stays informative */
      });
    return () => {
      cancelled = true;
    };
  }, [marksVisible, auditTrail, piece.id, piece.audit_summary]);

  // Translate the trail into per-block highlight ranges for RichText.
  const highlightedRanges = useMemo(() => {
    if (!marksVisible || !auditTrail) return null;
    const out: Record<number, AuditHighlightRange[]> = {};
    // Use the LATEST pass per claim so post-patch verdicts win. The
    // panel UI keeps both passes for the audit trail view; the
    // inline marks should reflect the final state.
    const lastPass = auditTrail.passes[auditTrail.passes.length - 1];
    if (!lastPass) return null;
    for (const claim of lastPass.claims) {
      if (claim.verdict === "grounded") continue; // no mark for clean spans
      if (claim.resolution === "dropped") continue; // dropped spans are no longer in the rendered text
      const list = out[claim.block_index] ?? [];
      list.push({
        start: claim.span_start,
        end: claim.span_end,
        verdict: claim.verdict,
        claimId: claim.id,
        patched: claim.resolution === "patched",
      });
      out[claim.block_index] = list;
    }
    return out;
  }, [auditTrail, marksVisible]);

  return (
    <article id={`piece-${piece.id}`} className="py-6 first:pt-0 scroll-mt-24">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-mono font-medium ${badge.color}`}
        >
          {badge.label}
        </span>
        <span className="text-text-faint">·</span>
        <span className="font-ui text-[10px] text-text-faint">{piece.read_time_minutes} min read</span>
        {piece.created_at && (
          <>
            <span className="text-text-faint">·</span>
            <span className="font-ui text-[10px] text-text-faint">{formatPieceTime(piece.created_at)}</span>
          </>
        )}
        {onToggleBookmark && (
          <>
            <span className="text-text-faint">·</span>
            <button
              onClick={() => onToggleBookmark(piece.id)}
              className={`font-ui text-[10px] transition-colors ${
                isBookmarked ? "text-accent" : "text-text-faint hover:text-accent"
              }`}
              title={isBookmarked ? "Remove bookmark" : "Bookmark this piece"}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill={isBookmarked ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.2"
              >
                <path d="M3 1h6a1 1 0 011 1v9l-4-2.5L2 11V2a1 1 0 011-1z" />
              </svg>
            </button>
          </>
        )}
        {/* Audit indicator — rolls up the pass-1 audit verdict
            into a small pill. Clicking opens a dropdown with the
            "Show audit marks" toggle + "View full audit trail"
            entry. Renders nothing when the piece pre-dates the
            audit feature (audit_summary is undefined). */}
        {piece.audit_summary && (
          <>
            <span className="text-text-faint">·</span>
            <AuditIndicator
              audit={piece.audit_summary}
              targetKind="piece"
              targetId={piece.id}
              marksVisible={marksVisible}
              onOpenPanel={() => setAuditPanelOpen(true)}
            />
          </>
        )}
        {/* Due-date pill — surfaces time-pressure at a glance. The
            color tier maps to urgency: negative for overdue/today,
            warning for this-week, calm-accent for further out. The
            tooltip shows the underlying rationale (e.g. "Linear
            ticket CIN-1234 is due 2026-04-30") so the user can
            verify *why* the system thinks the piece is time-sensitive
            and not just take the badge on faith. */}
        {piece.due_at && (
          <>
            <span className="text-text-faint">·</span>
            <DueBadge dueAt={piece.due_at} dueReason={piece.due_reason ?? null} />
          </>
        )}
      </div>

      <h2 className="font-display text-xl font-medium text-text-primary mb-2 leading-snug">
        {piece.title}
        {isInSeries && piece.part_number && (
          <SeriesBadge partNumber={piece.part_number} total={seriesParts?.length ?? null} />
        )}
        {/* One-time "new continuation" pill on Part-2+ pieces in
            today's briefing. Heuristic: piece is part of a series,
            partNumber >= 2, AND the briefing the user is looking at
            matches today's date. The pill stops rendering once the
            briefing rolls forward — so the next morning the same
            piece (now in "yesterday's briefing") shows just the
            normal series badge. */}
        {isInSeries && piece.part_number && piece.part_number >= 2 && isTodaysBriefing(briefingDate) && (
          <NewContinuationPill />
        )}
      </h2>

      {isInSeries && (
        <SeriesStrip currentPieceId={piece.id} partNumber={piece.part_number ?? null} parts={seriesParts} />
      )}

      {piece.why_chosen && (
        <button
          onClick={() => setWhyExpanded(!whyExpanded)}
          className="font-ui text-xs text-text-faint hover:text-text-dim transition-colors mb-3 min-h-[44px] flex items-center"
        >
          {whyExpanded ? "▾" : "▸"} Why this piece?
        </button>
      )}
      {whyExpanded && piece.why_chosen && (
        <div className="border-l-2 border-accent pl-3 mb-4">
          <p className="font-ui text-xs text-text-dim leading-relaxed">{piece.why_chosen}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AudioPlayer
          src={`/api/piece/${piece.id}/audio`}
          voiceId={voiceId}
          compact
          // Seed the duration estimate from the piece's content
          // length so the progress bar fills proportionally to real
          // elapsed time even when the worker streams at close to
          // playback rate. The title prefix + outro the worker adds
          // server-side aren't included in this estimate, but the
          // chars-per-second rate constant has enough headroom that
          // this nets out as a slight overestimate (graceful — the
          // bar snaps to 100% via `durationchange` at end).
          estimatedDurationSeconds={estimateTtsDurationSeconds(
            `${piece.title}\n\n${contentBlocksToSpokenText(piece.content)}`,
          )}
        />
        {/* Voice switcher is admin-only — picking a voice updates the
            per-surface default in `signalSurfaceMap.models.ttsModelTeachingPiece`,
            which is a deployment-wide setting. Non-admins listen with
            whatever the admin picked. */}
        <AdminOnly>
          <VoiceSwitcher currentVoiceId={voiceId} onChange={setVoiceId} surface="teachingPiece" />
        </AdminOnly>
      </div>

      {sources.length > 0 && <SourceProvenance sources={sources} sourceType={piece.source_type} />}

      <div className="mb-4">
        <RichText
          blocks={piece.content}
          bookmarkedBlock={bookmarkedBlock}
          onBookmarkBlock={onBookmarkBlock ? (blockIdx) => onBookmarkBlock(piece.id, blockIdx) : undefined}
          highlightedRanges={highlightedRanges}
          auditTarget={{ kind: "piece", id: piece.id }}
        />
      </div>

      {/* Floating popover for clicked audit marks + opt-in full
          trail modal. Both share the lazily-fetched `auditTrail`. */}
      <AuditPopover targetKind="piece" targetId={piece.id} trail={auditTrail} sources={sources} />
      <AuditTrailPanel
        open={auditPanelOpen}
        onClose={() => setAuditPanelOpen(false)}
        targetKind="piece"
        targetId={piece.id}
        preloadedTrail={auditTrail}
        sources={sources}
        onTrailLoaded={(t) => setAuditTrail(t)}
      />

      {piece.resources.length > 0 && (
        <div className="mb-4">
          <ResourceList resources={piece.resources} />
        </div>
      )}

      {piece.concepts.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          {piece.concepts.map((concept, i) => (
            // Defensive key — older pieces can carry empty/duplicate
            // concept ids when the briefing pipeline lost a match
            // (e.g. adjacent-source candidates with no graph hit fall
            // through with conceptId=""). The index suffix tiebreaks.
            <div key={`${concept.id || "concept"}-${i}`} className="flex items-center gap-2">
              <span className="font-ui text-xs text-text-secondary">{concept.name}</span>
              <DepthIndicator depth={concept.depth} />
              <ConfidenceBadge confidence={concept.confidence} />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <FeedbackButtons pieceId={piece.id} feedback={piece.feedback} onFeedback={onFeedback} />
        <Link
          to={`/briefing/${briefingDate}/${piece.id}`}
          // The link stays clickable while generating — clicking
          // jumps to the deep-dive view which has the full
          // progress UI. The visual cue is two parts:
          //   1. A subtle accent-tinted ring with `animate-pulse`
          //      around the button itself, so the in-flight state
          //      reads as "this control is doing something" without
          //      requiring the user to look at the spinner.
          //   2. A small inline ring spinner next to the label so
          //      the affordance is unambiguous on a quick scan.
          className={`min-h-[44px] inline-flex items-center rounded-md bg-accent-dim px-3 py-2 font-ui text-xs font-medium text-accent hover:bg-accent/20 transition-colors no-underline ${
            isDeepDiveGenerating ? "ring-1 ring-accent/40 animate-pulse" : ""
          }`}
          aria-busy={isDeepDiveGenerating || undefined}
          title={
            isDeepDiveGenerating
              ? "Deep dive is being generated — open the deep-dive view to track progress"
              : undefined
          }
        >
          Go deeper
          {isDeepDiveGenerating && (
            <span
              className="ml-1.5 inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin"
              aria-label="Generating"
            />
          )}
          {!isDeepDiveGenerating && piece.deep_dive_read_time ? (
            <span className="ml-1.5 text-text-faint">· {piece.deep_dive_read_time} min</span>
          ) : null}
        </Link>
      </div>

      <ModelFooter pieceId={piece.id} modelUsed={piece.model_used} onRegenerated={onRegenerated} />
    </article>
  );
}

function ModelFooter({
  pieceId,
  modelUsed,
  onRegenerated,
}: {
  pieceId: string;
  modelUsed?: string;
  onRegenerated?: (pieceId: string, updated: Partial<TeachingPieceData>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && models.length === 0) {
      apiGet<{ models: AvailableModel[] }>("/api/models")
        .then((data) => {
          setModels(data.models);
          const other = data.models.find((m) => m.id !== modelUsed);
          if (other) setSelectedModel(other.id);
        })
        .catch(() => {});
    }
  }, [expanded, models.length, modelUsed]);

  // Esc closes the inline picker. Capture phase so this handler
  // runs BEFORE any outer surface's Esc handler (e.g. the chat
  // panel's "Esc closes the panel" listener); `stopPropagation`
  // then prevents the outer handler from firing. Without this,
  // pressing Esc to dismiss the model picker inside chat would
  // accidentally close the entire chat panel.
  //
  // We don't fire when `regenerating` is in flight — partly because
  // the cancel link is still visible in that state and consistency
  // with click-cancel matters, but also because dismissing mid-
  // regenerate is the less-surprising behavior (the request keeps
  // running; the user just wanted the picker out of the way).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [expanded]);

  const handleRegenerate = useCallback(async () => {
    if (!selectedModel || regenerating) return;
    setRegenerating(true);
    setError(null);
    try {
      const data = await apiPost<{
        piece: {
          id: string;
          title: string;
          piece_type: string;
          content: unknown[];
          read_time_minutes: number;
          model_used: string;
          resources: unknown[];
        };
      }>(`/api/piece/${pieceId}/regenerate`, { model: selectedModel });
      setExpanded(false);
      onRegenerated?.(pieceId, {
        title: data.piece.title,
        piece_type: data.piece.piece_type,
        content: data.piece.content as TeachingPieceData["content"],
        read_time_minutes: data.piece.read_time_minutes,
        model_used: data.piece.model_used,
        resources: data.piece.resources as TeachingPieceData["resources"],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  }, [pieceId, selectedModel, regenerating, onRegenerated]);

  if (!modelUsed) return null;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-text-faint">Generated with {modelLabel(modelUsed)}</span>
        {/* Regeneration is admin-only — picking a different model is
            a deployment-wide concern (cost / quality), so non-admins
            see only the attribution. The server route also rejects
            non-admin POSTs to /api/piece/:id/regenerate. */}
        <AdminOnly>
          <button
            onClick={() => setExpanded(!expanded)}
            className="font-mono text-[10px] text-text-dim hover:text-accent transition-colors"
          >
            {expanded ? "cancel" : "↻ try different model"}
          </button>
        </AdminOnly>
      </div>

      {expanded && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={regenerating}
            className="bg-surface border border-border rounded-md px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors disabled:opacity-50"
          >
            {models.length === 0 ? (
              <option value="">Loading…</option>
            ) : (
              models
                .filter((m) => m.id !== modelUsed)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.tier})
                  </option>
                ))
            )}
          </select>
          <button
            onClick={handleRegenerate}
            disabled={regenerating || !selectedModel}
            className="px-2.5 py-1 rounded-md bg-accent text-white border border-accent text-xs font-mono font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
          {error && <span className="font-mono text-[10px] text-negative">{error}</span>}
        </div>
      )}
    </div>
  );
}

function formatPieceTime(ts: string): string {
  try {
    const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function modelLabel(id: string): string {
  if (id.includes("haiku")) return "Claude Haiku 4.5";
  if (id.includes("sonnet")) return "Claude Sonnet 4";
  if (id.includes("opus")) return "Claude Opus 4";
  return id;
}

/**
 * Small pill that summarizes a piece's deadline at a glance.
 *
 * Color tier maps to urgency, calibrated to what would make a sensible
 * person stop scrolling and read this piece:
 *
 *   • **overdue / today** — `text-negative bg-negative-dim`. The
 *     piece is at-or-past deadline; treat it as actionable now.
 *   • **tomorrow / within 3 days** — `text-warning bg-warning-dim`.
 *     Time-pressured but not on fire; read it before the day ends.
 *   • **this week (4–7 days)** — `text-accent bg-accent-dim`. On the
 *     horizon; the briefing should help you prep.
 *   • **further out** — `text-text-secondary bg-bg-warm`. Calm; the
 *     pill exists so you can see the eventual deadline without it
 *     screaming for attention.
 *
 * The label uses relative time wording when the deadline is close
 * ("Due today", "Due tomorrow", "Due in 3 days"), and falls back to a
 * formatted date for further-out deadlines ("Due Apr 30") so the
 * pill stays compact without losing information.
 */
function DueBadge({ dueAt, dueReason }: { dueAt: string; dueReason: string | null }) {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;

  // Compute days-until-due in *calendar days*, not 24-hour windows.
  // We want "Due tomorrow" to mean "the next calendar day" regardless
  // of time-of-day, otherwise a piece that came in at 9am with a
  // deadline of midnight tonight would read as "Due in 14 hours" when
  // any normal user would call that "Due today".
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dueMidnight = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const daysUntil = Math.round((dueMidnight - todayMidnight) / (1000 * 60 * 60 * 24));

  let label: string;
  let tier: "overdue" | "today" | "soon" | "this-week" | "later";
  if (daysUntil < 0) {
    label = `Overdue · was due ${formatDueDate(due)}`;
    tier = "overdue";
  } else if (daysUntil === 0) {
    label = "Due today";
    tier = "today";
  } else if (daysUntil === 1) {
    label = "Due tomorrow";
    tier = "soon";
  } else if (daysUntil <= 3) {
    label = `Due in ${daysUntil} days`;
    tier = "soon";
  } else if (daysUntil <= 7) {
    label = `Due in ${daysUntil} days`;
    tier = "this-week";
  } else {
    label = `Due ${formatDueDate(due)}`;
    tier = "later";
  }

  // Tier → color mapping. Kept in a switch (vs. a Record) so a
  // future contributor can't accidentally reuse the same color for
  // two different urgency levels, which would defeat the
  // at-a-glance signal.
  let className: string;
  switch (tier) {
    case "overdue":
    case "today":
      className = "text-negative bg-negative-dim";
      break;
    case "soon":
      className = "text-warning bg-warning-dim";
      break;
    case "this-week":
      className = "text-accent bg-accent-dim";
      break;
    case "later":
      className = "text-text-secondary bg-bg-warm";
      break;
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-mono font-medium ${className}`}
      title={dueReason ?? `Due ${formatDueDate(due)}`}
    >
      {label}
    </span>
  );
}

function formatDueDate(d: Date): string {
  // Compact form: "Apr 30" if same year, "Apr 30, 2027" otherwise.
  // Briefings are weekly-cadence so most due dates are within a
  // couple months — the year is rarely needed.
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Visual icons + short labels for the per-piece source-type summary
 * row. Mirrors the icons / shortcuts used by `WorkContextBar` on the
 * briefing header so a reader who's already learned what `◆` means
 * up there reads it the same way down here.
 */
const SOURCE_GROUP_ICONS: Record<string, string> = {
  linear_issue: "◆",
  linear: "◆",
  slack_thread: "◈",
  slack: "◈",
  incident: "▹",
  github_pr: "◇",
  github: "◇",
  adjacent: "▤",
  rss: "▤",
  hn: "▤",
  arxiv: "▤",
  decay: "↻",
};

const SOURCE_GROUP_LABELS: Record<string, string> = {
  linear_issue: "Linear",
  linear: "Linear",
  slack_thread: "Slack",
  slack: "Slack",
  incident: "Incidents",
  github_pr: "GitHub",
  github: "GitHub",
  adjacent: "Feed",
  rss: "RSS",
  hn: "HN",
  arxiv: "ArXiv",
  decay: "Refresher",
};

/**
 * Per-piece source attribution.
 *
 * Mirrors the briefing-level `WorkContextBar` collapse pattern:
 *
 *   - Default state: a single subtle line showing icon + count per
 *     source type (`Triggered by · ◆ 3 Linear · ◈ 2 Slack · details`)
 *     so the reader sees WHICH inputs fed the piece without the full
 *     list cluttering the article surface.
 *   - Expanded: the existing per-source detail list (label badge,
 *     title, link, optional summary) below the summary row.
 *
 * Pre-fix this component rendered as a bordered box always-expanded
 * directly above the content — useful but visually heavy for every
 * piece in a 5-piece briefing. Now matches the lightweight treatment
 * the briefing header uses.
 */
function SourceProvenance({ sources, sourceType }: { sources: SourceDescriptor[]; sourceType: string }) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) return null;

  const preposition =
    sourceType === "adjacent" ? "Based on" : sourceType === "decay-recalibrate" ? "Refreshing" : "Triggered by";

  // Group by source type so the collapsed line reads as a tight
  // "from these kinds of inputs" summary, with the per-item detail
  // available behind the toggle. We preserve `items` so the
  // expanded view can keep using the existing per-source layout.
  const grouped = new Map<string, { count: number; icon: string; label: string }>();
  for (const s of sources) {
    const key = s.type;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        count: 1,
        icon: SOURCE_GROUP_ICONS[key] ?? "○",
        label: SOURCE_GROUP_LABELS[key] ?? key.replace(/_/g, " "),
      });
    }
  }
  const groups = Array.from(grouped.values());

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] text-text-faint uppercase tracking-wider">{preposition}</span>
        {groups.map((g, i) => (
          <span key={i} className="inline-flex items-center gap-1 font-mono text-xs text-text-dim">
            <span className="text-text-faint">{g.icon}</span>
            <span className="tabular-nums text-text-primary">{g.count}</span>
            {g.label}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="font-mono text-[10px] text-text-faint hover:text-text-dim transition-colors"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide source details" : "Show source details"}
        >
          {expanded ? "hide" : "details"}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 rounded-md bg-bg-warm border border-border-subtle px-3 py-2 space-y-1">
          {sources.map((src, i) => (
            <SourceItem key={i} source={src} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Returns true when the briefing date passed in matches the user's
 * local "today" date. We compare on the YYYY-MM-DD shape because
 * briefing_date is stored as a date string (not a timestamp) and the
 * user always thinks of "today's briefing" in their local calendar.
 */
function isTodaysBriefing(briefingDate: string): boolean {
  if (!briefingDate) return false;
  // User's local YYYY-MM-DD. `toISOString()` returns the UTC date,
  // which rolls a day earlier in negative-offset timezones — at 9 PM
  // Sunday in UTC-4 the UTC date is already Monday, so a Sunday
  // briefing wouldn't be considered "today" with a UTC compare.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return briefingDate === today;
}

/**
 * Tiny "new" badge that fires once on Part-2+ pieces in today's
 * briefing. The user has likely read the predecessor part as a
 * standalone — this is the heads-up that the topic now has a
 * continuation. Subtle on purpose: alongside the Part-N badge, two
 * pills compete for attention; the "new" one is meant to read as a
 * one-time accent, not a sticker.
 */
function NewContinuationPill() {
  return (
    <span
      role="status"
      className="ml-1 inline-flex items-center align-middle rounded-full bg-positive-dim px-2 py-0.5 font-mono text-[10px] font-medium text-positive"
      aria-label="New continuation"
      title="A continuation in this series was published today"
    >
      new
    </span>
  );
}

/**
 * Compact "Part N of M" pill rendered next to a series piece's title.
 * Total `M` is the number of currently-published parts in the series.
 * Until the lazy fetch resolves we render "Part N" without the total
 * to avoid jankily flipping from "Part 1" to "Part 1 of 2" on mount.
 */
function SeriesBadge({ partNumber, total }: { partNumber: number; total: number | null }) {
  const label = total && total > 0 ? `Part ${partNumber} of ${total}` : `Part ${partNumber}`;
  return (
    <span
      role="note"
      className="ml-2 inline-flex items-center align-middle rounded-full bg-accent-dim px-2 py-0.5 font-mono text-[10px] font-medium text-accent"
      aria-label={`Series: ${label}`}
    >
      {label}
    </span>
  );
}

/**
 * Series-navigation strip rendered above the body for any piece that
 * sits in a multi-part series. Shows up to two adjacent siblings as
 * inline links — previous part on the left, next part on the right —
 * so readers can navigate the series without bouncing through the
 * archive.
 *
 * On Part 1 specifically, the next-part link gets the more prominent
 * "A continuation was published" treatment because the user has likely
 * already read Part 1 standalone (the series only formed once Part 2
 * landed). For Part 2+, both directions are styled as subtle inline
 * links — equivalent prev/next nav inside an article series.
 *
 * Renders nothing while parts are still loading (the strip would
 * otherwise pop in mid-scroll), and nothing when the series turned
 * out to have only one part (defensive — should not happen in
 * practice once the classifier has run).
 */
function SeriesStrip({
  currentPieceId,
  partNumber,
  parts,
}: {
  currentPieceId: string;
  partNumber: number | null;
  parts: PieceSeriesPart[] | null;
}) {
  if (!parts || parts.length <= 1) return null;
  const currentIdx = parts.findIndex((p) => p.id === currentPieceId);
  if (currentIdx === -1) return null;

  const previous = currentIdx > 0 ? parts[currentIdx - 1] : null;
  const next = currentIdx < parts.length - 1 ? parts[currentIdx + 1] : null;

  // Anchor target for jumping to a specific piece on its briefing
  // date. The briefing pages already react to URL hashes (used by
  // bookmarks), so we reuse that same scroll machinery here.
  const linkFor = (part: PieceSeriesPart) => `/briefing/${part.briefing_date}#piece-${part.id}`;

  // The forward callback on Part 1 is structurally important: when
  // Part 2 landed, Part 1's badge appeared *retroactively*. The user
  // has already consumed Part 1 (probably as a standalone) and now
  // there's a continuation. The prominent banner makes that obvious.
  const isPart1WithContinuation = partNumber === 1 && next !== null;

  return (
    <nav className="mb-3 flex flex-col gap-2" aria-label="Series navigation">
      {isPart1WithContinuation && next && (
        <Link
          to={linkFor(next)}
          className="block rounded-md border border-accent/30 bg-accent-dim px-3 py-2 no-underline hover:bg-accent/20 transition-colors"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
            A continuation was published
          </span>
          <span className="block font-ui text-xs text-text-primary mt-0.5 leading-snug">
            Part {next.part_number}: {next.title}
            <span className="text-text-faint"> · {formatSeriesDate(next.briefing_date)}</span>
          </span>
        </Link>
      )}
      {(previous || (next && !isPart1WithContinuation)) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-ui text-[11px] text-text-dim">
          {/* Subtle "previously / next" links — magazine-style series
              navigation. Reads as inline links, not chrome buttons. */}
          {previous && (
            <Link
              to={linkFor(previous)}
              className="text-link hover:text-link-hover no-underline hover:underline"
              aria-label={`Previous part: ${previous.title}`}
            >
              ← Part {previous.part_number}: {previous.title}
              <span className="text-text-faint"> · {formatSeriesDate(previous.briefing_date)}</span>
            </Link>
          )}
          {next && !isPart1WithContinuation && (
            <Link
              to={linkFor(next)}
              className="text-link hover:text-link-hover no-underline hover:underline ml-auto"
              aria-label={`Next part: ${next.title}`}
            >
              Part {next.part_number}: {next.title}
              <span className="text-text-faint"> · {formatSeriesDate(next.briefing_date)}</span> →
            </Link>
          )}
        </div>
      )}
    </nav>
  );
}

function formatSeriesDate(iso: string): string {
  // Briefing dates are stored as YYYY-MM-DD strings. Render them as
  // "Apr 12" — short and unambiguous next to the part title. Year is
  // omitted because the look-back window is bounded at 30 days.
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function SourceItem({ source }: { source: SourceDescriptor }) {
  const label = SOURCE_ITEM_LABELS[source.type] ?? source.type;
  const hasLink = !!source.url;
  // Slack message text leaks through with mrkdwn syntax (<https://...>,
  // <@U…>, <#C…|name>, &amp;) when ingested before normalization landed.
  // Cleaning at render time keeps already-stored briefings looking right
  // without forcing a regeneration.
  const displayTitle = source.title ? cleanSlackText(source.title) : null;
  const displaySummary = source.summary ? cleanSlackText(source.summary) : null;

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 rounded bg-surface border border-border-subtle px-1.5 py-0.5 font-mono text-[11px] leading-tight text-text-dim">
        {label}
      </span>
      <div className="min-w-0 flex-1">
        {hasLink ? (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-ui text-xs leading-tight text-link hover:text-link-hover no-underline hover:underline truncate block"
          >
            {displayTitle ?? source.url}
          </a>
        ) : (
          <span className="font-ui text-xs leading-tight text-text-primary truncate block">
            {displayTitle ?? source.id ?? "Unknown"}
          </span>
        )}
        {displaySummary && <span className="font-ui text-[10px] text-text-faint truncate block">{displaySummary}</span>}
      </div>
    </div>
  );
}
