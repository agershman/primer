---
title: "Deep Dives"
subtitle: "Extended instructional content generated on demand"
audiences: [user]
related:
  - briefings/teaching-pieces
  - reference/ai-models
  - reference/notifications
---

Deep dives are extended versions of teaching pieces that go significantly deeper into a topic. Every teaching piece has a **Go deeper** button — deep dives are generated on demand when you click it.

## How It Works

1. Click **Go deeper** on any teaching piece.
2. A progress panel appears showing what Primer is doing:
   - Analyzing the teaching piece and your concept depth
   - Researching extended examples and case studies
   - Writing the deep dive (800–1,500 words)
   - Generating resource links and visual aide suggestions
   - Finalizing
3. A live elapsed-time counter and a segmented progress bar let you track generation.
4. Once generated, the content is cached — revisiting the same deep dive loads instantly.

Generation typically takes 15–30 seconds depending on the model. The deep dive uses your configured **Deep dives** model from Settings → AI Models (default: Claude Sonnet 4).

### Navigate away while it's generating

Deep-dive generation runs server-side via Cloudflare's `ctx.waitUntil`, so you can leave the page mid-generation and the work continues. A **notification spawns in the bell** the moment you click "Go deeper":

- An accent dot pulses on the bell while generation is in flight.
- When the deep dive is ready, the bell shows an unread badge and the notification flips to a clickable row with the piece title.
- Clicking the row jumps you straight to the deep dive (which is now cached, so it loads instantly).
- If something goes wrong (network blip, model timeout, etc.), the row carries a `failed` status and a short error message; click × to dismiss and click "Go deeper" again to retry.

See [Notifications](/help/reference/notifications) for the full lifecycle.

## Content Format

Deep dives are substantially longer than regular teaching pieces — typically 800–1,500 words — and structured for deep comprehension:

- **Extended narrative** with detailed explanations, step-by-step walkthroughs, and multiple examples
- **Tradeoff analysis** comparing approaches with explicit pros and cons
- **Production context** describing how the concept applies in real systems

Deep dive voice and depth assumptions are calibrated to your **About you** statement. If you've said you're a senior practitioner who prefers concrete examples and trade-off discussions over exhaustive overviews, the deep dive will skip introductory definitions and lean into the substance. The system never quotes your About statement back at you.

## Visual Aides

Deep dives can include visual elements to aid understanding:

- **Mermaid diagrams** — Architecture diagrams, sequence flows, and state machines
- **Code examples** — Longer, annotated code blocks showing real-world usage
- **Tables** — Comparison matrices for evaluating options or configurations

## Resource Links

Deep dives include an expanded resource list beyond what the briefing piece shows, often including documentation links, related PRs, and external articles. Resources marked as "deep-dive only" appear exclusively in this view.

## Regenerating a Piece Before Deep Diving

If you regenerate a teaching piece with a different model (via the **↻ try different model** link in the piece footer), any cached deep dive is cleared. The next "Go deeper" click will generate a fresh deep dive based on the new content.

## Stuck Generation

If a deep dive appears to hang (the loading spinner runs for more than 2 minutes without content appearing), Primer automatically detects the stuck state and resets it. On your next "Go deeper" click, generation starts fresh. This can happen if an API call times out during generation — the retry is automatic.

## Listen + voice picker

Every deep dive has a **Listen** button next to the title. Audio is generated on demand and cached. A small **voice: \<name\> ↻** affordance beside the play button lets you switch to any of the 12 Cloudflare Aura voices, MeloTTS, OpenAI's 9 voices (`tts-1` and `tts-1-hd` × Alloy / Echo / Fable / Onyx / Nova / Shimmer — requires `OPENAI_API_KEY`), or ElevenLabs' multilingual / turbo / flash voices (requires `ELEVENLABS_API_KEY`). Picking a new voice updates your user-level default, so all future articles use it until you change again. Every TTS call lands in the unified `usage_events` ledger so audio spend stacks alongside LLM tokens under the monthly budget cap.

After the body finishes, the audio appends a short *"Hope you found it helpful. Thanks for listening."* sign-off so playback doesn't end on an abrupt cut. The body is auto-trimmed if needed so the closing always plays in full, even on the longest deep dives.
