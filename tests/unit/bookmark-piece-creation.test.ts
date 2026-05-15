/**
 * Tests for the end-to-end bookmark → piece flow. The user-facing
 * promise is "react `:bookmark:` to a Slack message and a teaching
 * piece will be created from it on the next briefing run." This file
 * pins the wiring across the three pipeline stages that promise
 * depends on:
 *
 *   1. `WorkContextItem.bookmarked` is a first-class field — not a
 *      title-prefix hack — so every downstream stage can read it.
 *   2. The concept extractor receives an explicit `[USER-BOOKMARKED]`
 *      annotation and an instruction in its system prompt to extract
 *      at least one concept from each such item, even when the
 *      substance bar would otherwise reject it.
 *   3. The briefing-generator's teaching-target selector has a P1
 *      tier above `current-work` (P2) that turns each bookmarked
 *      work item into a candidate, bypassing the depth filter and
 *      the NO_REPEAT_WITHIN_DAYS recent-concept filter so the piece
 *      gets generated reliably.
 *
 * Implemented as source-text contracts to keep the assertions
 * self-evident — the briefing-generator is a single 1k-line orchestrator
 * and unit-testing every branch around it is out of scope here.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("WorkContextItem carries a `bookmarked` field", () => {
  it("declares `bookmarked?: boolean` on the canonical WorkContextItem type", async () => {
    const src = await read("src/worker/sources/types.ts");
    expect(src).toMatch(/bookmarked\?:\s*boolean/);
  });

  it("concept-extractor's local WorkContextItem mirrors the field", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toMatch(/bookmarked\?:\s*boolean/);
  });
});

describe("Bookmarked-within-thread emphasis — bookmarkedExcerpts field", () => {
  // When a thread is in scope because of a `:bookmark:` reaction AND
  // individual messages within the thread are also bookmarked, those
  // specifically-bookmarked excerpts get propagated all the way to the
  // teaching-piece writer so the resulting piece anchors on what the
  // reader actually flagged — not on the surrounding chatter. The
  // contract spans four files; pin each link in the chain so a future
  // refactor that drops the field anywhere in the pipeline trips here.

  it("WorkContextItem declares the field as a first-class signal", async () => {
    const src = await read("src/worker/sources/types.ts");
    expect(src).toMatch(/bookmarkedExcerpts\?:\s*string\[\]/);
  });

  it("Slack source collects bookmarked-message texts during grouping", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // The grouping accumulator tracks the excerpts and is written
    // on every bookmarked message (root or reply) it sees.
    expect(src).toContain("bookmarkedExcerpts");
    expect(src).toMatch(/bookmarkedExcerpts\.push\(msg\.text\)/);
  });

  it("Slack source picks up in-thread reply bookmarks via the reply-fetch path", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // The pre-reply scan (channel history + reactions.list) sees the
    // root + any messages someone reacted to with reactions.list, but
    // doesn't surface in-thread reply bookmarks from teammates. The
    // reply-fetch path normalizes every reply once up front (tagging
    // each with `bookmarked`) and then filters slice(1) for the
    // bookmarked replies.
    expect(src).toMatch(/normalized\s*[\s\S]*?\.slice\(1\)[\s\S]*?\.filter\(\(r\)\s*=>\s*r\.bookmarked\)/);
    expect(src).toMatch(/bookmarked:\s*hasBookmarkReaction\(r\)/);
  });

  it("Slack source promotes to whole-thread scope when the reply-fetch reveals a root bookmark", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // normalized[0] is the thread root; if it carries a bookmark we
    // didn't see in the initial scan (e.g. the thread came in via a
    // cross-channel scan of just a reply), we promote rootBookmarked
    // so the work-context item widens back to the whole thread.
    expect(src).toMatch(/root\?\.bookmarked/);
    expect(src).toMatch(/base\.rootBookmarked\s*=\s*true/);
  });
});

describe("Bookmark scope — root vs reply-only", () => {
  // The user-facing model:
  //   - Bookmark a thread root           → whole thread is the unit.
  //   - Bookmark just a reply (or a       → ONLY that message is the
  //     standalone message)                 unit; don't pull in the rest.
  //   - Bookmark root + replies          → whole thread, replies boosted.
  // Pin the slack-source behavior that implements this scope rule.

  it("SlackThread tracks rootBookmarked separately from bookmarked", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toMatch(/rootBookmarked\?:\s*boolean/);
  });

  it("groupAndFilterSlackMessages detects root vs reply via thread_ts", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // A message is the root when `thread_ts` is unset OR equals its
    // own `ts`. Anything else is a reply.
    expect(src).toMatch(/isRoot\s*=\s*\(msg\.thread_ts\s*\?\?\s*msg\.ts\)\s*===\s*msg\.ts/);
  });

  it("slackProvider scopes the work-context item to bookmarked excerpts only when rootBookmarked is false", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // The reply-fetch branch widens the item only when rootBookmarked
    // OR not bookmarked at all. Reply-only bookmarks narrow the item
    // to JUST the bookmarked messages, with the first excerpt as the
    // title so the work-context bar reads as the message, not the
    // (unrelated) root.
    expect(src).toMatch(/base\.rootBookmarked\s*\|\|\s*!base\.bookmarked/);
    expect(src).toMatch(/base\.title\s*=\s*base\.bookmarkedExcerpts\[0\]\.slice\(0,\s*120\)/);
  });
});

describe("groupAndFilterSlackMessages — rootBookmarked detection", () => {
  it("sets rootBookmarked when the bookmark is on the thread root (no thread_ts)", async () => {
    const { groupAndFilterSlackMessages } = await import("../../src/worker/sources/slack");
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Root: should we migrate the index off Postgres? Here's my thinking…",
          ts: "1.0",
          user: "U1",
          // No thread_ts → root of a standalone thread.
          reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
    expect(result[0].rootBookmarked).toBe(true);
  });

  it("leaves rootBookmarked unset when only a reply carries the bookmark", async () => {
    const { groupAndFilterSlackMessages } = await import("../../src/worker/sources/slack");
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Substantive root message about migrating off Postgres for search performance reasons.",
          ts: "1.0",
          user: "U1",
        },
        {
          text: "Specifically I'm thinking about logical replication semantics in this case.",
          ts: "2.0",
          user: "U2",
          thread_ts: "1.0",
          reactions: [{ name: "bookmark", count: 1, users: ["U3"] }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
    // The bookmark sits on the reply only — the thread root isn't
    // bookmarked, so rootBookmarked should be falsy.
    expect(result[0].rootBookmarked).toBeFalsy();
    expect(result[0].bookmarkedExcerpts).toEqual(["Specifically I'm thinking about logical replication semantics in this case."]);
  });

  it("sets rootBookmarked when both the root and a reply are bookmarked", async () => {
    const { groupAndFilterSlackMessages } = await import("../../src/worker/sources/slack");
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Root: should we migrate the index off Postgres? Here's my thinking…",
          ts: "1.0",
          user: "U1",
          reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
        },
        {
          text: "Specifically — logical replication semantics matter here.",
          ts: "2.0",
          user: "U2",
          thread_ts: "1.0",
          reactions: [{ name: "bookmark", count: 1, users: ["U3"] }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
    expect(result[0].rootBookmarked).toBe(true);
    // Both messages contribute to excerpts so the in-thread reply
    // bookmark still boosts that specific message in the LLM prompt.
    expect(result[0].bookmarkedExcerpts).toHaveLength(2);
  });

  it("Slack source emits the field on the resulting WorkContextItem", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toMatch(/bookmarkedExcerpts:\s*thread\.bookmarkedExcerpts/);
  });

  it("slack-analyzer forwards the field into the prompt with an [EMPHASIS] block", async () => {
    const src = await read("src/worker/services/slack-analyzer.ts");
    // AnalyzerInput accepts the field, and the per-thread prompt
    // block surfaces it under a clearly-labeled sentinel the system
    // prompt knows to weight more heavily.
    expect(src).toMatch(/bookmarkedExcerpts\?:\s*string\[\]/);
    expect(src).toContain("[EMPHASIS — BOOKMARKED MESSAGES]");
    // The system prompt section that tells the model how to use the
    // emphasis sentinel — without this the block is decorative.
    expect(src).toMatch(/EMPHASIS\s*—\s*when\s+a\s+thread\s+block\s+begins/i);
  });

  it("concept-extractor mirrors the field and renders an [EMPHASIZED EXCERPTS] block", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toMatch(/bookmarkedExcerpts\?:\s*string\[\]/);
    expect(src).toContain("[EMPHASIZED EXCERPTS");
    // System prompt directs the extractor to anchor on the excerpts
    // when they're present.
    expect(src).toMatch(/EMPHASIZED EXCERPTS/);
    expect(src).toMatch(/Anchor your extracted concept/i);
  });

  it("briefing-generator's P1 bookmark tier injects an [EMPHASIS] block into sourceDescription", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The bookmark tier builds an emphasized block when the work item
    // carries bookmarkedExcerpts, and passes it as the writer's
    // sourceDescription so the teaching piece anchors on the
    // flagged excerpts rather than the generic thread digest.
    expect(src).toMatch(/item\.bookmarkedExcerpts\s*&&\s*item\.bookmarkedExcerpts\.length\s*>\s*0/);
    expect(src).toMatch(/EMPHASIS\s*—\s*messages within this thread the reader explicitly bookmarked/);
    // Concept-match haystack includes the excerpts so a thread whose
    // emphasized messages call out a different concept than the
    // title still anchors against the user's pick.
    expect(src).toMatch(/\(item\.bookmarkedExcerpts\s*\?\?\s*\[\]\)\.join/);
  });
});

describe("groupAndFilterSlackMessages — bookmarkedExcerpts behavior", () => {
  it("captures root-bookmark text as an excerpt", async () => {
    const { groupAndFilterSlackMessages } = await import("../../src/worker/sources/slack");
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Read https://example.com/blog/karpenter-consolidation for the consolidation story",
          ts: "1.0",
          user: "U1",
          reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
    expect(result[0].bookmarkedExcerpts).toBeDefined();
    expect(result[0].bookmarkedExcerpts).toHaveLength(1);
    expect(result[0].bookmarkedExcerpts?.[0]).toContain("karpenter-consolidation");
  });

  it("captures reply-bookmark text as an excerpt alongside the root (when both are bookmarked)", async () => {
    const { groupAndFilterSlackMessages } = await import("../../src/worker/sources/slack");
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Thread root — debating database choice",
          ts: "1.0",
          user: "U1",
          reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
        },
        {
          text: "Specifically: postgres logical replication has weird semantics here",
          ts: "2.0",
          user: "U2",
          thread_ts: "1.0",
          reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
    expect(result[0].bookmarkedExcerpts).toBeDefined();
    expect(result[0].bookmarkedExcerpts).toHaveLength(2);
    expect(result[0].bookmarkedExcerpts?.[0]).toContain("Thread root");
    expect(result[0].bookmarkedExcerpts?.[1]).toContain("postgres logical replication");
  });

  it("leaves the field undefined when no message carries a bookmark", async () => {
    const { groupAndFilterSlackMessages } = await import("../../src/worker/sources/slack");
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Hey team, we should think about migrating off of Postgres for the search index — performance has been suffering lately.",
          ts: "1.0",
          user: "U1",
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarkedExcerpts).toBeUndefined();
  });
});

describe("concept-extractor surfaces bookmarks to the LLM", () => {
  it("annotates bookmarked items with the [USER-BOOKMARKED] sentinel in formatBatch", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("[USER-BOOKMARKED]");
    expect(src).toMatch(/item\.bookmarked\s*\?\s*"\s*\[USER-BOOKMARKED\]"/);
  });

  it("system prompt instructs the model to emit at least one concept per bookmarked item", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toMatch(/USER-BOOKMARKED ITEMS/);
    // Directive language — "MUST emit at least one concept" is the
    // load-bearing instruction. If this softens to "may" or
    // "consider", bookmarks lose their guaranteed extraction.
    // `\s+` between words tolerates the prompt being wrapped across
    // source lines without weakening the assertion.
    expect(src).toMatch(/MUST\s+emit\s+at\s+least\s+one\s+concept/i);
  });
});

describe("briefing-generator's P1 bookmark tier", () => {
  it("filters workContext for bookmarked items as a dedicated candidate tier", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/workContext\.filter\(\(i\)\s*=>\s*i\.bookmarked\)/);
  });

  it("assigns priority 1 to bookmark-tier candidates (above current-work P2)", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The bookmark tier appears textually before the P2 active-work
    // loop so the candidate ordering is unambiguous.
    const bookmarkIdx = src.indexOf("workContext.filter((i) => i.bookmarked)");
    const activeWorkIdx = src.indexOf("const activeWorkConcepts = activeConcepts");
    expect(bookmarkIdx).toBeGreaterThan(0);
    expect(activeWorkIdx).toBeGreaterThan(bookmarkIdx);
    // The bookmark block pushes candidates with priority: 1.
    const between = src.slice(bookmarkIdx, activeWorkIdx);
    expect(between).toMatch(/priority:\s*1/);
  });

  it("excludes concepts already claimed by the bookmark tier from the P2 current-work tier", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/bookmarkConceptIds\.has\(c\.id\)/);
  });

  it("bookmark candidates have sourceType current-work so they satisfy the min-current-work invariant", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The bookmark block lives between the "P1 (bookmark)" marker and
    // the next "P2" / "active work" block. Anchor the search there.
    const startMarker = "P1 (bookmark)";
    const endMarker = "Low-depth concepts from active work";
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf(endMarker);
    expect(startIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = src.slice(startIdx, endIdx);
    // Both the matched-concept push and the fallback push set
    // `sourceType: "current-work"` so the fallback covering the
    // "must include one current-work piece" invariant doesn't kick in.
    const currentWorkCount = (block.match(/sourceType:\s*"current-work"/g) ?? []).length;
    expect(currentWorkCount).toBeGreaterThanOrEqual(2);
  });

  it("bypasses the depth filter AND the NO_REPEAT_WITHIN_DAYS recent-concept filter for bookmark candidates", async () => {
    // The P2 tier filters concepts by `!recentSet.has(c.id)` and
    // `depth_score ?? 0) < 3`. The bookmark tier deliberately does
    // NOT apply either filter — pin that by checking the bookmark
    // block doesn't reference `recentSet` and doesn't apply the same
    // `depth_score < 3` predicate. Strip comments first so the
    // descriptive prose (which references the bypassed filters) can't
    // produce false positives.
    const src = await read("src/worker/services/briefing-generator.ts");
    const startIdx = src.indexOf("P1 (bookmark)");
    const endIdx = src.indexOf("Low-depth concepts from active work");
    const blockWithComments = src.slice(startIdx, endIdx);
    const block = stripLineComments(blockWithComments);
    expect(block).not.toMatch(/recentSet\.has/);
    expect(block).not.toMatch(/depth_score\s*\?\?\s*0\)\s*<\s*3/);
  });
});

function stripLineComments(src: string): string {
  // Remove `// ...` to EOL on each line. Good enough for these
  // assertions — we don't have to handle block comments or strings
  // because the bookmark tier doesn't use either.
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}
