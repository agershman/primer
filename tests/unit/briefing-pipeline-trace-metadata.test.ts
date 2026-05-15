import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source-text contract: the briefing-generator must persist the
 * decision-level trace metadata the pipeline panel renders.
 *
 * Why a source-text pin rather than a behaviour test: the metadata
 * fields are JSON blobs on `briefing_timings.metadata`, written
 * deep inside `generateDailyBriefing` (~1500 lines, multiple LLM
 * calls, multiple DB roundtrips). A full behavioural test would
 * have to stand up D1 + every LLM client + every source provider,
 * mock-record the recordTiming arguments, and unwind a try/catch
 * pyramid. The fields themselves are simple — the risk is silent
 * removal during an unrelated refactor (someone simplifying the
 * selection loop and dropping `outcomes`, say). Pinning the
 * field NAMES on the relevant `recordTiming({...stepKey: "<x>"})`
 * call sites catches that drop without the integration burden.
 *
 * If you genuinely need to rename a metadata field, update both
 * this pin and the matching consumer in
 * `src/frontend/components/PipelineTrace.tsx` + the response shape
 * in `src/worker/routes/briefing/extra.ts`.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");

async function readSrc(): Promise<string> {
  return readFile(resolve(REPO_ROOT, "src/worker/services/briefing-generator.ts"), "utf-8");
}

describe("Pipeline-trace metadata contract on briefing_timings", () => {
  it("work_context step records per-provider stats keyed off the singleton registry", async () => {
    const src = await readSrc();
    // The orchestrator captures the FULL registry (not just enabled) so
    // disabled providers can be surfaced as 'disabled' in the trace.
    expect(src).toMatch(/sourceRegistry\.getSingletons\(env\)/);
    expect(src).toMatch(/providerStats/);
    // The widened metadata payload on the work_context recordTiming.
    expect(src).toMatch(/stepKey: "work_context"[\s\S]{0,400}metadata: \{ providers: providerStats/);
  });

  it("slack_filter step records dropped items with a sourceType tag (generic across future relevance gates)", async () => {
    const src = await readSrc();
    // Generic shape: `sourceType` rather than a Slack-only field —
    // future relevance gates writing the same metadata under their
    // own step key get rendered by the panel for free.
    expect(src).toMatch(/stepKey: "slack_filter"[\s\S]{0,1200}droppedItems:/);
    expect(src).toMatch(/sourceType: "slack_thread"/);
  });

  it("concepts step records the per-filter bucket layout (source-agnostic)", async () => {
    const src = await readSrc();
    expect(src).toMatch(/conceptBucketMap/);
    expect(src).toMatch(/stepKey: "concepts"[\s\S]{0,800}buckets: conceptBuckets/);
  });

  it("selecting step records per-candidate outcomes with droppedReason", async () => {
    const src = await readSrc();
    expect(src).toMatch(/candidateOutcomes/);
    expect(src).toMatch(/droppedReason/);
    expect(src).toMatch(/cap_max_pieces|cap_adjacent|cap_decay|duplicate_concept/);
    expect(src).toMatch(/stepKey: "selecting"[\s\S]{0,300}outcomes: candidateOutcomes/);
  });

  it("teaching_piece step records the continuation classifier verdict when it ran", async () => {
    const src = await readSrc();
    expect(src).toMatch(/stepKey: "teaching_piece"[\s\S]{0,500}continuation:/);
    // The duration is pinned to the writer wall-clock so the trace
    // doesn't double-count audit + classifier time on this row.
    expect(src).toMatch(/writerFinishedAt/);
  });
});
