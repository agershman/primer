import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * The two-pass content auditor in `services/piece-auditor.ts`
 * depends on the writer emitting inline `[[ref:<enrichment-id>]]`
 * tags on every factual sentence. If a future refactor removes the
 * tag instructions from one of the three writer prompts (teaching,
 * deep-dive, quiz), the auditor still runs — but every claim looks
 * un-cited, the web-search backstop fires on more spans than it
 * needs to, and audit costs balloon silently.
 *
 * Pinning the tag-instruction string in every writer's prompt
 * catches that regression at CI time. The two model-catalog
 * assertions catch the matching "someone deleted the audit slot"
 * regression that would silently revert the auditor to a hardcoded
 * default.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("audit prompt + model catalog contract", () => {
  it("teaching-generator prompt instructs the writer to emit [[ref:...]] tags", async () => {
    const src = await read("src/worker/services/teaching-generator.ts");
    expect(src).toMatch(/\[\[ref:/);
    expect(src).toMatch(/INLINE REF TAGS/);
  });

  it("deep-dive-generator prompt instructs the writer to emit [[ref:...]] tags", async () => {
    const src = await read("src/worker/services/deep-dive-generator.ts");
    expect(src).toMatch(/\[\[ref:/);
    expect(src).toMatch(/INLINE REF TAGS/);
  });

  it("deep-dive-generator accepts a `sources` option so the auditor verifies against the parent's bundle", async () => {
    const src = await read("src/worker/services/deep-dive-generator.ts");
    expect(src).toMatch(/sources\?:\s*Array</);
  });

  it("quiz-assessor cautions the writer against unverifiable factual premises", async () => {
    const src = await read("src/worker/services/quiz-assessor.ts");
    expect(src).toMatch(/FACTUAL DISCIPLINE/);
  });

  it("models.ts exports `audit` and `auditPatch` in ModelOperation union + DEFAULT_MODELS", async () => {
    const src = await read("src/worker/config/models.ts");
    expect(src).toMatch(/\|\s*"audit"/);
    expect(src).toMatch(/\|\s*"auditPatch"/);
    expect(src).toMatch(/audit:\s*"claude-haiku-4-5-20251001"/);
    expect(src).toMatch(/auditPatch:\s*"claude-sonnet-4-20250514"/);
  });

  it("classifyBlock prompt instructs the auditor to reject sub-sentence noun phrases", async () => {
    // Pins the v2 prompt-tightening: the classifier sometimes flagged
    // a 1-3 word noun phrase ("service dependencies") even though
    // the surrounding sentence was general engineering knowledge.
    // The remediation has two layers — a prompt instruction (this
    // assertion) and the `isTooShortToBeClaim` post-filter (covered
    // in `piece-auditor.test.ts`). Both must hold for the user-
    // visible regression to stay fixed.
    const src = await read("src/worker/services/piece-auditor.ts");
    expect(src).toMatch(/Reject isolated nouns or noun phrases/);
    expect(src).toMatch(/at least one full clause/);
  });
});
