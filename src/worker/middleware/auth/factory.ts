/**
 * Auth provider factory — picks an `AuthProvider` based on
 * `PRIMER_AUTH_MODE` and fails closed when required vars are
 * missing.
 *
 * Default is `cloudflare-access` (production posture). Production
 * deployments that omit `PRIMER_AUTH_MODE` therefore get the
 * hardened path; switching to dev mode requires setting
 * `PRIMER_AUTH_MODE=dev-header` explicitly. This is the design
 * choice that removes the prior footgun where a `PRIMER_DEV_USER`
 * env var would silently bypass Cloudflare Access.
 *
 * Module-scope cache: providers are stateless after construction
 * but `CloudflareAccessProvider` lazily fetches JWKS, so we keep
 * one instance per warm isolate per (mode, teamDomain, audience).
 *
 * Adding a new auth mode? Read
 * `.cursor/skills/auth-providers/SKILL.md`.
 */

import type { Env } from "../../types.js";
import { CloudflareAccessProvider } from "./cloudflare-access.js";
import { DevHeaderProvider } from "./dev-header.js";
import type { AuthProvider } from "./types.js";

export type AuthMode = "cloudflare-access" | "dev-header";

const SUPPORTED_MODES: AuthMode[] = ["cloudflare-access", "dev-header"];

const providerCache = new Map<string, AuthProvider>();

export function createAuthProvider(env: Env): AuthProvider {
  const mode = (env.PRIMER_AUTH_MODE ?? "cloudflare-access") as AuthMode;

  if (mode === "cloudflare-access") {
    const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
    const audienceRaw = env.CF_ACCESS_AUD;
    const missing: string[] = [];
    if (!teamDomain) missing.push("CF_ACCESS_TEAM_DOMAIN");
    if (!audienceRaw) missing.push("CF_ACCESS_AUD");
    if (missing.length > 0 || !teamDomain || !audienceRaw) {
      throw new Error(
        `[auth] PRIMER_AUTH_MODE=cloudflare-access requires ${missing.join(", ")}. ` +
          `Set them in wrangler.api.toml [vars] (or .dev.vars locally).`,
      );
    }
    // CF_ACCESS_AUD accepts comma-separated AUDs to handle the
    // Pages-to-Worker binding case where the worker may receive
    // JWTs minted for either the Pages app or the worker's own
    // Access app. `jose.jwtVerify` matches if any AUD in the array
    // passes.
    const audience = parseAudience(audienceRaw);
    const cacheKey = `cloudflare-access:${teamDomain}:${audienceRaw}`;
    const cached = providerCache.get(cacheKey);
    if (cached) return cached;
    const provider = new CloudflareAccessProvider({ teamDomain, audience, env });
    providerCache.set(cacheKey, provider);
    return provider;
  }

  if (mode === "dev-header") {
    const headerName = env.PRIMER_DEV_HEADER_NAME ?? "X-Primer-Dev-User";
    const envFallbackEmail = env.PRIMER_DEV_USER;
    const cacheKey = `dev-header:${headerName}:${envFallbackEmail ?? ""}`;
    const cached = providerCache.get(cacheKey);
    if (cached) return cached;
    const provider = new DevHeaderProvider({ env, headerName, envFallbackEmail });
    providerCache.set(cacheKey, provider);
    return provider;
  }

  throw new Error(`[auth] Unknown PRIMER_AUTH_MODE="${mode}". Supported modes: ${SUPPORTED_MODES.join(", ")}.`);
}

/**
 * Test-only — clears the module-scope provider cache so tests can
 * exercise factory branches independently.
 */
export function _resetAuthProviderCacheForTests(): void {
  providerCache.clear();
}

function parseAudience(raw: string): string | string[] {
  const parts = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parts.length === 0) {
    throw new Error(`[auth] CF_ACCESS_AUD parsed to empty list — check the value in wrangler vars`);
  }
  return parts.length === 1 ? parts[0] : parts;
}
