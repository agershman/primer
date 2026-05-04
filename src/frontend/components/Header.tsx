import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { type FontSize, useFontSize } from "../hooks/useFontSize";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { onPrimerEvent } from "../lib/events";
import { ActivityIndicator } from "./ActivityIndicator";
import { FocusEditor } from "./FocusEditor";
import { FocusIcon, GearIcon } from "./icons/HeaderIcons";
import { NotificationBell } from "./NotificationBell";
import { SettingsPanel } from "./SettingsPanel";

const NAV_ITEMS = [
  { path: "/", label: "Briefing" },
  { path: "/concepts", label: "Concepts" },
  { path: "/archive", label: "Archive" },
  { path: "/analytics", label: "Analytics" },
  { path: "/help", label: "Help" },
];

type ThemeMode = "light" | "dark" | "system";

// Every icon in the header's top-right cluster uses the same 16×16
// SVG nominal size so the bookmark / bell / prefs buttons look like
// siblings instead of three different icon vocabularies. The shared
// `HeaderIconButton` wraps each one in the same 32×32 hit-area shape.
const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: (active: boolean) => React.ReactNode }> = [
  {
    value: "light",
    label: "Light",
    icon: (active) => (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={active ? "text-text-primary" : "text-text-dim"}
      >
        <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (active) => (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={active ? "text-text-primary" : "text-text-dim"}
      >
        <path
          d="M13.4 10.2A6 6 0 0 1 5.8 2.6a6.5 6.5 0 1 0 7.6 7.6Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (active) => (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={active ? "text-text-primary" : "text-text-dim"}
      >
        <rect x="2" y="2" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.5 14h5M8 11v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
];

/**
 * Shared icon-button shape for the header's top-right utility row.
 * 32×32 hit area, rounded square, transparent until hovered. Every
 * action in that cluster (bookmark, notifications, prefs) uses this
 * so they read as siblings rather than three differently-styled
 * controls. Avatar stays distinct on purpose (round + colored
 * background) because it represents identity, not utility.
 */
const HEADER_ICON_BUTTON_CLASSES =
  "inline-flex items-center justify-center h-8 w-8 rounded-md text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors";

const FONT_SIZE_OPTIONS: Array<{ value: FontSize; label: string; icon: string }> = [
  { value: "small", label: "Small", icon: "A" },
  { value: "medium", label: "Medium", icon: "A" },
  { value: "large", label: "Large", icon: "A" },
];

function QuickPrefs({
  themeMode,
  setThemeMode,
  fontSize,
  setFontSize,
}: {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  fontSize: FontSize;
  setFontSize: (s: FontSize) => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div className="relative hidden sm:block">
      <button
        onClick={() => setOpen(!open)}
        // Drops the previous bordered "M" / "L" letter trigger.
        // The closed-state button is now an icon button that visually
        // matches Bookmark + Notifications. The font-size letter
        // didn't earn its place — readers who change font size do
        // it once and forget; the popover still shows the current
        // pick when they actually open it.
        className={HEADER_ICON_BUTTON_CLASSES}
        title="Display preferences"
        aria-label="Display preferences"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {THEME_OPTIONS.find((o) => o.value === themeMode)?.icon(true)}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-30 rounded-lg border border-border bg-bg shadow-xl p-3 w-48 animate-fade-in">
            <div className="font-mono text-[10px] text-text-dim uppercase tracking-wider mb-2">Theme</div>
            <div className="flex items-center rounded-md border border-border overflow-hidden mb-3">
              {THEME_OPTIONS.map((option) => {
                const isActive = themeMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    title={option.label}
                    onClick={() => setThemeMode(option.value)}
                    className={`flex-1 flex items-center justify-center p-1.5 transition-colors ${
                      isActive ? "bg-surface-active text-text-primary" : "text-text-dim hover:text-text-secondary"
                    }`}
                  >
                    {option.icon(isActive)}
                  </button>
                );
              })}
            </div>

            <div className="font-mono text-[10px] text-text-dim uppercase tracking-wider mb-2">Font size</div>
            <div className="flex items-center rounded-md border border-border overflow-hidden">
              {FONT_SIZE_OPTIONS.map((option) => {
                const isActive = fontSize === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    title={option.label}
                    onClick={() => setFontSize(option.value)}
                    className={`flex-1 flex items-center justify-center py-1.5 transition-colors ${
                      isActive ? "bg-surface-active text-text-primary" : "text-text-dim hover:text-text-secondary"
                    }`}
                  >
                    <span
                      className={`font-ui font-medium ${
                        option.value === "small" ? "text-[10px]" : option.value === "medium" ? "text-xs" : "text-sm"
                      }`}
                    >
                      {option.icon}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function getInitials(email: string, displayName: string | null): string {
  if (displayName) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0][0].toUpperCase();
  }
  return email[0].toUpperCase();
}

function UserAvatar({
  email,
  displayName,
  avatarUrl,
  isAdmin = false,
  onClick,
  ariaLabel,
  ariaExpanded,
}: {
  email: string;
  displayName: string | null;
  avatarUrl?: string | null;
  isAdmin?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  ariaExpanded?: boolean;
}) {
  const initials = getInitials(email, displayName);
  // Admin users get a 2px accent ring around the circle. Subtle but
  // unmistakable when you know to look — pairs with the "Admin" pill
  // in the dropdown to make role visible at-a-glance, so an admin
  // poking around the UI never has to wonder whether a restricted
  // setting is going to be writable for them. The ring is drawn via
  // Tailwind's `ring-*` utility (an outset box-shadow) so it sits
  // outside the rounded background instead of clipping the inner
  // text/initials. `ring-offset-1` separates the ring from the bg
  // by a 1px gap so it reads as an outline, not a thicker fill.
  // The ring color uses `accent` (not `accent-dim`) so it has
  // enough contrast against the page background to be visible.
  const adminRing = isAdmin ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : "";
  const titleSuffix = isAdmin ? " · Admin" : "";
  return (
    <button
      onClick={onClick}
      // Sized to match the rest of the header icon-button rhythm
      // (32×32) so the cluster reads as one unit. Round + accent
      // background keeps the avatar visually distinct from the
      // borderless utility icons next to it.
      className={`flex h-8 w-8 items-center justify-center rounded-full bg-accent-dim text-accent font-ui text-[11px] font-semibold select-none transition-colors hover:bg-accent-muted cursor-pointer overflow-hidden ${adminRing}`}
      title={`${displayName || email}${titleSuffix}`}
      aria-label={ariaLabel ?? (isAdmin ? "Open menu (Admin)" : "Open menu")}
      aria-haspopup="menu"
      aria-expanded={ariaExpanded ?? false}
      data-admin={isAdmin || undefined}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : initials}
    </button>
  );
}

/**
 * Avatar dropdown menu — opens off the avatar button in the header.
 * This is the canonical surface for "I want to peek at / change my
 * profile preferences" actions:
 *
 *   • Set focus → opens the FocusEditor modal (shows current focus,
 *     lets the user save a new version). Replaces the previous
 *     in-flow focus pill on the briefing page; focus is now a
 *     profile-level concept, not a per-briefing one.
 *   • Settings → opens the full SettingsPanel (sources, models,
 *     full About + Focus history, retention, etc.).
 *
 * Click-outside dismisses, as does Escape. The menu is portal-free
 * (anchored absolute under the avatar) because there's only ever one
 * open at a time and the layout has plenty of right-edge gutter on
 * the breakpoints we care about.
 */
interface AvatarMenuProps {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  currentFocus: string | null;
  isAdmin: boolean;
  onOpenFocus: () => void;
  onOpenSettings: () => void;
}

function AvatarMenu({
  email,
  displayName,
  avatarUrl,
  currentFocus,
  isAdmin,
  onOpenFocus,
  onOpenSettings,
}: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click-outside to dismiss. Defer the listener install so the click
  // that *opened* the menu doesn't immediately close it.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onMouseDown), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const focusPreview = currentFocus?.trim() || null;

  return (
    <div ref={containerRef} className="relative">
      <UserAvatar
        email={email}
        displayName={displayName}
        avatarUrl={avatarUrl}
        isAdmin={isAdmin}
        ariaLabel={open ? "Close menu" : "Open menu"}
        ariaExpanded={open}
        onClick={() => setOpen((cur) => !cur)}
      />

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 z-30 rounded-lg border border-border bg-bg shadow-xl w-72 py-1 animate-fade-in"
        >
          {/* Identity strip — small, informational, not a menu item.
              The Admin pill makes role visible at-a-glance so admins
              don't accidentally assume they're a regular user when
              poking around restricted UI. Regular users see no
              pill (the absence is implicit). */}
          <div className="px-3 py-2 border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <div className="font-ui text-xs font-medium text-text-primary truncate flex-1 min-w-0">
                {displayName || email}
              </div>
              {isAdmin && (
                <span
                  className="shrink-0 inline-flex items-center rounded-full border border-accent/30 bg-accent-dim px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent"
                  title="You can configure deployment-wide settings (sources, AI models, voice, limits)."
                >
                  Admin
                </span>
              )}
            </div>
            {displayName && <div className="font-mono text-[10px] text-text-faint truncate">{email}</div>}
          </div>

          {/* Set focus */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenFocus();
            }}
            className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
          >
            <FocusIcon />
            <div className="flex-1 min-w-0">
              <div className="font-ui text-xs font-medium text-text-primary">Set focus</div>
              <div
                className="font-mono text-[10px] text-text-dim mt-0.5 leading-snug"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {focusPreview ?? (
                  <span className="italic text-text-faint">Not set — click to write your first focus statement.</span>
                )}
              </div>
            </div>
          </button>

          {/* Settings */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-hover transition-colors"
          >
            <GearIcon />
            <span className="font-ui text-xs font-medium text-text-primary">Settings</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, setMode } = useTheme();
  const { size: fontSize, setSize: setFontSize } = useFontSize();
  const { user, refresh: refreshUser } = useCurrentUser();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusEditorOpen, setFocusEditorOpen] = useState(false);
  const settingsHook = useSettings();

  // Cross-component open hooks: the Cmd+K command palette dispatches
  // these events so it doesn't have to know about the Header's
  // internal modal state. Same pattern Primer already uses for
  // `primer:tts-voice-changed`.
  useEffect(() => {
    const offSettings = onPrimerEvent("open-settings", () => setSettingsOpen(true));
    const offFocus = onPrimerEvent("open-focus-editor", () => setFocusEditorOpen(true));
    return () => {
      offSettings();
      offFocus();
    };
  }, []);

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/" || location.pathname.startsWith("/briefing");
    return location.pathname.startsWith(path);
  };

  // Bookmark icon acts as a TOGGLE: if you're already on /bookmarks,
  // clicking it (or pressing Escape) returns you to whatever page you
  // were on before. We track the last non-bookmark location in a ref
  // that updates on every route change. Initial value is "/" so a
  // user who deep-links straight onto /bookmarks (refresh, shared
  // URL) gets sent home rather than landing in an empty back-stack.
  //
  // We capture pathname + search + hash so a user reading ?date=2026-04-15
  // on the briefing page, jumping into bookmarks, and dismissing,
  // lands back on the same dated briefing — not the unparameterized
  // root.
  const prevPathRef = useRef<string>("/");
  const onBookmarks = location.pathname === "/bookmarks" || location.pathname.startsWith("/bookmarks/");
  useEffect(() => {
    if (!onBookmarks) {
      prevPathRef.current = location.pathname + location.search + location.hash;
    }
  }, [location.pathname, location.search, location.hash, onBookmarks]);

  const goBackFromBookmarks = () => {
    navigate(prevPathRef.current || "/");
  };

  const onBookmarkIconClick = () => {
    if (onBookmarks) {
      goBackFromBookmarks();
    } else {
      navigate("/bookmarks");
    }
  };

  // Escape on /bookmarks → return. Skipped when a modal/dialog is
  // already on top so the dialog's own Esc handler runs first
  // (settings, focus editor, chat panel, refine dialog, etc.). We
  // sniff for `role="dialog"` / `role="alertdialog"` rather than
  // coupling to each modal's open state — keeps the back-stack glue
  // independent of what's stacked above it.
  useEffect(() => {
    if (!onBookmarks) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (settingsOpen || focusEditorOpen) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [data-modal-open="true"]')) {
        return;
      }
      goBackFromBookmarks();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigate + ref are stable; goBackFromBookmarks would re-create the listener on every render
  }, [onBookmarks, settingsOpen, focusEditorOpen]);

  return (
    <header
      className="sticky top-0 z-10 border-b border-border-subtle bg-bg/90 backdrop-blur-md"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-[860px] items-center justify-between px-4 sm:px-6 py-3">
        <Link to="/" className="flex items-baseline gap-1 no-underline" onClick={() => setMobileMenuOpen(false)}>
          <span className="font-display text-xl sm:text-2xl font-medium tracking-tight text-text-primary">Primer</span>
          <span className="text-accent text-[10px] mb-1">●</span>
        </Link>

        <nav className="hidden md:flex gap-0.5">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`rounded-md px-3 py-1.5 font-ui text-xs font-medium capitalize no-underline transition-colors ${
                isActive(item.path) ? "bg-surface text-text-primary" : "text-text-dim hover:text-text-primary"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {/*
         * Top-right cluster.
         * Two visual groups separated by a slightly larger gap:
         *   1. Utility: bookmarks, notifications, display preferences.
         *      All borderless 32×32 icon buttons sharing
         *      `HEADER_ICON_BUTTON_CLASSES` so they read as siblings.
         *   2. Identity: the avatar dropdown — round, accent-colored,
         *      visually distinct so it doesn't blend into the utility
         *      cluster.
         * Mobile menu toggle lives outside both groups since it's
         * platform-conditional UI.
         */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onBookmarkIconClick}
            className={`hidden sm:inline-flex ${HEADER_ICON_BUTTON_CLASSES} ${
              onBookmarks ? "bg-surface text-text-primary" : ""
            }`}
            title={onBookmarks ? "Back to where you were" : "Bookmarks"}
            aria-label={onBookmarks ? "Close bookmarks and go back" : "Bookmarks"}
            aria-pressed={onBookmarks}
            aria-current={onBookmarks ? "page" : undefined}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill={onBookmarks ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 2h8a1 1 0 0 1 1 1v11l-5-3-5 3V3a1 1 0 0 1 1-1z" />
            </svg>
          </button>
          {/*
           * Activity indicator sits LEFT of the bell so the
           * left-to-right reading order is "currently working" → "needs
           * your attention" — natural progression, and the activity icon
           * hides itself entirely when nothing is in flight, so the
           * default header has the bell as the leftmost utility icon
           * (no jarring layout shift between idle and active states).
           */}
          {user && <ActivityIndicator />}
          {user && <NotificationBell />}
          <QuickPrefs themeMode={mode} setThemeMode={setMode} fontSize={fontSize} setFontSize={setFontSize} />

          {/* Visual breathing room separating utility actions from
              the identity / account menu — subtle, no literal divider
              line, just a slightly wider gap. */}
          {user && (
            <div className="ml-1.5">
              <AvatarMenu
                email={user.email}
                displayName={user.displayName}
                avatarUrl={user.avatarUrl}
                currentFocus={user.focusStatement ?? null}
                isAdmin={user.isAdmin}
                onOpenFocus={() => setFocusEditorOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </div>
          )}

          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className={`md:hidden ${HEADER_ICON_BUTTON_CLASSES}`}
            aria-label="Toggle menu"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              {mobileMenuOpen ? (
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              ) : (
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <nav className="md:hidden border-t border-border-subtle px-4 py-2 bg-bg">
          {[...NAV_ITEMS, { path: "/bookmarks", label: "Bookmarks" }].map((item) => (
            <Link
              key={item.path}
              to={item.path}
              onClick={() => setMobileMenuOpen(false)}
              className={`block rounded-md px-3 py-2.5 font-ui text-sm no-underline transition-colors ${
                isActive(item.path)
                  ? "bg-surface text-text-primary font-medium"
                  : "text-text-secondary hover:bg-surface-hover"
              }`}
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-2 pt-2 border-t border-border-subtle px-3 py-2.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-text-dim uppercase">Theme</span>
              <div className="flex items-center rounded-md border border-border overflow-hidden">
                {THEME_OPTIONS.map((option) => {
                  const isActive = mode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      title={option.label}
                      onClick={() => setMode(option.value)}
                      className={`flex items-center justify-center w-10 h-9 transition-colors ${
                        isActive ? "bg-surface-active text-text-primary" : "text-text-dim"
                      }`}
                    >
                      {option.icon(isActive)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-text-dim uppercase">Font</span>
              <div className="flex items-center rounded-md border border-border overflow-hidden">
                {FONT_SIZE_OPTIONS.map((option) => {
                  const isActive = fontSize === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      title={option.label}
                      onClick={() => setFontSize(option.value)}
                      className={`flex items-center justify-center w-10 h-9 transition-colors ${
                        isActive ? "bg-surface-active text-text-primary" : "text-text-dim"
                      }`}
                    >
                      <span
                        className={`font-ui font-medium ${
                          option.value === "small" ? "text-[10px]" : option.value === "medium" ? "text-xs" : "text-sm"
                        }`}
                      >
                        {option.icon}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            {user && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setFocusEditorOpen(true);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-surface-hover transition-colors"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <FocusIcon />
                    <span className="font-ui text-xs text-text-secondary">Set focus</span>
                  </span>
                  <span
                    className="font-mono text-[10px] text-text-faint truncate flex-1 text-right"
                    style={{ maxWidth: "60%" }}
                  >
                    {user.focusStatement?.trim() || "not set"}
                  </span>
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  <span className="font-ui text-xs text-text-dim truncate">{user.email}</span>
                  <UserAvatar
                    email={user.email}
                    displayName={user.displayName}
                    avatarUrl={user.avatarUrl}
                    isAdmin={user.isAdmin}
                    ariaLabel="Open settings"
                  />
                </button>
              </div>
            )}
          </div>
        </nav>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settingsHook}
          user={user}
          onClose={() => setSettingsOpen(false)}
          onUserChanged={refreshUser}
        />
      )}

      {focusEditorOpen && (
        <FocusEditor
          currentFocus={user?.focusStatement ?? null}
          onCancel={() => setFocusEditorOpen(false)}
          onSaved={async () => {
            setFocusEditorOpen(false);
            // Refresh /api/me so the dropdown's "current focus" preview
            // and any other surface that reads `user.focusStatement`
            // (Settings panel, briefing-page subsequent renders) sees
            // the new statement immediately.
            await refreshUser();
          }}
        />
      )}
    </header>
  );
}
