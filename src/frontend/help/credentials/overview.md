---
title: "Credentials overview"
subtitle: "Every external integration Primer talks to, with links to per-integration setup"
audiences: [admin, ops]
related:
  - getting-started/setup
  - admins/admin-overview
  - ops/deploying-primer
---

This is the index of every external service Primer connects to. Each entry below links to a per-integration walkthrough that covers the credential format, the exact step-by-step setup, the **specific permissions Primer needs** (and what it doesn't), how to set the secret on the Cloudflare Worker, how to verify, and how to rotate.

## At a glance

| Integration | Required? | Env variable | Walkthrough |
|-------------|-----------|--------------|-------------|
| **Anthropic** (Claude LLMs) | One LLM provider required | `ANTHROPIC_API_KEY` | [Anthropic API key](/help/credentials/anthropic) |
| **OpenAI** (GPT-5 LLMs + TTS voices) | One LLM provider required | `OPENAI_API_KEY` | [OpenAI API key](/help/credentials/openai) |
| **Linear** (work-context source) | Recommended | `LINEAR_API_KEY` | [Linear API key](/help/credentials/linear) |
| **Slack** (work-context source) | Recommended | `SLACK_TOKEN` | [Slack app + token](/help/credentials/slack) |
| **GitHub** (work-context source) | Optional | `GITHUB_TOKEN` | [GitHub token](/help/credentials/github) |
| **incident.io** (work-context source) | Optional | `INCIDENT_IO_API_KEY` | [incident.io API key](/help/credentials/incident-io) |
| **ElevenLabs** (premium TTS voices) | Optional | `ELEVENLABS_API_KEY` | [ElevenLabs API key](/help/credentials/elevenlabs) |
| **Cloudflare Workers AI** (TTS — Aura + MeloTTS) | Bundled with the Worker — no separate key | (uses `[ai] binding = "AI"` in wrangler config) | n/a |

**Required**: at least one LLM provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Both can be set to mix models per operation.

**Recommended**: Linear + Slack tokens. Without work-source tokens, briefings rely entirely on external feeds (Hacker News, ArXiv, AWS / GCP changelogs, RSS) — useful but no longer personalized to your team's actual work.

**Optional**: everything else. Each integration is detected at request time, so missing keys never crash anything — the corresponding source / provider / voice just doesn't appear in the UI.

## Setting secrets on Cloudflare

All credential env vars are stored as Cloudflare Worker secrets, not committed to the repo. Set each with:

```bash
bunx wrangler secret put NAME --config wrangler.api.toml
```

Cloudflare propagates secret changes to every edge location within seconds. There's no need to redeploy when rotating a key. Verify with:

```bash
bunx wrangler secret list --config wrangler.api.toml
```

For local development, the same env vars live in `.dev.vars` at the project root (not committed). The format is `KEY=value` per line — see [Setup](/help/getting-started/setup) for the full local-dev walkthrough.

## Auth model summary

Different integrations use different auth schemes. Each walkthrough spells this out, but at a glance:

| Header | Used by |
|--------|---------|
| `Authorization: Bearer <token>` | Slack, OpenAI, incident.io |
| `Authorization: token <token>` | GitHub (REST, classic + fine-grained PATs both accept this) |
| `x-api-key: <key>` | Anthropic, ElevenLabs |
| Linear SDK (handles Bearer internally) | Linear |
| Cloudflare AI binding (no header — `env.AI.run(...)`) | Workers AI for TTS |

## Principle of least privilege

Each walkthrough lists the **minimum** scopes / permissions Primer actually uses. We deliberately don't ask for write capabilities anywhere — Primer is a read-only consumer of every external service. If your security review asks why a permission is requested, the per-integration doc has the specific endpoint + line of code that needs it.

If any walkthrough seems to ask for more than is needed, that's a bug — file it against the help docs. The codebase is the source of truth; the docs reflect what the worker actually calls.
