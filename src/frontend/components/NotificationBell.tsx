import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AppNotification, useNotifications } from "../hooks/useNotifications";

/**
 * Bell icon + dropdown panel in the app header.
 *
 * Concept split (intentional):
 *
 *   - The BELL is for things that need user attention: a deep dive
 *     finished, a briefing landed, a calibration is ready, something
 *     failed. These are status `ready` / `failed`. The bell badges
 *     the count of unread rows of these kinds.
 *
 *   - In-flight work (status `in_progress`) is NOT shown here and
 *     does NOT badge the bell. It lives in the separate
 *     `<ActivityIndicator>` next to the bell. Pre-fix the bell
 *     pulsed an accent dot whenever anything was running, which
 *     read as "you have something to look at" — but in-progress
 *     items by definition don't need user input. The split matches
 *     user intuition: "bell = act on this", "activity = work
 *     happening, FYI".
 *
 * Each notification row carries a kind, title, body, optional
 * actionUrl, and status. The dropdown stays generic over kind so
 * new bell-relevant kinds (briefing_ready, quiz_due, …) plug in
 * without UI changes.
 *
 * The dropdown also includes a "Clear all" button whenever there
 * are bell rows. Opening the dropdown auto-acknowledges unread
 * rows (so the badge clears), but the explicit button is the only
 * way to bulk-empty the panel — earlier this said "Mark all as
 * read" and only flipped acknowledgement state, which left the rows
 * sitting there read-but-still-visible with no obvious way to
 * clear them short of dismissing each one individually. The button
 * now actually empties the bell list (in-progress rows stay,
 * because they belong to the ActivityIndicator).
 */
export function NotificationBell() {
  const { notifications, unreadCount, refresh, acknowledge, acknowledgeAll, dismiss, dismissAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Bell-relevant rows only: anything not still in flight. The
  // ActivityIndicator owns in_progress; the bell owns "needs your
  // attention". Keeping the same ordering the API returned
  // (newest-first) so we don't have to re-sort.
  const bellNotifications = useMemo(() => notifications.filter((n) => n.status !== "in_progress"), [notifications]);

  // Acknowledge everything visible the moment the dropdown opens
  // (and again if a new unread row lands while it's still open).
  // The unread badge is for "you have something new"; once the user
  // has the panel in front of them, that's by definition no longer
  // true. We still show the rows; we just clear the unread count.
  useEffect(() => {
    if (open && unreadCount > 0) {
      void acknowledgeAll();
    }
  }, [open, unreadCount, acknowledgeAll]);

  // Refresh the list once on open so a freshly-completed notification
  // shows up even if it landed between polls.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Close on click-outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleRowClick = async (n: AppNotification) => {
    if (!n.acknowledgedAt) {
      void acknowledge(n.id);
    }
    setOpen(false);
    if (n.actionUrl) navigate(n.actionUrl);
  };

  const badgeText = unreadCount === 0 ? null : unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        // Same shape + size as the rest of the header icon buttons
        // (bookmark, prefs, activity) — see `HEADER_ICON_BUTTON_CLASSES`
        // in Header.tsx. Kept inline rather than imported because
        // NotificationBell is also reused by other surfaces.
        className="relative inline-flex items-center justify-center h-8 w-8 rounded-md text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {badgeText && (
          <span
            className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-negative text-white font-mono text-[9px] font-semibold px-1 leading-none"
            aria-hidden="true"
          >
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 w-[340px] max-h-[420px] rounded-lg bg-bg border border-border shadow-xl overflow-hidden flex flex-col z-50"
        >
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <span className="text-xs font-semibold text-text-primary">Notifications</span>
            <div className="flex items-center gap-3">
              {/*
               * "Clear all" empties the bell list in one click — the
               * bulk version of the per-row dismiss button. Shown
               * whenever there are bell rows; the action is a no-op
               * when the list is empty so we just hide it then. The
               * earlier label was "Mark all as read", but that only
               * flipped acknowledgement state — the rows stayed
               * visible and the user had no way to bulk-empty the
               * panel. The new label matches the new behavior.
               */}
              {bellNotifications.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    void dismissAll();
                  }}
                  className="text-[10px] font-mono text-accent hover:text-text-primary transition-colors"
                >
                  Clear all
                </button>
              )}
              <span className="text-[10px] font-mono text-text-dim">
                {bellNotifications.length === 0 ? "Nothing here" : `${bellNotifications.length} recent`}
              </span>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {bellNotifications.length === 0 ? (
              <div className="px-3 py-6 text-xs font-mono text-text-dim text-center">You're all caught up.</div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {bellNotifications.map((n) => (
                  <li key={n.id}>
                    <NotificationRow
                      notification={n}
                      onClick={() => handleRowClick(n)}
                      onDismiss={() => dismiss(n.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification: n,
  onClick,
  onDismiss,
}: {
  notification: AppNotification;
  onClick: () => void;
  onDismiss: () => void;
}) {
  const isClickable = n.status === "ready" && !!n.actionUrl;
  const statusColor = n.status === "ready" ? "bg-positive" : n.status === "failed" ? "bg-negative" : "bg-border";

  return (
    <div className="group relative flex items-start gap-2 px-3 py-2 hover:bg-surface-hover transition-colors">
      <span className={`shrink-0 mt-1 inline-block h-2 w-2 rounded-full ${statusColor}`} aria-hidden="true" />
      <button
        type="button"
        onClick={onClick}
        disabled={!isClickable}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-text-primary truncate">{n.title}</span>
          {!n.acknowledgedAt && <span className="shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-accent" />}
        </div>
        {n.body && <div className="mt-0.5 text-[11px] font-mono text-text-dim leading-snug">{n.body}</div>}
        <div className="mt-0.5 text-[10px] font-mono text-text-faint">
          {formatRelative(n.updatedAt)} · {n.kind.replace(/_/g, " ")}
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss"
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-text-faint hover:text-text-secondary hover:bg-surface-active"
      >
        <svg
          width="12"
          height="12"
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
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
    const ms = Date.now() - d.getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
