# Primer

🔥 Battle-tested at [Cinder](https://cinder.ai/)

Primer is a personalized daily learning briefing that keeps you sharp on the technologies, systems, and concepts you encounter at work. It scans your work signals — Linear issues, Slack conversations, GitHub PRs, incidents — maps them against a personal concept graph, and generates concise teaching content calibrated to your exact level of understanding.

Unlike passive information feeds, Primer actively identifies what you already know, finds what you don't, and teaches you at the right depth. Every briefing includes calibration quizzes that probe real understanding (not memorization), and a feed scanning layer that surfaces relevant content from external sources you configure (RSS, Atom, Hacker News, ArXiv) — there's no curated default feed list, so you wire up exactly the publishers that match your role.

Primer is split into two Cloudflare deployables: **`primer-api`** (the Worker — Hono routes, D1, AI binding, cron) and **`primer-ui`** (Cloudflare Pages — the static Vite build with a service binding to the API). Briefings generate daily via cron, and the entire system is designed for a single user (you).

Two short paragraphs you write in Settings shape everything Primer produces:
- **About you** — who you are. Tailors voice and depth across all of Primer's AI.
- **Current focus** — what you want to learn. Drives concept extraction.

Both are versioned with full history, per-version analytics, and a one-click **✨ Refine with AI** that asks Claude to tighten your draft into a prompt-ready paragraph.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (or Node.js 20+ with `npm`)
- A Cloudflare account (for production deployment)
- An LLM provider API key — `ANTHROPIC_API_KEY` (Claude family) or `OPENAI_API_KEY` (GPT-5 family). At least one must be set; both can be set to mix models per operation

### Install

```bash
git clone <repo-url> && cd primer
bun install
```

### Configure the API Worker

Copy the example config and fill in your Cloudflare account details:

```bash
cp wrangler.api.example.toml wrangler.api.toml
```

Edit `wrangler.api.toml` and replace the `<placeholders>` — at minimum, set `database_id` to your D1 database ID, `PRIMER_DEV_USER` to your email, and `GITHUB_ORG` to your GitHub org or username. See [Application Variables](#application-variables-wranglerapitoml) for the full reference.

### Configure API Keys

Create a `.dev.vars` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
LINEAR_API_KEY=lin_api_...
SLACK_TOKEN=xoxp-...
INCIDENT_IO_API_KEY=...
GITHUB_TOKEN=ghp_...           # optional — enables GitHub PR / issue context
OPENAI_API_KEY=sk-proj-...     # optional — adds OpenAI voices to the TTS picker
ELEVENLABS_API_KEY=sk_...      # optional — adds ElevenLabs voices (Rachel, Adam, Domi, Antoni in multilingual / turbo / flash tiers)
```

**At least one LLM provider key is required** — `ANTHROPIC_API_KEY` (Claude family) or `OPENAI_API_KEY` (GPT-5 family). Both can be set to mix providers per operation. The rest are optional but strongly recommended — without Linear, Slack, and GitHub tokens, briefings will rely entirely on external sources.

**Per-integration walkthroughs** — credential format, step-by-step setup in each provider's dashboard, **the exact permissions Primer needs** (Slack scopes, GitHub PAT permissions, OpenAI per-key restricted permissions, etc.), how to set the Cloudflare secret, and how to verify — live under `src/frontend/help/credentials/` and on the running app at `/help/credentials/overview`. Start there if you're standing the deployment up for the first time, or if a security reviewer asks why a particular permission is requested. Primer is a strictly read-only consumer of every external service.

### Database Setup

```bash
bun run db:migrate
```

Applies any pending migrations to the local D1 database via `wrangler d1 migrations apply`. The runner tracks state in a `d1_migrations` table, so this is safe to re-run — only pending migrations are applied. Inspect status with `bun run db:status`.

To wipe local state and re-apply everything from scratch:

```bash
bun run db:reset
```

### Development Server

```bash
bun run dev
```

This starts both the Cloudflare Worker (port 8787) and the Vite dev server (port 5173) concurrently. The Vite dev server proxies `/api` requests to the worker.

### Tests

```bash
bun x vitest run                            # full suite
bun x vitest run tests/unit/<file>.test.ts  # one file
```

`bun test` partially works but doesn't honor `@vitest-environment jsdom` directives — use `vitest` for the canonical run.

### First-run setup

After your first `bun run dev`, open the app and click your avatar to enter Settings:
1. **About you** — write a short persona paragraph; click **✨ Refine with AI**, then **Save as new version**.
2. **Current focus** — write what you want to learn; same flow.
3. **Linear / Slack / GitHub sources** — pick repos, channels, teams, time windows.
4. Click **Build full briefing preview** in the Settings footer to confirm the source filters return what you expect.

Then visit the briefing page to generate your first briefing.

## How It Works

### Briefing Lifecycle

Each daily briefing passes through a multi-step pipeline. At the start of every run, Primer loads the user's active **About** and **Focus** statements; both are injected into downstream prompts so the briefing reflects who you are and what you currently care about.

0. **Load persona context** — Resolve active About + Focus versions; stamp Focus on the briefing row + every newly-extracted concept for attribution
1. **Fetch work signals** — Pull recent activity from Linear, Slack, GitHub, and incident.io
1a. **Slack relevance filter** — Score each non-bookmarked Slack thread against About + Focus + global filterPrompt via a batched Haiku call; drop anything below `relevanceThreshold`. Bookmarked threads (🔖) bypass. Fails open on scoring errors so a transient LLM outage never strips the work context. Catches substantive-looking but off-topic lines (banter, jokes, personal logistics) that the length/pattern heuristics miss.
2. **Extract concepts** — Identify technical concepts from combined work context, biased by Focus + About; suppressed names are excluded
3. **Read concept graph** — Load current depth scores, confidence, decay status, and prerequisites (excluding suppressed concepts)
4. **Scan feeds** — Search external feeds for content related to your active concepts; About + Focus inform relevance scoring
5. **Select teaching targets** — Score candidates by relevance, delta, and novelty
6. **Generate teaching pieces** — Create content calibrated to your depth on each concept *and* tuned to your About statement (voice, tone, depth assumptions)
6a. **Continuation gate** — Each fresh draft is classified against recent (≤30 days) pieces that share concepts or sources. The classifier (Haiku) emits one of three outcomes: **NOVEL** (persist standalone), **ADDITIVE_CONTINUATION** (rewrite with a callback opener; backfill the predecessor as Part 1; persist as Part 2/3/...), or **REDUNDANT** (drop and surface as a "no new movement" chip in the briefing header). Biased toward NOVEL when uncertain, fails open to NOVEL on any classifier error so the pipeline never drops a piece because the gate had a bad day. See `src/worker/services/continuation-classifier.ts`.
7. **Generate calibration quiz** — Target the concept most in need of calibration; framing calibrated against About
8. **Store briefing** — Write everything to D1

Briefings generate automatically at **05:00 UTC weekdays** via cron, with each briefing's `briefing_date` stamped using the user's stored timezone (see [Timezones](dev-docs/usage.md#timezones) in the usage guide). A Sunday maintenance job (**03:00 UTC**) handles concept decay, retention sweeps, and reaping stuck notifications. Manual generation is available from the refresh button next to the date on the briefing page.

During generation, the UI shows a step-by-step progress timeline with granular details — you can see each Linear ticket being read, Slack threads being searched, and concepts being extracted in real time. The timeline includes an adaptive ETA based on your historical briefing durations, and teaching pieces appear progressively as they're built (you don't wait for the full pipeline to finish).

Generation can be cancelled at any time via the **Cancel** button on the progress timeline. The button flips to "Cancelling…" immediately and the run stops at the next checkpoint (between pipeline steps or between individual teaching pieces). The cancel flag lives in a dedicated `cancel_requested` column so progress writes can't stomp it, and refreshing the page does **not** un-cancel — the flag is persisted server-side. Cancellation is idempotent: triggering a fresh generation afterwards deletes the cancelled row and starts clean.

Every LLM HTTP call has a 120-second hard timeout (AbortController) — honoured by the Anthropic and OpenAI adapters today, and the contract any future adapter is expected to honour — so a stalled socket can't wedge generation indefinitely. If the server hasn't written progress for more than 3 minutes, the status endpoint flags the run as `stuck: true` and the UI surfaces a **Force stop** button. Force stop calls `POST /api/briefing/reset`, which unconditionally deletes today's briefing row — the escape hatch for zombie runs. `POST /api/briefing/generate` also auto-heals: if it finds a stuck row (`updated_at` > 3 minutes ago and status = "generating"), it deletes and starts fresh instead of returning "already generating".

To keep generation fast even over large work contexts, concept extraction runs in parallel batches of 15 items. A typical briefing over 60+ Linear/Slack items completes in seconds rather than minutes.

### Concept Graph

Your concept graph is a directed graph of technical concepts with depth scores (0–5), confidence levels (0–1), and relationships (prerequisite, leads-to, adjacent). Concepts are extracted automatically from work signals and calibrated through quizzes and feedback.

The depth scale:
- **0 Unknown** — Not yet encountered
- **1 Aware** — Recognizes the term
- **2 Understands** — Grasps mechanics
- **3 Applies** — Uses effectively in production
- **4 Teaches** — Can teach others
- **5 Authoritative** — Deep expertise

### Calibration

Each briefing includes one open-ended quiz question targeting the concept where calibration would be most valuable. Quiz assessment evaluates demonstrated understanding and produces three outputs: a depth adjustment, identified gaps in thinking, and a suggested learning path with resources.

Baseline calibration triggers when 3+ concepts are below depth 2, presenting a batch of 3–6 questions in one session.

### Feed Scanning

External feeds are scanned for content that overlaps with your active concepts but comes from outside your work context. **The source list is deployment-level and editable, and starts empty** — there's no curated starter pack baked in (different teams have different interests, and platform-flavored defaults aren't useful to a sales lead or designer). Configuration lives in **Settings → Sources → Feeds**, which supports three flows:

- Add an RSS feed by URL (the universal interop).
- Click **✨ Suggest** to have Claude propose ~8 well-known feeds matching your About + Focus, each as a one-click "Add" card.
- Toggle/remove existing sources, including the defaults.

The source list lives in `source_instances`. The feed scanner reads from this table and dispatches each row to the right fetcher (HN Firebase API, ArXiv XML, generic RSS). Feeds are sources with `multiInstance: true` — each DB row is an independent feed instance.

## Roles: Admin vs Regular User

Primer ships with a deliberately simple two-role model — one boolean (`users.is_admin`) is enough for the typical install pattern (one team or one person owns the deployment, everyone else just reads briefings).

- **Admin** — configures deployment-wide settings: source filters (Linear, Slack, GitHub, incident.io, Feeds), per-operation AI model picks, voice defaults, and limits (budget cap, relevance threshold, near-miss floor). Admins also see the per-piece **↻ try different model** affordance and the inline `voice: <name> ↻` switcher (both update deployment-wide defaults).
- **Regular user** — adjusts their own personalization: **About you**, **Current focus**, **Relevance filter** prompt + per-source overrides. Reads briefings, takes quizzes, runs deep dives, listens, chats — the full reading surface — but can't change deployment-wide config.

**Bootstrap rule:** the first user to provision a fresh deployment is automatically promoted to admin (atomic INSERT-SELECT in `worker/middleware/user-context.ts` so two simultaneous first-time provisions can't both stamp themselves admin). On schemas that already had user rows when migration `0002_user_admin.sql` runs, the **earliest-created** row is backfilled as admin so an installed system upgrades cleanly. Promote additional admins by hand via D1: `UPDATE users SET is_admin = 1 WHERE email = 'someone@example.com';`.

Server-side enforcement is the bar: `PATCH /api/settings` rejects admin-only fields with `403`, every `POST/PATCH/DELETE /api/source-instances*` is gated, and `POST /api/piece/:id/regenerate` requires admin. The frontend hides admin-only Settings panels + the per-piece pickers for regular users — but that's a UX hint, not a security boundary.

## Day-to-Day Usage

Per-feature behavior — reading briefings, deep dives, baseline calibration, chat, audio, settings, keyboard shortcuts, and the analytics page — is documented in [`dev-docs/usage.md`](dev-docs/usage.md). The same content (split into per-page articles with audience tags) is also served inside the running app at `/help`.

## Configuration

### Application Variables (wrangler.api.toml)

The API worker config is **not committed** — it contains account-specific values (D1 database ID, email, GitHub org). An example is provided:

```bash
cp wrangler.api.example.toml wrangler.api.toml
```

Then edit `wrangler.api.toml` and fill in your values:

| Placeholder | What to set |
|-------------|-------------|
| `<your-d1-database-id>` | Your Cloudflare D1 database ID (find it in the Cloudflare dashboard under Workers & Pages → D1) |
| `<your-email>` | Your email address (used as the dev user identity) |
| `<your-github-org>` | Your GitHub organization or username (used for PR/issue context) |

The following `[vars]` are pre-configured with sensible defaults in the example file. Adjust as needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `BUDGET_CAP_MONTHLY` | `35` | Max monthly AI spend (USD) across **all providers and modalities** — LLM tokens (Anthropic Claude + OpenAI GPT-5 today, more providers expansion-ready) plus TTS characters (Cloudflare Aura / MeloTTS, OpenAI, ElevenLabs). Read from the unified `usage_events` ledger. |
| `RETENTION_DAYS` | `365` | Briefing/piece retention |
| `NEAR_MISS_RETENTION_DAYS` | `30` | Near-miss retention |
| `RELEVANCE_THRESHOLD` | `0.4` | Min score to become a teaching piece |
| `NEAR_MISS_FLOOR` | `0.25` | Min score to be captured as a near miss |

The example also ships with `[limits] cpu_ms = 300000` (5 minutes — the Workers Paid maximum). **Do not lower this.** Long-running operations (deep dives, briefing generation, baseline calibration prep) all run under `c.executionCtx.waitUntil(...)` and share the worker's CPU budget. The default 30s gets cancelled mid-run and the user sees notifications that never flip to `ready`. See [ADR 0005](dev-docs/adrs/0005-streaming-plus-waituntil.md) for the full reasoning. There's no extra usage charge for raising this — `cpu_ms` is a ceiling, not a target, and LLM calls are subrequests that don't burn CPU during the wait.

### Source Configuration

Sources are **deployment-level** (shared across all users of the instance) and managed at `/admin/sources`. The legacy file `src/worker/config/signal-surfaces.ts` carries fallback defaults only. Per-user source filters live in `user_settings.source_config` — users pick which channels, teams, and time windows to include via **Settings → Sources**.

Users can also set an **AI relevance filter prompt** (a global prompt plus optional per-source overrides) under **Settings → Personalization → Relevance filter**. This lets you teach Primer what "relevant" means for you without writing code.

Source providers are **pluggable** — new sources can be added by implementing the `SourceProvider` interface and registering with the `SourceRegistry`. See `.cursor/skills/source-providers/SKILL.md` for the full guide.

Active configuration surfaces:
- **Slack channels** — picked from your workspace via the channel picker on **Settings → Sources → Slack**.
- **Linear teams + status filter** — picked on **Settings → Sources → Linear** (the team list comes from your Linear API key on demand).
- **Feeds** — deployment-level list in `source_instances`; managed under **Settings → Sources → Feeds**, where ✨ Suggest proposes new feeds based on your About + Focus.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide — local setup, the dev / typecheck / lint / test loop, conventions (Biome formatter, source-text contract tests, D1 migration patterns, help-doc persona tagging, admin-gating), the PR workflow + checklist, and how to report bugs. The PR template under `.github/PULL_REQUEST_TEMPLATE.md` mirrors the same checklist so it shows up automatically when you open a PR via `gh pr create` or the GitHub UI.

For deeper extension work — adding an LLM adapter, TTS adapter, source provider, or pipeline step — start at [`src/frontend/help/developers/extending-primer.md`](src/frontend/help/developers/extending-primer.md). The source-provider pattern lives in [`.cursor/skills/source-providers/SKILL.md`](.cursor/skills/source-providers/SKILL.md).

## CI/CD

GitHub Actions handles checks on PRs and continuous deployment on merges to `main`.

| Workflow | File | Trigger |
|---|---|---|
| Checks | [`.github/workflows/checks.yml`](.github/workflows/checks.yml) | Every PR (and manual dispatch) — lint, typecheck, vitest, vite build |
| Deploy | [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) | Push to `main` (and manual dispatch) — runs the same checks, then applies D1 migrations, deploys the API worker, and deploys Pages |

### Required GitHub repo secrets

Set these once in the repo's **Settings → Secrets and variables → Actions**. Cloudflare's official secret-creation guidance is at https://developers.cloudflare.com/workers/wrangler/ci-cd/.

- **`CLOUDFLARE_API_TOKEN`** — A scoped API token with these permissions on your Cloudflare account:
  - **Account**: `Workers Scripts:Edit`, `Workers KV Storage:Edit`, `D1:Edit`, `Cloudflare Pages:Edit`, `AI:Edit`
  - **Zone**: none required for Primer (no zone-level config)
- **`CLOUDFLARE_ACCOUNT_ID`** — Your Cloudflare account ID (found in the dashboard under **Workers & Pages → Overview**)

The token only authenticates the deploy runner; the worker's own runtime secrets (`ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, `SLACK_TOKEN`, `INCIDENT_IO_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`) live on the worker itself via `wrangler secret put` and never need to reach GitHub.

### One-time bootstrap (existing remote D1 → wrangler migrations runner)

Because production D1 already has the schema in place from manual `wrangler d1 execute` runs before CI/CD existed, you need to seed the `d1_migrations` tracking table once so the runner doesn't try to re-apply 0001–0010:

```bash
bun run db:bootstrap:remote
```

This runs [`scripts/bootstrap-remote-migrations.sh`](scripts/bootstrap-remote-migrations.sh), which inserts one row per existing migration into `d1_migrations` on remote. After that, every `bun run db:migrate:remote` (and every CI deploy) sees the existing migrations as applied and only runs new ones.

The script is idempotent — re-running it is safe.

### Recommended branch protection

Configure in **Settings → Branches → Branch protection rules** for `main`:

- **Require pull request before merging**
- **Require status checks: `check`** (the `Lint, typecheck, test, build` job from `checks.yml`)
- **Require linear history** (optional but keeps `main` clean)

These can't be set via committed config — only via the GitHub repo UI or `gh api`.

### Deploying manually

The `bun run deploy` / `deploy:api` / `deploy:ui` scripts still work for ad-hoc local deploys, mirroring exactly what CI does. Useful for testing a config change before merging, or for emergency rollouts when CI is busy.

```bash
bun run deploy        # builds + deploys both API + Pages from your laptop
bun run deploy:api    # API worker only
bun run deploy:ui     # frontend (Pages) only
```

Manual local deploys do NOT run migrations — use `bun run db:migrate:remote` separately if your changes touch the schema.

## Deploying Primer

The complete deployment guide — Cloudflare service inventory, the full `wrangler.api.toml` configuration surface, auth model (Cloudflare Access JWT verification, email allowlist, bring-your-own auth-proxy mode), security practices, cost estimates with April 2026 pricing, and the one-time production setup steps — lives in [`dev-docs/deploying.md`](dev-docs/deploying.md). The user-facing version is at [`src/frontend/help/ops/deploying-primer.md`](src/frontend/help/ops/deploying-primer.md) (also rendered at `/help/ops/deploying-primer` in the running app).

## Troubleshooting

**Briefing didn't generate** — Check `/api/health` for integration status. Verify at least one LLM provider key is set (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) and that the model picked in **Settings → Intelligence → AI models** for the operation that's failing comes from a provider whose key is configured. Check if the monthly budget cap has been reached via `/api/stats`.

**Partial briefing** — Limited work context or API rate limits during generation. Check the work context bar for source counts.

**Stuck / slow generation** — Click **Cancel** on the progress timeline, then retry. If concept extraction is slow, consider switching to Haiku for `conceptExtraction` in Settings → Intelligence → AI models.

**Stale concepts / decay warnings** — Engage actively (answer quizzes, give feedback). Check concept aliases if terms don't match.

**Reset local state** — `bun run db:reset` removes local Wrangler state and re-runs all migrations.

## Architecture

```
primer/
├── src/
│   ├── frontend/               # React SPA (Vite)
│   │   ├── components/         # Reusable UI components
│   │   ├── hooks/              # React hooks (useBriefing, useConcepts, useHelp, etc.)
│   │   ├── lib/                # Utilities (helpRegistry)
│   │   ├── pages/              # Route pages (Briefing, Concepts, Archive, Help, Calibrate)
│   │   ├── help/               # Markdown help articles with YAML frontmatter
│   │   ├── styles/             # Tailwind tokens and theme
│   │   ├── App.tsx             # Router
│   │   └── main.tsx            # Entry point
│   └── worker/                 # Cloudflare Worker (Hono)
│       ├── config/             # Constants, source configuration, models catalog, pricing
│       ├── integrations/       # Linear, Slack, incident.io, feeds, llm/ (adapter seam → Anthropic + OpenAI), tts/ (adapter seam → Cloudflare / OpenAI / ElevenLabs)
│       ├── middleware/          # Auth, user context
│       ├── routes/             # API route handlers
│       ├── services/           # Business logic (briefing generator, concept extractor, etc.)
│       └── db/                 # Database queries
├── migrations/                 # D1 SQL migrations
├── wrangler.toml               # Cloudflare Pages (UI) config
├── wrangler.api.example.toml   # Cloudflare Worker (API) config template — copy to wrangler.api.toml and fill in your values
├── scripts/                    # Bootstrap + ops scripts (e.g. bootstrap-remote-migrations.sh)
├── dev-docs/                   # Architecture diagram + ADRs + extended usage / deploying guides
├── .cursor/skills/             # Task-specific guides (source-providers, add-llm-adapter, …)
├── vite.config.ts              # Vite config
└── package.json
```

**Tech stack:** React 19 · React Router 7 · Tailwind CSS 4 · Hono · Cloudflare Workers · D1 · Anthropic Claude + OpenAI GPT-5 (today, behind a provider-agnostic LLM adapter) · Cloudflare Workers AI / OpenAI / ElevenLabs TTS (behind a provider-agnostic TTS adapter)

**Going deeper:** [`dev-docs/architecture.md`](dev-docs/architecture.md) has the full system shape (request flow, briefing pipeline, registry pattern). [`dev-docs/usage.md`](dev-docs/usage.md) is the in-depth feature guide. [`dev-docs/deploying.md`](dev-docs/deploying.md) is the complete Cloudflare deployment playbook. [`dev-docs/adrs/`](dev-docs/adrs/) explains non-obvious design decisions. [`.cursor/skills/`](.cursor/skills/) has agent-friendly task guides for adding adapters, routes, and pipeline steps.
