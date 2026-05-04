import type { ReactNode } from "react";

/**
 * Compact, inline expandable "Why this score?" panel.
 *
 * Used wherever Primer surfaces a depth assessment (the
 * post-submit baseline overview, the per-concept Quiz history on
 * the Concept Detail page, and any future scoring surface) so the
 * user can drill into the LLM's reasoning without leaving context.
 *
 * Stylistically a sibling to the post-quiz `QuizAssessment` block
 * (the rich panel shown after answering a one-off calibration
 * question) but tuned for *inline list rows*: the row itself is
 * the trigger, an arrow signals expandability, and the reasoning
 * panel slides in below the row when opened.
 *
 * Implemented with native `<details>` / `<summary>` so the
 * expand/collapse interaction is keyboard- and screen-reader-
 * accessible by default. Browsers that don't render the default
 * triangle marker fall back to our explicit chevron.
 */

export interface ScoringReasoningPanelData {
  /** Free-text "why this score" produced by the assessor LLM. */
  reasoning?: string | null;
  /** Per-area gap callouts. `specifics` may be empty even when
   *  `summary` is present, and vice versa. */
  gaps?: { summary?: string; specifics: string[] } | null;
  /** Optional ordered "next step" suggestions. Each step has an
   *  action ("Read X", "Try Y") and an optional resource link. */
  learningPath?: Array<{ action: string; resource?: { title: string; url: string } }> | null;
  /** Optional previous depth so we can render a "previous → new"
   *  delta block alongside the reasoning. */
  previousDepth?: number | null;
  /** Optional current/assessed depth. Required if `previousDepth`
   *  is set so we can compute the delta. */
  currentDepth?: number | null;
}

interface ScoringReasoningProps extends ScoringReasoningPanelData {
  /** The collapsed-state row content. Typically the concept name +
   *  depth indicator + numeric depth. */
  trigger: ReactNode;
  /** Optional className for the outer `<details>` wrapper. */
  className?: string;
  /** Forced behavior when there's no data to expand:
   *
   *   - "static" (default): renders the trigger as a plain row,
   *     no chevron, no clickability. Keeps list density consistent
   *     between rows that have reasoning and rows that don't (e.g.
   *     pending or pre-versioning history entries).
   *   - "with-empty-state": renders the row as a clickable
   *     `<details>` and the expanded panel just says
   *     "No reasoning available." Useful when callers want to
   *     guarantee a uniform interaction.
   */
  emptyMode?: "static" | "with-empty-state";
}

function hasContent(d: ScoringReasoningPanelData): boolean {
  if (d.reasoning && d.reasoning.trim().length > 0) return true;
  if (d.gaps?.summary && d.gaps.summary.trim().length > 0) return true;
  if (d.gaps?.specifics && d.gaps.specifics.length > 0) return true;
  if (d.learningPath && d.learningPath.length > 0) return true;
  return false;
}

function Chevron() {
  // Inline SVG so we don't depend on any icon library. Rotates 180°
  // when the parent <details> is open via the `group-open:` modifier
  // on the wrapper.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-text-faint shrink-0 transition-transform duration-150 group-open:rotate-180"
    >
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </svg>
  );
}

function DeltaPanel({ previous, current }: { previous: number; current: number }) {
  const delta = current - previous;
  const sign = delta >= 0 ? "+" : "";
  const cls = delta >= 0 ? "text-positive" : "text-negative";
  if (delta === 0) return null;
  return (
    <div className="flex items-center gap-3 text-xs font-mono">
      <span className="text-text-faint">{previous.toFixed(1)}</span>
      <span className="text-text-faint">→</span>
      <span className="text-text-secondary">{current.toFixed(1)}</span>
      <span className={cls}>
        {sign}
        {delta.toFixed(1)}
      </span>
    </div>
  );
}

export function ScoringReasoning({
  trigger,
  reasoning,
  gaps,
  learningPath,
  previousDepth,
  currentDepth,
  className,
  emptyMode = "static",
}: ScoringReasoningProps) {
  const data: ScoringReasoningPanelData = { reasoning, gaps, learningPath };
  const expandable = hasContent(data) || emptyMode === "with-empty-state";

  if (!expandable) {
    return <div className={`flex items-center gap-3 ${className ?? ""}`.trim()}>{trigger}</div>;
  }

  return (
    <details className={`group rounded-md ${className ?? ""}`.trim()}>
      <summary className="cursor-pointer list-none flex items-center gap-3 rounded-md px-1 py-0.5 hover:bg-surface-hover transition-colors">
        {trigger}
        <Chevron />
      </summary>
      <div className="mt-2 ml-1 mr-1 mb-1 space-y-3 rounded-md border border-border-subtle bg-surface px-3 py-3">
        {previousDepth != null && currentDepth != null && (
          <DeltaPanel previous={previousDepth} current={currentDepth} />
        )}

        {reasoning && reasoning.trim().length > 0 ? (
          <section>
            <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-1">
              Why this score
            </p>
            <p className="font-ui text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{reasoning}</p>
          </section>
        ) : null}

        {gaps && (gaps.summary || (gaps.specifics && gaps.specifics.length > 0)) ? (
          <section>
            <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-negative mb-1">
              Where to sharpen
            </p>
            {gaps.summary ? <p className="font-ui text-sm text-text-secondary mb-1">{gaps.summary}</p> : null}
            {gaps.specifics && gaps.specifics.length > 0 ? (
              <ul className="space-y-1">
                {gaps.specifics.map((g, i) => (
                  <li key={i} className="font-ui text-xs text-text-dim flex items-start gap-2">
                    <span className="text-negative mt-0.5 shrink-0">•</span>
                    <span>{g}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {learningPath && learningPath.length > 0 ? (
          <section>
            <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-positive mb-1">
              Suggested next steps
            </p>
            <ol className="space-y-1.5">
              {learningPath.map((step, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="font-mono text-xs text-positive mt-0.5 shrink-0 w-4 text-right">{i + 1}.</span>
                  <div className="min-w-0">
                    <p className="font-ui text-sm text-text-secondary">{step.action}</p>
                    {step.resource ? (
                      <a
                        href={step.resource.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-ui text-xs text-accent hover:text-accent/80 no-underline hover:underline"
                      >
                        {step.resource.title} ↗
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {!hasContent(data) ? (
          <p className="font-ui text-xs text-text-faint italic">No reasoning available for this entry.</p>
        ) : null}
      </div>
    </details>
  );
}
