/**
 * Pins the header's top-right icon cluster against three regressions
 * that landed before the cleanup:
 *
 *   1. SVG sizes had drifted apart (bookmark=14, bell=18, theme=13).
 *      Now every icon SVG in the cluster uses 16×16 as its nominal
 *      size for visual parity.
 *   2. The display-prefs button had a visible bordered shape with
 *      an "M" / "L" / "S" font-size letter. The other utility
 *      buttons were borderless — the prefs button stuck out. The
 *      letter and border were dropped; the font-size pick is still
 *      visible inside the popover.
 *   3. The hit-area shape varied (`p-1.5` vs `px-2 py-1.5` vs
 *      `h-7 w-7`). Now every utility button + the avatar share a
 *      32×32 (`h-8 w-8`) target so the cluster reads as one row.
 *
 * The avatar stays visually distinct (round + accent background) on
 * purpose — it represents identity, not utility.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("Header top-right cluster — shared icon-button rhythm", () => {
  it("Header.tsx exports a shared HEADER_ICON_BUTTON_CLASSES constant", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toContain("HEADER_ICON_BUTTON_CLASSES");
    // 32×32 hit area is the rhythm — h-8 w-8.
    expect(src).toMatch(/HEADER_ICON_BUTTON_CLASSES\s*=\s*[\s\S]{0,200}h-8 w-8/);
  });

  it("bookmark and prefs buttons use the shared shape", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Bookmark trigger is now a <button> (was a <Link>) so it can act
    // as a toggle — see bookmark-toggle.test.ts. It still applies the
    // shared icon-button classes (with an optional active overlay)
    // for visual parity with the rest of the cluster.
    expect(src).toMatch(/onClick=\{onBookmarkIconClick\}[\s\S]{0,400}\$\{HEADER_ICON_BUTTON_CLASSES\}/);
    // Prefs trigger button: identical shape, no border / font-size letter.
    // The shared-classes line precedes the aria-label, so anchor the
    // search on the className side.
    expect(src).toMatch(/className=\{HEADER_ICON_BUTTON_CLASSES\}[\s\S]{0,200}aria-label="Display preferences"/);
  });

  it("bookmark icon is 16×16 (was 14×14) for parity with the rest of the cluster", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The bookmark SVG uses 16×16. The width / height attributes are
    // split across multiple lines in the JSX, so allow whitespace
    // between them. Anchor on the bookmark path data so the
    // assertion targets that specific icon and not one of the theme
    // icons (which also use 16×16 now).
    expect(src).toMatch(/width="16"\s+height="16"[\s\S]{0,400}M4 2h8a1 1 0 0 1 1 1/);
  });

  it("theme icons (light / dark / system) are all 16×16", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // All three theme-icon SVGs share the same width/height; we
    // assert at least three matches (one per option) and that none
    // of them carry the old 13×13 size.
    // Biome may format JSX attributes one-per-line; tolerate any
    // whitespace (incl. newlines) between attrs so the assertion is
    // about the actual SVG sizing, not the formatter's output.
    const sizeMatches = src.match(/width="16"\s+height="16"\s+viewBox="0 0 16 16"/g) ?? [];
    expect(sizeMatches.length).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/width="13"\s+height="13"\s+viewBox="0 0 16 16"/);
  });

  it("prefs trigger button no longer renders the visible 'M' / 'L' / 'S' font-size letter", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The closed-state trigger renders ONLY the theme icon; the
    // font-size letter only appears inside the popover.
    expect(src).not.toMatch(/fontSize === "small" \? "S"[\s\S]{0,200}aria-label="Display preferences"/);
    // Make sure the popover still has both pickers (we didn't lose
    // functionality in the cleanup).
    expect(src).toContain("FONT_SIZE_OPTIONS");
    expect(src).toContain("THEME_OPTIONS");
  });

  it("avatar is 32×32 (h-8 w-8) so it matches the icon-button rhythm", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The UserAvatar inner button uses h-8 w-8 (was h-7 w-7).
    expect(src).toMatch(/UserAvatar\(/);
    expect(src).toMatch(/flex h-8 w-8 items-center justify-center rounded-full/);
  });

  it("avatar gets a small ml-1.5 gap to separate utility from identity", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Subtle visual grouping cue, no literal divider line.
    expect(src).toMatch(/<div className="ml-1\.5">[\s\S]{0,200}<AvatarMenu/);
  });

  it("notification bell uses the same 32×32 shape with a 16×16 SVG", async () => {
    const src = await read("src/frontend/components/NotificationBell.tsx");
    // Hit area matches the rest of the cluster (h-8 w-8).
    expect(src).toMatch(/h-8 w-8 rounded-md text-text-dim/);
    // SVG sized to 16×16, not the previous 18×18.
    expect(src).toMatch(/width="16"\s*\n\s*height="16"\s*\n\s*viewBox="0 0 24 24"/);
    expect(src).not.toMatch(/width="18"\s*\n\s*height="18"/);
  });

  it("activity indicator inherits the same 32×32 shape with a 16×16 SVG", async () => {
    const src = await read("src/frontend/components/ActivityIndicator.tsx");
    // Activity sits right next to the bell, so it MUST match the
    // cluster shape — different sizing here would read as "this
    // one's special / different" which is the wrong signal for an
    // FYI-class indicator.
    expect(src).toMatch(/h-8 w-8 rounded-md/);
    expect(src).toMatch(/width="16"\s*\n\s*height="16"\s*\n\s*viewBox="0 0 24 24"/);
    // Accent-tinted (not text-dim like bookmark/bell) so the
    // "active work" semantic is discoverable at a glance.
    expect(src).toMatch(/text-accent/);
  });

  it("mobile menu toggle reuses the shared icon-button shape", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toMatch(/md:hidden \$\{HEADER_ICON_BUTTON_CLASSES\}/);
  });
});
