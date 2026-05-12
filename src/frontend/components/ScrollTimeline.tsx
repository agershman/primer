import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Vertical timeline rail for the briefing page, scoped to **the last
 * week** (or fewer days if the user has fewer briefings). Each available
 * day gets one dot on the rail; the dot at the date currently in view is
 * filled and ringed, the rest are hollow circles. A dark "Thursday,
 * Apr 23"-style tooltip floats next to the active dot.
 *
 * Why week-scoped instead of full-retention:
 *   • Briefings are daily — the high-value navigation use case is
 *     "jump back 1–6 days", not "scroll through 11 months".
 *   • Day dots are semantically meaningful (one dot = one briefing),
 *     unlike year labels which were just typographic markers around
 *     a continuous rail.
 *   • The Archive page's calendar view is the right surface for
 *     month/year-scale navigation. The two surfaces complement.
 *
 * Behavior preserved from the previous design:
 *   • Fades in when the user starts scrolling, fades out ~1.2s after
 *     the last scroll event (or after the last drag interaction ends).
 *   • Pointer-based scrubbing — click or drag any dot to jump to that
 *     date; the parent's `onScrub` lazily loads any not-yet-paginated
 *     sections.
 *   • Locked to `lg+` viewports, where `lg:pr-16` on the App container
 *     reserves a clear gutter so the rail never lands on content.
 *
 * Date list contract: `dates` must be in newest-first order, i.e.
 *   ["2026-04-25", "2026-04-24", "2026-04-23", ...]
 *
 * Position mapping: index 0 = top of rail (most recent), index N-1 =
 * bottom of rail (oldest day in the week-scoped slice).
 */

export interface ScrollTimelineProps {
  /** Briefing dates, newest first. ISO `YYYY-MM-DD` strings. */
  dates: string[];
  /**
   * The date currently considered "in view" by the parent. Drives the
   * filled-dot active-day highlight when the user is passively
   * scrolling. `null` when no past-briefing section is in view (e.g.
   * the user is still looking at today's content above the timeline,
   * or has scrolled to a date outside the rail's week-scoped window). */
  currentDate: string | null;
  /**
   * Called when the user clicks or drags on the rail to scrub to a new
   * date. The parent is expected to scroll the matching section into
   * view (and lazy-load it if needed).
   */
  onScrub: (date: string, index: number) => void;
}

const HIDE_AFTER_MS = 1200;

/**
 * Maximum number of day dots rendered on the rail. Mirrors the way
 * Apple/Google photo apps scope their "recent" rail to a digestible
 * window. With 7 days, dots are far enough apart on a typical
 * 600–800px-tall rail to be tappable without crowding. If the user has
 * fewer than 7 days of briefings, we render however many they have.
 */
const RAIL_WINDOW_DAYS = 7;

export function ScrollTimeline({ dates, currentDate, onScrub }: ScrollTimelineProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  // While dragging, the previewed date may differ from the parent's
  // committed `currentDate` — we surface this separately so the active
  // dot tracks the cursor immediately, even before the parent scroll
  // lands.
  const [previewDate, setPreviewDate] = useState<string | null>(null);

  // Take only the most-recent N days. The full-retention rail handed
  // out in the parent (`BriefingFeed`) still works as the
  // source of truth — the rail just chooses to display a digestible
  // slice. Days outside this window are reachable via the Archive
  // page's calendar.
  const railDates = useMemo(() => dates.slice(0, RAIL_WINDOW_DAYS), [dates]);

  // One marker per day in the rail's window, evenly spaced top→bottom.
  // Top = most recent. With a single date we center it (50%) rather
  // than putting one lonely dot at the top edge.
  const dayMarkers = useMemo(() => {
    if (railDates.length === 0) return [] as Array<{ date: string; pct: number }>;
    if (railDates.length === 1) return [{ date: railDates[0], pct: 50 }];
    return railDates.map((date, i) => ({
      date,
      pct: (i / (railDates.length - 1)) * 100,
    }));
  }, [railDates]);

  // Index of the currently in-view date inside the rail's window, or
  // null if either nothing is in view *or* the visible date has been
  // scrolled past the week-scoped slice (which is fine — the rail
  // simply has no active highlight in that case).
  const currentIndex = useMemo(() => {
    if (!currentDate) return null;
    const idx = railDates.indexOf(currentDate);
    return idx === -1 ? null : idx;
  }, [currentDate, railDates]);

  // The date the user is actively pointing at (drag preview), or the
  // committed currentDate when not dragging. Drives the tooltip text.
  const displayedDate = dragging ? previewDate : currentDate;

  // Index of the displayed date inside the rail. Used to position the
  // tooltip next to the right dot, even while dragging across days.
  const displayedIndex = useMemo(() => {
    if (!displayedDate) return null;
    const idx = railDates.indexOf(displayedDate);
    return idx === -1 ? null : idx;
  }, [displayedDate, railDates]);

  // Percent down the rail for the displayed date — for tooltip
  // positioning and active-dot highlight.
  const displayedPct = useMemo(() => {
    if (displayedIndex == null) return null;
    if (railDates.length === 1) return 50;
    return (displayedIndex / (railDates.length - 1)) * 100;
  }, [displayedIndex, railDates]);

  // ── show/hide on scroll ────────────────────────────────────────────────
  useEffect(() => {
    const onScroll = () => {
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        // Don't hide while user is actively dragging — they'd lose their
        // grip indicator mid-scrub.
        setVisible((prev) => (dragging ? prev : false));
      }, HIDE_AFTER_MS);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [dragging]);

  // While dragging, force visible — even if scrolling stops (e.g. user
  // pauses cursor without releasing).
  useEffect(() => {
    if (dragging) setVisible(true);
  }, [dragging]);

  // ── click / drag scrubbing ─────────────────────────────────────────────
  // Snap to the nearest day in the rail's window. Each dot acts as a
  // discrete target — the user can drag continuously and the picked
  // date "ratchets" to the closest day.
  const pickDateFromY = useCallback(
    (clientY: number): { date: string; index: number } | null => {
      const rail = railRef.current;
      if (!rail || railDates.length === 0) return null;
      const rect = rail.getBoundingClientRect();
      const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
      const pct = rect.height === 0 ? 0 : y / rect.height;
      const index = Math.min(railDates.length - 1, Math.max(0, Math.round(pct * (railDates.length - 1))));
      return { date: railDates[index], index };
    },
    [railDates],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pick = pickDateFromY(e.clientY);
      if (!pick) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setDragging(true);
      setPreviewDate(pick.date);
      onScrub(pick.date, pick.index);
    },
    [pickDateFromY, onScrub],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const pick = pickDateFromY(e.clientY);
      if (!pick) return;
      // Only fire onScrub when the picked date actually changes — saves
      // a ton of redundant scroll calls during a fast drag.
      setPreviewDate((prev) => {
        if (prev === pick.date) return prev;
        onScrub(pick.date, pick.index);
        return pick.date;
      });
    },
    [dragging, pickDateFromY, onScrub],
  );

  const endDrag = useCallback((e?: React.PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    setPreviewDate(null);
    if (e) {
      try {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // Some browsers throw if capture wasn't set; ignore.
      }
    }
    // Schedule the normal auto-hide once the drag ends.
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  }, []);

  if (railDates.length === 0) return null;

  return (
    <div
      aria-hidden={!visible}
      // Position the rail's outer container fixed against the right
      // edge of the viewport. Renders only at `lg` (≥1024px) where
      // App-level `lg:pr-16` reserves a clear gutter for the rail —
      // see `App.tsx` and the test that pins both together.
      className={`pointer-events-none fixed right-5 top-32 bottom-32 z-30 hidden lg:flex items-stretch transition-all duration-300 ${
        visible || dragging ? "opacity-100 translate-x-0" : "opacity-0 translate-x-2"
      }`}
    >
      {/*
        Minimal rail — no opaque pill backdrop, no track line, no year
        labels. Just a column of day dots aligned vertically. Each dot
        has a `ring-2 ring-bg` halo so it remains clearly visible
        against any content that the layout shift hasn't fully cleared
        (rare with `lg:pr-16` but worth defending).

        The pointer hit zone is wider than the visible dots so users
        don't need pixel-perfect aim to grab them.
      */}
      <div
        ref={railRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="pointer-events-auto relative w-6 cursor-ns-resize select-none touch-none"
      >
        {/* Day dots — one per day in the rail's window. The active day
            (currently in view, or being scrubbed to) is a filled solid
            circle; the rest are hollow with a thin border. The
            `ring-2 ring-bg` on every dot ensures the dot stands out
            against any content underneath. */}
        {dayMarkers.map(({ date, pct }) => {
          const isActive = displayedDate === date;
          return (
            <div
              key={date}
              style={{ top: `${pct}%` }}
              className={`pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg transition-all ${
                isActive ? "h-2.5 w-2.5 bg-text-primary shadow-md" : "h-1.5 w-1.5 border border-border-subtle bg-bg"
              }`}
            />
          );
        })}

        {/* Date tooltip — dark "notification pill" style matching the
            screenshot. Shows the active or scrubbed-to date with full
            weekday name. Sits to the LEFT of the rail so it never
            covers the dots, and pointer-events-none so it never
            intercepts the drag pointer. */}
        {visible && displayedDate && displayedPct != null && (
          <div
            style={{ top: `${displayedPct}%` }}
            className="absolute right-full mr-3 -translate-y-1/2 rounded-md bg-text-primary text-bg px-2.5 py-1.5 font-mono text-[11px] font-medium whitespace-nowrap shadow-lg pointer-events-none"
          >
            {formatTimelineDate(displayedDate)}
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimelineDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}
