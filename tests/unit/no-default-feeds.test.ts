/**
 * Pins the "no curated starter pack" contract on a fresh deploy.
 *
 * Earlier versions of Primer seeded a platform/SRE-flavored set of
 * feeds (Hacker News, CNCF, ArXiv cs.DC+cs.SE, AWS What's New, GCP
 * Release Notes) on first request. Different deployments serve
 * different audiences (designers, sales leads, security folks,
 * etc.), so a baked-in default was presumptuous. The Feeds panel
 * now starts empty and admins populate it via ✨ Suggest sources or
 * by pasting RSS URLs directly.
 *
 * If anyone reintroduces a baked-in default later, this test fails
 * and forces the discussion.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_SOURCE_INSTANCES } from "../../src/worker/db/source-instance-queries.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("Feed seed defaults", () => {
  it("DEFAULT_SOURCE_INSTANCES is empty (no curated starter pack)", () => {
    expect(DEFAULT_SOURCE_INSTANCES).toEqual([]);
  });

  it("seedDefaultSourceInstancesIfEmpty short-circuits when the default array is empty", async () => {
    const src = await read("src/worker/db/source-instance-queries.ts");
    // Function still exists as a future hook (e.g. an opt-in wizard
    // could later use it) but no-ops at the start when the default
    // list is empty.
    expect(src).toMatch(/if \(DEFAULT_SOURCE_INSTANCES\.length === 0\) return/);
  });
});

describe("Feeds panel + docs reflect the empty default", () => {
  it("FeedsPanel description does not promise a 'starter pack'", async () => {
    const src = await read("src/frontend/components/settings/panels/FeedsPanel.tsx");
    expect(src).not.toMatch(/starter pack/i);
    // Tells the user explicitly the panel starts empty.
    expect(src).toMatch(/Starts empty/);
  });

  it("README no longer claims 'out of the box you get' with a hardcoded feed list", async () => {
    const src = await read("README.md");
    expect(src).not.toMatch(/out of the box you get a starter pack/i);
    // Says the list starts empty and points to ✨ Suggest sources / RSS URL.
    expect(src).toMatch(/starts empty/i);
  });

  it("how-generation-works doc reflects the empty-by-default behavior", async () => {
    const src = await read("src/frontend/help/briefings/how-generation-works.md");
    expect(src).not.toMatch(/Out of the box you get a starter pack/);
    expect(src).toMatch(/feed list starts empty/i);
  });

  it("source-instances doc reflects the empty-by-default behavior", async () => {
    const src = await read("src/frontend/help/briefings/source-instances.md");
    expect(src).toMatch(/starts empty/i);
    // No longer mentions Hacker News / CNCF / ArXiv as bundled defaults.
    expect(src).not.toMatch(/Hacker News, CNCF Blog, ArXiv cs\.DC \+ cs\.SE/);
  });
});
