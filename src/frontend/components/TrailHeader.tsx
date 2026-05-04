import type { ReactNode } from "react";
import { useState } from "react";
import type { ConceptData } from "../types";

interface TrailHeaderProps {
  category: string;
  concepts: ConceptData[];
  expanded: boolean;
  onToggle: () => void;
  /**
   * Optional content rendered as a sibling to the right-side stats
   * cluster. Used by the Concepts page to slot in a per-trail
   * "Calibrate trail (N) →" CTA when the trail has unverified
   * concepts. Click events stop propagating inside this slot so the
   * trail-header's own `onToggle` doesn't fire when the CTA is
   * clicked.
   */
  rightSlot?: ReactNode;
}

const CATEGORY_LABELS: Record<string, string> = {
  infrastructure: "Infrastructure",
  platform: "Platform",
  security: "Security",
  observability: "Observability",
  language: "Language",
  framework: "Framework",
  pattern: "Pattern",
  domain: "Domain",
  tool: "Tool",
  process: "Process",
};

export function TrailHeader({ category, concepts, expanded, onToggle, rightSlot }: TrailHeaderProps) {
  const label = CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
  const count = concepts.length;
  const avgDepth = count > 0 ? concepts.reduce((s, c) => s + (c.depth ?? 0), 0) / count : 0;
  const staleCount = concepts.filter((c) => c.decayWarning).length;
  const lowCount = concepts.filter((c) => (c.depth ?? 0) < 2).length;
  const deepCount = concepts.filter((c) => (c.depth ?? 0) >= 3).length;

  // The header is a clickable disclosure region. We can't nest a
  // <button> inside another <button> for the optional right-side
  // CTA, so we render the outer chrome as a <div> with a click
  // handler + role and put a <button> wrapper around the chevron +
  // labels portion only. The right slot (which itself contains
  // interactive elements) lives outside that inner button so its
  // own clicks aren't intercepted as toggle clicks.
  return (
    <div className="w-full group">
      <div className="flex items-center gap-3 py-3 px-4 rounded-lg border border-border-subtle bg-bg-warm hover:bg-surface-hover transition-colors">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          aria-expanded={expanded}
        >
          <span
            className="text-text-dim transition-transform duration-150 shrink-0"
            style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
            aria-hidden="true"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 1l4 4-4 4" />
            </svg>
          </span>

          <span className="font-display text-base font-medium text-text-primary truncate">{label}</span>

          <span className="font-mono text-xs text-text-dim tabular-nums shrink-0">
            {count} {count === 1 ? "concept" : "concepts"}
          </span>

          <span className="font-mono text-xs text-text-dim tabular-nums shrink-0">avg {avgDepth.toFixed(1)}</span>
        </button>

        <DepthBar concepts={concepts} />

        {deepCount > 0 && (
          <span className="font-mono text-[10px] text-positive tabular-nums shrink-0">{deepCount} deep</span>
        )}

        {rightSlot ? (
          <div
            className="shrink-0"
            // Stop click bubbling so a click in this slot (the
            // per-trail Calibrate CTA) doesn't toggle the trail.
            onClick={(e) => e.stopPropagation()}
          >
            {rightSlot}
          </div>
        ) : null}
      </div>

      {!expanded && (staleCount > 0 || lowCount > 0) && (
        <div className="flex items-center gap-3 px-4 py-1 font-mono text-[10px] text-text-faint">
          {lowCount > 0 && <span>{lowCount} below depth 2</span>}
          {staleCount > 0 && <span>{staleCount} stale</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Depth-scale labels matching the user-facing 0-5 rubric documented
 * at /help/concepts/depth-scale. Kept in sync with that doc — if the
 * scale ever changes, both this map and the help page need to move
 * together (the test in depth-bar.test.ts pins this contract).
 */
const DEPTH_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Aware",
  2: "Understands",
  3: "Applies",
  4: "Teaches",
  5: "Authoritative",
};

/**
 * Stacked horizontal distribution of a trail's concepts across the
 * 0-5 depth scale. Each segment is sized in PROPORTION to its
 * bucket's share of the total — the previous implementation used
 * equal-flex slots with tiny "empty" placeholders, which made it
 * impossible to read "6 unverified, 2 aware" at a glance.
 *
 * On hover, a richer tooltip pops below the bar with a per-bucket
 * breakdown (depth number + label + count + percent), so the user
 * can answer "what am I looking at?" without leaving context. The
 * directly-hovered segment is highlighted in the tooltip so they
 * know which row corresponds to the hovered slice.
 *
 * Empty buckets are skipped in the bar itself (no microscopic
 * sliver) but still rendered in the tooltip with a "0" count, so
 * the reader gets the full distribution at a glance regardless of
 * whether a bucket is currently populated.
 */
function DepthBar({ concepts }: { concepts: ConceptData[] }) {
  const buckets = [0, 1, 2, 3, 4, 5];
  const total = concepts.length;
  const counts = buckets.map((b) => concepts.filter((c) => Math.round(c.depth ?? 0) === b).length);

  const [hovered, setHovered] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  // Aria-label that reads naturally for screen readers — "Depth
  // distribution: 6 of 8 unknown, 2 of 8 aware". Built up by
  // walking populated buckets in depth order.
  const ariaLabel =
    total === 0
      ? "Depth distribution: no concepts"
      : `Depth distribution: ${buckets
          .filter((_, i) => counts[i] > 0)
          .map((b) => `${counts[b]} of ${total} ${DEPTH_LABELS[b].toLowerCase()}`)
          .join(", ")}`;

  if (total === 0) return null;

  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false);
        setHovered(null);
      }}
    >
      <div
        className="flex h-3 w-20 cursor-help overflow-hidden rounded-sm border border-border-subtle"
        role="img"
        aria-label={ariaLabel}
      >
        {buckets.map((b, i) => {
          const pct = (counts[i] / total) * 100;
          if (pct === 0) return null;
          // Fill ramp: depth 0 reads as a muted accent so "unverified"
          // doesn't look as prominent as a deep-mastered bucket.
          // Past depth 0, opacity climbs in 0.16 steps (0.30 → 1.0).
          const opacity = b === 0 ? 0.22 : 0.36 + b * 0.16;
          return (
            <div
              key={b}
              className="transition-all"
              onMouseEnter={() => setHovered(b)}
              onMouseLeave={() => setHovered(null)}
              style={{
                width: `${pct}%`,
                backgroundColor: "var(--primer-accent)",
                opacity,
              }}
            />
          );
        })}
      </div>

      {open && <DepthBarTooltip buckets={buckets} counts={counts} total={total} highlight={hovered} />}
    </div>
  );
}

function DepthBarTooltip({
  buckets,
  counts,
  total,
  highlight,
}: {
  buckets: number[];
  counts: number[];
  total: number;
  highlight: number | null;
}) {
  return (
    <div
      role="tooltip"
      className="absolute right-0 top-full z-30 mt-2 w-[260px] rounded-md border border-border bg-surface px-3 py-2.5 shadow-md"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-border-subtle pb-1.5">
        <span className="font-ui text-[11px] font-semibold uppercase tracking-wider text-text-dim">
          Depth distribution
        </span>
        <span className="font-mono text-[10px] text-text-faint">
          {total} concept{total === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-1">
        {buckets.map((b, i) => {
          const count = counts[i];
          const pct = (count / total) * 100;
          const isHighlighted = highlight === b;
          // Match the bar's own opacity ramp so the tooltip swatch
          // and the bar segment read as the same visual element.
          const opacity = count === 0 ? 0.18 : b === 0 ? 0.22 : 0.36 + b * 0.16;
          return (
            <div
              key={b}
              className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors ${
                isHighlighted ? "bg-surface-hover" : ""
              }`}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{
                  backgroundColor: "var(--primer-accent)",
                  opacity,
                }}
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] text-text-faint shrink-0 w-3 text-right">{b}</span>
              <span className="font-ui text-xs text-text-secondary flex-1 min-w-0 truncate">{DEPTH_LABELS[b]}</span>
              <span className="font-mono text-xs text-text-primary tabular-nums shrink-0 w-5 text-right">{count}</span>
              <span className="font-mono text-[10px] text-text-faint tabular-nums shrink-0 w-9 text-right">
                {pct.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
