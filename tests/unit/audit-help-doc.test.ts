import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * The audit help article is reachable from the help registry only if
 * its frontmatter includes the right `audiences` list and links back
 * to its neighbour articles. If a future edit drops the user audience
 * (so the user-facing help index hides it) or breaks the `related`
 * links (so navigation between teaching-pieces ↔ audit ↔ ai-models
 * silently rots), the user surface degrades without any test catching
 * it. Pinning the front-matter shape here keeps the cross-doc links
 * healthy.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("audit help article", () => {
  it("exists with the right frontmatter (audiences + related)", async () => {
    const src = await read("src/frontend/help/briefings/audit.md");
    expect(src).toMatch(/^---/);
    expect(src).toMatch(/title:\s*"The Audit Pass"/);
    expect(src).toMatch(/audiences:\s*\[user,\s*admin\]/);
    expect(src).toMatch(/briefings\/teaching-pieces/);
    expect(src).toMatch(/reference\/ai-models/);
  });

  it("explains the four resolution states the indicator surfaces", async () => {
    const src = await read("src/frontend/help/briefings/audit.md");
    expect(src).toMatch(/Audited · clean/);
    expect(src).toMatch(/Audited · N patched/);
    expect(src).toMatch(/Audited · N dropped/);
    expect(src).toMatch(/Audit unavailable/);
  });
});
