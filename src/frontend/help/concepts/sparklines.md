---
title: "Sparklines"
subtitle: "Reading depth-over-time charts"
audiences: [user]
related:
  - concepts/depth-scale
  - concepts/decay
---

Each concept gets a **sparkline** — a small inline chart that shows how your depth score has changed over time. Sparklines appear in two places:

- **The concepts list view** (`/concepts`) — one per row, capped at the most recent 24 history points so a row that's been quizzed many times still renders cleanly. Drives the at-a-glance scan: rising lines mean the row is learning; flat means no movement; falling means decay.
- **The concept detail panel** (clicking into a row) — full history for that concept, no cap, with the gap-callouts and source attribution (which depth changes came from quizzes vs feedback vs decay).

Both pull from the same source: `concept_depth_history`.

If a concept doesn't have enough history yet to plot (just-extracted, never calibrated), the list view shows a faint **dashed-line placeholder** that occupies the same 80×20 box a real sparkline would. Hover it to see "Not enough history yet — answer a quiz or give feedback to start the trajectory." The dashed shape clearly communicates "this column is a trend chart; nothing to plot yet" — much less ambiguous than a bare em-dash sitting next to other empty-state placeholders in adjacent columns.

Similarly, the **last-exposed** column (typically showing values like *today*, *2d ago*, *1mo ago*) shows the word *never* in italic when you've not yet been exposed to the concept in a briefing piece. Hover any cell in that column to see a tooltip explaining when (or whether) you last saw the concept.

## Reading the Chart

The sparkline plots depth score (Y-axis, 0–5) against time (X-axis). Each data point comes from the `concept_depth_history` table and represents a moment when your depth changed — whether from a quiz, feedback, decay, or baseline calibration.

### Common Patterns

**Rising line** — You're actively learning this concept. Depth is increasing through quizzes, feedback, and exposure. This is the ideal pattern for concepts relevant to your current work.

**Flat line** — You've been exposed to this concept but your depth isn't changing. This usually means the teaching pieces are at your current level (confirming but not advancing your understanding) or you're not engaging deeply enough through quizzes.

**Declining line** — Knowledge decay in action. The concept hasn't been reinforced recently and depth is dropping. A declining sparkline combined with a decay warning badge is a strong signal to engage with this concept.

**Step pattern** — Sharp jumps followed by plateaus. This is typical of quiz-driven calibration, where a single assessment can shift your depth significantly. The steps show that quiz results have a larger impact than gradual feedback.

**V-shape** — A decline followed by recovery. You let the concept decay, then engaged with it again (through a briefing or quiz) and regained depth. This is normal and healthy — it shows the system is working.

## Data Source

Sparkline data comes from the `concept_depth_history` table, which records every depth change with its source (quiz, feedback, decay, extraction) and a timestamp.

- The **list view** sparkline ships with the bulk `GET /api/concepts` response — a single round-trip pulls history for every loaded concept, then groups + caps to the last 24 points per concept on the worker side. No N+1 round-trips to render the page.
- The **detail panel** sparkline fetches the full series via `GET /api/concept/:id/history` when you expand a row.

Both views are bounded by the same retention (`RETENTION_DAYS`, default 365 days) and the maintenance job's monthly compaction — older data points get summarized into one entry per month so long-tail concepts don't accumulate hundreds of rows.
