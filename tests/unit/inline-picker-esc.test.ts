/**
 * Pins the Esc-to-cancel contract on the inline pickers.
 *
 * Both the per-piece "try different model" picker (in `<ModelFooter>`)
 * and the "voice:" picker (in `<VoiceSwitcher>`) opened to a small
 * inline UI with a clickable "cancel" link to dismiss. The user
 * pointed out that Esc should do the same — it does on every other
 * dismissable surface in Primer. This change adds an Esc handler to
 * both pickers.
 *
 * Two design constraints worth pinning explicitly:
 *
 *   1. **Capture phase** — both handlers register with
 *      `addEventListener(..., true)` so they run BEFORE the chat
 *      panel's bubble-phase Esc listener. Without this, Esc inside
 *      a voice picker that's mounted inside the chat panel would
 *      bubble up to the chat panel and close the WHOLE panel
 *      instead of just the picker.
 *
 *   2. **stopPropagation + preventDefault** — even with capture
 *      ordering, we explicitly halt propagation so a future bubble-
 *      phase listener registered after these doesn't accidentally
 *      see the Esc and react.
 *
 *   3. **Only when expanded** — the listener is gated on the
 *      picker's open state. When closed, no global Esc listener is
 *      attached, so this doesn't conflict with other Esc bindings
 *      anywhere else in the app.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("ModelFooter — Esc cancels the try-different-model picker", () => {
  it("only registers the keydown listener while the picker is expanded", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,400}if \(!expanded\) return;[\s\S]{0,800}document\.addEventListener\("keydown", onKey, true\)/,
    );
  });

  it("uses capture phase + stopPropagation so it wins against parent surface Esc handlers", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The third `true` arg to addEventListener selects capture phase.
    expect(src).toMatch(/addEventListener\("keydown", onKey, true\)/);
    expect(src).toMatch(/removeEventListener\("keydown", onKey, true\)/);
    // stopPropagation in the handler keeps bubble-phase listeners
    // (e.g. ChatPanel's outer Esc) from firing.
    expect(src).toMatch(/e\.stopPropagation\(\)/);
    expect(src).toMatch(/e\.preventDefault\(\)/);
  });

  it("calls setExpanded(false) on Escape — same effect as clicking cancel", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(
      /if \(e\.key !== "Escape"\) return;[\s\S]{0,200}setExpanded\(false\)/,
    );
  });
});

describe("VoiceSwitcher — Esc cancels the voice picker", () => {
  it("only registers the keydown listener while the picker is expanded", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    expect(src).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,400}if \(!expanded\) return;[\s\S]{0,800}document\.addEventListener\("keydown", onKey, true\)/,
    );
  });

  it("uses capture phase + stopPropagation so the chat panel's outer Esc doesn't fire", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    expect(src).toMatch(/addEventListener\("keydown", onKey, true\)/);
    expect(src).toMatch(/removeEventListener\("keydown", onKey, true\)/);
    expect(src).toMatch(/e\.stopPropagation\(\)/);
    expect(src).toMatch(/e\.preventDefault\(\)/);
  });

  it("calls setExpanded(false) on Escape — same effect as clicking cancel", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    expect(src).toMatch(
      /if \(e\.key !== "Escape"\) return;[\s\S]{0,200}setExpanded\(false\)/,
    );
  });
});

describe("Both pickers degrade gracefully — listener cleaned up on unmount", () => {
  it("ModelFooter returns a cleanup that matches the same capture phase", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(
      /document\.addEventListener\("keydown", onKey, true\);\s*return \(\) => document\.removeEventListener\("keydown", onKey, true\)/,
    );
  });

  it("VoiceSwitcher returns a cleanup that matches the same capture phase", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    expect(src).toMatch(
      /document\.addEventListener\("keydown", onKey, true\);\s*return \(\) => document\.removeEventListener\("keydown", onKey, true\)/,
    );
  });
});
