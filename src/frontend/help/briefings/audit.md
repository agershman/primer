---
title: "The Audit Pass"
subtitle: "How Primer flags, patches, and drops unsupported claims before you read them"
audiences: [user, admin]
related:
  - briefings/teaching-pieces
  - briefings/deep-dives
  - reference/ai-models
---

Every teaching piece, deep dive, and quiz question in Primer goes through a two-pass **audit** between generation and persistence. The auditor inspects each factual sentence, flags claims the writer can't back up against the source bundle, opportunistically verifies un-cited claims against public sources via a hosted web search, and either patches or drops anything that survives both passes. The persisted content you read is what the auditor approved.

The audit's job is straightforward: **every factual sentence is either (a) tied to a source we showed the writer, (b) verified by a public source the auditor found, (c) rewritten to a defensible weaker form, or (d) dropped.**

## What you see

### The audit pill

In the metadata row of every teaching piece (and on the header of every deep dive + quiz), a small pill summarizes the audit:

- **Audited · clean** (green) — every factual claim is grounded in the writer's source bundle. No flags.
- **Audited · N web-verified** (green) — N claims weren't covered by the source bundle but the auditor confirmed them against public sources (docs, RFCs, papers, vendor changelogs).
- **Audited · N patched** (yellow) — the auditor rewrote N claims to a defensible weaker form. The patched text is what you're reading.
- **Audited · N dropped** (red) — the auditor removed N claims entirely (no truthful rewrite was possible).
- **Audit unavailable** (grey) — the audit itself errored. The original draft shipped unchanged. Rare.

Clicking the pill opens a dropdown with two entries:

- **Show / Hide audit marks** — toggle the inline wavy underlines on this piece.
- **View full audit trail** — opens the modal panel listing every classified claim with the auditor's reasoning, cited refs, web evidence, and patch diff.

### Inline audit marks

When marks are enabled (the default), flagged spans appear with a subtle wavy underline in the body of the article — same visual language as spell check or a grammar checker. Click a marked span to open a popover anchored to it:

- **Yellow wavy underline** — the auditor flagged this span as unsupported. Click to see why and what (if anything) the auditor verified.
- **Red wavy underline** — the auditor flagged this span as a likely hallucination.
- **Blue wavy underline** — the auditor patched this span; the popover shows the original wording and the rewrite.
- **Subtle blue underline** — the span was web-verified (the writer didn't cite anything, but the auditor found a trustworthy public source).

Dropped spans aren't underlined — they're no longer in the article. The pill's drop count tells you how many were removed; the full trail panel shows the dropped text.

You can hide inline marks per-piece via the dropdown, or globally via **Settings → Intelligence → Show audit marks inline**.

### The full audit trail

The trail panel groups claims by which pass produced them (pass 1 is the initial classify + patch; pass 2 only runs when pass 1 patched something). Each claim row shows:

- Verdict pill (grounded, web-verified, unsupported, hallucinated)
- Resolution (kept, patched, dropped)
- The claim text + (when patched) the rewrite
- The auditor's one-sentence reasoning
- Cited refs — the source bundle entries the auditor linked the claim to (or "no cited ref" when the writer didn't tag the sentence)
- Web evidence — when present, clickable cards pointing to the public source(s) the backstop found

## How the audit works

1. **Writer emits claims with inline citations.** Each generator (teaching, deep dive, quiz) is instructed to append `[[ref:<enrichment-id>]]` tags to every factual sentence, drawn from the source bundle that was handed to it. Those tags are signal for the auditor — they tell us what the writer *intended* to cite. They're stripped from the rendered text before you see it.

2. **Pass 1 — classify against the source bundle.** A small model (Haiku by default) reads each text block and emits one record per factual sentence: span offsets, verdict, citation list, and a one-sentence reason.

3. **Web-search backstop.** For every flagged claim that carries no cited ref, the auditor invokes the model's hosted `web_search` tool to check the claim against trustworthy public sources. A verified claim upgrades to "web-verified" and surfaces in the trail with the source URLs. Un-verified claims fall through to the patch step.

4. **Patch step.** The patcher (defaults to the same model as the drafter, for voice consistency) either rewrites the flagged span to a defensible weaker form or signals "drop". Patches apply right-to-left within each block so offsets stay stable.

5. **Pass 2.** Patched spans are re-audited against the source bundle. Still-flagged spans are dropped (no patch retry).

If the auditor errors at any step, the **original draft ships unchanged** and the pill renders "Audit unavailable". The pipeline never loses a piece because the audit had a bad day.

## What the audit costs

Audit calls roll into the same monthly budget cap as the generators — see [Analytics](/help/reference/analytics) for the "Audit overhead" rollup card. Rough order of magnitude: an extra $0.005–0.015 per audited piece with the default Haiku auditor + Sonnet patcher. You can downgrade `auditPatch` to Haiku in **Settings → Intelligence → AI models** if you want to trade voice consistency for cost.

## What's NOT audited (today)

- **Chat responses.** A separate trust surface — handled in a follow-up if there's signal.
- **Quiz answer assessments.** The depth verdict you get back when you answer a quiz is the model's *judgement* of your knowledge, not a factual claim. The gaps + learning-path resource links it produces could in principle be audited; not in v1.
- **Per-depth indicators** stored on a quiz row — internal-facing only.
- **Historical content** (briefings older than the audit feature). Audit only runs at generation time and on the admin "↻ try different model" regenerate path.
