---
title: "Navigating your briefing history"
subtitle: "Two complementary surfaces — a fast scroll-timeline scrubber on the briefing page, and a calendar week-window on the archive page"
audiences: [user]
related:
  - briefings/teaching-pieces
  - reference/configuration
---

Primer keeps every briefing it generates within your retention window (default **365 days**, configurable via the `RETENTION_DAYS` worker variable). Two surfaces help you navigate that history:

## The briefing page — week-scoped day-dot scrubber

Below today's content, the **Earlier briefings** section is an infinite-scroll timeline of past days, lazy-loaded as each section nears the viewport. On viewports ≥1024px wide (where the page reserves a clear right gutter via `lg:pr-16`), a minimal **scrubber rail** appears along the right edge — modeled after the recent-photos rail in mobile photo apps but scoped to the briefing cadence.

### Behavior

- **Week-scoped.** The rail shows up to the **last 7 days** of briefings as a column of small dots, one per day. Briefings are daily, so a 7-day window covers the high-value navigation case ("jump back 1–6 days") while staying digestible. Older days are reachable via the Archive page's calendar view, which is purpose-built for month / year-scale navigation.
- **Auto-fades on scroll.** The rail appears as soon as the page scrolls and fades out ~1.2 seconds after motion stops. It stays visible while you're actively dragging it.
- **One filled dot for the day in view.** As you scroll, whichever day's section is currently in the viewport center gets the filled-circle highlight; the other six days are hollow circles. If you scroll to a date older than the rail's window, no dot is highlighted (the day-dot row stays passive — Archive is the right tool for that range).
- **Click + drag to scrub.** Tapping any dot jumps to that day. Dragging along the rail snaps to whichever dot is closest to your cursor, in real time. The page scrolls the matching section into view as the picked date changes.
- **Eager loading during scrub.** If you drag to a date that hasn't been paginated in yet, Primer keeps fetching pages in the background until the requested section is in the DOM.
- **Dark tooltip pill.** Next to the active dot, a dark `bg-text-primary text-bg` tooltip shows the full weekday — *"Thursday, Apr 23"* — so the date is unambiguous even at small dot sizes.

The full date list (newest-first ISO strings) still comes from `GET /api/briefings/dates`. The rail just *displays* the most recent 7; the parent timeline still uses the full retention window for everything else (eager loading, intersection tracking, the "end of timeline" marker).

## The archive page — calendar week-window

The Archive page (`/archive`) gives you intentional, calendar-driven access to history rather than scroll-driven access. It always shows **one week (Mon–Sun)** at a time, in reverse-chronological order — the same card style as before.

### Per-briefing thematic summary

Each archive row surfaces a one-line snapshot of the day's content directly under the date header:

- **Piece count** — total teaching pieces published that day.
- **Top piece titles** — up to 3 representative titles in priority order.
- **Top concepts** — up to 3 concept names that recurred most across the briefing's pieces, rendered as small pills.

This rolls in from `GET /api/briefings`, which joins `teaching_pieces` and the per-piece `concepts` table to compute the trio in a single round trip — no N+1 fetches. It's enough context to recognize a briefing at a glance ("oh, that's the day everything was about Durable Objects") without opening it. The piece-titles preview replaces the AI-generated greeting that used to anchor each card; the date + titles do the orientation job more directly.

### Navigator bar

Above the list of briefings, the navigator bar has:

- **`←` / `→` arrow buttons** to step ±1 week. The prev arrow disables when stepping would cross your retention boundary. The next arrow disables once you've reached the current week (no future).
- **Range button** in the middle (e.g. *"Apr 21–27 2026"*) — click to open a calendar popover.
- **"This week" shortcut** — appears only when you've navigated away from the current week, snaps back to it in one click.

### Calendar popover

A monthly grid (Mon-anchored) with:

- **Prev/next month** buttons (disable when stepping outside retention or into the future).
- **Days with briefings** show an accent dot underneath, so you can see which days have content before jumping there.
- **Today** is ringed.
- **Currently-selected week** is highlighted (all 7 days in the row that contains the selected `weekStart`).
- **Outside-retention dates** render greyed out and non-clickable, with a tooltip explaining why.

Picking any date snaps to that date's week and closes the popover. Click outside the popover to dismiss it.

### Retention boundary

Both the navigator and the calendar enforce your `retentionDays` setting. The page subtitle surfaces the boundary up front:

> *X briefings · keeping 365 days back to Apr 27 2025*

So you always know what's reachable without having to bump up against a disabled button to find out.

## Browsing while a briefing is regenerating

Past briefings stay readable while today's regeneration is in flight. The **Earlier briefings** timeline on the briefing page is deliberately not gated on the generating-status flag — only the parts of *today's* main column that depend on completed pieces (quiz, near misses) stay hidden until generation finishes. Scroll on past your in-progress today and read whatever past day you want; nothing about the timeline pauses.

## Local-timezone "today"

The "this week" shortcut and the calendar's "today is ringed" indicator anchor on the user's *local* calendar day, not UTC. The worker computes today via `userToday(user.timezone)` (where `user.timezone` is set per-request from the `X-Client-Timezone` header) and `/api/briefings/dates` returns it in the response payload. So a Sunday-evening EDT user doesn't see the calendar jump to Monday's empty week just because UTC has rolled over — the archive stays aligned with the user's wall clock. See [Briefing generation → Timezones and "today"](/help/briefings/how-generation-works#timezones-and-today) for the underlying machinery.

## Why two surfaces?

- The **briefing-page rail** is for *recent* navigation — the last week's worth of days, accessible with one tap. Fast, gestural, ambient.
- The **archive page calendar** is for *intentional* navigation — pick any week within retention and review what was happening then. Use it when you remember roughly *when* something happened ("the week of the 14th", "two weeks ago") or want to skim months back.

Both share the same lightweight `/briefings/dates` endpoint, so retention and "today" are one source of truth across the app — change `RETENTION_DAYS` in `wrangler.api.toml` and both surfaces respect the new boundary the next time you load.
