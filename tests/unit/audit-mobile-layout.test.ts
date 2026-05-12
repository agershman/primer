import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * Round-1 shipped the audit indicator with the dropdown anchored
 * `right-0` unconditionally. On narrow viewports the pill often
 * wraps to the start of its row (left-aligned), so a right-anchored
 * menu with `min-w-[14rem]` ends up with a negative left edge — the
 * user sees "t marks" and "audit trail" with the rest clipped off
 * the screen.
 *
 * Round-2 anchors the menu LEFT on mobile and right on `sm:` and up,
 * and caps width at `calc(100vw-2rem)` so the menu can never extend
 * past the viewport even when the pill is roughly centered.
 *
 * The AuditTrailPanel modal had a similar mobile issue — the inner
 * card was `w-full max-w-2xl` with no horizontal padding, so on a
 * 375px screen it hugged the edges and the empty state was nearly
 * invisible. Round-2 adds explicit margin + the "what is this
 * trail" explainer paragraph at the top so users land on a panel
 * with both visible structure and clear copy.
 *
 * These tests pin the className strings so a future Tailwind
 * refactor can't silently regress.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("AuditIndicator dropdown — mobile clipping fix", () => {
  it("menu pins LEFT on narrow viewports and RIGHT on sm+", async () => {
    const src = await read("src/frontend/components/AuditIndicator.tsx");
    expect(src).toMatch(/left-0\s+sm:left-auto\s+sm:right-0/);
  });

  it("menu has a hard max-width that keeps it inside the viewport", async () => {
    const src = await read("src/frontend/components/AuditIndicator.tsx");
    expect(src).toMatch(/max-w-\[calc\(100vw-2rem\)\]/);
  });

  it("menu retains its minimum width so the items don't collapse on desktop", async () => {
    const src = await read("src/frontend/components/AuditIndicator.tsx");
    expect(src).toMatch(/min-w-\[14rem\]/);
  });
});

describe("AuditTrailPanel — mobile sizing + explainer", () => {
  it("panel has horizontal margin so it doesn't hug the viewport edges on mobile", async () => {
    const src = await read("src/frontend/components/AuditTrailPanel.tsx");
    expect(src).toMatch(/w-\[calc\(100%-1rem\)\]\s+sm:w-full/);
    expect(src).toMatch(/mx-2\s+sm:mx-0/);
  });

  it("panel renders an explainer paragraph above the pass list", async () => {
    const src = await read("src/frontend/components/AuditTrailPanel.tsx");
    expect(src).toMatch(/Every factual claim/);
    expect(src).toMatch(/web-search backstop/);
  });

  it("empty state renders a styled card, not a thin gray line", async () => {
    const src = await read("src/frontend/components/AuditTrailPanel.tsx");
    expect(src).toMatch(/No audit on this content/);
    expect(src).toMatch(/predates the audit feature/);
    // The card must wrap in a bordered container so it visually
    // anchors against the surface — the round-1 single-paragraph
    // rendering looked like an empty modal.
    expect(src).toMatch(/border\s+border-border-subtle\s+bg-bg-warm/);
  });
});

describe("RichText audit marks — accessibility hint", () => {
  it("every audit-mark span carries a title attribute with the verdict description", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toMatch(/VERDICT_TITLES/);
    expect(src).toMatch(/title=\{verdictTitle\}/);
  });

  it("the patched variant has its own descriptive title", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toMatch(/Patched by audit/);
  });
});
