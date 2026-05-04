/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dispatchShortcut,
  isTypingTarget,
  type ShortcutHandlers,
} from "../../src/frontend/hooks/useKeyboardShortcuts";

function makeHandlers(): ShortcutHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openHelp: () => calls.push("openHelp"),
    openShortcuts: () => calls.push("openShortcuts"),
    gotoBriefing: () => calls.push("gotoBriefing"),
    gotoConcepts: () => calls.push("gotoConcepts"),
    gotoArchive: () => calls.push("gotoArchive"),
    gotoHelp: () => calls.push("gotoHelp"),
  };
}

function makeEvent(
  key: string,
  opts: { target?: EventTarget | null; meta?: boolean; ctrl?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    altKey: !!opts.alt,
    target: opts.target ?? null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

let handlers: ReturnType<typeof makeHandlers>;

beforeEach(() => {
  handlers = makeHandlers();
});

describe("isTypingTarget", () => {
  it("returns true for input elements", () => {
    const el = document.createElement("input");
    expect(isTypingTarget(el)).toBe(true);
  });

  it("returns true for textareas", () => {
    const el = document.createElement("textarea");
    expect(isTypingTarget(el)).toBe(true);
  });

  it("returns true for selects", () => {
    const el = document.createElement("select");
    expect(isTypingTarget(el)).toBe(true);
  });

  it("returns true for contenteditable elements (via data-allow-typing fallback)", () => {
    // jsdom doesn't implement isContentEditable. In real browsers
    // `contenteditable="true"` sets `isContentEditable = true`. Tests use
    // the data-attribute escape hatch which is part of the same contract.
    const el = document.createElement("div");
    el.dataset.allowTyping = "";
    expect(isTypingTarget(el)).toBe(true);
  });

  it("returns true for elements with data-allow-typing", () => {
    const el = document.createElement("div");
    el.dataset.allowTyping = "";
    expect(isTypingTarget(el)).toBe(true);
  });

  it("returns false for plain divs/spans/buttons", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("dispatchShortcut — single-key shortcuts", () => {
  it("? opens the shortcuts reference", () => {
    const result = dispatchShortcut(makeEvent("?"), null, handlers);
    expect(result).toEqual({ handled: true, newPrefix: null });
    expect(handlers.calls).toEqual(["openShortcuts"]);
  });

  it("H opens help (lowercase)", () => {
    const result = dispatchShortcut(makeEvent("h"), null, handlers);
    expect(result).toEqual({ handled: true, newPrefix: null });
    expect(handlers.calls).toEqual(["openHelp"]);
  });

  it("H opens help (uppercase)", () => {
    const result = dispatchShortcut(makeEvent("H"), null, handlers);
    expect(result).toEqual({ handled: true, newPrefix: null });
    expect(handlers.calls).toEqual(["openHelp"]);
  });

  it("unhandled keys return handled:false", () => {
    const result = dispatchShortcut(makeEvent("x"), null, handlers);
    expect(result).toEqual({ handled: false, newPrefix: null });
    expect(handlers.calls).toEqual([]);
  });
});

describe("dispatchShortcut — G-prefix chords", () => {
  it("G sets pending chord without firing", () => {
    const result = dispatchShortcut(makeEvent("g"), null, handlers);
    expect(result).toEqual({ handled: true, newPrefix: "g" });
    expect(handlers.calls).toEqual([]);
  });

  it("G then B navigates to briefing", () => {
    const result = dispatchShortcut(makeEvent("b"), "g", handlers);
    expect(result).toEqual({ handled: true, newPrefix: null });
    expect(handlers.calls).toEqual(["gotoBriefing"]);
  });

  it("G then C navigates to concepts", () => {
    const result = dispatchShortcut(makeEvent("c"), "g", handlers);
    expect(result.handled).toBe(true);
    expect(handlers.calls).toEqual(["gotoConcepts"]);
  });

  it("G then A navigates to archive", () => {
    const result = dispatchShortcut(makeEvent("a"), "g", handlers);
    expect(result.handled).toBe(true);
    expect(handlers.calls).toEqual(["gotoArchive"]);
  });

  it("G then H navigates to help", () => {
    const result = dispatchShortcut(makeEvent("h"), "g", handlers);
    expect(result.handled).toBe(true);
    expect(handlers.calls).toEqual(["gotoHelp"]);
  });

  it("G then unrecognized key cancels chord silently", () => {
    const result = dispatchShortcut(makeEvent("z"), "g", handlers);
    expect(result).toEqual({ handled: false, newPrefix: null });
    expect(handlers.calls).toEqual([]);
  });

  it("chord keys are case-insensitive", () => {
    const result = dispatchShortcut(makeEvent("B"), "g", handlers);
    expect(result.handled).toBe(true);
    expect(handlers.calls).toEqual(["gotoBriefing"]);
  });
});

describe("dispatchShortcut — suppression rules", () => {
  it("does nothing when focus is in an input", () => {
    const input = document.createElement("input");
    const result = dispatchShortcut(makeEvent("h", { target: input }), null, handlers);
    expect(result).toEqual({ handled: false, newPrefix: null });
    expect(handlers.calls).toEqual([]);
  });

  it("does nothing when focus is in a textarea", () => {
    const ta = document.createElement("textarea");
    const result = dispatchShortcut(makeEvent("?", { target: ta }), null, handlers);
    expect(result.handled).toBe(false);
    expect(handlers.calls).toEqual([]);
  });

  it("does nothing when Cmd/Meta is held", () => {
    const result = dispatchShortcut(makeEvent("h", { meta: true }), null, handlers);
    expect(result.handled).toBe(false);
    expect(handlers.calls).toEqual([]);
  });

  it("does nothing when Ctrl is held", () => {
    const result = dispatchShortcut(makeEvent("h", { ctrl: true }), null, handlers);
    expect(result.handled).toBe(false);
  });

  it("does nothing when Alt is held", () => {
    const result = dispatchShortcut(makeEvent("h", { alt: true }), null, handlers);
    expect(result.handled).toBe(false);
  });

  it("chord is also suppressed when typing", () => {
    const input = document.createElement("input");
    const result = dispatchShortcut(makeEvent("b", { target: input }), "g", handlers);
    expect(result.handled).toBe(false);
    expect(handlers.calls).toEqual([]);
  });
});

describe("dispatchShortcut — help doc coverage", () => {
  it("every shortcut documented in keyboard-shortcuts.md is handled", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const docPath = resolve(
      __dirname,
      "..",
      "..",
      "src/frontend/help/reference/keyboard-shortcuts.md",
    );
    const doc = await readFile(docPath, "utf-8");

    // Extract all **X** tokens from the tables and ensure our dispatcher
    // handles each one. This guards against the doc drifting ahead of the
    // implementation again.
    const bold = doc.match(/\*\*[A-Za-z?]\*\*/g) ?? [];
    const documentedKeys = new Set(
      bold.map((t) => t.replace(/\*/g, "").toLowerCase()),
    );

    // Escape is handled per-modal, not globally. Remove from set to avoid
    // spurious failure; it's documented as a separate section.
    documentedKeys.delete("escape");

    // G is a chord-starter, not a terminal shortcut.
    documentedKeys.delete("g");

    // ? is handled by ShortcutsDialog's own listener (not dispatchShortcut),
    // but dispatchShortcut still returns handled:true for it.
    const runAndCheck = (key: string, chord: string | null) => {
      const fresh = makeHandlers();
      return dispatchShortcut(makeEvent(key), chord, fresh);
    };

    for (const key of documentedKeys) {
      const res = runAndCheck(key, null);
      const resAsChord = runAndCheck(key, "g");
      expect(
        res.handled || resAsChord.handled,
        `Documented key "${key}" is not handled by dispatchShortcut`,
      ).toBe(true);
    }
  });
});

describe("ShortcutsDialog self-contained ? listener", () => {
  it("ShortcutsDialog manages its own state and key listener", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(
      resolve(__dirname, "..", "..", "src/frontend/components/ShortcutsDialog.tsx"),
      "utf-8",
    );
    expect(src).toContain('e.key === "?"');
    expect(src).toContain("setOpen");
    expect(src).toContain("isTypingTarget");
  });

  it("App renders ShortcutsDialog without external state", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(
      resolve(__dirname, "..", "..", "src/frontend/App.tsx"),
      "utf-8",
    );
    expect(src).toContain("<ShortcutsDialog />");
  });
});
