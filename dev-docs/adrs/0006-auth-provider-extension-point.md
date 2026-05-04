# 0006 — Auth provider extension point + Cloudflare Access hardening

**Status:** accepted

## Context

Primer originally resolved the user identity from one ad-hoc function (`getAuth` in `src/worker/middleware/auth.ts`, ~50 lines) that did three things at once:

- Read `Cf-Access-Jwt-Assertion` and base64-decode the payload **without verifying** the signature, audience, issuer, or expiry.
- Fall back to an `X-Primer-Dev-User` header.
- Fall back further to a `PRIMER_DEV_USER` env var.

Three problems compounded:

1. **Security.** No signature verification meant any request reaching the worker via a route that bypassed Cloudflare Access (the default `*.workers.dev` URL with no Access policy attached, a misconfigured policy, etc.) could send any JWT and become any user. The same code path also accepted a `PRIMER_DEV_USER` env-var fallback, so any production wrangler config that set that var (for dev convenience) would silently authenticate every unauthenticated request as that email.
2. **Coupling to Cloudflare.** A deployer running Primer behind a different auth proxy (oauth2-proxy, Pomerium, Tailscale Serve, nginx + OIDC) had to fork the file. The actual contract was small ("resolve a request to an email") but bundled with Cloudflare-specifics.
3. **Coupling to the admin model.** Migration 0002 introduced first-user-wins admin via an atomic `INSERT INTO users ... CASE WHEN COUNT(*) = 0 THEN 1` in `user-context.ts`. Without an allowlist running upstream of that INSERT, a single misconfigured Access policy or exposed workers.dev URL would hand permanent admin to whoever landed first.

Three options were considered:

1. **Inline hardening.** Add JWT verification, `aud` checks, and an allowlist directly inside the existing `getAuth`.
2. **Provider interface + two implementations.** Match the registry pattern Primer already uses for LLM / TTS / source providers. Mode-driven selection via `PRIMER_AUTH_MODE`.
3. **Full OIDC client.** Primer fetches and verifies tokens from a generic OIDC IdP without a proxy in front.

## Decision

Option 2. Auth becomes the **fourth registry-pattern extension point** alongside LLM / TTS / source providers (see [`dev-docs/architecture.md`](../architecture.md)'s "three registries" framing). The shape:

- `AuthProvider` interface (`src/worker/middleware/auth/types.ts`) — `name` + `authenticate(request: Request): Promise<AuthContext>`.
- `CloudflareAccessProvider` — verifies the `Cf-Access-Jwt-Assertion` JWT against Cloudflare Access's JWKS via `jose.jwtVerify` (signature + `iss` + `aud` + `exp` + `nbf`), then reads the `email` claim.
- `DevHeaderProvider` — reads a configured trusted-header (default `X-Primer-Dev-User`, override via `PRIMER_DEV_HEADER_NAME`). Used both for local dev and for non-Cloudflare deployments behind a different auth proxy.
- `enforceEmailAllowlist` — invoked inside every provider's `authenticate` before returning success. Reads `ALLOWED_EMAILS` and `ALLOWED_EMAIL_DOMAINS` from env. Permissive only when both are unset (documented hobbyist mode).
- `createAuthProvider(env)` — selects a provider based on `PRIMER_AUTH_MODE`. Defaults to `cloudflare-access`. Throws when the required CF Access vars are missing — fail-closed at first request.

The middleware (`user-context.ts`) calls `provider.authenticate(...)` BEFORE the admin-bootstrap INSERT, so the allowlist is the gate that prevents non-allowlisted callers from capturing admin.

## Consequences

**Wins:**

- **Hardened production posture by default.** Omitting `PRIMER_AUTH_MODE` selects `cloudflare-access`, which requires real JWT verification. There's no soft-fall-back path where a misconfigured deploy silently runs in dev mode.
- **Portability for non-Cloudflare deployers.** A new provider (`OAuth2ProxyProvider`, `TailscaleServeProvider`, etc.) is a single file plus a factory case — same shape as adding an LLM or source provider.
- **Allowlist is the single source of truth for "who can use this deployment".** Independent of the upstream proxy's policy, so a misconfigured Access policy can't silently let strangers in.
- **Testability.** The provider boundary is small and easy to mock. JWT verification is exercised end-to-end in tests via a test-only `keyResolver` injection seam.
- **Removes the production footgun.** `PRIMER_DEV_USER` no longer has any effect when `PRIMER_AUTH_MODE=cloudflare-access`. Setting it accidentally in `wrangler.api.toml` is now harmless rather than a silent auth bypass.

**Losses:**

- **One new dependency** (`jose`, ~9 KB gzipped, the de-facto JWT library for Workers).
- **Breaking config change.** Existing deployments must add `PRIMER_AUTH_MODE`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (and optionally `ALLOWED_EMAIL_DOMAINS`) before the next deploy. Without them the worker fails closed at first request — intentional, since silent fall-back was the prior bug.
- **Async authenticate.** `getAuth` was sync; `authenticate` is async because JWT verification is. This rippled into the calling middleware (which was already async, so no harm).

## Alternatives considered

- **Option 1 (inline hardening).** Rejected. Smaller diff, but the result still bundles Cloudflare-specifics with the dev-mode fallback in one function — a future "add oauth2-proxy support" change would have to revisit the whole file. The registry shape buys portability at roughly the same cost.
- **Option 3 (full OIDC client).** Rejected for now. The `DevHeaderProvider` (with a configurable header name) covers all "trusted upstream proxy" deployments — oauth2-proxy, Pomerium, Tailscale Serve, nginx + OIDC. A real OIDC client (Primer fetches and verifies tokens from a generic IdP without a proxy) is a meaningfully bigger change and not currently needed. Worth revisiting if a real deployer asks for it.
- **Hand-rolled WebCrypto JWT verifier.** Considered for zero new deps. Declined — JWT verification is exactly the kind of thing where rolling your own is a smell unless there's a strong reason not to.
- **Selecting providers via a TS-side constant rather than env var.** Rejected — env-driven selection lets the same artifact run in both modes (production CF Access, local dev-header) without rebuilding.

## See also

- `src/worker/middleware/auth/factory.ts` — the registry entry point.
- `.cursor/skills/auth-providers/SKILL.md` — agent-friendly guide for adding a new provider.
- `tests/unit/auth/auth-providers-contract.test.ts` — pins the allowlist-before-bootstrap invariant and the fail-closed factory.
- ADR 0001 — explains the registry pattern Primer uses for LLM / TTS / sources.
- ADR 0002 — source-text contract testing, used here for the call-ordering invariant.
- ADR 0004 — why these auth types live in `src/worker/middleware/auth/` rather than `src/shared/types.ts`.
