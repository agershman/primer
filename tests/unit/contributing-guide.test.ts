/**
 * Tests pinning CONTRIBUTING.md and the GitHub PR template against the
 * actual project conventions. The contributing guide is easy to drift
 * out of sync with how the project actually works (e.g. a script gets
 * renamed in package.json, a new admin-gated route lands, the help-doc
 * audience taxonomy changes). These tests catch the most common drift
 * sources by asserting that the guide:
 *
 *   1. Exists at the repo root.
 *   2. Names the canonical scripts contributors should run.
 *   3. References the actual conventions the codebase enforces
 *      (Biome, vitest, source-text contract pattern, audience tags,
 *      assertAdmin gate, migration shape).
 *   4. Cross-links to the rest of the doc system (setup, credentials,
 *      extending-primer, deploying-primer).
 *   5. Is itself linked from the README + the extending-primer help
 *      doc so contributors find it from either entry point.
 *
 * The PR template is also pinned because GitHub renders whatever's in
 * `.github/PULL_REQUEST_TEMPLATE.md` and we want the checklist to
 * stay in lockstep with the CONTRIBUTING.md checklist.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("CONTRIBUTING.md", () => {
  it("exists at the repo root", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toContain("# Contributing to Primer");
  });

  it("names the canonical bun scripts so contributors can copy / paste", async () => {
    const src = await read("CONTRIBUTING.md");
    // These names must match `package.json`'s scripts. If they
    // diverge, this test catches the drift.
    expect(src).toContain("bun run dev");
    expect(src).toContain("bun run typecheck");
    expect(src).toContain("bun run lint");
    expect(src).toContain("bun run test:run");
    expect(src).toContain("bun run check");
    expect(src).toContain("bun run build");
    expect(src).toContain("bun run db:migrate");
  });

  it("documents the Biome / TypeScript style conventions", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/Biome/);
    expect(src).toMatch(/120-column/);
    expect(src).toMatch(/2-space/);
    expect(src).toMatch(/double quotes/i);
    expect(src).toMatch(/trailing commas/i);
    expect(src).toMatch(/strict/i);
  });

  it("documents the source-text contract test pattern + Vitest workflow", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/Vitest/i);
    expect(src).toMatch(/source-text contracts?/);
    // Names the canonical example tests so a contributor knows where to look.
    expect(src).toMatch(/multi-provider-ai\.test\.ts/);
    expect(src).toMatch(/admin-role\.test\.ts/);
  });

  it("documents the migration naming + idempotency rules", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/migrations\//);
    expect(src).toMatch(/numbered/i);
    expect(src).toMatch(/idempotent/i);
    expect(src).toMatch(/Never edit a previously-shipped migration/i);
  });

  it("documents the help-doc audience taxonomy", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/audiences:/);
    expect(src).toMatch(/user[\s\S]{0,40}admin[\s\S]{0,40}developer[\s\S]{0,40}ops/);
  });

  it("documents the admin-gating contract for deployment-wide mutations", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/assertAdmin/);
    expect(src).toMatch(/security boundary/i);
    expect(src).toMatch(/AdminOnly/);
  });

  it("documents the PR title commitlint rule (per workspace policy)", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/commitlint/i);
    // The exact verification command the workspace rule mandates.
    expect(src).toContain('echo "$PR_TITLE" | bun x commitlint --verbose');
    // Conventional-commits prefix list.
    expect(src).toMatch(/feat:/);
    expect(src).toMatch(/fix:/);
  });

  it("includes a PR checklist with the key contract gates", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toMatch(/PR checklist/i);
    expect(src).toMatch(/- \[ \].*bun run check/);
    expect(src).toMatch(/- \[ \].*bun run test:run/);
    expect(src).toMatch(/- \[ \].*bun run build/);
    expect(src).toMatch(/- \[ \].*assertAdmin/);
  });

  it("cross-links to setup, credentials, extending-primer, deploying-primer", async () => {
    const src = await read("CONTRIBUTING.md");
    expect(src).toContain("src/frontend/help/getting-started/setup.md");
    expect(src).toContain("src/frontend/help/credentials/");
    expect(src).toContain("src/frontend/help/developers/extending-primer.md");
    expect(src).toContain("src/frontend/help/ops/deploying-primer.md");
  });
});

describe(".github/PULL_REQUEST_TEMPLATE.md", () => {
  it("exists at the standard GitHub path", async () => {
    const src = await read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(src).toContain("## What this PR does");
    expect(src).toContain("## Why");
    expect(src).toContain("## How to verify");
    expect(src).toContain("## Checklist");
  });

  it("mirrors the CONTRIBUTING checklist so the same gates show up automatically on every PR", async () => {
    const src = await read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(src).toMatch(/- \[ \].*bun run check/);
    expect(src).toMatch(/- \[ \].*bun run test:run/);
    expect(src).toMatch(/- \[ \].*bun run build/);
    expect(src).toMatch(/- \[ \].*assertAdmin/);
    // Help-doc + credential rules.
    expect(src).toMatch(/audiences:/);
    expect(src).toMatch(/credentials/);
  });

  it("notes the conventional-commits PR title format + commitlint check", async () => {
    const src = await read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(src).toMatch(/conventional commits/i);
    expect(src).toMatch(/commitlint/i);
  });
});

describe("README + extending-primer link to CONTRIBUTING", () => {
  it("README has a Contributing section pointing at CONTRIBUTING.md", async () => {
    const src = await read("README.md");
    expect(src).toMatch(/## Contributing/);
    expect(src).toMatch(/\[CONTRIBUTING\.md\]\(CONTRIBUTING\.md\)/);
  });

  it("extending-primer help doc cross-links to CONTRIBUTING", async () => {
    const src = await read("src/frontend/help/developers/extending-primer.md");
    expect(src).toMatch(/CONTRIBUTING\.md/);
  });
});
