# Cleanup roadmap

This file tracks the open follow-ups from the codebase health assessment plus the work that has shipped. Each item below is real work; the open ones are large enough to warrant their own dedicated session.

Pick an open item when you have a focused half-day or day available; they are roughly ordered by impact-per-hour-spent. Completed items live at the bottom for "why is this code shaped this way" archaeology.

## 1. Split `briefing-generator.ts` into `services/briefing-generator/`

**Status:** partial · **Effort remaining:** 3–6 h · **Blast radius:** high

`src/worker/services/briefing-generator.ts` is ~1100 lines today; `generateDailyBriefing` itself still spans the bulk of that as nine numbered pipeline steps inline. The shared helpers (`safeStep`, `withRetry`, `updateProgress`, `checkCancelled`, `CancelledError`, `summarizeFeedSources`, `summarizeWorkContextSources`, the `BriefingResult` type) **have already been extracted** to [`src/worker/services/briefing-generator/shared.ts`](../src/worker/services/briefing-generator/shared.ts). Each step body still needs to move out.

### Suggested decomposition

```
src/worker/services/briefing-generator/
  shared.ts                   # DONE — safeStep, withRetry, updateProgress, CancelledError, …
  fetch-work-context.ts       # Step 1 + 1a (slack relevance filter)
  extract-concepts.ts         # Step 3
  scan-adjacent.ts            # Step 5
  select-targets.ts           # Step 6 (candidates → selected)
  generate-pieces.ts          # Step 7 + continuation classification
  generate-quiz.ts            # Step 8
  finalize.ts                 # Step 9 + status update
```

`briefing-generator.ts` keeps its public path so existing imports (`import { generateDailyBriefing } from "./services/briefing-generator.js"`) stay green.

### Why deferred

Source-text contract tests pin on the shape of `briefing-generator.ts` (the per-step `safeStep` wrapping, the timing record calls). The route-split work used a sibling-folder pattern + a `readSplitSource` helper in [`tests/helpers/source.ts`](../tests/helpers/source.ts) — the same approach works here. Each step extraction is independent and reviewable as its own PR. Don't try to do all eight in one PR.

## 2. ~~Split kitchen-sink route files~~ — DONE

See **Completed** below.

## 3. Extract sub-components from large React files

**Status:** partial · **Effort remaining:** 2–4 h · **Blast radius:** medium

The Header avatar-menu icons have already been extracted to [`src/frontend/components/icons/HeaderIcons.tsx`](../src/frontend/components/icons/HeaderIcons.tsx). The remaining heavy components still need decomposition.

| File | Lines | Extract |
|---|---|---|
| `src/frontend/components/TeachingPiece.tsx` | 884 | `TeachingPieceAudio`, `TeachingPieceFeedback`, `TeachingPieceSeriesNav`, `TeachingPieceModelSwitcher`, `SourceProvenance` (already a sibling but extracted) |
| `src/frontend/components/ChatPanel.tsx` | 847 | `ChatMessageList`, `ChatComposer`, `ChatThreadSidebar` |
| `src/frontend/components/AudioPlayer.tsx` | 811 | `AudioTransportControls`, `AudioProgressBar`, `AudioVoicePicker` |
| `src/frontend/components/Header.tsx` | 737 | extract mobile menu, avatar menu (icons already moved) |
| `src/frontend/pages/BriefingPage.tsx` | 669 | `GenerationStatusPanel`, `RedundantDraftsHeader` |

### Why deferred

Source-text contract tests pin many of these. Extracting requires updating each test's `await read("...")` path. Easy work but tedious — best done as a focused session per component, not bundled.

### Where to start

Continue with `Header.tsx` — extract the mobile menu and avatar menu. Both are self-contained sub-trees with their own state management.

## 4. Continue splitting `tests/unit/session-features.test.ts`

**Status:** partial · **Effort remaining:** 2–4 h · **Blast radius:** low (tests only)

The file dropped from 3614 → 2568 lines after the per-article voice switcher block was extracted to [`tests/unit/session-features-voice.test.ts`](../tests/unit/session-features-voice.test.ts) and the personalization block (concept extraction overhaul, About statement, About wired, About + Refine UI) moved to [`tests/unit/session-features-personalization.test.ts`](../tests/unit/session-features-personalization.test.ts). ~30 unrelated `describe` blocks remain in the catch-all — pick the next clearly self-contained group (Slack normalization + permalink, bookmarks, briefing waterfall, audio outros, …) and extract it.

### Where to start

`Slack mrkdwn normalization` + `Slack permalink construction` are adjacent and self-contained — ~150 lines that move cleanly into `session-features-slack.test.ts`.

## 5. ~~Convert N+1 INSERTs in briefing pipeline to `db.batch()`~~ — DONE

See **Completed** below.

## 6. Continue migrating routes to zod-validated bodies

**Status:** partial · **Effort remaining:** multi-day · **Blast radius:** medium per route

Zod is now a dependency, [`src/shared/schemas.ts`](../src/shared/schemas.ts) hosts the schemas and the `parseBody` helper, and three routes are already migrated:

- `POST /api/me/refine-prompt` → `RefinePromptRequest`
- `POST /api/me/focus` → `StatementVersionRequest`
- `POST /api/me/about` → `StatementVersionRequest`

Each remaining `c.req.json<{...}>()` site is one schema + one `parseBody` swap. Hono also has first-class zod-validator middleware (`@hono/zod-validator`) if we ever want to centralize the wiring — for now, the explicit `parseBody` call keeps the migration grep-able and the error envelope stable.

### Where to start

Pick a single route file (e.g. `notifications.ts`) and migrate its handlers. Add the schema to `src/shared/schemas.ts` (the inferred type can re-export from there for the frontend).

## 7. ~~Migrate legacy `window.dispatchEvent` callers to the typed bus~~ — DONE

See **Completed** below.

## How to update this roadmap

When you complete an item, move its body to the **Completed** section at the bottom and replace the original section with a one-line `~~Title~~ — DONE` redirect. Don't delete the original heading — completed items are useful as breadcrumbs for understanding "why is this code shaped this way" later.

## Completed

### Kitchen-sink route splits (was item 2)

`routes/quiz.ts`, `routes/system.ts`, `routes/pieces.ts`, `routes/briefing.ts` are now thin assembly files (~30–45 lines each) that mount sub-routers from sibling folders:

- [`src/worker/routes/quiz/`](../src/worker/routes/quiz/) — `inline.ts`, `baseline.ts`, `shared.ts`
- [`src/worker/routes/system/`](../src/worker/routes/system/) — `health.ts`, `me.ts`, `stats.ts`, `focus.ts`, `about.ts`, `refine.ts`
- [`src/worker/routes/pieces/`](../src/worker/routes/pieces/) — `feedback-read.ts`, `deep-dive.ts`, `regenerate.ts`, `audio.ts`
- [`src/worker/routes/briefing/`](../src/worker/routes/briefing/) — `read.ts`, `lifecycle.ts`, `extra.ts`, `shared.ts`

The wire paths are unchanged. Source-text contract tests survived via [`tests/helpers/source.ts`](../tests/helpers/source.ts) → `readSplitSource(path)`, which concatenates the assembly file with every sibling sub-file so a single regex still matches across the family. New route splits should use the same helper.

### Briefing-pipeline N+1 INSERTs (was item 5)

`discovered_items`, `piece_resources`, and `near_misses` inserts in `briefing-generator.ts` are now batched via `db.batch([...])`. A typical briefing dropped from ~65 serial D1 round-trips to ~3 batches with no semantic change (`INSERT OR IGNORE` keeps the dedupe behaviour). See the inline comments at each batched site for the precise tradeoff.

### Typed event bus migration (was item 7)

Every `window.dispatchEvent(new CustomEvent("primer:..."))` call site that produced or consumed a typed event has migrated to [`src/frontend/lib/events.ts`](../src/frontend/lib/events.ts) via `dispatchPrimerEvent("...", payload)` / `onPrimerEvent("...", handler)`. The wire-format strings are unchanged so any third-party listener subscribing through raw `addEventListener` keeps working — only the dispatch + subscribe paths inside Primer are now type-checked.

Files touched: `App.tsx`, `Header.tsx`, `CommandPalette.tsx`, `ShortcutsDialog.tsx`, `VoiceSwitcher.tsx`, `TeachingPiece.tsx`, `ChatPanel.tsx`, `DeepDiveView.tsx`, `RichText.tsx`, `AudioPlayer.tsx`, `settings/SettingsModal.tsx`. Backwards-compatible string aliases (`OPEN_CHAT_EVENT`, `VOICE_CHANGED_EVENT`, etc.) are still exported as `primerEventName(...)` so any external consumer using the constants keeps working.
