// @vitest-environment node
/**
 * Tests for `CloudflareAccessProvider`.
 *
 * Bug class this prevents
 * -----------------------
 * Pre-refactor, the worker base64-decoded the JWT payload without
 * verifying the signature, audience, or expiry. Anyone reaching
 * the worker via a route that bypassed Cloudflare Access (e.g.
 * the default `*.workers.dev` URL) could send any JWT they liked
 * as `Cf-Access-Jwt-Assertion` and become any user. These tests
 * pin the four guarantees `jose.jwtVerify` gives us — signature,
 * `iss`, `aud`, `exp` — plus the email-claim + allowlist gate.
 *
 * Strategy
 * --------
 * Generate a real RSA key pair in-test, sign JWTs with it, and
 * inject the public key via the `keyResolver` test seam so the
 * provider verifies the signature without going to the network
 * for JWKS. This exercises the same code path production uses.
 */

import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { CloudflareAccessProvider } from "../../../src/worker/middleware/auth/cloudflare-access";
import { AuthError } from "../../../src/worker/middleware/auth/types";
import type { Env } from "../../../src/worker/types";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "test-audience-tag";

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

let signingPrivateKey: CryptoKey;
let goodKeyResolver: JWTVerifyGetKey;
let wrongKeyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const validPair = await generateKeyPair("RS256");
  signingPrivateKey = validPair.privateKey;
  const validPublicJwk = await exportJWK(validPair.publicKey);
  validPublicJwk.kid = "valid-kid";
  validPublicJwk.alg = "RS256";

  // A different key pair represents "JWKS doesn't have a public
  // key matching this signature" — the wrong-signature scenario.
  const otherPair = await generateKeyPair("RS256");
  const otherPublicJwk = await exportJWK(otherPair.publicKey);
  otherPublicJwk.kid = "valid-kid";
  otherPublicJwk.alg = "RS256";

  goodKeyResolver = async () => importJWK(validPublicJwk, "RS256");
  wrongKeyResolver = async () => importJWK(otherPublicJwk, "RS256");
});

interface SignOptions {
  email?: string;
  audience?: string;
  issuer?: string;
  /** Seconds offset from now; negative = expired. */
  expirationOffsetSeconds?: number;
  extraClaims?: Record<string, unknown>;
}

async function signTestJwt(options: SignOptions = {}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + (options.expirationOffsetSeconds ?? 600);
  const builder = new SignJWT({
    ...(options.email !== undefined ? { email: options.email } : {}),
    sub: "user-sub-123",
    country: "US",
    type: "access",
    ...options.extraClaims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "valid-kid" })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(exp);
  return builder.sign(signingPrivateKey);
}

describe("CloudflareAccessProvider", () => {
  it("returns AuthContext for a valid signed JWT with a permitted email", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({ email: "user@acme.test" });
    const auth = await provider.authenticate(
      makeRequest({ "Cf-Access-Jwt-Assertion": jwt }),
    );
    expect(auth.email).toBe("user@acme.test");
    expect(auth.isDev).toBe(false);
    expect(auth.identity.email).toBe("user@acme.test");
    expect(auth.identity.sub).toBe("user-sub-123");
    expect(auth.identity.type).toBe("access");
    expect(auth.identity.iss).toBe(ISSUER);
  });

  it("throws 401 when the Cf-Access-Jwt-Assertion header is missing", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    try {
      await provider.authenticate(makeRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("throws 401 on signature mismatch (forged JWT)", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: wrongKeyResolver,
    });
    const jwt = await signTestJwt({ email: "user@acme.test" });
    try {
      await provider.authenticate(makeRequest({ "Cf-Access-Jwt-Assertion": jwt }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("throws 401 when the audience claim doesn't match the configured AUD", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({ email: "user@acme.test", audience: "wrong-aud" });
    try {
      await provider.authenticate(makeRequest({ "Cf-Access-Jwt-Assertion": jwt }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("throws 401 when the issuer claim doesn't match the configured team domain", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({
      email: "user@acme.test",
      issuer: "https://attacker.cloudflareaccess.com",
    });
    try {
      await provider.authenticate(makeRequest({ "Cf-Access-Jwt-Assertion": jwt }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("throws 401 when the JWT has expired", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({
      email: "user@acme.test",
      expirationOffsetSeconds: -120,
    });
    try {
      await provider.authenticate(makeRequest({ "Cf-Access-Jwt-Assertion": jwt }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("throws 401 when the JWT lacks an email claim", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({});
    try {
      await provider.authenticate(makeRequest({ "Cf-Access-Jwt-Assertion": jwt }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
    }
  });

  it("accepts a JWT whose AUD matches any entry in a multi-AUD list", async () => {
    // Pages -> Worker service binding: the JWT carries the Pages
    // app's AUD, but the worker may also be reachable via its own
    // Access app (direct workers.dev / custom domain hits). The
    // provider must accept any AUD in the list.
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: ["other-aud", AUDIENCE, "third-aud"],
      env: makeEnv(),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({ email: "user@acme.test" });
    const auth = await provider.authenticate(
      makeRequest({ "Cf-Access-Jwt-Assertion": jwt }),
    );
    expect(auth.email).toBe("user@acme.test");
  });

  it("throws 403 when the email is outside the configured allowlist", async () => {
    const provider = new CloudflareAccessProvider({
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      env: makeEnv({ ALLOWED_EMAIL_DOMAINS: "acme.test" }),
      keyResolver: goodKeyResolver,
    });
    const jwt = await signTestJwt({ email: "stranger@evil.com" });
    try {
      await provider.authenticate(makeRequest({ "Cf-Access-Jwt-Assertion": jwt }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
    }
  });
});
