# Day-to-Day Usage

This is the in-depth user guide for Primer's reading surface — briefings, deep dives, calibration, chat, audio, settings, keyboard shortcuts, and the analytics page. The [README](../README.md) covers the high-level shape; this file covers the per-feature behavior.

For per-page user-facing documentation served inside the app, see `src/frontend/help/` (rendered at `/help` in the running deployment).

## Reading Briefings

Visit the root page to see today's briefing. Each briefing contains:
- A date heading and source counts (Linear / Slack / incidents / GitHub) — clean and minimal, no time-of-day greeting
- 3–5 teaching pieces, each calibrated to your depth, with:
  - **Origin badge** — colored pill showing where the piece came from: "From your work" (green, driven by Linear/Slack/incidents), "From feeds" (yellow, driven by HN/ArXiv/CNCF), or "Refresher" (grey, decay recalibration)
  - **Source provenance box** — shows the specific Linear ticket, Slack thread, or external article that triggered the piece, with clickable links
  - **"Go deeper"** button — generates an extended deep dive on demand with inline diagrams and code blocks woven into the narrative
  - **Listen** button — text-to-speech via Cloudflare Workers AI (12 Deepgram Aura speakers + MeloTTS), OpenAI TTS (`tts-1` / `tts-1-hd` with 6 voices — Alloy, Echo, Fable, Onyx, Nova, Shimmer), and ElevenLabs (Rachel / Adam / Domi / Antoni across multilingual / turbo / flash tiers). Provider/voice selectable in Settings → Intelligence → Voice, or per-surface via the small `voice: <name> ↻` affordance next to every Listen control. Available on **teaching pieces, deep dives, and chat replies** — same shared TTS pipeline, voice changes broadcast across all open pickers via `primer:tts-voice-changed`. OpenAI voices require the `OPENAI_API_KEY` secret; ElevenLabs voices require `ELEVENLABS_API_KEY`. Audio generates on demand, chunked + streamed in parallel for fast time-to-first-byte. The MP3 response carries `Cache-Control: public, max-age=86400`, so re-listens within 24 hours hit Cloudflare's edge HTTP cache (and the browser cache) and short-circuit the Worker entirely — no TTS-provider call, no `usage_events` row, no cost. The cache is keyed by the full URL including `?voice=<id>`, so each voice gets its own entry; switching voices forces a fresh generation. Audio bytes are never persisted to D1, R2, or KV — only the lightweight `usage_events` row (provider, voice, character count, cost) is written on a fresh generation.
  - **Audio transport controls** — every Listen player has flanking skip-back / skip-forward buttons (±15s, with `Shift` modifier for ±5s), a draggable playhead thumb on the progress bar (drag-to-scrub commits on release so streaming audio doesn't re-buffer per-pixel), and a playback-speed cycle button (0.75 / 1 / 1.25 / 1.5 / 1.75 / 2× — persists across sessions in localStorage and syncs across every open player via the `primer:audio-rate-changed` window event). Keyboard shortcuts when focused: Space, ←, →, Home, End, `[`, `]`. While streaming TTS where total duration isn't known yet, the bar shows an empty track plus a single pulsing leading-edge dot — no misleading marquee — and the elapsed-time readout to the right is the actual progress signal.
  - **Audio outros** — when the audio finishes, a short closing line plays so playback doesn't end abruptly. Briefing pieces invite you to "tap Go deeper" if you want more (the wording adapts based on whether the deep dive is already generated). Deep dive audio ends with *"Hope you found it helpful. Thanks for listening."* The body is auto-trimmed to ensure the outro always plays in full.
  - **Speech-to-text** — every microphone button across the app (quiz answers + chat input) runs in **continuous voice mode**: tap to start, talk freely, tap again to send. Or just stop talking — the session **auto-stops after 5 seconds of silence**. Pressing **`Esc`** while the mic is live also stops it instantly without dismissing the surrounding panel (capture-phase keydown + `stopImmediatePropagation` so a single Escape stops the mic only; a second Escape closes the modal/chat as usual). Live transcript appears as you speak; the field is read-only while listening so typing doesn't fight the live transcript. Auto-restart through silence (works around the Chromium silence-detector quirk that would otherwise terminate every 1–2 seconds). Uses the browser's Web Speech API (Chrome/Edge/Safari). No API key needed.
  - **Paragraph bookmarks** — hover any paragraph to see a bookmark icon in the left margin. Click to pin that spot. Bookmarks persist server-side and show on the Bookmarks page.
  - **Generation timestamp** — each piece shows when it was generated (e.g. "3:31 PM")
  - **Inline diagrams and code** — mermaid diagrams and syntax-highlighted code blocks appear inline within the article flow. Code blocks render via Prism with a line-number gutter, a copy button, and a per-block light/dark toggle that's independent of the site theme (cycle `auto → light → dark → auto`); the choice persists in localStorage and syncs across all code blocks on the page. Inline code (single backticks) renders as a neutral pill — mono font, warm background, thin border — so it reads as a literal value distinct from links.
  - **Reader-aware code routing.** Teaching pieces and deep dives route their use of code on signals from your **About you** statement. Technical readers get inline `code` for command names + config keys plus code-block snippets where they earn their space (always with a `language` tag so the block syntax-highlights correctly). Non-technical readers (PMs, designers, ops, sales, leadership) get prose-first explanations, mermaid diagrams instead of code where possible, and code only when the source material genuinely contains it — always with a one-line plain-English intro. Update your About statement and the next briefing's pieces will recalibrate.
  - **Verifiable citations** — links point to specific docs pages, blog posts, RFCs, and GitHub repos, never to company homepages or Wikipedia. Uncertain claims are qualified rather than asserted.
  - **Model regeneration** — the footer shows which model generated the piece (e.g. *"Generated with Claude Sonnet 4"*) and offers "↻ try different model" to regenerate with any model from any configured provider for direct quality comparison. The picker reads from `/api/models`, so as new providers light up they appear here automatically.
- A work context bar showing what sources were consulted
- A calibration quiz
- Near misses (items that almost made the threshold)

## Feedback

Thumbs-up on a piece adds +0.2 depth to associated concepts. Thumbs-down signals poor targeting without penalizing your depth. A toast shows the exact delta.

## Continuations and series

When a topic produces a follow-up piece, Primer chains the two into a **series**. The earlier piece is retroactively labeled **Part 1**, today's piece becomes **Part 2** (or 3, 4, ...), and the new body opens with an explicit callback ("Last time we looked at X. Today...") rather than recapping. Both parts get a small `Part N of M` badge next to the title and a subtle previous/next strip above the body so you can navigate the series without bouncing through the archive. On Part 2+ in *today's* briefing, a tiny green `new` pill flags the continuation; once the briefing rolls forward, only the regular badge remains. Today's drafts that turn out to be near-duplicates of recent pieces are filtered as **redundant** and surfaced as a small "no new movement on these topics" chip in the briefing header — each entry deep-links back to the predecessor so you can verify what was already covered. The classifier is conservative (lookback 30 days, biased toward NOVEL) and fails open: any error treats the draft as standalone rather than dropping it. Series state lives on `teaching_pieces.series_id` + `part_number` (migration 0012); redundant entries live on `briefings.redundant_drafts` (JSON). The lazy-fetched `GET /api/piece/:id/series` endpoint powers the navigation strip.

## Deep Dives

Click "Go deeper" on any teaching piece. Primer generates 800–1,500 words of extended content on demand, with a progress panel showing what it's working on. Once generated, the deep dive is cached — revisiting loads instantly. Regenerating the base piece with a different model clears the deep dive cache so the next click produces fresh content.

Generation runs server-side via Cloudflare's `ctx.waitUntil`, so you can navigate away mid-generation and the work continues. A **notification appears in the header bell** the moment you click "Go deeper" — pulsing accent dot while in flight, unread badge when the deep dive is ready (click to jump straight to it). The Sunday 3 AM UTC maintenance cron sweeps any in-flight notification that hasn't moved for 5+ minutes and flips it to `failed`, so a dead-worker scenario eventually shows up as a real failure in the bell instead of an indefinite spinner. See [Notifications](#notifications) below for the full read.

## Baseline Calibration

When 3+ concepts are below depth 2, the Concepts page shows a "Start calibration" prompt. Clicking it generates up to 6 open-ended quiz questions targeting your lowest-depth concepts. Answer them in one batch to quickly establish accurate depth baselines — much faster than waiting for one daily quiz per concept.

The 6-question cap is intentional — past 6, completion rates drop and answer quality with it. If you have 30 unverified concepts, you run ~5 sessions; the CTA shows the remaining count inline (`Start calibration (6 of 30) →`) so you can pace yourself, and a notification fires when each batch finishes assessing.

**Calibration scopes**: calibration is exposed at two levels. The cross-trail "Start calibration" CTA picks the lowest-depth concepts globally, while each **trail header** in the Concepts trails view has its own "Calibrate trail (N) →" CTA that scopes the batch to that trail (Infrastructure, Observability, etc.). Same 6-question cap, single-batch-at-a-time semantics. Useful when you want every question to land on the area you're focused on instead of a random global cross-section.

While questions generate, the button stays in a "preparing" state and a `baseline_calibration` notification tracks progress; you can navigate away and the bell flips green when the quiz is ready. After answering, the post-submit overview shows the LLM's per-concept reasoning inline so you can see where you scored well and where you have gaps — no need to dig into the quiz history to find the explanation.

## Concepts Page

The default **Learning Trails** view groups concepts by category (Infrastructure, Security, Observability, Platform, etc.) — each trail shows a summary header with concept count, average depth, and a depth distribution bar. Trails are ordered by most recent activity so your current work area is always at the top. Switch to the flat **All** view for a single sorted list. Within each view, sort by depth, name, or exposure count.

## Bookmarks

Click the bookmark icon on any teaching piece to save it. Primer tracks your reading position (scroll percentage) and audio playback position automatically. Visit `/bookmarks` to see all your saved pieces and in-progress reads. When you return to the briefing page, a small "pick up where you left off" affordance appears with a link to your most recent in-progress piece.

## Archive & history navigation

Two complementary surfaces:

- **Briefing page** — below today's content, an infinite-scroll **Earlier briefings** timeline with a minimal **week-scoped scrubber** along the right edge (≥1024px viewports, where the App-level layout reserves a clear right gutter via `lg:pr-16`). One small dot per day for the **last 7 days** — filled when the date is in view, hollow otherwise. A dark "Thursday, Apr 23"-style tooltip floats next to the active dot. Auto-fades on scroll, click + drag to jump to a day, drag scrubbing lazily loads pages as needed.
- **Archive page (`/archive`)** — calendar-driven **week window** for *intentional* navigation through older history. Always shows one week (Mon–Sun) of briefings in reverse chronological order. Step ±1 week with arrows, jump to any week via a monthly calendar popover, snap back to "this week" with one click. Days with briefings show a dot in the calendar. Retention boundary (default 365 days) is enforced visually — outside-retention dates are greyed out everywhere.

The two surfaces are **complementary, not redundant**: the rail is for *recent* navigation (last week's worth, accessible in one tap); the calendar is for *intentional* navigation (any week within retention). Both share `GET /api/briefings/dates`, a tiny payload (≈4 KB at default retention) that returns the user's distinct briefing dates plus retention metadata.

## Analytics

The `/analytics` page gives you a feedback loop on tuning.

**Performance** shows avg/p50/p95 duration per pipeline step broken down by model — so you can see directly whether switching concept extraction from Sonnet to Haiku actually shaved time, or whether narrowing your Linear filter reduced your work-context fetch. It also tracks total briefing duration and AI cost trends — when multiple providers are configured, costs stack by provider so you can see who's spending what.

**Token + audio usage** is a complementary feedback loop on the same `usage_events` ledger, exposed at full granularity. Three cuts:

- **By use case** — calls / input tokens / output tokens (with reasoning tokens called out) / audio chars / cost per `operation` (`concept_extraction`, `teaching_generation`, `chat_title`, `audio_teaching_piece`, etc.). Sorted by spend desc. The table to watch when **tuning prompts** — if `concept_extraction` is consuming 4× the input tokens of `teaching_generation`, the extraction prompt is bloated and worth tightening.
- **By model** — same shape, grouped by `(provider, model, modality)`. The table to watch when **deciding which model to tier down** — a model with high call volume but low tokens-per-call is a great Haiku candidate.
- **What if I switched TTS provider?** — projection table that takes your current TTS char volume in the window and projects what spend WOULD be on every catalog voice (Cloudflare Aura, OpenAI tts-1 / tts-1-hd, ElevenLabs Multilingual / Turbo / Flash). Sorted ascending. Each row shows the per-1k rate, projected cost, Δ vs current spend (negative = savings, positive = increase), plus a per-day rate so you can extrapolate monthly spend. Useful when deciding whether to swap to a slicker / cheaper voice without committing to the change first.

**Recent briefings** is a **trace-waterfall** view (Datadog/Honeycomb-style) of the last 10 runs. Each pipeline step is its own row; bar offset is the wall-clock delta from the briefing's earliest step start, bar width is the duration. Sequential steps line up end-to-end; parallel steps (e.g. 5 concurrent teaching pieces inside `Writing teaching pieces`) overlap visibly. Hover or focus any bar for a tooltip with step name, duration, start offset, model used, and items processed. Colors are picked for maximum hue separation: blue / amber / violet / emerald / gray / red / teal / pink / lime — no shared legend (each row labels itself directly, which scales cleanly when more step kinds get added).

**Learning** shows concept count growth, depth distribution, top movers (concepts whose depth changed most), quiz completions, and feedback volume. Per-step timings are stored in `briefing_timings` (migration 0005) — one row per pipeline step plus one per teaching piece, with absolute `started_at` / `finished_at` timestamps that drive the waterfall offsets.

## Avatar menu and Settings

Click your **avatar** in the top-right corner to open a small dropdown menu:

- **Set focus** — express-lane editor for your Current focus statement. Shows a 2-line preview of your current focus right in the menu, so you can confirm what's active without opening anything. Clicking opens a quick editor (current statement pre-filled, optional note, ✨ Refine with AI, save as new version). This is the canonical surface for keeping focus current.
- **Settings** — opens the full Settings panel for everything else.

The first time you ever load Primer, a **two-step onboarding wizard** automatically appears asking you to write your About + Focus statements (with Skip-for-now if you want to look around first). Without these, briefings read like generic industry-news summaries — strongly recommended not to skip.

The Settings panel itself is sidenav-driven. Entries are grouped into four sections: **Sources / Intelligence / Personalization / General**. A search bar above the sidenav filters entries by label and keyword; the footer carries the **Build full briefing preview** button.

In the Settings panel you can:

- Write an **About you** statement — a stable persona paragraph (role, experience level, communication preferences). Used to tailor voice and depth across **all** of Primer's AI: teaching pieces, deep dives, chat, quizzes, feed relevance scoring, and concept extraction. Versioned with history.
- Edit your **Current focus** statement (same editor as the avatar menu's Set focus) — a short paragraph telling the system what you work on and want to learn about right now. Saved as a new version every time you click **Save as new version**. View history opens a modal with a timeline of every version, inline diffs, and per-version analytics (concepts created, briefings, suppression rate, positive feedback rate). Restore old versions, delete unwanted ones.
- Both About and Focus have an **✨ Refine with AI** button that asks Claude to rewrite your draft into a tighter, prompt-ready paragraph. You see the diff and accept or keep yours.
- Set your **GitHub username** for avatar lookup and PR/issue context. Password-manager autofill is suppressed on this field — it's a profile preference, not a credential.
- **Reset concepts** — wipe your concept graph to start fresh under your current focus statement. Past briefings and teaching pieces are preserved.
- Configure which Linear issues (assigned, subscribed, in team projects), statuses, teams, and time window feed into your briefings
- Pick which Slack channels Primer should read and how many days of history to pull. Optionally also include any message reacted with `:bookmark:` — bookmarked messages bypass the noise/brevity filters, sort to the top of the work-context bar, and carry a 🔖 prefix so you can spot team-flagged signal at a glance.
- Override the model used for each operation (teaching pieces, deep dives, concept extraction, chat, continuation classifier, etc.) — the picker groups options by provider via `<optgroup>` headers, with each provider's group only visible when its API key is configured. See **AI Models** below; configured under **Settings → Intelligence → AI models**.
- Adjust the relevance threshold that controls teaching piece selection
- Set your monthly API budget cap
- Preview which sources match your filter settings before they're used — clicking **Build full briefing preview** in the Settings footer runs every source's fetch in parallel and surfaces the in-scope items inside each source's panel (Linear, Slack, GitHub, incident.io, Feeds). The button label flips to **Rebuild — filters changed** the moment you change anything after a preview.

On the **Concepts page**, every concept row has a small `✕` "not interested" button — clicking it suppresses the concept (hidden from trails, excluded from future briefings, never re-extracted by the LLM). The **Show suppressed** toggle reveals what you've muted with one-click un-suppress.

All changes auto-save with a 500ms debounce. The preview does not auto-run — click **Build full briefing preview** explicitly; when filters change, the footer button flips to **Rebuild — filters changed** so you know the previous preview is stale.

## AI Models

Primer's LLM layer is provider-agnostic at the seam. Every call goes through a normalized `LLMClient` interface (`src/worker/integrations/llm/`), and a **dispatcher registry** (`integrations/llm/dispatcher.ts`) routes each request to the right adapter based on `spec.provider`. Two adapters are wired in today — **Anthropic Claude** (Haiku 4.5 / Sonnet 4 / Opus 4) and **OpenAI** (GPT-5 nano / mini / full) — and additional providers (Google, Workers AI, OpenRouter) slot in by adding one entry to `LLM_ADAPTERS` plus one adapter file. Service code, the `/api/models` route, and the Settings picker all light up automatically once a provider's entry registers.

The dispatcher exposes `isProviderConfigured(provider, env)` and `getConfiguredProviders(env)` — same shape as the TTS dispatcher. The `/api/models` route uses these to filter the catalog so the picker only ever shows models from providers that are (a) registered AND (b) have their env keys set. Settings → Intelligence → AI models then renders each per-operation dropdown with `<optgroup>` headers — one group per provider — via the shared `ProviderGroupedSelect` component (also used by Settings → Intelligence → Voice). The two pickers read identically because they share the same component plus the same gating philosophy.

The model catalog (`src/worker/config/models.ts`) is the single source of truth for catalog entries: each carries provider, tier, full pricing (input / output / reasoning / cache rates), reasoning capability, tool support, and context window. Cost estimation, the per-piece "Generated with X" footer, the analytics waterfall, and the Settings model picker all read from this same list.

Each AI operation uses a configurable model. Defaults are tuned for cost/speed/quality balance:

| Operation | Default | Notes |
|-----------|---------|-------|
| Teaching pieces | Sonnet 4 | User-facing content, quality matters |
| Deep dives | Sonnet 4 | Long-form, nuanced explanations |
| Quiz assessment | Sonnet 4 | Needs nuance to grade open-ended answers |
| Chat | Sonnet 4 | Conversational reasoning |
| Concept extraction | Haiku 4.5 | Structured task, parallelizes well |
| Adjacent scoring | Haiku 4.5 | Pure ranking, high throughput |
| Quiz generation | Haiku 4.5 | Short structured output |
| Continuation classifier | Haiku 4.5 | Per-draft NOVEL / ADDITIVE / REDUNDANT call; one short JSON output is plenty |

Override any operation from **Settings → Intelligence → AI models**. Haiku 4.5 is fastest and cheapest; Sonnet 4 is balanced; Opus 4 is highest quality but slower and more expensive.

Every generated teaching piece shows the model used at the bottom (e.g. "Generated with Claude Sonnet 4") and the model is stored per artifact in the database for a full audit trail.

## Chat

Click the chat button (bottom-right corner) to open a conversational interface for exploring your Primer data. Chat has read access to your concept graph, briefing history, quiz results, and work signals from Linear, Slack, and incidents — so you can ask targeted follow-up questions without leaving the app.

Chat is strictly read-only: it can look things up and reason about your data, but it cannot create tickets, post messages, or take any external action. It's scoped to your Primer learning context and will not answer general-purpose questions.

Conversations are saved as threads. Threads older than 30 days are automatically compacted into summaries, and threads older than 90 days are deleted. Chat messages count toward the monthly AI budget (`BUDGET_CAP_MONTHLY`), which spans every configured LLM and TTS provider via the unified `usage_events` ledger.

## Notifications

The bell icon in the header tracks background work the system kicks off on your behalf. Two kinds are wired up today:

- **`deep_dive`** — clicking "Go deeper" on a teaching piece spawns an `in_progress` notification, runs generation under `ctx.waitUntil`, and flips the row to `ready` (with a click-through to the deep dive view) when it finishes.
- **`baseline_calibration`** — clicking "Start calibration" on the Concepts page hits `POST /api/quiz/baseline/prepare`, which spawns an in-progress notification and runs question generation in the background. The bell flips to `ready` with `actionUrl = "/calibrate"` when the quiz is ready. Endpoint is idempotent: re-clicking is a no-op while a row is in flight, and `GET /api/quiz/baseline` short-circuits with `{ generating: true }` instead of starting a duplicate inline generation.

Adaptive polling: 4 s while at least one notification is in progress, 30 s otherwise, paused entirely while the tab is hidden (resumes on `visibilitychange`). Opening the dropdown auto-acknowledges everything visible (the unread badge clears), but rows stay until you dismiss them with the per-row × on hover. The Sunday 3 AM UTC maintenance cron sweeps any in-flight row that hasn't moved for 5+ minutes and flips it to `failed`, so a dead-worker scenario eventually shows up as a real failure instead of an indefinite spinner. New notification kinds plug in by calling `createNotification(...)` and `transitionNotification(...)` — no UI changes needed; the bell renders by `kind` / `title` / `body` / `actionUrl` / `status`. Schema lives in `notifications` (migration 0015); see [`notifications.md`](../src/frontend/help/reference/notifications.md) for the full read.

## Timezones

Briefings are calendar-day artifacts (a `briefing_date` YYYY-MM-DD label, not a timestamp), so the date semantics depend on what calendar the user is on. Every API request from the browser carries an `X-Client-Timezone` header sourced from `Intl.DateTimeFormat().resolvedOptions().timeZone`; the worker's `userToday(user.timezone)` helper turns that into the user's local YYYY-MM-DD. The header value is also persisted on `users.timezone` (migration 0013) whenever it differs from what's stored, so the cron — which runs offline at 5 AM UTC with no live session — knows what date to stamp for each user even when they're a UTC-4 New Yorker still seeing Sunday on their phone clock at 9 PM EDT. Travelers get a fresh local date on the next request after `visibilitychange`, since the frontend invalidates its TZ cache on focus return.

Timestamps everywhere else (`generated_at`, `created_at`, `updated_at`, etc.) are stored as UTC ISO strings and rendered in the browser's local time via `Date.toLocaleString` — the standard "store UTC, display local" pattern. The TZ-aware machinery is the narrow exception for the one calendar-day field.

## Display Preferences

A quick-prefs button in the header (next to the bookmark icon) opens a compact panel with:
- **Theme** — Light / Dark / System
- **Font size** — Small (14px) / Medium (16px, default) / Large (18px) — scales the entire UI proportionally via the root font size

Preferences persist in localStorage.

## Keyboard Shortcuts

**Global:**

| Keys | Action |
|------|--------|
| **Cmd + K** (macOS) / **Ctrl + K** (Windows / Linux) | Open the command palette — search-driven launcher for navigation, settings, theme + font size, help articles, and quick actions |
| **H** | Open help |
| **?** | Keyboard shortcuts reference |
| **G** then **B** | Go to briefing |
| **G** then **C** | Go to concepts |
| **G** then **A** | Go to archive |
| **G** then **H** | Go to help |
| **Escape** | Close settings, chat, the command palette, or any open modal |

The **command palette** (Cmd / Ctrl + K) is modeled on Cursor / VS Code / Linear — a single keyboard-driven launcher for jumping anywhere in Primer without taking your hands off the keyboard. Inside the palette, **↑ / ↓** moves the highlight, **↵** runs the highlighted command, and **Esc** closes it. Search matches label, category, hint, AND a per-item keywords list, so typing "preferences" finds Settings and "saved" finds Bookmarks even when those words aren't in the labels.

**Audio player** (when focused on a Listen player — click anywhere on it or `Tab` to it):

| Keys | Action |
|------|--------|
| **Space** | Play / pause |
| **←** / **→** | Skip ±15 seconds |
| **Shift + ←** / **Shift + →** | Fine jump ±5 seconds |
| **Home** / **End** | Jump to start / end |
| **`[`** / **`]`** | Step playback rate down / up |

Global shortcuts are suppressed while typing in inputs, textareas, or the chat panel. The audio-player shortcuts only fire when the player container has keyboard focus.
