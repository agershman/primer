import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * React error boundary.
 *
 * Why this exists
 * ---------------
 * Pre-fix, a single render error anywhere in the React tree would
 * blank the whole tab. There was zero error-boundary coverage in
 * the frontend (`rg "ErrorBoundary"` returned nothing) — a typo in
 * a deeply nested component would take the entire app down with no
 * way to recover short of a full reload, and no diagnostic surface
 * to tell the user what went wrong.
 *
 * This boundary catches render errors, logs them to the console
 * (so they show up in browser devtools and Cloudflare Pages
 * production logs via the `console` capture), and renders a small
 * error pane with the error message + a "Reload page" button. The
 * surrounding chrome (header, nav, etc.) keeps working as long as
 * the boundary is scoped narrowly enough.
 *
 * Usage
 * -----
 *
 *   - Wrap `<Routes>` in `App.tsx` for whole-app coverage. A render
 *     error in any page falls back to a clean message instead of
 *     a blank screen.
 *   - Optionally wrap a heavy page (BriefingPage, ConceptsPage,
 *     AnalyticsPage) in its own boundary so a per-page error
 *     doesn't sink the chrome / nav. The two are stackable.
 *
 * Class component (rather than a hook) because React doesn't yet
 * expose a hook-based equivalent — `componentDidCatch` is the only
 * way to intercept render errors. `react-error-boundary` works too,
 * but it's another dep for a 60-line file we'd own anyway.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional label shown in the fallback ("Something broke in
   * <name>.") and tagged on the console.error. Lets per-route
   * boundaries identify themselves without inspecting the stack.
   */
  name?: string;
  /**
   * Optional custom fallback renderer. Receives the error and a
   * `reset` callback. When provided, replaces the default UI.
   * The default is a small inline pane suitable for both top-level
   * and per-page contexts.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Tag with the boundary name so a stack search in devtools or
    // Cloudflare Logs can locate which boundary tripped (e.g.
    // "BriefingPage" vs the top-level "App"). Component stack is
    // the most useful single piece of diagnostic info — it points
    // at the failing component without needing source maps.
    const tag = this.props.name ? `[ErrorBoundary:${this.props.name}]` : "[ErrorBoundary]";
    console.error(tag, error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return <DefaultFallback error={error} name={this.props.name} reset={this.reset} />;
  }
}

function DefaultFallback({ error, name, reset }: { error: Error; name?: string; reset: () => void }) {
  return (
    <div role="alert" className="my-6 rounded-lg border-2 border-negative/50 bg-negative-dim p-6">
      <div className="text-sm font-semibold text-negative mb-2">Something broke{name ? ` in ${name}` : ""}.</div>
      <div className="text-[11px] font-mono text-text-secondary leading-relaxed mb-4 break-words">
        {error.message || "Unknown error"}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="px-3 py-1.5 rounded-md border border-border-subtle bg-transparent text-text-primary text-xs font-mono hover:bg-surface-hover transition-colors"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => {
            window.location.reload();
          }}
          className="px-3 py-1.5 rounded-md border border-negative/60 bg-transparent text-negative text-xs font-mono hover:bg-negative hover:text-bg transition-colors"
        >
          Reload page
        </button>
      </div>
    </div>
  );
}
