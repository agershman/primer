/**
 * Pins the desktop sidebar scroll contract on the Help article page.
 *
 * The sidebar is `position: sticky` so it stays visible as the
 * article scrolls. It must ALSO have a viewport-bounded `max-height`
 * + its own `overflow-y-auto` — otherwise category groups that
 * exceed the viewport are clipped off-screen, and the only way to
 * reach the bottom items is to scroll the whole page past them
 * (which defeats the point of a sticky nav).
 *
 * The bug this test pins: the original wrapper was just
 * `<div className="sticky top-24">` with no height cap, so the full
 * sidebar — search box + ~6 category groups + ~25 article links —
 * extended below the viewport unbounded.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("HelpArticlePage desktop sidebar", () => {
  it("desktop sticky sidebar caps its height to the viewport and scrolls internally", async () => {
    const src = await read("src/frontend/pages/HelpArticlePage.tsx");

    // The sticky wrapper must:
    //   1. stay sticky at top:24 (= 6rem, just below the header)
    //   2. cap its height so it never extends past the viewport
    //   3. own an internal scrollbar via overflow-y-auto
    expect(src).toMatch(
      /sticky\s+top-24[^"']*max-h-\[calc\(100vh-7rem\)\][^"']*overflow-y-auto/,
    );

    // The "no overflow" pre-fix wrapper would match this — assert it
    // is gone so a future refactor can't accidentally re-introduce it.
    expect(src).not.toMatch(/className="sticky top-24">\s*\n\s*<Sidebar/);
  });

  it("mobile drawer keeps its own scroll (full-height, overflow-y-auto)", async () => {
    // The mobile flow is unaffected: the drawer is an `inset-y-0`
    // panel with overflow-y-auto, which already scrolls fine. Pin
    // it here so a refactor of the desktop side can't accidentally
    // rip it out of the mobile path.
    const src = await read("src/frontend/pages/HelpArticlePage.tsx");
    expect(src).toMatch(/inset-y-0[^"']*overflow-y-auto/);
  });
});
