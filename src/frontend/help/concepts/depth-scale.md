---
title: "Depth Scale"
subtitle: "Understanding 0–5 knowledge scoring"
audiences: [user]
related:
  - concepts/confidence
  - concepts/decay
  - calibration/quizzes
---

Every concept in your graph has a **depth score** from 0 to 5. This score represents how deeply you understand the concept, not just whether you've heard of it. Primer uses this scale to calibrate teaching content to your level.

## The Levels

### 0 — Unknown
You haven't encountered this concept in a Primer context. It exists in your graph because it was extracted from work signals, but you haven't been taught or quizzed on it yet.

*Example: "eBPF" appears in a Slack thread you were in, but you've never engaged with it in Primer.*

### 1 — Aware
You know what it is and roughly why it exists, but couldn't explain the mechanics. You recognize the term in conversation.

*Example: You know Kubernetes HPA auto-scales pods based on metrics, but you couldn't describe the scaling algorithm or configure one from scratch.*

### 2 — Understands
You grasp how it works at a functional level. You could explain the key components and common patterns to a colleague, and you've likely used it in some capacity.

*Example: You've configured HPA with CPU targets, understand the cooldown periods, and know the difference between resource and custom metrics.*

### 3 — Applies
You can effectively use this in production with confidence. You understand the tradeoffs, know the failure modes, and can make informed decisions about when to use it versus alternatives.

*Example: You've tuned HPA scaling policies for production workloads, debugged thrashing issues, and know when VPA or KEDA would be a better fit.*

### 4 — Teaches
You could teach this to someone else effectively. You understand the design decisions behind the concept, can anticipate edge cases, and have opinions about best practices backed by experience.

*Example: You've written internal documentation on HPA, mentored others through scaling issues, and have strong views on stabilization windows and behavior configurations.*

### 5 — Authoritative
You have deep expertise, potentially including knowledge of internals, historical context, or contrarian perspectives that most practitioners don't have. You could contribute to the upstream project or write definitive reference material.

*Example: You've read the HPA controller source code, understand the algorithm's evolution across Kubernetes versions, and have contributed to discussions about its limitations.*

## How Depth Changes

Depth changes through several mechanisms:

- **Quiz assessment** — The most accurate calibration. A quiz answer is assessed by the configured Quiz assessment model (Claude Sonnet 4 by default; configurable in Settings → AI Models) to determine demonstrated depth.
- **Positive feedback** — Thumbs-up on a teaching piece adds +0.2 to related concepts.
- **Knowledge decay** — Concepts not exposed or calibrated for 60+ days gradually lose depth.
- **Baseline calibration** — Initial batch assessment when you first encounter a set of concepts.

Depth is always a floating-point number (e.g., 2.4), though it's often displayed rounded. The decimal precision matters for calibration accuracy.
