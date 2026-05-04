---
title: "Baseline Calibration"
subtitle: "Establishing starting depths for key concepts"
audiences: [user]
related:
  - calibration/quizzes
  - concepts/depth-scale
---

Baseline calibration is a focused quiz session that establishes accurate starting depths for a batch of concepts at once, rather than one at a time through daily briefing quizzes.

## When It Triggers

A prompt to "Start calibration" appears on the **Concepts** page when Primer detects **3 or more concepts below depth 2**. This happens in two main scenarios:

1. **Cold start** — When you first use Primer and a batch of concepts are extracted from your work context with no depth data
2. **Concept influx** — When a new project or area of work introduces several unfamiliar concepts at once (e.g., you get assigned to a new team's codebase)

## Async preparation (you can navigate away)

The **Start calibration** button on the Concepts page kicks off baseline-question generation in the **background**. You don't have to wait on the Concepts page — close the tab, browse other Primer surfaces, even hit the dashboard — and a [bell-icon notification](/help/reference/notifications) (`kind = "baseline_calibration"`) pops the moment your quiz is ready. Clicking the notification jumps you straight to `/calibrate`.

Mechanically:

- The button hits `POST /api/quiz/baseline/prepare`. The route immediately spawns an `in_progress` notification and returns `{ status: "preparing" }`. Generation runs server-side via Cloudflare's `ctx.waitUntil`, so it survives long after the HTTP response closes.
- While the prep is running, the button on the Concepts page reads **Preparing your calibration…** and is disabled — clicking again is a no-op (the route is idempotent on the in-flight notification).
- `GET /api/quiz/baseline` shares the same idempotency: if a `baseline_calibration` notification is in flight, the endpoint returns `{ generating: true }` instead of kicking off a duplicate inline generation. The Concepts page poll uses this to keep its UI in sync with whatever started prep.
- When generation completes, the notification flips to `ready` with `actionUrl = "/calibrate"`. The next call to `GET /api/quiz/baseline` returns the saved questions. If something goes wrong, the notification flips to `failed` with the error message attached and the inline error surfaces under the Concepts button.
- The same Sunday 3 AM UTC maintenance cron that reaps stuck deep-dive notifications (5+ minutes without progress → `failed`) also reaps stuck baseline-prep rows, so a row left dangling by a worker that died mid-flight will eventually self-heal. To unblock sooner, dismiss the in-flight notification from the bell dropdown — `POST /api/quiz/baseline/prepare` is idempotent on a still-`in_progress` row, so re-clicking the button is a no-op until you clear the stale one.

## The Quiz Session

Each baseline session is **up to 6 questions** — one per low-depth concept, starting from the lowest. The 6-question cap is intentional: more than that and people abandon mid-batch, which produces worse calibration than just doing fewer at a time. If you have 30 unverified concepts, you run ~5 sessions (each takes ~5–10 minutes); the UI tells you "X of N calibrated" so you can pace yourself. Generation takes a few seconds per question (using your configured quiz generation model, default Haiku 4.5). Once the questions are ready (either inline or via the async prep flow above), they're served from the saved set on `GET /api/quiz/baseline`.

## Calibration scopes

Calibration is **per-concept** under the hood — every `calibration_quizzes` row maps to exactly one concept. The UI exposes two entry points so you can decide what to calibrate next:

- **Cross-trail (the top-level "Start calibration" CTA)** — picks the lowest-depth concepts globally. Best when you don't have a particular focus area in mind and want Primer to grab whatever needs the most attention right now. The button label includes the count: "Start calibration (6 of 30) →" so you know how many will land in this session vs. how many remain.
- **Per-trail (the "Calibrate trail (N) →" CTA on each trail header)** — scopes the batch to one trail, picking the lowest-depth concepts within it. Best when you're focused on one area (you just got assigned to a new team, you're prepping for a project review, etc.) and want every question to be on-topic.

Both share the same 6-question cap and the same single-batch-at-a-time rule: while one batch is pending or being assessed, all "Start calibration" buttons reflect that shared state instead of letting you pile up duplicates across scopes.

The questions follow the same design principles as daily calibration quizzes — open-ended, probing understanding rather than recall. You answer each question in sequence — submitting advances you to the next question immediately while the AI assessment runs in the background. No waiting between questions.

When you've answered all questions, the results screen shows your assessed depth for each concept. Scores that are still being assessed show a pulsing indicator and fill in as each assessment completes (typically a few seconds each). You don't need to wait for all results before navigating away — the assessments complete and update your concept graph regardless.

### Speaking your answer (voice-mode dictation)

Every answer textarea has a microphone button in the top-right that puts the field into **voice mode**, modeled after voice mode in modern AI assistants. The same mic behavior applies everywhere you can write a paragraph in Primer — baseline calibration, the daily inline quiz, the chat input, the avatar-menu **Set focus** editor, the **About you** and **Current focus** textareas in Settings, and the first-run onboarding wizard's About/Focus steps. One consistent interaction wherever you can talk to Primer:

- Tap the mic to start, talk freely (with pauses to think), tap again to send. Or just stop talking — the session **auto-stops after 5 seconds of silence**, treating that as "I'm done". Pressing **`Esc`** also stops the mic immediately, without dismissing the panel you're dictating into (so you don't lose your draft if you accidentally fire up voice mode).
- Your live transcript appears in the textarea as you speak — finalized phrases get committed to the answer, the in-progress phrase shows next to them.
- Brief pauses (up to 5 seconds) don't end the session. Primer transparently auto-restarts the recognizer underneath whenever the browser's silence detector cuts in (a quirk of `webkitSpeechRecognition` on Chromium that would otherwise stop you mid-thought every 1–2 seconds).
- The textarea becomes read-only while listening so your typing doesn't fight the live transcript; the field gets an accent ring and a "● Listening — speak freely…" hint.
- Transient browser errors (`no-speech`, `aborted`, `audio-capture`) are treated as "user paused" and trigger a silent restart. Real errors (network failure, mic permission denied) tear down cleanly.

Voice mode is great for stream-of-consciousness answers — say what you actually think, then edit the transcript before submitting if you want to.

## Why It Matters

Without baseline calibration, Primer would have to spend several daily briefings probing one concept at a time before it had enough data to teach effectively. Baseline calibration compresses this into a single 3–5 minute session, dramatically improving the quality of your first few briefings.

The alternative — guessing your depth based on which concepts you've been exposed to — leads to teaching that's either too basic (wasting your time) or too advanced (creating confusion). Even a rough calibration through baseline quizzes produces noticeably better content than no calibration at all.

## Re-Calibration

Baseline calibration can also trigger for existing users when enough concepts have decayed past the 60-day mark. In this case, the quiz focuses on re-establishing accurate scores for concepts Primer suspects you may have lost ground on.
