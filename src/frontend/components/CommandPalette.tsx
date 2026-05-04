import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useIsAdmin } from "../hooks/useCurrentUser";
import { type FontSize, useFontSize } from "../hooks/useFontSize";
import { useTheme } from "../hooks/useTheme";
import { dispatchPrimerEvent, onPrimerEvent, primerEventName } from "../lib/events";
import { getAllHelpPages } from "../lib/helpRegistry";

/**
 * Cmd+K command palette.
 *
 * A keyboard-driven launcher that lets a user navigate, change
 * preferences, and trigger actions without leaving their place.
 * Wires up Primer's design tokens and the surfaces Primer exposes:
 * navigation, settings, theme + font size, help articles, and the
 * focus editor / chat / shortcuts dialogs.
 *
 * Cross-component triggers (open Settings, open Chat, open Focus
 * editor, open Shortcuts) flow through the typed event bus in
 * `src/frontend/lib/events.ts`. The legacy `OPEN_*_EVENT` string
 * constants exported below are kept as re-exports of
 * `primerEventName(...)` so external listeners that already
 * `addEventListener("primer:open-chat", ...)` keep firing — the
 * wire format hasn't changed, only the type-checked dispatch path
 * has. New call sites should use `dispatchPrimerEvent` /
 * `onPrimerEvent` directly. See [ADR 0001](../../../dev-docs/adrs/0001-custom-event-bus.md)
 * for the rationale.
 */

export const COMMAND_PALETTE_OPEN_EVENT = primerEventName("open-command-palette");

// Backwards-compatible string aliases. The typed bus is the source
// of truth; these are re-exports of the wire-format strings for
// callers that still subscribe via raw `addEventListener`.
export const OPEN_SETTINGS_EVENT = primerEventName("open-settings");
export const OPEN_CHAT_EVENT = primerEventName("open-chat");
export const OPEN_FOCUS_EDITOR_EVENT = primerEventName("open-focus-editor");
export const OPEN_SHORTCUTS_EVENT = primerEventName("open-shortcuts");

interface PaletteItem {
  id: string;
  label: string;
  category: string;
  hint?: string;
  /**
   * Optional keywords that don't appear in `label` but should still
   * match the search box (e.g. "preferences" maps to Settings,
   * "shortcuts" maps to Help → Keyboard Shortcuts).
   */
  keywords?: string[];
  action: () => void;
}

const NAV_PAGES: Array<{ path: string; label: string; hint?: string; keywords?: string[] }> = [
  { path: "/", label: "Briefing", hint: "Today's briefing" },
  { path: "/concepts", label: "Concepts", hint: "Trails + concept graph" },
  { path: "/archive", label: "Archive", hint: "Past briefings" },
  { path: "/analytics", label: "Analytics", hint: "Cost + pipeline waterfall" },
  { path: "/bookmarks", label: "Bookmarks", hint: "Saved briefing items", keywords: ["saved"] },
  { path: "/help", label: "Help", hint: "Documentation" },
];

const THEME_OPTIONS: Array<{ value: "light" | "dark" | "system"; label: string }> = [
  { value: "light", label: "Switch to light mode" },
  { value: "dark", label: "Switch to dark mode" },
  { value: "system", label: "Use system theme" },
];

const FONT_SIZE_OPTIONS: Array<{ value: FontSize; label: string }> = [
  { value: "small", label: "Set font size to small" },
  { value: "medium", label: "Set font size to medium" },
  { value: "large", label: "Set font size to large" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { mode: theme, setMode: setTheme } = useTheme();
  const { size: fontSize, setSize: setFontSize } = useFontSize();
  const helpPages = useMemo(() => getAllHelpPages(), []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  // Cmd+K toggles the palette. Ctrl+K on non-Mac keyboards. We
  // prevent default early so the browser's URL-bar focus shortcut
  // (also Cmd+K in some browsers) doesn't fire alongside.
  //
  // Suppression: do NOT swallow Cmd+K when the user is typing in an
  // input — they may have rebound it for native browser behavior.
  // Actually the opposite: Cmd+K SHOULD work everywhere; that's the
  // whole point of a global launcher. We only skip if the focused
  // input has `data-allow-cmdk="false"` as an explicit opt-out.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        const target = event.target as HTMLElement | null;
        if (target?.dataset.allowCmdk === "false") return;
        event.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setSelectedIndex(0);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Programmatic open hook — anything in the app can dispatch
  // `primer:open-command-palette` to pop the palette without having
  // to know its internal state. Used by the avatar dropdown's
  // "Command palette…" entry, future help-page links, etc.
  useEffect(
    () =>
      onPrimerEvent("open-command-palette", () => {
        setOpen(true);
        setQuery("");
        setSelectedIndex(0);
      }),
    [],
  );

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    for (const nav of NAV_PAGES) {
      items.push({
        id: `nav-${nav.path}`,
        label: nav.label,
        category: "Navigate",
        hint: nav.hint,
        keywords: nav.keywords,
        action: () => {
          navigate(nav.path);
          close();
        },
      });
    }

    items.push({
      id: "action-open-settings",
      label: "Open settings",
      category: "Actions",
      hint: isAdmin ? "Sources, AI models, voice, account…" : "About, focus, filter, account",
      keywords: ["preferences", "config", "configuration"],
      action: () => {
        dispatchPrimerEvent("open-settings");
        close();
      },
    });
    items.push({
      id: "action-open-focus",
      label: "Update current focus",
      category: "Actions",
      hint: "Quick edit modal",
      keywords: ["focus", "set focus"],
      action: () => {
        dispatchPrimerEvent("open-focus-editor");
        close();
      },
    });
    items.push({
      id: "action-open-chat",
      label: "Open chat",
      category: "Actions",
      hint: "Ask Primer a question",
      keywords: ["claude", "ask"],
      action: () => {
        dispatchPrimerEvent("open-chat");
        close();
      },
    });
    items.push({
      id: "action-open-shortcuts",
      label: "Show keyboard shortcuts",
      category: "Actions",
      hint: "?",
      keywords: ["help", "hotkeys", "bindings"],
      action: () => {
        dispatchPrimerEvent("open-shortcuts");
        close();
      },
    });

    for (const opt of THEME_OPTIONS) {
      items.push({
        id: `theme-${opt.value}`,
        label: opt.label,
        category: "Theme",
        hint: theme === opt.value ? "current" : undefined,
        action: () => {
          setTheme(opt.value);
          close();
        },
      });
    }

    for (const opt of FONT_SIZE_OPTIONS) {
      items.push({
        id: `fontsize-${opt.value}`,
        label: opt.label,
        category: "Font size",
        hint: fontSize === opt.value ? "current" : undefined,
        action: () => {
          setFontSize(opt.value);
          close();
        },
      });
    }

    for (const page of helpPages) {
      items.push({
        id: `help-${page.id}`,
        label: page.title,
        category: "Help",
        hint: page.subtitle,
        action: () => {
          navigate(`/help/${page.id}`);
          close();
        },
      });
    }

    return items;
  }, [navigate, close, theme, setTheme, fontSize, setFontSize, helpPages, isAdmin]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((item) => {
      if (item.label.toLowerCase().includes(q)) return true;
      if (item.category.toLowerCase().includes(q)) return true;
      if (item.hint?.toLowerCase().includes(q)) return true;
      if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [allItems, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, PaletteItem[]> = {};
    for (const item of filtered) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    }
    return Object.entries(groups);
  }, [filtered]);

  // Reset selection when the query changes so the highlighted item
  // is always the first match — matches user expectations for
  // search-driven launchers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the trigger here, not a value to read
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (event.key === "Enter" && filtered[selectedIndex]) {
      event.preventDefault();
      filtered[selectedIndex].action();
    }
  };

  // Keep the highlighted row scrolled into view as the user navigates
  // with arrow keys. `block: "nearest"` avoids the jarring "scroll
  // selected item to center" behavior when the user is just nudging
  // up/down within the visible window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex is the trigger
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector("[data-selected='true']");
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  // Walk the grouped list once with a flat counter so we can match
  // the keyboard-driven `selectedIndex` (a flat 0..N) against the
  // grouped DOM rendering. Keeps the up/down arrow cursor coherent
  // across category boundaries.
  let flatIndex = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg rounded-xl border border-border bg-bg shadow-2xl overflow-hidden animate-fade-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="text-text-faint shrink-0"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5l3 3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search pages, actions, help…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            className="flex-1 bg-transparent border-none outline-none font-mono text-sm text-text-primary placeholder:text-text-faint"
          />
          <kbd className="px-1.5 py-0.5 rounded bg-surface border border-border-subtle text-[10px] font-mono text-text-dim">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-xs text-text-faint">
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            grouped.map(([category, items]) => (
              <div key={category}>
                <div className="px-4 pt-2 pb-1 font-ui text-[10px] font-semibold uppercase tracking-wider text-text-faint">
                  {category}
                </div>
                {items.map((item) => {
                  flatIndex++;
                  const isSelected = flatIndex === selectedIndex;
                  const currentIndex = flatIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-selected={isSelected}
                      onClick={item.action}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                      className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-left transition-colors ${
                        isSelected ? "bg-surface text-text-primary" : "text-text-secondary hover:bg-surface-hover"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className={`shrink-0 ${isSelected ? "text-accent" : "text-text-faint"}`}
                        >
                          <path d="M3 8h10M9 4l4 4-4 4" />
                        </svg>
                        <span className="font-mono text-xs font-medium truncate">{item.label}</span>
                      </div>
                      {item.hint ? (
                        <span className="font-mono text-[10px] text-text-faint shrink-0 max-w-[40%] truncate">
                          {item.hint}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-border-subtle flex items-center gap-3 font-mono text-[10px] text-text-faint">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-px rounded bg-surface border border-border-subtle text-[9px]">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-px rounded bg-surface border border-border-subtle text-[9px]">↵</kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-px rounded bg-surface border border-border-subtle text-[9px]">esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
