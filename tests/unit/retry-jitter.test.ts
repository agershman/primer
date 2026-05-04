import { describe, it, expect } from "vitest";
import { retryDelay, isRetryableStatus, parseRetryAfter, RETRY_CONFIG } from "../../src/worker/config/constants";

describe("retryDelay", () => {
  it("produces exponentially increasing delays", () => {
    const delays = Array.from({ length: 5 }, () => {
      const d0 = retryDelay(0);
      const d1 = retryDelay(1);
      const d2 = retryDelay(2);
      return { d0, d1, d2 };
    });

    for (const { d0, d1, d2 } of delays) {
      expect(d0).toBeGreaterThan(0);
      expect(d1).toBeGreaterThan(d0 * 0.5);
      expect(d2).toBeGreaterThan(d1 * 0.5);
    }
  });

  it("adds jitter (not all delays are identical)", () => {
    const samples = Array.from({ length: 20 }, () => retryDelay(1));
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("respects retryAfterMs when provided", () => {
    const delay = retryDelay(0, 5000);
    expect(delay).toBe(5000);
  });

  it("never returns a negative delay", () => {
    for (let i = 0; i < 100; i++) {
      expect(retryDelay(i % 5)).toBeGreaterThanOrEqual(100);
    }
  });

  it("uses RETRY_CONFIG values", () => {
    expect(RETRY_CONFIG.MAX_ATTEMPTS).toBe(3);
    expect(RETRY_CONFIG.JITTER_FACTOR).toBe(0.3);
    expect(RETRY_CONFIG.BACKOFF_MULTIPLIER).toBe(2);
  });
});

describe("isRetryableStatus", () => {
  it("retries 429 (rate limited)", () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("retries 500, 502, 503, 504 (server errors)", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  it("does NOT retry 400, 401, 403, 404", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("does NOT retry 200, 201, 204", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(201)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses numeric seconds", () => {
    const res = new Response("", { headers: { "Retry-After": "30" } });
    expect(parseRetryAfter(res)).toBe(30000);
  });

  it("returns undefined when header is absent", () => {
    const res = new Response("");
    expect(parseRetryAfter(res)).toBeUndefined();
  });
});
