import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../utils/api";

export type NotificationStatus = "in_progress" | "ready" | "failed" | "dismissed";

export interface AppNotification {
  id: string;
  kind: string;
  status: NotificationStatus;
  title: string;
  body: string | null;
  actionUrl: string | null;
  progress: number | null;
  payload: Record<string, unknown>;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface NotificationListResponse {
  notifications: AppNotification[];
  unreadCount: number;
  inProgressCount: number;
}

/**
 * Hook used by the bell icon in the header.
 *
 * Polling cadence:
 *
 *   - 4 s   while at least one notification is in_progress (the user
 *           expects near-realtime feedback for "your deep dive is
 *           generating" — 4 s feels live without spamming requests).
 *   - 30 s  otherwise (just keeps the unread count fresh in case the
 *           backend created a notification we don't yet know about).
 *   - paused while the document is hidden — no point polling a tab
 *           the user isn't looking at; we resume on visibilitychange.
 *
 * The cadence change happens via a re-armed setInterval whenever
 * `inProgressCount` flips from 0 to >=1 or vice versa.
 */
const POLL_FAST_MS = 4_000;
const POLL_SLOW_MS = 30_000;

export interface UseNotificationsResult {
  notifications: AppNotification[];
  unreadCount: number;
  inProgressCount: number;
  loading: boolean;
  /** Force a refresh — e.g. after the user opens the dropdown. */
  refresh: () => Promise<void>;
  acknowledge: (id: string) => Promise<void>;
  acknowledgeAll: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnread] = useState(0);
  const [inProgressCount, setInProgress] = useState(0);
  const [loading, setLoading] = useState(true);
  const inProgressRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const data = await apiGet<NotificationListResponse>("/api/notifications");
      setNotifications(data.notifications);
      setUnread(data.unreadCount);
      setInProgress(data.inProgressCount);
      inProgressRef.current = data.inProgressCount;
    } catch {
      // Polling failures are silent — we don't want a flaky network
      // to throw a toast every 4 s. The bell just stays at its
      // current state until the next successful poll.
    } finally {
      setLoading(false);
    }
  }, []);

  const armPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    const ms = inProgressRef.current > 0 ? POLL_FAST_MS : POLL_SLOW_MS;
    pollTimerRef.current = setInterval(() => {
      void fetchOnce().then(() => {
        // Re-arm at the new cadence if we crossed the in-progress
        // boundary on the last fetch.
        const now = inProgressRef.current > 0 ? POLL_FAST_MS : POLL_SLOW_MS;
        if (now !== ms) {
          armPoll();
        }
      });
    }, ms);
  }, [fetchOnce]);

  useEffect(() => {
    void fetchOnce();
    armPoll();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [armPoll, fetchOnce]);

  // Pause polling when tab is hidden; resume + re-fetch on
  // visibility return so the bell snaps to current state without
  // waiting for the next interval tick.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void fetchOnce();
        armPoll();
      } else if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [armPoll, fetchOnce]);

  const acknowledge = useCallback(
    async (id: string) => {
      try {
        await apiPost(`/api/notifications/${id}/acknowledge`);
      } catch {
        /* non-critical */
      }
      await fetchOnce();
    },
    [fetchOnce],
  );

  const acknowledgeAll = useCallback(async () => {
    try {
      await apiPost("/api/notifications/acknowledge-all");
    } catch {
      /* non-critical */
    }
    await fetchOnce();
  }, [fetchOnce]);

  const dismiss = useCallback(
    async (id: string) => {
      // Optimistic — drop locally then sync. The dropdown should feel
      // instant; the network round-trip can lag without affecting UX.
      setNotifications((prev) => prev.filter((n) => n.id !== id));
      try {
        await apiPost(`/api/notifications/${id}/dismiss`);
      } catch {
        /* swallow; next poll will reconcile */
      }
      await fetchOnce();
    },
    [fetchOnce],
  );

  return {
    notifications,
    unreadCount,
    inProgressCount,
    loading,
    refresh: fetchOnce,
    acknowledge,
    acknowledgeAll,
    dismiss,
  };
}
