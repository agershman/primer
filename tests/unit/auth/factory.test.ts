/**
 * Tests for the auth-provider factory.
 *
 * Bug class this prevents
 * -----------------------
 * The factory is the single point that decides which provider
 * production runs. Two failure modes are dangerous:
 *
 *   1. Default mode silently bypasses Cloudflare Access. Pre-
 *      refactor, omitting `PRIMER_AUTH_MODE` would still accept
 *      `PRIMER_DEV_USER` env vars in production. The test
 *      "Default mode is cloudflare-access" pins the safe default.
 *
 *   2. Required CF Access vars missing produce a soft fallback.
 *      The factory MUST throw when `cloudflare-access` mode is
 *      selected without `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD`,
 *      so a misconfigured deploy fails closed at first request
 *      rather than silently accepting any JWT.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  CloudflareAccessProvider,
  DevHeaderProvider,
  _resetAuthProviderCacheForTests,
  createAuthProvider,
} from "../../../src/worker/middleware/auth";
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

beforeEach(() => {
  _resetAuthProviderCacheForTests();
});

describe("createAuthProvider", () => {
  it("defaults to cloudflare-access mode when PRIMER_AUTH_MODE is unset", () => {
    const env = makeEnv({
      CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud-123",
    });
    const provider = createAuthProvider(env);
    expect(provider).toBeInstanceOf(CloudflareAccessProvider);
    expect(provider.name).toBe("cloudflare-access");
  });

  it("throws when cloudflare-access mode is selected without CF_ACCESS_TEAM_DOMAIN", () => {
    const env = makeEnv({
      PRIMER_AUTH_MODE: "cloudflare-access",
      CF_ACCESS_AUD: "aud-123",
    });
    expect(() => createAuthProvider(env)).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
  });

  it("throws when cloudflare-access mode is selected without CF_ACCESS_AUD", () => {
    const env = makeEnv({
      PRIMER_AUTH_MODE: "cloudflare-access",
      CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    });
    expect(() => createAuthProvider(env)).toThrow(/CF_ACCESS_AUD/);
  });

  it("throws naming both missing CF Access vars when neither is set", () => {
    const env = makeEnv({ PRIMER_AUTH_MODE: "cloudflare-access" });
    try {
      createAuthProvider(env);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/CF_ACCESS_TEAM_DOMAIN/);
      expect((err as Error).message).toMatch(/CF_ACCESS_AUD/);
    }
  });

  it("builds a DevHeaderProvider when PRIMER_AUTH_MODE=dev-header", () => {
    const env = makeEnv({
      PRIMER_AUTH_MODE: "dev-header",
      PRIMER_DEV_USER: "dev@acme.test",
    });
    const provider = createAuthProvider(env);
    expect(provider).toBeInstanceOf(DevHeaderProvider);
    expect(provider.name).toBe("dev-header");
  });

  it("throws on an unknown PRIMER_AUTH_MODE value", () => {
    const env = makeEnv({
      PRIMER_AUTH_MODE: "magic-link" as unknown as Env["PRIMER_AUTH_MODE"],
    });
    expect(() => createAuthProvider(env)).toThrow(/Unknown PRIMER_AUTH_MODE/);
  });

  it("caches the provider across calls (warm-isolate optimization)", () => {
    const env = makeEnv({
      CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud-123",
    });
    const first = createAuthProvider(env);
    const second = createAuthProvider(env);
    expect(second).toBe(first);
  });

  it("accepts comma-separated CF_ACCESS_AUD values for multi-AUD deploys", () => {
    // Pages -> Worker service binding: the JWT carries the Pages
    // app's AUD, but the worker may also be reachable via its own
    // Access app. Comma-separated AUDs let one config cover both.
    const env = makeEnv({
      CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud-pages, aud-api ,aud-preview",
    });
    const provider = createAuthProvider(env);
    expect(provider).toBeInstanceOf(CloudflareAccessProvider);
  });
});
