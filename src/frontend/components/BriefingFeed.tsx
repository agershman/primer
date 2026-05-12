import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBookmarks } from "../hooks/useBookmarks";
import { useGeneration } from "../hooks/useGeneration";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { useNotifications } from "../hooks/useNotifications";
import type { BriefingData, BriefingListItem, FeedbackDelta, TeachingPieceData } from "../types";
import { apiGet, apiPost } from "../utils/api";
import { FeedbackToast } from "./FeedbackToast";
import { GenerationProgress } from "./GenerationProgress";
import { ScrollTimeline } from "./ScrollTimeline";
import { TeachingPiece } from "./TeachingPiece";
import { Toast } from "./Toast";
import { WorkContextBar } from "./WorkContextBar";

const PAGE_SIZE = 5;

interface BriefingDatesResponse {
  dates: string[];
  retentionDays: number;
  earliestAllowed: string;
  earliestRetained: string | null;
  todayDate: string;
}

/**
 * The canonical surface for the root briefing route — a reverse-
 * chronological feed of dated sections, each with its own teaching
 * pieces. Replaces the old "today hero + past timeline" split: in
 * the new model, content is a log; the date is a reference point;
 * "today" is just whichever section happens to be on top.
 *
 * Lifecycle actions live above the feed:
 *   • "Generate now" — on-demand run of what the daily cron does.
 *     Pieces append to the log; an empty run yields a toast (and the
 *     bell notification kicked off by the worker), not a full-page
 *     state change.
 *   • Cancel / force-stop — surfaced only while a run is in flight.
 */
export function BriefingFeed() {
  const generation = useGeneration();
  const [items, setItems] = useState<BriefingListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allDates, setAllDates] = useState<string[]>([]);
  const [visibleDate, setVisibleDate] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "neutral" | "negative" } | null>(null);
  const [feedbackDeltas, setFeedbackDeltas] = useState<FeedbackDelta[]>([]);
  const offsetRef = useRef(0);
  const initialLoadStarted = useRef(false);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

  const fetchPage = useCallback(async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      offsetRef.current = 0;
    } else {
      setLoadingMore(true);
    }
    try {
      const offset = reset ? 0 : offsetRef.current;
      const data = await apiGet<{
        briefings: BriefingListItem[];
        total: number;
        hasMore: boolean;
      }>(`/api/briefings?limit=${PAGE_SIZE}&offset=${offset}`);
      // Hide finalized zero-piece briefings — they're noise in a feed
      // that's about *content*, not "the cron ran but found nothing".
      // The user already learns about an empty run via the toast +
      // bell notification fired on completion; surfacing those rows
      // here too would duplicate the message and crowd the timeline.
      const visible = data.briefings.filter((b) => (b.pieceCount ?? 0) > 0);
      setItems((prev) => (reset ? visible : [...prev, ...visible]));
      setHasMore(data.hasMore);
      offsetRef.current = offset + data.briefings.length;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load briefings");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    fetchPage(true);
    apiGet<BriefingDatesResponse>("/api/briefings/dates")
      .then((data) => setAllDates(data.dates))
      .catch(() => {
        // Non-critical: scrubber simply doesn't render if dates fail.
      });
  }, [fetchPage]);

  // Run completion: refresh the first page (today's row may have just
  // appeared, or had pieces appended) and surface the outcome as a
  // toast. The bell notification is fired server-side regardless.
  // We watch only the tick — re-running on every outcome state
  // change would double-fire toast + refetch on a single completion.
  useEffect(() => {
    if (generation.completionTick === 0) return;
    fetchPage(true);
    apiGet<BriefingDatesResponse>("/api/briefings/dates")
      .then((data) => setAllDates(data.dates))
      .catch(() => {});
    const outcome = generation.lastOutcome;
    if (outcome) {
      if (outcome.kind === "no_new_content") {
        setToast({ message: copyForNoNewContent(outcome.reason), tone: "neutral" });
      } else if (outcome.kind === "failed") {
        setToast({ message: copyForFailure(outcome.reason), tone: "negative" });
      }
      // "added" runs need no toast — the new pieces are their own ack.
      generation.clearOutcome();
    }
  }, [generation.completionTick]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) fetchPage(false);
  }, [fetchPage, loadingMore, hasMore]);

  const { sentinelRef } = useInfiniteScroll({ hasMore, loading: loadingMore, onLoadMore: loadMore });

  // Track which section is currently visible so the scrubber thumb
  // follows the user's scroll. Same logic as the prior timeline:
  // newest-intersecting section wins.
  const intersectingDatesRef = useRef<Set<string>>(new Set());
  const handleSectionIntersection = useCallback((date: string, isIntersecting: boolean) => {
    if (isIntersecting) {
      intersectingDatesRef.current.add(date);
    } else {
      intersectingDatesRef.current.delete(date);
    }
    const intersecting = Array.from(intersectingDatesRef.current);
    if (intersecting.length === 0) {
      setVisibleDate(null);
      return;
    }
    intersecting.sort((a, b) => b.localeCompare(a));
    setVisibleDate(intersecting[0]);
  }, []);

  const scrubInFlightRef = useRef(false);
  const handleScrub = useCallback(
    async (date: string) => {
      const el = sectionRefs.current.get(date);
      if (el) {
        el.scrollIntoView({ behavior: "auto", block: "start" });
        return;
      }
      if (scrubInFlightRef.current) return;
      scrubInFlightRef.current = true;
      try {
        const isLoaded = () => sectionRefs.current.has(date);
        let safety = 0;
        while (!isLoaded() && hasMore && safety < 200) {
          await fetchPage(false);
          safety++;
        }
        const target = sectionRefs.current.get(date);
        if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
      } finally {
        scrubInFlightRef.current = false;
      }
    },
    [fetchPage, hasMore],
  );

  const registerSection = useCallback((date: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(date, el);
    else sectionRefs.current.delete(date);
  }, []);

  // Deep-dive-in-flight pieceIds for the spinner ring on "Go deeper"
  // buttons. Reads off the same notifications stream the bell uses,
  // so no extra polling.
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

  const { bookmarks, loadBookmarks, isSaved, toggleSaved, saveBookmark } = useBookmarks();
  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);
  const blockBookmarks = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of bookmarks) {
      if (b.scrollPosition > 0) {
        const blockIdx = Math.round(b.scrollPosition);
        if (blockIdx > 0) map.set(b.pieceId, blockIdx);
      }
    }
    return map;
  }, [bookmarks]);
  const handleBookmarkBlock = useCallback(
    async (pieceId: string, blockIndex: number) => {
      const existing = blockBookmarks.get(pieceId);
      if (existing === blockIndex) {
        await saveBookmark(pieceId, { type: "reading", scrollPosition: 0 });
      } else {
        await saveBookmark(pieceId, { type: "saved", scrollPosition: blockIndex });
      }
    },
    [blockBookmarks, saveBookmark],
  );

  const handleFeedback = useCallback(async (pieceId: string, feedback: "positive" | "negative") => {
    try {
      const data = await apiPost<{ conceptDeltas: FeedbackDelta[] }>(`/api/piece/${pieceId}/feedback`, { feedback });
      if (data.conceptDeltas.length > 0) setFeedbackDeltas(data.conceptDeltas);
    } catch {
      // Feedback is non-critical.
    }
  }, []);

  const hasContent = items.length > 0;
  const showInlineEmpty = !loading && !hasContent && !generation.generating && !error;

  return (
    <div className="animate-fade-in">
      <FeedActionBar
        generating={generation.generating}
        cancelling={generation.cancelling}
        onGenerate={generation.generate}
      />

      {generation.generating && (
        <div className="mb-8">
          <GenerationProgress
            step={generation.status.step}
            stepLabel={generation.status.stepLabel}
            details={generation.status.details}
            waitingOnAi={generation.status.waitingOnAi}
            stepStartedAt={generation.status.stepStartedAt}
            startedAt={generation.status.startedAt}
            updatedAt={generation.status.updatedAt}
            averageDurationSeconds={generation.status.averageDurationSeconds}
            cancelling={generation.cancelling || generation.status.cancelRequested}
            stuck={generation.status.stuck}
            onCancel={generation.cancel}
            onForceReset={generation.forceReset}
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4 mb-6">
          <p className="font-ui text-sm text-negative">{error}</p>
        </div>
      )}

      {showInlineEmpty && (
        <div className="border border-border-subtle rounded-lg p-8 text-center">
          <p className="font-display text-base text-text-secondary mb-2">No briefings yet.</p>
          <p className="font-ui text-sm text-text-dim">
            Click <span className="font-medium text-text-primary">Generate now</span> above to run your first one, or
            wait for tomorrow morning's scheduled run.
          </p>
        </div>
      )}

      <div className="space-y-12">
        {items.map((b) => (
          <BriefingSection
            // Keying by id + pieceCount means an additive run that
            // appended new pieces to today's existing row remounts the
            // section and refetches — without a manual refresh path.
            key={`${b.id}-${b.pieceCount}`}
            item={b}
            registerRef={registerSection}
            onIntersectionChange={handleSectionIntersection}
            generatingDeepDiveIds={generatingDeepDiveIds}
            isSaved={isSaved}
            toggleSaved={toggleSaved}
            blockBookmarks={blockBookmarks}
            onBookmarkBlock={handleBookmarkBlock}
            onFeedback={handleFeedback}
          />
        ))}
      </div>

      {loadingMore && (
        <div className="py-6 text-center">
          <div className="inline-block h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        </div>
      )}
      <div ref={sentinelRef} className="h-1" />

      {!hasMore && items.length > 0 && (
        <div className="mt-8 py-6 text-center font-mono text-[10px] text-text-faint uppercase tracking-wider">
          end of timeline · {items.length} briefing{items.length === 1 ? "" : "s"}
        </div>
      )}

      <ScrollTimeline dates={allDates} currentDate={visibleDate} onScrub={handleScrub} />

      {toast && <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} />}
      {feedbackDeltas.length > 0 && <FeedbackToast deltas={feedbackDeltas} onDismiss={() => setFeedbackDeltas([])} />}
    </div>
  );
}

interface FeedActionBarProps {
  generating: boolean;
  cancelling: boolean;
  onGenerate: () => void;
}

function FeedActionBar({ generating, cancelling, onGenerate }: FeedActionBarProps) {
  return (
    <div className="mb-6 flex items-center justify-between gap-3">
      <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary">Your briefings</h1>
      <button
        onClick={onGenerate}
        disabled={generating || cancelling}
        className="font-ui text-sm font-medium text-accent bg-accent-dim hover:bg-accent/20 rounded-md px-3 py-2 transition-colors min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        title="Run the daily generation now and append anything new to your feed"
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
        <span>Generate now</span>
      </button>
    </div>
  );
}

interface BriefingSectionResponse {
  briefing: BriefingData | null;
  pieces: TeachingPieceData[];
}

interface BriefingSectionProps {
  item: BriefingListItem;
  registerRef: (date: string, el: HTMLElement | null) => void;
  onIntersectionChange: (date: string, isIntersecting: boolean) => void;
  generatingDeepDiveIds: Set<string>;
  isSaved: (pieceId: string) => boolean;
  toggleSaved: (pieceId: string) => Promise<void>;
  blockBookmarks: Map<string, number>;
  onBookmarkBlock: (pieceId: string, blockIndex: number) => Promise<void>;
  onFeedback: (pieceId: string, feedback: "positive" | "negative") => Promise<void>;
}

/**
 * One date's content rendered inline. Lazy-loads its full briefing
 * when the section nears the viewport so a long feed doesn't trigger
 * 50 simultaneous requests on mount.
 */
function BriefingSection({
  item,
  registerRef,
  onIntersectionChange,
  generatingDeepDiveIds,
  isSaved,
  toggleSaved,
  blockBookmarks,
  onBookmarkBlock,
  onFeedback,
}: BriefingSectionProps) {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [pieces, setPieces] = useState<TeachingPieceData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (loaded) return;
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          observer.disconnect();
          setLoading(true);
          apiGet<BriefingSectionResponse>(`/api/briefing/${item.briefing_date}`)
            .then((data) => {
              setBriefing(data.briefing);
              setPieces(data.pieces);
              setLoaded(true);
            })
            .catch((err) => {
              setError(err instanceof Error ? err.message : "Failed to load");
            })
            .finally(() => setLoading(false));
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [item.briefing_date, loaded]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        onIntersectionChange(item.briefing_date, entry.isIntersecting);
      },
      { rootMargin: "-30% 0px -50% 0px", threshold: 0 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      onIntersectionChange(item.briefing_date, false);
    };
  }, [item.briefing_date, onIntersectionChange]);

  const setSectionRef = useCallback(
    (el: HTMLElement | null) => {
      sectionRef.current = el;
      registerRef(item.briefing_date, el);
    },
    [item.briefing_date, registerRef],
  );

  // Pieces come from the server ordered by `position DESC`. Within a
  // single date, re-sort dated pieces (due_at) to the top so deadlines
  // are visible without scrolling — matches the prior briefing-page
  // behavior.
  const displayPieces = useMemo(() => {
    return pieces
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
      .map((w) => w.p);
  }, [pieces]);

  return (
    <section ref={setSectionRef} className="scroll-mt-4">
      <DateHeader date={item.briefing_date} />

      {!loaded && (loading ? <SectionSkeleton /> : <SectionPlaceholder />)}

      {error && (
        <div className="rounded-md border border-negative-dim bg-negative-dim/30 p-3 mb-4">
          <p className="font-ui text-xs text-negative">{error}</p>
        </div>
      )}

      {loaded && briefing && (
        <>
          {briefing.workContextSources?.length > 0 && (
            <div className="mb-6">
              <WorkContextBar sources={briefing.workContextSources} />
            </div>
          )}

          {displayPieces.length === 0 ? (
            <p className="font-ui text-xs text-text-faint italic">No teaching pieces in this briefing.</p>
          ) : (
            <div className="divide-y divide-border-subtle">
              {displayPieces.map((piece) => (
                <TeachingPiece
                  key={`${piece.id}-${piece.model_used ?? ""}`}
                  piece={piece}
                  briefingDate={item.briefing_date}
                  onFeedback={onFeedback}
                  onRegenerated={(pieceId, updated) => {
                    setPieces((prev) => prev.map((p) => (p.id === pieceId ? { ...p, ...updated } : p)));
                  }}
                  isBookmarked={isSaved(piece.id)}
                  onToggleBookmark={toggleSaved}
                  bookmarkedBlock={blockBookmarks.get(piece.id) ?? null}
                  onBookmarkBlock={onBookmarkBlock}
                  isDeepDiveGenerating={generatingDeepDiveIds.has(piece.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function DateHeader({ date }: { date: string }) {
  const formatted = formatDateHeading(date);
  return (
    <div className="sticky top-0 z-10 -mx-4 px-4 py-3 mb-6 bg-bg/95 backdrop-blur-sm border-b border-border-subtle">
      <div className="flex items-baseline gap-3">
        <h3 className="font-display text-lg sm:text-xl font-medium text-text-primary">{formatted.day}</h3>
        <span className="font-mono text-[11px] text-text-faint uppercase tracking-wider">{formatted.relative}</span>
      </div>
    </div>
  );
}

function formatDateHeading(dateStr: string): { day: string; relative: string } {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

  let relative = "";
  if (diffDays === 0) relative = "today";
  else if (diffDays === 1) relative = "yesterday";
  else if (diffDays < 7) relative = `${diffDays} days ago`;
  else if (diffDays < 14) relative = "last week";
  else if (diffDays < 30) relative = `${Math.floor(diffDays / 7)} weeks ago`;
  else if (diffDays < 60) relative = "last month";
  else if (diffDays < 365) relative = `${Math.floor(diffDays / 30)} months ago`;
  else relative = `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) === 1 ? "" : "s"} ago`;

  const day = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });

  return { day, relative };
}

function SectionSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-4 w-2/3 rounded bg-surface-active animate-pulse" />
      <div className="h-3 w-full rounded bg-surface-active animate-pulse" />
      <div className="h-3 w-5/6 rounded bg-surface-active animate-pulse" />
      <div className="h-3 w-4/5 rounded bg-surface-active animate-pulse" />
    </div>
  );
}

function SectionPlaceholder() {
  return <div className="h-32" />;
}

function copyForNoNewContent(reason: string): string {
  switch (reason) {
    case "no_candidates":
      return "Nothing new surfaced — your sources didn't have anything fresh to teach yet.";
    case "monthly_budget_exceeded":
      return "Monthly LLM budget reached. Generation will resume next cycle.";
    case "cancelled":
      return "Run cancelled.";
    default:
      return "Generation finished without new pieces.";
  }
}

function copyForFailure(reason: string): string {
  switch (reason) {
    case "all_pieces_failed":
      return "Generation finished but every piece errored — likely a transient AI hiccup.";
    case "monthly_budget_exceeded":
      return "Monthly LLM budget reached. Generation will resume next cycle.";
    default:
      return "Generation failed. Check the bell for details.";
  }
}
