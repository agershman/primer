---
title: "Giving Feedback"
subtitle: "How thumbs-up and thumbs-down affect your concept graph"
audiences: [user]
related:
  - concepts/depth-scale
  - concepts/confidence
---

Every teaching piece has thumbs-up and thumbs-down buttons. Your feedback directly influences your concept graph and future briefings.

## Positive Feedback (Thumbs Up)

When you mark a piece as helpful, Primer interprets this as "I engaged with this content and it advanced my understanding." The effect:

- **Depth bump:** Each concept associated with the piece receives a +0.2 depth increase, capped so it can't jump more than 0.5 above your current score in a single interaction.
- **Confidence boost:** Confidence increases slightly, signaling that your depth score is becoming more reliable.
- **Exposure update:** The concept's last-exposed timestamp is refreshed, resetting the decay clock.

A feedback toast appears briefly showing the delta — for example, "Kubernetes HPA: 2.0 → 2.2" — so you can see exactly what changed.

## Negative Feedback (Thumbs Down)

Negative feedback means "this wasn't useful to me" — maybe it was too basic, too advanced, or off-target. The effect:

- **No depth change.** Primer doesn't penalize you for receiving a bad piece; the problem was in the content selection, not your knowledge.
- **Recalibration signal:** The generation pipeline records that this concept-depth pairing wasn't a good match, which adjusts future target selection. Over several negative signals, Primer shifts the depth at which it targets that concept.

## Impact on Future Briefings

Feedback accumulates over time. If you consistently give positive feedback on infrastructure topics at depth 3 and negative feedback on product topics at depth 1, Primer learns to prioritize the former and recalibrate its approach to the latter. This is separate from quiz-based calibration — feedback captures your subjective assessment of usefulness, while quizzes measure objective understanding.
