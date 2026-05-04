# 0005 — Streaming + waitUntil for briefing generation

**Status:** accepted

## Context

`POST /api/briefing/generate` runs a 30 s – 3 min pipeline (multiple LLM calls, signal fetches, classification, quiz generation). Two constraints:

1. **Cloudflare's edge will 524-timeout** any request that doesn't write its first byte within ~100 s. A briefing on a busy day routinely exceeds 100 s wallclock, so naive `await generationPromise; return c.json(...)` returns a Cloudflare HTML error page instead of progress.
2. **Users navigate away mid-generation.** They click Refresh, then go read concepts, then expect to come back to a finished briefing. Naively, the moment the browser aborts the open `apiPost` fetch, the worker exits and generation halts — leaving the briefing row stuck at `status='generating'`.

## Decision

Two complementary mechanisms layered on the same generation promise:

1. **Streaming response body.** The handler writes a single space byte immediately (resets the edge's first-byte timer), heartbeats a space every 25 s (well under any idle-connection limit), and finally writes the JSON result when generation finishes. The body remains valid JSON because heartbeats are pure whitespace; the frontend's `apiPost` parses leading whitespace fine.

2. **`c.executionCtx.waitUntil(generationWithNotification)`.** Pins the generation promise to the worker's invocation lifetime so it survives client disconnect. A `briefing_generation` notification is created at the start of the request and transitions to `ready` / `failed` when generation completes — the bell catches up at its next poll regardless of which tab the user ends up on.

Both consumers (the streaming response body's `await generationPromise` and the waitUntil hold) await the same source promise. Promises support multiple awaiters, so this isn't a fork — it's a fan-out.

## Consequences

**Wins:**

- Long-running generations don't hit the 524 timeout (streaming bytes resets the edge timer).
- Client disconnects don't kill the work in progress (waitUntil keeps the worker alive).
- The notification is the user-visible source of truth for "is it done" — consistent with deep dives and baseline calibration, both of which use the same pattern.
- Cancellation still works via the cooperative `cancel_requested` flag — the generator checks at every step boundary and exits cleanly.

**Losses:**

- **Two mechanisms to maintain.** The streaming response and the waitUntil hold both reference the same promise; refactoring one requires understanding the other.
- **Heartbeats whitewash valid-JSON guarantees.** The body is `'   ' + JSON.stringify({...})` — leading whitespace is fine for `JSON.parse`, but a stricter consumer would reject it. We accept this; the only consumer is `apiPost` and it's well-tested.

## Operational gotcha: `waitUntil` has its own 30-second cap that `cpu_ms` does NOT extend

This was the load-bearing insight from a real production debugging session. Earlier versions of this ADR claimed `cpu_ms = 300000` would extend `waitUntil`'s post-response budget. That is wrong. Two separate Cloudflare runtime limits apply, and they are independent:

1. **`cpu_ms`** — bounds the foreground request's CPU time. Configurable up to 300 s on Workers Paid. Subrequests (LLM API calls, D1 queries) don't burn CPU while waiting on the network, so setting this high is mostly free.
2. **`waitUntil` post-response cap** — Cloudflare cancels any task pinned via `c.executionCtx.waitUntil(...)` **30 seconds after the response is sent**, regardless of `cpu_ms`. This is documented at [https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).

When deep-dive generation was implemented as `waitUntil(generationPromise); return c.json({status:"generating"}, 202)`, every deep dive that took longer than 30 seconds was silently killed mid-LLM-call. The notification stayed `in_progress`, the piece stayed `has_deep_dive=-1`, and the bell spun forever. The Cloudflare warning surfaces as:

```
waitUntil() tasks did not complete within the allowed time after
invocation end and have been cancelled.
```

Verified by runtime instrumentation during the bug investigation: 30,021 ms between IIFE entry and cancellation warning — an exact match for the documented 30-second cap.

**The actual fix is the streaming-response pattern itself.** While the response stream is open, the worker stays alive in foreground (no waitUntil cap applies). The deep-dive route was rewritten to follow the briefing-generator shape: open a streaming response, run generation in foreground (`await runGeneration()`), heartbeat whitespace every 25 s, write the final JSON when done. The worker survives long-running LLM calls because it's not in a "post-response" window — it's still serving the original request.

`cpu_ms = 300000` remains in [`wrangler.api.toml`](../../wrangler.api.toml) as headroom for the foreground CPU budget (briefing pipelines occasionally do meaningful CPU work between subrequests — JSON manipulation, classification, sorting). It does NOT solve the waitUntil cancellation; the streaming pattern does. Keeping `cpu_ms` set is harmless (LLM calls are subrequests, no CPU burn while waiting), so we leave it in.

### What this means for new code

If you add a new long-running route, **DO NOT use `waitUntil` to keep the work alive after returning a 202**. The streaming pattern is the only shape that works for operations expected to exceed 30 seconds. See the canonical implementations:

- `src/worker/routes/briefing.ts` — `POST /briefing/generate`
- `src/worker/routes/pieces.ts` — `GET /piece/:id/deep-dive`

Both keep the response stream open, run work in foreground, and use whitespace heartbeats. `waitUntil` is fine for short post-response side-effects (under 30 s) like `transitionNotification` calls; it's the wrong tool for hosting the entire long-running operation.

## Alternatives considered

- **Plain `await generationPromise; return c.json(...)`.** Rejected — 524 timeout on long runs.
- **`waitUntil` only, no streaming.** Considered. Returns 202 immediately, frontend polls `/api/briefing/status`. Cleaner architecturally, but the user loses the live progress UX (the streaming heartbeats double as "the worker is alive and making progress" feedback to the open page). Worth revisiting if the streaming approach causes problems.
- **Cloudflare Queues fan-out.** Each user's briefing dispatches as a queue message; a consumer worker does the per-user pipeline. The "right" architecture for many users, but over-engineered for a single-deployment-per-user app. Roadmap item, not a now problem.
- **Server-Sent Events (text/event-stream).** Considered. Same trade-offs as streaming JSON, but commits the route to a non-JSON response body. Streaming JSON keeps the existing `apiPost` consumer working, which mattered for the migration path.

## See also

- `src/worker/routes/briefing.ts` — `POST /briefing/generate` handler.
- `src/frontend/help/reference/notifications.md` — the user-facing notification contract.
- ADR 0001 — explains why notifications are a separate concept from in-progress activity.
