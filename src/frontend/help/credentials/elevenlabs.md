---
title: "ElevenLabs API key"
subtitle: "Premium TTS voices (Multilingual / Turbo / Flash) for Listen"
audiences: [admin, ops]
related:
  - reference/configuration
  - admins/admin-overview
---

ElevenLabs is an optional TTS provider. When configured, its voices appear alongside Cloudflare Aura + OpenAI in the Voice picker. ElevenLabs is the most expensive of the three providers ($0.30 / 1k chars on Multilingual) but produces the most natural-sounding speech.

## What Primer uses it for

Streaming text-to-speech for every Listen surface (teaching pieces, deep dives, chat replies). Voice catalog entries Primer ships with:

| Tier | Model id | Voices |
|------|----------|--------|
| Multilingual (premium) | `eleven_multilingual_v2` | Rachel, Adam, Domi, Antoni |
| Turbo (balanced) | `eleven_turbo_v2_5` | Rachel, Adam |
| Flash (real-time / budget) | `eleven_flash_v2_5` | Rachel, Adam |

Primer hits **`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128`** for each chunk of text, returns the streaming MP3 to the browser, and writes a `usage_events` row with the character count + estimated cost.

## Auth model

ElevenLabs uses an API key sent via the `xi-api-key` header (not Bearer). Keys are issued per-account from the ElevenLabs dashboard.

## Step-by-step setup

1. Sign in (or sign up) at <https://elevenlabs.io>.
2. Open your **Profile** menu (top-right) and click **Profile + API Key**.
3. The dashboard shows your key under **API Key**. Click **Copy**. (ElevenLabs lets you regenerate but doesn't expose multiple per-account keys via the standard UI; for separate-account isolation, create a service-only ElevenLabs account.)

If your account is on a paid plan with team / workspace features, you can create scoped API keys via **Workspace → API Keys** — same flow, but you can name them.

## Required permissions

The standard ElevenLabs API key has full account access. There's no per-endpoint permission scoping the way OpenAI restricts keys. The minimum the key needs is:

- Access to **text-to-speech** generation
- Access to your account's **available voices** (the voice IDs Primer references — Rachel, Adam, Domi, Antoni — are part of ElevenLabs' default voice library)

If you're on a workspace-scoped plan, document the key as **Read voice + Generate TTS** if those toggles are exposed.

Primer does **not** need:

- Voice cloning / voice creation permissions
- Speech-to-text permissions
- Project / dubbing permissions
- History management permissions

If the dashboard offers granular toggles, only enable TTS generation.

## Setting the secret on the worker

```bash
bunx wrangler secret put ELEVENLABS_API_KEY --config wrangler.api.toml
```

For local dev, in `.dev.vars`:

```
ELEVENLABS_API_KEY=sk_...
```

## Verifying

`GET /api/health` reports `elevenlabs_tts: ok`. The Voice picker in **Settings → Intelligence → Voice** shows an **ElevenLabs** optgroup with Multilingual / Turbo / Flash entries.

Trigger a Listen on any teaching piece and switch to an ElevenLabs voice — the audio should stream within ~200–400ms.

Common failure modes:

- **ElevenLabs entries don't appear in the picker** — `/api/tts-models` filters by configured provider keys at request time. Confirm the secret was actually set: `bunx wrangler secret list --config wrangler.api.toml`.
- **`401 Unauthorized`** — Key revoked or pasted incorrectly. The `xi-api-key` header is the only auth surface; copy / paste again carefully.
- **`429 Too Many Requests`** — ElevenLabs rate-limits per minute on free / starter tiers. Upgrade the plan or reduce concurrent Listen sessions.
- **`Voice not found`** — Account doesn't have the default voice library (Rachel, Adam, etc.). Check ElevenLabs dashboard → Voices.

## Cost notes

ElevenLabs is character-billed; each TTS request writes a `usage_events` row with provider `elevenlabs`, voice id, character count, and estimated cost. The Analytics page shows ElevenLabs spend stacked alongside Cloudflare Aura and OpenAI TTS so admins can see at a glance which voice is eating the budget. Dialing in the right tier per surface (Flash for chat replies that read once and disappear, Multilingual for teaching pieces you might re-listen to) makes a big difference — see [Configuration → Voice](/help/reference/configuration) for the per-surface picker.

## Rotating the key

Dashboard → Profile → regenerate API key. Then `bunx wrangler secret put ELEVENLABS_API_KEY`. Note that regenerating invalidates the old key immediately, so any in-flight TTS request mid-rotation will 401 — prefer off-hours.
