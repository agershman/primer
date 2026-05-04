---
title: "Setup"
subtitle: "Getting Primer running locally and in production"
audiences: [user, ops]
related:
  - reference/configuration
  - troubleshooting/common-issues
---

## Prerequisites

- [Bun](https://bun.sh/) (Primer uses `bun` for scripts; `npm` works too if you prefer)
- A Cloudflare account (for production deployment)
- API keys for the integrations you want to use

## Local Development

Clone the repository and install dependencies:

```bash
bun install
```

Create a `.dev.vars` file in the project root with your API keys:

```
ANTHROPIC_API_KEY=sk-ant-...
LINEAR_API_KEY=lin_api_...
SLACK_TOKEN=xoxp-...
INCIDENT_IO_API_KEY=...
GITHUB_TOKEN=ghp_...           # optional — enables GitHub PR / issue context
OPENAI_API_KEY=sk-proj-...     # optional — adds OpenAI voices to the TTS picker
ELEVENLABS_API_KEY=sk_...      # optional — adds ElevenLabs voices to the TTS picker
```

**At least one LLM provider key is required** — `ANTHROPIC_API_KEY` (Claude family) or `OPENAI_API_KEY` (GPT-5 family). Both can be set to mix providers per operation (e.g. Claude Sonnet 4 for teaching pieces, GPT-5 mini for concept extraction). See [AI Models → Architecture](/help/reference/ai-models) for the full provider list and gating rules.

The others are optional but strongly recommended:
- Without **Linear** and **Slack** tokens, Primer won't have work context to draw from.
- **`GITHUB_TOKEN`** unlocks the GitHub source pipeline (PR review requests, assigned PRs, team activity).
- **`INCIDENT_IO_API_KEY`** pulls open and recently resolved incidents into your work context.
- **`OPENAI_API_KEY`** adds OpenAI's `tts-1` and `tts-1-hd` voices to the per-article voice picker. Cloudflare's Aura voices work without it.

Each integration has its own walkthrough covering credential format, step-by-step issuance, **the exact permissions Primer needs**, and how to verify — see [Credentials & Permissions overview](/help/credentials/overview) for the index, or jump directly to the per-integration doc:

- [Linear API key](/help/credentials/linear)
- [Slack app + token](/help/credentials/slack)
- [GitHub token](/help/credentials/github) — classic vs fine-grained PAT
- [incident.io API key](/help/credentials/incident-io)
- [Anthropic API key](/help/credentials/anthropic) — Claude model access
- [OpenAI API key](/help/credentials/openai) — GPT-5 + TTS permissions
- [ElevenLabs API key](/help/credentials/elevenlabs) — premium voices
- **`ELEVENLABS_API_KEY`** adds ElevenLabs voices (multilingual, turbo, flash tiers) to the per-article voice picker. Character-billed; spend lands in the same `usage_events` ledger as everything else.
- **`OPENAI_API_KEY`** also unlocks the **GPT-5 family** (nano / mini / full) in the per-operation LLM picker, alongside the OpenAI TTS voices it already enables — one key, two seams.

Apply all migrations to the local D1 database:

```bash
bun run db:migrate
```

Backed by `wrangler d1 migrations apply`, which tracks applied migrations in a `d1_migrations` table — re-running is safe and only applies pending migrations. Use `bun run db:status` to see what's pending, or `bun run db:reset` to wipe local state and re-apply everything from scratch.

Start the development server (runs both the Cloudflare Worker and the Vite frontend in parallel):

```bash
bun run dev
```

The frontend is at `http://localhost:5173` and the worker API at `http://localhost:8787`.

## First-Run Setup

The very first time you load Primer, a **two-step onboarding wizard** automatically appears asking you to write your **About you** and **Current focus** statements. This is the most important thing you can do up front — without these, briefings read like generic industry-news summaries:

1. **About you** — a short paragraph describing who you are (role, experience, communication preferences). Tailors voice and depth across teaching pieces, deep dives, chat, briefings, quizzes, and relevance scoring. Use **✨ Refine with AI** to have Claude tighten your draft, then save.
2. **Current focus** — what you want to learn or focus on right now. Drives concept extraction. Same flow.

You can **Skip for now** if you want to look around first — the prompt re-appears in the next session until both are set. After onboarding (or if you skipped), the rest of your setup happens via the **avatar menu** (top-right of the header):

- **Avatar → Set focus** — express-lane editor to update your current focus statement at any time. Saving creates a new version (full history is preserved).
- **Avatar → Settings** — full configuration panel: source filters, AI model overrides, voice (TTS) picker, version history with per-version analytics, GitHub username, retention settings.

In Settings:

- **Sources → Linear / Slack / GitHub / incident.io / Feeds** — pick which repos, channels, teams, time windows, and external feeds (RSS / HN / ArXiv) feed into your briefings. Each source's panel includes an "In scope" subsection that fills in once you've run a full briefing preview from the footer.
- **Intelligence → AI models** — pick which model handles each operation (defaults are sensible). The picker is provider-aware: each per-operation dropdown groups its options by provider via `<optgroup>` headers, and a provider's group only appears when both its adapter is registered AND its API key is set on the worker. Today Anthropic and OpenAI are both registered; Google / Workers AI / OpenRouter slot into the same picker once their adapters land.
- **Intelligence → Voice** — choose between 12 Cloudflare Aura voices, MeloTTS, and (if `OPENAI_API_KEY` is set) 9 OpenAI voices, plus (if `ELEVENLABS_API_KEY` is set) ElevenLabs voices across multilingual / turbo / flash tiers.

Click **Build full briefing preview** in the Settings footer to confirm the source filters return what you expect (each source's panel fills in its own "In scope" subsection), then visit the briefing page to generate.

## Verify Your Configuration

Before triggering a full briefing, open **Settings** and click **Build full briefing preview** in the footer. This runs every source's fetch in parallel and surfaces in-scope items inside each source's panel — Linear shows issues, Slack shows channels, Feeds shows external feeds, etc. If something you expect isn't there, adjust the filters in the relevant panel and rebuild. The button label flips to **Rebuild — filters changed** the moment you change anything after a preview. This is much faster than generating a whole briefing, looking at the work context bar, and iterating.

See [Configuration → Preview](/help/reference/configuration) for the full behavior.

## Deploying to Production

Primer's production architecture is split:
- **`primer-api`** — the Cloudflare Worker (Hono routes, D1, AI binding, all secrets) configured by `wrangler.api.toml`.
- **`primer-ui`** — Cloudflare Pages serving the static Vite build with a service binding to `primer-api`, configured by `wrangler.toml`.

Set your secrets on the API worker before the first deploy:

```bash
bunx wrangler secret put ANTHROPIC_API_KEY --config wrangler.api.toml
bunx wrangler secret put LINEAR_API_KEY --config wrangler.api.toml
bunx wrangler secret put SLACK_TOKEN --config wrangler.api.toml
bunx wrangler secret put INCIDENT_IO_API_KEY --config wrangler.api.toml
bunx wrangler secret put GITHUB_TOKEN --config wrangler.api.toml         # optional
bunx wrangler secret put OPENAI_API_KEY --config wrangler.api.toml       # optional
bunx wrangler secret put ELEVENLABS_API_KEY --config wrangler.api.toml   # optional
```

### Bootstrap the migration tracking table (once)

If the remote D1 database already has its schema in place from earlier manual `wrangler d1 execute` runs, seed the tracking table so the new runner sees those migrations as already-applied:

```bash
bun run db:bootstrap:remote
```

This is idempotent — safe to re-run.

### Apply migrations + deploy

After the bootstrap, every deploy can run migrations safely (only pending ones apply):

```bash
bun run db:migrate:remote   # apply any new migrations to remote D1
bun run deploy              # builds + deploys both API + Pages
# or, individually:
bun run deploy:api          # API worker only
bun run deploy:ui           # frontend (Pages) only — runs vite build first
```

After the first deploy you can update individual secrets at any time without redeploying — Cloudflare propagates secret changes to all edge locations within seconds.

### CI/CD via GitHub Actions

The repo includes two workflows under `.github/workflows/`:

- **`checks.yml`** — runs on every PR. Lint, typecheck, vitest, vite build.
- **`deploy.yml`** — runs on push to `main`. Re-runs all checks, then applies D1 migrations, deploys the API worker, and deploys Pages. Manual dispatch is available for re-deploys without a code change.

Required GitHub repo secrets (set under **Settings → Secrets and variables → Actions**):

- `CLOUDFLARE_API_TOKEN` — scoped Cloudflare API token (Account: Workers Scripts:Edit, D1:Edit, Cloudflare Pages:Edit, AI:Edit)
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

Worker runtime secrets (`ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, etc.) are set on the worker via `wrangler secret put` and never need to reach GitHub.

## Tailing production logs

```bash
bunx wrangler tail --config wrangler.api.toml
```

See [Common Issues](/help/troubleshooting/common-issues) for filtering tips.

## Resetting Local State

If you need a clean slate during development:

```bash
bun run db:reset
```

This removes the local Wrangler state directory and re-runs every migration.
