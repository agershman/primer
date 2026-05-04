---
name: add-pipeline-step
description: >-
  Add a new step to the briefing-generation pipeline (the 9-step
  flow in services/briefing-generator.ts). Covers checkpointing,
  cancellation, error isolation, retry, and timing recording.
  Use when inserting a new transformation between fetch / extract /
  generate stages.
---

# Add a pipeline step

The user wants to add a new step to the briefing-generation pipeline:

> $ARGUMENTS

## Architecture

`src/worker/services/briefing-generator.ts` is the orchestrator. It runs a numbered sequence of steps (1, 1a, 3, 5, 6, 7, 7a, 8, 9 — non-contiguous because we've inserted sub-steps over time without renumbering everything) on each user's briefing. Each step:

1. **Checks cancellation** at entry via `await checkCancelled(briefingId, db)` (throws `CancelledError` if the user clicked Cancel).
2. **Updates progress** via `updateProgress(db, briefingId, { step: "<id>", stepLabel: "<UI text>", details: "..." })` so the frontend's status panel shows what's happening.
3. **Wraps risky work** in `safeStep(stepName, async () => { … })` — catches and logs errors without sinking the whole briefing.
4. **Records timing** via `recordTiming(timings, "<step-id>", elapsedMs)` for the analytics page's per-step waterfall.
5. **Optionally retries** transient failures via `withRetry(async () => { … }, { attempts: 3, baseDelayMs: 1000 })`.

See `briefing-generator.ts` for the canonical helpers — they live at the top of the file and are used by every step.

## Step 1 — Decide where the new step belongs

Think about dependencies:

- If your step needs `workContext` items, it must run after Step 1.
- If it needs `concepts`, it must run after Step 3.
- If it needs `selectedTargets`, after Step 6.
- If it needs to inform `selectedTargets` (e.g. filtering before scoring), it goes between 5 and 6.

Pick a numeric ID. Sub-steps use letters (`1a`, `7a`, etc.) so we don't have to renumber everything when we insert. The ID is the canonical identifier — it appears in:

- `metadata.step` in the briefings DB row.
- The frontend's status-pane copy (look up `STEP_LABELS` in `AnalyticsPage.tsx`).
- The waterfall chart's per-step bar.
- Test assertions on pipeline shape.

## Step 2 — Add a step constant + add to the pipeline

Add the step ID to the `PIPELINE_STEPS` array near the top of `briefing-generator.ts`:

```ts
const PIPELINE_STEPS = [
  "starting",
  "fetch-work-context",
  "slack-filter",
  "extract-concepts",
  // …
  "<your-new-step>",       // ← add here
  "writing-pieces",
  "generate-quiz",
  "finalizing",
];
```

This is the single source of truth for the order. The frontend's analytics waterfall and the status-pane labels read from this list.

## Step 3 — Write the step body

Inside `generateDailyBriefing`:

```ts
// Step <ID>: <one-line description>
//
// <multi-paragraph rationale — what this step does, why it exists,
// what failure modes it accepts, what it depends on, what it
// produces. The goal: a future contributor or AI agent should be
// able to understand this step in isolation by reading its prologue.>
await checkCancelled(briefingId, db);
await updateProgress(db, briefingId, {
  step: "<your-new-step>",
  stepLabel: "<UI label>",
  details: "<optional sub-detail>",
});
const stepStart = Date.now();
await safeStep("<your-new-step>", async () => {
  // …actual work…
});
recordTiming(timings, "<your-new-step>", Date.now() - stepStart);
```

Patterns to follow:

- **`safeStep` wraps anything that talks to an external service** (LLM, source API, D1 batch). Errors get logged into the briefing's `errors[]` array and the pipeline continues. Without this, a transient LLM 500 sinks the whole briefing.
- **`withRetry` for transient failures.** LLM 429s, occasional D1 timeouts. Don't retry on permanent failures (4xx other than 429).
- **`recordTiming` is the analytics input.** Even if the step is "fast" (< 100 ms), record it — the user analyses this in the waterfall and a missing entry breaks the chart.

## Step 4 — Hook into `STEP_LABELS` on the frontend

In `src/frontend/pages/AnalyticsPage.tsx` (the waterfall chart) and in the briefing status-panel logic, the step ID maps to a human-readable label:

```ts
const STEP_LABELS: Record<string, string> = {
  // …
  "<your-new-step>": "<UI label>",
  // …
};
```

Same label string as the `stepLabel` field passed to `updateProgress`. Pin it in both places — the analytics page reads from this map, the live status pane reads from the briefing row's `metadata.stepLabel`.

## Step 5 — Tests

- **Source-text contract test** in `tests/unit/generation-progress.test.ts` (or a new file): pin that the step ID appears in `PIPELINE_STEPS`, that `safeStep("<id>")` is called, that `recordTiming` is invoked.
- **Execution test** (if the step has logic worth testing): mock the inputs (workContext, concepts, etc.) and assert on the outputs.
- If the step adds a new error mode, add a test that the error is captured in `errors[]` rather than thrown.

## Step 6 — Help docs

Update `src/frontend/help/briefings/how-generation-works.md`:

- The numbered list of pipeline steps (so the user sees the new step in the description).
- The "what each step does" sub-section with a paragraph describing the new step's purpose.
- Update the mermaid diagram if you have one (`dev-docs/architecture.md` has the canonical pipeline diagram).

## Verification checklist

- The step ID appears in `PIPELINE_STEPS`, the analytics page's `STEP_LABELS`, the help doc's pipeline list, and the architecture diagram.
- `bun run vitest run tests/unit/generation-progress.test.ts` passes.
- A briefing run shows the new step in the live status pane and the analytics waterfall.
- Cancellation mid-step works (the step's `checkCancelled` call throws cleanly and the briefing finalizes as `failed` with `reason='cancelled'`).
- An induced step failure (throw inside the `safeStep` callback) doesn't sink the whole briefing — it lands in `errors[]` and the pipeline continues.

## See also

- `dev-docs/architecture.md` — the pipeline mermaid diagram.
- ADR 0005 — streaming + waitUntil for the route that triggers the pipeline.
- `src/frontend/help/briefings/how-generation-works.md` — user-facing docs.
- `.cursor/skills/source-providers/` — for adding new data sources that this step might consume.
