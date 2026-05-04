import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Week-based date navigator with a month-grid calendar popover.
 *
 * Designed for the Archive page: the user always views one week of
 * briefings at a time, can step ±1 week with arrow buttons, jump to any
 * date via the calendar popover, or snap back to "this week" with one
 * click. The retention boundary is enforced — dates older than
 * `earliestAllowed` (and dates after today) are visually disabled in
 * both the navigator and the calendar grid.
 *
 * Week boundaries: weeks run Monday → Sunday. We chose Monday-start
 * because work-related briefings naturally align with workweeks; if we
 * wanted Sunday-start that would be a one-line change in `weekStartFor`.
 */

interface WeekNavigatorProps {
  /** First day of the currently selected week (Monday), `YYYY-MM-DD`. */
  weekStart: string;
  /** Earliest date the user is allowed to navigate to (retention boundary). */
  earliestAllowed: string;
  /** Today's date in the user's frame, `YYYY-MM-DD`. */
  today: string;
  /**
   * Set of dates (as `YYYY-MM-DD`) that have a briefing. Used to dot
   * those days in the calendar popover so the user can see which days
   * have content before jumping there.
   */
  datesWithBriefings: Set<string>;
  /** Called when the user picks a new week (we always pass the Monday). */
  onWeekChange: (weekStart: string) => void;
}

export function WeekNavigator({
  weekStart,
  earliestAllowed,
  today,
  datesWithBriefings,
  onWeekChange,
}: WeekNavigatorProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  // The month visible in the popover — defaults to the month of the
  // currently-selected week, but the user can page through months
  // independently of changing the selected week.
  const [calendarMonth, setCalendarMonth] = useState(() => firstOfMonth(weekStart));
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // If the parent updates the week externally (e.g. user clicks "This
  // week" or the URL changes), realign the popover so it shows the same
  // month next time it opens.
  useEffect(() => {
    setCalendarMonth(firstOfMonth(weekStart));
  }, [weekStart]);

  // Click-outside-to-close handler for the calendar popover.
  useEffect(() => {
    if (!calendarOpen) return;
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setCalendarOpen(false);
      }
    };
    // Defer until the next tick so the click that *opened* the popover
    // doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
    };
  }, [calendarOpen]);

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const prevWeekStart = useMemo(() => addDays(weekStart, -7), [weekStart]);
  const nextWeekStart = useMemo(() => addDays(weekStart, 7), [weekStart]);

  // Disable nav buttons that would step outside the retention window or
  // into the future.
  const canGoPrev = prevWeekStart >= earliestAllowed;
  const canGoNext = weekStart < weekStartFor(today); // can't jump past current week
  const isCurrentWeek = weekStart === weekStartFor(today);

  const goPrev = () => {
    if (canGoPrev) onWeekChange(prevWeekStart);
  };
  const goNext = () => {
    if (canGoNext) onWeekChange(nextWeekStart);
  };
  const goToday = () => {
    onWeekChange(weekStartFor(today));
  };
  const pickDate = (date: string) => {
    if (date < earliestAllowed || date > today) return;
    onWeekChange(weekStartFor(date));
    setCalendarOpen(false);
  };

  return (
    <div className="relative mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={goPrev}
          disabled={!canGoPrev}
          className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border-subtle text-text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous week"
          title={canGoPrev ? "Previous week" : `Retention starts ${formatLong(earliestAllowed)}`}
        >
          <ChevronLeft />
        </button>

        <button
          type="button"
          onClick={() => setCalendarOpen((open) => !open)}
          className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-border-subtle text-text-primary hover:bg-surface-hover transition-colors font-ui text-sm font-medium"
          aria-haspopup="dialog"
          aria-expanded={calendarOpen}
        >
          <CalendarIcon />
          <span>{formatWeekRange(weekStart, weekEnd)}</span>
        </button>

        <button
          type="button"
          onClick={goNext}
          disabled={!canGoNext}
          className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-border-subtle text-text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Next week"
          title={canGoNext ? "Next week" : "Already at the current week"}
        >
          <ChevronRight />
        </button>

        {!isCurrentWeek && (
          <button
            type="button"
            onClick={goToday}
            className="ml-1 inline-flex items-center h-9 px-3 rounded-md font-ui text-xs font-medium text-accent hover:bg-accent-dim/40 transition-colors"
          >
            This week
          </button>
        )}
      </div>

      {calendarOpen && (
        <div
          ref={popoverRef}
          className="absolute left-0 top-full mt-2 z-40 rounded-lg border border-border bg-surface shadow-lg p-3 w-[280px]"
          role="dialog"
          aria-label="Pick a week"
        >
          <CalendarMonthGrid
            monthFirst={calendarMonth}
            onPrevMonth={() => setCalendarMonth(addMonths(calendarMonth, -1))}
            onNextMonth={() => setCalendarMonth(addMonths(calendarMonth, 1))}
            earliestAllowed={earliestAllowed}
            today={today}
            selectedWeekStart={weekStart}
            datesWithBriefings={datesWithBriefings}
            onPick={pickDate}
          />
        </div>
      )}
    </div>
  );
}

interface CalendarMonthGridProps {
  monthFirst: string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  earliestAllowed: string;
  today: string;
  selectedWeekStart: string;
  datesWithBriefings: Set<string>;
  onPick: (date: string) => void;
}

function CalendarMonthGrid({
  monthFirst,
  onPrevMonth,
  onNextMonth,
  earliestAllowed,
  today,
  selectedWeekStart,
  datesWithBriefings,
  onPick,
}: CalendarMonthGridProps) {
  const selectedWeekEnd = addDays(selectedWeekStart, 6);

  // Build a 6×7 grid (max 42 cells) covering the visible month plus
  // leading/trailing days from adjacent months to fill the calendar.
  // This is the standard Google Photos / Apple Photos calendar layout.
  const cells = useMemo(() => {
    const first = new Date(`${monthFirst}T12:00:00Z`);
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    // Monday-anchored: shift by `(weekday + 6) % 7` days back from the
    // first of the month to land on Monday.
    const firstWeekday = first.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
    const shiftBack = (firstWeekday + 6) % 7;
    const start = new Date(first);
    start.setUTCDate(first.getUTCDate() - shiftBack);

    const out: Array<{
      date: string;
      day: number;
      inMonth: boolean;
      disabled: boolean;
      isToday: boolean;
      hasBriefing: boolean;
      inSelectedWeek: boolean;
    }> = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      out.push({
        date: iso,
        day: d.getUTCDate(),
        inMonth: d.getUTCMonth() === month,
        disabled: iso < earliestAllowed || iso > today,
        isToday: iso === today,
        hasBriefing: datesWithBriefings.has(iso),
        inSelectedWeek: iso >= selectedWeekStart && iso <= selectedWeekEnd,
      });
      // Stop early if we've gone past the visible month and back to a
      // Monday — keeps the grid compact (5 rows when possible, 6 only
      // when the month spans them).
      if (i >= 27 && d.getUTCMonth() !== month && d.getUTCDay() === 1) {
        break;
      }
    }
    return out;
  }, [monthFirst, earliestAllowed, today, selectedWeekStart, selectedWeekEnd, datesWithBriefings]);

  const monthLabel = formatMonth(monthFirst);
  const prevMonthAllowed = lastDayOf(addMonths(monthFirst, -1)) >= earliestAllowed;
  const nextMonthAllowed = monthFirst <= firstOfMonth(today);

  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={onPrevMonth}
          disabled={!prevMonthAllowed}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeft />
        </button>
        <span className="font-ui text-sm font-medium text-text-primary">{monthLabel}</span>
        <button
          type="button"
          onClick={onNextMonth}
          disabled={!nextMonthAllowed}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          aria-label="Next month"
        >
          <ChevronRight />
        </button>
      </div>

      {/* Weekday header — Mon-anchored to match how we slice weeks. */}
      <div className="grid grid-cols-7 mb-1">
        {["M", "T", "W", "T", "F", "S", "S"].map((label, i) => (
          <span key={i} className="text-center font-mono text-[10px] uppercase tracking-wider text-text-faint">
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((cell) => (
          <button
            key={cell.date}
            type="button"
            onClick={() => !cell.disabled && onPick(cell.date)}
            disabled={cell.disabled}
            aria-pressed={cell.inSelectedWeek}
            className={`relative h-8 rounded-md font-ui text-xs transition-colors ${
              cell.disabled
                ? "text-text-faint cursor-not-allowed opacity-40"
                : cell.inSelectedWeek
                  ? "bg-accent-dim text-text-primary font-semibold"
                  : cell.inMonth
                    ? "text-text-secondary hover:bg-surface-hover"
                    : "text-text-faint hover:bg-surface-hover"
            } ${cell.isToday ? "ring-1 ring-accent" : ""}`}
            title={
              cell.disabled
                ? "Outside retention window"
                : cell.hasBriefing
                  ? `Has briefing — ${formatLong(cell.date)}`
                  : formatLong(cell.date)
            }
          >
            {cell.day}
            {cell.hasBriefing && !cell.disabled && (
              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-accent" />
            )}
          </button>
        ))}
      </div>
    </>
  );
}

// ───── Date utilities ──────────────────────────────────────────────────
// All operations work on `YYYY-MM-DD` strings via UTC noon parsing to
// avoid DST/midnight edge cases. This matches how `briefing_date` is
// stored on the worker side.

export function weekStartFor(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  // Monday = 1, Sunday = 0. Shift to Monday-start convention.
  const weekday = d.getUTCDay();
  const shiftBack = (weekday + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shiftBack);
  return d.toISOString().slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

function lastDayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function formatWeekRange(start: string, end: string): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const startStr = s.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const endStr = sameMonth
    ? e.toLocaleDateString(undefined, { day: "numeric", timeZone: "UTC" })
    : e.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
  const yearStr = ` ${e.getUTCFullYear()}`;
  return `${startStr}–${endStr}${sameYear ? yearStr : ""}`;
}

function formatMonth(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatLong(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function ChevronLeft() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="10 3 5 8 10 13" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 3 11 8 6 13" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <line x1="2" y1="6" x2="14" y2="6" />
      <line x1="5" y1="2" x2="5" y2="4" />
      <line x1="11" y1="2" x2="11" y2="4" />
    </svg>
  );
}
