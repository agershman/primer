/**
 * Email allowlist — the second line of defense behind whatever auth
 * proxy fronts Primer.
 *
 * Why this exists
 * ---------------
 * The provider in front of us (Cloudflare Access, oauth2-proxy, etc.)
 * is responsible for proving the caller controls an email address.
 * The allowlist is responsible for deciding whether THAT email is
 * permitted to use this deployment.
 *
 * Defense in depth, not redundancy:
 *   - Cloudflare Access policies CAN enforce a domain match, but
 *     mistakes happen — adding a public IdP without a domain rule,
 *     pasting the wrong policy onto a new app, etc.
 *   - The allowlist is one env var away and runs server-side, so a
 *     single misconfigured Access policy doesn't hand admin to a
 *     stranger.
 *   - On a fresh deploy, the FIRST authenticated user becomes
 *     deployment admin via the atomic INSERT-SELECT in
 *     `user-context.ts`. The allowlist runs upstream of that
 *     INSERT, which is what makes it safe to keep auto-provisioning.
 *
 * Configuration
 * -------------
 *   - `ALLOWED_EMAILS` — comma-separated explicit emails. Matched
 *     case-insensitively for equality.
 *   - `ALLOWED_EMAIL_DOMAINS` — comma-separated bare domains.
 *     Matched case-insensitively against the `@<domain>` portion of
 *     the email.
 *
 * Either match passes. If BOTH are unset the allowlist is fully
 * permissive — documented mode for hobbyist / single-user installs.
 * Production deployments should set at least one.
 */

import type { Env } from "../../types.js";
import { AuthError } from "./types.js";

/**
 * Throws `AuthError(403)` if the email isn't permitted by the
 * configured allowlist. No-op when both env vars are unset.
 */
export function enforceEmailAllowlist(email: string, env: Env): void {
  const explicitList = parseList(env.ALLOWED_EMAILS);
  const domainList = parseList(env.ALLOWED_EMAIL_DOMAINS);

  if (explicitList.length === 0 && domainList.length === 0) {
    return;
  }

  const normalized = email.toLowerCase();
  if (explicitList.includes(normalized)) {
    return;
  }

  const at = normalized.lastIndexOf("@");
  const domain = at >= 0 ? normalized.slice(at + 1) : "";
  if (domain && domainList.includes(domain)) {
    return;
  }

  throw new AuthError("Forbidden", 403);
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}
