---
title: "Analytics"
subtitle: "How long Primer takes, where the time goes, and how your learning is progressing"
audiences: [user, admin]
related:
  - reference/configuration
  - reference/ai-models
  - briefings/how-generation-works
---

The **Analytics** page (`/analytics`) gives you a feedback loop on the two things that matter most when tuning Primer: how fast your briefings are, and how well your learning is progressing.

## Window Selector

A 7d / 30d / 90d / 1y toggle at the top filters every chart and stat. The default is 30 days.

## Performance

### Summary cards

- **Avg briefing** — average end-to-end briefing duration in the window, with a trendline of recent runs.
- **API cost** — total spend across all configured AI providers over the window (from the unified `usage_events` ledger), bar chart by day. Stacks by provider when more than one is configured, and breaks out text vs audio modality in the monthly summary.
- **Concepts added** — count of new concepts extracted in the window, bar chart by day.

### Per-step timing by model

A table of every pipeline step (work_context, concepts, adjacent, selecting, generating_pieces, teaching_piece, quiz, finishing), broken down by which model was used. For each row you see:

- **avg / p50 / p95 / max** duration
- **n** — number of runs in the window
- **items total** — how many items the step processed (Linear issues, concepts, teaching pieces, etc.)

This is the table to watch when tuning. Switch concept extraction from Sonnet to Haiku in **Settings → AI Models**, generate a few briefings, and you'll see the row split into two — letting you compare directly. Same applies to filter changes (narrower Linear filters → smaller `items_total` and faster `concepts` runs).

## Token + audio usage

A second feedback loop, paired with the per-step timing table above. Pulled from the same `usage_events` ledger that drives the cost trendline, but exposed at full granularity so you can answer three different questions:

### Aggregate totals

Four cards across the top: total **calls**, **input tokens**, **output tokens** (with reasoning tokens called out separately when present), and **audio chars** in the selected window. The bottom-line view — useful for the "are we trending up?" gut check.

### By use case

A table grouped by **operation**: `concept_extraction`, `teaching_generation`, `chat_title`, `audio_teaching_piece`, etc. Sorted by spend. Each row carries calls / input tokens / output tokens / audio chars / cost. This is the table to watch when **tuning prompts**: if you see `concept_extraction` consuming 4× the input tokens of `teaching_generation`, the extraction prompt is probably bloated and worth tightening.

### By model

A roll-up across operations, grouped by `(provider, model, modality)`. Sorted by spend. Same columns as "By use case". This is the table to watch when **deciding which model to tier down**: a model with high call volume but low tokens-per-call (like `chat_title`) is a great Haiku candidate.

### Daily volume

Three side-by-side bar charts: input tokens / output tokens / audio chars per day. Each shows the window total above the bars. Useful for spotting traffic spikes (e.g. you generated five deep dives on a single day) and projecting future spend.

### What if I switched TTS provider?

Below the daily charts, a projection table that takes your current TTS character volume in the window and projects what spend WOULD be on every catalog voice. Sorted ascending so the cheapest options are at the top. Each row shows:

- **Per 1k chars** — that voice's catalog rate (`costPer1kChars`)
- **Projected** — your current char volume × that rate
- **Δ vs current** — the dollar delta against your CURRENT TTS spend in the window. Negative (green) = savings, positive (red) = increase

Use this to answer questions like "if I swapped all teaching-piece audio to ElevenLabs Turbo for the warmer voice, what would my monthly TTS spend be?" The per-day cost in the voice's metadata helps extrapolate ("this voice would be ~$0.40/day, ~$12/mo at this volume").

The projection assumes the same character volume — it doesn't model retention / engagement changes from a better-sounding voice. Treat it as a budget-planning aid, not a strict ROI calculation.

### Recent briefings (trace waterfall)

The 10 most recent briefings, each rendered as a **trace-waterfall** view modeled after Datadog / Honeycomb / Jaeger trace UIs. The view distinguishes two kinds of rows so a user reading the chart can immediately tell what each row represents:

- **Backbone rows** — pipeline stages that run **once per briefing** (`work_context`, `slack_filter`, `concepts`, `adjacent`, `selecting`, `generating_pieces`, `quiz`, `finishing`). Solid bars at their start offset; bar width = duration. Right column shows the absolute duration.
- **Iterative rows (×N)** — step kinds that recur multiple times per briefing (today only `teaching_piece`, which runs once per generated piece — typically 4×, in parallel inside `generating_pieces`). These collapse into **one summary row** with:
  - a `×N` count badge next to the label,
  - a striped bar spanning the wall-clock range from the first child's start to the last child's end (so the bar reads as "multiple things happening here" rather than as one long monolithic operation),
  - **avg** in the right column (rather than a sum that double-counts parallel work),
  - a click-to-expand affordance that reveals each iteration as a thin, indented child bar underneath the summary.

This avoids the old failure mode where a 50-piece briefing would render 50 individual `Each teaching piece` rows dwarfing the 8 backbone rows.

Together the two row kinds reveal the actual structure of the run:

- Sequential steps line up end-to-end.
- **Parallel iterations** show up immediately in the striped span — and you can drill into the per-iteration timings on demand.
- A time axis at the bottom shows ticks at natural unit boundaries (200ms / 500ms / 1s / 2s / 5s / 10s …) picked dynamically based on the run's total span.

Hover (or focus, for keyboard users) any bar to surface a tooltip:

- **Backbone tooltip** — `duration`, `started at` (offset from t=0), `model`, `items processed`.
- **Fanout summary tooltip** — `count`, parallel-aware `span`, `avg`, `p50`, `p95`, `max`, plus a hint to click to expand.
- **Iteration tooltip** (when expanded) — duration + start offset + model for that single iteration.

Bars are focusable `<button>` elements with descriptive `aria-label`s so the same info is reachable via screen reader.

Colors are picked for **maximum hue separation** at the same lightness/saturation so adjacent rows of different step kinds are immediately distinguishable: blue (work_context), amber (slack_filter), violet (concepts), emerald (adjacent), gray (selecting), red (generating_pieces), teal (teaching_piece), pink (quiz), lime (finishing). Unknown steps fall back to neutral zinc. There's no shared legend — each row labels itself directly, which scales as the pipeline gains more step kinds.

Backed by absolute `startedAt` / `finishedAt` ISO timestamps on each row of the `/api/analytics/briefings` response (added so the frontend can compute true offsets, not just stack durations). Multi-row step kinds are detected client-side from the response — any future step that the backend writes more than one row for in a briefing automatically collapses into a fanout summary without UI changes.

## Learning

### Summary cards

- **Concepts tracked** — total nodes in your concept graph
- **Quizzes completed** — count + cumulative depth gain attributed to quiz answers in the window
- **Feedback** — positive / negative thumb counts on teaching pieces

### Depth distribution

A horizontal bar chart of concepts grouped by their current rounded depth (Unknown → Aware → Understands → Applies → Teaches → Authoritative). Watch the distribution shift right over time as you engage.

### Top movers

The 10 concepts whose depth has changed the most in the window — both up and down (decay-induced drops show up here too). Sorted by absolute delta.

## Per-statement analytics (Settings)

In addition to the global analytics page, **Settings → About you / Current focus → View history** opens a per-version analytics view. Each version row in the timeline shows:

- Concepts created / suppressed under that version
- Briefings + teaching pieces generated while it was active
- Category distribution of extracted concepts (Focus only)
- Suppression rate — % of concepts created under this Focus version that you later suppressed (a high rate signals the Focus statement isn't filtering well)
- Positive feedback rate on teaching pieces written during the version's active window

This is the feedback loop for refining your Focus and About statements. If a Focus version's suppression rate is consistently above 25% on runs of 5+ concepts, the modal flags it and nudges you to refine.

## Where the data comes from

- **Per-step timings** are recorded by the briefing generator into `briefing_timings` (added in migration 0005). One row per pipeline step, plus one row per generated teaching piece.
- **Concept depth changes** come from `concept_depth_history` — every depth update writes a row, with `change_source` tagging the cause (extraction, quiz, feedback, decay, baseline, manual).
- **Cost** comes from the unified `usage_events` ledger, which tracks every billable AI call across providers and modalities — LLM tokens (input/output/reasoning/cache) and TTS character counts in one table so analytics, monthly budget caps, and per-piece audit trails all read from the same source of truth.
- **Per-Focus-version concept attribution** comes from `concepts.focus_version_id` (migration 0009), stamped at extraction time. **Per-About-version analytics** uses time windows derived from the `about_statement_versions.created_at` timeline (migration 0010); concepts and briefings are not attributed to About versions because About is a stylistic signal, not a topic-selection one.

All analytics are user-scoped — your data never bleeds across users.

## Retention

Timing rows are kept for 365 days alongside briefings (matching `RETENTION_DAYS`). Concept depth history is retained indefinitely so long-term trends are recoverable.
