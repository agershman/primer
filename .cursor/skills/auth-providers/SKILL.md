---
name: auth-providers
description: >-
  Add or modify auth providers in Primer's identity-resolution
  layer. Covers the AuthProvider interface, the email allowlist
  contract, the fail-closed factory, and the source-text contract
  tests every provider must add. Use when adding support for a new
  auth proxy (oauth2-proxy, Pomerium, Tailscale Serve, nginx +
  OIDC), modifying an existing provider, or working in
  src/worker/middleware/auth/.
---

# Auth Providers

The user wants to add or modify an auth provider:

> $ARGUMENTS

## Architecture

Auth is the **fourth registry-pattern extension point** alongside LLM / TTS / source providers — see [ADR 0006](../../dev-docs/adrs/0006-auth-provider-extension-point.md) and [`dev-docs/architecture.md`](../../dev-docs/architecture.md). The shape mirrors the others: a small interface, two-or-more implementations, and a config-driven factory.

```
src/worker/middleware/auth/
├── types.ts             # AuthProvider, AuthError, type re-exports
├── allowlist.ts         # enforceEmailAllowlist (called by every provider)
├── cloudflare-access.ts # CloudflareAccessProvider (verifies CF Access JWT)
├── dev-header.ts        # DevHeaderProvider (trusted-header path)
├── factory.ts           # createAuthProvider(env) — selects by PRIMER_AUTH_MODE
└── index.ts             # barrel re-exports
```

### The `AuthProvider` contract

```typescript
export interface AuthProvider {
  readonly name: string;
  authenticate(request: Request): Promise<AuthContext>;
}
```

Implementations MUST:

1. **Verify whatever the upstream gives them.** Don't base64-decode and trust — that was the pre-refactor bug. JWT-bearing proxies: verify the signature, audience, issuer, and expiry. Trusted-header proxies: only trust the header that the upstream actually controls (and rely on the upstream to strip client-supplied versions).
2. **Call `enforceEmailAllowlist(email, env)` before returning success.** This is the second line of defense behind the auth proxy and the gate that prevents non-allowlisted callers from capturing admin on a fresh deploy via the first-user-wins bootstrap in `user-context.ts`.
3. **Throw `AuthError`** on every failure path. Use `401` for "we don't know who you are" and `403` for "we know who you are but you're not permitted". The middleware translates these to JSON responses; anything else propagates as a 500.

## Decision tree

1. **Does the upstream proxy mint a JWT (signed, with claims)?** → Build a JWT-verifying provider. Use `jose.jwtVerify` against a JWKS. Pattern-match against `cloudflare-access.ts`.
2. **Does the upstream proxy inject a trusted email header?** (oauth2-proxy `X-Forwarded-Email`, Pomerium `X-Pomerium-Claim-Email`, Tailscale Serve `Tailscale-User-Login`, nginx + OIDC `X-Auth-Request-Email`) → A new mode is usually unnecessary — `DevHeaderProvider` with a configured `PRIMER_DEV_HEADER_NAME` already covers this. Document the recipe in the README rather than building a new provider.
3. **Does it need full OIDC token-fetching from a generic IdP without a proxy?** → That's a meaningfully bigger lift. ADR 0006 lists it as deferred. Open a discussion before building it.

## Step 1 — Build the provider

`src/worker/middleware/auth/<your-provider>.ts`:

```typescript
import type { Env } from "../../types.js";
import { enforceEmailAllowlist } from "./allowlist.js";
import { AuthError, type AuthContext, type AuthProvider } from "./types.js";

export interface YourProviderOptions {
  env: Env;
  // ... whatever your provider needs (team domain, audience, header name, etc.)
}

export class YourProvider implements AuthProvider {
  readonly name = "your-provider";

  private readonly env: Env;
  // ... typed fields

  constructor(options: YourProviderOptions) {
    this.env = options.env;
    // ... initialize from options
  }

  async authenticate(request: Request): Promise<AuthContext> {
    // 1. Extract whatever the upstream gives you (header, JWT).
    //    Throw `new AuthError("...", 401)` if missing or malformed.
    // 2. Verify it. NEVER trust without verifying.
    // 3. Read the email claim. Throw 401 if missing.
    // 4. Call `enforceEmailAllowlist(email, this.env)` — MUST run
    //    before the return below, OR the contract test fails.
    // 5. Return AuthContext.

    enforceEmailAllowlist(email, this.env);
    return { email, identity: { /* your claims */ }, isDev: false };
  }
}
```

## Step 2 — Wire it into the factory

`src/worker/middleware/auth/factory.ts`:

```typescript
export type AuthMode = "cloudflare-access" | "dev-header" | "your-mode";

const SUPPORTED_MODES: AuthMode[] = ["cloudflare-access", "dev-header", "your-mode"];

// Inside createAuthProvider, add the new mode branch BEFORE the
// "Unknown PRIMER_AUTH_MODE" throw. Validate every required env
// var up-front; throw a clear `Error` listing the missing ones so
// a misconfigured deploy fails closed at first request.
if (mode === "your-mode") {
  // validate env, throw with a list of missing vars if needed
  const cacheKey = `your-mode:${...}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return cached;
  const provider = new YourProvider({ env, /* ... */ });
  providerCache.set(cacheKey, provider);
  return provider;
}
```

Re-export from `index.ts`.

## Step 3 — Extend `Env` types

`src/worker/types.ts` — add any new env vars your provider reads to the `Env` interface, with TSDoc comments explaining the purpose. The existing auth vars (`PRIMER_AUTH_MODE`, `CF_ACCESS_*`, `ALLOWED_*`, `PRIMER_DEV_*`) are co-located in the same block.

## Step 4 — Update the wrangler templates

- `wrangler.api.example.toml` — add comments showing how to opt into your mode (placeholder values, NOT real secrets).
- `wrangler.api.toml` — only update if `your-mode` becomes the deployer's posture; otherwise the example is enough.

If your provider reads new secrets (API keys, signing keys), they belong in `wrangler secret put` flows, not `[vars]`. Document the secret-put command in the README's "Runtime secrets" table.

## Step 5 — Tests

You need three test layers — execution, factory, and contract — to match what the existing providers ship:

### Execution test

`tests/unit/auth/<your-provider>.test.ts`

Cover the whole authenticate matrix:

- Happy path with a permitted email.
- Missing whatever-the-upstream-supplies → 401.
- Verification failure (forged token, wrong audience, expired, etc.) → 401.
- Missing email claim → 401.
- Email outside allowlist → 403.

For JWT-verifying providers, use `jose.generateKeyPair` to create an in-test key pair and inject the public key via a `keyResolver` test seam (see `cloudflare-access.test.ts` for the pattern). NEVER hit the network for JWKS in tests.

### Factory test

`tests/unit/auth/factory.test.ts` — extend with cases for your mode:

- `your-mode` selection builds a `YourProvider`.
- Required env vars missing → throws naming them.

### Contract test (source-text, per ADR 0002)

`tests/unit/auth/auth-providers-contract.test.ts` — extend the "provider implementations call enforceEmailAllowlist" describe block to include your provider. Pin the allowlist-call-precedes-success-return ordering. Pin that the factory's `SUPPORTED_MODES` enumerates your new mode.

## Step 6 — Documentation

- **Architecture doc**: add a row to the auth section in [`dev-docs/architecture.md`](../../dev-docs/architecture.md) if your provider materially changes the picture (e.g. introduces a new mode that production deployers will commonly choose).
- **README**: extend the "Bring your own auth proxy" sub-section in `Authentication & authorization` with the recipe for your mode. Include the env vars, the `PRIMER_AUTH_MODE` value, and a one-line summary of which proxies this fits.
- **No new ADR needed** unless your provider introduces a non-obvious architectural decision (e.g. a new dependency, a meaningfully different verification model). Most provider additions are routine — the registry pattern is already documented in ADR 0006.

## Verification checklist

- `bun run typecheck` passes.
- `bun run test:run tests/unit/auth/` passes — includes execution, factory, and contract tests for your provider.
- `bun run lint` passes.
- `tests/unit/auth/auth-providers-contract.test.ts` covers your provider's `enforceEmailAllowlist` call ordering.
- `wrangler.api.example.toml` documents your mode.
- README `Authentication & authorization` section mentions your mode if it's a production-grade addition.

## See also

- [ADR 0006](../../dev-docs/adrs/0006-auth-provider-extension-point.md) — the rationale for the registry shape and the fail-closed factory.
- [`src/worker/middleware/auth/cloudflare-access.ts`](../../src/worker/middleware/auth/cloudflare-access.ts) — canonical JWT-verifying provider.
- [`src/worker/middleware/auth/dev-header.ts`](../../src/worker/middleware/auth/dev-header.ts) — canonical trusted-header provider.
- [`tests/unit/auth/cloudflare-access.test.ts`](../../tests/unit/auth/cloudflare-access.test.ts) — JWKS-injection test pattern.
- ADR 0001 — the registry pattern Primer uses across LLM / TTS / sources / auth.
- ADR 0002 — source-text contract testing for the call-ordering invariants.
