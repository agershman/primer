/**
 * Tests for `enforceEmailAllowlist` — the second line of defense
 * behind whatever auth proxy fronts Primer.
 *
 * Bug class this prevents
 * -----------------------
 * If the Cloudflare Access policy is misconfigured (a public IdP
 * gets attached without a domain restriction, or the wrong policy
 * is bound to the worker route), an authenticated stranger could
 * reach `userContext` and get a row in `users` — including the
 * first-user-wins admin bootstrap on a fresh deploy. The
 * allowlist runs INSIDE every provider's `authenticate` and
 * therefore upstream of the bootstrap INSERT.
 */

import { describe, expect, it } from "vitest";
import { enforceEmailAllowlist } from "../../../src/worker/middleware/auth/allowlist";
import { AuthError } from "../../../src/worker/middleware/auth/types";
import type { Env } from "../../../src/worker/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    ANTHROPIC_API_KEY: "sk-xxx",
    LINEAR_API_KEY: "lin_xxx",
    SLACK_TOKEN: "xoxp-xxx",
    INCIDENT_IO_API_KEY: "inc-xxx",
    BUDGET_CAP_MONTHLY: "35",
    RETENTION_DAYS: "365",
    NEAR_MISS_RETENTION_DAYS: "30",
    RELEVANCE_THRESHOLD: "0.4",
    NEAR_MISS_FLOOR: "0.25",
    ...overrides,
  };
}

describe("enforceEmailAllowlist", () => {
  it("is permissive when neither env var is set (hobbyist / single-user mode)", () => {
    const env = makeEnv();
    expect(() => enforceEmailAllowlist("anyone@anywhere.com", env)).not.toThrow();
  });

  it("permits an email matching ALLOWED_EMAILS exactly (case-insensitive)", () => {
    const env = makeEnv({ ALLOWED_EMAILS: "Alice@Example.com,bob@example.com" });
    expect(() => enforceEmailAllowlist("alice@example.com", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("ALICE@EXAMPLE.COM", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("bob@example.com", env)).not.toThrow();
  });

  it("permits an email under ALLOWED_EMAIL_DOMAINS (case-insensitive)", () => {
    const env = makeEnv({ ALLOWED_EMAIL_DOMAINS: "Acme.test,example.com" });
    expect(() => enforceEmailAllowlist("alice@acme.test", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("alice@ACME.TEST", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("bob@example.com", env)).not.toThrow();
  });

  it("permits when either ALLOWED_EMAILS or ALLOWED_EMAIL_DOMAINS matches", () => {
    const env = makeEnv({
      ALLOWED_EMAILS: "external@partner.io",
      ALLOWED_EMAIL_DOMAINS: "acme.test",
    });
    expect(() => enforceEmailAllowlist("alice@acme.test", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("external@partner.io", env)).not.toThrow();
  });

  it("throws AuthError(403) when neither list matches", () => {
    const env = makeEnv({ ALLOWED_EMAIL_DOMAINS: "acme.test" });
    try {
      enforceEmailAllowlist("attacker@evil.com", env);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
    }
  });

  it("treats malformed emails (no @) as denied when an allowlist is configured", () => {
    const env = makeEnv({ ALLOWED_EMAIL_DOMAINS: "acme.test" });
    expect(() => enforceEmailAllowlist("not-an-email", env)).toThrow(AuthError);
  });

  it("trims whitespace and ignores empty entries in the lists", () => {
    const env = makeEnv({
      ALLOWED_EMAILS: " alice@example.com , , bob@example.com ",
    });
    expect(() => enforceEmailAllowlist("alice@example.com", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("bob@example.com", env)).not.toThrow();
    expect(() => enforceEmailAllowlist("eve@example.com", env)).toThrow(AuthError);
  });
});
