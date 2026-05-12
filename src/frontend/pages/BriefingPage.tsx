import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BriefingFeed } from "../components/BriefingFeed";
import { CalibrationQuiz } from "../components/CalibrationQuiz";
import { FeedbackToast } from "../components/FeedbackToast";
import { NearMisses } from "../components/NearMisses";
import { RedundantDraftsChip } from "../components/RedundantDraftsChip";
import { TeachingPiece } from "../components/TeachingPiece";
import { WeeklyStats } from "../components/WeeklyStats";
import { WorkContextBar } from "../components/WorkContextBar";
import { useBookmarks } from "../hooks/useBookmarks";
import { useBriefing } from "../hooks/useBriefing";
import { useNotifications } from "../hooks/useNotifications";
import type { FeedbackDelta, TeachingPieceData } from "../types";
import { DeepDiveView } from "./DeepDiveView";

/**
 * Routes:
 *   /                       → reverse-chrono feed of all briefings.
 *   /briefing/:date         → single-date view (a focused permalink).
 *   /briefing/:date/:id     → deep dive on a piece inside a briefing.
 *
 * The feed is where "Generate now" lives. The date-scoped view is a
 * read-only permalink — no regenerate button, since generation is a
 * top-level action keyed to today, not to whichever date the user is
 * looking at. (That decoupling fixed the "refresh wiped my content"
 * bug where regenerating from a past-date view would replace the
 * surfaced row with an empty today's-briefing row.)
 */
export function BriefingPage() {
  const { date, id: deepDiveId } = useParams();

  if (!date && !deepDiveId) {
    return <BriefingFeed />;
  }

  return <DatedBriefingView date={date} deepDiveId={deepDiveId} />;
}

interface DatedBriefingViewProps {
  date: string | undefined;
  deepDiveId: string | undefined;
}

function DatedBriefingView({ date, deepDiveId }: DatedBriefingViewProps) {
  const { briefing, pieces, quiz, loading, error, submitFeedback } = useBriefing(date);
  const [toastDeltas, setToastDeltas] = useState<FeedbackDelta[]>([]);
  const { bookmarks, loadBookmarks, toggleSaved, isSaved, saveBookmark } = useBookmarks();
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
  // the series-navigation strip ("Part 2" link from a sibling).
  useEffect(() => {
    if (pieces.length === 0) return;
    if (!window.location.hash) return;
    const id = window.location.hash.slice(1);
    const el = document.getElementById(id);
    if (!el) return;
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
    // Due-date prioritization: pieces with a deadline bubble to the
    // top in ascending due order; everything else preserves the
    // server's reverse-chronological order within the date.
    return merged
      .map((p, idx) => ({ p, idx }))
      .sort((a, b) => {
        const aDue = a.p.due_at ?? null;
        const bDue = b.p.due_at ?? null;
        if (aDue && bDue) {
          if (aDue !== bDue) return aDue < bDue ? -1 : 1;
          return a.p.title.localeCompare(b.p.title, undefined, { numeric: true, sensitivity: "base" });
        }
        if (aDue) return -1;
        if (bDue) return 1;
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

  if (error && !briefing) {
    return (
      <div className="animate-fade-in">
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4">
          <p className="font-ui text-sm text-negative">{error}</p>
        </div>
      </div>
    );
  }

  if (!briefing) {
    return (
      <div className="animate-fade-in">
        <div className="font-ui text-xs sm:text-sm text-text-dim uppercase tracking-wider mb-2">{formatDate(date)}</div>
        <p className="font-display text-lg font-normal text-text-secondary italic leading-relaxed mb-6">
          No briefing for this date.
        </p>
        <Link to="/" className="font-ui text-sm text-accent hover:text-accent/80 inline-flex items-center gap-1.5">
          ← Back to feed
        </Link>
      </div>
    );
  }

  const briefingDate = briefing.briefing_date;
  const isMonday = new Date(briefingDate + "T12:00:00").getDay() === 1;
  const weeklyStats = briefing.metadata?.weeklyStats;

  return (
    <div className="animate-fade-in">
      {error && (
        <div className="rounded-lg border border-warning-dim bg-warning-dim/30 px-4 py-3 mb-6">
          <p className="font-ui text-sm text-warning">Reconnecting… showing your last loaded briefing.</p>
        </div>
      )}
      {briefing?.status === "partial" && (
        <div className="rounded-lg border border-warning-dim bg-warning-dim/30 px-4 py-3 mb-6">
          <p className="font-ui text-sm text-warning">
            This briefing was generated with limited sources. Some pieces may be missing.
          </p>
        </div>
      )}

      <div className="-mx-4 sm:-mx-6 px-4 sm:px-6 bg-bg-warm border-b border-border-subtle mb-8">
        <div className="mx-auto max-w-[860px] py-6">
          <div className="flex items-center justify-between mb-2">
            <span className="font-ui text-xs sm:text-sm text-text-dim uppercase tracking-wider">
              {formatDate(briefingDate)}
            </span>
            <Link
              to="/"
              className="font-ui text-xs text-text-faint hover:text-accent transition-colors min-h-[44px] flex items-center gap-1.5"
            >
              <span className="hidden sm:inline">Back to feed</span>
              <span className="sm:hidden">Feed</span>
            </Link>
          </div>

          {isMonday && weeklyStats && (
            <div className="mt-3">
              <WeeklyStats stats={weeklyStats} />
            </div>
          )}

          {briefing.workContextSources && briefing.workContextSources.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border-subtle/50">
              <WorkContextBar sources={briefing.workContextSources} />
            </div>
          )}

          {briefing.redundantDrafts && briefing.redundantDrafts.length > 0 && (
            <RedundantDraftsChip drafts={briefing.redundantDrafts} />
          )}
        </div>
      </div>

      {displayPieces.length > 0 ? (
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
      ) : (
        <p className="font-ui text-sm text-text-dim italic">No teaching pieces in this briefing.</p>
      )}

      {quiz && (
        <div className="mt-8 pt-6 border-t border-border-subtle">
          <CalibrationQuiz initialQuiz={quiz} />
        </div>
      )}

      {briefing?.id && <NearMisses briefingId={briefing.id} />}

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

function todayDate(): string {
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
