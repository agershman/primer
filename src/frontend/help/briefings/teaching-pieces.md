---
title: "Teaching Pieces"
subtitle: "Types, depth calibration, and content format"
audiences: [user]
related:
  - concepts/depth-scale
  - briefings/deep-dives
---

Teaching pieces are the core unit of a Primer briefing. Each piece focuses on a single concept or a tightly scoped topic and is written at a depth calibrated to your current understanding **and** in a voice tuned to your **About you** statement (see [Configuration → About you](/help/reference/configuration)). The system never quotes your About statement back at you — it just calibrates tone, depth assumptions, and what to skip based on what you've said works for you.

## Piece Types

**60-second** — A concise summary you can read in under a minute. Covers one key idea with enough context to be useful. Best for concepts you're already familiar with or quick updates on things you know well.

**Walkthrough** — A guided explanation that walks through a concept step by step, often with examples. Typically 2–4 minutes of reading. Used when you have some awareness of a concept but need a clearer mental model.

**Deep-dive** — Extended coverage with nuance, tradeoffs, and multiple perspectives. Usually 4–7 minutes. Generated when you're ready to move from "understands" to "applies" on a concept.

## Depth Calibration

The depth of each piece is calibrated to your concept graph score:

- **Depth 0–1 (Unknown → Aware):** Basics — what it is, why it exists, when you'd encounter it. Analogies and simple examples.
- **Depth 2 (Understands):** Mechanics — how it works, key components, common patterns. Code examples where relevant.
- **Depth 3 (Applies):** Tradeoffs — when to use it vs. alternatives, failure modes, production gotchas. Real-world case studies.
- **Depth 4–5 (Teaches → Authoritative):** Contrarian takes — unconventional approaches, edge cases most people miss, architectural implications at scale. Challenges your assumptions.

## Content Format

Each piece includes:

- **Origin badge** — A colored pill that immediately tells you where this piece came from:
  - **From your work** (green) — driven by concepts extracted from your Linear issues, Slack threads, or incidents
  - **From feeds** (yellow) — driven by an external article from Hacker News, ArXiv, CNCF, AWS, or GCP feeds
  - **Refresher** (grey) — a decaying concept being recalibrated from disuse
- **Source provenance box** — Directly below the title, a compact card shows the specific sources that triggered this piece. For work-driven pieces you'll see the Linear ticket IDs and titles; for feed-driven pieces you'll see the article title and a link. This lets you immediately tell *why* a piece was presented and whether the system is pulling from the right places.
- **Due-date badge** — When a piece's source has a deadline (currently sourced from Linear `dueDate`; future signals will include incident.io postmortem next-due dates and SOC2 audit milestones), a small pill in the metadata row surfaces the time pressure at a glance. The pill's color tier maps to urgency:
  - **Overdue / Due today** — `text-negative bg-negative-dim`. Actionable now.
  - **Due tomorrow / Due in 2–3 days** — `text-warning bg-warning-dim`. Time-pressured.
  - **Due in 4–7 days** — `text-accent bg-accent-dim`. On the horizon.
  - **Due Apr 30** (further out) — calm `bg-bg-warm`. Visible but not screaming for attention.
  
  The badge label uses relative wording when the deadline is close (*Due today*, *Due tomorrow*, *Due in 3 days*) and falls back to a formatted date for further-out deadlines (*Due Apr 30*) so it stays compact. Hovering shows the underlying rationale (e.g. *"Linear ticket CIN-1234 is due 2026-04-30"*) so you can verify *why* the system thinks the piece is time-sensitive. Pieces with a due date sort to the top of the briefing in soonest-first order, with same-day ties broken alphanumerically by title — see [Briefings → How generation works](/help/briefings/how-generation-works) for the sort rules.
- **Series badge (`Part N of M`)** — When a piece is part of a multi-part series, a small accent pill next to the title shows its position. The first piece only gets labeled retroactively (when a Part 2 lands), so a piece that lived for weeks as a standalone can transition to **Part 1** the day a continuation arrives. Pieces in a series also show a subtle previous/next strip above the body so you can navigate the series without bouncing through the archive. On Part-2+ pieces in *today's* briefing, a tiny `new` pill flags the continuation; the next morning, only the regular badge remains. See [Continuations and series](/help/briefings/continuations-and-series) for the full read.
- **Structured content blocks** — Text and headings organized for scannability
- **Inline concept links** — Key terms link to their concept page, showing your current depth
- **Resource list** — Relevant Linear issues, Slack threads, documentation, and external articles
- **"Go deeper" button** — Expands into a deep-dive with visual aides if you want more
- **Model attribution + regeneration** — Each piece shows which model produced it (e.g. "Generated with Claude Sonnet 4"). Click **↻ try different model** to expand a selector and regenerate the same piece with any model from any configured provider — the picker groups options by provider via `<optgroup>` headers and only shows providers whose API key is set. Today that means Claude Haiku 4.5 / Sonnet 4 / Opus 4 (Anthropic) and GPT-5 nano / mini / full (OpenAI); future Gemini / Workers AI entries slot into the same picker once their adapters land. The piece updates in place and the model footer reflects the new model, so you can directly compare quality between models — even across providers — on the same topic. See [AI Models](/help/reference/ai-models) for details on each model tier and the provider-gating rules.
- **Listen** — Click **Listen** at the top of any article to hear it read aloud via text-to-speech. Audio is generated on demand and cached. Right next to the Listen button, a small **voice: <name> ↻** affordance lets you try a different voice on the spot — your pick becomes your new default for all future articles (and is reflected in **Settings → Intelligence → Voice**). Available voices: Cloudflare Workers AI (Deepgram Aura — 12 speakers including Asteria, Luna, Orion, Zeus; MeloTTS for budget), OpenAI TTS (`tts-1` and `tts-1-hd` with Alloy, Echo, Fable, Onyx, Nova, Shimmer — requires `OPENAI_API_KEY`), and ElevenLabs (multilingual / turbo / flash tiers — requires `ELEVENLABS_API_KEY`). Each option lists tier and price-per-1k-chars. Deep dives have their own audio button + voice picker. Long content is automatically chunked to handle API limits. Every TTS request — across all providers — writes a row to the unified `usage_events` ledger with character count, voice, and estimated cost, so audio spend rolls into the same monthly budget cap as LLM tokens.
  - **Audio outros.** After the article finishes, the audio appends a short closing line so playback doesn't end on an abrupt cut. For briefing pieces, it invites you to use **Go deeper** if you want more — and the wording adapts depending on whether the deep dive has already been generated for that piece (so you don't get told to "tap to generate" something that's already ready). For deep dive audio, it's a short *"Hope you found it helpful. Thanks for listening."* sign-off. The body is auto-trimmed if needed so the outro always plays in full.
- **Inline diagrams and code** — Teaching pieces and deep dives can include mermaid diagrams and code blocks inline within the content, placed right after the paragraph they illustrate. No separate "visuals" section — everything flows naturally within the text. Code blocks render with **syntax highlighting** (via Prism), a **line-number gutter**, a **copy button**, and an **independent light/dark toggle** in the header — flip a code block to dark while reading prose on a light page (or vice versa) and your choice persists across all code blocks on the page. The toggle cycles `auto → light → dark → auto`; `auto` follows the site theme.

  Inline code (single backticks) renders as a neutral pill (mono font, warm background, thin border) so it reads as a literal value distinct from links.

  **Reader-aware code routing.** The teaching-piece + deep-dive generators route their use of code on signals from your **About you** statement. Technical readers get inline `code` for command names, function names, and config keys, plus full code-block snippets where they earn their space — with the `language` tag set so the block syntax-highlights correctly. Non-technical readers (PMs, designers, ops, sales, leadership) get prose-first explanations, mermaid diagrams instead of code where possible, and code only when the source material genuinely contains it (e.g. a PR snippet you referenced) — always introduced with a one-line plain-English summary first. Update your About statement and the next briefing's pieces will recalibrate.
- **Verifiable citations** — Inline links point to specific, verifiable sources (documentation pages, blog posts, RFCs, GitHub repos) rather than company homepages or generic marketing pages. When Primer isn't sure about a claim, it qualifies it rather than asserting it as fact.
