import { describe, expect, it } from "vitest";
import { classifyNoContentReason } from "../../src/worker/services/briefing-generator/shared";

/**
 * Pins the classifier the briefing-generator finalize step uses to
 * tag empty-briefing rows with `metadata.reason`. This is the
 * boundary that distinguishes "quiet day, nothing surfaced" from
 * "we tried and broke" — the UI shows different copy and styling
 * for each.
 */
describe("classifyNoContentReason", () => {
  it("returns null when the briefing has at least one piece", () => {
    expect(classifyNoContentReason({ totalPieces: 1, selectedCount: 1, errorCount: 0 })).toBeNull();
    expect(classifyNoContentReason({ totalPieces: 5, selectedCount: 5, errorCount: 0 })).toBeNull();
    // Even a partial briefing (some pieces persisted, some errors) is
    // not "no content" — the user has something to read.
    expect(classifyNoContentReason({ totalPieces: 2, selectedCount: 5, errorCount: 3 })).toBeNull();
  });

  it("returns 'no_candidates' when nothing was selected for generation", () => {
    expect(classifyNoContentReason({ totalPieces: 0, selectedCount: 0, errorCount: 0 })).toBe("no_candidates");
  });

  it("returns 'all_pieces_failed' when every selected candidate errored", () => {
    expect(classifyNoContentReason({ totalPieces: 0, selectedCount: 5, errorCount: 5 })).toBe("all_pieces_failed");
    // Even one error is enough to surface the failure flavor —
    // any selected-but-not-persisted piece points at a generation
    // problem the user should know about.
    expect(classifyNoContentReason({ totalPieces: 0, selectedCount: 3, errorCount: 1 })).toBe("all_pieces_failed");
  });

  it("falls back to 'no_candidates' when selected > 0 but neither errors nor pieces — defensive bucket", () => {
    // Shouldn't happen in practice (the generator always either
    // persists a piece or pushes an error per selected candidate),
    // but if it ever did we want the calm copy rather than a
    // misleading "everything failed". The test pins that choice so
    // a future refactor doesn't silently flip it.
    expect(classifyNoContentReason({ totalPieces: 0, selectedCount: 2, errorCount: 0 })).toBe("no_candidates");
  });
});
