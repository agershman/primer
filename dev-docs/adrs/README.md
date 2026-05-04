# Architecture Decision Records

Short documents recording non-obvious architectural choices and the reasoning behind them. Future contributors (human and AI agent) will inevitably ask "why is it done this way" — these documents answer those questions in a single file each, so the answer doesn't have to be reconstructed from git archaeology or guesswork.

## Format

Each ADR follows a minimal MADR-inspired template:

- **Status** — accepted / superseded / rejected.
- **Context** — what problem we faced.
- **Decision** — what we chose to do.
- **Consequences** — what we accept by going this way.
- **Alternatives considered** — what we rejected and why.

Files are numbered sequentially (`0001-…`, `0002-…`) and named in kebab-case after the decision they document. Numbers don't get reused — superseded ADRs stay in place with their `Status` updated to `superseded by 00NN`.

## Index

| # | Title | Status |
|---|---|---|
| 0001 | [Custom DOM event bus instead of context](./0001-custom-event-bus.md) | accepted |
| 0002 | [Source-text contract testing as the primary test style](./0002-source-text-contract-tests.md) | accepted |
| 0003 | [Single user_settings row instead of EAV](./0003-single-user-settings-row.md) | accepted |
| 0004 | [Shared types module instead of API codegen](./0004-shared-types-module.md) | accepted |
| 0005 | [Streaming + waitUntil for briefing generation](./0005-streaming-plus-waituntil.md) | accepted |
| 0006 | [Auth provider extension point + Cloudflare Access hardening](./0006-auth-provider-extension-point.md) | accepted |

For tracked-but-not-yet-done refactors that aren't architectural decisions per se (file splits, validation rollouts), see [`../cleanup-roadmap.md`](../cleanup-roadmap.md).

## When to add a new ADR

Add one when a future contributor would reasonably ask "why isn't this done the obvious way?" — i.e. when the current choice differs from the path of least resistance and the difference is intentional. Some triggers:

- You introduced a new architectural pattern (registry, adapter, dispatcher) that other parts of the system should pattern-match against.
- You rejected a popular library or framework in favour of a custom implementation.
- You picked a non-obvious trade-off (e.g. waitUntil vs. inline await, streaming vs. JSON response, denormalized JSON column vs. relational table).
- You discovered a surprising constraint (Cloudflare-specific behaviour, browser quirk) that shaped the design.

Don't add an ADR for routine implementation details. The bar is "would someone reasonably try to undo this without realizing why it's there".
