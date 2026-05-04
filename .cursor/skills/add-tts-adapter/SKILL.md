---
name: add-tts-adapter
description: >-
  Add a new TTS (text-to-speech) provider adapter (e.g. Azure, Polly,
  PlayHT). Plugs into the registry / dispatcher pattern so the
  per-operation voice picker surfaces the new provider's voices.
  Use when adding a voice provider whose voices should appear in the
  Voice settings panel.
---

# Add a TTS adapter

The user wants to add a new TTS provider to Primer:

> $ARGUMENTS

## Architecture

Mirror of the LLM adapter pattern. The TTS layer is a registry of provider-specific adapters behind a single `TtsAdapter` interface. The audio routes (`/api/piece/:id/audio`, `/api/deep-dive/:id/audio`, `/api/chat/audio`) all dispatch through `ttsAdapterFor(model, env)` — they never see provider-specific code.

```
src/worker/
├── integrations/tts/
│   ├── types.ts               # TtsAdapter interface, TtsResult, TtsRecordingContext
│   ├── dispatcher.ts          # ttsAdapterFor() + isProviderConfigured()
│   ├── cloudflare-adapter.ts  # CloudflareTtsAdapter (Workers AI)
│   ├── openai-adapter.ts      # OpenAITtsAdapter
│   ├── elevenlabs-adapter.ts  # ElevenLabsAdapter
│   └── <your-provider>-adapter.ts   # NEW
├── config/
│   └── constants.ts           # TTS_MODELS catalog (provider, voice IDs, pricing)
└── services/
    └── tts.ts                 # Wraps the dispatcher, records usage_events
```

## Step 1 — Write the adapter

Create `src/worker/integrations/tts/<provider>-adapter.ts` implementing `TtsAdapter`:

```ts
import type { Env } from "../../types.js";
import type { TtsAdapter, TtsRequest, TtsResult } from "./types.js";

export class <Provider>TtsAdapter implements TtsAdapter {
  constructor(private apiKey: string) {}

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    // 1. Translate TtsRequest → provider's API call.
    // 2. POST to the provider; expect audio bytes back (mp3 / wav / ogg).
    // 3. Return { audio: ArrayBuffer, contentType: "audio/mpeg", chars: text.length }.
  }
}
```

Look at `elevenlabs-adapter.ts` for the canonical implementation. Key points:

- **Output format.** Prefer `audio/mpeg` (mp3) — every browser supports it natively. Some providers default to ogg / opus; ask for mp3 explicitly.
- **Streaming.** If the provider supports streaming synthesis, use it — `<audio>` plays a streamed mp3 incrementally. The frontend's `AudioPlayer` already handles streamed responses.
- **Character counting.** `chars: text.length` is what the cost ledger uses. Some providers bill by codepoint, some by token; for the ledger, character count is the lowest-common-denominator.
- **Errors.** Wrap the provider's HTTP error in a clear message. `audioErrorResponse` in `services/tts.ts` surfaces these in the `<audio>` error UI.

## Step 2 — Register the adapter

In `src/worker/integrations/tts/dispatcher.ts`:

```ts
import { <Provider>TtsAdapter } from "./<provider>-adapter.js";

export function ttsAdapterFor(model: TtsModel, env: Env): TtsAdapter {
  if (model.provider === "<provider>") {
    if (!env.<PROVIDER>_API_KEY) {
      throw new Error("<Provider> TTS not configured");
    }
    return new <Provider>TtsAdapter(env.<PROVIDER>_API_KEY);
  }
  // existing branches…
}

export function isProviderConfigured(provider: TtsProvider, env: Env): boolean {
  // existing branches…
  if (provider === "<provider>") return Boolean(env.<PROVIDER>_API_KEY);
}
```

Add the env var to `src/worker/types.ts`. The `isProviderConfigured` predicate is what makes the per-operation voice picker filter to configured providers.

## Step 3 — Add voices to the catalog

In `src/worker/config/constants.ts`, extend `TTS_MODELS`:

```ts
{
  id: "<provider>-<voice-id>",        // unique across all providers
  label: "<Display Name>",
  provider: "<provider>",
  tier: "fast" | "balanced" | "quality",
  description: "<short voice description>",
  pricing: {
    perMillionChars: 30,              // USD per 1M characters
  },
},
```

The Voice settings panel groups by provider; ordering within a provider is alphabetical by `label`. Tier names are user-facing — pick descriptive ones.

Also extend the `TtsProvider` literal type in `constants.ts` to include `"<provider>"`.

## Step 4 — Add tests

- `tests/unit/tts-adapters.test.ts` — pin that the new adapter appears in the dispatcher, returns the right `contentType`, and counts characters correctly.
- `tests/unit/per-op-tts.test.ts` — pin that the new provider appears in the per-operation voice picker (`/api/tts-models` filtering, VoicePanel rendering).

## Step 5 — Help docs

Add `src/frontend/help/credentials/<provider>.md` mirroring `elevenlabs.md`. Include:

- Where to get the API key.
- Pricing tier explanations (most TTS providers have free tiers with monthly character caps).
- Voice quality / latency expectations.
- Setup in `wrangler.api.toml`.

## Verification checklist

- `bun run vitest run tests/unit/tts-adapters.test.ts tests/unit/per-op-tts.test.ts` passes.
- `/api/tts-models` returns the new provider's voices when the key is set, omits them otherwise.
- Voice settings panel shows a new section for the provider.
- Per-piece "↻ try different voice" picker shows the new voices grouped under the provider.
- The Analytics page's per-provider cost breakdown shows TTS character usage from the new provider.

## See also

- `dev-docs/architecture.md` — the three-registry pattern.
- `.cursor/skills/add-llm-adapter/` — same pattern for LLM providers.
- `src/frontend/help/reference/voice.md` — the user-facing voice docs (extend with the new provider).
