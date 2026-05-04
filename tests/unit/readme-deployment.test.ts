/**
 * Tests pinning the deployment / hosting / cost section.
 *
 * Originally lived in the README; relocated to `dev-docs/deploying.md`
 * during the README split (Apr 2026) so the README could stay focused
 * on quickstart + architecture. The README's "## Deploying Primer"
 * section is now a 2-line pointer to this file.
 *
 * The section covers what an ops person or individual deploying Primer
 * needs: which Cloudflare services we use, the configuration surface,
 * the auth model, security practices, and a low/medium/high cost
 * estimate with an explicit pricing-date citation. It's content that
 * gets stale fast — a Cloudflare price change, an Anthropic model
 * rename, a new optional integration — so we pin the structural
 * pieces (sections, citation date, key dollar figures) here. When
 * pricing actually changes, the doc + this test get updated together.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("dev-docs/deploying.md — Deploying Primer (Cloudflare hosting)", () => {
  it("README has a top-level deployment pointer to dev-docs/deploying.md", async () => {
    const src = await read("README.md");
    expect(src).toMatch(/## Deploying Primer/);
    expect(src).toContain("dev-docs/deploying.md");
  });

  it("dev-docs/deploying.md has a top-level deployment section", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/^# Deploying Primer \(Cloudflare hosting\)/m);
  });

  it("inventories the Cloudflare services Primer uses", async () => {
    const src = await read("dev-docs/deploying.md");
    // Each service should be named so an ops reviewer can confirm
    // they have the right Cloudflare account scope.
    for (const service of [
      "Workers", // primer-api
      "Pages", // primer-ui
      "D1", // primer-db
      "Workers AI", // TTS
      "Cron Triggers",
      "Cloudflare Access",
    ]) {
      expect(src, `should mention ${service}`).toContain(service);
    }
  });

  it("documents the configurability surface (vars, secrets, runtime settings)", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/Build-time vars/i);
    expect(src).toMatch(/Runtime secrets/i);
    expect(src).toMatch(/Per-user runtime settings/i);
    // Specific knobs ops folks will look for.
    expect(src).toMatch(/BUDGET_CAP_MONTHLY/);
    expect(src).toMatch(/RETENTION_DAYS/);
    expect(src).toMatch(/RELEVANCE_THRESHOLD/);
  });

  it("documents authentication and authorization explicitly", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/Authentication.*Cloudflare Access/i);
    expect(src).toMatch(/CF-Access-JWT-Assertion/);
    // First-user-becomes-admin bootstrap is a key fact.
    expect(src).toMatch(/First user.*admin/i);
  });

  it("documents JWT verification (not just header reading) and the email allowlist", async () => {
    const src = await read("dev-docs/deploying.md");
    // Pre-refactor the README claimed the worker "reads the
    // CF-Access-JWT-Assertion header" — true, but it didn't
    // verify it. The hardened path re-verifies signature + iss +
    // aud + exp against JWKS. Pin the claim so a future doc edit
    // doesn't quietly walk back to the trust-the-header story.
    expect(src).toMatch(/re-verifies/i);
    expect(src).toMatch(/JWKS/);
    expect(src).toMatch(/aud/);
    // Allowlist must be documented as defense in depth.
    expect(src).toMatch(/ALLOWED_EMAIL_DOMAINS/);
    expect(src).toMatch(/defense.in.depth/i);
  });

  it("documents the bring-your-own-auth-proxy path for non-Cloudflare deployments", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/Bring your own auth proxy/i);
    expect(src).toMatch(/PRIMER_AUTH_MODE\s*=\s*"dev-header"/);
    expect(src).toMatch(/PRIMER_DEV_HEADER_NAME/);
    // At least one common upstream proxy is named so deployers
    // can pattern-match against their own setup.
    expect(src).toMatch(/oauth2-proxy|Pomerium|Tailscale/);
  });

  it("documents security practices and assumptions", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/Security practices/i);
    expect(src).toMatch(/Read-only/);
    expect(src).toMatch(/Server gates/);
    expect(src).toMatch(/Cost-bounded/i);
    expect(src).toMatch(/usage_events/);
  });

  it("includes a cost estimate with an explicit pricing-date citation", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/^# Deploying Primer \(Cloudflare hosting\)/m);
    // The user explicitly asked us to cite when pricing was last verified.
    expect(src).toMatch(/April 2026/);
    expect(src).toMatch(/as of April 2026/i);
  });

  it("cites at least the canonical pricing source URLs so readers can re-verify", async () => {
    const src = await read("dev-docs/deploying.md");
    // Workers + D1 + Workers AI pricing pages on developer.cloudflare.com.
    expect(src).toContain("developer.cloudflare.com/workers/platform/pricing");
    expect(src).toContain("developer.cloudflare.com/d1/platform/pricing");
    expect(src).toContain("developers.cloudflare.com/workers-ai/platform/pricing");
    // Cloudflare Access pricing.
    expect(src).toContain("cloudflare.com/teams-pricing");
    // Anthropic + OpenAI rate cards.
    expect(src).toContain("docs.anthropic.com/en/about-claude/pricing");
    expect(src).toContain("platform.openai.com/docs/pricing");
  });

  it("includes per-step token math so reviewers can audit the cost model", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/LLM cost per briefing/i);
    expect(src).toMatch(/Slack relevance filter/);
    expect(src).toMatch(/Concept extraction/);
    expect(src).toMatch(/Teaching pieces/);
    expect(src).toMatch(/Continuation classifier/);
    expect(src).toMatch(/Quiz generation/);
    // Per-briefing total figure ($0.34) — the reference number the
    // tier estimates extend.
    expect(src).toMatch(/Per-briefing total[\s\S]{0,80}\$0\.34/);
  });

  it("provides low / medium / high single-user monthly estimates", async () => {
    const src = await read("dev-docs/deploying.md");
    // Each tier is named in the table; daily / weekly / monthly
    // breakdowns with explicit dollar figures.
    expect(src).toMatch(/\*\*Low\*\*/);
    expect(src).toMatch(/\*\*Medium\*\*/);
    expect(src).toMatch(/\*\*High\*\*/);
    // The table headers — daily / weekly / monthly — must be present
    // so a reader gets all three time horizons.
    expect(src).toMatch(/\| Tier \|.*Daily.*Weekly.*Monthly/);
    // First-month total under the medium tier (the headline number
    // we give as a "what does it actually cost" example).
    expect(src).toMatch(/≈\$14\.20/);
  });

  it("notes the multi-user extrapolation rule", async () => {
    const src = await read("dev-docs/deploying.md");
    expect(src).toMatch(/Multi-user extrapolation/);
    expect(src).toMatch(/scale.*per.*user/i);
    // Mentions Cloudflare Access pricing kicks in at user 51.
    expect(src).toMatch(/50 users/);
  });

  it("links back to the existing ops + credentials docs (with paths relative to dev-docs/)", async () => {
    const src = await read("dev-docs/deploying.md");
    // Cross-link to the deeper procedural ops walkthrough.
    expect(src).toContain("../src/frontend/help/ops/deploying-primer.md");
    // Per-integration credential docs.
    expect(src).toContain("../src/frontend/help/credentials/anthropic.md");
    expect(src).toContain("../src/frontend/help/credentials/linear.md");
    expect(src).toContain("../src/frontend/help/credentials/slack.md");
  });
});
