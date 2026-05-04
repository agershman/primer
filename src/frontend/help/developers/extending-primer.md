---
title: "Extending Primer"
subtitle: "Adapter patterns, source providers, and where to plug in new code"
audiences: [developer]
related:
  - reference/api-endpoints
  - reference/notifications
  - briefings/how-generation-works
---

Primer is built around small, well-defined extension points. Adding a new LLM provider, TTS voice family, or work-context source shouldn't require touching the briefing pipeline, the routes, or the UI — each seam is a single new file plus a registration entry.

## Repository layout

```text
src/
├── frontend/                    # React + Vite SPA
│   ├── components/              # Reusable UI
│   ├── hooks/                   # useChat, useSettings, useCurrentUser, …
│   ├── lib/                     # helpRegistry, etc.
│   ├── pages/                   # Route components
│   └── help/                    # Markdown help articles (this directory)
└── worker/                      # Cloudflare Worker (Hono)
    ├── config/                  # Constants, models catalog, pricing, signal surfaces
    ├── integrations/
    │   ├── llm/                 # Adapter seam → Anthropic + OpenAI today
    │   └── tts/                 # Adapter seam → Cloudflare / OpenAI / ElevenLabs
    ├── middleware/              # auth, user-context, require-admin
    ├── routes/                  # Hono route handlers
    ├── services/                # Business logic (generators, scorers, filters)
    ├── sources/                 # Source providers (linear, slack, github, feeds, …)
    └── db/                      # D1 query helpers + schema-aware code
```

Migrations live in top-level `migrations/`. Tests live in `tests/unit/` and use Vitest; most are source-text contracts that snapshot the seam between layers.

## LLM adapters

Every LLM call goes through the `LLMClient` interface in `worker/integrations/llm/types.ts`. Two adapters ship today (`anthropic-adapter.ts`, `openai-adapter.ts`) and a dispatcher (`dispatcher.ts`) routes each request to the right adapter based on `ModelSpec.provider`.

To add a new provider (Google, Workers AI, OpenRouter, …):

1. Implement `LLMClient` for the provider in a new `worker/integrations/llm/<provider>-adapter.ts`. Mirror an existing adapter — both reuse the same `NormalizedUsage` shape so cost tracking stays unified.
2. Register it in `LLM_ADAPTERS` in `dispatcher.ts` with `provider` id, `isConfigured(env)` (typically checks for an env key), and a `build(env)` factory.
3. Add the new model entries to `worker/config/models.ts` with provider, tier, pricing (input / output / reasoning / cache), reasoning capability, tool support, context window.

The Settings AI-models picker, the per-piece "↻ try different model" affordance, the cost ledger, and analytics light up automatically once the adapter registers — no UI changes needed.

See `worker/integrations/llm/dispatcher.ts` for the registry pattern and `worker/integrations/llm/openai-adapter.ts` for a worked example of normalizing reasoning tokens separately from completion tokens.

## TTS adapters

Same pattern, separate seam. `worker/integrations/tts/types.ts` defines `TtsAdapter`; `dispatcher.ts` routes per `TtsModel.provider`. Three adapters today (Cloudflare Workers AI, OpenAI, ElevenLabs).

To add a provider:

1. Implement the adapter in `worker/integrations/tts/<provider>-adapter.ts`.
2. Register in the TTS dispatcher.
3. Add catalog entries to `TTS_MODELS` in `worker/config/constants.ts` (id, label, provider, voice id, tier, cost-per-1k-chars).

`/api/tts-models` filters by configured provider env keys at request time, so a new provider's voices show up in every UI picker the moment the env key is set.

## Source providers

Work-context sources (Linear, Slack, GitHub, incident.io) and feed sources (RSS, HN, ArXiv) implement the `SourceProvider` interface in `worker/sources/types.ts`. Each provider declares whether it's a singleton (one instance per deployment, e.g. Linear) or multi-instance (many instances per deployment, e.g. RSS — one per feed URL).

The detailed pattern lives in the project's source-providers skill:

```text
.cursor/skills/source-providers/SKILL.md
```

That guide walks through implementing the provider, registering with the source registry, exposing user fields via the settings manifest, and wiring the fetch path. The briefing generator picks up registered providers automatically — no per-source code in the pipeline.

## Pipeline seams

The briefing generator (`worker/services/briefing-generator.ts`) is broken up into discrete steps, each tagged with a `step_key` that flows into the analytics waterfall:

```text
work_context  →  slack_filter  →  concepts  →  adjacent  →  selecting
            →  generating_pieces  →  quiz  →  finishing
```

Adding a step:

1. Wrap the new logic in a `safeStep("step_key", () => …, fallback)` call so generator failures don't abort the briefing.
2. Call `recordTiming` with the step key + duration + items processed.
3. Add the step key to the `STEP_ORDER` array in `worker/routes/analytics.ts`.
4. Add the label + color to `BriefingWaterfall.tsx` so it renders in the analytics view.
5. Add the label to `GENERATION_STEPS` in `BriefingPage.tsx` for the live progress timeline.

`slack-relevance-filter.ts` is a worked example — it's a single file that drops Slack threads scoring below the user's `relevanceThreshold` against their About + Focus, slotted between the work-context fetch and concept extraction.

## API routes

Routes live in `worker/routes/<area>.ts`, each registered against a single `Hono` app via `app.route("/api", areaRoutes)` in `worker/index.ts`. Mutating routes that affect deployment-wide state should gate via `assertAdmin(c.get("user"))` — see `worker/middleware/require-admin.ts`.

The route surface is documented for reference in [API Endpoints](/help/reference/api-endpoints).

## Frontend extension points

- **Help docs** — drop a markdown file in `src/frontend/help/<category>/<slug>.md` with frontmatter (`title`, `subtitle`, `audiences`, optional `related`). It's auto-discovered via Vite's `import.meta.glob` and added to the search + index. See `src/frontend/lib/helpRegistry.ts`.
- **New settings panel** — add a panel component to `src/frontend/components/settings/panels/` and register it in `STATIC_NAV` (or in `buildSourceNavEntries` for source-specific panels) in `SettingsModal.tsx`.
- **New audio surface** — pass a `surface` tag to `<VoiceSwitcher>` matching the `TtsOperation` union; the per-surface default flows through automatically.

## Testing

Most tests are source-text contracts that pin specific symbols / shapes between layers (e.g. "the dispatcher exports `getConfiguredProviders`", "the SettingsModal hides the preview button for non-admins"). They're fast, no fixtures, and catch most regressions on adapter / route / UI seams.

Run the suite with:

```bash
bun x vitest run
```

For a single file: `bun x vitest run tests/unit/<file>.test.ts`.

Add a test alongside any seam you change — see `tests/unit/multi-provider-ai.test.ts` for the LLM adapter pattern, `tests/unit/per-op-tts.test.ts` for TTS, and `tests/unit/admin-role.test.ts` for the admin gate.

## Contributing

Before opening a PR, read [CONTRIBUTING.md](https://github.com/agershman/primer/blob/main/CONTRIBUTING.md) (or the local [`CONTRIBUTING.md`](https://github.com/agershman/primer/blob/main/CONTRIBUTING.md) at the repo root) — it covers the dev loop, conventions, test patterns, the migration / help-doc / admin-gating rules, and the PR workflow + checklist. The PR template at `.github/PULL_REQUEST_TEMPLATE.md` mirrors the same checklist so it pops up automatically when you open a PR.
