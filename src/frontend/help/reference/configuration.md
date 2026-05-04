---
title: "Configuration"
subtitle: "Customize signal sources, thresholds, and budget from the Settings panel"
audiences: [user, admin]
related:
  - briefings/how-generation-works
  - reference/ai-models
  - concepts/depth-scale
---

## Roles: Admin vs Regular User

Primer separates **deployment-wide configuration** (sources, AI model picks, voice defaults, budget caps, thresholds) from **personalization** (your About / Focus / Relevance filter). The first surface is the admin's job; the second is yours regardless of role.

- **Admin** — configures every panel below. Also sees the per-piece **↻ try different model** affordance and the inline `voice: <name> ↻` switcher on every Listen control (both update deployment-wide defaults).
- **Regular user** — sees **only** Personalization (About, Focus, Relevance filter) plus Account in the Settings nav. The Sources and Intelligence groups, Briefing limits, the **Build full briefing preview** button, the per-piece model regeneration picker, and the inline voice switcher are all hidden. Server-side mutations on those areas would 403 anyway — hiding them just keeps the UI calm.

**Becoming admin:** the first user to provision a fresh deployment is admin automatically (atomic INSERT-SELECT bootstrap — two simultaneous first-time signups can't both claim it). The bootstrap admin sees a one-time welcome dialog explaining what their role enables. On systems upgrading from a pre-admin schema, the earliest-created existing user is backfilled (and is treated as already-welcomed, so the dialog doesn't pop after the migration runs).

**Promoting / demoting users:** admins manage roles from **Settings → Users**. Each user row has a Promote / Demote button; the change lands server-side immediately and the affected user sees the welcome dialog on their next session if they were promoted. The deployment must always have at least one admin (the server refuses last-admin demotion with a 409).

`GET /api/me` returns the resolved `isAdmin` flag plus `needsBootstrapWelcome` so the UI can branch correctly. Server gates are independent of the UI hint and are the only thing that decides whether a write actually lands.

## Settings Panel

Click your **avatar** in the top-right corner of the header to open the Settings modal. Changes auto-save as you edit — a brief "Saved" indicator in the footer confirms each update.

Your saved settings apply to **every** briefing run — both manual generation (clicking the refresh button) and the daily 5 AM UTC cron trigger. When you change a filter or model override, the next briefing will use it automatically.

The modal is sidenav-driven. Entries are grouped into four sections (admin only — regular users see only Personalization + Account):

- **Sources** _(admin)_ — Linear, Slack, GitHub, incident.io, Feeds (RSS / HN / ArXiv).
- **Intelligence** _(admin)_ — AI models (per-operation model picks, grouped by provider), Voice (per-surface TTS picks + global default).
- **Personalization** _(all users)_ — About you (persona statement), Current focus (priorities), Relevance filter (prompt + per-source overrides).
- **General** — Briefing limits _(admin)_, Account (display name, GitHub username, danger-zone reset — all per-user).

A **search bar** above the sidenav filters entries by label and keyword. The footer carries a single primary button — **Build full briefing preview** _(admin only)_ — that runs your current filters across every source and shows the in-scope items inside each source's panel (see the [Preview section](#preview) below).

## Linear Sources

Control which Linear activity feeds into your briefings:

- **Assigned to me** — Issues where you're the assignee
- **Subscribed / commented on** — Issues you're watching or have participated in
- **In team projects** — All issues in your team's active projects

### Status Filter

Choose which issue states to include. By default Primer pulls Triage, Backlog, Todo, and In Progress. Toggle any combination of:

Triage · Backlog · Todo · In Progress · Done · Cancelled

### Team Prefixes

If your workspace has multiple Linear teams, select which teams' issues should be scanned. Unselected teams are ignored during signal fetch.

### Time Window

Limit how far back Primer looks at Linear activity. Only issues updated within the window are fetched, which keeps briefings focused on current work:

- **3 days** — Only very recent activity
- **7 days** — Balanced (default)
- **14 days** — Broader context
- **30 days** — Maximum lookback

### Preview

The footer's **Build full briefing preview** button runs every source's fetch in parallel against your current filter set. Results are surfaced **inside each source's panel** — the Linear panel shows in-scope issues, the Slack panel shows channels, the Feeds panel shows external feed items. There's no always-on right-hand preview pane; navigate to a source's panel to see its slice.

While a preview is in flight, the footer button reads **Running…**. When you change filters after a preview has been built, the button label flips to **Rebuild — filters changed** so you know the preview is stale. After a successful run, the button reads **Rebuild full briefing preview**.

Each source's "In scope" subpanel shows a count + status header ("Updated just now"), the rendered list of items, and (where available) a near-misses block explaining what almost matched. Items are clickable links back to Linear / Slack / etc. so you can verify the right content is being pulled in.

## Slack Sources

### Channel Picker

Select the Slack channels Primer should read. Use the search bar at the top to filter by name. Each channel shows its member count so you can gauge how noisy a source will be.

### History Window

Choose how far back Primer looks when scanning Slack messages:

- **3 days** — Tight focus, lower token cost
- **7 days** — Balanced (default)
- **14 days** — Broader context
- **30 days** — Maximum coverage

### Bookmarked messages (`:bookmark:` reaction)

Toggle **Include `:bookmark:` reactions** to pull in any message in your monitored channels that has a `:bookmark:` reaction from anyone in the channel — even if it would otherwise be filtered out as too short or too noisy. The bookmark reaction is treated as an explicit "include this regardless" signal:

- The standard noise filter (`thanks`, `lgtm`, lone emoji, sub-15-character messages) is bypassed for bookmarked messages.
- The per-thread length floor (30 chars / 2+ messages) is bypassed for any thread that has a bookmarked message anywhere in it (root or reply).
- Bookmarked threads sort to the top of the work-context bar and get a 🔖 prefix on their title so you can see at a glance which items the team flagged.
- The description fed to the concept extractor includes an explicit "Bookmarked by a teammate (`:bookmark:` reaction)." note, so the LLM weights these messages as high-signal even when the text alone is brief.

The toggle is opt-in (default off) — turning it on essentially says "trust me when someone uses the `:bookmark:` reaction in these channels, surface that message even if my other filters wouldn't have caught it." Pairs well with narrow channel selections — pointing it at #eng-share or #good-reads where bookmarking is already part of the team's workflow tends to produce the best signal.

Today the bypass operates over the messages already pulled in by the **History window** above. Bookmarks on messages older than the window aren't yet retrieved (Slack's `search.messages` would unlock that, but requires the `search:read` scope which isn't on by default).

## Display Preferences

The quick-prefs button in the header (next to the bookmark icon) lets you change:

- **Theme** — Light, Dark, or System (follows OS preference)
- **Font size** — Small (14px), Medium (16px, default), or Large (18px). Scales the entire UI proportionally. Persisted in localStorage.

Press **Escape** to close the preferences panel.

## AI Models

Pick which model powers each operation in Primer. Each operation has a sensible default, but you can override per-operation to trade quality for speed/cost. Each dropdown groups its options by provider via `<optgroup>` headers — one section per configured provider — and a provider's group only appears when both its adapter is registered AND its API key is present on the worker. Today **Anthropic** (gates on `ANTHROPIC_API_KEY`) and **OpenAI** (gates on `OPENAI_API_KEY`) are both registered; Google / Workers AI / OpenRouter slot into the same picker once their adapters land. See [AI Models](/help/reference/ai-models) for the full architecture, per-operation defaults, and pricing details.

Per-operation defaults:

- **Teaching pieces** — the main daily briefing content. Default: Claude Sonnet 4 (balanced).
- **Deep dives** — extended drill-down content. Default: Claude Sonnet 4.
- **Quiz assessment** — evaluating your quiz answers. Default: Claude Sonnet 4 (nuance matters here).
- **Chat** — conversational assistant. Default: Claude Sonnet 4.
- **Concept extraction** — identifying concepts from work items. Default: Claude Haiku 4.5 (structured task, speed matters).
- **Adjacent scoring** — ranking external sources for relevance. Default: Claude Haiku 4.5.
- **Quiz generation** — writing calibration questions. Default: Claude Haiku 4.5.
- **Continuation classifier** — NOVEL / ADDITIVE / REDUNDANT call on each fresh draft. Default: Claude Haiku 4.5.

Models available:

- **Anthropic** — Claude **Haiku 4.5** (fast/cheap), **Sonnet 4** (balanced default), **Opus 4** (highest quality).
- **OpenAI** — **GPT-5 nano** (fast), **GPT-5 mini** (balanced), **GPT-5** (quality). All three support the `reasoning effort` knob and are tracked with separate reasoning-token columns in the cost ledger.

The model used to generate each teaching piece is shown in a small footer at the bottom of the piece.

### About you (versioned persona)

The **Personalization → About you** panel holds a short paragraph describing *who you are* — role, experience level, communication preferences, learning style. Saved as a new version every time you click **Save as new version**. Used to tailor voice and depth across **all** of Primer's user-facing AI:

- Concept extraction (lower-weight signal, secondary to Focus)
- Teaching piece generation (voice, depth assumptions)
- Deep dive generation (same)
- Chat (tone, audience modeling)
- Quiz generation (difficulty calibration)
- Relevance scoring (disambiguates ambiguous matches)

The **View history** modal shows the full timeline of versions with diffs and per-version analytics (concepts created, briefings, teaching pieces, positive feedback rate during the version's active period).

The **✨ Refine with AI** button asks Claude to rewrite your draft into a tighter, prompt-ready paragraph. The refinement never invents facts about you and gives you a one-line rationale; you accept or keep yours.

### Focus statement (versioned)

The **Personalization → Current focus** panel holds a short paragraph the system uses to bias what it extracts and surfaces. Saved as a new version every time you click **Save as new version**. See **View history** for a timeline of every version with diffs and per-version analytics:

- **Concepts created** under that version
- **Briefings** and **teaching pieces** produced while it was active
- **Category distribution** of extracted concepts
- **Suppression rate** — % of concepts under that version that you later marked "not interested." If this is above ~25% on a version that produced 5+ concepts, the focus statement is producing noise and the modal nudges you to refine it.

You can **restore** any historical version (creates a new version pointing back at the source) or **delete** non-current versions you'd rather not keep around. Concepts and briefings attributed to a deleted version are kept but become "untagged" for analytics.

The focus statement is also the single most powerful filter for the concept extractor — it dramatically reduces the volume of off-target concepts that show up in your trails.

### Concepts: suppress / unsuppress / reset

- **Suppress** — every concept row on the Concepts page has a `✕` button. Suppressed concepts are hidden from trails, excluded from future briefing generation, and never re-extracted by the LLM.
- **Show suppressed** toggle on the Concepts page reveals suppressed entries with strike-through styling and an unsuppress button.
- **Reset concepts** in **Settings → General → Account** (danger zone) wipes your concept graph (concepts, depth, calibration history) so the next briefing rebuilds it from scratch under your current focus. Past briefings and teaching pieces are preserved.

### Voice (TTS) and audio playback

Choose the text-to-speech provider and voice for the **Listen** feature. The panel mirrors the **AI models** panel's per-operation pattern:

- **Default voice** — the catch-all used when an individual surface has no override. Pick once and it applies everywhere unless you say otherwise.
- **Per-surface overrides** — separate voice picks for **Teaching pieces**, **Deep dives**, and **Chat replies**. Each override starts on **Use default voice** (inherits the global default) — pick a specific voice there to scope it to just that surface. Useful for, say, a friendly female voice for daily teaching pieces and a deeper narrator voice for deep dives.

Voices are grouped by provider in every picker (Cloudflare → OpenAI → ElevenLabs), and each option shows a description, tier, and price per 1k characters. Storage lives in `signalSurfaceMap.models` alongside the LLM picks: `ttsModel` (global default), `ttsModelTeachingPiece`, `ttsModelDeepDive`, `ttsModelChat`. Resolution: `?voice=` query → per-surface key → global `ttsModel` → catalog default.

Every audio player supports full transport controls — flanking skip-back / skip-forward buttons (`±15s`, with `Shift` modifier for `±5s`), drag-to-scrub on the progress bar via a visible playhead thumb, **playback-speed cycling** through `0.75 / 1 / 1.25 / 1.5 / 1.75 / 2`× via a small rate button (or `[` / `]` keys), and keyboard scrubbing (Space, ←, →, Home, End) when the player has focus. The selected speed persists in localStorage and syncs across every player on the page in real time. See [Keyboard Shortcuts → Audio Player](/help/reference/keyboard-shortcuts) for the full list.

The voice setting applies everywhere Primer speaks back to you:

- **Teaching pieces** — Listen button at the top of each piece on the briefing page. Uses `ttsModelTeachingPiece` if set, otherwise the global default.
- **Deep dives** — Listen button on the deep-dive view. Uses `ttsModelDeepDive` if set.
- **Chat replies** — 🔊 Listen affordance under each finished assistant message in the chat panel. Uses `ttsModelChat` if set. (User messages don't get one — you typed them.)

You can also change the voice **per surface from the inline switcher**: every Listen control has a small **voice: \<name\> ↻** affordance next to it. Picking a new voice there does two things at once: (1) regenerates that surface's audio in the new voice, and (2) updates that surface's default — so changing the chat voice from a chat reply sticks to chat replies, not deep dives. Multiple open switchers and the Settings panel stay in sync via a window event (`primer:tts-voice-changed`) whose detail carries the surface tag, so listeners ignore picks scoped to a different surface.

**Cloudflare Workers AI** (no extra config — uses your Workers AI binding):

- **Deepgram Aura** — 12 natural-sounding speakers: Asteria (default, friendly female US), Luna, Stella, Athena (UK), Hera, Orion, Arcas, Perseus, Angus (Irish), Orpheus, Helios (UK), Zeus. $0.015/1k characters.
- **MeloTTS** — open-source budget option, more robotic. $0.0002/1k characters.

**OpenAI TTS** (requires `OPENAI_API_KEY` secret):

- **`tts-1`** (balanced, $0.015/1k characters) — Alloy, Echo, Fable (British narrator), Onyx (deep male), Nova (bright female), Shimmer (soft female).
- **`tts-1-hd`** (higher quality, $0.030/1k characters) — Alloy, Nova, Onyx.

OpenAI options only appear in the picker when `OPENAI_API_KEY` is configured on the worker. Set it locally in `.dev.vars` and in production via `bunx wrangler secret put OPENAI_API_KEY --config wrangler.api.toml`.

**ElevenLabs TTS** (requires `ELEVENLABS_API_KEY` secret):

- **`eleven_multilingual_v2`** (premium, $0.30/1k characters) — Rachel, Adam, Domi, Antoni. Highest quality, multilingual.
- **`eleven_turbo_v2_5`** (balanced, $0.15/1k characters) — Rachel, Adam. Lower latency than multilingual.
- **`eleven_flash_v2_5`** (budget / real-time, $0.075/1k characters) — Rachel, Adam.

ElevenLabs options only appear in the picker when `ELEVENLABS_API_KEY` is configured on the worker. Set it locally in `.dev.vars` and in production via `bunx wrangler secret put ELEVENLABS_API_KEY --config wrangler.api.toml`. ElevenLabs is character-billed; the cost-per-1k figures above are written into the catalog and surface in `usage_events` rows the moment the audio finishes streaming.

### About / Focus version history

When you save a new version of your **About you** or **Current focus** statement, the prior version is preserved in `about_statement_versions` / `focus_statement_versions` and the version-history modal renders the textual diff between consecutive versions automatically. Earlier iterations of Primer also required a free-text "why this change?" note on every save, but that turned out to be friction with no real payoff — the diff view already conveys what changed at the level a reader of history actually scans for. The `note` column is still on the schema (the restore-from-version path writes a `restored from <id>` marker) but it's no longer prompted for or required by the API.

### Per-source relevance filter overrides

The **Personalization → Relevance filter** panel has two layers:

- **Global filter** — applies to every source unless overridden.
- **Per-source overrides** — one slot per *configured source* (Linear, Slack, incident.io, plus each individual feed instance you've added under **Sources → Feeds**). When set, the per-source prompt **replaces** the global filter for that source's items during scoring and concept extraction.

Override slots are derived from your live source configuration — singletons (Linear, Slack, incident.io, GitHub) appear by provider; feed providers (RSS, HN, ArXiv) expand into one row per *enabled* configured instance, so e.g. "CNCF Blog" and "Cloudflare Blog" each get their own filter even though they share the RSS provider underneath.

At runtime, items are bucketed by their effective filter prompt before going to the LLM:

- Adjacent-source scoring (the relevance scorer that decides what makes it into "From feeds" pieces) runs one scoring call per unique filter — global-bucket items in one call, per-instance overrides in their own.
- Concept extraction does the same: items get grouped by source, batched at 15 per LLM call, and each bucket's prompt carries its applicable filter.

When zero overrides are set, behavior is identical to the global-only path (one batch sequence). The bucket count is bounded by the number of distinct override prompts you actually have.

## General

### Monthly Budget Cap

The maximum monthly spend (USD) across **all** AI providers and modalities — LLM tokens (Claude today, OpenAI / Google when wired in) plus TTS characters (Cloudflare Aura / MeloTTS, OpenAI, ElevenLabs). Primer reads cumulative usage from the unified `usage_events` ledger and pauses generation when the cap is reached. Default: $35.

The Analytics page surfaces this same number broken down by provider and modality so you can see where the spend is coming from when you're approaching the cap (e.g. "TTS is half the bill this month — switch to MeloTTS for adjacent pieces").

### Relevance Threshold

A slider from 0.20 (more inclusive) to 0.80 (more selective) that controls the minimum relevance score a concept must reach to appear as a teaching piece in your briefing.

- **Lower values** → more teaching pieces per briefing, broader coverage
- **Higher values** → fewer but more targeted pieces

The current value is displayed in the center of the slider. Default: 0.40.
