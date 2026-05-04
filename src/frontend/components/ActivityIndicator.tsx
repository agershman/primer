import { useEffect, useMemo, useRef, useState } from "react";
import { type AppNotification, useNotifications } from "../hooks/useNotifications";

/**
 * Activity indicator — sibling of `<NotificationBell>` in the header.
 *
 * Shows ONLY when there's at least one notification in `in_progress`
 * status. Pre-fix the bell pulsed an accent dot for in-flight work,
 * which the user reported reading as "you have something to look
 * at" — but in-progress items by definition don't need the user's
 * attention. The split: bell = act on this, activity = work
 * happening, FYI.
 *
 * UX shape:
 *   - Subtle spinning loader icon (no badge, no count) so it
 *     telegraphs "active work" without the urgency of the bell's
 *     red unread badge.
 *   - Click opens a small panel listing in-flight items, each with
 *     a kind label and "Started X min ago" hint.
 *   - Hides itself entirely when there's nothing in flight, so it
 *     never adds visual noise to a quiet header.
 *   - No dismiss button per row: in-progress items resolve to ready
 *     or failed automatically. The user can't (and shouldn't) cancel
 *     from here — operation-specific cancel UIs (briefing cancel,
 *     etc.) own that affordance.
 *
 * Polls via the same `useNotifications` hook the bell uses, so we
 * don't double the request rate.
 */
export function ActivityIndicator() {
  const { notifications, inProgressCount } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Only `in_progress` rows belong here. Same data source, opposite
  // filter to the bell — keeping the pivot client-side avoids
  // doubling up on /api/notifications calls.
  const activeWork = useMemo(() => notifications.filter((n) => n.status === "in_progress"), [notifications]);

  // Auto-close the panel when the last item finishes — opening a
  // panel that just emptied feels broken. We DON'T auto-open when a
  // new item starts; the user opted into background work, they
  // shouldn't be interrupted.
  useEffect(() => {
    if (activeWork.length === 0 && open) {
      setOpen(false);
    }
  }, [activeWork.length, open]);

  // Close on click-outside / Escape — same shape as the bell so the
  // two header popovers feel like siblings.
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

  // Hide the icon entirely when nothing is in flight. Pre-fix this
  // would have rendered as a permanent header element — too noisy
  // for the typical idle state.
  if (inProgressCount === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Activity (${inProgressCount} working)`}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${inProgressCount} working`}
        // Same shape + size as the rest of the header icon cluster
        // (bookmark, bell, prefs) so they read as siblings. Animated
        // tint pulse on the icon (not a separate dot) telegraphs
        // "active" without competing with the bell's red unread
        // badge for visual weight.
        className="relative inline-flex items-center justify-center h-8 w-8 rounded-md text-accent hover:bg-surface-hover transition-colors"
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
          // Tailwind `animate-spin` rotates the SVG. The dashed arc
          // pattern reads as "loading / working" instantly because
          // it matches the platform spinner vocabulary
          // (Lucide / Heroicons / Material).
          className="animate-spin"
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 w-[320px] max-h-[360px] rounded-lg bg-bg border border-border shadow-xl overflow-hidden flex flex-col z-50"
        >
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border-subtle">
            <span className="text-xs font-semibold text-text-primary">Activity</span>
            <span className="text-[10px] font-mono text-text-dim">{activeWork.length} working</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {activeWork.length === 0 ? (
              // Defensive — the parent already early-returns when
              // inProgressCount is 0. This empty-state covers the
              // brief flash window between "last item completed"
              // and "auto-close fires" so we don't show a blank
              // panel.
              <div className="px-3 py-6 text-xs font-mono text-text-dim text-center">Nothing in flight.</div>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {activeWork.map((n) => (
                  <li key={n.id}>
                    <ActivityRow notification={n} />
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

function ActivityRow({ notification: n }: { notification: AppNotification }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <span className="shrink-0 mt-1 inline-flex h-2 w-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-text-primary truncate">{n.title}</div>
        {n.body && <div className="mt-0.5 text-[11px] font-mono text-text-dim leading-snug">{n.body}</div>}
        <div className="mt-0.5 text-[10px] font-mono text-text-faint">
          Started {formatStarted(n.createdAt)} · {n.kind.replace(/_/g, " ")}
        </div>
      </div>
    </div>
  );
}

function formatStarted(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
    const ms = Date.now() - d.getTime();
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
