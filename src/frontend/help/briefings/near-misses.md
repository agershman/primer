---
title: "Near Misses"
subtitle: "Items below the relevance threshold"
audiences: [user]
related:
  - briefings/how-generation-works
  - reference/configuration
---

Not every signal from your work context makes it into the briefing. Items that score close to — but below — the relevance threshold are captured as **near misses** rather than being silently discarded.

## What Qualifies as a Near Miss

During briefing generation, each candidate teaching topic is scored for relevance on a 0–1 scale. The default thresholds are:

- **≥ 0.4** — Included in the briefing as a teaching piece
- **0.25–0.39** — Captured as a near miss
- **< 0.25** — Discarded (too tangential to be useful)

Both thresholds are configurable via `RELEVANCE_THRESHOLD` and `NEAR_MISS_FLOOR` in `wrangler.api.toml`'s `[vars]` block (the API worker config, not the Pages-only root `wrangler.toml`).

## Viewing Near Misses

Near misses appear in a collapsed section at the bottom of each briefing. Expand it to see:

- **Title** — What the candidate topic was
- **Source** — Where it came from (Linear issue, Slack thread, external article, etc.)
- **Relevance score** — How close it was to the threshold
- **Exclusion reason** — Why it didn't make the cut (e.g., "below relevance threshold", "concept already covered at higher relevance")

## The Serendipity Layer

Near misses serve as a serendipity layer. Sometimes the most valuable thing you learn in a day is something that wasn't obviously relevant. By showing you what almost made it in, Primer lets you self-select into topics the algorithm would have skipped. If you find yourself repeatedly clicking into near misses from a particular domain, that's a signal your concept graph may need updating.

## Retention

Near misses are retained for 30 days by default (configurable via `NEAR_MISS_RETENTION_DAYS`), after which they're cleaned up by the Sunday maintenance job. Briefing teaching pieces follow the standard retention period.
