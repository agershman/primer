---
title: "Chat"
subtitle: "Ask questions about your learning content"
audiences: [user]
related:
  - concepts/concept-graph
  - calibration/assessment
  - briefings/how-generation-works
---

The chat panel gives you a conversational interface for exploring your Primer data in depth. Instead of passively reading briefings, you can ask targeted questions about concepts, quiz results, and depth trends — and get answers grounded in your actual learning history.

## What Chat Can Help With

- **Dive deeper into concepts** — Ask why a concept's depth score changed, what prerequisites you're missing, or how two concepts relate in your graph.
- **Understand quiz gaps** — After a calibration quiz, ask the chat to break down where your answer fell short and what a stronger response would look like.
- **Analyze depth trends** — Ask about concepts that are decaying, stalling, or improving. The chat can surface patterns across your graph that aren't obvious from sparklines alone.
- **Cross-reference work signals** — Ask how recent Slack threads, incidents, or Linear issues connect to concepts you're learning.

## What Chat Can Access

The chat has read access to everything Primer knows about you:

- Your concept graph (depth scores, confidence, relations, history)
- All briefings and teaching pieces
- Quiz history and assessment results
- Work context from Linear, Slack, GitHub, and incident.io
- Near-miss data
- Your **About you** and **Current focus** statements — chat speaks to you in the voice and depth you've said you prefer, and is aware of what you're currently focused on
- Web search for external documentation and references

## What Chat Cannot Do

Chat is **strictly read-only**. It can look things up and reason about your data, but it will never:

- Create or modify Linear tickets
- Post messages in Slack
- Trigger workflows or deployments
- Write or execute code
- Answer general questions unrelated to your Primer data (it's scoped to your learning context, not a general-purpose assistant)

Think of it as a knowledgeable colleague who has read all your briefings and has your concept graph memorized — helpful for discussion, but not taking any action on your behalf.

## Streaming Responses

Chat responses stream progressively — you see text appear word by word as the model generates it, rather than waiting for the full response. A blinking cursor indicates the response is still in progress. Streaming works across every provider whose adapter is wired in: today both the Anthropic and OpenAI adapters re-emit the same normalized `StreamEvent` shape, so the chat UI is provider-agnostic and future Google / Workers AI / OpenRouter adapters slot in without UI changes.

When the chat uses tools (like searching the web or looking up Primer data), you'll see a brief indicator showing what it's doing. The response resumes streaming after the tool completes.

## Listening to replies

Every finished assistant message has a small **🔊 Listen** affordance underneath it. Tapping it expands an inline audio player and a voice picker right next to the bubble — same TTS pipeline you already use on teaching pieces and deep dives. Audio is generated on demand (we don't auto-fire TTS on every reply), and the picker is the same `voice: <name> ↻` control you'll see on articles, so changing voice in chat updates your default everywhere else. The chat-message audio endpoint strips markdown (fenced code blocks, links, headings, list markers) so the recognizer reads your reply as natural prose rather than spelling out punctuation.

User messages don't get a Listen button — you typed them, no need to hear them back.

## Talking to the chat (dictation)

The microphone button next to the chat input uses the same **voice mode** as the calibration quiz mic — one consistent interaction wherever you can talk to Primer:

- Tap the mic to start, speak freely (pauses are fine), tap again to send. Or just stop talking — the session auto-stops after **5 seconds of silence**. Pressing **`Esc`** while the mic is live stops it instantly without closing the chat panel; a second Escape closes the panel as usual.
- Your live transcript appears in the chat input as you speak. The input becomes read-only while listening so it doesn't fight the live transcript; you'll see a "● Listening — pause for 5 s or tap the mic to send." hint.
- Brief pauses don't end the session — Primer auto-restarts the recognizer beneath the surface so the perceived session stays continuous.

Once the mic stops (either auto-stop or tap-to-stop), the input becomes editable again, so you can clean up the transcript before pressing send.

## Model Selection

Click the model selector at the bottom-left of the input area to choose which model powers the chat. Options are grouped by provider with a small uppercase header per group — only providers whose API key is configured on the worker show up. The grouping mirrors the **Settings → Intelligence → AI models** picker so the picker reads identically across surfaces.

**Anthropic** (when `ANTHROPIC_API_KEY` is set):

- **Claude Haiku 4.5** — Fast responses, good for quick questions
- **Claude Sonnet 4** — Balanced quality and speed (default)
- **Claude Opus 4** — Highest quality, slower, best for nuanced analysis

**OpenAI** (when `OPENAI_API_KEY` is set):

- **GPT-5 nano** — Fastest, cheapest. Good for quick lookups.
- **GPT-5 mini** — Balanced.
- **GPT-5** — Highest-quality OpenAI option for nuanced analysis.

Additional providers (Google, Workers AI, OpenRouter) appear in their own group as soon as their adapter and API key land on the worker — see [AI Models → Picker behavior](/help/reference/ai-models) for the gating rules.

Your model selection persists for the session. You can also set a default in **Settings → AI Models → Chat**.

## Thread Management

Conversations are organized into threads. Each thread is saved automatically and persists across sessions, so you can pick up where you left off.

- **Automatic summarization** — Threads older than 30 days are automatically compacted into a summary. You can still see the summary, but individual messages are replaced to save storage.
- **Automatic cleanup** — Threads older than 90 days are deleted entirely.
- **Thread switching** — Click the thread title in the chat header to open the thread picker. You can switch between recent conversations or start a new one.

## Calibration Integrity

When you have pending calibration quizzes, the chat will not help you answer them. If you ask the chat about a concept you're being quizzed on, it will politely decline and explain why:

Calibration only works when it measures what you genuinely know. If the chat gave you the answer, your depth score would be inflated and your future briefings would be targeted at the wrong level — too advanced, skipping material you actually need. It's always better to say "I don't know" than to get a score you didn't earn.

After you submit your answer, the chat is happy to discuss the concept in depth and help you fill any gaps the assessment identifies.

## How to Use

1. Click the chat button in the bottom-right corner of any page.
2. Type your question and press Enter (or click the send button).
3. The chat will respond with streaming text based on your Primer data and the page you're currently viewing.
4. Use Shift+Enter for multi-line messages.
5. Switch threads via the dropdown in the chat header.
6. Press Escape to close the chat panel.
