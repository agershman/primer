<!--
PR title format: conventional commits (feat:, fix:, chore:, refactor:, docs:, test:, ...).
The title becomes the squash commit on main, so write it carefully.

PR titles are verified against commitlint:
  echo "$PR_TITLE" | bun x commitlint --verbose

See CONTRIBUTING.md for the full PR workflow.
-->

## What this PR does

<!-- One paragraph: the change + the user-visible / system-visible effect. Avoid restating the diff. -->

## Why

<!--
The motivation. Trade-offs you considered. Anything a reviewer in 6 months
would want to know that the diff alone won't tell them.
-->

## How to verify

<!--
- Manual reproduction steps (URLs, settings, sample data) if the change is user-facing.
- The specific tests you added / updated and what they pin.
- Any deploy-time concerns (migrations, secrets, cache invalidation).
-->

## Checklist

<!-- Tick the ones that apply. Strike or drop the rest. -->

### Pattern conformance

- [ ] **If this PR adds a new LLM provider, TTS provider, source, route, or pipeline step, I followed the matching skill in [`.cursor/skills/`](../.cursor/skills/).** (LLM → `add-llm-adapter`, TTS → `add-tts-adapter`, source → `source-providers`, route → `add-route`, pipeline step → `add-pipeline-step`.) Diverging from the pattern silently breaks registry filtering, model pickers, and analytics — the skills exist precisely to prevent that.
- [ ] **If this PR proposes to change a pattern documented in [`dev-docs/adrs/`](../dev-docs/adrs/), the PR description links the relevant ADR and surfaces the trade-offs accepted by changing it.** Patterns in scope: custom event bus (0001), source-text contract tests (0002), single user_settings row (0003), shared types module (0004), streaming + waitUntil for long-running routes (0005). Don't silently undo any of these.

### CI / tests

- [ ] `bun run check` is green (Biome lint + tsc).
- [ ] `bun run test:run` is green; tests added for new seams.
- [ ] `bun run build` succeeds.

### Conventions (CI-enforced)

- [ ] No raw `fetch("/api/...")` calls — use `apiGet` / `apiPost` / `apiPatch` / `apiDelete` from `src/frontend/utils/api.ts`. Pinned by [`tests/unit/api-helper-usage.test.ts`](../tests/unit/api-helper-usage.test.ts).
- [ ] No raw Tailwind palette classes (`bg-zinc-*`, `text-emerald-*`, …) — use design tokens (`bg-bg`, `text-positive`, …) from [`src/frontend/styles/tokens.css`](../src/frontend/styles/tokens.css). Pinned by [`tests/unit/design-tokens.test.ts`](../tests/unit/design-tokens.test.ts).

### Admin / docs

- [ ] If this PR mutates deployment-wide state (sources, AI model picks, voice defaults, budget caps), the route is gated via `assertAdmin` — see [`CONTRIBUTING.md → Admin-gated changes`](../CONTRIBUTING.md#admin-gated-changes).
- [ ] If this PR adds or changes a help doc, it has `audiences:` frontmatter and is linked from a relevant existing doc.
- [ ] If this PR changes an external integration, the matching `src/frontend/help/credentials/<provider>.md` walkthrough is up to date.
- [ ] If this PR ships a DB schema change, the migration is numbered, idempotent, and re-runnable.
- [ ] Comments where they earn their place — the *why*, not the *what*.

### New architectural decisions

- [ ] If this PR makes a non-obvious architectural choice (rejecting a popular library, picking a counter-intuitive trade-off, introducing a new pattern other parts of the system should pattern-match against), I added an ADR under [`dev-docs/adrs/`](../dev-docs/adrs/) explaining the decision. The bar is "would someone reasonably try to undo this without realizing why it's there?".

## Related issues / docs

<!-- Closes #N. Links to design docs, RFCs, related PRs, prior context. -->
