/**
 * Pins the visual + accessibility distinction on the admin avatar.
 *
 * Admins were already marked in the dropdown via an "Admin" pill in
 * the identity strip, but the closed-state avatar gave no signal —
 * an admin scanning the header had no at-a-glance cue that
 * deployment-wide controls would be writable for them. This change
 * adds a 2px accent ring + offset gap to the avatar circle when
 * `isAdmin` is true, matched by aria-label + title affordances so
 * screen-reader / keyboard users get the same signal.
 *
 * Three pieces of contract:
 *
 *   1. Visual — `ring-2 ring-accent ring-offset-1 ring-offset-bg`
 *      Tailwind utility produces an outset 2px outline with a 1px
 *      gap from the avatar fill. The gap matters: without it the
 *      ring reads as a thicker fill rather than an outline.
 *
 *   2. Accessibility — title appends " · Admin", aria-label is
 *      "Open menu (Admin)" when the avatar is the menu trigger.
 *
 *   3. Wiring — the AvatarMenu (header dropdown) AND the mobile
 *      drawer's avatar both pass `isAdmin` through to UserAvatar.
 *      Regression-prone: the mobile drawer was added later and is
 *      easy to forget when the desktop one already shows the cue.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("UserAvatar — admin ring", () => {
  it("accepts an isAdmin prop with a safe default", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toMatch(/isAdmin\?:\s*boolean/);
    expect(src).toMatch(/isAdmin = false/);
  });

  it("applies a Tailwind accent ring with offset gap when isAdmin is true", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Pin the exact ring shape: 2px wide, accent color, 1px offset
    // from the bg. Anything narrower reads as a fat fill; anything
    // bigger competes with the icon-button rhythm.
    expect(src).toMatch(/ring-2 ring-accent ring-offset-1 ring-offset-bg/);
    expect(src).toMatch(/const adminRing = isAdmin\s*\?\s*"ring-2 ring-accent/);
  });

  it("appends ' · Admin' to the hover title when isAdmin is true", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toMatch(/const titleSuffix = isAdmin \? " · Admin" : ""/);
    expect(src).toMatch(/title=\{`\$\{displayName \|\| email\}\$\{titleSuffix\}`\}/);
  });

  it("aria-label distinguishes admin (Open menu (Admin)) from regular users", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toMatch(
      /ariaLabel \?\? \(isAdmin \? "Open menu \(Admin\)" : "Open menu"\)/,
    );
  });

  it("exposes a data-admin attribute for CSS / E2E selection", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // `data-admin` is set when isAdmin, otherwise omitted (so the
    // attribute selector `[data-admin]` matches admin avatars only).
    expect(src).toMatch(/data-admin=\{isAdmin \|\| undefined\}/);
  });
});

describe("AvatarMenu wires isAdmin through to the avatar", () => {
  it("desktop dropdown passes isAdmin down to UserAvatar", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The AvatarMenu mounts a UserAvatar with `isAdmin={isAdmin}`
    // (the prop the menu receives from the Header). Pin the exact
    // wiring so a future refactor that drops the prop in passing
    // is caught.
    expect(src).toMatch(
      /<UserAvatar[\s\S]{0,500}isAdmin=\{isAdmin\}[\s\S]{0,500}ariaLabel=\{open \?/,
    );
  });

  it("mobile drawer also passes isAdmin (regression: was missing in the original mobile path)", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The mobile drawer's settings button mounts a UserAvatar too.
    // Pin that it carries `user.isAdmin` so the ring shows in the
    // mobile menu just like the desktop avatar.
    expect(src).toMatch(
      /<UserAvatar[\s\S]{0,500}isAdmin=\{user\.isAdmin\}[\s\S]{0,300}ariaLabel="Open settings"/,
    );
  });
});
