---
title: "Deploying Primer"
subtitle: "Cloudflare Workers + Pages, secrets, D1 migrations, CI/CD"
audiences: [ops]
related:
  - getting-started/setup
  - troubleshooting/common-issues
  - reference/configuration
---

Primer's production architecture is split across two Cloudflare deployables:

- **`primer-api`** — the Hono Worker. Runs all `/api/*` routes, owns the D1 database, holds every secret. Configured by `wrangler.api.toml`.
- **`primer-ui`** — Cloudflare Pages serving the static Vite build. Holds a service binding to `primer-api` so frontend `/api/*` requests reach the Worker without leaving the Cloudflare edge. Configured by `wrangler.toml`.

Cron triggers (5 AM daily briefings, 3 AM Sunday maintenance) live on the `primer-api` Worker.

## One-time setup

### 1. Set worker runtime secrets

These live on the worker forever after the first push — no need to re-set on every deploy.

```bash
bunx wrangler secret put ANTHROPIC_API_KEY --config wrangler.api.toml
bunx wrangler secret put LINEAR_API_KEY --config wrangler.api.toml
bunx wrangler secret put SLACK_TOKEN --config wrangler.api.toml
bunx wrangler secret put INCIDENT_IO_API_KEY --config wrangler.api.toml
bunx wrangler secret put GITHUB_TOKEN --config wrangler.api.toml         # optional
bunx wrangler secret put OPENAI_API_KEY --config wrangler.api.toml       # optional, OpenAI LLM + TTS
bunx wrangler secret put ELEVENLABS_API_KEY --config wrangler.api.toml   # optional, ElevenLabs TTS
```

Required: at least one LLM provider (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Both can be set to mix models per operation.

Optional but strongly recommended: `LINEAR_API_KEY`, `SLACK_TOKEN`, `INCIDENT_IO_API_KEY`. Without work-source tokens, briefings rely entirely on external feeds.

Secrets propagate to all edge locations within seconds — no redeploy needed when you rotate one.

For each credential — what it does, the step-by-step setup in the provider's dashboard, **the exact permissions / scopes Primer needs**, and how to verify — see the per-integration walkthroughs:

- [Credentials overview](/help/credentials/overview) — index of every external service Primer talks to
- [Linear](/help/credentials/linear) · [Slack](/help/credentials/slack) · [GitHub](/help/credentials/github) · [incident.io](/help/credentials/incident-io)
- [Anthropic](/help/credentials/anthropic) · [OpenAI](/help/credentials/openai) · [ElevenLabs](/help/credentials/elevenlabs)

### 2. Bootstrap the D1 migration tracking table

If the remote D1 already has the schema applied from earlier manual `wrangler d1 execute` runs, seed the tracking table once so the new runner sees existing migrations as already-applied:

```bash
bun run db:bootstrap:remote
```

This runs `scripts/bootstrap-remote-migrations.sh` and is idempotent — safe to re-run.

### 3. GitHub Actions secrets

In **repo Settings → Secrets and variables → Actions**:

- **`CLOUDFLARE_API_TOKEN`** — scoped API token with these permissions:
  - **Account**: `Workers Scripts:Edit`, `Workers KV Storage:Edit`, `D1:Edit`, `Cloudflare Pages:Edit`, `AI:Edit`
  - **Zone**: none required (no zone-level config in Primer).
- **`CLOUDFLARE_ACCOUNT_ID`** — your Cloudflare account ID (Workers & Pages → Overview).

The token authenticates the deploy runner only. Worker runtime secrets (set above) never reach GitHub.

## CI/CD

Two workflows under `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `checks.yml` | Every PR + manual dispatch | Lint, typecheck, vitest, vite build |
| `deploy.yml` | Push to `main` + manual dispatch | Same checks → applies pending D1 migrations → deploys API worker → deploys Pages |

Branch protection (configure in **repo Settings → Branches**):

- Require pull request before merging
- Require status check: `check` (the lint / typecheck / test / build job)
- Require linear history (optional but keeps `main` clean)

These can't be set via committed config — only via the GitHub repo UI or `gh api`.

## Manual / emergency deploys

The CI flow is the canonical path; manual deploys mirror it for ad-hoc cases (testing a config change before merging, emergency rollouts when CI is busy):

```bash
bun run deploy        # builds + deploys both API + Pages
bun run deploy:api    # API worker only
bun run deploy:ui     # Pages only — runs vite build first
```

Manual deploys do **not** run migrations. If your changes touch the schema, run:

```bash
bun run db:migrate:remote
```

separately.

## Migrations

Schema changes ship as numbered SQL files in top-level `migrations/`. The wrangler migration runner tracks applied migrations in a `d1_migrations` table inside the database itself, so re-running is safe — only pending migrations execute.

```bash
bun run db:status         # what's pending vs applied (local)
bun run db:status:remote  # same, against production D1
bun run db:migrate        # apply pending migrations locally
bun run db:migrate:remote # apply pending migrations to production
bun run db:reset          # wipe local state and re-apply everything (LOCAL ONLY)
```

When adding a new migration, name it `NNNN_description.sql` (e.g. `0003_add_widgets.sql`). Each migration runs in its own transaction.

## Monitoring + cost

- **`/api/health`** returns integration status for every external API the deployment talks to.
- **`/api/stats`** returns monthly LLM + TTS spend pulled from the unified `usage_events` ledger.
- **Analytics page** (`/analytics`) shows per-step timing, recent-briefing waterfalls, and cost trends — broken out by provider and modality so you can see where the budget is going.
- **Wrangler tail** for live logs:

  ```bash
  bunx wrangler tail --config wrangler.api.toml
  ```

The monthly budget cap (`BUDGET_CAP_MONTHLY` worker var, default `35` USD) is read from the same `usage_events` ledger; when the deployment crosses the cap, briefing generation pauses until the next month rolls over. Adjust by editing `[vars]` in `wrangler.api.toml` and redeploying.

## Auth

Primer is designed to sit behind **Cloudflare Access** in production. The worker re-verifies the `CF-Access-JWT-Assertion` header against Cloudflare's JWKS (signature + `iss` + `aud` + `exp`) before reading the email claim — see `src/worker/middleware/auth/cloudflare-access.ts` and [ADR 0006](../../../../dev-docs/adrs/0006-auth-provider-extension-point.md).

Required wrangler vars when running in `cloudflare-access` mode (the default): `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`. Set `ALLOWED_EMAIL_DOMAINS` (or `ALLOWED_EMAILS`) as defense in depth behind the Access policy. The factory fails closed at first request if the required vars are missing, so a misconfigured deploy doesn't silently accept any JWT.

For local dev (`bun run dev`) or non-Cloudflare deployments behind a different auth proxy (oauth2-proxy, Pomerium, Tailscale Serve, nginx + OIDC), set `PRIMER_AUTH_MODE=dev-header` plus `PRIMER_DEV_HEADER_NAME` (the email header your proxy injects). For local dev, put `PRIMER_AUTH_MODE` and `PRIMER_DEV_USER` in `.dev.vars` (gitignored) — never in production wrangler vars.

The first user to authenticate against a fresh deployment is automatically promoted to admin (atomic INSERT-SELECT in `worker/middleware/user-context.ts`). The allowlist runs upstream of that INSERT, so a non-allowlisted attacker on a fresh deploy cannot capture admin. The bootstrap admin sees a one-time welcome dialog explaining what their role enables.

Subsequent users are regular by default. Admins manage roles from **Settings → Users** — each row has a Promote / Demote button; the server enforces last-admin protection (409) so the deployment can never lock itself out via the UI.

If you need to promote a user before the UI is reachable (rare — typically only during initial provisioning), the D1 fallback still works:

```bash
bunx wrangler d1 execute primer-db --config wrangler.api.toml \
  --command="UPDATE users SET is_admin = 1 WHERE email = 'colleague@example.com';"
```

See [Admin Overview](/help/admins/admin-overview) for the full role model.

## Troubleshooting

Common deployment / runtime issues — including stuck briefings, budget-exceeded behavior, missing voice options, and stale concepts — are covered in [Common Issues](/help/troubleshooting/common-issues).
