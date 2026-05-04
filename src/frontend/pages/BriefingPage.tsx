import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CalibrationQuiz } from "../components/CalibrationQuiz";
import { FeedbackToast } from "../components/FeedbackToast";
import { NearMisses } from "../components/NearMisses";
import { PastBriefingsTimeline } from "../components/PastBriefingsTimeline";
import { RedundantDraftsChip } from "../components/RedundantDraftsChip";
import { TeachingPiece } from "../components/TeachingPiece";
import { WeeklyStats } from "../components/WeeklyStats";
import { WorkContextBar } from "../components/WorkContextBar";
import { useBookmarks } from "../hooks/useBookmarks";
import { useBriefing } from "../hooks/useBriefing";
import { useNotifications } from "../hooks/useNotifications";
import type { FeedbackDelta, TeachingPieceData } from "../types";
import { DeepDiveView } from "./DeepDiveView";

export function BriefingPage() {
  const { date, id: deepDiveId } = useParams();
  const {
    briefing,
    pieces,
    quiz,
    loading,
    error,
    generating,
    cancelling,
    generationStatus,
    generate,
    cancel,
    forceReset,
    submitFeedback,
  } = useBriefing(date);
  const [toastDeltas, setToastDeltas] = useState<FeedbackDelta[]>([]);
  const { bookmarks, loadBookmarks, toggleSaved, isSaved, saveBookmark, mostRecentInProgress } = useBookmarks();
  const [blockBookmarks, setBlockBookmarks] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  useEffect(() => {
    const map = new Map<string, number>();
    for (const b of bookmarks) {
      if (b.scrollPosition > 0) {
        const blockIdx = Math.round(b.scrollPosition);
        if (blockIdx > 0) map.set(b.pieceId, blockIdx);
      }
    }
    setBlockBookmarks(map);
  }, [bookmarks]);

  // Scroll to a `#piece-<id>` hash once pieces have rendered. Used by
  // the series-navigation strip ("Part 2" link from a sibling) and
  // potentially by future deep-link surfaces. We re-run on `pieces`
  // changing because the briefing payload arrives async — the hash
  // is set before the article DOM exists, so a naïve "on mount"
  // attempt would silently no-op.
  useEffect(() => {
    if (pieces.length === 0) return;
    if (!window.location.hash) return;
    const id = window.location.hash.slice(1);
    const el = document.getElementById(id);
    if (!el) return;
    // A frame tick after layout so `scroll-mt-24` (anchor offset) is
    // already applied by Tailwind.
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [pieces]);

  const handleBookmarkBlock = useCallback(
    async (pieceId: string, blockIndex: number) => {
      const existing = blockBookmarks.get(pieceId);
      if (existing === blockIndex) {
        setBlockBookmarks((prev) => {
          const next = new Map(prev);
          next.delete(pieceId);
          return next;
        });
        await saveBookmark(pieceId, { type: "reading", scrollPosition: 0 });
      } else {
        setBlockBookmarks((prev) => new Map(prev).set(pieceId, blockIndex));
        await saveBookmark(pieceId, { type: "saved", scrollPosition: blockIndex });
      }
    },
    [blockBookmarks, saveBookmark],
  );
  const patchesRef = useRef<Map<string, Partial<TeachingPieceData>>>(new Map());
  const [patchCounter, setPatchCounter] = useState(0);

  // Subscribe to the notification stream so the briefing page can
  // surface an in-flight indicator on the per-piece "Go deeper"
  // button. The bell icon already polls these; we read off the same
  // hook results to derive a `Set<pieceId>` of pieces whose deep dive
  // is currently being generated. The poll cadence inside
  // useNotifications is already 4s when anything is in_progress and
  // 30s otherwise, so this adds no new HTTP traffic.
  //
  // The notification's `payload.pieceId` is set by the deep-dive
  // route at creation time (`createNotification(..., payload: { pieceId, ... })`),
  // so matching is exact. Status === "in_progress" is the
  // canonical "currently generating" signal — the bell flips it to
  // "ready" / "failed" once generation finishes, at which point the
  // matching piece drops out of the set and its spinner disappears.
  const { notifications: appNotifications } = useNotifications();
  const generatingDeepDiveIds = useMemo(() => {
    const set = new Set<string>();
    for (const n of appNotifications) {
      if (n.kind !== "deep_dive") continue;
      if (n.status !== "in_progress") continue;
      const pid = (n.payload as { pieceId?: unknown })?.pieceId;
      if (typeof pid === "string") set.add(pid);
    }
    return set;
  }, [appNotifications]);

  const displayPieces = useMemo(() => {
    const merged = pieces.map((p) => {
      const patch = patchesRef.current.get(p.id);
      return patch ? { ...p, ...patch } : p;
    });
    // ─── Due-date prioritization ─────────────────────────────────
    // Pieces with a `due_at` come first, sorted by soonest deadline.
    // Pieces without a due date come after, in their original
    // position-from-the-server order. Within a single due-date day,
    // ties are broken alphanumerically on title so the order stays
    // stable across renders even when two tickets share a deadline.
    //
    // Why client-side sort: the underlying `position` field is the
    // generator's chosen reading order, which we still want to fall
    // back to for non-dated pieces. Doing this on the client keeps
    // the server's existing sort semantics intact and lets the user
    // see pieces stream in (the regenerate flow patches a single
    // piece in place; that patch shouldn't reshuffle the whole list
    // every keystroke). The sort is stable: pieces without dates
    // keep their original index, so the only re-orderings come from
    // dated pieces "bubbling" to the top.
    return merged
      .map((p, idx) => ({ p, idx }))
      .sort((a, b) => {
        const aDue = a.p.due_at ?? null;
        const bDue = b.p.due_at ?? null;
        // (1) Both have a due date → soonest first, ties broken by title.
        if (aDue && bDue) {
          if (aDue !== bDue) return aDue < bDue ? -1 : 1;
          return a.p.title.localeCompare(b.p.title, undefined, {
            numeric: true,
            sensitivity: "base",
          });
        }
        // (2) Only one has a due date → it goes first.
        if (aDue) return -1;
        if (bDue) return 1;
        // (3) Neither has a due date → preserve server order (stable).
        return a.idx - b.idx;
      })
      .map((wrap) => wrap.p);
  }, [pieces, patchCounter]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRegenerated = useCallback((pieceId: string, updated: Partial<TeachingPieceData>) => {
    patchesRef.current.set(pieceId, updated);
    setPatchCounter((c) => c + 1);
  }, []);

  const handleFeedback = useCallback(
    async (pieceId: string, feedback: "positive" | "negative") => {
      try {
        const deltas = await submitFeedback(pieceId, feedback);
        if (deltas.length > 0) {
          setToastDeltas(deltas);
        }
      } catch {
        // feedback is non-critical
      }
    },
    [submitFeedback],
  );

  if (deepDiveId) {
    const piece = displayPieces.find((p) => p.id === deepDiveId);
    if (loading) return <LoadingState />;
    if (!piece) {
      return (
        <div className="animate-fade-in text-center py-12">
          <p className="font-ui text-sm text-text-dim">Piece not found.</p>
        </div>
      );
    }
    return <DeepDiveView piece={piece} briefingDate={date || todayDate()} />;
  }

  if (loading) return <LoadingState />;

  if (error) {
    return (
      <div className="animate-fade-in">
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4">
          <p className="font-ui text-sm text-negative">{error}</p>
        </div>
      </div>
    );
  }

  if (!briefing && !generating) {
    return (
      <div className="animate-fade-in">
        <div className="font-ui text-xs sm:text-sm text-text-dim uppercase tracking-wider mb-2">{formatDate(date)}</div>
        <p className="font-display text-lg font-normal text-text-secondary italic leading-relaxed mb-6">
          Your briefing will appear here once generated.
        </p>
        <div className="border border-border-subtle rounded-lg p-6 text-center">
          <p className="font-ui text-sm text-text-dim mb-4">No briefing for today yet.</p>
          <button
            onClick={generate}
            className="font-ui text-sm font-medium text-accent bg-accent-dim hover:bg-accent/20 rounded-md px-4 py-2 transition-colors min-h-[44px]"
          >
            Generate briefing
          </button>
        </div>
      </div>
    );
  }

  const briefingDate = briefing?.briefing_date ?? todayDate();
  const isMonday = new Date(briefingDate + "T12:00:00").getDay() === 1;
  const weeklyStats = briefing?.metadata?.weeklyStats;
  const isStillGenerating = generating || briefing?.status === "generating";

  return (
    <div className="animate-fade-in">
      {briefing?.status === "partial" && !isStillGenerating && (
        <div className="rounded-lg border border-warning-dim bg-warning-dim/30 px-4 py-3 mb-6">
          <p className="font-ui text-sm text-warning">
            This briefing was generated with limited sources. Some pieces may be missing.
          </p>
        </div>
      )}

      {/* ─── Briefing header — full-bleed warm band ─── */}
      <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 bg-bg-warm border-b border-border-subtle mb-8">
        <div className="mx-auto max-w-[860px] py-6">
          <div className="flex items-center justify-between mb-2">
            <span className="font-ui text-xs sm:text-sm text-text-dim uppercase tracking-wider">
              {formatDate(briefingDate)}
            </span>
            {!isStillGenerating && (
              <button
                onClick={generate}
                className="font-ui text-xs text-text-faint hover:text-accent transition-colors min-h-[44px] flex items-center gap-1.5"
                title="Regenerate today's briefing"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
                  <path
                    d="M2 8a6 6 0 0 1 10.3-4.2M14 8a6 6 0 0 1-10.3 4.2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M12 1v3.5h-3.5M4 15v-3.5h3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="hidden sm:inline">Refresh</span>
              </button>
            )}
          </div>

          {isMonday && weeklyStats && (
            <div className="mt-3">
              <WeeklyStats stats={weeklyStats} />
            </div>
          )}

          {mostRecentInProgress && (
            <Link
              to={`/briefing/${mostRecentInProgress.briefingDate}`}
              className="inline-flex items-center gap-1.5 mt-3 font-ui text-xs text-accent hover:text-accent/80 no-underline"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M3 1h6a1 1 0 011 1v9l-4-2.5L2 11V2a1 1 0 011-1z" />
              </svg>
              Pick up where you left off — {mostRecentInProgress.pieceTitle}
            </Link>
          )}

          {briefing?.workContextSources && briefing.workContextSources.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border-subtle/50">
              <WorkContextBar sources={briefing.workContextSources} />
            </div>
          )}

          {/* Redundant-drafts chip — surfaces topics whose drafts the
              continuation classifier filtered as REDUNDANT (no new
              movement vs. a recent piece). Only renders when at least
              one topic was filtered, so the briefing header stays
              tight on the typical day. */}
          {briefing?.redundantDrafts && briefing.redundantDrafts.length > 0 && (
            <RedundantDraftsChip drafts={briefing.redundantDrafts} />
          )}
        </div>
      </div>

      {/* ─── Generation progress (above pieces by design) ───────────
          During generation the progress panel sits *above* the
          teaching-piece list, not below it. Reason: pieces stream in
          one at a time as the generator produces them, and rendering
          them above the panel pushed it down the page on every new
          arrival — disorienting for the user, who's typically watching
          the progress for the first run. With pieces below, the panel
          stays anchored: every newly streamed piece appends to the
          end of the list (below the panel), so nothing the user is
          currently looking at shifts. The order also matches the
          natural reading flow: "what's happening now" first, then
          "what's been produced so far".

          Once generation completes (`!isStillGenerating`), the panel
          unmounts and the page reflows to just-pieces — same end
          state as before this reorder.
          ─────────────────────────────────────────────────────────── */}
      {isStillGenerating && (
        <div className="mb-6">
          <GenerationProgress
            step={generationStatus.step}
            stepLabel={generationStatus.stepLabel}
            details={generationStatus.details}
            waitingOnAi={generationStatus.waitingOnAi}
            stepStartedAt={generationStatus.stepStartedAt}
            startedAt={generationStatus.startedAt}
            updatedAt={generationStatus.updatedAt}
            averageDurationSeconds={generationStatus.averageDurationSeconds}
            cancelling={cancelling || generationStatus.cancelRequested}
            stuck={generationStatus.stuck}
            onCancel={cancel}
            onForceReset={forceReset}
          />
        </div>
      )}

      {displayPieces.length > 0 && (
        <div className="divide-y divide-border-subtle">
          {displayPieces.map((piece) => (
            <TeachingPiece
              key={`${piece.id}-${piece.model_used ?? ""}`}
              piece={piece}
              briefingDate={briefingDate}
              onFeedback={handleFeedback}
              onRegenerated={handleRegenerated}
              isBookmarked={isSaved(piece.id)}
              onToggleBookmark={toggleSaved}
              bookmarkedBlock={blockBookmarks.get(piece.id) ?? null}
              onBookmarkBlock={handleBookmarkBlock}
              isDeepDiveGenerating={generatingDeepDiveIds.has(piece.id)}
            />
          ))}
        </div>
      )}

      {!isStillGenerating && quiz && (
        <div className="mt-8 pt-6 border-t border-border-subtle">
          <CalibrationQuiz initialQuiz={quiz} />
        </div>
      )}

      {!isStillGenerating && briefing?.id && <NearMisses briefingId={briefing.id} />}

      {/* Vertical timeline of earlier briefings — only on the root /briefing
          view (not when looking at a specific past date or a deep dive).
          Lazy-loads each day's content as it scrolls into view.
          
          Deliberately NOT gated on `!isStillGenerating`: past briefings
          are independent of today's regeneration and should stay readable
          while today rebuilds. Hiding them mid-refresh strands the user
          on a "spinner only" screen for a topic they're actively in. */}
      {!date && !deepDiveId && briefing?.briefing_date && (
        <PastBriefingsTimeline excludeDate={briefing.briefing_date} />
      )}

      {toastDeltas.length > 0 && <FeedbackToast deltas={toastDeltas} onDismiss={() => setToastDeltas([])} />}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="animate-fade-in space-y-4">
      <div className="h-3 w-32 rounded bg-surface-active animate-pulse" />
      <div className="h-5 w-3/4 rounded bg-surface-active animate-pulse" />
      <div className="h-4 w-full rounded bg-surface-active animate-pulse" />
      <div className="h-4 w-5/6 rounded bg-surface-active animate-pulse" />
      <div className="h-4 w-2/3 rounded bg-surface-active animate-pulse" />
    </div>
  );
}

const GENERATION_STEPS = [
  { key: "starting", label: "Starting generation" },
  { key: "work_context", label: "Fetching sources" },
  { key: "slack_filter", label: "Filtering source data" },
  { key: "concepts", label: "Extracting concepts" },
  { key: "adjacent", label: "Scanning feeds" },
  { key: "selecting", label: "Selecting teaching targets" },
  { key: "generating_pieces", label: "Writing teaching pieces" },
  { key: "quiz", label: "Generating calibration quiz" },
  { key: "finishing", label: "Finishing up" },
];

function ElapsedTime({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(since).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  if (elapsed < 2) return null;
  return <span className="font-mono text-xs text-text-faint ml-2">{elapsed}s</span>;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `about ${Math.round(seconds)} seconds`;
  const mins = seconds / 60;
  if (mins < 2) return `about a minute`;
  return `about ${Math.round(mins)} minutes`;
}

function EtaMessage({ startedAt, averageSeconds }: { startedAt: string | null; averageSeconds: number | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (averageSeconds && averageSeconds > 5) {
    if (startedAt && elapsed > 0) {
      const remaining = Math.max(0, Math.round(averageSeconds - elapsed));
      if (remaining > 0) {
        return <>Based on your recent briefings, about {formatDuration(remaining)} remaining.</>;
      }
      return <>Taking a bit longer than usual — almost there.</>;
    }
    return <>Based on your recent briefings, this usually takes {formatDuration(averageSeconds)}.</>;
  }
  return <>This usually takes 1–2 minutes.</>;
}

function GenerationProgress({
  step,
  stepLabel,
  details,
  waitingOnAi,
  stepStartedAt,
  startedAt,
  updatedAt,
  averageDurationSeconds,
  cancelling,
  stuck,
  onCancel,
  onForceReset,
}: {
  step: string | null;
  stepLabel: string | null;
  details: string[];
  waitingOnAi: boolean;
  stepStartedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  averageDurationSeconds: number | null;
  cancelling: boolean;
  stuck: boolean;
  onCancel: () => void;
  onForceReset: () => void;
}) {
  const activeIndex = GENERATION_STEPS.findIndex((s) => s.key === step);

  // Surface the escape hatch when cooperative cancel has been pending too
  // long, or when the server tells us the generator has gone silent.
  const [cancelPendingMs, setCancelPendingMs] = useState(0);
  useEffect(() => {
    if (!cancelling) {
      setCancelPendingMs(0);
      return;
    }
    const start = Date.now();
    const tick = () => setCancelPendingMs(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cancelling]);

  const showForceStop = stuck || (cancelling && cancelPendingMs > 15_000);

  const stuckSeconds = useMemo(() => {
    if (!updatedAt) return null;
    const t = new Date(updatedAt).getTime();
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 1000);
  }, [updatedAt, cancelPendingMs]);

  const headline = stuck
    ? "Briefing generation is stuck"
    : cancelling
      ? "Cancelling briefing…"
      : "Generating your briefing";

  return (
    <div className="border border-border-subtle rounded-lg p-6 sm:p-8">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          {stuck ? (
            <span className="h-5 w-5 rounded-full border-2 border-warning bg-warning-dim shrink-0 flex items-center justify-center text-warning">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="5" y1="1" x2="5" y2="6" />
                <circle cx="5" cy="9" r="0.5" fill="currentColor" />
              </svg>
            </span>
          ) : (
            <div className="h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
          )}
          <p className="font-display text-lg text-text-primary">{headline}</p>
        </div>
        <div className="flex items-center gap-2">
          {!showForceStop && (
            <button
              onClick={onCancel}
              disabled={cancelling}
              className="shrink-0 px-2.5 py-1 rounded-md border border-border font-ui text-xs text-text-dim hover:text-negative hover:border-negative transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-dim disabled:hover:border-border"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {showForceStop && (
            <button
              onClick={onForceReset}
              className="shrink-0 px-2.5 py-1 rounded-md border border-negative bg-negative-dim font-ui text-xs text-negative hover:bg-negative hover:text-white transition-colors"
            >
              Force stop
            </button>
          )}
        </div>
      </div>

      {stuck && (
        <div className="mb-5 rounded-md bg-warning-dim border border-warning/20 px-3 py-2 font-ui text-xs text-text-primary">
          No progress for {stuckSeconds != null ? `${stuckSeconds}s` : "a while"} — the generator is likely hung on an
          external API call. Click <span className="font-semibold">Force stop</span> to clear this briefing and start
          fresh.
        </div>
      )}

      {!stuck && cancelling && cancelPendingMs > 15_000 && (
        <div className="mb-5 rounded-md bg-bg-warm border border-border-subtle px-3 py-2 font-ui text-xs text-text-dim">
          Cancel is taking longer than expected. The generator may be blocked on an in-flight API call. You can{" "}
          <span className="font-semibold text-negative">Force stop</span> to clear this briefing immediately.
        </div>
      )}

      <div className="space-y-1">
        {GENERATION_STEPS.map((s, i) => {
          const isCompleted = activeIndex > i;
          const isActive = activeIndex === i;
          const isPending = activeIndex < i;

          return (
            <div key={s.key} className="flex items-start gap-3 py-1.5">
              <div className="w-5 flex justify-center shrink-0 mt-[7px]">
                {isCompleted && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8.5l3.5 3.5L13 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-positive"
                    />
                  </svg>
                )}
                {isActive && (
                  <div className="relative flex items-center justify-center">
                    <span className="absolute h-4 w-4 rounded-full bg-accent/30 animate-ping" />
                    <span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
                  </div>
                )}
                {isPending && <div className="h-2 w-2 rounded-full bg-surface-active" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center">
                  <span
                    className={`font-ui text-sm transition-colors ${
                      isCompleted ? "text-text-dim" : isActive ? "text-text-primary font-medium" : "text-text-faint"
                    }`}
                  >
                    {isActive && stepLabel ? stepLabel : s.label}
                  </span>
                  {isActive && stepStartedAt && <ElapsedTime since={stepStartedAt} />}
                  {isActive && waitingOnAi && (
                    <span className="ml-2 font-ui text-[10px] text-accent bg-accent-dim px-1.5 py-0.5 rounded">AI</span>
                  )}
                </div>
                {isActive && details.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {details.map((d, di) => (
                      <div key={di} className="font-ui text-xs text-text-dim truncate">
                        {d}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="font-ui text-xs text-text-faint mt-5 pl-8">
        {cancelling ? (
          <>Waiting for the current step to finish before stopping…</>
        ) : (
          <EtaMessage startedAt={startedAt} averageSeconds={averageDurationSeconds} />
        )}
      </p>
    </div>
  );
}

function todayDate(): string {
  // User's local YYYY-MM-DD. Using UTC here would render the briefing
  // header as e.g. "Monday April 27" while the user's wall clock still
  // says Sunday, because UTC rolls a day earlier than UTC-N timezones.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) {
    return new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
