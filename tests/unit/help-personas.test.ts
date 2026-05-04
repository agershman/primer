/**
 * Tests for the persona-aware help-doc system.
 *
 * The help index now sections content by audience — `user` (default),
 * `admin`, `developer`, `ops`. Most existing docs are user-facing;
 * configuration / AI models are admin; API endpoints are
 * developer-flavored; deployment is ops. The docs themselves declare
 * their audience(s) in frontmatter, the registry parses them, and the
 * index page exposes a persona-chip filter.
 *
 * Coverage:
 *   1. Frontmatter parser — accepts both inline (`audiences: [a, b]`)
 *      and multi-line (`audiences:\n  - a\n  - b`) shapes; defaults
 *      to `["user"]` when omitted; rejects unknown audience values.
 *   2. Every existing doc is tagged (so the persona filter is
 *      complete on day one — no "user" doc accidentally landing
 *      in the admin slice).
 *   3. The three anchor docs exist (admins, developers, ops).
 *   4. New categories (`admins`, `developers`, `ops`) appear in
 *      CATEGORY_ORDER + CATEGORY_LABELS.
 *   5. `getHelpPagesGrouped` filters by audience.
 *   6. `searchHelp` filters by audience.
 *   7. HelpIndexPage source-text contracts: chips render, URL hash
 *      persistence, non-admin default, audience badges in search
 *      results.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const HELP_ROOT = resolve(REPO_ROOT, "src/frontend/help");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

async function listHelpDocs(): Promise<string[]> {
  const cats = await readdir(HELP_ROOT, { withFileTypes: true });
  const out: string[] = [];
  for (const cat of cats) {
    if (!cat.isDirectory()) continue;
    const files = await readdir(resolve(HELP_ROOT, cat.name));
    for (const f of files) {
      if (f.endsWith(".md")) out.push(`${cat.name}/${f}`);
    }
  }
  return out;
}

describe("Frontmatter audiences parser", () => {
  it("parses inline form `audiences: [user, admin]`", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toContain('audiences:');
    expect(src).toMatch(/inline form[\s\S]{0,200}\[user,\s*admin\]/i);
    // Inline-array branch + comma split.
    expect(src).toMatch(/rest\.startsWith\("\["\)/);
  });

  it("parses multi-line form (\\n  - user\\n  - admin)", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    // Same `- value` shape as related: — both feed through the
    // `listKey` accumulator.
    expect(src).toMatch(/listKey\s*=\s*"audiences"/);
    expect(src).toMatch(/listKey === "audiences"/);
  });

  it("defaults to ['user'] when frontmatter omits the field", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    // The fallback shows up at the end of parseFrontmatter.
    expect(src).toMatch(/audiences\.length\s*>\s*0\s*\?\s*audiences\s*:\s*\["user"\]/);
  });

  it("rejects unknown audience values via isAudience type guard", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toMatch(/function isAudience/);
    expect(src).toMatch(/v === "user" \|\| v === "admin" \|\| v === "developer" \|\| v === "ops"/);
  });
});

describe("Every help doc declares an audience", () => {
  it("tags every existing markdown file", async () => {
    const docs = await listHelpDocs();
    expect(docs.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const rel of docs) {
      const src = await read(`src/frontend/help/${rel}`);
      if (!/audiences:/m.test(src)) missing.push(rel);
    }
    expect(missing, `untagged docs:\n${missing.join("\n")}`).toEqual([]);
  });

  it("admin-only configuration doc is tagged for admin readers", async () => {
    const src = await read("src/frontend/help/reference/configuration.md");
    expect(src).toMatch(/audiences:\s*\[[^\]]*admin/);
  });

  it("AI-models doc is admin-only (deployment-wide model picks)", async () => {
    const src = await read("src/frontend/help/reference/ai-models.md");
    expect(src).toMatch(/audiences:\s*\[admin\]/);
  });

  it("API endpoints doc surfaces for developers + admins", async () => {
    const src = await read("src/frontend/help/reference/api-endpoints.md");
    expect(src).toMatch(/audiences:\s*\[developer,\s*admin\]/);
  });

  it("Setup doc covers user + ops (local dev + production deploy)", async () => {
    const src = await read("src/frontend/help/getting-started/setup.md");
    expect(src).toMatch(/audiences:\s*\[user,\s*ops\]/);
  });

  it("Common-issues troubleshooting spans user + admin + ops", async () => {
    const src = await read("src/frontend/help/troubleshooting/common-issues.md");
    expect(src).toMatch(/audiences:\s*\[user,\s*admin,\s*ops\]/);
  });
});

describe("Anchor docs for new personas", () => {
  it("admins/admin-overview.md exists and is tagged [admin]", async () => {
    const src = await read("src/frontend/help/admins/admin-overview.md");
    expect(src).toMatch(/audiences:\s*\[admin\]/);
    expect(src).toMatch(/Promoting another user to admin/i);
  });

  it("developers/extending-primer.md exists and is tagged [developer]", async () => {
    const src = await read("src/frontend/help/developers/extending-primer.md");
    expect(src).toMatch(/audiences:\s*\[developer\]/);
    expect(src).toMatch(/LLM adapters/);
    expect(src).toMatch(/TTS adapters/);
    expect(src).toMatch(/Source providers/);
    expect(src).toMatch(/Pipeline seams/);
  });

  it("ops/deploying-primer.md exists and is tagged [ops]", async () => {
    const src = await read("src/frontend/help/ops/deploying-primer.md");
    expect(src).toMatch(/audiences:\s*\[ops\]/);
    expect(src).toMatch(/wrangler secret put/);
    expect(src).toMatch(/D1 migration/i);
    expect(src).toMatch(/CI\/CD/);
  });
});

describe("CATEGORY_ORDER includes the new persona-anchor categories", () => {
  it("admins / developers / ops sit at the bottom of CATEGORY_ORDER", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toMatch(/"admins"/);
    expect(src).toMatch(/"developers"/);
    expect(src).toMatch(/"ops"/);
    // Order: user-facing categories first, then persona anchors.
    const orderMatch = src.match(/CATEGORY_ORDER\s*=\s*\[([\s\S]+?)\]/);
    expect(orderMatch).not.toBeNull();
    const orderText = orderMatch![1];
    expect(orderText.indexOf("getting-started")).toBeLessThan(orderText.indexOf("admins"));
    expect(orderText.indexOf("admins")).toBeLessThan(orderText.indexOf("developers"));
    expect(orderText.indexOf("developers")).toBeLessThan(orderText.indexOf("ops"));
  });

  it("CATEGORY_LABELS humanizes admins/developers/ops as 'For Admins / Developers / Ops'", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toMatch(/admins:\s*"For Admins"/);
    expect(src).toMatch(/developers:\s*"For Developers"/);
    expect(src).toMatch(/ops:\s*"For Ops"/);
  });
});

describe("getHelpPagesGrouped + searchHelp accept an audience filter", () => {
  it("getHelpPagesGrouped passes the audience filter through both passes", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toMatch(/getHelpPagesGrouped\(\s*audience\?:\s*HelpAudience \| null/);
    expect(src).toMatch(/!audience \|\| p\.audiences\.includes\(audience\)/);
  });

  it("searchHelp filters by audience after the fuse search", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toMatch(/searchHelp\(\s*query: string,\s*audience\?: HelpAudience \| null/);
    expect(src).toMatch(/audience \? pages\.filter\(\(p\) => p\.audiences\.includes\(audience\)\) : pages/);
  });
});

describe("HelpIndexPage persona filter UI", () => {
  it("renders a chip per persona (All / Users / Admins / Developers / Ops)", async () => {
    const src = await read("src/frontend/pages/HelpIndexPage.tsx");
    expect(src).toMatch(/PERSONA_FILTERS/);
    expect(src).toMatch(/"all"\s*,\s*\.\.\.HELP_AUDIENCES/);
    expect(src).toMatch(/aria-pressed=\{active\}/);
  });

  it("persists the persona filter in the URL via ?for=admins so deep links work", async () => {
    const src = await read("src/frontend/pages/HelpIndexPage.tsx");
    expect(src).toContain("useSearchParams");
    expect(src).toMatch(/searchParams\.get\("for"\)/);
    expect(src).toMatch(/params\.set\("for", next\)/);
  });

  it("defaults non-admins to the user persona on first visit", async () => {
    const src = await read("src/frontend/pages/HelpIndexPage.tsx");
    expect(src).toMatch(/useIsAdmin/);
    // First-load nudge — sets persona to "user" when not admin and the URL has no `for=`.
    expect(src).toMatch(/if \(initialFromUrl\) return/);
    expect(src).toMatch(/setPersona\("user"\)/);
  });

  it("search results show audience badges so readers can see the persona at a glance", async () => {
    const src = await read("src/frontend/pages/HelpIndexPage.tsx");
    expect(src).toMatch(/page\.audiences\.map/);
    expect(src).toMatch(/HELP_AUDIENCE_LABELS\[a\]/);
  });

  it("renders an empty-state escape hatch when the chosen persona has no docs", async () => {
    const src = await read("src/frontend/pages/HelpIndexPage.tsx");
    expect(src).toMatch(/grouped\.size === 0/);
    expect(src).toMatch(/setPersona\("all"\)/);
  });
});
