import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import type { BriefingData, BriefingListItem, TeachingPieceData } from "../types";
import { apiGet, apiPost } from "../utils/api";
import { ScrollTimeline } from "./ScrollTimeline";
import { TeachingPiece } from "./TeachingPiece";
import { WorkContextBar } from "./WorkContextBar";

const PAGE_SIZE = 5;

interface BriefingDatesResponse {
  dates: string[];
  retentionDays: number;
  earliestAllowed: string;
  earliestRetained: string | null;
  todayDate: string;
}

interface PastBriefingsTimelineProps {
  /**
   * The briefing date currently rendered above the timeline (today, by default).
   * Excluded from the timeline so we don't duplicate it.
   */
  excludeDate: string;
}

/**
 * Vertical infinite-scroll timeline of past briefings — modeled on the mobile
 * photo-gallery pattern: scroll back through time, content lazy-loads as it
 * approaches the viewport. Each day is a `<PastBriefingSection>`, each section
 * fetches its own pieces on first visibility, so we don't bulk-load 30 days
 * of teaching pieces up front.
 */
export function PastBriefingsTimeline({ excludeDate }: PastBriefingsTimelineProps) {
  const [items, setItems] = useState<BriefingListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const initialLoadStarted = useRef(false);
  // ───── Scrubber timeline state ─────
  // Full set of available briefing dates (newest first) used by the
  // right-side ScrollTimeline. We fetch these once on mount because the
  // payload is small (≤365 ISO date strings) and the scrubber needs a
  // stable end-to-end mapping; we don't want it to grow as the user
  // scrolls past pagination boundaries.
  const [allDates, setAllDates] = useState<string[]>([]);
  // The date associated with whichever past-briefing section is currently
  // most prominent in the viewport. Drives the scrubber thumb position.
  const [visibleDate, setVisibleDate] = useState<string | null>(null);
  // Section refs keyed by date — let us scroll directly to a section when
  // the user scrubs to a given date.
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (reset) {
        setLoading(true);
        offsetRef.current = 0;
      } else {
        setLoadingMore(true);
      }
      try {
        const offset = reset ? 0 : offsetRef.current;
        // Pad limit slightly in case today's date appears in the result and we
        // need to filter it out below.
        const data = await apiGet<{
          briefings: BriefingListItem[];
          total: number;
          hasMore: boolean;
        }>(`/api/briefings?limit=${PAGE_SIZE + 1}&offset=${offset}`);
        const filtered = data.briefings.filter((b) => b.briefing_date !== excludeDate);
        // Trim to page size if we got an extra (because of the +1 padding).
        const trimmed = filtered.slice(0, PAGE_SIZE);
        setItems((prev) => (reset ? trimmed : [...prev, ...trimmed]));
        setHasMore(data.hasMore || filtered.length > trimmed.length);
        offsetRef.current = offset + data.briefings.length;
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load past briefings");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [excludeDate],
  );

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    fetchPage(true);
    // Fetch the full date list separately. This powers the scrubber on the
    // right edge — having the full list up front means the scrubber rail
    // shows the user's *entire* retention window, not just what's loaded.
    apiGet<BriefingDatesResponse>("/api/briefings/dates")
      .then((data) => {
        // Exclude today's date from the rail so it stays in sync with the
        // pageable list (which also excludes it).
        const filtered = data.dates.filter((d) => d !== excludeDate);
        setAllDates(filtered);
      })
      .catch(() => {
        // Non-critical: scrubber simply doesn't render if dates fail to
        // load. The list itself still works.
      });
  }, [fetchPage, excludeDate]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) fetchPage(false);
  }, [fetchPage, loadingMore, hasMore]);

  const { sentinelRef } = useInfiniteScroll({ hasMore, loading: loadingMore, onLoadMore: loadMore });

  // Track which past-briefing section is currently visible, so the
  // scrubber thumb can follow the user's natural scroll position. We use
  // a stack of intersecting sections — the topmost intersecting section
  // wins, which matches the user's intuition (the date heading they're
  // currently reading is the date "they're on").
  const intersectingDatesRef = useRef<Set<string>>(new Set());
  const handleSectionIntersection = useCallback((date: string, isIntersecting: boolean) => {
    if (isIntersecting) {
      intersectingDatesRef.current.add(date);
    } else {
      intersectingDatesRef.current.delete(date);
    }
    // Pick the newest date among intersecting sections. Items are
    // rendered newest-first, so this keeps the thumb at the most-recent
    // visible day when several sections overlap (long days with lots of
    // pieces).
    const intersecting = Array.from(intersectingDatesRef.current);
    if (intersecting.length === 0) {
      setVisibleDate(null);
      return;
    }
    intersecting.sort((a, b) => b.localeCompare(a));
    setVisibleDate(intersecting[0]);
  }, []);

  // Scrubber requested date — eagerly load until the section exists in
  // `items` (so we can scroll to it), then scroll its element into view.
  // We keep loading additional pages until we find the requested date or
  // exhaust pagination, so users can drag from "today" all the way to
  // the oldest retained date in one motion without manually triggering
  // intermediate loads.
  const scrubInFlightRef = useRef(false);
  const handleScrub = useCallback(
    async (date: string) => {
      // Already-loaded section: scroll instantly.
      const el = sectionRefs.current.get(date);
      if (el) {
        el.scrollIntoView({ behavior: "auto", block: "start" });
        return;
      }
      // Avoid spawning multiple eager loaders if the user keeps dragging.
      if (scrubInFlightRef.current) return;
      scrubInFlightRef.current = true;
      try {
        // Keep paging until the requested date appears in `items` or we
        // run out of pages. Each fetchPage(false) appends one PAGE_SIZE
        // chunk, so this loop is bounded by ceil(retention / PAGE_SIZE).
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

  // Don't render anything while the initial fetch is in flight + there's no
  // content yet — keeps the briefing page from showing a "loading more" jolt
  // immediately after today's content. Show a divider only once we have
  // confirmed past briefings exist.
  if (loading && items.length === 0) return null;
  if (!loading && items.length === 0 && !error) return null;

  return (
    <div className="mt-12 pt-8 border-t border-border-subtle">
      <div className="mb-6 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base sm:text-lg font-medium text-text-secondary">Earlier briefings</h2>
        <span className="font-mono text-[10px] text-text-faint uppercase tracking-wider">scroll for more</span>
      </div>

      {error && (
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4 mb-4">
          <p className="font-ui text-sm text-negative">{error}</p>
        </div>
      )}

      <div className="space-y-12">
        {items.map((b) => (
          <PastBriefingSection
            key={b.id}
            item={b}
            registerRef={registerSection}
            onIntersectionChange={handleSectionIntersection}
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
          end of timeline · {items.length} past briefing{items.length === 1 ? "" : "s"}
        </div>
      )}

      {/* Right-edge scrubber. Lives outside the normal flow (position: fixed)
          and tracks the visible date as the user scrolls; click + drag
          jumps to a specific date, lazily loading any pages in between. */}
      <ScrollTimeline dates={allDates} currentDate={visibleDate} onScrub={handleScrub} />
    </div>
  );
}

interface PastBriefingResponse {
  briefing: BriefingData | null;
  pieces: TeachingPieceData[];
}

/**
 * One day's briefing rendered inline. Lazy-loads its full content when the
 * section comes within ~400px of the viewport, so a long timeline of 50+ days
 * doesn't trigger 50 simultaneous API calls on mount.
 */
interface PastBriefingSectionProps {
  item: BriefingListItem;
  registerRef: (date: string, el: HTMLElement | null) => void;
  onIntersectionChange: (date: string, isIntersecting: boolean) => void;
}

function PastBriefingSection({ item, registerRef, onIntersectionChange }: PastBriefingSectionProps) {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [pieces, setPieces] = useState<TeachingPieceData[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  // Lazy-load this section's full content when it nears the viewport.
  // Same logic as before, but kept on its own observer so we can cleanly
  // tear it down once the data arrives.
  useEffect(() => {
    if (loaded) return;
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          observer.disconnect();
          setLoading(true);
          apiGet<PastBriefingResponse>(`/api/briefing/${item.briefing_date}`)
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

  // Visibility tracking for the scrubber thumb. Distinct from the
  // lazy-load observer because we want a tighter "is in view" definition
  // (no preload margin) — it should only fire when the section's top
  // edge is actually within the viewport.
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
      // Make sure we don't leak this date into the parent's intersecting
      // set on unmount (e.g. when a section gets re-keyed during refresh).
      onIntersectionChange(item.briefing_date, false);
    };
  }, [item.briefing_date, onIntersectionChange]);

  // Register the section element with the parent so scrubbing can scroll
  // directly to it.
  const setSectionRef = useCallback(
    (el: HTMLElement | null) => {
      sectionRef.current = el;
      registerRef(item.briefing_date, el);
    },
    [item.briefing_date, registerRef],
  );

  return (
    <section ref={setSectionRef} className="scroll-mt-4">
      <DateHeader date={item.briefing_date} />

      {/* The AI-generated `briefing.greeting` used to render here as
          an italic "Good morning! …" intro line above each section.
          It was removed because it added visual noise without
          orienting the reader — the date heading + the teaching
          piece titles below already do that job. The DB column
          remains for legacy data; the UI just no longer surfaces
          it. Focus-version attribution still lives on the briefing
          row server-side (joined into the briefing response) so
          analytics + version history work; we just don't display
          per-briefing focus pills inline. */}

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

          {pieces.length === 0 ? (
            <p className="font-ui text-xs text-text-faint italic">No teaching pieces in this briefing.</p>
          ) : (
            <div className="space-y-8">
              {pieces.map((piece, idx) => (
                <div key={piece.id}>
                  <TeachingPiece
                    piece={piece}
                    briefingDate={item.briefing_date}
                    onFeedback={async (pieceId, feedback) => {
                      // Past-briefing feedback goes through the same endpoint
                      // as today's feedback — concept depth updates apply
                      // regardless of when the piece was generated. We don't
                      // pop a depth-gain toast here (that's the today-page's
                      // job); just record the rating and reflect locally.
                      try {
                        await apiPost(`/api/piece/${pieceId}/feedback`, { feedback });
                        setPieces((prev) => prev.map((p) => (p.id === pieceId ? { ...p, feedback } : p)));
                      } catch {
                        // Non-critical; user can retry.
                      }
                    }}
                    onRegenerated={(pieceId, updated) => {
                      setPieces((prev) => prev.map((p) => (p.id === pieceId ? { ...p, ...updated } : p)));
                    }}
                  />
                  {idx < pieces.length - 1 && <div className="mt-8 border-t border-border-subtle" />}
                </div>
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
  // Use noon UTC to avoid timezone-shift edge cases at midnight.
  const date = new Date(`${dateStr}T12:00:00Z`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

  let relative = "";
  if (diffDays === 1) relative = "yesterday";
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
  // Slim placeholder while waiting for IntersectionObserver to trigger the
  // load. Provides enough vertical space to make the timeline feel
  // continuous, but is otherwise unobtrusive.
  return <div className="h-32" />;
}
