import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { onPrimerEvent } from "../lib/events";

const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

function formatKey(key: string): string {
  if (key === "Cmd") return isMac ? "\u2318" : "Ctrl";
  return key;
}

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string[]; description: string }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Command Palette",
    items: [{ keys: ["Cmd", "K"], description: "Open command palette" }],
  },
  {
    title: "Help",
    items: [
      { keys: ["H"], description: "Open help index" },
      { keys: ["?"], description: "Show this shortcuts dialog" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: ["G", "B"], description: "Go to briefing" },
      { keys: ["G", "C"], description: "Go to concepts" },
      { keys: ["G", "A"], description: "Go to archive" },
      { keys: ["G", "H"], description: "Go to help" },
    ],
  },
  {
    title: "Panels",
    items: [{ keys: ["Esc"], description: "Close current modal or panel" }],
  },
];

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // External open hook — the Cmd+K command palette dispatches this
  // event when the user picks "Show keyboard shortcuts". Mirrors the
  // open-settings / open-chat pattern in the Header / App so the
  // palette doesn't have to thread state through props.
  useEffect(() => onPrimerEvent("open-shortcuts", () => setOpen(true)), []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setOpen(false)}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm rounded-xl bg-bg border border-border shadow-2xl overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <h3 className="text-sm font-bold text-text-primary uppercase tracking-wider">Keyboard Shortcuts</h3>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-text-dim hover:text-text-primary p-1 rounded-md hover:bg-surface-hover transition-colors"
            aria-label="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="py-2 max-h-[70vh] overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-5 pt-3 pb-1">
                <span className="text-[10px] font-mono text-text-dim uppercase tracking-wider">{group.title}</span>
              </div>
              {group.items.map((shortcut) => (
                <div key={shortcut.description} className="flex items-center justify-between px-5 py-1.5">
                  <span className="text-xs font-mono text-text-secondary">{shortcut.description}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && <span className="text-text-faint text-[10px]">then</span>}
                        <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border-subtle text-[10px] font-mono text-text-secondary min-w-[24px] text-center">
                          {formatKey(key)}
                        </kbd>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="px-5 py-2.5 border-t border-border-subtle">
          <p className="text-[10px] font-mono text-text-faint">Shortcuts are disabled while typing in inputs.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
