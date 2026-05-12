# 0007 — Two-pass content audit with web-search backstop

**Status:** accepted

## Context

Primer ships three flavours of user-facing AI content: teaching pieces, deep dives, and calibration quizzes. Pre-audit, every generator emitted directly to the reader with no post-write check. The trust surface was real and tiered:

- **Teaching pieces** receive a `SourceDescriptor[]` bundle and are anchored to it — the most defensible content today, but writers still produced unsourced factual claims at the edges.
- **Deep dives** received only `conceptName + parent piece text` — they had no source bundle, so almost every factual claim was grounded in "what the model knows."
- **Quiz questions** are short but high-leverage — a question with a flawed factual premise miscalibrates the user's depth score for the concept.

The codebase already tracks model attribution per piece and surfaces a footer to the reader ("Generated with Claude Sonnet 4"). That footer is a trust contract: when the model gets a claim wrong, the footer becomes a sticker over a hole. The audit is what backs the contract.

## Decision

Add a content-agnostic auditor (`src/worker/services/piece-auditor.ts`) that runs after every generator and follows the same shape across all three target kinds:

1. **Strip writer-emitted `[[ref:<enrichment-id>]]` markers** from each text/heading block. The markers are valuable signal for the auditor's LLM (they tell us what the writer *intended* to cite) but they don't belong in user-visible text. Stripping up-front means span offsets recorded in `audit_claims` line up with the rendered DOM.
2. **Pass 1 — classify each factual sentence** against the local source bundle: `grounded`, `unsupported`, or `hallucinated`.
3. **Web-search backstop** fires only on flagged spans that carry no cited ref. Hosted `web_search` server tools (Anthropic's `web_search_20250305` today; OpenAI's Responses API tool when the adapter extends to it) verify the claim against trustworthy public sources. A verified claim upgrades to `grounded-web`.
4. **Patch** remaining flagged spans with the SAME model the drafter used (voice consistency). The patcher either rewrites the span to a defensible weaker form or signals "drop". Right-to-left within each block so offsets stay stable.
5. **Pass 2** re-audits patched spans. Still-flagged → drop (no patch retry).
6. **Fail-open** on any thrown LLM error: the original content ships unchanged, a single `audits` row with `status='failed'` is persisted, and the indicator pill renders "Audit unavailable". The pipeline must NEVER lose a piece because the auditor had a bad day. Same pattern the continuation classifier uses (see `briefing-generator.ts` around the continuation-rewrite fallback).

Per-claim outcomes persist in two polymorphic tables (`audits` + `audit_claims`, keyed on `(target_kind, target_id, pass)`); the briefing-read endpoint LEFT JOINs the latest pass-1 row so every piece carries an inline `audit_summary` rollup; the full trail lives behind `GET /api/piece/:id/audit`.

Inline wavy-underline marks on flagged spans (`.audit-mark` CSS in `tokens.css`) are the primary UI surface. Clicking a mark opens `AuditPopover` anchored to the span. The `AuditIndicator` pill in the metadata row is a secondary at-a-glance summary; its dropdown exposes "Show audit marks" toggle + "View full audit trail" entry.

## Why this shape

**Hosted web search over a third-party API.** Anthropic and OpenAI both host `web_search` tools today. A third-party (Tavily, Brave, Perplexity) would mean another API key, another secret, another rate-limit story. The hosted variants ride the same API key + the same retry semantics as the LLM call — zero new operational surface. The adapter seam (`integrations/web-search.ts` + `serverTools` on `CreateMessageOptions`) is shaped so a future Tavily provider slots in as another `kind` without touching the auditor.

**Cited-ref gate on the backstop.** Web search is the most expensive auditor primitive. Running it on every unsupported claim doubles audit cost. Gating to "no cited ref" lets the writer's own citation discipline do the cheap pre-filter — when the writer correctly anchored a claim to a local source, the local-source classifier already has enough signal. Only un-cited claims need an outside check.

**Same model as the drafter for the patch step.** A patch in a different voice reads as a stitched-in apology. Keeping the patch model in lock-step with the drafter (Sonnet by default, admin-overridable per slot) means the post-audit text is indistinguishable from a clean writer run. The trade-off is cost; admins who want a cheaper patch can downgrade `auditPatch` in `Settings → Intelligence → AI models`.

**Polymorphic `audits` table over three near-identical tables.** Pieces, deep dives, and quizzes share the same rollup math, the same UI rendering, the same analytics aggregation. Splitting them would force every aggregation query to `UNION ALL` three sources. The CHECK on `target_kind` + the per-kind FK enforcement at the application layer (the auditor wrapper functions) preserves referential intent without a per-kind FK column.

**Strip `[[ref:...]]` markers before persisting.** The alternative — keep them in the stored content and have the frontend strip on render — forces every rendered span offset to also walk back through tag-position arithmetic. Stripping at the auditor boundary collapses two coordinate spaces into one: the auditor's offsets, the persisted offsets, and the rendered DOM's offsets all agree.

**Fail-open instead of fail-closed.** The audit is a quality-of-life feature; a missing audit is "less trust signal", not "no piece". Failing open keeps the pipeline robust to LLM weather (timeouts, JSON parse failures, schema drift) and matches the continuation-classifier pattern. The `status='failed'` row gives analytics visibility into how often the audit itself flaked.

## Consequences

**Wins**

- Every factual sentence is now either (a) tied to a source we showed the writer, (b) verified by a public source, (c) rewritten to a defensible form, or (d) dropped.
- The audit pill + inline marks make the trust state legible without leaving the article.
- Audit overhead rolls into the unified `usage_events` ledger via the existing `recordTokenUsage` helper; the analytics page picks it up automatically.
- Per-claim audit trail is debuggable — an admin can see WHY a span got patched, what the auditor's reasoning was, and what web evidence (if any) supported the upgrade.

**Costs**

- Each piece now costs an extra Haiku classification call per block, plus a Sonnet patch call per flagged span, plus an occasional hosted web search. Rough sketch: ~$0.005–0.015 per audited piece. Tunable down by overriding `audit` and `auditPatch` to Haiku in Settings.
- The writer prompt now carries an extra block of citation-discipline instructions. The longer prompt is a one-time cost per call (prompt cache absorbs most of it for Anthropic).
- The auditor adds two passes of latency. Pass 1 runs in parallel per block; pass 2 only runs when something was patched. Typical addition: 2–8 s per piece.

**Risks**

- **False-positive flagging.** The auditor might call a true claim "unsupported" if the source bundle doesn't surface it explicitly. The patch step's "no patch retry on pass 2" rule means a marginal claim can get dropped where it should have been kept. Mitigated by the web-search backstop on un-cited claims; un-mitigated when the writer cited an irrelevant ref. Surfaced in the trail so an admin can see + correct.
- **Cost runaway on a piece with many un-cited unsupported claims.** A draft with 20 such claims fires 20 web searches plus 20 patch calls. The `BUDGET_CAP_MONTHLY` cap stops the whole pipeline when this happens, which is the right circuit-breaker but loses the briefing's later pieces. Future: a per-piece audit cost cap.

## Alternatives considered

- **Audit only teaching pieces, leave deep dives + quizzes uncovered.** Cheapest, but the highest-stakes (longest, most-shared) content stays unaudited. Rejected.
- **Audit only AFTER user feedback — flag a piece only when a reader pressed thumbs-down.** Doesn't catch the silent-skip case (reader sees a wrong claim, loses trust, never gives feedback). Rejected.
- **Real-time inline audit during streaming.** Adds 5–10 s to first-byte latency. The audit's value is "I can trust what I just read" — landing the verdict 2–3 s after the reader gets the text is fine. Rejected.
- **Tavily / Brave HTTP API for the web-search step.** Slightly cheaper than hosted, but a new API key, a new rate limit, a new failure mode. The seam supports it as a future addition; not the shipped default.

## Implementation pointers

- `src/worker/services/piece-auditor.ts` — `auditContent(...)` + `auditPiece` / `auditDeepDive` / `auditQuiz` wrappers.
- `src/worker/integrations/web-search.ts` — `supportsWebSearch`, `parseWebEvidence`, `checkClaimWithWebSearch`.
- `src/worker/integrations/llm/{anthropic,openai}-adapter.ts` — translate `serverTools` to provider-native hosted-tool format.
- `src/worker/config/models.ts` — `audit` (default Haiku) + `auditPatch` (default Sonnet) operations.
- `migrations/0007_content_audits.sql` — `audits` + `audit_claims` tables, indexes, `ALTER TABLE user_settings ADD COLUMN show_audit_marks`.
- `src/frontend/components/{AuditIndicator,AuditPopover,AuditTrailPanel}.tsx` — the three UI primitives.
- `src/frontend/components/RichText.tsx` — `highlightedRanges` prop for the inline marks.
- `src/frontend/styles/tokens.css` — `.audit-mark*` variants using the existing color tokens.

Source-text contract tests pin the patterns: `tests/unit/audit-prompt-contract.test.ts`, `audit-routes.test.ts`, `audit-usage-labels.test.ts`, `audit-settings-panel.test.ts`, `audit-migration.test.ts`.
