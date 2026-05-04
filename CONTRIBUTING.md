# Contributing to Primer

Thanks for taking the time to contribute. This guide covers how to set up locally, the conventions the project follows, and what to expect when you open a pull request.

The codebase is the source of truth — when this guide and the code disagree, file a docs bug. The goal of this file is to help you reach "my change passes CI and looks like the rest of the codebase" with as little friction as possible.

## Table of contents

- [Getting set up](#getting-set-up)
- [Development loop](#development-loop)
- [Project structure](#project-structure)
- [Code style](#code-style)
- [Tests](#tests)
- [Database migrations](#database-migrations)
- [Help docs and personas](#help-docs-and-personas)
- [Admin-gated changes](#admin-gated-changes)
- [Security](#security)
- [Pull request workflow](#pull-request-workflow)
- [Reporting bugs](#reporting-bugs)
- [Where to ask](#where-to-ask)

## Getting set up

Read [`src/frontend/help/getting-started/setup.md`](src/frontend/help/getting-started/setup.md) end-to-end first. The summary:

```bash
git clone <repo-url> && cd primer
bun install
cp wrangler.api.example.toml wrangler.api.toml   # fill in the placeholders
# Drop your API keys in .dev.vars (one KEY=value per line)
bun run db:migrate                               # apply local D1 migrations
bun run dev                                      # worker on :8787, vite on :5173
```

You need at least one LLM provider key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Linear / Slack / GitHub / incident.io / ElevenLabs are optional. Each integration has its own walkthrough under [`src/frontend/help/credentials/`](src/frontend/help/credentials/) covering the credential format, exact permissions Primer needs, and how to verify.

## Development loop

```bash
bun run dev          # worker + frontend in parallel
bun run typecheck    # tsc --noEmit
bun run lint         # biome check src/
bun run lint:fix     # biome check --write src/
bun run format       # biome format --write src/
bun run test         # vitest (watch mode)
bun run test:run     # vitest run (one-shot)
bun run check        # lint + typecheck (matches the bulk of CI)
bun run build        # vite build
```

CI (`.github/workflows/checks.yml`) runs Biome lint → typecheck → vitest → build on every PR. If `bun run check && bun run test:run && bun run build` is green locally, CI will be green too.

When in doubt: read the canonical script list in [`package.json`](package.json) — the names there are stable.

## Project structure

```text
src/
├── frontend/                  React + Vite SPA
│   ├── components/            Reusable UI
│   ├── hooks/                 useChat, useSettings, useCurrentUser, …
│   ├── lib/                   helpRegistry, etc.
│   ├── pages/                 Route components
│   └── help/                  Markdown help articles (frontmatter-tagged)
└── worker/                    Cloudflare Worker (Hono)
    ├── config/                Constants, models catalog, pricing
    ├── integrations/          Adapter seams: llm/, tts/, plus per-provider clients
    ├── middleware/            auth, user-context, require-admin
    ├── routes/                Hono route handlers
    ├── services/              Business logic (generators, scorers, filters)
    ├── sources/               Source providers (linear, slack, github, feeds, …)
    └── db/                    D1 query helpers
migrations/                    Numbered D1 SQL migrations (NNNN_description.sql)
tests/unit/                    Vitest unit tests
dev-docs/                      Architecture diagram + ADRs for non-obvious decisions
.cursor/skills/                Task-specific guides (source-providers, add-llm-adapter, …)
.github/workflows/             CI (checks.yml) + deploy (deploy.yml)
```

For the deeper architecture tour, start with [`dev-docs/architecture.md`](dev-docs/architecture.md) — it has the system shape, the briefing pipeline diagram, and pointers to the three registry-pattern extension points. For non-obvious design decisions ("why a custom event bus?", "why source-text contract tests?"), see [`dev-docs/adrs/`](dev-docs/adrs/).

Per-task guides live in [`.cursor/skills/`](.cursor/skills/) — agent-friendly task playbooks that work for human contributors too. The user-facing dev guide at [`src/frontend/help/developers/extending-primer.md`](src/frontend/help/developers/extending-primer.md) is the in-app version of the same material.

## Before you add X — read Y

Several extension points have a strict pattern that the rest of the codebase relies on. Diverging from the pattern silently breaks things (model pickers, registry filtering, analytics waterfalls, etc.) — the skills below exist precisely to prevent that. **Read the matching skill before opening the editor**, not after CI fails:

| If you're adding … | Read first |
|---|---|
| A new data source (Linear, Slack, RSS, …) | [`.cursor/skills/source-providers/SKILL.md`](.cursor/skills/source-providers/SKILL.md) |
| A new LLM provider (Gemini, Mistral, …) | [`.cursor/skills/add-llm-adapter/SKILL.md`](.cursor/skills/add-llm-adapter/SKILL.md) |
| A new TTS / voice provider (Azure, Polly, …) | [`.cursor/skills/add-tts-adapter/SKILL.md`](.cursor/skills/add-tts-adapter/SKILL.md) |
| A new Hono API route or endpoint | [`.cursor/skills/add-route/SKILL.md`](.cursor/skills/add-route/SKILL.md) |
| A new step to the briefing pipeline | [`.cursor/skills/add-pipeline-step/SKILL.md`](.cursor/skills/add-pipeline-step/SKILL.md) |

If you find yourself **proposing to undo** a pattern documented in [`dev-docs/adrs/`](dev-docs/adrs/) — custom event bus, source-text contract tests, single user_settings row, shared types module, streaming + waitUntil — read the ADR first and surface the trade-offs in your PR description. Don't silently undo decisions captured there; they were deliberate, and the reasoning is documented to save you the rediscovery.

## Code style

We use **Biome** for both linting and formatting, configured in [`biome.json`](biome.json). Key conventions:

- 2-space indentation, **120-column** soft line limit.
- Double quotes, semicolons, trailing commas everywhere.
- `useConst: error` — prefer `const`. Use `let` only when reassignment is genuine intent.
- `noNonNullAssertion: warn` — prefer narrowing over `!`. Sometimes `!` is right; document why in a brief comment.
- `noExplicitAny: warn` — use real types. `unknown` + a guard beats `any` if the shape isn't known yet.
- `noUnusedVariables` / `noUnusedImports` — both warnings; CI doesn't fail on warnings, but please clean them up.
- `useExhaustiveDependencies: warn` — React `useEffect` / `useCallback` deps. If you intentionally drop a dep, prepend the disable comment with a one-line `why`.
- TypeScript is strict (`tsconfig.json`). `tsc --noEmit` must pass.

Comments earn their place. Cite the *why* — trade-offs, gotchas, intent — not the *what* (the code says that). Skim any service in `src/worker/services/` for the house style.

## Tests

We use **Vitest**. The bar for new code is "the seam between layers is pinned by a test that fails when someone breaks the contract." Most tests in this repo are **source-text contracts** — they read a source file and assert specific symbols / shapes are present. They're fast, no fixtures, and catch regressions on the seams that matter (adapter dispatch, route gating, UI rendering, cross-doc links). See `tests/unit/multi-provider-ai.test.ts`, `tests/unit/admin-role.test.ts`, `tests/unit/help-credentials.test.ts` for canonical examples.

Where source-text contracts aren't enough — the resolver actually has logic, the helper computes a real value — run the function directly with mocks. See `tests/unit/per-op-tts.test.ts` and `tests/unit/slack-relevance-filter.test.ts`.

Run the full suite with:

```bash
bun run test:run                                # all
bun x vitest run tests/unit/<file>.test.ts      # one file
bun x vitest run -t "your test name"            # one test by name
```

Add a test alongside any seam you change. New routes get a route test; new help docs get pinned in `tests/unit/help-personas.test.ts` (audience tag) or `help-credentials.test.ts` (cross-doc links); new categories on the help index get a registry test.

## Database migrations

Schema changes ship as numbered SQL files under [`migrations/`](migrations/), e.g. `0003_add_widgets.sql`. Each migration:

- Runs in its own transaction.
- Should be idempotent or guarded by `IF NOT EXISTS` / `WHERE NOT EXISTS` so re-running on a partially-applied DB doesn't fail.
- Should backfill existing rows when a `NOT NULL` column is added without a default — see `migrations/0002_user_admin.sql` for the pattern (column add + `UPDATE` to seed sensible defaults on existing rows).

The Wrangler runner tracks applied migrations in a `d1_migrations` table inside the database itself, so re-running is safe — only pending migrations execute. Local commands:

```bash
bun run db:status        # what's pending vs applied
bun run db:migrate       # apply pending migrations (LOCAL)
bun run db:reset         # wipe local state and re-apply everything (LOCAL ONLY)
```

Never edit a previously-shipped migration. If you need to fix a mistake, ship a new migration that corrects it.

## Help docs and personas

Help docs live under `src/frontend/help/<category>/<slug>.md` and are auto-discovered by the help registry (`src/frontend/lib/helpRegistry.ts`) via Vite's `import.meta.glob`. Frontmatter shape:

```yaml
---
title: "..."
subtitle: "..."
audiences: [user, admin]   # one or more of: user, admin, developer, ops
related:
  - some/other-doc
---
```

The Help index page renders a persona-chip filter (`/help` → All / Users / Admins / Developers / Ops). Tag every new doc with the audience(s) it's written for; default is `user` if you omit the field. Keep slugs flat — react-router treats `/` as a separator, so nested paths under `<category>/` won't resolve.

When you add a new category (e.g. `monitoring/`), update `CATEGORY_ORDER` and `CATEGORY_LABELS` in `helpRegistry.ts`, plus the description + icon maps in `src/frontend/pages/HelpIndexPage.tsx`. There's a test pattern in `tests/unit/help-personas.test.ts` you can extend.

## Admin-gated changes

Primer has a simple two-role model — admin vs regular user — backed by `users.is_admin`. The first user to provision a fresh deployment is automatically admin (atomic INSERT-SELECT in `src/worker/middleware/user-context.ts`); everyone else is regular. See [`src/frontend/help/admins/admin-overview.md`](src/frontend/help/admins/admin-overview.md) for the full role model.

When you add a route or settings field that mutates **deployment-wide** state (sources, AI model picks, voice defaults, budget caps, anything in `signalSurfaceMap` other than `filterPrompt` / `sourceFilterOverrides`), you must gate it on admin:

```ts
import { assertAdmin } from "../middleware/require-admin.js";

routes.post("/some/admin-action", async (c) => {
  const block = assertAdmin(c.get("user"));
  if (block) return block;
  // ... handler
});
```

The frontend can use `<AdminOnly>` / `useIsAdmin()` from `src/frontend/hooks/useCurrentUser.tsx` to hide admin-only UI, but the **server gate is the security boundary** — never rely on hiding the UI alone.

## Security

Vulnerability reports go through the private channel — see [`SECURITY.md`](SECURITY.md) for the disclosure process. Please don't open a public issue for anything that could compromise a secret, leak data, or impersonate another user.

PRs that touch any of the following surfaces will get extra scrutiny — they're the load-bearing security boundaries of every Primer deployment. Flag in your PR description if your change lands in any of them:

- **`.github/workflows/**`** — CI / deploy workflows. A malicious change here could exfiltrate the deploy token. New third-party action references should be SHA-pinned the same way the existing ones are.
- **`src/worker/middleware/auth/**`** — JWT verification, allowlist enforcement, dev-header trust. See [ADR 0006](dev-docs/adrs/0006-auth-provider-extension-point.md) for the threat model.
- **`src/worker/middleware/require-admin.ts`** and any `assertAdmin` call site — the server-side admin boundary.
- **`wrangler.api.example.toml`** defaults that ship to first-time deployers — anything here becomes a default a real operator could miss when copying to `wrangler.api.toml`.

If you're not sure whether your change touches a security-relevant surface, ask in the PR description rather than guessing.

## Pull request workflow

We use plain `git` and `gh` (no Graphite). The flow:

```bash
git checkout -b your-feature-branch
# … make changes, with tests …
bun run check && bun run test:run && bun run build   # local CI mirror
git add .
git commit -m "feat: short imperative summary"
git push -u origin HEAD
gh pr create --fill                                  # or via the GitHub UI
```

PR titles must pass **commitlint** (the conventional-commits format — `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, etc.). The pre-commit verification is:

```bash
echo "$PR_TITLE" | bun x commitlint --verbose
```

CI runs `lint → typecheck → vitest → vite build` on every push. PRs that pass CI are guaranteed to pass the deploy gate after merge (the deploy workflow re-runs the same checks before deploying).

### PR checklist

Before requesting review, confirm:

- [ ] `bun run check` is green (Biome lint + tsc).
- [ ] `bun run test:run` is green; you've added tests for new seams.
- [ ] `bun run build` succeeds.
- [ ] If you touched a route or service that mutates deployment-wide state, you gated it via `assertAdmin` (see [Admin-gated changes](#admin-gated-changes)).
- [ ] If you added a help doc, it has `audiences:` frontmatter and is linked from a relevant existing doc.
- [ ] If you changed an external integration, you updated the matching `src/frontend/help/credentials/<provider>.md` walkthrough.
- [ ] If you shipped a DB schema change, the migration file is numbered, idempotent, and re-runnable.
- [ ] Comments where they earn their place — the *why*, not the *what*.

We squash-merge by default; the PR title becomes the commit on `main`, so write it carefully.

## Reporting bugs

Open a GitHub issue with:

- **What you did** — the steps to reproduce, including any non-default settings (admin? source filters? model picks?).
- **What you expected to happen.**
- **What actually happened** — error messages, screenshots, log snippets from `bunx wrangler tail` if the bug is server-side.
- **Environment** — local dev or deployed? Bun / Node version, browser, Cloudflare account if relevant.

If the bug is in the help docs (e.g. "the doc says X but the code does Y"), include the file path. The codebase is the source of truth.

For sensitive issues (anything that could compromise a secret, leak data, or impersonate another user), don't open a public issue — follow the responsible-disclosure process in [`SECURITY.md`](SECURITY.md).

## Where to ask

- **How does X work?** — start at [`/help`](src/frontend/help/) (filter by audience). Most "how does this fit together" questions are already answered.
- **Where's the seam to extend Y?** — [`src/frontend/help/developers/extending-primer.md`](src/frontend/help/developers/extending-primer.md) walks the adapter / source-provider / pipeline-step seams.
- **What credential / permission do I need for Z?** — [`src/frontend/help/credentials/overview.md`](src/frontend/help/credentials/overview.md).
- **How do I deploy?** — [`src/frontend/help/ops/deploying-primer.md`](src/frontend/help/ops/deploying-primer.md).

If the answer isn't in the docs, the answer should *go into* the docs. PRs that fix a confusing surface and update the relevant help article are especially welcome.

Thanks for contributing.
