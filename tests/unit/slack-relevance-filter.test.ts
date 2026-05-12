/**
 * Tests for `filterSlackByRelevance` — the LLM-backed Slack pre-filter
 * that drops banter and off-topic chatter before it reaches concept
 * extraction or the work-context bar.
 *
 * Coverage:
 *   1. Empty / no-Slack input — early return, no LLM call.
 *   2. Bookmarked threads (`item.bookmarked === true`) bypass scoring
 *      entirely — even a near-zero score keeps them.
 *   3. Threshold gate — items at or above threshold pass; below drop;
 *      uses the supplied threshold (defaults to 0.4).
 *   4. Unscored items default to "kept" (per-item fail-open) so a
 *      partial response from the model can't silently delete threads
 *      it forgot to mention.
 *   5. LLM failure → fail-open: input passes through unchanged with
 *      `failedOpen: true`.
 *   6. Non-Slack items (Linear / incident / GitHub) pass through
 *      untouched — the filter is scoped to `slack_thread`.
 *   7. Source-text contracts on the briefing-generator integration
 *      (pipeline step exists, wired to `filterSlackByRelevance`,
 *      mutates `workContext` in place, records timing).
 *   8. Source-text contracts on the step-list updates across the
 *      analytics route + the three frontend step lists.
 */

import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { filterSlackByRelevance } from "../../src/worker/services/slack-relevance-filter.js";
import type { LLMClient } from "../../src/worker/integrations/llm/types.js";
import type { WorkContextItem } from "../../src/worker/sources/index.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

function fakeDB(): D1Database {
  // `recordTokenUsage` runs against this; the call uses prepare/bind/run.
  const noop = {
    bind() {
      return this;
    },
    async run() {
      return { success: true };
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] };
    },
  };
  return {
    prepare() {
      return noop;
    },
  } as unknown as D1Database;
}

function slackThread(
  id: string,
  title: string,
  description = "",
  bookmarked = false,
): WorkContextItem {
  return {
    type: "slack_thread",
    id,
    title,
    url: `https://slack.example.com/archives/X/p${id}`,
    description,
    ...(bookmarked ? { bookmarked: true } : {}),
  };
}

function linearIssue(id: string, title: string): WorkContextItem {
  return {
    type: "linear_issue",
    id,
    title,
    url: `https://linear.app/x/issue/${id}`,
    description: "",
  };
}

interface FakeLLMResponse {
  scores: Array<{ index: number; score: number; reason: string }>;
}

function fakeLLM(response: FakeLLMResponse | (() => Promise<FakeLLMResponse>)): LLMClient {
  return {
    async generateJson() {
      const result = typeof response === "function" ? await response() : response;
      return {
        result: result as unknown,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      } as Awaited<ReturnType<LLMClient["generateJson"]>>;
    },
    // Other methods aren't called by `filterSlackByRelevance`; cast
    // the partial mock to the full interface.
  } as unknown as LLMClient;
}

describe("filterSlackByRelevance — empty / passthrough cases", () => {
  it("returns input untouched when there are no Slack threads", async () => {
    const generateJson = vi.fn();
    const llm = { generateJson } as unknown as LLMClient;
    const items = [linearIssue("PLAT-1", "Migrate RDS")];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.kept).toBe(items);
    expect(result.totalSlackCount).toBe(0);
    expect(result.dropped).toEqual([]);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("does not call the LLM when every Slack thread is bookmarked", async () => {
    const generateJson = vi.fn();
    const llm = { generateJson } as unknown as LLMClient;
    const items = [
      slackThread("t1", "🔖 PR review on the new scheduler", "", true),
      slackThread("t2", "🔖 Postmortem follow-up", "", true),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.totalSlackCount).toBe(2);
    expect(result.keptSlackCount).toBe(2);
    expect(result.kept).toEqual(items);
    expect(generateJson).not.toHaveBeenCalled();
  });
});

describe("filterSlackByRelevance — threshold + bookmark bypass", () => {
  it("drops threads below threshold and keeps threads at or above it", async () => {
    const llm = fakeLLM({
      scores: [
        { index: 0, score: 0.85, reason: "on-topic technical content" },
        { index: 1, score: 0.15, reason: "off-topic banter" },
        { index: 2, score: 0.4, reason: "borderline" },
      ],
    });
    const items = [
      slackThread("t1", "Postgres replication lag spike", "We're seeing 12s lag…"),
      slackThread("t2", "Justin Bieber, Justin Beaver :laughing:"),
      slackThread("t3", "Borderline thread", "kind of related"),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items, {
      threshold: 0.4,
      aboutStatement: "platform engineer",
      focusStatement: "database scaling",
    });

    expect(result.totalSlackCount).toBe(3);
    expect(result.keptSlackCount).toBe(2);
    expect(result.kept.map((i) => i.id)).toEqual(["t1", "t3"]);
    expect(result.dropped).toEqual([
      { id: "t2", title: items[1].title, score: 0.15, reason: "off-topic banter" },
    ]);
  });

  it("bookmarked threads bypass scoring even when scored low for the unbookmarked siblings", async () => {
    // Two threads — one bookmarked (`bookmarked: true`), one not. The
    // model only sees the unbookmarked one; the bookmarked one is kept
    // regardless. The 🔖 title prefix is purely cosmetic now —
    // bypass keys off the `bookmarked` field.
    const llm = fakeLLM({
      scores: [{ index: 0, score: 0.0, reason: "noise" }],
    });
    const items = [
      slackThread("t1", "🔖 Bookmarked thread the team flagged", "", true),
      slackThread("t2", "msft makes good dev tools. that is it"),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.kept.map((i) => i.id)).toEqual(["t1"]);
    expect(result.dropped.map((d) => d.id)).toEqual(["t2"]);
  });

  it("does NOT bypass scoring on the 🔖 title prefix alone — bookmark gating reads `item.bookmarked`", async () => {
    // Regression guard: an earlier version keyed the bypass off the
    // title prefix, which conflated "user-bookmarked" with "team
    // teammate bookmarked, surfaced via channel scan". The field is
    // the source of truth now; the prefix is for human display.
    const llm = fakeLLM({
      scores: [{ index: 0, score: 0.0, reason: "noise" }],
    });
    const items = [
      slackThread("t1", "🔖 Title carries the glyph but no field"),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.kept.map((i) => i.id)).toEqual([]);
    expect(result.dropped.map((d) => d.id)).toEqual(["t1"]);
  });

  it("uses 0.4 as the default threshold when none is supplied", async () => {
    const llm = fakeLLM({
      scores: [
        { index: 0, score: 0.41, reason: "just over" },
        { index: 1, score: 0.39, reason: "just under" },
      ],
    });
    const items = [
      slackThread("t1", "Just over the bar"),
      slackThread("t2", "Just under the bar"),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.kept.map((i) => i.id)).toEqual(["t1"]);
    expect(result.dropped.map((d) => d.id)).toEqual(["t2"]);
  });
});

describe("filterSlackByRelevance — unscored items + fail-open", () => {
  it("keeps unscored threads (per-item fail-open) so a partial model response can't drop them silently", async () => {
    const llm = fakeLLM({
      // Returns scores for index 0 only — index 1 is missing.
      scores: [{ index: 0, score: 0.9, reason: "great" }],
    });
    const items = [
      slackThread("t1", "Scored high"),
      slackThread("t2", "Model forgot to score this one"),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.kept.map((i) => i.id)).toEqual(["t1", "t2"]);
    expect(result.dropped).toEqual([]);
  });

  it("falls open with the input unchanged on LLM error and surfaces failedOpen: true", async () => {
    const llm: LLMClient = {
      async generateJson() {
        throw new Error("provider 503");
      },
    } as unknown as LLMClient;
    const items = [
      slackThread("t1", "Anything"),
      slackThread("t2", "Goes"),
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    expect(result.kept).toEqual(items);
    expect(result.failedOpen).toBe(true);
    expect(result.dropped).toEqual([]);
  });
});

describe("filterSlackByRelevance — non-Slack items pass through untouched", () => {
  it("only filters slack_thread items; Linear / incidents / GitHub stay regardless of score", async () => {
    const llm = fakeLLM({
      scores: [{ index: 0, score: 0.0, reason: "unrelated" }],
    });
    const items = [
      linearIssue("PLAT-1", "Migrate RDS"),
      slackThread("t1", "Off-topic chatter"),
      { type: "incident", id: "inc-1", title: "DB failover", url: "...", description: "" } as WorkContextItem,
      { type: "github_pr", id: "pr-1", title: "Fix race", url: "...", description: "" } as WorkContextItem,
    ];
    const result = await filterSlackByRelevance(llm, fakeDB(), "user-1", items);
    // Slack thread filtered, all three non-Slack types remain.
    expect(result.kept.map((i) => i.id)).toEqual(["PLAT-1", "inc-1", "pr-1"]);
    expect(result.kept).toHaveLength(3);
  });
});

describe("Briefing-generator pipeline integration", () => {
  it("imports filterSlackByRelevance and runs it as the slack_filter step", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain('from "./slack-relevance-filter.js"');
    expect(src).toContain("filterSlackByRelevance");
    expect(src).toContain('"slack_filter"');
    // The step runs before concept extraction so the filtered list is
    // the one fed into `extractConcepts`.
    const filterIdx = src.indexOf("filterSlackByRelevance");
    const extractIdx = src.indexOf("extractConcepts(db, userId, llm, workContext");
    expect(filterIdx).toBeGreaterThan(0);
    expect(extractIdx).toBeGreaterThan(0);
    expect(filterIdx).toBeLessThan(extractIdx);
  });

  it("passes the user's About / Focus / filterPrompt / relevanceThreshold into the filter", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/aboutStatement,\s*\n\s*focusStatement,\s*\n\s*filterPrompt:\s*userSettings\?.filterPrompt/);
    expect(src).toMatch(/threshold:\s*userSettings\?\.relevanceThreshold/);
  });

  it("records a slack_filter timing row with totalSlackCount + droppedCount metadata", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/stepKey:\s*"slack_filter"/);
    expect(src).toContain("totalSlackCount: filterResult.totalSlackCount");
    expect(src).toContain("keptSlackCount: filterResult.keptSlackCount");
  });

  it("rebinds workContext (let, not const) so the filtered list flows downstream", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("let workContext: WorkContextItem[] = [];");
    expect(src).toMatch(/workContext\s*=\s*filterResult\.kept/);
  });
});

describe("slack_filter step is wired into every pipeline-step list", () => {
  it("appears in the analytics route's STEP_ORDER between work_context and concepts", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(/"work_context",\s*\n\s*"slack_filter",\s*\n\s*"concepts"/);
  });

  it("appears in the GenerationProgress GENERATION_STEPS timeline with a source-neutral label", async () => {
    // The GENERATION_STEPS array moved out of BriefingPage when the
    // progress panel was extracted into its own component so both
    // the feed (root view) and any future surface could reuse it.
    const src = await read("src/frontend/components/GenerationProgress.tsx");
    // Display label deliberately stays source-neutral ("Filtering source
    // data") even though the internal step_key is `slack_filter` —
    // makes the timeline forward-compatible if/when we filter other
    // source types without renaming the historical timing rows.
    expect(src).toMatch(/key:\s*"slack_filter",\s*label:\s*"Filtering source data"/);
  });

  it("appears in BriefingWaterfall labels + colors with a source-neutral label", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    expect(src).toMatch(/slack_filter:\s*"Filtering source data"/);
    expect(src).toMatch(/slack_filter:\s*"#f59e0b"/);
  });

  it("appears in AnalyticsPage STEP_LABELS with a source-neutral label", async () => {
    const src = await read("src/frontend/pages/AnalyticsPage.tsx");
    expect(src).toMatch(/slack_filter:\s*"Filtering source data"/);
  });
});
