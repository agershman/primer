---
title: "Quiz Assessment"
subtitle: "Understanding gaps and learning paths"
audiences: [user]
related:
  - calibration/quizzes
  - concepts/confidence
---

After you answer a calibration quiz, Primer assesses your response using the model you've configured for **Quiz assessment** in **Settings → AI Models**, to determine what depth of understanding you demonstrated. The assessment is structured in three sections.

## How Assessment Works

When you submit an answer, Primer sends your response along with the quiz question, concept name, your current depth score, and expected depth indicators to the configured assessment model for evaluation. The assessment model (configurable in Settings → AI Models → Quiz assessment) compares your answer against what depth-1 through depth-5 responses look like and assigns a calibrated score. Defaults to Claude Sonnet 4 today; switching to another provider's model in the picker swaps the assessment LLM with no code change.

Both inline quizzes (attached to briefing pieces) and baseline quizzes (from the /calibrate flow) use the same real-time AI assessment. Batch baseline submissions are assessed sequentially, so each answer gets individual attention.

## Section 1: Depth Change

The core result — what depth your answer demonstrated and how it compares to your previous score. You'll see:

- **Previous depth** — Where you were before the quiz
- **Assessed depth** — What your answer demonstrated
- **Reasoning** — A 1–2 sentence explanation of why Primer assessed the depth it did

If the assessed depth is higher than your previous score, your concept depth increases. If it's lower, the depth adjusts downward. If it's roughly the same, the main effect is a confidence increase — Primer is now more sure about your score.

The depth change also writes to your concept history, so you'll see it in the sparkline chart.

## Section 2: Where Your Thinking Fell Short

Even when your overall assessment is strong, there are often specific gaps or imprecisions in your answer. This section identifies them:

- **Gap summary** — A one-sentence description of the main gap (e.g., "Your explanation didn't address failure modes")
- **Specifics** — A list of concrete things you missed or got slightly wrong

This isn't punitive — it's diagnostic. Knowing exactly where your mental model has holes is the fastest way to fill them.

## Section 3: Suggested Learning Path

Based on the gaps identified, Primer suggests a learning path — a sequence of 2–4 actions you could take to strengthen your understanding:

- **Read a specific resource** — Links to documentation, blog posts, or internal docs that address the gap
- **Review a related teaching piece** — Points back to a Primer piece that covers the missing angle
- **Explore a prerequisite concept** — If the gap is foundational, suggests going deeper on a prerequisite first

Each suggestion includes a link where applicable, making it actionable rather than abstract.

## What Happens After Assessment

After assessment completes:

1. Your **concept depth** is updated to the assessed score
2. Your **confidence** increases (Primer is more certain about your depth)
3. A **depth history entry** is recorded (visible in concept sparklines)
4. The assessment details are stored on the quiz record for later reference

If assessment fails for any reason (e.g., API timeout), the quiz is still marked as answered and a placeholder is returned. You can always re-calibrate the concept later.
