/**
 * Cloudflare Access auth provider.
 *
 * Verifies the `Cf-Access-Jwt-Assertion` header that Cloudflare
 * Access mints at the edge after the user's SSO. We re-verify
 * server-side rather than trusting the header blindly because:
 *
 *   1. If the worker is reachable on `*.workers.dev` or any route
 *      that bypasses Access (a common ops-misconfig), a client can
 *      send any JWT they like as that header. Signature verification
 *      blocks that path.
 *
 *   2. Access JWTs carry an `aud` (audience) tag specific to the
 *      Access application. Without `aud` checking, a JWT issued for
 *      a DIFFERENT Access app on the same Cloudflare team would
 *      validate as "real CF Access JWT" and impersonate the user.
 *
 *   3. The `exp` / `nbf` checks are free once we're verifying;
 *      `jose`'s `jwtVerify` handles all four (signature, iss, aud,
 *      exp) in one call.
 *
 * JWKS comes from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
 * The issuer claim is `https://<team>.cloudflareaccess.com`. Both
 * are derived from the configured team domain.
 *
 * Adding a new auth provider? Read
 * `.cursor/skills/auth-providers/SKILL.md`.
 */

import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Env } from "../../types.js";
import { enforceEmailAllowlist } from "./allowlist.js";
import { type AuthContext, AuthError, type AuthProvider, type IdentityClaims } from "./types.js";

const JWT_HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Module-scope JWKS cache so warm isolates skip the JWKS fetch on
 * every request. Keyed by team domain — practically there's only
 * ever one entry, but keeping a map keeps tests honest if they
 * spin up two providers with different domains.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

export interface CloudflareAccessProviderOptions {
  teamDomain: string;
  /**
   * Accepted AUD tag(s). Pass a single string for the typical case,
   * or an array when the worker is reachable through multiple
   * Access applications — common with Pages → Worker service
   * bindings, where the JWT is minted for the Pages app's AUD but
   * the worker may also be reachable directly via its own
   * `*.workers.dev` / custom-domain Access app. `jose.jwtVerify`
   * accepts an array and matches if any entry passes.
   */
  audience: string | string[];
  env: Env;
  /**
   * Test-only seam — pass an in-memory key resolver to avoid
   * hitting the network. In production, the default
   * `createRemoteJWKSet` is used.
   */
  keyResolver?: JWTVerifyGetKey;
}

export class CloudflareAccessProvider implements AuthProvider {
  readonly name = "cloudflare-access";

  private readonly teamDomain: string;
  private readonly audience: string | string[];
  private readonly issuer: string;
  private readonly env: Env;
  private readonly keyResolver: JWTVerifyGetKey;

  constructor(options: CloudflareAccessProviderOptions) {
    this.teamDomain = options.teamDomain;
    this.audience = options.audience;
    this.issuer = `https://${options.teamDomain}`;
    this.env = options.env;
    this.keyResolver = options.keyResolver ?? resolveJwks(options.teamDomain);
  }

  async authenticate(request: Request): Promise<AuthContext> {
    const jwt = request.headers.get(JWT_HEADER);
    if (!jwt) {
      throw new AuthError("Missing Cf-Access-Jwt-Assertion header", 401);
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(jwt, this.keyResolver, {
        issuer: this.issuer,
        audience: this.audience,
      }));
    } catch (err) {
      // Don't leak the underlying jose error reason — surfaces
      // via console for ops, 401 to the client.
      console.warn("[auth/cloudflare-access] JWT verification failed:", err);
      throw new AuthError("Invalid Cloudflare Access JWT", 401);
    }

    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) {
      throw new AuthError("Cloudflare Access JWT missing email claim", 401);
    }

    enforceEmailAllowlist(email, this.env);

    const identity: IdentityClaims = {
      email,
      sub: typeof payload.sub === "string" ? payload.sub : null,
      iat: typeof payload.iat === "number" ? payload.iat : null,
      exp: typeof payload.exp === "number" ? payload.exp : null,
      country: typeof payload.country === "string" ? payload.country : null,
      type: typeof payload.type === "string" ? payload.type : "access",
      iss: typeof payload.iss === "string" ? payload.iss : null,
    };

    return { email, identity, isDev: false };
  }
}

function resolveJwks(teamDomain: string): JWTVerifyGetKey {
  const cached = jwksCache.get(teamDomain);
  if (cached) return cached;
  const resolver = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
  jwksCache.set(teamDomain, resolver);
  return resolver;
}
