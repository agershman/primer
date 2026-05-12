import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CancelledError } from "../../src/worker/services/briefing-generator";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const readRepoFile = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("CancelledError", () => {
  it("is a distinct error class with a descriptive message", () => {
    const err = new CancelledError();
    expect(err).toBeInstanceOf(CancelledError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CancelledError");
    expect(err.message).toContain("cancelled");
  });

  it("is catchable as CancelledError specifically", () => {
    let caught: unknown = null;
    try {
      throw new CancelledError();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CancelledError);
  });

  it("is distinguishable from generic Error", () => {
    const cancelled = new CancelledError();
    const generic = new Error("something else");
    expect(cancelled instanceof CancelledError).toBe(true);
    expect(generic instanceof CancelledError).toBe(false);
  });
});

describe("cancel storage model", () => {
  // The cancel flag lives in its own column so progress writes can't stomp
  // it. Previously it was embedded in the metadata JSON and a race between
  // updateProgress (read-check-then-write) and the cancel route could wipe
  // the flag. These assertions document the invariants.

  it("consolidated schema has a dedicated cancel_requested column", async () => {
    const sql = await readRepoFile("migrations/0001_initial.sql");
    expect(sql).toMatch(/cancel_requested INTEGER NOT NULL DEFAULT 0/);
  });

  it("cancel route SQL updates only the cancel_requested column", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // The cancel route must not touch the metadata column — that would
    // race with updateProgress.
    // Tolerate either router name — `briefingRoutes` (legacy assembly
    // file) or `briefingLifecycleRoutes` (post-split sub-file).
    const cancelRoute = src.match(
      /(?:briefingRoutes|briefingLifecycleRoutes)\.post\("\/briefing\/cancel"[\s\S]*?\}\);/,
    );
    expect(cancelRoute).not.toBeNull();
    expect(cancelRoute?.[0]).toContain("cancel_requested = 1");
    expect(cancelRoute?.[0]).not.toMatch(/SET metadata/);
  });

  it("checkCancelled reads from cancel_requested column, not metadata", async () => {
    // The helper moved into a sibling shared file when the
    // briefing pipeline started extracting reusable primitives
    // (see services/briefing/shared.ts). The contract is the
    // same — assert against either location via the split-source
    // reader so the test holds across both.
    const src = await readSrc("src/worker/services/briefing-generator.ts");
    const match = src.match(/(?:async function|export async function) checkCancelled[\s\S]*?^\}/m);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain("cancel_requested");
    expect(match?.[0]).not.toMatch(/JSON\.parse\(row\.metadata\)/);
  });

  it("status endpoint surfaces cancelRequested for the UI", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toMatch(/cancelRequested:/);
    expect(src).toMatch(/cancel_requested FROM briefings/);
  });

  it("the teaching-piece loop has a mid-step cancel checkpoint", async () => {
    const src = await readRepoFile("src/worker/services/briefing-generator.ts");
    const loopMatch = src.match(
      /for \(let ti = 0; ti < selected\.length; ti \+= 2\) \{[\s\S]*?Promise\.all/,
    );
    expect(loopMatch, "teaching piece batch loop should exist").not.toBeNull();
    expect(loopMatch?.[0]).toContain("await checkCancelled");
  });

  it("useGeneration.cancel optimistically sets cancelling state", async () => {
    // User feedback requirement: clicking Cancel must immediately indicate
    // that the click registered, not wait for the next server poll.
    // (Generation lifecycle moved out of useBriefing into useGeneration
    // so it could be decoupled from any specific date.)
    const src = await readRepoFile("src/frontend/hooks/useGeneration.ts");
    const cancelFn = src.match(/const cancel = useCallback\([\s\S]*?\}, \[\]\);/);
    expect(cancelFn, "cancel callback should exist").not.toBeNull();
    expect(cancelFn?.[0]).toContain("setCancelling(true)");
    // Optimistic update to status shape as well so timeline heading flips.
    expect(cancelFn?.[0]).toMatch(/cancelRequested: true/);
  });

  it("GenerationProgress disables the Cancel button while cancelling", async () => {
    // The cancel button lives in the GenerationProgress panel that
    // the BriefingFeed mounts above the date sections. The disabled
    // + "Cancelling…" verbiage is the user-visible contract.
    const src = await readRepoFile("src/frontend/components/GenerationProgress.tsx");
    expect(src).toMatch(/disabled=\{cancelling\}/);
    expect(src).toMatch(/\{cancelling \? "Cancelling…" : "Cancel"\}/);
  });
});
