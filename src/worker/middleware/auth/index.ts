/**
 * Auth provider extension point — see ADR 0006 and
 * `.cursor/skills/auth-providers/SKILL.md`.
 */

export { enforceEmailAllowlist } from "./allowlist.js";
export { CloudflareAccessProvider } from "./cloudflare-access.js";
export { DevHeaderProvider } from "./dev-header.js";
export { _resetAuthProviderCacheForTests, type AuthMode, createAuthProvider } from "./factory.js";
export type { AuthContext, AuthProvider, IdentityClaims } from "./types.js";
export { AuthError } from "./types.js";
