/**
 * AuthProvider extension point — see ADR 0006.
 *
 * Primer's identity-resolution layer is the fourth registry-pattern
 * extension point alongside LLM / TTS / source providers. Each
 * provider knows how to extract a verified user identity from an
 * incoming request:
 *
 *   - `CloudflareAccessProvider` verifies a `Cf-Access-Jwt-Assertion`
 *     JWT against Cloudflare Access's JWKS (signature + iss + aud +
 *     exp + nbf), then reads the `email` claim.
 *   - `DevHeaderProvider` reads a configured trusted-header (default
 *     `X-Primer-Dev-User`) — for local dev or for non-Cloudflare
 *     deployments that put oauth2-proxy / Pomerium / Tailscale Serve
 *     in front and have it inject an email header.
 *
 * Both providers MUST call `enforceEmailAllowlist(email, env)` before
 * returning success. The middleware then runs the admin-bootstrap
 * INSERT in `user-context.ts`, so the allowlist is the gate that
 * prevents a non-allowlisted caller from becoming the bootstrap admin
 * on a fresh deploy.
 *
 * Adding a new provider? Read `.cursor/skills/auth-providers/SKILL.md`.
 */

import type { AuthContext, IdentityClaims } from "../../types.js";

export type { AuthContext, IdentityClaims };

/**
 * Resolves a request to an authenticated identity. Implementations
 * MUST verify whatever the upstream auth proxy gives them (don't
 * trust headers blindly), MUST apply `enforceEmailAllowlist` before
 * returning success, and MUST throw `AuthError` on any failure path
 * so the middleware translates it to a 401 / 403 response.
 */
export interface AuthProvider {
  /** Stable identifier — surfaces in logs and the `/api/me` debug payload. */
  readonly name: string;
  authenticate(request: Request): Promise<AuthContext>;
}

/**
 * Thrown by providers (and the allowlist helper) on any
 * authentication / authorization failure. The `userContext`
 * middleware catches these and converts to JSON responses. Any
 * other thrown error propagates as a 500.
 */
export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}
