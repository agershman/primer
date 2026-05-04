---
name: add-llm-adapter
description: >-
  Add a new LLM provider adapter to Primer (e.g. Gemini, Mistral,
  Cohere). Plugs into the registry / dispatcher pattern so the
  pipeline, chat, and analytics surface the new provider without
  touching the calling code. Use when adding a provider whose models
  should appear in the per-use-case AI model picker.
---

# Add an LLM adapter

The user wants to add a new LLM provider to Primer:

> $ARGUMENTS

## Architecture

Primer's LLM layer is a registry of provider-specific adapters behind a single `LLMClient` interface. The pipeline, chat responder, and continuation classifier all dispatch through `llmClient(spec, env)` — they never see provider-specific code. Adding a new provider means writing one adapter file, registering it in the dispatcher, and adding model entries to the catalog.

```
src/worker/
├── integrations/llm/
│   ├── types.ts            # LLMClient interface, ModelSpec, NormalizedUsage
│   ├── dispatcher.ts       # llmClient() lookup + LLM_ADAPTERS registry
│   ├── anthropic-adapter.ts   # AnthropicAdapter (existing)
│   ├── openai-adapter.ts      # OpenAIAdapter (existing)
│   └── <your-provider>-adapter.ts   # NEW — implement here
├── config/
│   ├── models.ts           # AVAILABLE_MODELS catalog (pricing + capabilities)
│   └── pricing.ts          # estimateLlmCost() per model
└── routes/
    └── models.ts           # /api/models filters by configured providers
```

## Step 1 — Write the adapter

Create `src/worker/integrations/llm/<provider>-adapter.ts` implementing `LLMClient`:

```ts
import type { Env } from "../../types.js";
import type { LLMClient, LLMRequest, LLMResponse, NormalizedUsage } from "./types.js";

export class <Provider>Adapter implements LLMClient {
  constructor(private apiKey: string) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // 1. Translate the provider-agnostic LLMRequest to the provider's API shape.
    // 2. Make the HTTP call (with timeout — see LLM_REQUEST_TIMEOUT_MS).
    // 3. Normalize the response back to LLMResponse.
    // 4. Surface usage in the NormalizedUsage shape (input/output/reasoning/cache tokens).
  }

  async stream(request: LLMRequest): AsyncIterable<string> {
    // SSE / chunked streaming if the provider supports it.
    // Used by chat for token-by-token streaming.
  }
}

function normalizeUsage(raw: unknown): NormalizedUsage {
  // Provider-specific → standard shape. Critical for unified cost tracking.
}
```

Look at `anthropic-adapter.ts` for the canonical implementation. Key points:

- **Timeout.** Use `LLM_REQUEST_TIMEOUT_MS` from `config/constants.ts` with `AbortController`.
- **Retries.** Most providers handle their own retries — don't add another layer unless the provider's behaviour is bad.
- **Usage normalization.** The `NormalizedUsage` shape (`input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_write_tokens`) is the contract for the cost ledger. Map every field; missing fields go to 0.
- **Errors.** Throw `Error` with a useful message. The dispatcher's caller decides retry / fail behaviour.

## Step 2 — Register the adapter

In `src/worker/integrations/llm/dispatcher.ts`, add an entry to `LLM_ADAPTERS`:

```ts
import { <Provider>Adapter } from "./<provider>-adapter.js";

const LLM_ADAPTERS: LLMAdapterRegistration[] = [
  // existing entries…
  {
    provider: "<provider>",
    isAvailable: (env) => Boolean(env.<PROVIDER>_API_KEY),
    build: (env) => new <Provider>Adapter(env.<PROVIDER>_API_KEY!),
  },
];
```

The `isAvailable` predicate is what makes the model picker filter to configured providers. If the user's deployment doesn't have `<PROVIDER>_API_KEY` set, models from this provider don't appear in any picker.

Also add the env var to `src/worker/types.ts`:

```ts
export interface Env {
  // existing…
  <PROVIDER>_API_KEY?: string;
}
```

## Step 3 — Add models to the catalog

In `src/worker/config/models.ts`, append entries to `AVAILABLE_MODELS`:

```ts
{
  id: "<provider>-<model-id>",        // unique across all providers
  label: "<Display Name>",
  provider: "<provider>",
  tier: "fast" | "balanced" | "quality",
  description: "<short description>",
  reasoning: "none" | "effort" | "budget",   // pick what the model supports
  supportsTools: true | false,
  contextWindow: 128_000,             // tokens
  pricing: {
    inputPer1M: 0.5,                  // USD per 1M tokens
    outputPer1M: 1.5,
    cacheReadPer1M: 0.05,             // optional
    cacheWritePer1M: 0.6,             // optional
  },
},
```

The `id` shape `<provider>-<model>` is convention; pickers group by provider and the dispatcher uses it to route. The `pricing` field powers the analytics page's cost breakdown — even rough numbers are better than nothing.

## Step 4 — Pricing helper (if needed)

Most adapters can rely on the catalog's `pricing` field via `estimateLlmCost(model, usage)` in `config/pricing.ts`. If your provider has unusual pricing (e.g. per-character, or per-step), add a special-case branch there.

## Step 5 — Add tests

Two test files matter:

- `tests/unit/multi-provider-ai.test.ts` — pin that the new provider appears in the dispatcher registry, that `isAvailable` returns false without the key and true with it, and that `/api/models` filters correctly.
- `tests/unit/<provider>-adapter.test.ts` (new) — execution tests for `normalizeUsage`, request translation, and error handling. Mirror `tests/unit/llm-adapter.test.ts` for the existing AnthropicAdapter.

## Step 6 — Help docs

Add a credentials guide at `src/frontend/help/credentials/<provider>.md` mirroring the existing `anthropic.md`, `openai.md`, `elevenlabs.md` files. Include:

- Where to get an API key (URL of the provider's settings page).
- Required permissions / scopes (if applicable).
- Cost expectations.
- Where in `wrangler.api.toml` to set `<PROVIDER>_API_KEY` (as a secret, not a vars entry).

Also update the README's environment-variables table to mention the new optional secret.

## Verification checklist

- `bun run vitest run tests/unit/multi-provider-ai.test.ts` passes.
- `/api/models` returns the new provider's models when the key is set, omits them when not.
- The Settings → AI models picker groups the new provider's models under their own header.
- The Analytics page's per-provider cost breakdown shows usage from the new provider.

## See also

- `dev-docs/architecture.md` — the three-registry pattern.
- ADR 0004 — shared types module (the LLM types live in `src/worker/integrations/llm/types.ts`, not `src/shared/`, because the LLMClient interface has runtime behaviour that's worker-only).
- `.cursor/skills/add-tts-adapter/` — same pattern for voice providers.
