/**
 * Pins the token + audio-character analytics surface.
 *
 * The unified `usage_events` ledger has been collecting per-call
 * input/output/reasoning/cache tokens + audio chars + provider +
 * model + operation + cost since the multi-provider migration.
 * Pre-fix, only the per-day cost roll-up was exposed; this surface
 * adds three additional cuts (per-operation, per-model, per-day
 * volume) and a TTS provider projection so the user can answer:
 *
 *   1. "Which use case is consuming the most tokens?" — drives
 *      prompt-tightening decisions.
 *   2. "Which (provider, model) is the biggest contributor?" —
 *      drives tier-down decisions.
 *   3. "What would TTS cost if I switched to a slicker voice?" —
 *      drives budget planning around provider swaps.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("server: GET /api/analytics/usage exposes the ledger", () => {
  it("registers the route on analyticsRoutes", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(/analyticsRoutes\.get\("\/analytics\/usage"/);
  });

  it("queries usage_events with all token + char dimensions", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(/SUM\(input_tokens\) as input_tokens/);
    expect(src).toMatch(/SUM\(output_tokens\) as output_tokens/);
    expect(src).toMatch(/SUM\(reasoning_tokens\) as reasoning_tokens/);
    expect(src).toMatch(/SUM\(cache_read_tokens\) as cache_read_tokens/);
    expect(src).toMatch(/SUM\(cache_write_tokens\) as cache_write_tokens/);
    expect(src).toMatch(/SUM\(audio_chars\) as audio_chars/);
    expect(src).toMatch(/SUM\(estimated_cost_usd\) as cost_usd/);
  });

  it("groups by (operation, modality, provider, model, voice, day)", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    // The single-query approach: SQL groups by every dimension so
    // JS-side aggregation can roll up into operation / model / day
    // cuts without re-querying.
    expect(src).toMatch(
      /GROUP BY operation, modality, provider, model, voice, day/,
    );
  });

  it("returns four cuts: byOperation, byModel, byOperationModel, byDay", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(/byOperation:\s*sortByCost/);
    expect(src).toMatch(/byModel:\s*sortByCost/);
    expect(src).toMatch(/byOperationModel:\s*sortByCost/);
    expect(src).toMatch(/byDay:\s*Array\.from\(byDay\.values\(\)\)/);
  });

  it("sorts cost-bearing cuts by cost desc so biggest contributors are top", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(/const sortByCost = [\s\S]{0,300}b\.costUsd - a\.costUsd/);
  });

  it("ships the TTS catalog and current-window TTS char volume for projections", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(/import \{ TTS_MODELS \} from "\.\.\/config\/constants\.js"/);
    expect(src).toMatch(/ttsCatalog = TTS_MODELS\.map/);
    // Catalog entries include the four fields the projection needs.
    expect(src).toMatch(/id: m\.id/);
    expect(src).toMatch(/label: m\.label/);
    expect(src).toMatch(/provider: m\.provider/);
    expect(src).toMatch(/costPer1kChars: m\.costPer1kChars/);
    // Current TTS chars in window — the input to the projection.
    expect(src).toMatch(/currentTtsCharsInWindow/);
    expect(src).toMatch(
      /if \(r\.modality === "tts"\) currentTtsCharsInWindow \+= r\.audio_chars \?\? 0/,
    );
  });

  it("response includes totals + windowDays + every cut", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    expect(src).toMatch(
      /return c\.json\(\{[\s\S]{0,400}windowDays:\s*days[\s\S]{0,400}totals[\s\S]{0,400}byOperation[\s\S]{0,400}byModel[\s\S]{0,400}byOperationModel[\s\S]{0,400}byDay[\s\S]{0,400}currentTtsCharsInWindow[\s\S]{0,400}ttsCatalog/,
    );
  });
});

describe("hook: useAnalytics fetches the new endpoint alongside the others", () => {
  it("declares a UsageData type with all metric fields + cuts", async () => {
    const src = await read("src/frontend/hooks/useAnalytics.ts");
    expect(src).toMatch(/export interface UsageMetrics/);
    expect(src).toMatch(/export interface UsageData/);
    expect(src).toMatch(/byOperation:\s*Array</);
    expect(src).toMatch(/byModel:\s*Array</);
    expect(src).toMatch(/byOperationModel:\s*Array</);
    expect(src).toMatch(/byDay:\s*Array</);
    expect(src).toMatch(/ttsCatalog:\s*Array</);
  });

  it("fetches /api/analytics/usage in parallel with the other endpoints", async () => {
    const src = await read("src/frontend/hooks/useAnalytics.ts");
    expect(src).toMatch(/apiGet<UsageData>\(`\/api\/analytics\/usage\?days=\$\{days\}`\)/);
    // The `Promise.all` returns four results now — pin the shape so
    // a future refactor doesn't accidentally drop the usage fetch.
    expect(src).toMatch(/const \[b, p, l, u\] = await Promise\.all/);
    expect(src).toMatch(/setUsage\(u\)/);
  });

  it("exposes `usage` on the hook return value", async () => {
    const src = await read("src/frontend/hooks/useAnalytics.ts");
    expect(src).toMatch(/return \{ days, setDays, briefings, performance, learning, usage,/);
  });
});

describe("UsageBreakdown component", () => {
  it("renders the four aggregate Stat cards (calls / input / output / audio)", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/<Stat label="Calls"/);
    expect(src).toMatch(/<Stat\s+label="Input tokens"/);
    expect(src).toMatch(/<Stat[\s\S]{0,200}label="Output tokens"/);
    expect(src).toMatch(/<Stat[\s\S]{0,200}label="Audio chars"/);
  });

  it("renders separate per-use-case + per-model UsageTables", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/title="By use case"/);
    expect(src).toMatch(/title="By model"/);
    // Both wired to the rolled-up data from the hook.
    expect(src).toMatch(/rows=\{byOperation\}/);
    expect(src).toMatch(/rows=\{byModel\}/);
  });

  it("each table column shows calls / input / output / chars / cost", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/Calls<\/div>/);
    expect(src).toMatch(/Input<\/div>/);
    expect(src).toMatch(/Output<\/div>/);
    expect(src).toMatch(/Chars<\/div>/);
    expect(src).toMatch(/Cost<\/div>/);
  });

  it("output column highlights reasoning tokens separately when > 0", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    // Reasoning tokens (OpenAI o-series, Anthropic extended thinking,
    // Gemini thoughts) are billed at output rates but tracked
    // separately. Surface in a parenthetical so users can see the
    // breakdown without it dominating the visual.
    expect(src).toMatch(/r\.reasoningTokens > 0/);
    expect(src).toMatch(/reasoning/);
  });

  it("daily charts: three side-by-side (input / output / audio chars)", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/<DailyChart label="Input tokens"/);
    expect(src).toMatch(/<DailyChart\s+label="Output tokens"/);
    expect(src).toMatch(/<DailyChart label="Audio chars"/);
  });

  it("includes a pluralized 'Show all (N)' / 'Show top 8' toggle", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/Show all/);
    expect(src).toMatch(/Show top 8/);
    expect(src).toMatch(/TOP_LIMIT = 8/);
  });
});

describe("TTS provider projection", () => {
  it("only renders when the user has TTS volume in the window", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/currentTtsCharsInWindow > 0[\s\S]{0,200}<TtsProjection/);
  });

  it("computes projected cost from char volume × catalog rate", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    // The math is per-1k chars × per-1k rate → USD. Pin the formula
    // so a future refactor can't accidentally swap chars for tokens.
    expect(src).toMatch(/const projectedCost = \(chars \/ 1000\) \* m\.costPer1kChars/);
  });

  it("compares each candidate to the user's CURRENT TTS spend, not their total spend", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    // Filtering byModel to modality === 'tts' so the LLM rows don't
    // pollute the baseline.
    expect(src).toMatch(/byModel\.filter\(\(m\) => m\.modality === "tts"\)/);
    expect(src).toMatch(/delta:\s*projectedCost - currentCostUsd/);
  });

  it("renders '≈ current' for negligible deltas (avoids '+\\$0.00' noise)", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/Math\.abs\(p\.delta\) < 0\.005/);
    expect(src).toMatch(/≈ current/);
  });

  it("sorts candidates ascending by projected cost (cheapest first)", async () => {
    const src = await read("src/frontend/components/UsageBreakdown.tsx");
    expect(src).toMatch(/\.sort\(\(a, b\) => a\.projectedCost - b\.projectedCost\)/);
  });
});

describe("AnalyticsPage wires UsageBreakdown into the page", () => {
  it("imports + renders <UsageBreakdown> when the data has loaded", async () => {
    const src = await read("src/frontend/pages/AnalyticsPage.tsx");
    expect(src).toContain('import { UsageBreakdown } from "../components/UsageBreakdown"');
    expect(src).toMatch(/usage && <UsageBreakdown data=\{usage\} \/>/);
  });
});

describe("help docs document the new analytics surface", () => {
  it("api-endpoints lists /api/analytics/usage", async () => {
    const src = await read("src/frontend/help/reference/api-endpoints.md");
    expect(src).toMatch(/\/api\/analytics\/usage/);
    expect(src).toMatch(/byOperation/);
    expect(src).toMatch(/byModel/);
    expect(src).toMatch(/ttsCatalog/);
  });

  it("analytics.md explains the three cuts + TTS projection", async () => {
    const src = await read("src/frontend/help/reference/analytics.md");
    expect(src).toMatch(/Token \+ audio usage/);
    expect(src).toMatch(/By use case/);
    expect(src).toMatch(/By model/);
    expect(src).toMatch(/What if I switched TTS provider/);
  });
});
