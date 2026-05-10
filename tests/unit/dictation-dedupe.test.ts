import { describe, expect, it } from "vitest";
import { dedupeAgainstSession } from "../../src/frontend/components/DictationButton";

// Regression coverage for the Android Chrome cumulative-final bug. The
// helper is what stops emissions like
//   "Cinders Cinders Cinders implementation Cinders implementation of single
//    single tenancy"
// when each cumulative final transcript would otherwise be appended in full.

describe("dedupeAgainstSession", () => {
  it("returns the full transcript when nothing has been emitted yet", () => {
    expect(dedupeAgainstSession("", "hello world")).toBe("hello world");
  });

  it("returns nothing when the new transcript exactly equals the session", () => {
    expect(dedupeAgainstSession("Cinders", "Cinders")).toBe("");
  });

  it("returns nothing when the session ends with the new transcript (replayed final)", () => {
    expect(dedupeAgainstSession("I am a developer at Cinders", "Cinders")).toBe("");
  });

  it("strips the prefix when the new transcript is a prefix-extension of the session", () => {
    expect(dedupeAgainstSession("Cinders", "Cinders implementation")).toBe("implementation");
    expect(dedupeAgainstSession("Cinders implementation", "Cinders implementation of single")).toBe("of single");
  });

  it("strips a word-boundary overlap between the session tail and the new prefix", () => {
    // The classic mobile-Chrome pattern: after an auto-restart the next
    // utterance begins with the same word the previous one ended on.
    expect(dedupeAgainstSession("Cinders implementation of single", "single tenancy")).toBe("tenancy");
  });

  it("does not strip short coincidental word-boundary overlaps", () => {
    // Single-character word matches at boundaries happen all the time in
    // natural speech ("of a" then "a developer") and would produce false
    // positives if we treated every overlap as a duplicate.
    expect(dedupeAgainstSession("of a", "a developer")).toBe("a developer");
  });

  it("does not strip mid-word substring matches", () => {
    // "implement" inside "implementation" shouldn't trigger overlap removal —
    // case 2 requires a trailing space in `next`, and the word-boundary
    // check in case 3 rules out matches that don't sit on whitespace.
    expect(dedupeAgainstSession("we implement", "implementation matters")).toBe("implementation matters");
    // Likewise a prefix that doesn't end on a word boundary in `next`
    // should not be stripped.
    expect(dedupeAgainstSession("Cind", "Cinders implementation")).toBe("Cinders implementation");
  });

  it("emits new utterances unchanged when they don't overlap the session", () => {
    expect(dedupeAgainstSession("Cinders implementation", "hello world")).toBe("hello world");
  });

  it("handles the full reproducer end-to-end", () => {
    // Simulates the cumulative emissions from the bug report:
    //   1. "Cinders" → emit "Cinders"
    //   2. "Cinders" → emit ""
    //   3. "Cinders implementation" → emit "implementation"
    //   4. "Cinders implementation of single" → emit "of single"
    //   5. "single tenancy" → emit "tenancy"
    let session = "";
    const append = (next: string) => {
      const remainder = dedupeAgainstSession(session, next);
      if (remainder) session = session ? `${session} ${remainder}` : remainder;
      return remainder;
    };
    expect(append("Cinders")).toBe("Cinders");
    expect(append("Cinders")).toBe("");
    expect(append("Cinders implementation")).toBe("implementation");
    expect(append("Cinders implementation of single")).toBe("of single");
    expect(append("single tenancy")).toBe("tenancy");
    expect(session).toBe("Cinders implementation of single tenancy");
  });
});
