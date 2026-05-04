# 0004 — Shared types module instead of API codegen

**Status:** accepted

## Context

Primer's worker (Cloudflare Workers + Hono) and frontend (React on Cloudflare Pages) share a JSON wire format on `/api/*` routes. Some types describe data that crosses that boundary and is consumed by both sides — `ContentBlock`, `Resource`, eventually `BriefingData`, `TeachingPieceData`, etc.

In the project's history these types were defined twice — once in `src/worker/types.ts` and once in `src/frontend/types.ts`. They drifted twice in production:

1. A new `Resource.type` literal ("notion") landed on the worker side and the frontend's literal union dropped notion-typed resources to the `"other"` rendering path silently.
2. A `code` content block landed on the frontend before the worker schema knew about it; pieces with code blocks rendered, but the worker tests passed because the worker's `ContentBlock` definition was missing the literal.

Three options for fixing this:

1. **Single shared types module.** Both sides import from a third location (`src/shared/`).
2. **API codegen.** Add a contract definition (zod, OpenAPI, JSON Schema) and generate types for both sides at build time.
3. **Bind the frontend type to the worker type.** Have the frontend import from `worker/types`. Asymmetric — the worker must not import from the frontend.

## Decision

Option 1 — `src/shared/types.ts`. Plain TypeScript, zero runtime imports, both sides re-export the types via their existing `types.ts` files for ergonomic backwards-compatibility.

## Consequences

**Wins:**

- **One source of truth.** A change to `Resource.type` updates both sides at type-check time. Drift is caught at CI before production.
- **Zero new tooling.** Just TypeScript imports — no codegen step, no schema language, no version-skew problems between generated and hand-written code.
- **Trivial migration path.** Existing `import { ContentBlock } from "../types"` calls keep working through the re-export.
- **Sets up the zod runtime layer.** This decision was the prerequisite for the runtime-validation work that landed in [`src/shared/schemas.ts`](../../src/shared/schemas.ts) — schemas live next to the types in `src/shared/` so a single PR adds a contract on both sides of the wire. See cleanup-roadmap item 6 for the in-flight migration of remaining route handlers.

**Losses:**

- **Runtime validation is opt-in, route-by-route.** The shared types catch drift at CI time on every endpoint, but only routes that have been migrated to `parseBody(c.req.raw, <Schema>)` reject malformed bodies at runtime. The migration is mechanical but covers ~30 endpoints — see roadmap item 6 for the rollout.
- **Discipline required.** Easy to put a type that's actually worker-only or frontend-only into `src/shared/` because it touches both. The header comment in `src/shared/types.ts` documents the rule explicitly.

## Alternatives considered

- **OpenAPI codegen instead of hand-written zod.** Rejected — OpenAPI is verbose for the scale of this API (~30 endpoints) and adds another build step. Hand-written zod schemas in `src/shared/schemas.ts` cover the same need with one file and an inferred TypeScript type via `z.infer<typeof Schema>`.
- **OpenAPI spec + openapi-typescript.** Rejected — OpenAPI is verbose for the scale of this API (~30 endpoints) and adds another build step. Hono has typed responses; we'd be duplicating the type info.
- **Frontend imports from worker/types.** Considered as a lower-friction alternative. Rejected because it creates an asymmetric coupling — the frontend now depends on the worker tree's structure, and a worker-side refactor (e.g. splitting `worker/types.ts`) breaks the frontend in surprising ways.

## See also

- `src/shared/types.ts` — the module + its top-of-file rules about what does and doesn't belong here.
- `src/shared/schemas.ts` — the runtime zod schemas + `parseBody` helper consumed by route handlers.
- `tests/unit/content-features.test.ts` — pins the re-export contract on both sides.
