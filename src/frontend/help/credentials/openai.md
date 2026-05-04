---
title: "OpenAI API key"
subtitle: "GPT-5 family for LLM operations + tts-1 / tts-1-hd voices for Listen"
audiences: [admin, ops]
related:
  - reference/ai-models
  - admins/admin-overview
  - troubleshooting/common-issues
---

OpenAI is the second LLM provider Primer ships with adapters for. The same key unlocks two distinct surfaces:

1. **LLMs** — GPT-5 / GPT-5 mini / GPT-5 nano in the per-operation AI Models picker (admins can mix them with Claude per operation).
2. **TTS voices** — `tts-1` and `tts-1-hd` (six voices each: Alloy, Echo, Fable, Onyx, Nova, Shimmer) added to the Voice picker.

Both surfaces are gated on a single env key. You set it once, both light up. If you only want one of the two, restrict the key's permissions in the OpenAI dashboard (see below) — Primer will detect at request time which capabilities are available.

## What Primer reads / writes

| Surface | Endpoint | Auth |
|---------|----------|------|
| LLM (chat completions, streaming + non-streaming) | `POST https://api.openai.com/v1/chat/completions` | `Authorization: Bearer ${apiKey}` |
| LLM (JSON mode) | Same endpoint, `response_format: { type: "json_object" }` | Same |
| TTS | `POST https://api.openai.com/v1/audio/speech` | Same |

Read / generate only. Primer does not call any management endpoints.

## Auth model

OpenAI API keys ship from the OpenAI dashboard with a per-key **permissions** surface (separate from project / workspace scoping). You can restrict a key to a subset of OpenAI's API surface, which is the right move for a service account.

## Step-by-step setup

1. Sign in to <https://platform.openai.com>.
2. Open **Dashboard → API keys**.
3. (Recommended) Create a new **Project** named `Primer` so usage is tracked separately and you can set a project-specific spend cap.
4. Click **Create new secret key**.
5. Name it `Primer (production)`. Pick the project from step 3.
6. **Permissions** — pick **Restricted** and grant only the permissions Primer needs (see below).
7. Click **Create secret key** and copy the value (starts with `sk-proj-`). Shown once.

## Required permissions

When creating a **Restricted** key, OpenAI shows a permission tree. The minimum for Primer:

| Permission | Setting | Why |
|------------|---------|-----|
| **Model capabilities → Chat completions** (`/v1/chat/completions`) | **Write** | LLM operations (teaching pieces, deep dives, chat, quiz, etc.) when GPT-5 is selected. |
| **Audio → Text-to-speech** (`/v1/audio/speech`) | **Write** | Powers OpenAI voices in the Listen feature. |
| Everything else | **None / Restricted** | Primer doesn't need files, embeddings, fine-tuning, assistants, batch, vector stores, or model-management permissions. |

If you only want LLM access (not OpenAI TTS), leave **Audio → Text-to-speech** at None. OpenAI voices simply won't appear in the Voice picker (`/api/tts-models` filters by capability at request time).

If you only want TTS (not GPT-5 LLMs), leave **Chat completions** at None. The OpenAI group disappears from the AI Models picker; admins continue to use Claude for every LLM operation.

### Model access

Beyond the permission tree, the project must have access to the **`gpt-5`**, **`gpt-5-mini`**, and **`gpt-5-nano`** model IDs (or the subset you care about). Check **Project → Limits → Model usage** to see what's enabled. New projects typically have all three.

## Setting the secret on the worker

```bash
bunx wrangler secret put OPENAI_API_KEY --config wrangler.api.toml
```

For local dev, in `.dev.vars`:

```
OPENAI_API_KEY=sk-proj-...
```

The same env key is consumed by both the LLM adapter (`worker/integrations/llm/openai-adapter.ts`) and the TTS adapter (`worker/integrations/tts/openai-adapter.ts`).

## Verifying

`GET /api/health` reports `openai: ok` and `openai_tts: ok` (both light up if the key has both permissions; only `openai: ok` if you scoped TTS off).

In the UI:

- **Settings → Intelligence → AI models** — the **OpenAI** optgroup appears with GPT-5 nano / mini / full.
- **Settings → Intelligence → Voice** — OpenAI voices (Alloy / Echo / Fable / Onyx / Nova / Shimmer for `tts-1`; Alloy / Nova / Onyx for `tts-1-hd`) appear in the picker.

Common failure modes (also covered in [Common Issues](/help/troubleshooting/common-issues)):

- **`401` on TTS** but LLMs work — Key doesn't have **Audio → Text-to-speech** permission. Re-create the key with TTS write permission set to **Request**.
- **`404 model_not_found` on `gpt-5-nano`** — Project doesn't have GPT-5 nano enabled. Check **Project → Limits → Model usage**.
- **Voices disappear after rotating the key** — The new key is missing TTS permission. Re-issue with **Restricted → Audio: write**.
- **Rate limits on bursty briefings** — OpenAI's per-project rate limits scale with usage tier. Concept extraction (15-item parallel batches) hits the model hardest; cap it at GPT-5 nano if you're rate-limited on full GPT-5.

## Rotating the key

Dashboard → API keys → Revoke → create a new one with the same permissions and project, then `bunx wrangler secret put OPENAI_API_KEY`. Both LLM and TTS pick up the new key on the next request.
