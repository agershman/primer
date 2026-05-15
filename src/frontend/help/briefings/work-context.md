---
title: "Work Context Transparency"
subtitle: "What sources were consulted for your briefing"
audiences: [user]
related:
  - briefings/how-generation-works
  - reference/configuration
---

Every briefing includes a transparency bar that shows exactly what work signals Primer consulted during generation. This helps you understand why certain topics appeared and verify that the right sources are being scanned.

## The Work Context Bar

At the top of each briefing, a collapsed bar summarizes the source types and counts. Expanding it reveals the full list:

- **Linear issues** — Issues you're assigned to, have commented on, or are watching. Shown with issue identifier and title.
- **Slack threads** — Conversations from mapped channels, with full thread replies fetched for substantive discussions. Primer analyzes multi-message threads to identify topics, questions raised, knowledge gaps, and specific learning opportunities — not just raw message text. Shown with channel name and an AI-generated summary. Slack emoji shortcodes (like `:wave:`) are converted to native emoji in the display.

  Slack threads also pass through a **relevance filter** before they reach the work-context bar: a batched Haiku scoring call rates each non-bookmarked thread 0.0–1.0 against your **About + Focus + Relevance filter prompt** and drops anything below your `relevanceThreshold` (default 0.4). This catches substantive-looking but off-topic lines the length/pattern heuristics miss — banter, name jokes, personal logistics. Bookmarked threads (`:bookmark:` reaction → 🔖 prefix) bypass the filter entirely. See [How generation works → Step 1a](/help/briefings/how-generation-works) for the full pipeline shape.

  **Where the `:bookmark:` reaction is placed decides the scope** of what Primer pulls in:
  - React `:bookmark:` to a **thread root** — the whole thread is in scope. Primer fetches the replies, runs the conversation analyzer over the full transcript, and generates a teaching piece anchored on the thread's substance.
  - React `:bookmark:` to **a single reply** (or to a standalone message) — only that message is in scope. The work-context item is scoped down to the bookmarked text; the surrounding thread is not pulled in. The teaching piece anchors on just the message you flagged.
  - React `:bookmark:` to the **thread root and also to specific replies within it** — the whole thread is in scope, AND the bookmarked replies are surfaced to the writer as an emphasized excerpt. The teaching piece treats the thread as the context but anchors its concept selection and framing on the messages you specifically boosted.
- **GitHub PRs** — Pull requests you're reviewing, assigned to, have commented on, or that your team has been tagged on. Configurable in Settings. Shown with PR title and repo name.
- **Incidents** — Open or recently resolved incidents from incident.io. Shown with severity and title.
- **External sources** — Articles and posts from configured feeds (Hacker News, CNCF, AWS, etc.) that matched your concept graph.

## Source Counts

Each source type shows a count — for example, "Linear: 12 issues, Slack: 8 threads, Incidents: 2." This gives you a quick sense of how much work context was available. If counts are unusually low, it might indicate a configuration issue with API tokens or channel mappings.

## Why This Matters

Transparency in sourcing is a core Primer principle. If a teaching piece feels off-target, the work context bar lets you trace back to what triggered it. You can see whether the piece was driven by a Linear issue you're actively working on, a Slack conversation you were tangentially part of, or an external article that happened to match your concept graph.

## Previewing Before Generation

The work context bar shows what was consulted *after* a briefing ran. If you want to see what *will* be in scope for your next briefing before you trigger it, open **Settings** and click **Build full briefing preview** in the footer. Each source's panel (Linear, Slack, GitHub, incident.io, Feeds) then shows its own "In scope" subsection with the items the generator would pull in — useful for tuning filters (issue status, teams, time window, channel selection, feeds) without having to generate a full briefing to verify. See [Configuration → Preview](/help/reference/configuration) for the full behavior.
