---
title: "API Endpoints"
subtitle: "Quick reference for all routes"
audiences: [developer, admin]
related:
  - reference/configuration
---

All API endpoints are mounted under `/api` and require authentication via Cloudflare Access headers.

Both manual generation (`POST /api/briefing/generate`) and the scheduled cron trigger use the user's saved settings from `PATCH /api/settings` — so filter changes, model overrides, and relevance thresholds apply to every briefing run, not just the preview.

## Briefing

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/briefing/today` | Get today's briefing with pieces and pending quiz. Each piece includes `source_context` (JSON array of source descriptors with `type`, `title`, `url`, `dueAt`, `dueReason`) plus optional `series_id` + `part_number` (set when the piece is in a multi-part series). The briefing object includes `redundantDrafts` — an array of entries describing topics the continuation classifier filtered as redundant during generation, each with `predecessor_id`, `predecessor_title`, `predecessor_briefing_date`, `predecessor_series_id`, `predecessor_part_number`, and `reason`. Empty array when nothing was filtered. |
| `GET` | `/api/briefing/:date` | Get briefing for a specific date (YYYY-MM-DD). Same shape as `/today`, including `redundantDrafts` and per-piece `series_id` / `part_number`. |
| `GET` | `/api/briefings` | List briefings with pagination (`?limit=10&offset=0`). Each row carries `pieceCount`, `pieceTitles` (top 3 piece titles for the day), and `topConcepts` (top 3 concepts surfaced across the briefing) so the Archive page can render a one-line thematic summary per briefing without N+1 fetches. |
| `GET` | `/api/briefings/dates` | Lightweight list of distinct briefing dates (newest first), the user's `retentionDays`, `earliestAllowed` (today − retention), `earliestRetained`, and `todayDate`. Powers the right-edge scroll-timeline scrubber on the briefing page and the calendar navigator on the archive page. Tiny payload (≈4 KB at default 365-day retention) so we don't paginate. |
| `POST` | `/api/briefing/generate` | Trigger manual briefing generation (deletes any existing briefing for today first — idempotent). Returns a streaming `application/json` body: an immediate space byte (resets Cloudflare's first-byte timer), space heartbeats every 25s, and the final result JSON when generation finishes. Heartbeats are pure whitespace so the body is still valid JSON — `apiPost`'s `res.json()` parses it directly. Avoids the 524 edge timeout on long runs. Generation is also pinned to `ctx.waitUntil`, so navigating away mid-run doesn't cancel the work — a `briefing_generation` notification (kind `briefing_generation`) is created at the start and transitions to `ready`/`failed` when the worker finishes, so the bell flips green even on a different tab. |
| `GET` | `/api/briefing/status` | Check if a briefing is currently generating; returns step, details, ETA, elapsed time, `cancelRequested`, and `stuck` (true when no progress for 3+ min) |
| `POST` | `/api/briefing/cancel` | Cooperative cancel; sets the `cancel_requested` column so the generator stops at the next checkpoint. Returns 404 if no briefing, 400 if not currently generating. Idempotent. |
| `POST` | `/api/briefing/reset` | Force-delete today's briefing row regardless of status — escape hatch for zombied generations. Returns `{ok: true, deleted: boolean}` |
| `GET` | `/api/briefing/:id/near-misses` | Get near-miss items for a briefing |
| `GET` | `/api/briefing/:id/work-context` | Get work context sources for a briefing |

## Pieces

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/piece/:id/feedback` | Submit feedback (`{ feedback: "positive" \| "negative" }`) |
| `POST` | `/api/piece/:id/read` | Mark a piece as read (updates exposure) |
| `GET` | `/api/piece/:id/deep-dive` | Get or generate deep-dive content for a piece (on-demand, cached after first generation) |
| `GET` | `/api/piece/:id/resources` | Get resources linked to a piece |
| `POST` | `/api/piece/:id/regenerate` | Regenerate a piece with a different model (`{ model: "claude-opus-4-..." }`). Updates in place, clears cached deep dive. |
| `GET` | `/api/piece/:id/audio` | Generate and stream TTS audio (MP3) for a teaching piece. Provider and voice come from the user setting by default; pass `?voice=<voice-id>` (any id from `/api/tts-models`) to override per request. Each voice is cached independently because the cache key includes the query string. |
| `GET` | `/api/piece/:id/deep-dive/audio` | Same as above, for deep dives. Also accepts `?voice=`. |
| `GET` | `/api/piece/:id/series` | List all parts of the series the piece belongs to, ordered by `part_number` ascending. Each part includes `id`, `title`, `part_number`, `created_at`, and `briefing_date` (used by the frontend to build `/briefing/{date}#piece-{id}` deep links). Standalone pieces (no series) get `{ seriesId: null, parts: [] }`. Lazy-fetched by the series-navigation strip and only when the piece has a `series_id` set. |
| `GET` | `/api/tts-models` | List available TTS models (filtered by which provider keys are configured) along with the default voice. |
| `POST` | `/api/me/focus` | Create a new focus statement version. Body: `{ statement: string, note: string }` — the `note` is **required** when the statement actually changed (the server enforces this so scripts and CLI calls hit the same contract as the UI). Idempotent — same statement returns the existing version without requiring a note. |
| `GET` | `/api/me/focus/history` | Newest-first timeline of all focus versions for the current user with `isCurrent` flag. |
| `POST` | `/api/me/focus/:versionId/restore` | Re-activates an old version by creating a new version row with the same statement (preserves history). |
| `DELETE` | `/api/me/focus/:versionId` | Removes a non-current historical version. Concepts/briefings tagged with it become untagged. Refuses to delete the current version. |
| `GET` | `/api/me/focus/:versionId/analytics` | Aggregations for a single focus version: concepts created/suppressed, suppression rate, briefings, teaching pieces, category mix, source-type mix, positive feedback rate. |
| `POST` | `/api/me/about` | Create a new About / persona statement version. Body: `{ statement: string, note: string }` — `note` is **required** on any actual change (server-enforced). Idempotent — same statement returns the existing version without requiring a note. |
| `GET` | `/api/me/about/history` | Newest-first timeline of About versions. |
| `POST` | `/api/me/about/:versionId/restore` | Restore by creating a new version with the same statement. |
| `DELETE` | `/api/me/about/:versionId` | Remove a non-current About version. Refuses to delete the current version. About has no concept attribution to clean up. |
| `GET` | `/api/me/about/:versionId/analytics` | Time-window aggregations for an About version: concepts/briefings/pieces created during the version's active period + positive feedback rate. |
| `POST` | `/api/me/refine-prompt` | AI-assisted refinement. Body: `{ kind: "about" \| "focus", draft: string }`. Returns `{ refined, rationale }` — a tightened, prompt-ready rewrite from Claude Sonnet 4 plus a one-line explanation of what changed. Does not save. |
| `POST` | `/api/concept/:id/suppress` | Mark a concept as not-interested. Excludes from trails, briefings, and future extractions. |
| `POST` | `/api/concept/:id/unsuppress` | Reverse a previous suppression. |
| `POST` | `/api/concepts/reset` | Wipe the user's concept graph (concepts, depth, history, relations, artifacts). Briefings preserved. |

## Concepts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/concepts` | List all concepts (`?sort=depth&order=desc&category=...`) |
| `GET` | `/api/concept/:id` | Get concept detail with relations and artifacts |
| `GET` | `/api/concept/:id/history` | Get depth change history for sparkline |
| `GET` | `/api/concept/:id/articles` | Get teaching pieces that covered this concept |
| `GET` | `/api/concepts/graph` | Get full concept graph (nodes + edges) |

## Quiz

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/quiz/next` | Get next pending quiz question |
| `POST` | `/api/quiz/:id/answer` | Submit quiz answer (`{ answer: "..." }`) |
| `POST` | `/api/quiz/:id/skip` | Skip a quiz question |
| `GET` | `/api/analytics/usage` | Token + audio-character breakdown from the unified `usage_events` ledger over a window (default 30 days, max 365). Returns `{ totals, byOperation, byModel, byOperationModel, byDay, currentTtsCharsInWindow, ttsCatalog }`. Each cut carries `{ calls, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, audioChars, costUsd }`. The `ttsCatalog` field ships every catalog voice's `{ id, label, provider, costPer1kChars }` so the analytics page can compute per-provider TTS spend projections client-side without a second fetch. |
| `GET` | `/api/quiz/baseline` | Get baseline calibration questions (up to 6). If a `baseline_calibration` notification is currently in flight, returns `{ generating: true }` instead of starting a duplicate inline generation; the frontend polls until the notification flips to `ready`. |
| `GET` | `/api/quiz/baseline/status` | Read-only snapshot of the user's baseline-calibration state. Returns `{ status, conceptCount?, startedAt?, recent? }` where `status` is one of `idle` / `generating` / `ready` / `assessing` / `complete`. Drives **two** mount-aware surfaces: (a) the **Start calibration** button on the Concepts page, which surfaces `idle` / `generating` / `ready` so the loading view survives navigation, and (b) the `/calibrate` page itself, which uses `assessing` / `complete` to *resume* a recently-submitted batch — the user can answer questions, navigate away during LLM assessment, and come back to the same per-question overview without re-entering the question flow. The `recent` field carries `{ questions: [{id, conceptId, concept, assessedDepth, previousDepth}], pendingCount, submittedAt }`. **Self-heals stuck notifications**: if pending baseline rows exist but a `baseline_calibration` notification is still `in_progress`, the GET handler transitions it to `ready` right there — covers the edge case where the prepare endpoint's `waitUntil` lost its transition (worker termination, transient D1 hiccup) and the bell would otherwise show "pending" forever. |
| `POST` | `/api/quiz/baseline/prepare` | Kick off async baseline question generation. Spawns an `in_progress` notification (`kind = "baseline_calibration"`) and runs generation under `ctx.waitUntil` so the user can navigate away. Idempotent — re-calling while a row is in flight is a no-op and returns the existing notification. Body accepts `{ category? }`: when set, the batch is scoped to one trail (e.g. `"infrastructure"`) and pulls the lowest-depth concepts in that trail. Empty body falls back to the cross-trail "lowest depth globally" pool. The 6-question cap (`BATCH_LIMIT`) applies either way. Returns `{ status: "in_progress" \| "ready" \| "no_concepts", notificationId, conceptCount, category }`. |
| `POST` | `/api/quiz/baseline/batch` | Submit all baseline answers at once |

## Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/settings` | Get current user settings (filters, models, thresholds) |
| `PATCH` | `/api/settings` | Update settings; accepts camelCase, deep-merges `signalSurfaceMap` |
| `POST` | `/api/settings/preview/linear` | Preview Linear issues that match the given filters (independent request, shows its own progress) |
| `POST` | `/api/settings/preview/slack` | Preview configured Slack channels (instant, no API call) |
| `GET` | `/api/settings/preview/incidents` | Preview active incidents from incident.io |
| `POST` | `/api/settings/preview` | Combined preview across all three sources in one request (used by legacy callers) |
| `GET` | `/api/slack/channels` | List all public Slack channels the app has access to |
| `GET` | `/api/linear/teams` | List Linear teams in the workspace |

## Models

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/models` | Returns the available LLM models filtered by which providers are configured on the worker (`isProviderConfigured(provider, env)` from the LLM dispatcher — registered adapter AND env key set). Catalog entries from providers without an adapter or without their key never reach the UI. Today Anthropic Claude (gates on `ANTHROPIC_API_KEY`) and OpenAI GPT-5 nano / mini / full (gates on `OPENAI_API_KEY`) surface; Google / Workers AI / OpenRouter light up automatically as their adapter entries land in `LLM_ADAPTERS`. Each model entry carries `provider`, `tier`, full pricing (input/output/reasoning/cache rates), reasoning capability, tool support, JSON-mode support, and context window — enough metadata for the per-operation `<optgroup>`-grouped picker in Settings → AI Models. |

## Bookmarks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bookmarks` | List all bookmarks with piece title, briefing date, scroll/audio positions, and an optional `contextSnippet` (~260-char excerpt extracted from the bookmarked block; the BookmarksPage clamps it to 3 lines so the row stays bounded). Snippets are NULL on legacy bookmarks whose source piece's content has been pruned by retention. |
| `GET` | `/api/bookmark/:pieceId` | Get bookmark for a specific piece (if exists) |
| `PUT` | `/api/bookmark/:pieceId` | Upsert a bookmark (type, scrollPosition, audioPosition, note) |
| `DELETE` | `/api/bookmark/:pieceId` | Remove a bookmark |

## Analytics

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/analytics/briefings?limit=N` | Last N briefings with per-step timings — each step row includes `stepKey`, `startedAt` (ISO), `finishedAt` (ISO), `durationMs`, `itemsProcessed`, `modelUsed`, and arbitrary metadata. The absolute timestamps are what enable the trace-waterfall view on the Analytics page (offset = `startedAt − earliest`, width = `durationMs`). Default 30, max 100. |
| `GET` | `/api/analytics/performance?days=N` | Aggregate avg/p50/p95 duration per (step, model) over the window, plus briefing totals and daily cost trend (default 30 days, max 365). Cost data is rolled up from the unified `usage_events` ledger and surfaced per-day broken out by `byProvider` and `byModality`, plus a `monthlyByProvider` / `monthlyByModality` summary so the analytics frontend can render stacked spend bars and per-provider summary cards. |
| `GET` | `/api/analytics/learning?days=N` | Concept count, depth distribution, concepts added by day, top movers (depth delta), quiz/feedback counts |

## Chat

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chat/threads` | List the user's chat threads |
| `POST` | `/api/chat/threads` | Start a new chat thread |
| `GET` | `/api/chat/threads/:id` | Get a thread with its messages |
| `DELETE` | `/api/chat/threads/:id` | Delete a thread |
| `POST` | `/api/chat/threads/:id/messages` | Send a message and get the AI response (non-streaming, blocks until full reply is ready) |
| `POST` | `/api/chat/threads/:id/messages/stream` | Same as above but streams the reply over Server-Sent Events. Each SSE chunk includes the partial assistant content; the final `done` event has the persisted message ID. Used by the chat panel to render replies progressively. |
| `GET` | `/api/chat/messages/:messageId/audio` | Generate and stream TTS audio (MP3) of an **assistant** chat message. The endpoint refuses user messages, strips markdown (fenced code blocks, links, list markers, headings) before voicing, caps at 8000 chars, and accepts `?voice=<voice-id>` like the piece audio endpoints. Each voice is cached independently because the cache key includes the query string. |

## System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check with integration status |
| `GET` | `/api/me` | Current user info and settings |
| `GET` | `/api/stats` | Overall stats (concepts, briefings, spend) |
| `GET` | `/api/stats/weekly` | Weekly activity summary |
