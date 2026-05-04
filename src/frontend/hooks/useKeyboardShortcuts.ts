import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Global keyboard shortcuts handler.
 *
 * Supports two kinds of bindings:
 *  - Single-key shortcuts (e.g. `?`, `H`) fire immediately.
 *  - G-prefixed chords (e.g. `g b`) require `g` followed by a second key
 *    within a short window — idiomatic for Gmail/GitHub-style navigation.
 *
 * Suppression rules:
 *  - Ignored while focus is inside an editable element (input, textarea,
 *    contenteditable, or element with `data-allow-typing`).
 *  - Ignored while any modifier key is held (Cmd/Ctrl/Alt/Meta).
 *  - Escape is handled by individual modals/panels (SettingsPanel, ChatPanel)
 *    and intentionally NOT captured here.
 */

const CHORD_WINDOW_MS = 750;

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.dataset.allowTyping !== undefined) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface ShortcutHandlers {
  openHelp: () => void;
  openShortcuts: () => void;
  gotoBriefing: () => void;
  gotoConcepts: () => void;
  gotoArchive: () => void;
  gotoHelp: () => void;
}

export function dispatchShortcut(
  event: KeyboardEvent,
  chordPrefix: string | null,
  handlers: ShortcutHandlers,
): { handled: boolean; newPrefix: string | null } {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return { handled: false, newPrefix: null };
  }
  if (isTypingTarget(event.target)) {
    return { handled: false, newPrefix: null };
  }

  const key = event.key;

  if (chordPrefix === "g") {
    switch (key.toLowerCase()) {
      case "b":
        handlers.gotoBriefing();
        return { handled: true, newPrefix: null };
      case "c":
        handlers.gotoConcepts();
        return { handled: true, newPrefix: null };
      case "a":
        handlers.gotoArchive();
        return { handled: true, newPrefix: null };
      case "h":
        handlers.gotoHelp();
        return { handled: true, newPrefix: null };
      default:
        return { handled: false, newPrefix: null };
    }
  }

  if (key === "?") {
    handlers.openShortcuts();
    return { handled: true, newPrefix: null };
  }

  if (key.toLowerCase() === "h") {
    handlers.openHelp();
    return { handled: true, newPrefix: null };
  }

  if (key.toLowerCase() === "g") {
    return { handled: true, newPrefix: "g" };
  }

  return { handled: false, newPrefix: null };
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const chordPrefix = useRef<string | null>(null);
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handlers: ShortcutHandlers = {
      openHelp: () => navigate("/help"),
      openShortcuts: () => {
        // Handled by ShortcutsDialog's own listener; no-op here to avoid
        // double-firing. The dispatchShortcut function still returns
        // handled:true so the event is preventDefault'd.
      },
      gotoBriefing: () => navigate("/"),
      gotoConcepts: () => navigate("/concepts"),
      gotoArchive: () => navigate("/archive"),
      gotoHelp: () => navigate("/help"),
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const { handled, newPrefix } = dispatchShortcut(event, chordPrefix.current, handlers);

      if (handled) {
        event.preventDefault();
      }

      if (chordTimer.current) {
        clearTimeout(chordTimer.current);
        chordTimer.current = null;
      }
      chordPrefix.current = newPrefix;
      if (newPrefix) {
        chordTimer.current = setTimeout(() => {
          chordPrefix.current = null;
          chordTimer.current = null;
        }, CHORD_WINDOW_MS);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (chordTimer.current) clearTimeout(chordTimer.current);
    };
  }, [navigate]);
}
