/**
 * Source-text contract tests for the AuthProvider extension point —
 * see ADR 0002 for the rationale, ADR 0006 for the contract.
 *
 * These tests pin invariants that execution tests can't easily
 * reach:
 *
 *   1. Every provider implementation calls `enforceEmailAllowlist`
 *      before returning success. Forgetting this would silently
 *      remove the second line of defense behind the auth proxy.
 *
 *   2. The factory fails closed — it throws when the required
 *      Cloudflare Access vars are missing rather than soft-falling
 *      back to a permissive mode.
 *
 *   3. The `userContext` middleware calls `provider.authenticate(...)`
 *      BEFORE the admin-bootstrap INSERT in `users`. This is the
 *      load-bearing security invariant: the allowlist runs inside
 *      `authenticate`, so reversing the call order would let a
 *      non-allowlisted attacker on a fresh deploy capture admin.
 *
 *   4. The factory's `switch` enumerates exactly the supported
 *      modes — a future addition that forgets to update this test
 *      surfaces immediately.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("AuthProvider — provider implementations call enforceEmailAllowlist", () => {
  it("CloudflareAccessProvider calls enforceEmailAllowlist before returning success", async () => {
    const src = await read("src/worker/middleware/auth/cloudflare-access.ts");
    expect(src).toMatch(/enforceEmailAllowlist\(email,\s*this\.env\)/);
    // Allowlist call must precede the AuthContext return so a
    // non-allowlisted email never escapes the provider.
    const allowlistIdx = src.indexOf("enforceEmailAllowlist");
    const returnIdx = src.indexOf("return { email, identity");
    expect(allowlistIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(-1);
    expect(allowlistIdx).toBeLessThan(returnIdx);
  });

  it("DevHeaderProvider calls enforceEmailAllowlist before returning success", async () => {
    const src = await read("src/worker/middleware/auth/dev-header.ts");
    expect(src).toMatch(/enforceEmailAllowlist\(email,\s*this\.env\)/);
    const allowlistIdx = src.indexOf("enforceEmailAllowlist");
    const returnIdx = src.indexOf("return {");
    expect(allowlistIdx).toBeLessThan(returnIdx);
  });
});

describe("AuthProvider factory — fail-closed contract", () => {
  it("createAuthProvider throws when CF_ACCESS_TEAM_DOMAIN is missing in cloudflare-access mode", async () => {
    const src = await read("src/worker/middleware/auth/factory.ts");
    expect(src).toMatch(/CF_ACCESS_TEAM_DOMAIN/);
    expect(src).toMatch(/CF_ACCESS_AUD/);
    // The error message must list the missing vars so misconfigured
    // deploys produce an actionable startup failure.
    expect(src).toMatch(/throw new Error\([\s\S]{0,400}missing\.join/);
  });

  it("createAuthProvider's switch enumerates exactly the supported modes", async () => {
    const src = await read("src/worker/middleware/auth/factory.ts");
    expect(src).toMatch(/SUPPORTED_MODES[\s\S]{0,200}"cloudflare-access"[\s\S]{0,80}"dev-header"/);
    // The factory must throw on unknown modes — defense against a
    // typo in wrangler vars that would otherwise silently pick one.
    expect(src).toMatch(/Unknown PRIMER_AUTH_MODE/);
  });

  it("default mode is cloudflare-access (the safe production posture)", async () => {
    const src = await read("src/worker/middleware/auth/factory.ts");
    expect(src).toMatch(/PRIMER_AUTH_MODE\s*\?\?\s*"cloudflare-access"/);
  });
});

describe("user-context middleware — allowlist runs before admin bootstrap", () => {
  it("calls provider.authenticate BEFORE the INSERT INTO users statement", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    const authenticateIdx = src.indexOf("provider.authenticate");
    const insertIdx = src.indexOf("INSERT INTO users");
    expect(authenticateIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(authenticateIdx).toBeLessThan(insertIdx);
  });

  it("propagates AuthError as a 401-or-403 JSON response", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    expect(src).toMatch(/err instanceof AuthError/);
    expect(src).toMatch(/err\.status as 401 \| 403/);
  });
});

describe("AuthProvider extension point — registry shape parity", () => {
  it("the auth/ barrel re-exports the public surface", async () => {
    const src = await read("src/worker/middleware/auth/index.ts");
    expect(src).toMatch(/export \{ AuthError \}/);
    expect(src).toMatch(/AuthContext, AuthProvider, IdentityClaims/);
    expect(src).toMatch(/createAuthProvider/);
    expect(src).toMatch(/enforceEmailAllowlist/);
    expect(src).toMatch(/CloudflareAccessProvider/);
    expect(src).toMatch(/DevHeaderProvider/);
  });

  it("there is no top-level src/worker/middleware/auth.ts (replaced by the auth/ directory)", async () => {
    // The legacy file is gone; importing `./auth.js` from
    // `user-context.ts` would now fail. This guards against a
    // future revert that re-creates the kitchen-sink file.
    await expect(read("src/worker/middleware/auth.ts")).rejects.toThrow();
  });
});
