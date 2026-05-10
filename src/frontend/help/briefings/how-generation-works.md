---
title: "How Briefing Generation Works"
subtitle: "Sources, pipeline, and scheduling"
audiences: [user]
related:
  - briefings/teaching-pieces
  - concepts/concept-graph
---

Every daily briefing passes through a multi-step pipeline that transforms raw work signals into personalized teaching content. Two user-context signals are loaded at the start and injected into every relevant LLM prompt:

- **About you** (persona) — calibrates voice, depth, and audience modeling on every user-facing surface.
- **Current focus** (topic priority) — biases concept extraction toward topics you care about and away from organizational noise.

Both flow in automatically; you don't need to do anything per-briefing.

## The Pipeline

**Step 0 — Load persona context.** Primer resolves your active **About** and **Focus** versions. Both are stamped on the briefing row (Focus also gets attributed to every newly-extracted concept, so analytics can show "what was extracted under v3 of my focus").

**Step 1 — Fetch work signals.** Primer pulls recent activity from Linear (assigned/commented issues), Slack (threads in mapped channels), GitHub (PRs you're reviewing or assigned), and incident.io (open and recently resolved incidents). What gets fetched is governed by your filter settings — preview ahead of time via the **Build full briefing preview** button at the bottom of Settings (see [Configuration → Preview](/help/reference/configuration)).

**Step 1a — Slack relevance filter.** Slack channels are noisy by design — a single channel mixes substantive technical threads with personal banter, jokes, and logistics. The Slack source's existing length / pattern heuristics (15-char floor, 30-char / 2-message floor, "lone emoji" regex) catch one-line acks but miss substantive-looking lines that are still off-topic ("msft makes good dev tools. that is it" or a Justin Bieber joke).

Primer runs each non-bookmarked Slack thread through a single batched Haiku scoring call against your **About + Focus + global Relevance filter prompt** and drops anything below the same `relevanceThreshold` you've tuned for feed scoring (default 0.4). Bookmarked threads (🔖) bypass entirely — explicit `:bookmark:` reactions are an opt-in signal that overrides the LLM gate. The step **fails open**: if scoring errors out, the input passes through unchanged so a transient outage can't strip your Slack work context.

What was filtered shows up live in the progress timeline (`✕ <thread title> (0.18 — banter)` style) and rolls up into the Analytics waterfall under the `slack_filter` step.

**Step 2 — Extract concepts.** The combined work context is analyzed to identify technical concepts — but bounded by hard rules in the extraction prompt: a substance bar (must be teachable as standalone subject matter), explicit anti-examples (no standups, retros, OKRs, ritual roles), an umbrella rule (close variants collapse into one canonical concept with the others as aliases), and **your Focus statement** as a strong topic filter. **About** flows in as a secondary signal that informs concept granularity (one umbrella concept for a senior platform engineer; finer detail for a less specialized reader). Suppressed concept names are excluded from extraction entirely.

**Step 3 — Read concept graph.** Primer loads your full graph: current depth scores, confidence levels, decay status, prerequisite relationships. Suppressed concepts are excluded from this view. This determines what you're ready to learn next.

**Step 4 — Scan feeds.** Your configured feeds are scanned for content overlapping your active concepts. The feed list starts empty on a fresh deploy — admins populate it via **Settings → Sources → Feeds** by pasting RSS URLs directly or by clicking ✨ Suggest sources to have Claude propose ~8 candidates tailored to the admin's About + Focus. Both **About** and **Focus** flow into the scoring prompt to disambiguate ambiguous matches and bias scores toward what you actually care about. See [Feeds](/help/briefings/source-instances) for the full panel.

**Step 5 — Select teaching targets.** Each candidate topic is scored by relevance, delta (how much it would advance your depth), and novelty. Items scoring above the relevance threshold (default: 0.4) become teaching targets. Items between 0.25 and 0.39 become near misses.

**Step 6 — Generate teaching pieces.** For each target, Primer generates a teaching piece calibrated to your depth on that concept *and* tuned to your **About** statement (voice, tone preferences, depth assumptions, what to skip). A concept at depth 1 gets a basics-level piece; at depth 4, you get contrarian perspectives and edge cases — and either is written in the voice you've said works for you.

**Step 6a — Continuation gate.** Each fresh draft passes through a classifier *before* it's persisted. The classifier looks at recent pieces (last 30 days) that share concepts or sources with the draft and decides whether the draft is:

- **Novel** — stands on its own, no meaningful overlap with anything recent. Persists as a standalone piece.
- **Continuation** — genuinely builds on a specific recent piece (new movement in sources, new claims, a resolution that wasn't possible before). The piece is rewritten with a callback opener ("Last time we looked at X. Today...") and linked into a series. The earlier piece gets retroactively labeled **Part 1** and the new one becomes **Part 2** (or 3, 4, ...).
- **Redundant** — covers the same ground as a recent piece with no meaningfully new claims, sources, or actions. The draft is silently dropped and surfaced as a "no new movement on these topics" chip in the briefing header instead.

The gate uses Haiku (fast/cheap) and biases toward "novel" when uncertain, so it never aggressively chains unrelated pieces together. See [Continuations and series](/help/briefings/continuations-and-series) for the full read.

**Step 7 — Generate calibration quiz.** One quiz question is generated, targeting the concept where calibration would be most valuable — typically the one with the lowest confidence score. Question framing is calibrated against your About statement, so it assumes your stated experience level.

**Step 8 — Store briefing.** Everything is written to D1: the briefing record (with the active focus version stamped on it), teaching pieces, quiz, near misses, and work context metadata. The briefing status moves to `ready`.

## Progress Tracking

When a briefing is generating (either via cron or manual trigger), the UI shows a step-by-step progress timeline. Each step transitions from pending (dim dot) to active (pulsing amber) to completed (green checkmark).

Under the active step, you'll see granular details of what Primer is currently reading:

- **Work context**: Each Linear ticket being fetched (e.g. "◆ PLAT-3907 Switch customer staging..."), Slack thread counts, incident counts
- **Teaching pieces**: Which concepts are being written about

This gives you confidence that generation is making progress and visibility into exactly what sources Primer is consulting.

### Adaptive ETA

The timeline shows an adaptive ETA that learns from your historical briefing durations. After the first few briefings, Primer has a good sense of how long each step typically takes in your environment and will update the estimate as generation proceeds.

### Progressive Results

Teaching pieces appear **as they're generated**, one at a time — you don't have to wait for the full pipeline to finish before reading. The progress timeline remains visible at the bottom for any pending steps. The quiz and near misses appear once generation is fully complete.

## Cancelling Generation

If a briefing is taking too long or you want to start over with different settings, click **Cancel** next to the progress timeline. The button immediately shows "Cancelling…" so you know the click registered, and the timeline heading switches to "Cancelling briefing…".

Primer stops at the **next checkpoint**, not mid-step. Checkpoints sit between pipeline steps and between each teaching piece, so cancel typically takes effect within a few seconds — but if the generator is mid-way through a long LLM call (say, writing a single teaching piece with Opus 4 or any future heavy reasoning model), you may wait for that one call to finish before the run stops.

Cancellation is safe and idempotent:
- Any partial data already written to the database is left intact and the briefing row is marked `failed` with `reason: "cancelled"`.
- Triggering a fresh generation afterwards deletes the cancelled row and starts clean.
- Refreshing the page during a cancel does **not** un-cancel it — the flag is persisted server-side in a dedicated column so it can't be overwritten by progress updates.

### Hard Timeouts and Force Stop

Every LLM HTTP call has a 120-second hard timeout enforced via `AbortController` — honoured by the Anthropic and OpenAI adapters today, and the contract any future adapter is expected to honour — so a stalled socket can't wedge generation indefinitely. On top of that, if the server hasn't written progress for more than 3 minutes, the status endpoint flags the run as `stuck: true` and the UI surfaces a **Force stop** button.

Force stop (`POST /api/briefing/reset`) unconditionally deletes today's briefing row — use it when cooperative cancel can't reach a checkpoint (hung fetch, dead worker, Cloudflare runtime restart mid-run). Triggering a fresh generation against a zombied briefing also auto-heals: the generate route will delete a stuck row and start clean rather than bouncing to the poll URL.

### Streaming keepalive (no more 524s)

Long generation runs used to crash into Cloudflare's edge timeout — the request body has to start streaming bytes within ~100s or the edge returns a 524 to the client. Briefings with multiple teaching pieces (each a Sonnet call), the continuation classifier (Haiku per draft), and the occasional ADDITIVE rewrite routinely exceeded that budget.

`POST /api/briefing/generate` now returns a streaming `application/json` body. The response writes a single space byte immediately (which resets the edge's first-byte timer), heartbeats a space every 25 seconds (well under any idle-connection limit), and finally writes the result JSON when generation finishes. Heartbeats are pure whitespace, so the concatenated body is still valid JSON for the client's `apiPost` (which parses leading whitespace fine) — no client change needed.

The same generation promise is also pinned to `c.executionCtx.waitUntil`, which keeps the work alive past the response stream. That matters for the navigate-away case: if the user clicks **Refresh** and then closes the tab (or switches to a different page in the app, which aborts the open `apiPost` fetch), the streaming response closes but `waitUntil` keeps the worker running so generation actually finishes. A `briefing_generation` notification is created at the start of the request and transitions to `ready` (or `failed`) when generation completes, so the bell catches up at its next poll regardless of which tab the user ends up on. See [notifications](/help/reference/notifications#what-triggers-notifications-today) for the bell-side contract.

## Timezones and "today"

A briefing's `briefing_date` is a calendar-day label (a YYYY-MM-DD string), not a timestamp — there's no UTC instant to translate it from at display time. Instead, Primer captures the user's *local* calendar at generation time and stores that.

The flow:

- Every API request from the browser carries an `X-Client-Timezone` header sourced from `Intl.DateTimeFormat().resolvedOptions().timeZone`. The worker reads it on every authenticated request, validates it against `Intl`, and computes the user's "today" via `Intl.DateTimeFormat('en-CA', { timeZone, year, month, day })`.
- The header value is also persisted on `users.timezone` (migration 0013) whenever it differs from what's stored, so cron — which runs offline at 5 AM UTC with no live session — knows what date to stamp for each user.
- Mutating routes (`/briefing/generate`, `cancel`, `reset`) use the same `userToday(user.timezone)` helper, so a refresh on Sunday evening EDT generates Sunday's briefing, not Monday's UTC date.
- `/briefing/today`'s fallback (used when no row exists for today, e.g. Sunday before cron has fired) explicitly excludes future-dated rows. The most recent briefing whose date is *on or before* today is returned, never one whose date hasn't arrived yet.

For travelers: the cache of the browser's TZ in `apiGet`/`apiPost`/etc. is dropped on `visibilitychange` and `focus` events. Flying NYC → Tokyo and reopening the tab produces a Tokyo `X-Client-Timezone` on the next request, the worker switches the live session to Tokyo immediately, and the persisted value is updated so cron generates Tokyo-dated briefings the following morning. Old briefings keep the date they were originally stamped with — "Monday's briefing" stays Monday's briefing forever, matching how readers remember consuming it.

Timestamps everywhere else (`generated_at`, `created_at`, `updated_at`, etc.) are stored as UTC ISO strings via SQLite's `datetime('now')` and rendered in the browser's local time via `Date` and `toLocaleString` — the standard "store UTC, display local" pattern. The TZ-aware machinery above is the narrow exception for the one *calendar-day* field.

## Due-Date Prioritization

When a piece's source carries a deadline, Primer surfaces it as a "Due in 3 days" badge and sorts the piece to the top of the briefing. Currently the only signal feeding this is **Linear `dueDate`** — when an issue has a due date set, that date flows through `WorkContextItem.dueAt` → `SourceDescriptor.dueAt` → the teaching piece's `due_at` column (added in migration 0011). Future signals that could populate this field include incident.io postmortem next-due dates, SOC2 audit milestones, and PR-review SLAs derived from team conventions.

When a piece has multiple sources with deadlines, the **soonest** one wins as the piece's `due_at`, so the user always sees the most urgent signal — and the `due_reason` tooltip names the specific source that contributed it (e.g. *"Linear ticket CIN-1234 is due 2026-04-30"*) so you can verify *why* the system thinks the piece is time-sensitive.

Sort order on the briefing page:

1. Pieces **with** a `due_at` come first, sorted by deadline ascending (soonest first).
2. Among pieces sharing the same calendar day, ties are broken **alphanumerically by title** (with `numeric: true` so "Migration 2" sorts before "Migration 10").
3. Pieces **without** a `due_at` come after, in the generator's chosen reading order — preserved as a stable index-based fallback so non-time-sensitive pieces keep the order Primer chose for them.

The badge color tier maps to urgency at a glance: red for overdue/today, amber for the next few days, accent for this week, calm grey for further out. See [Teaching Pieces → Due-date badge](/help/briefings/teaching-pieces) for the full label / color mapping.

## Model Selection

Each pipeline step uses a configurable model. Defaults are tuned for cost/speed/quality balance, but you can override them in **Settings → AI Models**. The picker groups options by provider via `<optgroup>` headers and only shows providers whose API key is set on the worker — today that's **Anthropic Claude** (Haiku 4.5, Sonnet 4, Opus 4) and **OpenAI GPT-5** (nano, mini, full); additional providers (Google, Workers AI, OpenRouter) light up automatically as their adapters land. See [AI Models](/help/reference/ai-models) for the gating rules and per-operation defaults.

Every generated teaching piece shows the model used at the bottom (e.g. "Generated with Claude Sonnet 4"), so you have a full audit trail across every provider you've ever used.

## Parallelism

To keep briefing generation fast even as your work context grows, Primer processes concepts in parallel batches (15 items per batch) during concept extraction. This means a briefing over 60+ Linear/Slack items completes in seconds rather than minutes.

## Scheduling

Briefings generate automatically via cron at **05:00 UTC, every day**, with the briefing's calendar `briefing_date` stamped using the user's stored timezone (see [Timezones and "today"](#timezones-and-today)). A Sunday maintenance job runs at **03:00 UTC** to handle concept decay, retention sweeps, and reaping stuck notifications. You can also trigger a manual briefing at any time using the refresh button next to the date — useful after a particularly active day or when you want fresh content.

If a given day has nothing worth surfacing — no new work signals, no adjacent reading material, no decaying concepts — the generator finalizes the briefing row with zero teaching pieces and a structured `metadata.reason` (`no_candidates`). The `/briefing/today` endpoint promotes that as `noContentReason` so the briefing page can render an explicit "no new content today" state instead of an empty shell. Failure paths (`all_pieces_failed`, `monthly_budget_exceeded`) use the same surface but render with warning styling.
