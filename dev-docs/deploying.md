# Deploying Primer (Cloudflare hosting)

Primer is a Cloudflare-native deployment — there's no other infrastructure to provision. This document covers what you'll need from Cloudflare, every configurability knob, the auth model, security practices, and a cost estimate with current April 2026 pricing so you can plan a budget before the first deploy.

For the step-by-step deploy commands themselves, see [Production setup (one-time)](#production-setup-one-time) below or the help doc at [`src/frontend/help/ops/deploying-primer.md`](../src/frontend/help/ops/deploying-primer.md).

## Cloudflare services Primer uses

| Service | What it stores / does | Configured via |
|---------|------------------------|-----------------|
| **Workers** (`primer-api`) | Hono API surface, daily briefing cron, Sunday maintenance cron, every `/api/*` route | `wrangler.api.toml` → `name`, `main`, `compatibility_date`, `[triggers].crons` |
| **Pages** (`primer-ui`) | Static Vite build of the React frontend, served from Cloudflare's edge with a service binding to `primer-api` so `/api/*` requests stay on Cloudflare's network | `wrangler.toml` |
| **D1** (`primer-db`) | SQLite database — users, briefings, teaching pieces, concepts, depth history, notifications, the `usage_events` cost ledger | `wrangler.api.toml` → `[[d1_databases]]`. Schema lives in `migrations/`, applied via `bun run db:migrate:remote`. |
| **Workers AI** (`AI` binding) | Cloudflare-hosted TTS (Deepgram Aura voices + MeloTTS). Optional — only used when the user picks an Aura voice. | `wrangler.api.toml` → `[ai].binding = "AI"` |
| **Cron Triggers** | Two crons — daily briefings at `0 5 * * *` (5 AM UTC every day) and maintenance at `0 3 * * SUN` | `wrangler.api.toml` → `[triggers].crons` |
| **Cloudflare Access** (recommended) | Auth in front of the Worker — Primer reads the `CF-Access-JWT-Assertion` header to identify users | Cloudflare Zero Trust dashboard |

You don't need a domain registered with Cloudflare. The default `*.workers.dev` and `*.pages.dev` URLs work fine for personal / internal deployments. If you have a custom domain, add it via the Workers / Pages routing UI.

## Account requirements

- A **Cloudflare account** — free tier is fine to start; you'll need the **Workers Paid** plan ($5/mo) to use D1 above the free thresholds and to remove the daily-request cap. For a single-user deployment on the Workers free plan, the 100k requests/day limit is generous, but D1 paid limits are what you'll typically hit first. See [Cost estimate](#cost-estimate) below.
- **`wrangler` CLI** (bundled with Bun via `bunx`). No global install needed.
- **Account API token** for CI/CD deploys with these permissions: `Workers Scripts:Edit`, `Workers KV Storage:Edit`, `D1:Edit`, `Cloudflare Pages:Edit`, `AI:Edit`. No zone-level permissions are required.

## Configuration surface

Primer is configured at three layers, each with a clear purpose:

### 1. Build-time vars (`wrangler.api.toml [vars]`) — committed, shipped on deploy

| Variable | Default | Tune when |
|----------|---------|-----------|
| `BUDGET_CAP_MONTHLY` | `35` | You want to bound monthly AI spend. Read from the unified `usage_events` ledger; generation pauses past this cap. |
| `RETENTION_DAYS` | `365` | You want to keep more / less briefing history. The Sunday maintenance cron prunes pieces older than this. |
| `NEAR_MISS_RETENTION_DAYS` | `30` | Near-miss item retention is shorter than briefing retention by default — they're scratch data. |
| `RELEVANCE_THRESHOLD` | `0.4` | The score above which a candidate becomes a teaching piece. Same knob is reused by the Slack relevance filter to drop banter. |
| `NEAR_MISS_FLOOR` | `0.25` | Below this score, an item isn't even captured as a near-miss. |
| `PRIMER_AUTH_MODE` | `cloudflare-access` | Selects an `AuthProvider`. `cloudflare-access` (default) verifies Cloudflare Access JWTs against JWKS. `dev-header` reads a trusted upstream-proxy header — for local dev or non-Cloudflare deployments. See ADR 0006. |
| `CF_ACCESS_TEAM_DOMAIN` | (required in `cloudflare-access` mode) | Your Cloudflare Zero Trust team domain (e.g. `<your-team>.cloudflareaccess.com`). Used for the JWKS URL and `iss` claim. |
| `CF_ACCESS_AUD` | (required in `cloudflare-access` mode) | The per-application "Application Audience" tag from the Access app. Pinning this prevents a JWT issued for a different Access app on the same team from being accepted. |
| `ALLOWED_EMAIL_DOMAINS` | (unset) | Comma-separated bare domains permitted to use this deployment. Defense in depth behind the Access policy. |
| `ALLOWED_EMAILS` | (unset) | Comma-separated explicit emails permitted. Either domain match or explicit match passes. |
| `PRIMER_DEV_HEADER_NAME` | `X-Primer-Dev-User` | Override for the trusted-header path (e.g. `X-Forwarded-Email` for oauth2-proxy, `X-Pomerium-Claim-Email` for Pomerium, `Tailscale-User-Login` for Tailscale Serve). Only used in `dev-header` mode. |
| `PRIMER_DEV_USER` | (set in `.dev.vars` only) | Local-dev fallback email when `dev-header` mode is active and no header is set. Production deployments must NOT set this in wrangler vars. |
| `GITHUB_ORG` | (unset) | Your GitHub organization slug, used for org-scoped queries (teams, repos). |

### 2. Runtime secrets (`wrangler secret put …`) — never committed, never in CI logs

| Secret | Required? | Purpose | Walkthrough |
|--------|-----------|---------|-------------|
| `ANTHROPIC_API_KEY` | One LLM key required | Claude family (Haiku / Sonnet / Opus) | [credentials/anthropic.md](../src/frontend/help/credentials/anthropic.md) |
| `OPENAI_API_KEY` | One LLM key required | GPT-5 family + OpenAI TTS voices | [credentials/openai.md](../src/frontend/help/credentials/openai.md) |
| `LINEAR_API_KEY` | Recommended | Linear work-context source | [credentials/linear.md](../src/frontend/help/credentials/linear.md) |
| `SLACK_TOKEN` | Recommended | Slack work-context source | [credentials/slack.md](../src/frontend/help/credentials/slack.md) |
| `GITHUB_TOKEN` | Optional | GitHub work-context source | [credentials/github.md](../src/frontend/help/credentials/github.md) |
| `INCIDENT_IO_API_KEY` | Optional | incident.io work-context source | [credentials/incident-io.md](../src/frontend/help/credentials/incident-io.md) |
| `ELEVENLABS_API_KEY` | Optional | Premium TTS voices | [credentials/elevenlabs.md](../src/frontend/help/credentials/elevenlabs.md) |

Secrets propagate to all edge locations within seconds — rotating one never requires a redeploy. Each per-integration walkthrough specifies the **minimum scopes / permissions** Primer needs (we're a strictly read-only consumer of every external service).

### 3. Per-user runtime settings — stored in D1, edited from the UI

These live in the `user_settings` table and are managed from the Settings modal. Admins see Sources / Intelligence / General panels (deployment-wide config); regular users see only Personalization (their own About / Focus / Relevance filter). See [Roles: Admin vs Regular User](../README.md#roles-admin-vs-regular-user) for the full breakdown.

## Authentication & authorization

Auth is the fourth registry-pattern extension point in Primer (alongside LLM / TTS / source providers — see `dev-docs/architecture.md`). The shape is documented in [ADR 0006](adrs/0006-auth-provider-extension-point.md); adding a new provider is documented in `.cursor/skills/auth-providers/`.

### Authentication — Cloudflare Access (default, recommended)

Production Primer is designed to sit behind **Cloudflare Access**. The Worker re-verifies the `CF-Access-JWT-Assertion` header on every request — checking the signature against Cloudflare's JWKS, the `iss` claim against the configured team domain, the `aud` claim against the configured Application Audience tag, and the `exp` (via [`jose`](https://github.com/panva/jose)). Only after verification does the Worker read the `email` claim as the user identity (see `src/worker/middleware/auth/cloudflare-access.ts`). Cloudflare Access handles SSO with whichever IdP you point it at (Google, Okta, GitHub, generic SAML/OIDC).

Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `wrangler.api.toml [vars]`. The factory fails closed at first request if either is missing, so a misconfigured deploy doesn't silently accept any JWT.

- **Free up to 50 users** on the Cloudflare Access free plan — adequate for any single-team deployment.
- Above 50 users, Cloudflare Zero Trust pricing kicks in at **$7/user/month** (Pay-as-you-go, billed annually) [as of April 2026](https://www.cloudflare.com/teams-pricing/).

### Email allowlist (defense in depth)

`ALLOWED_EMAIL_DOMAINS` and `ALLOWED_EMAILS` gate which authenticated users can reach the deployment, independent of the upstream Access policy. Either match passes. The allowlist runs INSIDE every auth provider's `authenticate` call — upstream of the first-user-wins admin bootstrap in `user-context.ts` — so a non-allowlisted caller on a fresh deploy cannot capture admin even if the Access policy is misconfigured. If both vars are unset the allowlist is fully permissive (documented hobbyist mode); production deploys should set at least one.

### Bring your own auth proxy (non-Cloudflare deployments)

A deployer running Primer behind oauth2-proxy, Pomerium, Tailscale Serve, nginx + OIDC, or any other "trusted upstream proxy" pattern can run in `dev-header` mode and configure the header name to whatever their proxy injects:

```toml
PRIMER_AUTH_MODE = "dev-header"
PRIMER_DEV_HEADER_NAME = "X-Forwarded-Email"  # oauth2-proxy
# PRIMER_DEV_HEADER_NAME = "X-Pomerium-Claim-Email"
# PRIMER_DEV_HEADER_NAME = "Tailscale-User-Login"
ALLOWED_EMAIL_DOMAINS = "your-domain.com"
```

The provider trusts whatever email the configured header carries — the security model assumes the upstream proxy strips any client-supplied version of that header before forwarding. Always pair with a non-empty allowlist.

### Local development

`bun run dev` runs the worker with `wrangler dev`, which loads `.dev.vars`. Set:

```
PRIMER_AUTH_MODE=dev-header
PRIMER_DEV_USER=<your-email>
```

`.dev.vars` is `.gitignore`-d, so these never reach production. The vite dev proxy injects `X-Primer-Dev-User` automatically; the env fallback covers `wrangler dev` direct hits without the proxy.

`PRIMER_DEV_USER` is intentionally **not** a production wrangler var. Setting it in `wrangler.api.toml` would let any request that bypasses Cloudflare Access (e.g. via the default `*.workers.dev` URL) auto-authenticate as that email — exactly the footgun this refactor closes.

### Authorization — admin vs regular user

Primer has a deliberately simple two-role model backed by `users.is_admin`:

- **First user** to provision a fresh deployment is automatically promoted to admin (atomic INSERT-SELECT in `worker/middleware/user-context.ts` so two simultaneous first-time signups can't both claim it). The bootstrap admin sees a one-time welcome dialog explaining what their role enables.
- **Subsequent users** are regular by default. Admins promote / demote them from **Settings → Users** — each row has a Promote / Demote button. The server enforces last-admin protection (409 on the only remaining admin) so the deployment can never lock itself out via the UI. The D1 SQL recipe (`UPDATE users SET is_admin = 1 WHERE email = ...`) still works for pre-UI bootstrapping if needed.
- **Server gates** are the security boundary — `PATCH /api/settings` rejects admin-only fields with 403, every `POST/PATCH/DELETE /api/source-instances*` requires admin, `POST /api/piece/:id/regenerate` requires admin, and `GET /api/users` + `PATCH /api/users/:id` (the Users panel's backend) require admin. The frontend hides admin-only UI based on `GET /api/me`'s `isAdmin` flag, but that's a UX hint.

See [`src/frontend/help/admins/admin-overview.md`](../src/frontend/help/admins/admin-overview.md) for the full role model.

## Security practices and assumptions

- **Read-only by design.** Primer never writes to Linear, Slack, GitHub, or incident.io. The credential walkthroughs ask for the minimum scopes required to read what the briefing pipeline consumes — nothing else. If a security review questions a permission, the per-integration doc has the exact endpoint + line of code that needs it.
- **Secrets stay on the worker.** Runtime secrets (`ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, etc.) are stored via `wrangler secret put` and never reach GitHub. The only secret in CI is the `CLOUDFLARE_API_TOKEN`, scoped to deploy-only permissions on your Cloudflare account.
- **No secret-bearing logs.** Wrangler tail and Workers Logs (20M events/month free on Workers Paid) capture HTTP method, path, status, and duration — no auth headers or request bodies. Audit logs are 7 days on Workers Paid.
- **Cost-bounded by default.** `BUDGET_CAP_MONTHLY` (default $35) caps AI spend across every provider and modality via the unified `usage_events` ledger — generation pauses if the cap is reached, so a runaway prompt loop can't drain your account. Cloudflare Workers also lets you set a per-invocation CPU limit via the dashboard for additional defense-in-depth.
- **Idempotent migrations.** Schema changes ship as numbered SQL files in `migrations/`. The Wrangler runner tracks applied migrations in a `d1_migrations` table inside the database itself, so re-running is safe — only pending migrations execute. New migrations should never edit a previously-shipped file.
- **Per-piece content cached at the edge.** TTS audio responses carry `Cache-Control: public, max-age=86400`, so re-listens within 24 hours hit Cloudflare's edge HTTP cache and short-circuit the Worker entirely — no provider call, no `usage_events` row, no cost. Cache key includes `?voice=<id>` so each voice gets its own entry.
- **Server gates over UI hides.** Every admin-only mutation is rejected server-side with 403 if a non-admin tries it. The frontend hides admin UI based on `/api/me.isAdmin`, but that's a UX hint — the API enforces the actual boundary.
- **Server-side JWT verification.** The Worker doesn't trust the `Cf-Access-Jwt-Assertion` header just because it's present — it re-verifies signature + `iss` + `aud` + `exp` against Cloudflare's JWKS via `jose.jwtVerify`. Even if a request reaches the Worker via a route that bypassed Access (e.g. the default `*.workers.dev` URL with no policy attached), it can't impersonate a user without also forging a Cloudflare-signed JWT. Recommended: disable the `*.workers.dev` route in production so the Access-protected hostname is the only ingress.
- **Email allowlist as defense in depth.** `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_EMAILS` gate the deployment independent of the Access policy, so a misconfigured Access app (a public IdP attached without a domain rule) doesn't silently let strangers in. The allowlist runs upstream of the first-user-wins admin INSERT, preventing non-allowlisted callers from capturing admin on a fresh deploy.
- **No password store, no session rotation.** Primer delegates SSO + MFA + lifecycle to the upstream auth proxy (Cloudflare Access by default, or any "trusted upstream proxy" you swap in via `PRIMER_AUTH_MODE=dev-header`).

## Cost estimate

All pricing in this section is **as of April 2026**, sourced from each provider's published rate cards (links inline). Your actual bill will vary with usage, model choices, and provider price changes — but the order of magnitude should be stable.

### Cloudflare infrastructure (single user, fixed)

| Service | Pricing (April 2026) | Primer's typical usage | Estimated cost |
|---------|----------------------|--------------------------|----------------|
| **Workers Paid** plan | $5/mo flat, includes 10M requests + 30M CPU-ms ([source](https://developer.cloudflare.com/workers/platform/pricing/)) | <50k req/mo (one user, briefing fetches + UI page loads + chat) | **$5/mo flat** |
| **D1** | Free up to 25B rows read + 50M rows written + 5GB on Workers Paid ([source](https://developer.cloudflare.com/d1/platform/pricing/)) | <10M reads, <500k writes, <100MB storage per user | **$0/mo** within free tier |
| **Workers AI** (Aura TTS, optional) | $0.011 per 1k neurons; Aura @ $0.015/1k chars ([source](https://developers.cloudflare.com/workers-ai/platform/pricing/)) | Heavy listener: ~165k chars/mo | **$2.50/mo** |
| **Pages** | Free with service binding to a Worker | Static frontend serving | **$0/mo** |
| **Cron Triggers** | Free, included with Workers Paid | 2 crons (daily briefings + Sunday maintenance) | **$0/mo** |
| **Cloudflare Access** | Free for ≤50 users; $7/user/mo above ([source](https://www.cloudflare.com/teams-pricing/)) | Single user / small team | **$0/mo** within free tier |

**Cloudflare floor: $5/mo** for any deployment past the free thresholds. Single-user deployments won't approach D1 or Workers AI overage levels.

### LLM cost per briefing (default model picks)

The default per-operation picks (Claude Sonnet 4 for teaching pieces / deep dives / chat, Haiku 4.5 for everything else) are tuned for cost/quality balance. A typical daily briefing fans out roughly like this:

| Step | Model | Tokens (approx) | Cost / briefing |
|------|-------|-----------------|------------------|
| Slack relevance filter | Haiku 4.5 | 5k in + 1k out | $0.010 |
| Concept extraction (4 batches) | Haiku 4.5 | 25k in + 6k out | $0.055 |
| Adjacent feed scoring | Haiku 4.5 | 10k in + 3k out | $0.025 |
| Teaching pieces (4 × Sonnet 4) | Sonnet 4 | 20k in + 12k out | $0.240 |
| Continuation classifier (4×) | Haiku 4.5 | 4k in + 1k out | $0.010 |
| Quiz generation | Haiku 4.5 | 2k in + 0.5k out | $0.005 |
| **Per-briefing total** | | | **≈$0.34** |

Anthropic pricing as of April 2026: Haiku 4.5 = $1/$5 per 1M tokens; Sonnet 4 = $3/$15 per 1M tokens; Opus 4 = $15/$75 per 1M tokens ([source](https://docs.anthropic.com/en/about-claude/pricing)). OpenAI alternatives: GPT-5 nano = $0.05/$0.40 per 1M, GPT-5 mini = $0.25/$2 per 1M, GPT-5 = $1.25/$10 per 1M ([source](https://platform.openai.com/docs/pricing)).

**Switching all teaching pieces to Opus 4 multiplies the per-briefing cost by ~5x** ($0.34 → ~$1.20). The default `BUDGET_CAP_MONTHLY` of $35 leaves headroom for that mode if you want to experiment.

### Single-user monthly estimates (low / medium / high)

~30 daily briefings/month is the base assumption (cron runs every day; the per-briefing LLM cost below applies to days that produce teaching pieces, and quieter days that finalize as `no_candidates` still incur the cheaper extraction + scoring steps). Audio is character-billed and 24h-cached at the edge, so re-listens don't double the cost.

| Tier | Profile | Daily | Weekly | Monthly |
|------|---------|-------|--------|---------|
| **Low** | Read-only — no listen, no deep dives, no chat. Default model picks. | $0.34 | $1.70 | **$8 LLM + $5 Cloudflare = $13/mo** |
| **Medium** | Listen to ~half briefings (Cloudflare Aura, ~80k chars/mo), 2 deep dives/week, occasional chat. | $0.50 | $2.50 | **$10 LLM + $1.20 audio + $5 Cloudflare = $16/mo** |
| **High** | Listen to every briefing (OpenAI tts-1-hd, ~165k chars/mo), 1 deep dive/day, daily chat. | $0.80 | $4.00 | **$13 LLM + $5 audio + $5 Cloudflare = $23/mo** |
| **Premium voice** | Same as High, but using ElevenLabs Multilingual ($0.10/1k chars [source](https://elevenlabs.io/pricing/api)) for every listen. | $1.30 | $6.50 | **$13 LLM + $16 audio + $5 Cloudflare = $34/mo** |

**Multi-user extrapolation:** AI costs scale roughly linearly per active user. Cloudflare costs stay flat until you cross 10M requests or D1 thresholds (well past 100 active users on a typical workload). Cloudflare Access starts billing at user 51 ($7/user/mo). A 10-person team running the **Medium** profile lands at **~$165/mo** total ($150 AI + $5 Cloudflare + $10 if you've enabled Access for >50 users — for ≤50 it stays free).

### Concrete first-month budget (Medium tier, single user)

- Cloudflare Workers Paid plan: **$5.00**
- Anthropic Claude usage: **~$8.00** (Sonnet pieces + Haiku everywhere else, 22 briefings)
- Workers AI Aura TTS: **~$1.20** (half of briefings listened-to)
- Total: **≈$14.20** the first month, with another ~$5 floor for Cloudflare every month thereafter.

These are real numbers — Primer's `usage_events` cost ledger captures every billable AI call with provider, model, modality, and pre-computed cost, so the Analytics page (`/analytics`) shows what you're actually spending after a couple weeks of real usage. If the trend is climbing toward `BUDGET_CAP_MONTHLY`, the per-step waterfall plus the per-provider stacked cost bars make it easy to spot the culprit (TTS chars piling up? Sonnet over-budget on chat? Concept extraction batches getting too large?).

## Production setup (one-time)

Once per Cloudflare account / GitHub repo:

### 1. Set worker runtime secrets

These live on the worker forever after the first push — they don't need to be re-set on every deploy.

```bash
bunx wrangler secret put ANTHROPIC_API_KEY --config wrangler.api.toml
bunx wrangler secret put LINEAR_API_KEY --config wrangler.api.toml
bunx wrangler secret put SLACK_TOKEN --config wrangler.api.toml
bunx wrangler secret put INCIDENT_IO_API_KEY --config wrangler.api.toml
bunx wrangler secret put GITHUB_TOKEN --config wrangler.api.toml         # optional
bunx wrangler secret put OPENAI_API_KEY --config wrangler.api.toml       # optional, for OpenAI TTS voices
bunx wrangler secret put ELEVENLABS_API_KEY --config wrangler.api.toml   # optional, for ElevenLabs TTS voices
```

### 2. Bootstrap the D1 migration tracking table

If the remote DB already has the schema applied (which it does for any pre-CI Primer deploy), seed the tracking table:

```bash
bun run db:bootstrap:remote
```

After this, all CI deploys re-use `wrangler d1 migrations apply` cleanly.

### 3. Set GitHub Actions secrets

In **repo Settings → Secrets and variables → Actions**: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. See the [CI/CD](../README.md#cicd) section in the README for required token scopes.

## Tail production logs

```bash
bunx wrangler tail --config wrangler.api.toml
```

Primer is designed to sit behind Cloudflare Access for authentication. The worker reads the `CF-Access-JWT-Assertion` header to identify the current user.
