import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("source_instances schema", () => {
  it("creates source_instances with kind/label/url/config/enabled and no user_id", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("CREATE TABLE source_instances");
    expect(sql).toMatch(/kind TEXT NOT NULL/);
    expect(sql).toMatch(/label TEXT NOT NULL/);
    expect(sql).toMatch(/url TEXT/);
    expect(sql).toMatch(/config TEXT NOT NULL DEFAULT '\{\}'/);
    expect(sql).toMatch(/enabled INTEGER NOT NULL DEFAULT 1/);
    expect(sql).toMatch(/UNIQUE\(kind, url\)/);
    expect(sql).toMatch(/CREATE INDEX[\s\S]*?ON source_instances\(enabled\)/);
    const tableStart = sql.indexOf("CREATE TABLE source_instances");
    const tableEnd = sql.indexOf(");", tableStart) + 2;
    const tableDdl = sql.slice(tableStart, tableEnd);
    expect(tableDdl).not.toContain("user_id");
    expect(tableDdl).not.toContain("origin TEXT");
    expect(tableDdl).not.toContain("positive_count");
    expect(tableDdl).not.toContain("negative_count");
    expect(tableDdl).not.toContain("pieces_contributed");
  });
});

describe("adjacent-scanner reads from deployment-level source list", () => {
  it("seeds defaults on first scan, then dispatches via source registry", async () => {
    const src = await read("src/worker/services/adjacent-scanner.ts");
    expect(src).toContain("seedDefaultSourceInstancesIfEmpty");
    expect(src).toContain("listSourceInstances(db, { onlyEnabled: true })");
    expect(src).toContain("sourceRegistry.get(src.kind)");
    expect(src).not.toMatch(/src\.kind === "hn"/);
    expect(src).not.toMatch(/src\.kind === "rss"/);
    expect(src).not.toMatch(/DEFAULT_SIGNAL_SURFACE_MAP\.externalSources/);
  });

  it("seeding call does not pass userId", async () => {
    const src = await read("src/worker/services/adjacent-scanner.ts");
    expect(src).toMatch(/seedDefaultSourceInstancesIfEmpty\(db\)/);
    expect(src).not.toMatch(/seedDefaultSourceInstancesIfEmpty\(db,\s*userId\)/);
  });
});

describe("source suggester", () => {
  it("returns a JSON-only Anthropic call shape with the expected fields", async () => {
    const src = await read("src/worker/services/source-suggester.ts");
    expect(src).toMatch(/NEVER guess a feed URL/);
    expect(src).toMatch(/DO NOT propose:/);
    expect(src).toMatch(/"suggestions":\s*\[/);
    expect(src).toMatch(/"label":\s*"Display name for the feed"/);
    expect(src).toMatch(/"kind":\s*"rss"\s*\|\s*"hn"/);
    expect(src).toMatch(/"rationale":/);
    expect(src).toMatch(/"contentType":/);
    expect(src).toMatch(/!\/\^https\?:\\\/\\\/\/\.test\(s\.url\)/);
  });

  it("source-suggester records token usage so cost budgeting still works", async () => {
    const src = await read("src/worker/services/source-suggester.ts");
    expect(src).toContain("recordTokenUsage");
    expect(src).toContain('"ecosystem_suggest"');
  });
});

describe("/api/source-instances surface", () => {
  it("exposes list / create / patch / delete / suggest handlers", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toMatch(/sourceInstanceRoutes\.get\("\/source-instances"/);
    expect(src).toMatch(/sourceInstanceRoutes\.post\("\/source-instances"/);
    expect(src).toMatch(/sourceInstanceRoutes\.patch\("\/source-instances\/:id"/);
    expect(src).toMatch(/sourceInstanceRoutes\.delete\("\/source-instances\/:id"/);
    expect(src).toMatch(/sourceInstanceRoutes\.post\("\/source-instances\/suggest"/);
  });

  it("create endpoint validates kind, requires url for rss/hn, returns 409 on duplicate", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toMatch(/kind must be 'rss', 'hn', or 'arxiv'/);
    expect(src).toMatch(/requires a url/);
    expect(src).toMatch(/UNIQUE/);
    expect(src).toMatch(/already exists/);
  });

  it("suggest endpoint passes About + Focus + existing keys to the suggester", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).toContain("user.aboutStatement");
    expect(src).toContain("user.focusStatement");
    expect(src).toContain("existingSourceKeys");
  });

  it("worker mounts the source-instance route bundle on /api", async () => {
    const src = await read("src/worker/index.ts");
    expect(src).toContain('import { sourceInstanceRoutes } from "./routes/source-instances.js"');
    expect(src).toContain('app.route("/api", sourceInstanceRoutes)');
  });

  it("CRUD routes do not reference user.userId for source operations", async () => {
    const src = await read("src/worker/routes/source-instances.ts");
    expect(src).not.toMatch(/user\.userId.*(?:create|update|delete|list)SourceInstance/);
    expect(src).not.toMatch(/(?:create|update|delete|list)SourceInstance\([^)]*user\.userId/);
  });
});

describe("maintenance cron no longer rolls up source-feedback stats", () => {
  it("does not import or call refreshEcosystemSourceStats", async () => {
    const src = await read("src/worker/services/maintenance.ts");
    expect(src).not.toContain("refreshEcosystemSourceStats");
    expect(src).not.toContain("ecosystem-queries");
    expect(src).not.toContain("ecosystem stats roll-up");
  });
});

describe("FeedsPanel UI", () => {
  it("registered in settings nav under the 'Sources' group with label 'Feeds'", async () => {
    const shell = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(shell).toMatch(/id: "feeds"[\s\S]{0,200}group: "Sources"/);
    expect(shell).toMatch(/label: "Feeds"/);
    expect(shell).toContain("FeedsPanel");
  });

  it("renders list + add-by-URL form + ✨ Suggest button", async () => {
    const src = await read("src/frontend/components/settings/panels/FeedsPanel.tsx");
    expect(src).toContain("✨ Suggest sources");
    expect(src).toContain("Add a source by feed URL");
    expect(src).toMatch(/RSS 2\.0 and Atom 1\.0 are both supported/);
    expect(src).toContain("/api/source-instances");
    expect(src).not.toContain("/api/ecosystem-sources");
  });

  it("no longer renders per-user feedback flags or origin labels", async () => {
    const src = await read("src/frontend/components/settings/panels/FeedsPanel.tsx");
    expect(src).not.toContain("Refresh feedback");
    expect(src).not.toContain("negative_leaning");
    expect(src).not.toContain("performing_well");
    expect(src).not.toContain("origin");
    expect(src).not.toContain("positiveCount");
    expect(src).not.toContain("negativeCount");
    expect(src).not.toContain("piecesContributed");
  });
});
