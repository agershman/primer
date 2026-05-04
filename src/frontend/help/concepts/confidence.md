---
title: "Confidence Badges"
subtitle: "Verified, estimated, and unverified scores"
audiences: [user]
related:
  - concepts/depth-scale
  - calibration/quizzes
---

Not all depth scores are equally reliable. A score based on a thorough quiz assessment is much more trustworthy than one inferred from a thumbs-up on a teaching piece. Primer uses **confidence scores** (0.0 to 1.0) to track how reliable each depth score is, and displays this as a badge on concept pages.

## The Three Tiers

### Verified (confidence ≥ 0.7)
The depth score has been confirmed through quiz assessment. Primer has directly evaluated your understanding and is confident the depth accurately reflects your knowledge.

Verified badges appear as a solid indicator, typically in the positive/green color. These concepts are the most reliably calibrated in your graph.

### Estimated (confidence 0.4–0.69)
The depth score is inferred from indirect signals — teaching piece feedback, exposure patterns, or a quiz that was somewhat ambiguous. Primer has a reasonable basis for the score but hasn't conclusively verified it.

Estimated badges appear in the accent/amber color. These concepts benefit from quiz calibration to improve accuracy.

### Unverified (confidence < 0.4)
The depth score is a rough guess based on limited data — perhaps just the initial extraction or a single piece of feedback. The actual depth could be significantly different.

Unverified badges appear in the dim/gray color. These concepts are high-priority targets for calibration quizzes.

## Why Primer Keeps Quizzing You

Primer prioritizes quizzing concepts with low confidence, not just low depth. A concept at depth 3 with confidence 0.3 is a better quiz target than a concept at depth 1 with confidence 0.8 — because the former's score is unreliable and might be wrong, while the latter's score, though low, is trustworthy.

This is why you'll sometimes get quizzed on concepts you feel confident about. Primer isn't doubting you — it's verifying its own model. Once your answer confirms the existing score, the confidence jumps and Primer moves on to other concepts.

## Confidence Decay

Confidence gradually decreases alongside depth during knowledge decay. Even a verified concept becomes estimated after extended periods without exposure or recalibration, because Primer can't be sure you still remember it at the same level.
