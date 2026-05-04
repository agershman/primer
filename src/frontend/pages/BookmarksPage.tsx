import { useEffect } from "react";
import { Link } from "react-router-dom";
import { type Bookmark, useBookmarks } from "../hooks/useBookmarks";

export function BookmarksPage() {
  const { bookmarks, loading, loadBookmarks, removeBookmark } = useBookmarks();

  useEffect(() => {
    loadBookmarks();
  }, [loadBookmarks]);

  const saved = bookmarks.filter((b) => b.type === "saved");
  const reading = bookmarks.filter((b) => b.type === "reading" && b.scrollPosition > 0);

  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary mb-2">Bookmarks</h1>
      <p className="font-ui text-sm text-text-dim mb-6">Saved articles and reading progress.</p>

      {loading && bookmarks.length === 0 && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-surface-active animate-pulse" />
          ))}
        </div>
      )}

      {!loading && bookmarks.length === 0 && (
        <div className="border border-border-subtle rounded-lg p-6 text-center">
          <p className="font-ui text-sm text-text-dim">
            No bookmarks yet. Click the bookmark icon on any teaching piece to save it.
          </p>
        </div>
      )}

      {saved.length > 0 && (
        <section className="mb-8">
          <h2 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-dim mb-3">Saved</h2>
          <div className="space-y-2">
            {saved.map((b) => (
              <BookmarkRow key={b.id || b.pieceId} bookmark={b} onRemove={removeBookmark} />
            ))}
          </div>
        </section>
      )}

      {reading.length > 0 && (
        <section>
          <h2 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-dim mb-3">In progress</h2>
          <div className="space-y-2">
            {reading.map((b) => (
              <BookmarkRow key={b.id || b.pieceId} bookmark={b} onRemove={removeBookmark} showProgress />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function BookmarkRow({
  bookmark,
  onRemove,
  showProgress = false,
}: {
  bookmark: Bookmark;
  onRemove: (pieceId: string) => void;
  showProgress?: boolean;
}) {
  const pct = Math.round((bookmark.scrollPosition ?? 0) * 100);

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-3 hover:bg-surface-hover transition-colors">
      <Link to={`/briefing/${bookmark.briefingDate}`} className="flex-1 min-w-0 no-underline">
        <div className="font-ui text-sm text-text-primary truncate">{bookmark.pieceTitle ?? bookmark.pieceId}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="font-mono text-[10px] text-text-faint">{bookmark.briefingDate}</span>
          {showProgress && pct > 0 && (
            <>
              <span className="text-text-faint">·</span>
              <span className="font-mono text-[10px] text-accent tabular-nums">{pct}% read</span>
            </>
          )}
          {bookmark.audioPosition > 0 && (
            <>
              <span className="text-text-faint">·</span>
              <span className="font-mono text-[10px] text-text-dim tabular-nums">
                audio {Math.floor(bookmark.audioPosition / 60)}:
                {String(Math.floor(bookmark.audioPosition % 60)).padStart(2, "0")}
              </span>
            </>
          )}
        </div>
        {bookmark.contextSnippet && (
          // Context line — shows the user *where* in the piece this
          // bookmark points so they don't have to open it just to
          // remember what they pinned. The text comes from the
          // bookmarked block (or the proportional block for reading
          // bookmarks). Line-clamped to 3 rows so the row height
          // stays bounded for long passages, with the rest available
          // when the user opens the piece. 3 lines × ~80 chars ≈ the
          // 260-char snippet cap on the worker, so the truncation
          // routinely lands at a word boundary inside the visible
          // box.
          <p
            className="font-body text-xs text-text-secondary mt-1.5 leading-snug"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            title={bookmark.contextSnippet}
          >
            {bookmark.contextSnippet}
          </p>
        )}
        {bookmark.note && <p className="font-ui text-xs text-text-dim mt-1 truncate italic">{bookmark.note}</p>}
      </Link>

      {showProgress && pct > 0 && (
        <div className="w-12 h-1.5 rounded-full bg-surface-active shrink-0">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}

      <button
        onClick={() => onRemove(bookmark.pieceId)}
        className="shrink-0 p-1.5 rounded-md text-text-faint hover:text-negative hover:bg-negative-dim transition-colors"
        title="Remove bookmark"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <line x1="2" y1="2" x2="10" y2="10" />
          <line x1="10" y1="2" x2="2" y2="10" />
        </svg>
      </button>
    </div>
  );
}
