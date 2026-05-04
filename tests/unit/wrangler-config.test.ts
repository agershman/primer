/**
 * Pin critical wrangler.api.toml settings.
 *
 * Bug this test prevents regressing
 * --------------------------------
 * Without `[limits] cpu_ms = 300000`, every `c.executionCtx.waitUntil(...)`
 * task gets cancelled at the default 30 s CPU budget. That surfaces
 * to the user as deep dives that never finish, briefings that get
 * stuck in `generating`, and notifications that never flip green.
 *
 * The Cloudflare runtime emits this warning when it happens:
 *
 *   waitUntil() tasks did not complete within the allowed time
 *   after invocation end and have been cancelled.
 *
 * Workers Paid supports up to 300 s CPU time. We set the full
 * maximum because LLM API calls are subrequests (don't burn CPU
 * while waiting) — there's no usage cost to raising the ceiling,
 * only correctness risk to lowering it.
 *
 * Both `wrangler.api.toml` (the deployed config) and
 * `wrangler.api.example.toml` (the template new operators copy)
 * must carry this setting. If a future cleanup drops it from
 * either file, this test fails before deployment.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

const FILES_THAT_MUST_SET_CPU_MS = ["wrangler.api.toml", "wrangler.api.example.toml"];

describe("wrangler API config — operational guardrails", () => {
  for (const file of FILES_THAT_MUST_SET_CPU_MS) {
    it(`${file} sets cpu_ms = 300000 in [limits] (waitUntil headroom)`, async () => {
      const src = await read(file);
      // Pin the [limits] section presence + the cpu_ms value. We
      // accept any whitespace shape between the section header and
      // the value so a formatter pass can't break this — but the
      // actual value MUST be 300000 (the Workers Paid max). A
      // future change that lowers it should fail loudly.
      expect(
        src,
        `${file} is missing [limits] cpu_ms — long-running waitUntil tasks (deep dives, briefings, baseline prep) will time out at the default 30s. See dev-docs/adrs/0005-streaming-plus-waituntil.md.`,
      ).toMatch(/\[limits\][\s\S]{0,500}cpu_ms\s*=\s*300000/);
    });
  }

  it("ADR 0005 documents the cpu_ms operational requirement", async () => {
    const md = await read("dev-docs/adrs/0005-streaming-plus-waituntil.md");
    // The "Operational gotcha" section must mention the warning
    // text the user sees in their logs, the fix, and the file
    // they need to edit. This is the single most useful breadcrumb
    // when someone hits the warning in production — pin it.
    expect(md).toMatch(/cpu_ms/);
    expect(md).toMatch(/waitUntil\(\) tasks did not complete within the allowed time/);
    expect(md).toMatch(/wrangler\.api\.toml/);
  });
});

describe("wrangler API config — auth posture (ADR 0006)", () => {
  /**
   * Bug class this prevents
   * -----------------------
   * Pre-refactor, `wrangler.api.toml` carried a live
   * `PRIMER_DEV_USER = "dev@acme.test"` which would silently
   * authenticate any request that bypassed Cloudflare Access (e.g.
   * via the `*.workers.dev` URL) as that email. Production must
   * NOT carry this var; dev-mode auth lives in `.dev.vars` only.
   */
  it("wrangler.api.toml does NOT set PRIMER_DEV_USER (the production footgun)", async () => {
    const src = await read("wrangler.api.toml");
    // PRIMER_DEV_USER belongs in `.dev.vars` (gitignored, local
    // dev only). Setting it in production wrangler vars makes the
    // dev-header path silently accept any request that doesn't
    // carry a valid CF Access JWT.
    expect(src).not.toMatch(/^\s*PRIMER_DEV_USER\s*=/m);
  });

  it("wrangler.api.toml runs in cloudflare-access mode with CF_ACCESS_* vars", async () => {
    const src = await read("wrangler.api.toml");
    expect(src).toMatch(/PRIMER_AUTH_MODE\s*=\s*"cloudflare-access"/);
    expect(src).toMatch(/CF_ACCESS_TEAM_DOMAIN\s*=/);
    expect(src).toMatch(/CF_ACCESS_AUD\s*=/);
  });

  it("wrangler.api.toml carries an email allowlist (defense in depth)", async () => {
    const src = await read("wrangler.api.toml");
    // ALLOWED_EMAILS or ALLOWED_EMAIL_DOMAINS — either passes.
    // The allowlist is the second line of defense behind the
    // Access policy and should be set in production.
    expect(src).toMatch(/ALLOWED_EMAIL(S|_DOMAINS)\s*=/);
  });

  it("wrangler.api.example.toml shows the production posture as the default", async () => {
    const src = await read("wrangler.api.example.toml");
    expect(src).toMatch(/PRIMER_AUTH_MODE\s*=\s*"cloudflare-access"/);
    expect(src).toMatch(/CF_ACCESS_TEAM_DOMAIN/);
    expect(src).toMatch(/CF_ACCESS_AUD/);
    // PRIMER_DEV_USER must not be a top-level vars entry — only
    // referenced as a comment for `.dev.vars` setup.
    expect(src).not.toMatch(/^\s*PRIMER_DEV_USER\s*=/m);
  });
});

describe("package.json deploy gate — pre-deploy typecheck + tests", () => {
  /**
   * Why this test exists
   * --------------------
   * The original `deploy` script was just `vite build && wrangler deploy && wrangler pages deploy`.
   * `vite build` uses esbuild, which strips TypeScript types but DOES
   * NOT type-check. A real bug shipped to production where
   * `useEffect` was used without being imported in `useSettings.ts`;
   * the deploy succeeded, the runtime crashed with "useEffect is
   * not defined" the moment any settings hook ran. That's the kind
   * of bug `tsc --noEmit` catches in 3 seconds.
   *
   * The fix is to gate every `bun run deploy` (and `deploy:api` /
   * `deploy:ui`) on `bun run typecheck` and (for the full
   * `deploy`) on `bun run test:run`. Both are fast (~5 s combined),
   * and both catch real classes of bug that bypass `vite build`.
   * `deploy:fast` exists as an explicit escape hatch when the
   * caller knows they're not changing code (e.g. updating
   * environment variables, retrying after CI passed elsewhere).
   *
   * Pin the gate here so a future "let's make deploy faster"
   * cleanup can't silently strip it without dropping back to
   * `deploy:fast`.
   */
  it("`deploy` script runs typecheck + tests before building", async () => {
    const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.deploy).toMatch(/bun run typecheck/);
    expect(pkg.scripts.deploy).toMatch(/bun run test:run/);
    // The order matters — fail fast on type errors before the
    // (longer) test run. Both must run before `vite build`, since
    // a build failure after a passing typecheck would point at a
    // bundler config issue, not a code issue.
    expect(pkg.scripts.deploy).toMatch(/typecheck[\s\S]+test:run[\s\S]+vite build/);
  });

  it("`deploy:api` and `deploy:ui` gate on typecheck", async () => {
    const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    // Partial deploys (worker-only or UI-only) still need the
    // typecheck — they're commonly used for hot fixes where
    // rushing past type errors is exactly the wrong move.
    expect(pkg.scripts["deploy:api"]).toMatch(/bun run typecheck/);
    expect(pkg.scripts["deploy:ui"]).toMatch(/bun run typecheck/);
  });

  it("`deploy:fast` escape hatch exists for when the caller has already validated", async () => {
    const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
    // When the caller has just run tests (e.g. CI just passed) or
    // is not actually changing code (e.g. env-var rotation), they
    // can use `deploy:fast`. Pin its existence so the gate is
    // bypassable on purpose, not by accident.
    expect(pkg.scripts["deploy:fast"]).toBeDefined();
    expect(pkg.scripts["deploy:fast"]).not.toMatch(/typecheck/);
  });
});
