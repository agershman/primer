---
name: add-route
description: >-
  Add a new Hono API route to the Primer worker. Covers request /
  response shape, admin gating, error handling, and the frontend
  apiGet / apiPost / apiPatch / apiDelete pairing. Use when wiring
  a new endpoint or moving an existing one.
---

# Add an API route

The user wants to add a new API route to Primer:

> $ARGUMENTS

## Architecture

Routes live in `src/worker/routes/` and are wired up in `src/worker/index.ts`. The standard shape:

```ts
// src/worker/routes/<resource>.ts
import { Hono } from "hono";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const <resource>Routes = new Hono<AppEnv>();

<resource>Routes.get("/<resource>/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // …business logic — usually delegate to src/worker/services/…
  return c.json({ /* response */ });
});
```

Then in `src/worker/index.ts`:

```ts
import { <resource>Routes } from "./routes/<resource>.js";
// …
app.route("/api", <resource>Routes);
```

## Step 1 — Pick the right route file

The codebase has several large kitchen-sink route files (`system.ts`, `briefing.ts`, `quiz.ts`, `pieces.ts`). Don't add to those if your endpoint is conceptually distinct — create a new file or extend the right resource's file. Rule of thumb: **one resource per file**, sub-resources live in the same file.

If the resource doesn't exist yet, create `src/worker/routes/<resource>.ts` and register it in `index.ts`.

## Step 2 — Gating: who can call this?

Three gating modes:

1. **Authenticated only.** Default — the user-context middleware (set up in `index.ts`) populates `c.get("user")` for every `/api/*` route. Just use it.

2. **Admin only.** Wrap the route or use the `requireAdmin` middleware:

   ```ts
   import { requireAdmin } from "../middleware/require-admin.js";

   <resource>Routes.post("/<resource>/dangerous-action", requireAdmin, async (c) => {
     // c.get("user").isAdmin is guaranteed true here
   });
   ```

   Use this for: source CRUD, AI model picks, voice defaults, budget caps, anything in `signalSurfaceMap`. Anything that affects the deployment-wide configuration.

3. **Public.** Don't add public routes. Cloudflare Access gates the whole site; if you need a webhook endpoint, mount it outside `/api/` and document the auth scheme.

## Step 3 — Request body validation

The preferred path is the shared zod schema layer in `src/shared/schemas.ts` plus the `parseBody(req, Schema)` helper. Three routes are already migrated as reference:

```ts
import { parseBody, MyRequestSchema } from "../../../shared/schemas.js";

routes.post("/my-resource", async (c) => {
  const parsed = await parseBody(c.req.raw, MyRequestSchema);
  if (!parsed.ok) return c.json(parsed.error, 400);
  const body = parsed.data; // typed via z.infer<typeof MyRequestSchema>
  // … happy path …
});
```

The 400 envelope shape (`{ error: "Invalid request body", issues: [{ path, message }] }`) is fixed across every route — don't hand-roll a different one. See [the shared-types rule](mdc:.cursor/rules/shared-types.mdc) for the full migration playbook.

Legacy handlers still using `await c.req.json<{...}>()` keep working and migrate opportunistically when they're touched. Don't block adding a new route on migrating an unrelated old one.

## Step 4 — Response shape

- **Success:** `return c.json({ /* data */ });` (200 by default).
- **Created:** `return c.json({ /* data */ }, 201);`.
- **Validation error:** `return c.json({ error: "<message>" }, 400);`.
- **Not found:** `return c.json({ error: "<resource> not found" }, 404);`.
- **Auth:** the middleware handles 401. Don't return 401 from route handlers.
- **Server error:** let it throw — the Hono default 500 handler is fine. For known-bad cases (LLM provider down, DB offline), `return c.json({ error: "..." }, 503);` so the frontend's `apiPost` retry kicks in.

## Step 5 — Long-running work (≥30 s)

If the work runs longer than ~10 seconds, follow the **streaming + waitUntil** pattern documented in ADR 0005:

1. Return a streaming JSON response that heartbeats whitespace.
2. Pin the work promise to `c.executionCtx.waitUntil(workPromise)`.
3. Create a notification (kind `<resource>_<verb>`) at start, transition to `ready` / `failed` on completion.

See `briefing.ts`'s `POST /briefing/generate` for the canonical implementation. Don't reinvent this — it's load-bearing for the user navigating away mid-run.

## Step 6 — Frontend pairing

The frontend has shared API helpers in `src/frontend/utils/api.ts`. **Always use them** — never call `fetch("/api/...")` directly. They auto-attach `X-Client-Timezone` and apply 503 retry semantics. There's a contract test (`tests/unit/api-helper-usage.test.ts`) that fails CI if you bypass.

```ts
import { apiGet, apiPost, apiPatch, apiDelete } from "../../utils/api";

const data = await apiGet<{ items: Item[] }>("/api/<resource>");
await apiPost<{ ok: true }>("/api/<resource>", { kind, label });
await apiPatch(`/api/<resource>/${id}`, { enabled });
await apiDelete(`/api/<resource>/${id}`);
```

## Step 7 — Tests

At minimum:

- A source-text contract test pinning the route's mount point, gating, and response shape (see `tests/unit/notifications.test.ts` for examples).
- An execution test if the business logic has branches worth testing (see `tests/unit/briefing-cancel-route.test.ts`).

If the route writes to D1, also add a test using the `FakeD1` shim in `tests/unit/briefing-cancel-route.test.ts` for the storage contract.

## Step 8 — Help docs

Update `src/frontend/help/reference/api-endpoints.md` with the new endpoint. The format is:

```markdown
| `POST` | `/api/<resource>/<verb>` | <one-line description>. <Notes about gating, async behaviour, etc.> |
```

If the endpoint introduces a new notification kind, also update `src/frontend/help/reference/notifications.md`.

## Verification checklist

- The route appears in `index.ts`'s `app.route("/api", ...)` chain.
- `bun run vitest run tests/unit/api-helper-usage.test.ts` passes (no raw fetch on the consuming side).
- Admin-gated routes return 403 for non-admin users.
- Long-running routes write a notification at start and transition it on finish.
- The endpoint appears in `api-endpoints.md`.

## See also

- `dev-docs/architecture.md` — high-level worker layout.
- ADR 0005 — streaming + waitUntil pattern.
- `src/worker/middleware/require-admin.ts` — admin gating implementation.
- `.cursor/skills/add-pipeline-step/` — for adding a step inside the briefing pipeline rather than a top-level endpoint.
