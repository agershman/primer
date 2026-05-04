---
title: "Continuations and Series"
subtitle: "How Primer chains follow-up pieces and filters near-duplicates"
audiences: [user]
related:
  - briefings/teaching-pieces
  - briefings/how-generation-works
---

Once Primer has written a piece about a topic, the next briefing might find that nothing genuinely new has happened in the outside world. Slack might be quiet. Linear ticket descriptions haven't moved. The PR queue is unchanged. Without a guardrail, Primer would happily produce another piece on the same topic with slightly different phrasing — déjà vu briefings, day after day.

The **continuation gate** prevents that. Every fresh draft is classified against recent pieces *before* it's persisted, so the briefing only contains pieces that are either standalone-novel or genuine follow-ups.

## What you'll see

### Part-N badges

Pieces in a multi-part series get a small **Part 2 of 3** pill next to the title. The first piece in a series isn't labeled until a Part 2 lands — at that point it gets retroactively labeled **Part 1**. From then on, both parts show their position in the series.

### Bidirectional series navigation

Pieces in a series carry a small **previous / next** strip above the body:

- `← Part 1: <title> · Apr 12` — link to the prior part.
- `Part 3: <title> · Apr 18 →` — link to the next part.

Both links jump straight to that part inside its briefing day. The strip is subtle on purpose: it reads like a magazine series footer, not chrome.

### "A continuation was published" banner on Part 1

When you re-open Part 1 *after* a Part 2 has been published, you see a more prominent banner pointing to the continuation. The reason is asymmetric: you almost certainly read Part 1 as a standalone before Part 2 ever existed (the series only formed when the classifier picked it as a predecessor). The banner is the heads-up that the topic now has a follow-up.

### "new" pill on today's continuations

When today's briefing contains a Part 2+ piece, that piece's title gets a tiny green **new** pill alongside the Part-N badge. It only renders while the piece is in *today's* briefing — the next morning, the same piece (now in "yesterday's") shows just the regular badge. No acknowledgement state, no clearing — the briefing date carries the signal.

### "No new movement" header chip

When the classifier filters one or more drafts as **redundant** (no genuinely new content), the briefing header shows:

> 2 topics had no new movement today: **X (Part 1)** · **Y**

Each entry deep-links back to the predecessor piece. The chip is muted styling — meta-context, not a primary surface. Hovering an entry shows the LLM's one-sentence reason for filtering.

## How the gate decides

Each draft goes through two stages.

**1. Candidate recall (structural).** Primer looks at recent pieces (default: last 30 days) and selects up to 5 that overlap with the draft on at least one concept ID **or** at least one source URL/issue ID. This is a wide net — pieces routinely share concepts without being continuations, but the cheap heuristic gives the LLM a small, focused candidate set instead of a month of unrelated history.

**2. Classification (LLM).** The classifier (Haiku) sees the draft and the candidates, and emits one of three buckets with a one-sentence rationale:

- **`NOVEL`** — no meaningful overlap of claims with any candidate. The default when uncertain. Persists as a standalone piece.
- **`ADDITIVE_CONTINUATION`** — builds on a specific candidate with new movement: new claims, sources from a clearly later point in time, a resolution the earlier piece couldn't yet describe. Picks the strongest candidate. The pipeline links them into a series.
- **`REDUNDANT`** — covers the same ground as a specific candidate with no meaningfully new claims, sources, or actions. The draft is dropped; the candidate becomes the chip entry.

The prompt is explicit about being conservative — Primer would rather emit a slightly-overlapping novel piece than aggressively chain pieces that aren't really continuations.

## Why the 30-day window

Continuations only chain within the last 30 days. Beyond that:

- The user has likely forgotten the prior piece. A callback ("Last time we looked at X (six months ago)...") would be more confusing than helpful.
- Concepts and sources drift. A topic that came up in February probably looks different by August even when the surface labels match.
- The candidate prompt grows with the lookback. Bounded recall keeps classification cheap and fast.

After 30 days, the classifier doesn't even consider the older piece — the new draft just stands on its own.

## When the classifier fails

The continuation gate is designed to **fail open**: any error from candidate selection or the LLM call falls through to NOVEL. The pipeline never drops a piece because the gate had a bad day. The worst case is that you get an occasional near-duplicate piece, not a missing one.

## What's in your control

- **Suppress concepts** that the classifier keeps misjudging. Suppressed concepts don't generate fresh pieces, so they can't trigger the gate.
- **Refine your focus statement.** Tighter focus narrows candidate recall (concept overlap), which biases the gate toward NOVEL on tangential topics.
- **Open the predecessor piece** from the chip's deep link to see exactly what was already covered. If you disagree with the filter, the link gets you there in one click.

## What's NOT in your control (yet)

- There's no manual "merge two pieces into a series" or "split this out of a series" override. If the classifier picks the wrong predecessor or skips one it should have linked, the only correction today is to wait for the next round.
- The header chip lists redundant drafts but doesn't yet let you "promote" one back to a full piece. If you want the dropped piece anyway, the predecessor link is the closest substitute.

These are tracked as follow-up improvements; reach out if either matters for how you want to use Primer.
