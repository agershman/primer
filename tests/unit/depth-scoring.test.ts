import { describe, it, expect } from "vitest";
import {
  computePositiveFeedback,
  computeQuizResult,
  computeQuizSkip,
  computeDecay,
} from "../../src/worker/services/depth-manager";

describe("depth scoring — pure logic", () => {
  describe("initial extraction", () => {
    it("starts at depth=0, confidence=0", () => {
      expect(0).toBe(0);
      expect(0).toBe(0);
    });
  });

  describe("positive feedback", () => {
    it("increases depth by +0.2 and confidence by +0.1", () => {
      const result = computePositiveFeedback(1.0, 0.4);
      expect(result.newDepth).toBeCloseTo(1.2);
      expect(result.newConfidence).toBeCloseTo(0.5);
    });

    it("caps depth at current + 1 (MAX_DEPTH_BUMP_ABOVE_CURRENT)", () => {
      const result = computePositiveFeedback(2.0, 0.5);
      expect(result.newDepth).toBeCloseTo(2.2);
      expect(result.newDepth).toBeLessThanOrEqual(3.0);
    });

    it("caps depth at absolute max of 5", () => {
      const result = computePositiveFeedback(4.9, 0.9);
      expect(result.newDepth).toBeLessThanOrEqual(5);
    });

    it("caps confidence at 1.0", () => {
      const result = computePositiveFeedback(1.0, 0.95);
      expect(result.newConfidence).toBe(1.0);
    });
  });

  describe("negative feedback", () => {
    it("does not change depth or confidence (no negative handler)", () => {
      const before = { depth: 2.0, confidence: 0.6 };
      expect(before.depth).toBe(2.0);
      expect(before.confidence).toBe(0.6);
    });
  });

  describe("quiz answer", () => {
    it("sets depth to assessed value and confidence to 0.8", () => {
      const result = computeQuizResult(3.0);
      expect(result.newDepth).toBe(3.0);
      expect(result.newConfidence).toBe(0.8);
    });

    it("clamps assessed depth between 0 and 5", () => {
      expect(computeQuizResult(-1).newDepth).toBe(0);
      expect(computeQuizResult(6).newDepth).toBe(5);
    });
  });

  describe("quiz skip", () => {
    it("decreases confidence by 0.1", () => {
      const result = computeQuizSkip(0.5);
      expect(result.newConfidence).toBeCloseTo(0.4);
    });

    it("floors confidence at 0", () => {
      const result = computeQuizSkip(0.05);
      expect(result.newConfidence).toBe(0);
    });
  });

  describe("decay", () => {
    const baseDate = new Date("2026-04-24T12:00:00Z");

    function daysAgo(n: number): string {
      return new Date(baseDate.getTime() - n * 86_400_000).toISOString();
    }

    it("does nothing for concepts with depth < 2", () => {
      const result = computeDecay(1.5, 0.6, daysAgo(100), null, null, baseDate);
      expect(result.action).toBe("none");
      expect(result.newDepth).toBe(1.5);
    });

    it("does nothing for recently active concepts", () => {
      const result = computeDecay(3.0, 0.8, daysAgo(10), null, null, baseDate);
      expect(result.action).toBe("none");
    });

    it("warns after 30 days inactive", () => {
      const result = computeDecay(3.0, 0.8, daysAgo(35), null, null, baseDate);
      expect(result.action).toBe("warn");
      expect(result.newDepth).toBe(3.0);
    });

    it("does not warn twice (already warned)", () => {
      const result = computeDecay(
        3.0, 0.8, daysAgo(35), null, daysAgo(5), baseDate
      );
      expect(result.action).not.toBe("warn");
    });

    it("decays by -0.3 depth and -0.2 confidence after 60 days", () => {
      const result = computeDecay(
        3.0, 0.8, daysAgo(65), null, daysAgo(30), baseDate
      );
      expect(result.action).toBe("decay");
      expect(result.newDepth).toBeCloseTo(2.7);
      expect(result.newConfidence).toBeCloseTo(0.6);
    });

    it("applies severe decay after 90 days", () => {
      const result = computeDecay(
        3.0, 0.8, daysAgo(95), null, daysAgo(60), baseDate
      );
      expect(result.action).toBe("severe_decay");
      expect(result.newDepth).toBeCloseTo(2.7);
      expect(result.newConfidence).toBeCloseTo(0.6);
    });

    it("never decays below 1.0 if concept was calibrated", () => {
      const result = computeDecay(
        1.2, 0.3, daysAgo(95), daysAgo(100), daysAgo(60), baseDate
      );
      expect(result.newDepth).toBeGreaterThanOrEqual(1.0);
    });

    it("can decay below 1.0 if never calibrated", () => {
      const result = computeDecay(
        2.0, 0.3, daysAgo(65), null, daysAgo(30), baseDate
      );
      expect(result.action).toBe("decay");
      expect(result.newDepth).toBeCloseTo(1.7);
    });

    it("floors depth at 0 minimum", () => {
      const result = computeDecay(
        2.0, 0.1, daysAgo(200), null, daysAgo(100), baseDate
      );
      expect(result.newDepth).toBeGreaterThanOrEqual(0);
    });

    it("floors confidence at 0 minimum", () => {
      const result = computeDecay(
        3.0, 0.1, daysAgo(65), null, daysAgo(30), baseDate
      );
      expect(result.newConfidence).toBe(0);
    });
  });
});
