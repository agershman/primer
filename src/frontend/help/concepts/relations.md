---
title: "Concept Relations"
subtitle: "Prerequisites and learning sequences"
audiences: [user]
related:
  - concepts/concept-graph
---

Concepts in your graph aren't isolated — they're connected by relationships that Primer uses to determine teaching order and content depth.

## Relation Types

### prerequisite-of
Concept A is a prerequisite of Concept B. You should understand A before diving deep into B. Primer uses this to avoid teaching advanced topics before you have the foundational knowledge.

*Example: "TCP/IP networking" is prerequisite-of "Kubernetes Service networking." Primer won't generate a deep-dive on kube-proxy until you're at least depth 2 on basic networking.*

### leads-to
Concept A naturally leads to Concept B in a learning progression. Unlike prerequisites, this isn't a hard dependency — you can learn B without A — but the progression is smoother if you learn them in order.

*Example: "Docker containers" leads-to "Kubernetes pods." Understanding containers first makes pod concepts click faster, even though you could technically learn about pods directly.*

### adjacent-to
Concepts A and B are related but without a directional learning order. They share context and are often encountered together.

*Example: "Prometheus" is adjacent-to "Grafana." Neither is a prerequisite of the other, but knowing one makes learning the other easier.*

## How Primer Uses Relations

**Teaching order** — When a briefing has multiple teaching pieces, Primer sequences them so prerequisites come first. You won't see a piece on advanced topic B before the piece on foundational topic A, even if B scored higher on relevance.

**Depth gating** — Primer won't target a concept for deep teaching (depth 3+ content) if its prerequisites are below depth 2. Instead, it focuses on bringing the prerequisites up first.

**Adjacent learning** — When scanning external sources, Primer looks for content related to concepts that are adjacent to your active ones. This is how serendipitous discoveries surface — through graph adjacency rather than random chance.

## Automatic Discovery

Relations are discovered automatically during concept extraction. When Primer sees two concepts frequently co-occurring in the same context (e.g., the same Linear issue or Slack thread), it infers a relationship. The relation type is determined by analyzing how the concepts are discussed — if one is clearly foundational to the other, it's marked as prerequisite; otherwise, it's adjacent.
