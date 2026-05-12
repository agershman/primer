import { describe, expect, it } from "vitest";

import { dedupeOverlappingClaims, isInvalidPatchText, isTooShortToBeClaim } from "../../src/worker/services/piece-auditor";
import type { AuditVerdict } from "../../src/worker/types";

/**
 * Regression suite for the audit content pipeline. The bugs these
 * tests pin against:
 *
 *   1. "dataad balancer" — two overlapping flagged spans in the same
 *      block ran through applyResolutions, where the right-to-left
 *      splice of the inner span clipped through the outer span,
 *      producing a smeared token in the rendered text. Fixed by
 *      `dedupeOverlappingClaims` running before patch + applyResolutions.
 *
 *   2. Empty-string rewrite from the patch model — naive splice with
 *      `""` mid-sentence merges adjacent words ("loadbalancer"). Fixed
 *      by `isInvalidPatchText` rejecting empty / control-char rewrites
 *      and falling back to a drop.
 *
 *   3. Noun-phrase claims — the classifier occasionally flagged a 1-3
 *      word noun phrase ("service dependencies") even though the
 *      prompt says only flag complete factual assertions. Fixed by
 *      `isTooShortToBeClaim` filtering them post-classify.
 */

type TestClaim = {
  block_index: number;
  span_start: number;
  span_end: number;
  verdict: AuditVerdict;
  id?: string;
};

describe("dedupeOverlappingClaims", () => {
  it("keeps both claims when they're on different blocks (no overlap across blocks)", () => {
    const claims: TestClaim[] = [
      { block_index: 0, span_start: 10, span_end: 30, verdict: "unsupported", id: "a" },
      // Same offsets on block 1 — overlap check is per-block, so both survive.
      { block_index: 1, span_start: 10, span_end: 30, verdict: "unsupported", id: "b" },
    ];
    const out = dedupeOverlappingClaims(claims);
    const ids = out.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("drops the lower-severity claim when two spans overlap within a block", () => {
    const claims: TestClaim[] = [
      { block_index: 0, span_start: 10, span_end: 40, verdict: "unsupported", id: "lo" },
      // Hallucinated > unsupported — the more severe verdict wins.
      { block_index: 0, span_start: 25, span_end: 50, verdict: "hallucinated", id: "hi" },
    ];
    const out = dedupeOverlappingClaims(claims);
    expect(out.map((c) => c.id)).toEqual(["hi"]);
  });

  it("tie-breaks identical severity by larger span size", () => {
    const claims: TestClaim[] = [
      { block_index: 0, span_start: 10, span_end: 20, verdict: "unsupported", id: "small" },
      { block_index: 0, span_start: 12, span_end: 40, verdict: "unsupported", id: "big" },
    ];
    const out = dedupeOverlappingClaims(claims);
    expect(out.map((c) => c.id)).toEqual(["big"]);
  });

  it("breaks a 3-claim chain — A overlaps B, B overlaps C, A and C are independent", () => {
    // Severity order: A=unsupported, B=grounded (lowest), C=unsupported.
    // After dedupe we should keep both A and C and drop B (the bridge),
    // since A and C don't overlap each other directly.
    const claims: TestClaim[] = [
      { block_index: 0, span_start: 0, span_end: 15, verdict: "unsupported", id: "A" },
      { block_index: 0, span_start: 10, span_end: 30, verdict: "grounded", id: "B" },
      { block_index: 0, span_start: 25, span_end: 45, verdict: "unsupported", id: "C" },
    ];
    const out = dedupeOverlappingClaims(claims);
    const ids = out.map((c) => c.id).sort();
    expect(ids).toEqual(["A", "C"]);
  });

  it("returns an empty array when given an empty input", () => {
    expect(dedupeOverlappingClaims([])).toEqual([]);
  });

  it("preserves claims that don't overlap anything (no false positives)", () => {
    const claims: TestClaim[] = [
      { block_index: 0, span_start: 0, span_end: 10, verdict: "unsupported", id: "x" },
      { block_index: 0, span_start: 20, span_end: 30, verdict: "unsupported", id: "y" },
      { block_index: 0, span_start: 40, span_end: 50, verdict: "unsupported", id: "z" },
    ];
    const out = dedupeOverlappingClaims(claims);
    expect(out.map((c) => c.id).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("isInvalidPatchText", () => {
  it("rejects undefined and null", () => {
    expect(isInvalidPatchText(undefined)).toBe(true);
    expect(isInvalidPatchText(null)).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isInvalidPatchText("")).toBe(true);
  });

  it("rejects strings containing nul bytes or other ASCII control chars", () => {
    // The patch model has occasionally returned strings with stray
    // control bytes (typically nul or DEL) that look fine in JSON but
    // smear the rendered DOM when spliced inline. Reject any such
    // patch and fall back to dropping the claim.
    expect(isInvalidPatchText("hello\x00world")).toBe(true);
    expect(isInvalidPatchText("foo\x01bar")).toBe(true);
    expect(isInvalidPatchText("baz\x7Fqux")).toBe(true);
    expect(isInvalidPatchText("a\x1Fb")).toBe(true);
  });

  it("allows tabs, newlines, and carriage returns inside otherwise-normal text", () => {
    expect(isInvalidPatchText("first line\nsecond line")).toBe(false);
    expect(isInvalidPatchText("col1\tcol2")).toBe(false);
    expect(isInvalidPatchText("dos\r\nlines")).toBe(false);
  });

  it("accepts a plausible patch rewrite", () => {
    expect(isInvalidPatchText("Some teams report this pattern, but it varies by org size.")).toBe(false);
  });
});

describe("isTooShortToBeClaim", () => {
  it("rejects 1-3 word noun phrases", () => {
    expect(isTooShortToBeClaim("service dependencies")).toBe(true);
    expect(isTooShortToBeClaim("load balancer")).toBe(true);
    expect(isTooShortToBeClaim("orchestrators")).toBe(true);
    expect(isTooShortToBeClaim("the load balancer")).toBe(true);
  });

  it("accepts 4+ word spans that read as a claim", () => {
    expect(isTooShortToBeClaim("Most orchestrators distinguish liveness from readiness probes.")).toBe(false);
    expect(isTooShortToBeClaim("health checks evaluate whether a service can serve traffic")).toBe(false);
  });

  it("trims surrounding whitespace before counting", () => {
    expect(isTooShortToBeClaim("   service dependencies   ")).toBe(true);
    expect(isTooShortToBeClaim("   four whole tokens here   ")).toBe(false);
  });

  it("handles empty / whitespace-only input", () => {
    expect(isTooShortToBeClaim("")).toBe(true);
    expect(isTooShortToBeClaim("   ")).toBe(true);
  });
});

/**
 * End-to-end splice simulation. Mirrors what `applyResolutions` does
 * for two overlapping claims — without dedupe, the result is a
 * smeared token like "dataad balancer". With dedupe-then-splice, the
 * surviving claim is applied cleanly.
 */
describe("overlap-splice simulation (the 'dataad balancer' regression)", () => {
  function spliceRightToLeft(
    text: string,
    claims: Array<{ span_start: number; span_end: number; rewrite: string }>,
  ): string {
    const ordered = [...claims].sort((a, b) => b.span_start - a.span_start);
    let out = text;
    for (const c of ordered) {
      out = out.slice(0, c.span_start) + c.rewrite + out.slice(c.span_end);
    }
    return out;
  }

  it("without dedupe, two overlapping rewrites produce smeared output", () => {
    // Original text. Indices: "A load balancer needs this distinction."
    //                          0123456789012345678901234567890123456789
    //                                    1111111111222222222233333333334
    const text = "A load balancer needs this distinction.";
    // Two claims with overlapping spans. This is the patch-model
    // failure mode behind "dataad balancer": when applyResolutions
    // splices right-to-left, the inner rewrite changes the indices
    // the outer rewrite was computed against — so the outer splice
    // ends up clipping through a rewritten region and leaves a
    // smeared token in the result.
    const claims = [
      // Outer span [2,8) covers "load b" → rewrite to "data c".
      { span_start: 2, span_end: 8, rewrite: "data c" },
      // Inner span [5,10) overlaps the outer's tail ("d bal") → rewrite
      // to "ta cen". The patch model can absolutely produce this kind
      // of conflicting suggestion when two adjacent claims both fire.
      { span_start: 5, span_end: 10, rewrite: "ta cen" },
    ];
    const result = spliceRightToLeft(text, claims);
    // The naive right-to-left splice produces a smeared run of
    // characters because the outer rewrite was computed against the
    // original indices but is being applied to the already-modified
    // string. The visible regression on production was tokens like
    // "dataad" — here we observe "ccenancer" from the analogous
    // double-edit pattern. The shape is what matters: an English
    // word smeared with characters from the adjacent rewrite.
    expect(result).toContain("ccenancer");
    // And it's not the clean either-rewrite result.
    expect(result).not.toBe("A data c balancer needs this distinction.");
    expect(result).not.toBe("A loata cenancer needs this distinction.");
  });

  it("with dedupe (severity tie → larger span wins), the surviving claim splices cleanly", () => {
    const text = "A load balancer needs this distinction.";
    const claims: TestClaim[] = [
      { block_index: 0, span_start: 2, span_end: 8, verdict: "unsupported", id: "wide" },
      { block_index: 0, span_start: 5, span_end: 10, verdict: "unsupported", id: "narrow" },
    ];
    const deduped = dedupeOverlappingClaims(claims);
    // The larger span wins on the tie-break (both are "unsupported").
    expect(deduped.map((c) => c.id)).toEqual(["wide"]);
    // Now splice using only the surviving claim — no smear possible.
    const result = spliceRightToLeft(text, [{ span_start: 2, span_end: 8, rewrite: "data c" }]);
    expect(result).not.toContain("ccenancer");
    expect(result).toBe("A data calancer needs this distinction.");
  });
});
