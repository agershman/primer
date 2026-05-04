---
title: "Anthropic API key"
subtitle: "Powering Claude Haiku / Sonnet / Opus across briefings, deep dives, chat, quizzes"
audiences: [admin, ops]
related:
  - reference/ai-models
  - admins/admin-overview
---

Anthropic's Claude family is one of two LLM providers Primer ships with adapters for today (the other is OpenAI). At least one of the two must be configured for the system to function — many operations default to Claude Sonnet 4 / Haiku 4.5 out of the box.

## What Primer uses it for

Every LLM call goes through the provider-agnostic `LLMClient` interface and dispatches to the Anthropic adapter when the configured model has `provider: "anthropic"`. Default per-operation Claude picks (configurable from **Settings → Intelligence → AI models**, admin-only):

| Operation | Default | Why |
|-----------|---------|-----|
| Teaching pieces | Claude Sonnet 4 | Quality matters for user-facing content. |
| Deep dives | Claude Sonnet 4 | Long-form, nuanced explanations. |
| Quiz assessment | Claude Sonnet 4 | Open-ended grading needs nuance. |
| Chat | Claude Sonnet 4 | Conversational reasoning. |
| Concept extraction | Claude Haiku 4.5 | Structured task, parallelizes well. |
| Adjacent scoring | Claude Haiku 4.5 | Pure relevance ranking, high throughput. |
| Quiz generation | Claude Haiku 4.5 | Short structured output. |
| Continuation classifier | Claude Haiku 4.5 | One short JSON output per draft. |
| Slack relevance filter | Claude Haiku 4.5 | One batched call per briefing. |
| Statement refinement | Claude Sonnet 4 | The ✨ Refine with AI button. |

Each call hits `POST https://api.anthropic.com/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01`.

## Auth model

Anthropic API keys are issued from the Anthropic Console (`https://console.anthropic.com`). They authenticate with the `x-api-key` header. Anthropic does **not** expose granular scopes — a key can call any model the workspace has access to.

## Step-by-step setup

1. Sign in to <https://console.anthropic.com>.
2. Open **API Keys** (left sidebar).
3. Click **Create Key**.
4. Name it `Primer (production)`.
5. **Workspace** — pick the one whose billing should cover Primer's usage.
6. Click **Create Key**, then copy the value (shown only once; starts with `sk-ant-`).

## Required permissions / model access

The key's "permissions" are determined by which models the workspace can call:

- **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) — required for the default Haiku operations above.
- **Claude Sonnet 4** (`claude-sonnet-4-20250514`) — required for the default Sonnet operations.
- **Claude Opus 4** (`claude-opus-4-20250514`) — required only if you upgrade Teaching pieces or Deep dives to Opus from **Settings → Intelligence → AI models**.

New Anthropic workspaces typically have access to all three out of the box. Check **Console → Workspaces → Models** if a model returns `404` / model not available.

Anthropic's API doesn't have a "permission" surface beyond model availability — keys are not scope-limited like Slack or fine-grained GitHub PATs.

## Setting the secret on the worker

```bash
bunx wrangler secret put ANTHROPIC_API_KEY --config wrangler.api.toml
```

For local dev, in `.dev.vars`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Verifying

`GET /api/health` reports `anthropic: ok`. After setting the key, the AI Models picker shows the **Anthropic** group with Claude Haiku 4.5 / Sonnet 4 / Opus 4 entries; the default per-operation picks resolve to Anthropic models.

Trigger a manual briefing — successful generation confirms the key works end-to-end.

Common failure modes:

- **`401 Unauthorized`** — Key revoked or pasted incorrectly.
- **`404` on a specific model** — That model isn't enabled for the workspace. Check Console → Workspaces.
- **Spend cap hit** — Anthropic's per-workspace spend limit can pause requests. Raise it in Console → Plans & Billing, or set Primer's `BUDGET_CAP_MONTHLY` lower so you hit Primer's cap first and fail predictably.

## Rotating the key

Console → API Keys → Revoke. Then `bunx wrangler secret put ANTHROPIC_API_KEY` again with the new value. The cost ledger (`usage_events`) is keyed on operation, not on the API key, so spend tracking continues seamlessly across rotations.
