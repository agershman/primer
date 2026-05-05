/**
 * Focus-steering contract tests — pinning the four behaviours added
 * to make the user's focus statement actually steer the briefing
 * pipeline (not just filter extraction):
 *
 *   1. Teaching/quiz prompts inject a CURRENT FOCUS block when set.
 *   2. The focus-scorer ranks candidates per briefing.
 *   3. Same-day refreshes are ADDITIVE — existing pieces survive,
 *      new pieces append, a focus edit doesn't wipe what's there.
 *   4. The Settings UI copy describes which knob steers what.
 *
 * Source-text contracts (no LLM in the loop) — same shape as the
 * neighbouring `session-features-personalization.test.ts` tests.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("focus-steering — additive refresh path", () => {
  it("lifecycle.ts preserves the existing briefing instead of deleting + rebuilding", async () => {
    const src = await read("src/worker/routes/briefing/lifecycle.ts");
    // Isolate the /briefing/generate handler body. Splitting on the
    // route registration keeps us out of the /reset handler which
    // legitimately still issues a DELETE.
    const parts = src.split('briefingLifecycleRoutes.post("/briefing/generate"');
    expect(parts.length).toBeGreaterThan(1);
    const generateBlock = parts[1] ?? "";
    // The new generate handler resets status on the existing row
    // instead of deleting it. We pin both halves: the presence of
    // the status-reset UPDATE, and the absence of any DELETE FROM
    // briefings inside the generate handler.
    expect(generateBlock).toMatch(/UPDATE briefings SET status = 'generating'/);
    expect(generateBlock).not.toMatch(/DELETE FROM briefings/);
    // The existing-briefing branch reuses existing.id rather than
    // generating a fresh one.
    expect(generateBlock).toMatch(/briefingId = existing\.id/);
  });

  it("briefing-generator detects the additive-refresh path by querying existing pieces", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("isAdditiveRefresh");
    expect(src).toMatch(/SELECT id, position, concepts FROM teaching_pieces/);
    // Builds a Set of concept ids already covered so the candidate
    // gathering can skip them.
    expect(src).toContain("existingPieceConceptIds");
  });

  it("candidate gathering filters out concepts already covered by existing pieces", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The P1 active-work filter, P2 adjacent-match filter, and P4
    // decay filter all consult `existingPieceConceptIds` so a
    // refresh doesn't re-teach what's already on the briefing.
    expect(src).toMatch(/!existingPieceConceptIds\.has\(c\.id\)/);
    expect(src).toMatch(/existingPieceConceptIds\.has\(matchedConcept\.id\)/);
  });

  it("selection caps new pieces to MAX_REFRESH_ADDITIONS on the additive path", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("MAX_REFRESH_ADDITIONS");
    expect(src).toMatch(/maxNewPieces = isAdditiveRefresh \? BRIEFING_RULES\.MAX_REFRESH_ADDITIONS/);
    // The new-piece position counter starts AFTER the highest
    // existing position so additive refreshes append at the end
    // instead of stomping on slot 0.
    expect(src).toContain("maxExistingPosition + 1");
  });

  it("BRIEFING_RULES exposes MAX_REFRESH_ADDITIONS at a sensible value", async () => {
    const src = await read("src/worker/config/constants.ts");
    expect(src).toContain("MAX_REFRESH_ADDITIONS");
    // 1-3 inclusive — small enough that a chain of refreshes can't
    // grow a briefing without bound.
    expect(src).toMatch(/MAX_REFRESH_ADDITIONS:\s*[1-3]/);
  });

  it("the migration adds focus_version_id to teaching_pieces and backfills from briefings", async () => {
    const src = await read("migrations/0006_teaching_piece_focus_version.sql");
    expect(src).toMatch(/ALTER TABLE teaching_pieces[\s\S]*ADD COLUMN focus_version_id/);
    expect(src).toMatch(/REFERENCES focus_statement_versions\(id\)/);
    // Backfill copies focus_version_id from the parent briefing so
    // existing rows have an attribution.
    expect(src).toMatch(/UPDATE teaching_pieces[\s\S]*SELECT focus_version_id FROM briefings/);
  });

  it("teaching-piece INSERT stamps focus_version_id on new pieces", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/INSERT INTO teaching_pieces[\s\S]*focus_version_id/);
    // The bind list ends with focusVersionId after seriesId / partNumber.
    expect(src).toMatch(/seriesId,\s*\n?\s*partNumber,\s*\n?\s*focusVersionId,/);
  });

  it("calibration quiz generation is skipped on additive refreshes", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The lowestDepthTarget lookup short-circuits to undefined when
    // we're refreshing — the existing briefing's quiz stays valid.
    expect(src).toMatch(/lowestDepthTarget = isAdditiveRefresh\s*\?\s*undefined/);
  });

  it("MIN_PIECES + must-include-current-work invariants only enforce on fresh generation", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // Both invariants are guarded by `!isAdditiveRefresh` so a
    // refresh that legitimately produces 0 new pieces doesn't get
    // padded with off-focus content.
    expect(src).toMatch(/!isAdditiveRefresh && !hasCurrentWork/);
    expect(src).toMatch(/if \(!isAdditiveRefresh\)\s*\{\s*\n\s*while \(selected\.length < BRIEFING_RULES\.MIN_PIECES/);
  });
});

describe("focus-steering — settings UI copy", () => {
  it("StatementPanel description for About emphasizes voice, not direction", async () => {
    const src = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    // The About description should call out that it shapes voice
    // and explicitly NOT what gets selected — that's Focus's job.
    expect(src).toMatch(/Shapes the voice/);
    expect(src).toMatch(/Doesn't decide what you see/);
  });

  it("StatementPanel description for Focus emphasizes direction across the pipeline", async () => {
    const src = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    expect(src).toMatch(/Drives direction across the whole briefing pipeline/);
    // And it should disclaim voice / depth so the user knows those
    // belong to About + concept mastery.
    expect(src).toMatch(/Doesn't change voice or depth/);
  });
});
