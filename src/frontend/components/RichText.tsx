import { Highlight, themes as prismThemes } from "prism-react-renderer";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dispatchPrimerEvent, onPrimerEvent } from "../lib/events";
import type { ContentBlock } from "../types";
import { Tooltip } from "./Tooltip";

interface RichTextProps {
  blocks: ContentBlock[];
  bookmarkedBlock?: number | null;
  onBookmarkBlock?: (blockIndex: number) => void;
}

function parseInlineMarkup(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const linkMatch = remaining.match(/\{\{(.+?)\|\|(.+?)\}\}/);
    // Glossary marker `[[term||definition]]` — surfaces a hover tooltip
    // with the definition. Term and definition are split on `||` exactly
    // like the link syntax so the LLM can reuse the same mental model.
    // Non-greedy on the inner halves so adjacent markers don't merge.
    const glossaryMatch = remaining.match(/\[\[(.+?)\|\|(.+?)\]\]/);
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
    const codeMatch = remaining.match(/`([^`]+)`/);

    const candidates: Array<{ index: number; length: number; node: ReactNode; type: string }> = [];

    if (linkMatch?.index !== undefined) {
      candidates.push({
        index: linkMatch.index,
        length: linkMatch[0].length,
        type: "link",
        node: (
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:text-link-hover border-b border-link/30 hover:border-link/60 transition-colors"
          >
            {linkMatch[1]}
          </a>
        ),
      });
    }

    if (boldMatch?.index !== undefined) {
      candidates.push({
        index: boldMatch.index,
        length: boldMatch[0].length,
        type: "bold",
        node: <strong key={key++}>{boldMatch[1]}</strong>,
      });
    }

    if (italicMatch?.index !== undefined) {
      candidates.push({
        index: italicMatch.index,
        length: italicMatch[0].length,
        type: "italic",
        node: <em key={key++}>{italicMatch[1]}</em>,
      });
    }

    if (codeMatch?.index !== undefined) {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        type: "code",
        // Neutral palette + thin border so inline code reads as a
        // "literal value" distinct from links (links use the same
        // accent color). Slightly tightened padding + a hair
        // smaller font keeps the code inline with surrounding
        // prose without breaking the line baseline.
        node: (
          <code
            key={key++}
            className="font-mono text-text-primary bg-bg-warm border border-border-subtle rounded px-1.5 py-px text-[0.88em] mx-[1px] whitespace-nowrap"
          >
            {codeMatch[1]}
          </code>
        ),
      });
    }

    if (glossaryMatch?.index !== undefined) {
      // Dotted underline + help cursor signals "more info on hover"
      // without competing with link styling (links use a solid border
      // in the accent color). The Tooltip portal handles touch via
      // its existing onMouseEnter / onMouseLeave handlers — long-press
      // on iOS triggers the same hover state.
      candidates.push({
        index: glossaryMatch.index,
        length: glossaryMatch[0].length,
        type: "glossary",
        node: (
          <Tooltip key={key++} content={glossaryMatch[2]}>
            <span className="border-b border-dotted border-text-faint cursor-help text-text-primary">
              {glossaryMatch[1]}
            </span>
          </Tooltip>
        ),
      });
    }

    if (candidates.length === 0) {
      parts.push(remaining);
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const winner = candidates[0];

    if (winner.index > 0) {
      parts.push(remaining.slice(0, winner.index));
    }
    parts.push(winner.node);
    remaining = remaining.slice(winner.index + winner.length);
  }

  return parts;
}

let mermaidInitialized = false;

export function DiagramBlock({ value, label }: { value: string; label?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
            securityLevel: "loose",
          });
          mermaidInitialized = true;
        }
        const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: rendered } = await mermaid.render(id, value);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <>
      <div className="my-4 rounded-lg border border-border-subtle bg-surface overflow-hidden group relative">
        {label && (
          <div className="px-3 py-1.5 border-b border-border-subtle bg-bg-warm">
            <span className="font-mono text-[10px] text-text-dim uppercase tracking-wider">{label}</span>
          </div>
        )}
        {svg ? (
          <>
            <div
              ref={containerRef}
              className="px-4 py-3 overflow-x-auto [&_svg]:max-w-full"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering mermaid-generated SVG (trusted output of the mermaid library, not user-controlled markup)
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            {/* Expand button — visible on hover, always visible on touch devices */}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-surface/80 border border-border-subtle text-text-dim hover:text-text-primary hover:bg-surface backdrop-blur-sm transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label="Expand diagram"
              title="Expand diagram (Esc to close)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7V3h4M13 7V3H9M3 9v4h4M13 9v4H9" />
              </svg>
            </button>
          </>
        ) : (
          <pre className="px-4 py-3 overflow-x-auto font-mono text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
            {error ? `[diagram render failed]\n${value}` : value}
          </pre>
        )}
      </div>

      {expanded && svg && <DiagramModal svg={svg} label={label} onClose={() => setExpanded(false)} />}
    </>
  );
}

/**
 * Full-screen modal for inspecting a diagram up close. Backdrop click and
 * Esc both dismiss. We render via portal so the modal isn't constrained by
 * the article's `prose` width — the diagram can scale up to nearly the full
 * viewport (90vw × 85vh).
 */
function DiagramModal({ svg, label, onClose }: { svg: string; label?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase so we beat any other Escape handlers (e.g. ChatPanel).
    window.addEventListener("keydown", onKey, true);
    // Lock background scroll while the modal is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm grid place-items-center p-4 sm:p-8 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? "Diagram"}
    >
      <div
        className="relative w-full h-full max-w-[90vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-3 py-2 rounded-t-lg bg-surface border border-border border-b-0">
          <span className="font-mono text-[11px] text-text-dim uppercase tracking-wider">{label ?? "Diagram"}</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors"
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <svg
              width="16"
              height="16"
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
        <div
          className="flex-1 min-h-0 overflow-auto rounded-b-lg bg-surface border border-border p-6 grid place-items-center [&_svg]:max-w-full [&_svg]:max-h-full [&_svg]:h-auto [&_svg]:w-auto"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: rendering mermaid-generated SVG (trusted output of the mermaid library, not user-controlled markup)
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body,
  );
}

/**
 * Per-page code-theme preference. The user can flip individual code
 * blocks between light and dark independently of the site's overall
 * theme — useful when the reader prefers reading prose on a light
 * background but wants their code samples in a darker editor-style
 * theme (or vice versa). The choice persists in localStorage and
 * syncs across every CodeBlock on the page in real time via a
 * window event, mirroring the AudioPlayer's playback-rate sync
 * pattern.
 *
 * Default is `"site"` — match whatever the site theme is. Once the
 * user explicitly picks `"light"` or `"dark"`, the choice sticks
 * across reloads and applies to every code block they encounter.
 */
type CodeTheme = "site" | "light" | "dark";
const CODE_THEME_STORAGE_KEY = "primer:code-theme";

function readStoredCodeTheme(): CodeTheme {
  if (typeof window === "undefined") return "site";
  try {
    const raw = window.localStorage?.getItem(CODE_THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "site") return raw;
    return "site";
  } catch {
    return "site";
  }
}

function writeStoredCodeTheme(theme: CodeTheme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(CODE_THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage can throw in private-mode Safari; the runtime
    // event still propagates the change in-session.
  }
}

/**
 * Resolve "site" → the actual light / dark mode the document is in
 * by reading the `dark` class on `<html>` (the same hook the rest
 * of Primer's theming uses). Fast and synchronous so the first
 * paint is correct without a flash.
 */
function effectiveCodeTheme(theme: CodeTheme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function CodeBlock({ value, language }: { value: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  // Per-page code theme. State lives in each CodeBlock instance so
  // React re-renders on change, but reads/writes go through the
  // shared localStorage + window-event channel so all blocks on
  // the page stay in sync.
  const [codeTheme, setCodeTheme] = useState<CodeTheme>(() => readStoredCodeTheme());

  useEffect(() => {
    const offCode = onPrimerEvent("code-theme-changed", (detail) => {
      const next = detail.theme;
      if (next === "light" || next === "dark" || next === "site") {
        setCodeTheme(next);
      }
    });
    // The Primer site theme can also flip from under us (the user
    // clicks the global Light/Dark/System toggle). Re-render when
    // it changes so a `theme === "site"` block follows the page.
    const offSite = onPrimerEvent("theme-changed", () => setCodeTheme((cur) => cur));
    return () => {
      offCode();
      offSite();
    };
  }, []);

  const cycleCodeTheme = () => {
    const order: CodeTheme[] = ["site", "light", "dark"];
    const idx = order.indexOf(codeTheme);
    const next = order[(idx + 1) % order.length];
    setCodeTheme(next);
    writeStoredCodeTheme(next);
    dispatchPrimerEvent("code-theme-changed", { theme: next });
  };

  const resolved = effectiveCodeTheme(codeTheme);
  // `themes.github` reads cleanly on a light background; `themes.vsDark`
  // is the workhorse VS Code dark theme. Both ship with prism-react-
  // renderer so we don't need a separate token-color stylesheet.
  const prismTheme = resolved === "dark" ? prismThemes.vsDark : prismThemes.github;

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Strip a single trailing newline that LLMs often append — it
  // produces an empty line at the bottom of the rendered block
  // that looks like a stray gap.
  const trimmedValue = value.replace(/\n+$/, "");
  const lineCount = trimmedValue.split("\n").length;
  // 2-digit gutter is plenty for a typical teaching-piece snippet
  // (10–60 lines). Pad with a leading space for ≥10 lines so the
  // numbers right-align cleanly in their column.
  const gutterDigits = Math.max(2, String(lineCount).length);

  // Surfaces visible label for the theme toggle. Compact ("light",
  // "dark", "auto") so the header stays tight in narrow contexts.
  const themeLabel = codeTheme === "site" ? "auto" : codeTheme;
  const themeNextLabel = (() => {
    const order: CodeTheme[] = ["site", "light", "dark"];
    const idx = order.indexOf(codeTheme);
    const next = order[(idx + 1) % order.length];
    return next === "site" ? "auto" : next;
  })();

  // Container styling: independent of the site theme. We pin
  // background + foreground colors directly so a "light" block on
  // a "dark" page (or vice versa) renders correctly. The header
  // bar uses a slightly tinted band of the same theme so the
  // language label and toggle controls remain legible.
  const containerStyle =
    resolved === "dark"
      ? { background: "#1e1e1e", color: "#d4d4d4", borderColor: "#3e3e42" }
      : { background: "#ffffff", color: "#24292e", borderColor: "#e1e4e8" };
  const headerStyle =
    resolved === "dark"
      ? { background: "#252526", color: "#9d9d9d", borderColor: "#3e3e42" }
      : { background: "#f6f8fa", color: "#586069", borderColor: "#e1e4e8" };
  const gutterColor = resolved === "dark" ? "#6a6a6a" : "#959da5";

  return (
    <div className="my-4 rounded-lg border overflow-hidden" style={containerStyle}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b text-[10px] font-mono" style={headerStyle}>
        <span className="lowercase">{language ?? "code"}</span>
        <div className="flex items-center gap-3">
          <button
            onClick={cycleCodeTheme}
            className="transition-colors hover:opacity-100 opacity-70"
            title={`Code theme: ${themeLabel} — click to switch to ${themeNextLabel}`}
            aria-label={`Code theme is ${themeLabel}; click to switch to ${themeNextLabel}`}
          >
            ◐ {themeLabel}
          </button>
          <button
            onClick={handleCopy}
            className="transition-colors hover:opacity-100 opacity-70"
            title="Copy to clipboard"
            aria-label="Copy code to clipboard"
          >
            {copied ? "✓ copied" : "copy"}
          </button>
        </div>
      </div>
      <Highlight theme={prismTheme} code={trimmedValue} language={language ?? "text"}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} px-0 py-3 overflow-x-auto font-mono text-xs leading-relaxed`}
            // The Prism theme injects its own background — but we
            // already set it on the container so the corners stay
            // rounded and consistent. Override here so the inner
            // <pre> doesn't paint a different shade.
            style={{ ...style, background: "transparent", margin: 0 }}
          >
            {tokens.map((line, i) => {
              const { key: lineKey, ...lineProps } = getLineProps({ line });
              return (
                <div key={`line-${i}`} {...lineProps} className={`flex ${lineProps.className ?? ""}`}>
                  {/* Line-number gutter — shrink-0 so it stays
                      aligned regardless of the line's content
                      width. `select-none` keeps copy-paste from
                      grabbing the numbers. `tabular-nums` lines
                      digits up vertically. */}
                  <span
                    className="shrink-0 px-3 select-none tabular-nums text-right opacity-60"
                    style={{
                      color: gutterColor,
                      minWidth: `${gutterDigits + 2}ch`,
                    }}
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 pr-4 whitespace-pre">
                    {line.map((token, j) => {
                      const { key: tokenKey, ...tokenProps } = getTokenProps({ token });
                      return <span key={`tok-${i}-${j}`} {...tokenProps} />;
                    })}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export function RichText({ blocks, bookmarkedBlock, onBookmarkBlock }: RichTextProps) {
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        const isBookmarked = bookmarkedBlock === i;
        const bookmarkBtn = onBookmarkBlock ? (
          <button
            onClick={() => onBookmarkBlock(i)}
            className={`absolute -left-5 top-[0.35em] opacity-0 group-hover:opacity-100 transition-opacity ${
              isBookmarked ? "!opacity-100 text-accent" : "text-text-faint hover:text-accent"
            }`}
            title={isBookmarked ? "Remove bookmark" : "Bookmark here"}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill={isBookmarked ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.2"
            >
              <path d="M3 1h6a1 1 0 011 1v9l-4-2.5L2 11V2a1 1 0 011-1z" />
            </svg>
          </button>
        ) : null;

        if (block.type === "heading") {
          return (
            <div key={i} className="group relative">
              {bookmarkBtn}
              <p className="font-ui text-sm font-semibold text-text-primary mt-4 first:mt-0">{block.value}</p>
            </div>
          );
        }
        if (block.type === "diagram") {
          return (
            <div key={i} className="group relative">
              {bookmarkBtn}
              <DiagramBlock value={block.value} label={block.label} />
            </div>
          );
        }
        if (block.type === "code") {
          return (
            <div key={i} className="group relative">
              {bookmarkBtn}
              <CodeBlock value={block.value} language={block.language} />
            </div>
          );
        }
        return (
          <div key={i} className="group relative">
            {bookmarkBtn}
            <p className="font-body text-base leading-relaxed text-text-secondary">{parseInlineMarkup(block.value)}</p>
          </div>
        );
      })}
    </div>
  );
}
