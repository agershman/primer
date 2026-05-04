import { useCallback, useEffect, useRef, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../utils/api";

export interface Bookmark {
  id: string;
  pieceId: string;
  type: "reading" | "saved";
  scrollPosition: number;
  audioPosition: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  pieceTitle?: string;
  pieceType?: string;
  readTimeMinutes?: number | null;
  briefingDate?: string;
  /**
   * Short text snippet (~180 chars) describing where in the piece
   * the bookmark points. Computed server-side from the piece's
   * content blocks based on bookmark type:
   *   - `saved` block-level → text of the bookmarked block
   *   - `reading` progress  → proportional block at that position
   *   - `saved` piece-level → first text block as a teaser
   * `null` for legacy bookmarks where the piece content can't be
   * resolved (e.g. content was pruned by retention).
   */
  contextSnippet?: string | null;
}

interface BookmarkResponse {
  bookmark: Bookmark | null;
}

interface BookmarksListResponse {
  bookmarks: Bookmark[];
}

// Matches the PUT body shape
interface BookmarkUpdate {
  type?: "reading" | "saved";
  scrollPosition?: number;
  audioPosition?: number;
  note?: string;
}

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBookmarks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<BookmarksListResponse>("/api/bookmarks");
      setBookmarks(data.bookmarks);
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  const getBookmark = useCallback(async (pieceId: string): Promise<Bookmark | null> => {
    try {
      const data = await apiGet<BookmarkResponse>(`/api/bookmark/${pieceId}`);
      return data.bookmark;
    } catch {
      return null;
    }
  }, []);

  const saveBookmark = useCallback(async (pieceId: string, update: BookmarkUpdate) => {
    try {
      await apiPut(`/api/bookmark/${pieceId}`, update);
    } catch {
      // non-critical — bookmark save failures are silent
    }
  }, []);

  const toggleSaved = useCallback(
    async (pieceId: string) => {
      const existing = bookmarks.find((b) => b.pieceId === pieceId);
      if (existing?.type === "saved") {
        await apiDelete(`/api/bookmark/${pieceId}`);
        setBookmarks((prev) => prev.filter((b) => b.pieceId !== pieceId));
      } else {
        await apiPut(`/api/bookmark/${pieceId}`, { type: "saved" });
        setBookmarks((prev) => {
          const without = prev.filter((b) => b.pieceId !== pieceId);
          return [
            {
              id: "",
              pieceId,
              type: "saved" as const,
              scrollPosition: existing?.scrollPosition ?? 0,
              audioPosition: existing?.audioPosition ?? 0,
              note: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            ...without,
          ];
        });
      }
    },
    [bookmarks],
  );

  const removeBookmark = useCallback(async (pieceId: string) => {
    try {
      await apiDelete(`/api/bookmark/${pieceId}`);
      setBookmarks((prev) => prev.filter((b) => b.pieceId !== pieceId));
    } catch {
      // non-critical
    }
  }, []);

  const isSaved = useCallback(
    (pieceId: string) => bookmarks.some((b) => b.pieceId === pieceId && b.type === "saved"),
    [bookmarks],
  );

  const mostRecentInProgress = bookmarks.find((b) => b.type === "reading" && b.scrollPosition > 0);

  return {
    bookmarks,
    loading,
    loadBookmarks,
    getBookmark,
    saveBookmark,
    toggleSaved,
    removeBookmark,
    isSaved,
    mostRecentInProgress,
  };
}

/**
 * Auto-save scroll position for a specific piece. Debounces writes to avoid
 * hammering the API on every scroll event.
 */
export function useScrollTracking(
  pieceId: string | null,
  saveBookmark: (id: string, u: BookmarkUpdate) => Promise<void>,
) {
  const lastSaved = useRef(0);

  useEffect(() => {
    if (!pieceId) return;

    const handleScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;
      const position = Math.min(1, scrollTop / docHeight);

      const now = Date.now();
      if (now - lastSaved.current < 3000) return;
      if (position < 0.05) return;

      lastSaved.current = now;
      saveBookmark(pieceId, { type: "reading", scrollPosition: position });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [pieceId, saveBookmark]);
}
