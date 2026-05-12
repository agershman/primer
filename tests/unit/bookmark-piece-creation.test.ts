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
