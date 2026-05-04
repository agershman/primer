import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Tooltip } from "./Tooltip";

/**
 * Hoverable explainer panels for the three concept stats — Depth,
 * Confidence, Exposures.
 *
 * The user complaint these address: "I see a number but I don't
 * know what it means or how it's measured." Pre-fix the labels had
 * one-line tooltips ("Current depth score on a 0-5 scale") that
 * weren't actionable — the rubric, the scale, and what each value
 * actually represents lived only in the help docs, which the user
 * had to navigate to mid-task.
 *
 * Now each stat label has a small `ⓘ` glyph and a popover with:
 *   - The full rubric (Depth: all 6 levels) or a focused blurb
 *     (Confidence / Exposures: 2-paragraph explanation).
 *   - A `guide →` link to the matching help doc for the longer
 *     explanation when the popover isn't enough.
 *
 * Single source of truth for the rubric labels; the trail-header
 * `<DepthBar>` tooltip and the `/help/concepts/depth-scale` page
 * both use the same vocabulary so a user reading the popover here
 * lines up with what they see elsewhere.
 */

export interface ConceptStatProps {
  label: string;
  value: ReactNode;
  tooltip: ReactNode;
  tooltipWidth?: string;
}

export function ConceptStat({ label, value, tooltip, tooltipWidth }: ConceptStatProps) {
  return (
    <div className="min-w-0">
      <Tooltip content={tooltip} width={tooltipWidth}>
        <span className="inline-flex items-center gap-1 cursor-help">
          <span className="font-ui text-[10px] text-text-faint">{label}</span>
          <InfoIcon />
        </span>
      </Tooltip>
      <div>
        <span className="font-mono text-sm text-text-primary">{value}</span>
      </div>
    </div>
  );
}

function InfoIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-text-faint opacity-70"
    >
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="7.5" x2="8" y2="11" />
      <circle cx="8" cy="5" r="0.6" fill="currentColor" />
    </svg>
  );
}

const DEPTH_LEGEND: Array<{ level: number; label: string; blurb: string }> = [
  { level: 0, label: "Unknown", blurb: "Extracted but never engaged with." },
  { level: 1, label: "Aware", blurb: "Recognize the term, can't explain it." },
  { level: 2, label: "Understands", blurb: "Grasp how it works at a functional level." },
  { level: 3, label: "Applies", blurb: "Use it confidently in production." },
  { level: 4, label: "Teaches", blurb: "Could mentor someone else through it." },
  { level: 5, label: "Authoritative", blurb: "Could write the docs / define best practice." },
];

export function DepthGuide({ value }: { value: number }) {
  const rounded = Math.round(value);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 border-b border-border-subtle pb-1 mb-1">
        <span className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim">Depth (0–5)</span>
        <Link
          to="/help/concepts/depth-scale"
          className="font-mono text-[9px] text-accent hover:text-accent/80 no-underline"
        >
          guide →
        </Link>
      </div>
      {DEPTH_LEGEND.map((row) => {
        const active = row.level === rounded;
        return (
          <div
            key={row.level}
            className={`flex items-baseline gap-2 ${active ? "text-text-primary" : "text-text-secondary"}`}
          >
            <span className="font-mono text-[10px] tabular-nums w-3 text-right shrink-0">{row.level}</span>
            <span className={`font-ui text-xs shrink-0 w-[88px] ${active ? "font-semibold text-accent" : ""}`}>
              {row.label}
            </span>
            <span className="font-ui text-[11px] text-text-dim leading-tight">{row.blurb}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ConfidenceGuide() {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 border-b border-border-subtle pb-1 mb-1">
        <span className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim">Confidence</span>
        <Link
          to="/help/concepts/confidence"
          className="font-mono text-[9px] text-accent hover:text-accent/80 no-underline"
        >
          guide →
        </Link>
      </div>
      <p className="font-ui text-xs text-text-secondary leading-relaxed">
        How sure Primer is about your depth score. Climbs with each quiz answer and concept engagement; decays slowly
        when a concept goes a long time without exposure.
      </p>
      <p className="font-ui text-[11px] text-text-dim leading-relaxed">
        Low confidence means the depth value is a rough guess — take a calibration quiz to firm it up.
      </p>
    </div>
  );
}

export function ExposuresGuide() {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 border-b border-border-subtle pb-1 mb-1">
        <span className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim">Exposures</span>
      </div>
      <p className="font-ui text-xs text-text-secondary leading-relaxed">
        Total times this concept appeared in a briefing or quiz. Higher means Primer has seen it more in your work
        signals or had more chances to teach you about it.
      </p>
      <p className="font-ui text-[11px] text-text-dim leading-relaxed">
        Useful for distinguishing "haven't seen it much" from "seen it a lot but haven't learned it yet" at the same
        depth score.
      </p>
    </div>
  );
}
