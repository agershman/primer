# 0002 — Source-text contract testing as the primary test style

**Status:** accepted

## Context

Primer needs tests that catch regressions but doesn't have the test-infrastructure budget for full integration testing (no e2e suite, no jsdom-based React Testing Library coverage of every component). Many of the most regression-prone parts of the codebase are:

- Cross-cutting contracts (file A's exported constant must be used by file B with a specific shape)
- Architectural shapes (route X must wrap its work in `ctx.waitUntil`; component Y must consume design tokens not raw palette)
- Documentation surfaces (help docs must mention the new notification kind; CONTRIBUTING.md must list the contributing checklist)

Traditional execution-level unit tests cover function correctness well but miss "did you forget to update the help docs" or "did you accidentally add a raw `fetch` call". Visual / e2e tests catch those but cost time and CI minutes.

## Decision

Use **source-text contract tests** — vitest tests that read source files via `node:fs/promises` and assert on their content with regex. Examples:

```ts
const src = await read("src/worker/routes/briefing.ts");
expect(src).toMatch(/c\.executionCtx\.waitUntil\(generationWithNotification\)/);
```

These are the bulk of the test suite (~1000 of ~1150 tests). Live alongside execution-level unit tests where execution-level coverage is more appropriate (LLM dispatcher routing, normalization helpers, time math).

## Consequences

**Wins:**

- **Catches regressions in places traditional tests wouldn't.** A search-text test caught two cases of palette-class drift in `AdminSourcesPage` and `GenericSourcePanel`. An execution test wouldn't have noticed.
- **Self-documenting.** Each test's first paragraph explains the bug it prevents regressing. New contributors reading `tests/unit/baseline-loading-states.test.ts` (for example) learn what NOT to break.
- **Cheap.** They run in milliseconds and don't need a DOM, a worker, or fixture data.
- **Composable with execution tests.** When a logic bug needs an execution check, write that too — the styles coexist.

**Losses:**

- **Brittle to refactors.** Renaming a constant or reformatting a JSX block can break tests that pinned on exact tokens. Mitigated by writing regexes with generous `[\s\S]{0,N}` windows that tolerate whitespace and biome-format reflows.
- **Doesn't catch logic bugs the regex can't see.** A function that compiles to source matching the regex but does the wrong thing at runtime passes the test. We accept this — these tests pin **intent**, execution tests pin **behaviour**, and we use both.
- **Encourages over-pinning.** Easy to write a test that asserts on cosmetic details (variable names, comment text). Best practice: pin on the contract surface (function signatures, exported tokens, JSX structure) and avoid pinning on internal naming.

## Alternatives considered

- **Skip these tests; rely on TypeScript + execution tests.** Rejected — TypeScript wouldn't catch raw `fetch` calls, missing waitUntil, palette drift, or stale help docs. Execution tests would balloon CI time.
- **Snapshot tests.** Rejected — snapshots invert the signal: a regression silently updates the snapshot. Source-text tests force the failure to surface.
- **AST-based linting.** Considered for the structural checks (e.g. "every Hono route handler must call `c.json`"). Declined for now — the cost of writing AST visitors didn't pay back for a single-author project. Worth revisiting if the codebase grows past ~50 contributors.

## See also

- `tests/unit/api-helper-usage.test.ts`, `tests/unit/design-tokens.test.ts` — examples of cross-cutting contract tests.
- `tests/unit/notifications.test.ts`, `tests/unit/baseline-loading-states.test.ts` — examples of intent-pinning tests with detailed bug-narrative comments.
