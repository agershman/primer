---
title: "Concept Graph"
subtitle: "How concepts are tracked and extracted"
audiences: [user]
related:
  - concepts/depth-scale
  - concepts/relations
---

Your concept graph is Primer's model of your technical knowledge. It's a directed graph where nodes are concepts (like "Terraform state locking" or "gRPC streaming") and edges represent relationships between them (like prerequisites or natural learning progressions).

## Automatic Extraction

Concepts are extracted automatically from your work signals every time a briefing is generated. The extraction process:

1. **Text analysis** — Linear issue descriptions, Slack messages, and incident summaries are analyzed to identify technical terms and themes.
2. **Substance bar** — A concept must be teachable as standalone subject matter. Meeting types (standup, retro), ritual roles (retro lead, on-call rotation), cadence labels (weekly check-in, OKRs as a rote noun), team names, internal initiatives, and generic verbs ("review", "implementation") are explicitly excluded. The bar is "could an experienced practitioner write a short article about this that another engineer would benefit from reading?"
3. **Umbrella rule** — Close variants are collapsed into a single canonical concept with the variants as aliases. "Schema migration", "online migration", and "database migration" become one concept (`database migrations`) rather than three.
4. **Normalization** — Raw terms are mapped to canonical concept names. "K8s", "Kubernetes", and "k8s cluster" all resolve to "Kubernetes."
5. **Categorization** — Each concept is assigned a category (infrastructure, security, platform, observability, framework, tool, methodology, etc.) based on the context in which it appears.
6. **Deduplication** — If a concept already exists in your graph, it's linked rather than duplicated. The exposure count increments, and the last-exposed timestamp updates.

## About + Focus

Two complementary user-context signals feed into Primer's AI:

- **About you** (Settings → About you) — *who* you are. A stable persona statement: role, experience level, communication preferences, learning style, what excites you. Influences voice, depth, and audience-modeling across **all** user-facing AI generation: teaching pieces, deep dives, chat, quiz framing, and relevance scoring. Versioned with history.
- **Current focus** (Settings → Current focus) — *what* you want to learn right now. Drives concept extraction: biases the system toward concepts intersecting your focus and filters out technically valid concepts that are clearly outside your interests. Versioned with history and per-version analytics (suppression rate, category mix).

Both fields have a **✨ Refine with AI** button that asks Claude to rewrite your draft into a tight, prompt-ready paragraph. You see the original alongside the refined version with a one-line rationale, and choose to accept or keep yours.

Focus statements are **versioned**. Every time you save, a new version is created. The history modal (Settings → Focus → View history) shows:

- The full text of every version with a timestamp
- An inline diff vs the previous version
- Per-version analytics: number of concepts created, briefings generated, teaching pieces produced, category distribution, and a **suppression rate** (% of concepts you later marked as "not interested"). A high suppression rate is a signal that the focus statement isn't filtering well — refine it.

You can restore an old version (creates a new version, preserves history) or delete historical versions you don't want kept.

## Suppression — "Not interested"

Each concept row has a small `✕` button. Clicking it marks the concept as suppressed: it's hidden from your trails, excluded from the briefing pipeline, and the canonical name is fed to the extraction prompt as "do not re-extract" so future briefings respect your judgment.

Use the **Show suppressed** toggle on the Concepts page to view and unsuppress entries. Suppression is per-user and reversible.

## Reset

If you want to start fresh — for example after writing your first focus statement, or after a major shift in your role — **Settings → General → Account → Reset concepts** wipes your concept graph (concepts, depth scores, calibration history, exposure counts). Past briefings and teaching pieces are preserved as an audit trail. The next briefing rebuilds the graph from scratch under the current focus statement and the new extraction rules.

## Alias Management

Many concepts go by multiple names. Primer maintains an alias list for each concept. When new terms are extracted that resolve to an existing concept, they're added as aliases. This prevents fragmentation — you won't end up with separate graph nodes for "CI/CD" and "continuous integration."

## Artifact Linking

Each concept tracks which briefing pieces, quizzes, and resources have referenced it. This creates a browsable history: you can go to any concept page and see every teaching piece that covered it, every quiz that tested it, and every resource that was linked to it. Artifacts are listed chronologically, giving you a learning timeline for each concept.

## Learning Trails

The default view on the Concepts page groups your concepts into **Learning Trails** by category — Infrastructure, Security, Observability, Platform, Framework, Tool, etc. Each trail shows:

- A summary header with concept count, average depth, and a depth distribution bar
- Counts of stale or low-depth concepts when collapsed
- Concepts within the trail sorted by depth (lowest first) so gaps are at the top

Trails are ordered by activity — the trail with the most recently exposed concepts appears first, keeping your current work area at the top. You can collapse/expand any trail by clicking its header.

A **Trails / All** toggle at the top lets you switch between the grouped view and a flat list of all concepts sorted by depth, name, or exposure.

When a trail has 3+ concepts below depth 2, a calibration prompt appears suggesting you calibrate that area.

## Graph Growth

Your graph grows organically as you work. A typical user might start with 20–30 concepts after the cold-start flow and accumulate 100+ within a few weeks of daily briefings. The graph doesn't grow without bound — concepts that are never re-encountered eventually decay and may be flagged for cleanup during the Sunday maintenance job.
