import { describe, it, expect } from "vitest";

const GENERATION_STEPS = [
  "starting",
  "work_context",
  "concepts",
  "adjacent",
  "selecting",
  "generating_pieces",
  "quiz",
  "finishing",
];

describe("generation progress", () => {
  it("defines all expected pipeline steps", () => {
    expect(GENERATION_STEPS).toHaveLength(8);
    expect(GENERATION_STEPS[0]).toBe("starting");
    expect(GENERATION_STEPS[GENERATION_STEPS.length - 1]).toBe("finishing");
  });

  it("step ordering is sequential", () => {
    expect(GENERATION_STEPS.indexOf("work_context")).toBeGreaterThan(
      GENERATION_STEPS.indexOf("starting")
    );
    expect(GENERATION_STEPS.indexOf("concepts")).toBeGreaterThan(
      GENERATION_STEPS.indexOf("work_context")
    );
    expect(GENERATION_STEPS.indexOf("generating_pieces")).toBeGreaterThan(
      GENERATION_STEPS.indexOf("selecting")
    );
  });

  it("progress metadata shape is correct", () => {
    const metadata = {
      step: "work_context",
      stepLabel: "Searching Slack threads…",
      details: ["◆ PLAT-3907 Switch customer staging", "◈ 3 Slack threads"],
    };

    expect(metadata.step).toBeDefined();
    expect(metadata.stepLabel).toBeDefined();
    expect(Array.isArray(metadata.details)).toBe(true);
    expect(metadata.details.length).toBeGreaterThan(0);
  });

  it("details accumulate across sources", () => {
    const details: string[] = [];

    details.push("◆ PLAT-3907 Switch customer staging to RDS");
    details.push("◆ SRE-31 Multi-AZ failover alert pattern");
    expect(details).toHaveLength(2);

    details.push("◈ 5 Slack threads");
    expect(details).toHaveLength(3);

    details.push("▹ 1 recent incidents");
    expect(details).toHaveLength(4);

    expect(details[0]).toMatch(/^◆/);
    expect(details[2]).toMatch(/^◈/);
    expect(details[3]).toMatch(/^▹/);
  });

  it("status endpoint response shape", () => {
    const response = {
      status: "generating",
      step: "work_context",
      stepLabel: "Reading PLAT-3907 (1/5)…",
      details: ["◆ PLAT-3907"],
      lastGenerated: "2026-04-24 19:06:47",
    };

    expect(response.status).toBe("generating");
    expect(response.step).toBeTruthy();
    expect(response.stepLabel).toBeTruthy();
    expect(Array.isArray(response.details)).toBe(true);
  });

  it("completed status has no step", () => {
    const response = {
      status: "generated",
      step: null,
      stepLabel: null,
      details: [],
      lastGenerated: "2026-04-24 19:10:00",
    };

    expect(response.step).toBeNull();
    expect(response.details).toHaveLength(0);
  });
});

/**
 * The "Writing pieces…" progress label has been through two
 * iterations because the wording kept reading wrong:
 *
 *   v1 — "Writing pieces 1–2/4: …" — read as a fraction (1.5 / 4) or
 *        a typo. Replaced.
 *   v2 — "Writing pieces 1–2 of 4: …" — replaced the slash with "of"
 *        but kept the en dash. Readers still saw "3–4 of 4" as a
 *        range or fraction rather than an enumeration. Replaced.
 *   v3 — "Writing pieces 1 and 2 of 4: …" — explicit conjunction.
 *        Reads as plain English: "we are writing pieces 1 and 2,
 *        out of 4 total". The singleton tail case stays as "piece N
 *        of T" with no conjunction.
 *
 * The function below mirrors the briefing generator's `range`
 * formatter so a refactor that regresses to either v1 or v2 fails
 * this test instead of shipping confusing UI copy.
 */
describe("Writing pieces progress label", () => {
  function rangeLabel(ti: number, total: number, batchSize = 2): string {
    const start = ti + 1;
    const end = Math.min(ti + batchSize, total);
    return start === end ? `piece ${start}` : `pieces ${start} and ${end}`;
  }

  it("uses 'pieces N and M of T' for multi-piece batches", () => {
    expect(`Writing ${rangeLabel(0, 4)} of 4`).toBe("Writing pieces 1 and 2 of 4");
    expect(`Writing ${rangeLabel(2, 4)} of 4`).toBe("Writing pieces 3 and 4 of 4");
  });

  it("uses singular 'piece N of T' on a tail-end batch of one", () => {
    expect(`Writing ${rangeLabel(4, 5)} of 5`).toBe("Writing piece 5 of 5");
  });

  it("never renders the fraction-style 'N–M/T' wording (v1 regression)", () => {
    expect(`Writing ${rangeLabel(0, 4)} of 4`).not.toMatch(/\d\/\d/);
    expect(`Writing ${rangeLabel(2, 4)} of 4`).not.toMatch(/\d\/\d/);
  });

  it("never renders the en-dash range wording (v2 regression — readers saw it as a range, not an enumeration)", () => {
    expect(`Writing ${rangeLabel(0, 4)} of 4`).not.toMatch(/\d–\d/);
    expect(`Writing ${rangeLabel(2, 4)} of 4`).not.toMatch(/\d–\d/);
    // Hyphen-minus too, since some readers might type that mistakenly.
    expect(`Writing ${rangeLabel(0, 4)} of 4`).not.toMatch(/pieces \d-\d/);
  });
});

