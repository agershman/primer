import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { getCategoryLabel, getHelpPage, getHelpPagesGrouped, searchHelp } from "../lib/helpRegistry";

function Sidebar({ currentId, onNavigate }: { currentId: string; onNavigate?: () => void }) {
  const [sidebarQuery, setSidebarQuery] = useState("");
  const grouped = getHelpPagesGrouped();
  const searchResults = sidebarQuery.trim() ? searchHelp(sidebarQuery) : null;

  return (
    <nav className="space-y-1">
      <div className="mb-3">
        <input
          type="text"
          value={sidebarQuery}
          onChange={(e) => setSidebarQuery(e.target.value)}
          placeholder="Search..."
          className="w-full rounded-md border border-border-subtle bg-bg px-2.5 py-1.5 font-ui text-xs text-text-primary placeholder:text-text-faint outline-none transition-colors focus:border-accent"
        />
      </div>

      {searchResults ? (
        <div className="space-y-0.5">
          {searchResults.map((page) => (
            <Link
              key={page.id}
              to={`/help/${page.id}`}
              onClick={onNavigate}
              className={`block rounded-md px-2.5 py-1.5 font-ui text-xs no-underline transition-colors ${
                page.id === currentId
                  ? "bg-accent-dim text-accent font-medium"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              }`}
            >
              {page.title}
            </Link>
          ))}
        </div>
      ) : (
        Array.from(grouped.entries()).map(([category, pages]) => (
          <div key={category} className="mb-3">
            <div className="px-2.5 py-1 font-ui text-[10px] font-semibold uppercase tracking-wider text-text-faint">
              {getCategoryLabel(category)}
            </div>
            <div className="space-y-0.5 mt-0.5">
              {pages.map((page) => (
                <Link
                  key={page.id}
                  to={`/help/${page.id}`}
                  onClick={onNavigate}
                  className={`block rounded-md px-2.5 py-1.5 font-ui text-xs no-underline transition-colors ${
                    page.id === currentId
                      ? "bg-accent-dim text-accent font-medium"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  }`}
                >
                  {page.title}
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </nav>
  );
}

export function HelpArticlePage() {
  const { category, page: pageSlug } = useParams<{
    category: string;
    page: string;
  }>();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const pageId = `${category}/${pageSlug}`;
  const helpPage = getHelpPage(pageId);

  if (!helpPage) {
    return (
      <div className="animate-fade-in py-16 text-center">
        <p className="font-ui text-sm text-text-secondary mb-4">Help article not found.</p>
        <Link to="/help" className="font-ui text-sm text-link hover:text-link-hover no-underline">
          Back to Help
        </Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Mobile sidebar toggle */}
      <button
        onClick={() => setDrawerOpen(true)}
        className="lg:hidden mb-4 flex items-center gap-1.5 rounded-md border border-border-subtle px-3 py-1.5 font-ui text-xs text-text-secondary hover:bg-surface-hover transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-text-dim">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Browse articles
      </button>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-bg border-r border-border overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="font-ui text-xs font-semibold text-text-primary">Help Articles</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-1 hover:bg-surface-hover transition-colors"
                aria-label="Close sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-text-dim">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <Sidebar currentId={pageId} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex gap-8">
        {/* Desktop sidebar.
         *
         * The sidebar is `position: sticky` so it stays visible as the
         * article scrolls. We must also cap its height to the viewport
         * (minus the `top` offset + a small bottom gutter) AND give it
         * its own `overflow-y-auto`, otherwise category groups that
         * exceed the viewport height are clipped off-screen — the
         * sticky element pins at top:24, but its content keeps
         * extending downward unbounded, so the last few items only
         * become reachable once the page itself scrolls past them.
         *
         * `pr-2` reserves a gutter so the inner scrollbar doesn't
         * overlap link text. `pb-6` keeps the last item from sitting
         * flush against the viewport bottom when the user scrolls.
         */}
        <aside className="hidden lg:block w-56 shrink-0">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 pb-6">
            <Sidebar currentId={pageId} />
          </div>
        </aside>

        {/* Article content */}
        <article className="min-w-0 flex-1">
          <div className="mb-1">
            <button
              onClick={() => navigate("/help")}
              className="font-ui text-[10px] text-text-faint hover:text-text-dim uppercase tracking-wider transition-colors"
            >
              ← Help
            </button>
          </div>

          <header className="mb-6">
            <span className="font-ui text-[10px] text-accent uppercase tracking-wider font-medium">
              {getCategoryLabel(helpPage.category)}
            </span>
            <h1 className="font-display text-2xl font-medium text-text-primary mt-1">{helpPage.title}</h1>
            <p className="font-ui text-sm text-text-secondary mt-1">{helpPage.subtitle}</p>
          </header>

          <div className="prose-primer">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{helpPage.content}</ReactMarkdown>
          </div>

          {helpPage.related.length > 0 && (
            <footer className="mt-10 pt-6 border-t border-border-subtle">
              <h3 className="font-ui text-xs font-semibold text-text-dim uppercase tracking-wider mb-3">
                Related Articles
              </h3>
              <div className="flex flex-wrap gap-2">
                {helpPage.related.map((relatedId) => {
                  const relatedPage = getHelpPage(relatedId);
                  if (!relatedPage) return null;
                  return (
                    <Link
                      key={relatedId}
                      to={`/help/${relatedId}`}
                      className="rounded-md border border-border-subtle bg-surface px-3 py-2 no-underline transition-colors hover:border-border hover:bg-surface-hover"
                    >
                      <span className="font-ui text-xs font-medium text-text-primary">{relatedPage.title}</span>
                      <span className="block font-ui text-[10px] text-text-dim mt-0.5">
                        {getCategoryLabel(relatedPage.category)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </footer>
          )}
        </article>
      </div>
    </div>
  );
}
