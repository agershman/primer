/**
 * Pins the bookmark icon's toggle behavior in the header.
 *
 * Click rules (desktop):
 *   • Not on /bookmarks → navigate to /bookmarks.
 *   • Already on /bookmarks → navigate back to the page the user was
 *     on before clicking the icon (or "/" as a fallback if the user
 *     deep-linked / refreshed onto /bookmarks).
 *
 * Keyboard rules:
 *   • Escape on /bookmarks → same back-navigation as the second click.
 *   • Suppressed when a modal/dialog is open on top, so the dialog's
 *     own Esc handler runs first (settings, focus editor, chat, etc.).
 *
 * The previous-path cache is captured at the route-change level (a
 * useEffect that watches `location.pathname/search/hash` and stores
 * the last NON-bookmark path), so query strings + hashes survive the
 * round trip — e.g. /briefing/2026-04-15 → /bookmarks → back lands
 * on the dated briefing rather than "/".
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("Header bookmark icon — toggle behavior", () => {
  it("bookmark icon is a <button>, not a <Link>, so clicks can be intercepted", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The desktop bookmark trigger is now a button with onClick =
    // onBookmarkIconClick. It must NOT be a router <Link to="/bookmarks">
    // anymore — that would let the second click no-op (already on
    // the route) instead of navigating back.
    expect(src).toMatch(/onClick=\{onBookmarkIconClick\}/);
    expect(src).not.toMatch(/<Link\s+to="\/bookmarks"/);
  });

  it("clicking the bookmark icon toggles between /bookmarks and the previous page", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The handler chooses based on whether we're currently on
    // /bookmarks. Both branches are explicit so a future refactor
    // can't accidentally drop the back-navigation arm.
    expect(src).toMatch(
      /const onBookmarkIconClick = \(\) => \{[\s\S]{0,300}if \(onBookmarks\)[\s\S]{0,200}goBackFromBookmarks\(\);[\s\S]{0,200}navigate\("\/bookmarks"\);/,
    );
  });

  it("previous-page tracking ignores /bookmarks itself + preserves search/hash", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The ref is updated only when the user is NOT on /bookmarks, so
    // hopping bookmark→bookmark→back doesn't overwrite the prior
    // page. We capture pathname + search + hash so dated briefings
    // (?date=…) and anchor links (#concept-x) survive the round trip.
    expect(src).toMatch(/prevPathRef\s*=\s*useRef<string>\("\/"\)/);
    expect(src).toMatch(
      /if \(!onBookmarks\) \{[\s\S]{0,200}prevPathRef\.current = location\.pathname \+ location\.search \+ location\.hash/,
    );
  });

  it("falls back to '/' when there's no remembered previous page (deep-link / refresh)", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // goBackFromBookmarks reads the ref but defaults to "/" if the
    // ref is somehow falsy — defensive against the edge case where
    // the user lands on /bookmarks via a shared URL.
    expect(src).toMatch(/navigate\(prevPathRef\.current \|\| "\/"\)/);
  });

  it("Escape on /bookmarks navigates back, but only when no modal is open", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The keydown listener only registers when onBookmarks is true,
    // and short-circuits if a modal is on top — sniffed via
    // role="dialog" / role="alertdialog" / data-modal-open so the
    // back-stack glue stays decoupled from each modal's open state.
    expect(src).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,200}if \(!onBookmarks\) return;[\s\S]{0,400}if \(e\.key !== "Escape"\) return;/,
    );
    expect(src).toMatch(
      /document\.querySelector\(\s*'\[role="dialog"\], \[role="alertdialog"\], \[data-modal-open="true"\]'/,
    );
    // Header-owned modals (settings / focus editor) get an explicit
    // guard too since they don't necessarily render a role=dialog.
    expect(src).toMatch(/if \(settingsOpen \|\| focusEditorOpen\) return;/);
  });

  it("the icon swaps title / aria-label / aria-pressed when active so screen readers know it toggles", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Active-state tooltip + aria-label change communicate the
    // second-click affordance ("Back to where you were"). aria-pressed
    // is the accessible signal that this is a toggle button — without
    // it, AT users would only hear "Bookmarks" and not know it's
    // currently asserted.
    expect(src).toMatch(/title=\{onBookmarks \? "Back to where you were" : "Bookmarks"\}/);
    expect(src).toMatch(
      /aria-label=\{onBookmarks \? "Close bookmarks and go back" : "Bookmarks"\}/,
    );
    expect(src).toMatch(/aria-pressed=\{onBookmarks\}/);
  });

  it("treats /bookmarks/* (e.g. /bookmarks/:id) as 'on bookmarks' for toggle purposes", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // Future-proofing: if we ever add a /bookmarks/:itemId detail
    // route, the toggle should still recognize it as "on the
    // bookmarks surface" so a second click from a detail view still
    // returns to the prior page rather than no-oping.
    expect(src).toMatch(
      /location\.pathname === "\/bookmarks" \|\| location\.pathname\.startsWith\("\/bookmarks\/"\)/,
    );
  });
});
