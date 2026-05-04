import { describe, expect, it, vi } from "vitest";
import { selectEnabledSingletons } from "../../src/worker/services/briefing-generator/shared";
import type { SourceFetchContext, SourceFetchResult, SourceProvider } from "../../src/worker/sources/index";

/**
 * Integration tests for the per-user enabled-sources gate in the
 * briefing pipeline.
 *
 * These tests don't stand up the full briefing pipeline (D1, LLM,
 * settings row, concept extraction, teaching generation, etc.) —
 * the gate logic is the small bit that actually decides which
 * sources fan out, and isolating it lets us pin the behaviour
 * without 30 lines of mock plumbing per test.
 *
 * Coverage:
 *   - undefined enabled list = pass-through (preserves any
 *     pre-feature codepath that hasn't loaded settings yet).
 *   - empty enabled list = nothing fans out.
 *   - partial enabled list = only the matching providers run; the
 *     others' `fetch()` is never invoked (which is the actual cost
 *     savings the gate exists for).
 *   - unknown ids in the enabled list are silently ignored (a
 *     deployment can shrink its registry without bricking briefings).
 */

function fakeProvider(id: string, multiInstance = false): SourceProvider & { fetch: ReturnType<typeof vi.fn> } {
  return {
    id,
    name: id,
    requiredEnv: [],
    multiInstance,
    isAvailable: () => true,
    isConfigured: () => true,
    fetch: vi.fn<(ctx: SourceFetchContext) => Promise<SourceFetchResult>>(async () => ({
      items: [],
      details: [`${id}: 0 items`],
    })),
  };
}

describe("Briefing-pipeline gate — selectEnabledSingletons", () => {
  it("undefined enabled list returns every provider unchanged", () => {
    const providers = [fakeProvider("linear"), fakeProvider("slack"), fakeProvider("github")];
    const got = selectEnabledSingletons(providers, undefined);
    expect(got.map((p) => p.id)).toEqual(["linear", "slack", "github"]);
  });

  it("empty enabled list returns no providers", () => {
    const providers = [fakeProvider("linear"), fakeProvider("slack")];
    const got = selectEnabledSingletons(providers, []);
    expect(got).toEqual([]);
  });

  it("partial enabled list keeps only the matching providers", () => {
    const providers = [
      fakeProvider("linear"),
      fakeProvider("slack"),
      fakeProvider("github"),
      fakeProvider("incident_io"),
    ];
    const got = selectEnabledSingletons(providers, ["linear", "github"]);
    expect(got.map((p) => p.id).sort()).toEqual(["github", "linear"]);
  });

  it("unknown ids in the enabled list are ignored (no error)", () => {
    const providers = [fakeProvider("linear"), fakeProvider("slack")];
    const got = selectEnabledSingletons(providers, ["linear", "phantom_kind", "deleted_provider"]);
    expect(got.map((p) => p.id)).toEqual(["linear"]);
  });

  it("disabled providers' fetch() is never called when the gate runs the fan-out", async () => {
    // This test mirrors the actual fan-out shape in
    // briefing-generator.ts: filter providers, then Promise.all
    // their fetch() calls. The behavioural guarantee — disabled
    // sources' fetch is NOT invoked — is the cost saving the
    // gate exists for, so it's the one we pin.
    const linear = fakeProvider("linear");
    const slack = fakeProvider("slack");
    const github = fakeProvider("github");
    const all = [linear, slack, github];

    const enabled = selectEnabledSingletons(all, ["linear", "github"]);
    const fakeCtx = {} as SourceFetchContext;
    await Promise.all(enabled.map((p) => p.fetch(fakeCtx)));

    expect(linear.fetch).toHaveBeenCalledOnce();
    expect(github.fetch).toHaveBeenCalledOnce();
    expect(slack.fetch).not.toHaveBeenCalled();
  });

  it("the orchestrator wires the gate by calling selectEnabledSingletons", async () => {
    // Source-text contract: the actual briefing-generator must
    // delegate to the helper rather than re-implementing the
    // filter inline. Without this pin, a future refactor could
    // silently drop the gate while keeping `enabledSourceIds`
    // referenced elsewhere in the file.
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const REPO_ROOT = resolve(__dirname, "..", "..");
    const src = await readFile(resolve(REPO_ROOT, "src/worker/services/briefing-generator.ts"), "utf-8");
    expect(src).toMatch(/selectEnabledSingletons\(\s*sourceRegistry\.getSingletons\(env\),\s*userSettings\?\.enabledSourceIds/);
  });
});
