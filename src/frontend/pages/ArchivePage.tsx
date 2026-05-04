import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { addDays, WeekNavigator, weekStartFor } from "../components/WeekNavigator";
import type { BriefingListItem } from "../types";
import { apiGet } from "../utils/api";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ready: { label: "Ready", color: "text-positive" },
  generating: { label: "Generating", color: "text-accent" },
  partial: { label: "Partial", color: "text-warning" },
  failed: { label: "Failed", color: "text-negative" },
};

interface BriefingDatesResponse {
  dates: string[];
  retentionDays: number;
  earliestAllowed: string;
  earliestRetained: string | null;
  todayDate: string;
}

/**
 * Archive page — calendar-driven week view of past briefings.
 *
 * The user always sees one week (Mon–Sun) at a time, in reverse-chronological
 * order. They can step ±1 week with the navigator's arrows, jump to any week
 * via the calendar popover, or snap back to "this week" with one click. The
 * retention boundary (`earliestAllowed`) is enforced — the navigator and the
 * popover both visually disable dates older than that, so the user can't
 * accidentally pick a window that's been pruned.
 *
 * Why week-anchored vs. infinite-scroll: the briefing page already has the
 * infinite-scroll timeline pattern (with the right-edge scrubber for fast
 * navigation). The Archive page exists to give the user *intentional*
 * control — pick a specific time window and review what was happening then,
 * rather than scrolling endlessly. A weekly cadence matches how people
 * naturally talk about their calendar ("the week of the 14th", "two weeks
 * ago"), and aligns with how briefings get generated (one per workday).
 */
export function ArchivePage() {
  const [datesData, setDatesData] = useState<BriefingDatesResponse | null>(null);
  const [datesLoading, setDatesLoading] = useState(true);
  const [datesError, setDatesError] = useState<string | null>(null);
  // The Monday of the currently-viewed week. We default to "this week"
  // once the dates response lands, so the page always starts on the most
  // recent window and the user can navigate backward from there.
  const [weekStart, setWeekStart] = useState<string | null>(null);
  // Briefings that fall within the currently-viewed week, fetched on
  // demand. We don't bulk-load every week's content because most users
  // only look at the recent ones.
  const [items, setItems] = useState<BriefingListItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  // Initial bootstrap — pull the date list (retention metadata + which
  // dates have content) and seed `weekStart` to today's week.
  useEffect(() => {
    apiGet<BriefingDatesResponse>("/api/briefings/dates")
      .then((data) => {
        setDatesData(data);
        setWeekStart(weekStartFor(data.todayDate));
        setDatesError(null);
      })
      .catch((err) => {
        setDatesError(err instanceof Error ? err.message : "Failed to load archive");
      })
      .finally(() => setDatesLoading(false));
  }, []);

  // Whenever the selected week changes, fetch the briefings whose
  // briefing_date falls in [weekStart, weekStart + 6]. We use the same
  // /api/briefings list endpoint and filter client-side rather than
  // adding a new server endpoint — the list is already deduplicated by
  // date and capped to a few dozen rows even on busy weeks. The cost is
  // a single page request per navigation, which is cheaper than a custom
  // range query.
  const fetchWeek = useCallback(async (start: string) => {
    setItemsLoading(true);
    try {
      // Pull a generous window — the API returns newest-first, so a
      // limit of 100 + offset 0 will cover a week (max 7 days) plus
      // some buffer in case of duplicate-date edge cases.
      const data = await apiGet<{
        briefings: BriefingListItem[];
        total: number;
        hasMore: boolean;
      }>("/api/briefings?limit=100&offset=0");
      const end = addDays(start, 6);
      const filtered = data.briefings
        .filter((b) => b.briefing_date >= start && b.briefing_date <= end)
        // Newest first — already the API order, but be defensive.
        .sort((a, b) => b.briefing_date.localeCompare(a.briefing_date));
      setItems(filtered);
      setItemsError(null);
    } catch (err) {
      setItemsError(err instanceof Error ? err.message : "Failed to load briefings");
    } finally {
      setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!weekStart) return;
    fetchWeek(weekStart);
  }, [weekStart, fetchWeek]);

  const datesWithBriefings = useMemo(() => new Set(datesData?.dates ?? []), [datesData]);

  if (datesLoading) {
    return (
      <div className="animate-fade-in">
        <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary mb-2">Archive</h1>
        <p className="font-ui text-sm text-text-dim mb-7">Loading…</p>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="py-4 space-y-2">
              <div className="h-3 w-32 rounded bg-surface-active animate-pulse" />
              <div className="h-4 w-3/4 rounded bg-surface-active animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (datesError || !datesData || !weekStart) {
    return (
      <div className="animate-fade-in">
        <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary mb-2">Archive</h1>
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4">
          <p className="font-ui text-sm text-negative">{datesError ?? "Failed to load archive."}</p>
        </div>
      </div>
    );
  }

  const totalBriefings = datesData.dates.length;
  const retentionLabel = formatRetentionRange(datesData.earliestAllowed, datesData.todayDate, datesData.retentionDays);

  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary mb-2">Archive</h1>
      <p className="font-ui text-sm text-text-dim mb-5">
        {totalBriefings > 0
          ? `${totalBriefings} briefing${totalBriefings !== 1 ? "s" : ""} · ${retentionLabel}`
          : `Past briefings will appear here · ${retentionLabel}`}
      </p>

      <WeekNavigator
        weekStart={weekStart}
        earliestAllowed={datesData.earliestAllowed}
        today={datesData.todayDate}
        datesWithBriefings={datesWithBriefings}
        onWeekChange={setWeekStart}
      />

      {itemsError && (
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4 mb-4">
          <p className="font-ui text-sm text-negative">{itemsError}</p>
        </div>
      )}

      {itemsLoading && items.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="py-4 space-y-2">
              <div className="h-3 w-32 rounded bg-surface-active animate-pulse" />
              <div className="h-4 w-3/4 rounded bg-surface-active animate-pulse" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="border border-border-subtle rounded-lg p-6 text-center">
          <p className="font-ui text-sm text-text-dim">No briefings in this week.</p>
          <p className="font-ui text-xs text-text-faint mt-2">Pick a different week from the calendar above.</p>
        </div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {items.map((b) => {
            const status = STATUS_LABELS[b.status] || STATUS_LABELS.ready;
            const pieceCount = b.pieceCount ?? 0;
            const titles = b.pieceTitles ?? [];
            const concepts = b.topConcepts ?? [];
            return (
              <Link
                key={b.id}
                to={`/briefing/${b.briefing_date}`}
                className="block py-6 no-underline hover:bg-surface-hover -mx-4 px-4 rounded-md transition-colors"
              >
                {/* Header: date pill + status. The piece-titles
                    preview below is now the row's "identity"
                    surface — the AI-generated greeting that used
                    to anchor this card was removed because it
                    added visual noise without aiding navigation
                    (the date + titles already answer "what was
                    this about"). */}
                <div className="flex items-center justify-between mb-4">
                  <span className="font-ui text-xs text-text-faint uppercase tracking-wider">
                    {formatDate(b.briefing_date)}
                  </span>
                  <span className={`font-mono text-[10px] ${status.color}`}>{status.label}</span>
                </div>

                {/* Piece-title preview. Vertical list — long titles
                    routinely contain colons ("Cloudflare DNS: Beyond
                    Basic Name Resolution"), which fight bullet
                    separators on a single inline run; one title per
                    row reads cleanly at any title length. */}
                {pieceCount > 0 && titles.length > 0 && (
                  <div>
                    <p className="font-ui text-[10px] uppercase tracking-wider text-text-faint mb-2">
                      {pieceCount} piece{pieceCount === 1 ? "" : "s"}
                    </p>
                    <ul className="space-y-1 font-ui text-xs text-text-secondary leading-relaxed">
                      {titles.map((title) => (
                        <li key={title} className="line-clamp-1">
                          {title}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Concept tags — dominant *topics* in the briefing,
                    complementary to the titles which describe the
                    *angle* on those topics. */}
                {concepts.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {concepts.map((name) => (
                      <span
                        key={name}
                        className="font-mono text-[10px] text-text-dim bg-bg-warm border border-border-subtle rounded-full px-2 py-0.5"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatRetentionRange(earliest: string, today: string, days: number): string {
  const e = new Date(`${earliest}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  void today;
  return `keeping ${days} days back to ${e}`;
}
