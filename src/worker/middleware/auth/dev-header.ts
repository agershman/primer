/**
 * Dev / trusted-header auth provider.
 *
 * Reads an email from a configured "trusted upstream" header. Two
 * uses:
 *
 *   1. Local development. Vite's dev proxy injects
 *      `X-Primer-Dev-User` so `bun run dev` works without going
 *      through Cloudflare Access.
 *
 *   2. Non-Cloudflare deployments. A deployer running Primer
 *      behind oauth2-proxy / Pomerium / Tailscale Serve / nginx +
 *      OIDC configures `PRIMER_DEV_HEADER_NAME` to whatever email
 *      header their proxy sets (e.g. `X-Forwarded-Email`,
 *      `X-Pomerium-Claim-Email`, `Tailscale-User-Login`) and runs
 *      with `PRIMER_AUTH_MODE=dev-header`.
 *
 * This provider intentionally trusts the configured header — the
 * security model is that the upstream proxy strips any
 * client-supplied version of the header before forwarding. The
 * factory will only build this provider when
 * `PRIMER_AUTH_MODE=dev-header` is set explicitly, so it can never
 * be the default and never silently fall back.
 *
 * `PRIMER_DEV_USER` env fallback exists so a local dev can hit the
 * worker via `wrangler dev` directly (no vite proxy in front) and
 * still get an authenticated session.
 *
 * Adding a new auth provider? Read
 * `.cursor/skills/auth-providers/SKILL.md`.
 */

import type { Env } from "../../types.js";
import { enforceEmailAllowlist } from "./allowlist.js";
import { type AuthContext, AuthError, type AuthProvider } from "./types.js";

const DEFAULT_HEADER = "X-Primer-Dev-User";

export interface DevHeaderProviderOptions {
  env: Env;
  /** Header name to read. Defaults to `X-Primer-Dev-User`. */
  headerName?: string;
  /** Fallback email when the header is absent (for `wrangler dev` direct hits). */
  envFallbackEmail?: string;
}

export class DevHeaderProvider implements AuthProvider {
  readonly name = "dev-header";

  private readonly env: Env;
  private readonly headerName: string;
  private readonly envFallbackEmail: string | undefined;

  constructor(options: DevHeaderProviderOptions) {
    this.env = options.env;
    this.headerName = options.headerName ?? DEFAULT_HEADER;
    this.envFallbackEmail = options.envFallbackEmail;
  }

  async authenticate(request: Request): Promise<AuthContext> {
    const headerEmail = request.headers.get(this.headerName) ?? undefined;
    const email = headerEmail || this.envFallbackEmail;
    if (!email) {
      throw new AuthError(`Missing ${this.headerName} header`, 401);
    }

    enforceEmailAllowlist(email, this.env);

    return {
      email,
      identity: { email, type: "dev" },
      isDev: true,
    };
  }
}
