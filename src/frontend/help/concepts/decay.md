---
title: "Knowledge Decay"
subtitle: "How depth scores decrease over time"
audiences: [user]
related:
  - concepts/depth-scale
  - calibration/quizzes
---

Knowledge fades without reinforcement. Primer models this through a **decay system** that gradually reduces depth scores for concepts you haven't engaged with recently.

## Decay Timeline

The decay clock starts from whichever is more recent: your last exposure to a concept (reading a piece about it, getting it in a quiz) or your last calibration (quiz assessment, feedback).

- **30 days without activity** — A decay warning appears on the concept. No depth change yet, but Primer flags it as at-risk and may prioritize it in upcoming briefings or quizzes.
- **60 days without activity** — Depth decreases by 0.3. A concept at depth 3.0 becomes 2.7. Confidence also decreases, reflecting uncertainty about your current level.
- **90 days without activity** — Another 0.3 decrease. The concept at 2.7 would now be 2.4. The warning badge becomes more prominent.

## Decay Floor

Depth never decays below **1.0** for concepts that have been calibrated at least once. If Primer has verified — through a quiz or baseline calibration — that you knew something at any point, it assumes you retain at least awareness-level knowledge. Only concepts that were never calibrated (depth set entirely through inference) can decay to 0.

## Resetting the Clock

Any meaningful interaction resets the decay clock:

- Reading a teaching piece that covers the concept
- Answering a quiz about the concept
- Giving feedback on a piece that references the concept

Simply seeing the concept name in a briefing without engaging doesn't count.

## Re-Calibration Targets

Decayed concepts are prime targets for re-calibration. If Primer detects that several of your concepts have decayed past the 60-day mark, it may trigger a baseline calibration session — a focused set of 3–6 quiz questions designed to re-establish accurate depth scores for the most important decayed concepts.
