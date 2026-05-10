---
title: "Welcome to Primer"
subtitle: "What Primer is and how it works"
audiences: [user]
related:
  - getting-started/your-first-briefing
  - getting-started/setup
---

Primer is a personalized daily learning briefing that keeps you sharp on the technologies, systems, and concepts you encounter at work. Rather than passively absorbing information from Slack threads, Linear tickets, GitHub PRs, and incident post-mortems, Primer actively extracts what matters, identifies what you already know, and teaches you what you don't — calibrated to your exact level of understanding.

## How Primer knows you

Two short paragraphs you write shape everything Primer produces:

- **About you** (stable persona) — who you are: role, experience, communication preferences, learning style. Tailors voice and depth across **all** of Primer's AI: teaching pieces, deep dives, chat, quizzes, and relevance scoring. Update it as your role evolves.
- **Current focus** (dynamic priority) — what you want to learn right now. Drives concept extraction: biases the system toward concepts that intersect your focus and away from organizational noise. Update it whenever your priorities shift.

Both fields are versioned with full history and a one-click **✨ Refine with AI** that asks Claude to tighten your draft into a prompt-ready paragraph. You see the diff before accepting, and the system never invents facts about you.

### First-run onboarding

The very first time you load Primer, you'll see a two-step welcome wizard that captures both statements before you reach the briefing. About comes first (stable, slow-changing), then Focus (dynamic, fast-changing). Each step has the same ✨ Refine with AI you'll use later in Settings. There's a "Skip for now" link if you want to look around first — you can finish the setup from Settings or via the prompt that reappears the next time you open Primer in a new session. We strongly recommend not skipping: until both are set, briefings read like generic industry-news summaries.

### Updating focus from the avatar menu

Focus changes naturally as you learn things, switch teams, or get curious about new areas. Click your **avatar** in the top-right and choose **Set focus** — a quick editor opens showing your current focus statement (truncated, plus the full text in the modal) and lets you save a new version with one click. Saving creates a new version (your previous focus stays in history with attribution to the concepts and briefings it produced); today's briefing was already generated against the old focus, so the new one shapes the *next* briefing.

The avatar menu's focus entry is the canonical surface for "I want to peek at or change my focus" — fast, always visible, no scrolling. The full versioning UI (history modal, per-version analytics, restore/delete) still lives in **Settings → Current focus → View history** for when you want to look back at how your focus has evolved.

### What about focus on past briefings?

Each briefing is still tagged server-side with the focus version that was active when it ran (`focus_version_id` on the `briefings` row, joined against `focus_statement_versions` on read), so analytics + the version history modal can attribute concepts and content to the focus that drove them. We don't surface this inline in the briefing UI anymore — the per-briefing badge added too much visual chrome to a view whose job is to be calm and focused on content. If you want to see what focus drove a specific briefing, open **Settings → Current focus → View history** and follow the version's analytics view.

## How a briefing comes together

Every morning, Primer generates a fresh briefing by scanning your work signals — active Linear issues, Slack conversations, GitHub PRs you're involved in, and recent incidents. It maps these against your personal **concept graph**, a living model of what you know and how deeply you know it. Concept extraction is biased by your **Focus** statement so the graph fills with topics you actually care about, not whatever happened to be mentioned in a Slack thread. The result is a set of concise teaching pieces, each written at exactly the depth that will challenge you without being redundant — and in a voice tuned to your **About** statement.

Primer goes beyond your immediate work context through **feed scanning**. It scans external sources like Hacker News, CNCF blog posts, AWS announcements, and academic papers to find material relevant to concepts you're working with but haven't been exposed to yet. Both your About and Focus inform what counts as relevant, so the serendipity layer doesn't waste your attention on off-topic technical content.

## Calibration and reading

Your knowledge is kept honest through **calibration quizzes** — open-ended questions that probe your understanding, not your ability to recall keywords. When you answer a quiz, Primer assesses the depth of your response, identifies gaps in your mental model, and adjusts your concept graph accordingly. Quiz framing is calibrated against your About statement so the questions assume your stated experience level rather than over-explaining basics.

When you want to go beyond the briefing, the **chat** panel lets you ask follow-up questions about any concept, quiz result, or work signal. It has full read access to your concept graph, briefing history, and connected integrations — and it knows your About + Focus, so it speaks to you the way you've said you prefer.

Every teaching piece, deep dive, and chat reply has a **Listen** button that reads it aloud via TTS — Cloudflare Aura (12 voices), MeloTTS, OpenAI's `tts-1` / `tts-1-hd` (with `OPENAI_API_KEY`), and ElevenLabs multilingual / turbo / flash (with `ELEVENLABS_API_KEY`). A small voice picker beside each play button lets you switch voices on the fly — your last pick becomes the new default everywhere. All TTS spend lands in the same `usage_events` ledger as LLM tokens, under one monthly budget cap.

For input, every long-form textarea in Primer — quiz answers, the chat input, the **Set focus** editor (avatar menu), and the **About you** / **Current focus** textareas in Settings and the first-run onboarding wizard — has a **microphone** in continuous voice mode. Tap to start, talk freely (pauses are fine), tap again or wait 5 seconds of silence to stop, or hit **`Esc`** to stop the mic without closing the panel you're in. Live transcript appears as you speak; the textarea is read-only while listening so your typing doesn't fight the live transcript. Talking out your About / Focus is often easier than typing it.

## Pruning over time

Concepts you don't actually want to learn about can be **suppressed** with one click on the Concepts page. Suppressed concepts disappear from your trails, stop driving briefings, and are explicitly excluded from future extractions. If your concept graph becomes stale or no longer reflects who you are, **Settings → General → Account → Reset concepts** wipes it and lets the next briefing rebuild from scratch under your current Focus and About.

## Continuations and series

When a topic produces a follow-up piece, Primer chains the two into a **series** — Part 1 (retroactively), Part 2 (today's). The new piece opens with a callback to the prior part, and both pieces show a small "Part N of M" badge plus a previous/next navigation strip so you can move through the series without bouncing through the archive. When today's draft has nothing new vs. a recent piece, it's silently filtered as **redundant** and surfaced as a small "no new movement on these topics" chip in the briefing header — so you know the topic was considered, not forgotten. See [Continuations and series](/help/briefings/continuations-and-series) for the full read.

## Navigating your history

Two surfaces help you move through past briefings within your retention window (default 365 days):

- The **briefing page** has a Google-Photos-style auto-fading **scroll-timeline scrubber** along the right edge. Year markers, a live thumb tracking the visible date, and click + drag scrubbing that lazily loads pages as you go.
- The **archive page** is a **week-window calendar**. Step through ±1 week with arrows, jump to any week from a calendar popover, snap back to "this week" with one click. Both retention boundary and "no future weeks" are enforced visually.

Both surfaces share the same lightweight `/api/briefings/dates` endpoint so they always agree on what's reachable.
