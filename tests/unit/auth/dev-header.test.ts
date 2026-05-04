/**
 * Tests for the dev / trusted-header auth provider.
 *
 * Used in two contexts:
 *   - Local development with `wrangler dev` + vite dev proxy.
 *   - Non-Cloudflare deployments where an upstream auth proxy
 *     (oauth2-proxy, Pomerium, Tailscale Serve) injects a trusted
 *     email header.
 *
 * The provider intentionally trusts the configured header; the
 * factory only ever instantiates it when
 * `PRIMER_AUTH_MODE=dev-header` is set explicitly. Tests pin the
 * header-name override path and the env-fallback path used when
 * hitting the worker directly (no vite proxy in front).
 */

import { describe, expect, it } from "vitest";
import { DevHeaderProvider } from "../../../src/worker/middleware/auth/dev-header";
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

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/test", { headers: new Headers(headers) });
}

describe("DevHeaderProvider", () => {
  it("reads the default X-Primer-Dev-User header", async () => {
    const provider = new DevHeaderProvider({ env: makeEnv() });
    const auth = await provider.authenticate(
      makeRequest({ "X-Primer-Dev-User": "dev@acme.test" }),
    );
    expect(auth.email).toBe("dev@acme.test");
    expect(auth.isDev).toBe(true);
    expect(auth.identity.type).toBe("dev");
  });

  it("reads a custom header when one is configured (oauth2-proxy / Pomerium / Tailscale)", async () => {
    const provider = new DevHeaderProvider({
      env: makeEnv(),
      headerName: "X-Forwarded-Email",
    });
    const auth = await provider.authenticate(
      makeRequest({ "X-Forwarded-Email": "user@partner.io" }),
    );
    expect(auth.email).toBe("user@partner.io");
    expect(auth.isDev).toBe(true);
  });

  it("falls back to envFallbackEmail when the header is absent", async () => {
    const provider = new DevHeaderProvider({
      env: makeEnv(),
      envFallbackEmail: "fallback@acme.test",
    });
    const auth = await provider.authenticate(makeRequest());
    expect(auth.email).toBe("fallback@acme.test");
    expect(auth.isDev).toBe(true);
  });

  it("throws 401 when neither header nor envFallbackEmail is set", async () => {
    const provider = new DevHeaderProvider({ env: makeEnv() });
    try {
      await provider.authenticate(makeRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("throws 403 when the email is outside the allowlist", async () => {
    const provider = new DevHeaderProvider({
      env: makeEnv({ ALLOWED_EMAIL_DOMAINS: "acme.test" }),
    });
    try {
      await provider.authenticate(
        makeRequest({ "X-Primer-Dev-User": "attacker@evil.com" }),
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
    }
  });
});
