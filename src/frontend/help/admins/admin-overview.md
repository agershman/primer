---
title: "Admin Overview"
subtitle: "What you can do as the deployment admin"
audiences: [admin]
related:
  - reference/configuration
  - reference/ai-models
  - reference/analytics
  - briefings/source-instances
  - credentials/overview
---

The admin is whoever provisions the deployment first. They configure deployment-wide settings; everyone else uses what's been set up. This is a deliberately simple two-bucket model — one boolean (`users.is_admin`) — that fits the typical install pattern (one team or one person owns the deployment, everyone else just reads briefings).

## What you can do as admin

| Area | What you control | Doc |
|------|-------------------|-----|
| **Sources** | Linear teams + status filter, Slack channels + bookmark bypass, GitHub repos + teams, incident.io, RSS / HN / ArXiv feed instances | [Configuration](/help/reference/configuration) |
| **AI models** | Per-operation LLM picks (teaching pieces, deep dives, quiz, chat, concept extraction, adjacent scoring, continuation classifier) — grouped by provider | [AI Models](/help/reference/ai-models) |
| **Voice** | Default TTS voice + per-surface overrides (teaching pieces, deep dives, chat replies) | [Configuration → Voice](/help/reference/configuration) |
| **Limits** | Monthly budget cap, relevance threshold, near-miss floor | [Configuration → Limits](/help/reference/configuration) |
| **Feeds CRUD** | Add / remove / toggle / suggest external feeds via `POST /api/source-instances` (and friends) | [Feeds](/help/briefings/source-instances) |
| **Per-piece overrides** | The **↻ try different model** affordance + the inline `voice: <name> ↻` switcher on every Listen control. Updating either updates the deployment-wide default. | n/a — visible inline on each piece |
| **Users** | Promote teammates to admin or demote them back to regular users from the **Settings → Users** panel. The deployment must always have at least one admin (the server refuses last-admin demotion with a 409). | This article |

Regular users see **only** Personalization (About / Focus / Relevance filter) and Account in the Settings nav. The Sources / Intelligence / Limits panels stay hidden, as do the inline per-piece pickers. Server-side mutations on those areas would 403 anyway — the UI hide is just to keep the panel calm.

## Promoting another user to admin

Open **Settings → Users** (admin-only). Each row carries a Promote / Demote button — click, confirm in the dialog, and the change lands server-side immediately. The promoted user sees a one-time welcome dialog explaining their new role on their next session.

The deployment can have any number of admins; the bootstrap only guarantees the *first* user is one so the system is configurable on a fresh install. The server refuses to demote the **last remaining admin** (returns 409) — to demote the only admin, promote someone else first. Self-demotion is allowed when at least one other admin exists; the demoting admin's Settings nav collapses to Personalization + Account on the next /api/me poll.

If you need to promote a user before the UI exists (e.g. while developing locally without the welcome flow), the D1 fallback still works:

```bash
bunx wrangler d1 execute primer-db --config wrangler.api.toml \
  --command="UPDATE users SET is_admin = 1 WHERE email = 'colleague@example.com';"
```

## How the admin gate is enforced

The frontend hides admin-only UI based on the `isAdmin` flag returned by `GET /api/me` — that's a UX hint. The actual security boundary is server-side:

- `PATCH /api/settings` rejects with `403` when a non-admin tries to set any deployment-wide field (`signalSurfaceMap`, `budgetCapMonthly`, `relevanceThreshold`, `nearMissFloor`). `filterPrompt` and `sourceFilterOverrides` remain user-allowed because they're per-user personalization.
- `POST` / `PATCH /:id` / `DELETE /:id` / `POST /suggest` on `/api/source-instances` all gate to admin.
- `POST /api/piece/:id/regenerate` (model swap) gates to admin.
- `GET /api/users` and `PATCH /api/users/:id` (the Users panel's backend) gate to admin. The PATCH refuses to demote the only remaining admin with a 409 so the deployment can never lock itself out via the UI.

Read endpoints (`GET /settings`, `GET /sources`, previews) stay open — non-admins can see what's configured even though they can't change it. Useful for understanding why a briefing came out the way it did.

## Setting up credentials

Each external integration (Linear, Slack, GitHub, incident.io, Anthropic, OpenAI, ElevenLabs) has its own walkthrough covering the credential format, step-by-step issuance from the provider's dashboard, **the exact permissions Primer needs** (and what it doesn't), and how to verify after `wrangler secret put`. Start at the [Credentials & Permissions overview](/help/credentials/overview) for the index.

Primer is a strictly read-only consumer of every external service it talks to — the per-integration docs spell out the minimum scopes so you can hand them to a security reviewer without overshooting.

## Day-to-day admin tasks

A typical week's admin work:

- **Tune source filters** when a team's signal-to-noise ratio shifts (a new noisy Slack channel, a Linear team you stopped working on).
- **Promote new teammates** when they join.
- **Adjust the budget cap** if monthly spend trends up — Analytics shows the breakdown by provider and modality so you can spot whether it's TTS, LLM, or a specific model eating the budget.
- **Swap models** for an operation when a cheaper / faster one matches quality. Concept extraction is the highest-volume LLM operation by far — switching it from Sonnet to Haiku can halve the briefing's per-run cost without noticeably changing output.
- **Configure new feeds** as your team's interests evolve. The `✨ Suggest` button proposes ~8 candidates based on the admin's About + Focus.
