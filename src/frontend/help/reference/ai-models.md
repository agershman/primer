---
title: "AI Models"
subtitle: "Pick which model powers each step of Primer"
audiences: [admin]
related:
  - reference/configuration
  - briefings/how-generation-works
---

## Architecture

Primer's AI layer is provider-agnostic at the seam. Every LLM call goes through a normalized `LLMClient` interface in `src/worker/integrations/llm/`, with a **dispatcher registry** that routes to a per-provider adapter based on each request's `ModelSpec` (`{ provider, model, reasoning?, ... }`). Two adapters are wired in today — Anthropic Claude and OpenAI (GPT-5 family) — and additional providers (Google, Workers AI, OpenRouter) slot in by adding one entry to the dispatcher's `LLM_ADAPTERS` array plus one adapter file. Services, the `/api/models` route, and the Settings picker all light up automatically once a provider's adapter registers.

The dispatcher exposes two helpers the rest of the system reads from:

- **`isProviderConfigured(provider, env)`** — true only when (a) an adapter exists for the provider AND (b) its required env keys are present. Mirrors the equivalent in the TTS dispatcher.
- **`getConfiguredProviders(env)`** — list of `ProviderId`s ready to serve, in registration order.

The model catalog (`src/worker/config/models.ts`) is the single source of truth for catalog entries. Each entry carries its provider, tier, pricing (input/output/reasoning/cache rates per 1M tokens), reasoning capability, tool support, and context window. Cost estimation, the per-piece "Generated with X" footer, the analytics waterfall tier resolution, and the Settings model picker all read from this same list.

## Picker behavior — provider grouping + env-key gating

The dropdowns under **Settings → Intelligence → AI models** group their options by provider via `<optgroup>` headers — one section per configured provider. The grouping mirrors the **Settings → Intelligence → Voice** picker behavior; the two panels share a single `ProviderGroupedSelect` component so the UX is identical.

Two gates determine which providers show up:

1. **An adapter must be registered** for that provider in the LLM dispatcher (`integrations/llm/dispatcher.ts`). Catalog entries without an adapter are filtered out so users can't pick a model that would 500 on use.
2. **The provider's env key must be set** on the worker. Anthropic models gate on `ANTHROPIC_API_KEY`; OpenAI gates on `OPENAI_API_KEY`; future Google / Workers AI entries gate on `GOOGLE_API_KEY` / the AI binding and so on.

Both gates are enforced server-side by `/api/models`, so the picker simply renders whatever the route returns. Add an env key to `.dev.vars` (or `bunx wrangler secret put` in production), refresh the panel, and that provider's group materialises.

## Available Models

You can pick which model powers each step from **Settings → Intelligence → AI models**. Two providers are registered today; entries for either group only appear when their API key is set on the worker:

### Anthropic (gates on `ANTHROPIC_API_KEY`)

| Model | Tier | When to use |
|-------|------|-------------|
| **Claude Haiku 4.5** | Fast | Structured or repetitive tasks. Fastest and cheapest. Matches Sonnet 4 on most benchmarks per Anthropic. |
| **Claude Sonnet 4** | Balanced | Default for user-facing content. Strong reasoning at a reasonable cost and speed. |
| **Claude Opus 4** | Quality | Highest quality, slowest, most expensive. Use when you want maximum depth in teaching pieces. |

### OpenAI (gates on `OPENAI_API_KEY`)

| Model | Tier | When to use |
|-------|------|-------------|
| **GPT-5 nano** | Fast | Smallest, fastest GPT-5. Bulk classification, structured extraction, high-volume scoring. |
| **GPT-5 mini** | Balanced | Mid-tier — strong reasoning at a fraction of the full model's cost. Good general-purpose pick. |
| **GPT-5** | Quality | Full GPT-5. Highest quality OpenAI option. Pair with deep dives or nuanced grading. |

All three OpenAI entries support the **reasoning effort** knob (`minimal` / `low` / `medium` / `high`). The picker doesn't yet expose effort as a third dropdown — operations default to the model's stock effort. Reasoning tokens are tracked separately from output tokens in the cost ledger so analytics can show how much "thinking" each operation paid for.

## Per-Operation Settings

You can set a different model for each operation. Defaults are tuned for cost/speed/quality balance:

| Operation | Default | Why |
|-----------|---------|-----|
| Teaching pieces | Sonnet 4 | User-facing content, quality matters |
| Deep dives | Sonnet 4 | Long-form, nuanced explanations |
| Quiz assessment | Sonnet 4 | Needs nuance to grade open-ended answers |
| Chat | Sonnet 4 | Conversational reasoning |
| Concept extraction | Haiku 4.5 | Structured task, speed matters with many items |
| Adjacent scoring | Haiku 4.5 | Pure ranking, high throughput |
| Quiz generation | Haiku 4.5 | Short structured output |
| Continuation classifier | Haiku 4.5 | Per-draft NOVEL / ADDITIVE / REDUNDANT call; one short JSON output is plenty for Haiku |

## Upgrading for Quality

If you want deeper teaching pieces, set **Teaching pieces** to Opus 4. Expect slower generation (30-60+ seconds per piece vs 10-20 with Sonnet) and higher cost. The resulting pieces tend to have more nuance, better synthesis, and stronger examples.

## Downgrading for Speed/Cost

If you have a tight budget or want faster briefings, set all operations to Haiku 4.5. Haiku 4.5 matches Sonnet 4 on most tasks per Anthropic's benchmarks, and is significantly cheaper and faster.

## Model Tracking

Every generated teaching piece displays the model used at the bottom (e.g. "Generated with Claude Sonnet 4"). The model is also stored in the database for each artifact, so you have a full audit trail of what model produced what content.

## Changing Models Mid-Briefing

Model settings only affect **future** generations. Teaching pieces already in your archive preserve their original model attribution.

## Voice picks (per-surface)

The same per-operation pattern applies to text-to-speech voices. **Settings → Intelligence → Voice** shows a global **Default voice** plus per-surface override rows for **Teaching pieces**, **Deep dives**, and **Chat replies**. Each override defaults to **Use default voice** (inherits the global pick) — overriding a row scopes that voice to just that surface. Storage lives alongside the LLM picks at `signalSurfaceMap.models.{ttsModel, ttsModelTeachingPiece, ttsModelDeepDive, ttsModelChat}`; resolution is `?voice=` query → per-surface key → global `ttsModel` → catalog default. The per-surface inline `voice: <name> ↻` switcher next to every Listen control updates only that surface's setting, so changing the chat voice from a chat reply doesn't bleed into your deep-dive voice. See [Configuration → Voice (TTS) and audio playback](/help/reference/configuration#voice-tts-and-audio-playback) for the full panel walkthrough.

## Cost ledger

Every billable AI call — text and audio — writes a row to the unified `usage_events` table with `(provider, modality, model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, audio_chars, voice, estimated_cost_usd)`. The Analytics page's cost trendline and the monthly budget cap both read from this single ledger, so a TTS-heavy month and an LLM-heavy month are tracked side-by-side under the same `BUDGET_CAP_MONTHLY`. With both Anthropic and OpenAI configured, spend stacks into the same trendline grouped by provider — useful for spotting "GPT-5 just ate half my budget" before the cap fires.
