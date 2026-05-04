# AGENTS.md

This file is auto-loaded by AI coding assistants (Cursor, Claude Code, aider, OpenAI Codex, …) when they open the Primer repository. The goal: any agent — and any new human contributor reading this file directly — should land on the right pattern, the right skill, and the right architectural decision document the FIRST time they touch the codebase, without having to discover them by accident.

If you are an agent: read the **Steering map** below before doing the user's task. The skills and ADRs it references contain the patterns + conventions that turn a "this works" change into a "this matches the rest of the codebase" change.

If you are a human contributor: same advice. The skills are not just for AI — they're agent-friendly task playbooks that work as written for humans too.

## What Primer is (one paragraph)

Primer is a personalized AI briefing platform built on Cloudflare Workers + Pages. It pulls signals from work surfaces (Linear, Slack, GitHub, incident.io, RSS feeds), extracts concepts, scans adjacent sources, and uses LLMs to generate per-day teaching pieces tailored to the user's About / Focus statement. There's a calibration quiz that tracks per-concept depth over time, a chat interface backed by the same context, and a unified cost ledger across LLM and TTS modalities.

## Steering map — read these BEFORE starting

### "I'm adding a new …" tasks

| If the user is asking to … | Read this skill first |
|---|---|
| Add a new data source (Linear, Slack, RSS, …) | [`.cursor/skills/source-providers/SKILL.md`](.cursor/skills/source-providers/SKILL.md) |
| Add a new LLM provider (Gemini, Mistral, Cohere, …) | [`.cursor/skills/add-llm-adapter/SKILL.md`](.cursor/skills/add-llm-adapter/SKILL.md) |
| Add a new TTS / voice provider (Azure, Polly, PlayHT, …) | [`.cursor/skills/add-tts-adapter/SKILL.md`](.cursor/skills/add-tts-adapter/SKILL.md) |
| Add a new Hono API route or endpoint | [`.cursor/skills/add-route/SKILL.md`](.cursor/skills/add-route/SKILL.md) |
| Add a new step to the briefing pipeline | [`.cursor/skills/add-pipeline-step/SKILL.md`](.cursor/skills/add-pipeline-step/SKILL.md) |

These skills exist because each of these tasks has a strict pattern that the rest of the codebase relies on. Diverging from the pattern means breaking the registry / dispatcher / waterfall — and almost always means failing tests we can't see in the immediate scope.

### "Why is the codebase shaped this way?" questions

| If the user asks "why …" or "should we change …" | Read this ADR first |
|---|---|
| custom DOM event bus (`primer:open-chat` etc.) instead of context | [ADR 0001](dev-docs/adrs/0001-custom-event-bus.md) |
| so much "source-text contract" testing instead of execution tests | [ADR 0002](dev-docs/adrs/0002-source-text-contract-tests.md) |
| one wide `user_settings` row instead of EAV / many tables | [ADR 0003](dev-docs/adrs/0003-single-user-settings-row.md) |
| `src/shared/types.ts` instead of API codegen / zod everywhere | [ADR 0004](dev-docs/adrs/0004-shared-types-module.md) |
| `POST /briefing/generate` does both streaming AND `waitUntil` | [ADR 0005](dev-docs/adrs/0005-streaming-plus-waituntil.md) |

If the user is asking to **undo** one of these patterns, read the ADR first and surface the trade-offs they accept by changing it. Do not silently change a pattern documented in an ADR — propose the change, link the ADR, and ask the user to confirm.

### Architectural orientation

If you're new to the codebase or your task spans multiple files, read [`dev-docs/architecture.md`](dev-docs/architecture.md) for the system shape — the briefing pipeline diagram, the three-registry pattern, where data lives.

For tracked refactors that aren't done yet (if you're asked "can we clean up X"), check [`dev-docs/cleanup-roadmap.md`](dev-docs/cleanup-roadmap.md) — it has effort estimates and "where to start" guidance for the deferred items.

## Critical conventions (do not violate these silently)

These are not stylistic preferences — they are contract-level rules with CI checks behind them. Breaking them fails tests immediately:

### Frontend

- **Use `apiGet` / `apiPost` / `apiPatch` / `apiDelete` from `src/frontend/utils/api.ts`. NEVER call `fetch("/api/...")` directly.** The helpers attach `X-Client-Timezone` (read by the worker's user-context middleware) and apply uniform 503 retry semantics. Pinned by [`tests/unit/api-helper-usage.test.ts`](tests/unit/api-helper-usage.test.ts) — bypass and CI fails. The two allowed exceptions (`utils/api.ts` itself and `useChat.ts` for SSE) are listed there.

- **Use design tokens, not raw Tailwind palette classes.** `bg-bg`, `text-text-primary`, `bg-positive`, `text-negative`, `bg-accent` — never `bg-zinc-*`, `text-emerald-*`, `bg-blue-*`, etc. Pinned by [`tests/unit/design-tokens.test.ts`](tests/unit/design-tokens.test.ts). The token catalog lives in [`src/frontend/styles/tokens.css`](src/frontend/styles/tokens.css). Common mappings:
  - `bg-zinc-900` → `bg-bg-warm` or `bg-surface`
  - `text-zinc-500` → `text-text-dim`
  - `text-emerald-*` → `text-positive`
  - `bg-emerald-*` → `bg-positive` or `bg-positive-dim`
  - `text-red-*` → `text-negative`
  - `bg-blue-*` → `bg-accent` or `bg-accent-dim`

- **Wire DOM events through `src/frontend/lib/events.ts`** (typed bus). Existing `window.dispatchEvent(new CustomEvent("primer:..."))` calls keep working — the bus emits bit-identical event names — but new code should use `dispatchPrimerEvent` / `onPrimerEvent` for type safety.

### Backend

- **Long-running routes (≥ 10s) MUST follow the streaming + `ctx.waitUntil` pattern** documented in [ADR 0005](dev-docs/adrs/0005-streaming-plus-waituntil.md). The user navigating away mid-run cannot kill the work. The user-visible source of truth for "is it done" is a notification row (kind `<resource>_<verb>`), not the HTTP response.

- **Admin-gated routes use `requireAdmin` middleware** from `src/worker/middleware/require-admin.ts`. Settings that affect deployment-wide configuration (sources, AI model picks, voice defaults, budget caps) are admin-only. Personalization (About, Focus, relevance filter) is per-user.

- **Provider/adapter/registry is the load-bearing pattern** for cross-cutting extension points: LLM adapters, TTS adapters, source providers. New extension points should follow the same shape (`_REGISTRATIONS` array + `isAvailable(env)` predicate + lazy build). See [`dev-docs/architecture.md`](dev-docs/architecture.md) → "The three registries".

### Tests

- **Source-text contract tests are the primary style** — see [ADR 0002](dev-docs/adrs/0002-source-text-contract-tests.md). When you add a new pattern (a contract surface, a registered hook, a documented invariant), pin it with a regex test that fails when someone forgets to follow the pattern. The bug-narrative comment at the top of each test is required, not optional — it tells future readers what the test exists to prevent.

- **Run `bun run vitest run` after every meaningful change.** Most regressions surface there before manual testing.

## When you're stuck or unsure

1. **Search the existing pattern first.** Most "how do I do X" questions in this codebase have an answer that already exists somewhere. Pattern-match against the closest neighbour before improvising.
2. **If you have to improvise, document why.** A 3-line comment explaining the trade-off saves the next reader an hour.
3. **If you're proposing to undo a pattern documented in an ADR, surface the ADR.** Don't silently undo it.

## Mode-of-operation suggestions

- For **multi-step tasks** (3+ distinct steps), use the `TodoWrite` tool to make the plan visible.
- For **broad codebase exploration**, prefer `SemanticSearch` over `Grep` for "how does X work" questions; use `Grep` for known-symbol lookups.
- For **destructive operations** (deleting branches, force-pushing, dropping D1 tables), confirm explicitly with the user. The danger-zone styling on the Reset Concepts button is the visual analogue — your behaviour should match.
