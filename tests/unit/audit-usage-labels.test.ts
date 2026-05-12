import { describe, expect, it } from "vitest";
import { AUDIT_OPERATIONS, OPERATION_LABELS, isAuditOperation } from "../../src/frontend/components/usage-format";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * Every audit-family operation tag the worker writes to `usage_events`
 * MUST have a matching entry in `OPERATION_LABELS` — otherwise the
 * Analytics page renders raw snake_case strings like "piece_audit_websearch"
 * in the per-operation breakdown table. Pinning the contract here
 * catches the "worker added a new operation, frontend forgot the label"
 * regression at CI time.
 *
 * Also asserts the `AUDIT_OPERATIONS` rollup list stays in sync with
 * the labels — the "Audit overhead" analytics card aggregates over
 * this list, so a missing entry silently under-counts audit spend.
 */

describe("audit operation labels stay in sync with worker recordTokenUsage tags", () => {
  const expected = [
    "piece_audit",
    "deep_dive_audit",
    "quiz_audit",
    "piece_audit_patch",
    "piece_audit_websearch",
  ] as const;

  it("each audit operation tag has a friendly label", () => {
    for (const op of expected) {
      expect(OPERATION_LABELS[op], `missing label for ${op}`).toBeTruthy();
    }
  });

  it("AUDIT_OPERATIONS contains exactly the audit-family tags", () => {
    expect([...AUDIT_OPERATIONS].sort()).toEqual([...expected].sort());
  });

  it("isAuditOperation discriminates correctly", () => {
    for (const op of expected) {
      expect(isAuditOperation(op)).toBe(true);
    }
    expect(isAuditOperation("teaching_generation")).toBe(false);
    expect(isAuditOperation("chat")).toBe(false);
  });
});
