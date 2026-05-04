import { useMemo, useState } from "react";

/**
 * Trace-style visualization of a single briefing's pipeline run.
 *
 * Two kinds of rows are rendered, with distinct visual treatment so
 * the user can immediately tell what kind of work each row represents:
 *
 *   1. **Backbone steps** — pipeline stages that run once per briefing
 *      (work_context, slack_filter, concepts, adjacent, selecting,
 *      generating_pieces, quiz, finishing). Each gets a solid bar at
 *      its start offset, width = duration.
 *
 *   2. **Fanout summaries** — step keys that recur multiple times in
 *      the same briefing (e.g. `teaching_piece` runs once per piece,
 *      typically 4× in parallel inside `generating_pieces`). These
 *      collapse into ONE summary row showing:
 *        - a `× N` count badge,
 *        - the wall-clock span (earliest start → latest end across
 *          children, with a striped fill so it's visually distinct
 *          from solid backbone bars),
 *        - aggregate timing (avg / p95 in the right column),
 *        - a click-to-expand affordance that reveals each individual
 *          child as a thin, indented bar.
 *
 * The previous version rendered N separate `Each teaching piece` rows
 * at the same hierarchy as the backbone, which (a) made it hard to
 * tell which rows were "the pipeline" vs "iterations within a stage"
 * and (b) didn't scale — a 50-piece briefing would have produced 50
 * rows of teal bars dwarfing the 8 backbone rows.
 *
 * Hover/focus a row to see a tooltip with all the trace details
 * (model used, items processed, start offset, duration; for fanouts
 * also count + avg + p50 + p95 + total span).
 */

interface WaterfallStep {
  stepKey: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  itemsProcessed: number | null;
  modelUsed: string | null;
}

interface BriefingWaterfallProps {
  steps: WaterfallStep[];
  /** Optional total ms used as the axis upper bound. If omitted we infer
   *  it from the steps themselves. Useful when the briefing exposes a
   *  separate `totalMs` that may include time outside the step set
   *  (e.g. setup/teardown not instrumented). */
  totalMs?: number;
  /** Override step-key→label mapping for nicer display. Defaults are
   *  baked in for the canonical pipeline keys. */
  stepLabels?: Record<string, string>;
}

const DEFAULT_STEP_LABELS: Record<string, string> = {
  work_context: "Fetching sources",
  slack_filter: "Filtering source data",
  concepts: "Extracting concepts",
  adjacent: "Scanning feeds",
  selecting: "Selecting targets",
  generating_pieces: "Writing teaching pieces",
  teaching_piece: "Each teaching piece",
  quiz: "Calibration quiz",
  finishing: "Finishing up",
};

/**
 * Color palette for the waterfall bars. Hand-picked to maximize hue
 * separation at the same lightness/saturation, so adjacent rows of
 * different step kinds are immediately distinguishable. Falls back to
 * a neutral accent for any step key we don't know about (custom user
 * pipelines, future steps added without an explicit color).
 */
const STEP_COLORS: Record<string, string> = {
  work_context: "#3b82f6", // blue-500
  slack_filter: "#f59e0b", // amber-500
  concepts: "#8b5cf6", // violet-500
  adjacent: "#10b981", // emerald-500
  selecting: "#6b7280", // gray-500
  generating_pieces: "#ef4444", // red-500
  teaching_piece: "#14b8a6", // teal-500
  quiz: "#ec4899", // pink-500
  finishing: "#84cc16", // lime-500
};

const FALLBACK_COLOR = "#a1a1aa"; // zinc-400

interface BackboneRow {
  kind: "backbone";
  stepKey: string;
  step: WaterfallStep;
  startMs: number;
  endMs: number;
}

interface FanoutRow {
  kind: "fanout";
  stepKey: string;
  /** Aggregate over every child's timing — start = earliest, end =
   *  latest, total = wall-clock span (which is parallelism-aware:
   *  three children running concurrently for 10s each have a span of
   *  10s, not 30s). */
  startMs: number;
  endMs: number;
  spanMs: number;
  /** Convenience aggregate over child durations for the right-column
   *  readout and the tooltip. */
  count: number;
  totalDurationMs: number;
  avgMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  /** Children, sorted by start time so an "expand" view reads in order. */
  children: WaterfallStep[];
}

type Row = BackboneRow | FanoutRow;

interface RenderedRow {
  /** Stable index used for hover/focus. Backbone rows get an integer
   *  index; expanded fanout-child rows get `${parentIdx}.${childIdx}`. */
  key: string;
  row: Row | { kind: "child"; parentKey: string; child: WaterfallStep; startMs: number };
  offsetPct: number;
  widthPct: number;
  isChildOfExpanded?: boolean;
}

export function BriefingWaterfall({ steps, totalMs, stepLabels }: BriefingWaterfallProps) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [expandedFanouts, setExpandedFanouts] = useState<Set<string>>(new Set());
  const labels = stepLabels ?? DEFAULT_STEP_LABELS;

  // Group steps by stepKey so multi-row keys collapse into one fanout
  // summary. Keep the original WaterfallStep entries alongside in case
  // a fanout is expanded and we need to render each child.
  const layout = useMemo(() => {
    if (steps.length === 0) {
      return { rows: [] as Row[], totalSpanMs: 0 };
    }
    const grouped = new Map<string, WaterfallStep[]>();
    for (const s of steps) {
      const list = grouped.get(s.stepKey) ?? [];
      list.push(s);
      grouped.set(s.stepKey, list);
    }

    const rows: Row[] = [];
    for (const [stepKey, group] of grouped) {
      if (group.length === 1) {
        const s = group[0];
        rows.push({
          kind: "backbone",
          stepKey,
          step: s,
          startMs: Date.parse(s.startedAt),
          endMs: Date.parse(s.finishedAt),
        });
      } else {
        const childStarts = group.map((c) => Date.parse(c.startedAt));
        const childEnds = group.map((c) => Date.parse(c.finishedAt));
        const startMs = Math.min(...childStarts);
        const endMs = Math.max(...childEnds);
        const sortedDurations = [...group].map((c) => c.durationMs).sort((a, b) => a - b);
        const totalDurationMs = sortedDurations.reduce((a, b) => a + b, 0);
        rows.push({
          kind: "fanout",
          stepKey,
          startMs,
          endMs,
          spanMs: Math.max(1, endMs - startMs),
          count: group.length,
          totalDurationMs,
          avgMs: totalDurationMs / group.length,
          maxMs: sortedDurations[sortedDurations.length - 1],
          p50Ms: percentile(sortedDurations, 0.5),
          p95Ms: percentile(sortedDurations, 0.95),
          children: [...group].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
        });
      }
    }

    // Order rows by their earliest timestamp so the temporal flow of
    // the pipeline is preserved (work_context first, finishing last).
    rows.sort((a, b) => a.startMs - b.startMs);

    const t0 = Math.min(...rows.map((r) => r.startMs));
    const tEnd = Math.max(...rows.map((r) => r.endMs));
    const span = Math.max(tEnd - t0, totalMs ?? 0, 1);
    return { rows, totalSpanMs: span, t0 };
  }, [steps, totalMs]);

  if (layout.rows.length === 0) return null;

  const t0 = layout.t0 ?? 0;
  const span = layout.totalSpanMs;

  // Flatten rows + any expanded fanout children for rendering.
  const rendered: RenderedRow[] = [];
  layout.rows.forEach((row, i) => {
    if (row.kind === "backbone") {
      const offsetMs = Math.max(0, row.startMs - t0);
      rendered.push({
        key: `b${i}`,
        row,
        offsetPct: (offsetMs / span) * 100,
        widthPct: Math.max((row.step.durationMs / span) * 100, 0.5),
      });
    } else {
      const offsetMs = Math.max(0, row.startMs - t0);
      rendered.push({
        key: `f${i}`,
        row,
        offsetPct: (offsetMs / span) * 100,
        widthPct: Math.max((row.spanMs / span) * 100, 0.5),
      });
      if (expandedFanouts.has(row.stepKey)) {
        row.children.forEach((child, ci) => {
          const cStart = Date.parse(child.startedAt);
          const childOffsetMs = Math.max(0, cStart - t0);
          rendered.push({
            key: `f${i}.${ci}`,
            row: {
              kind: "child",
              parentKey: row.stepKey,
              child,
              startMs: cStart,
            },
            offsetPct: (childOffsetMs / span) * 100,
            widthPct: Math.max((child.durationMs / span) * 100, 0.5),
            isChildOfExpanded: true,
          });
        });
      }
    }
  });

  const ticks = computeAxisTicks(span);

  const toggleFanout = (stepKey: string) => {
    setExpandedFanouts((cur) => {
      const next = new Set(cur);
      if (next.has(stepKey)) next.delete(stepKey);
      else next.add(stepKey);
      return next;
    });
  };

  return (
    <div className="relative">
      <div className="flex flex-col gap-1">
        {rendered.map((rr) => {
          const { row, key } = rr;
          const isHovered = hoverKey === key;

          if (row.kind === "child") {
            const color = STEP_COLORS[row.parentKey] ?? FALLBACK_COLOR;
            const label = labels[row.parentKey] ?? row.parentKey;
            const offsetMs = row.startMs - t0;
            return (
              <div
                key={key}
                className="grid grid-cols-[140px_1fr_56px] sm:grid-cols-[180px_1fr_72px] items-center gap-2"
                onMouseEnter={() => setHoverKey(key)}
                onMouseLeave={() => setHoverKey((cur) => (cur === key ? null : cur))}
                onFocus={() => setHoverKey(key)}
                onBlur={() => setHoverKey((cur) => (cur === key ? null : cur))}
              >
                <span className="pl-5 font-mono text-[10px] text-text-faint truncate" title={label}>
                  ↳ iteration
                </span>
                <div className="relative h-1.5">
                  <div className="absolute inset-0 rounded-sm bg-border-subtle/30" />
                  <button
                    type="button"
                    className={`absolute top-0 h-1.5 rounded-sm cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity ${
                      isHovered ? "opacity-95" : "opacity-70"
                    }`}
                    style={{
                      left: `${rr.offsetPct}%`,
                      width: `${rr.widthPct}%`,
                      backgroundColor: color,
                    }}
                    aria-label={`${label} iteration, started at ${formatMs(offsetMs)}, took ${formatMs(row.child.durationMs)}`}
                  />
                </div>
                <span className="font-mono text-[10px] text-text-faint tabular-nums text-right">
                  {formatMs(row.child.durationMs)}
                </span>
              </div>
            );
          }

          if (row.kind === "backbone") {
            const label = labels[row.stepKey] ?? row.stepKey;
            const color = STEP_COLORS[row.stepKey] ?? FALLBACK_COLOR;
            const offsetMs = row.startMs - t0;
            return (
              <div
                key={key}
                className="grid grid-cols-[140px_1fr_56px] sm:grid-cols-[180px_1fr_72px] items-center gap-2"
                onMouseEnter={() => setHoverKey(key)}
                onMouseLeave={() => setHoverKey((cur) => (cur === key ? null : cur))}
                onFocus={() => setHoverKey(key)}
                onBlur={() => setHoverKey((cur) => (cur === key ? null : cur))}
              >
                <span className="font-mono text-[10px] text-text-dim truncate" title={label}>
                  {label}
                </span>
                <div className="relative h-2.5">
                  <div className="absolute inset-0 rounded-sm bg-border-subtle/40" />
                  <button
                    type="button"
                    className={`absolute top-0 h-2.5 rounded-sm cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity ${
                      isHovered ? "opacity-100" : "opacity-90"
                    }`}
                    style={{
                      left: `${rr.offsetPct}%`,
                      width: `${rr.widthPct}%`,
                      backgroundColor: color,
                    }}
                    aria-label={`${label}, started at ${formatMs(offsetMs)}, took ${formatMs(row.step.durationMs)}`}
                  />
                </div>
                <span className="font-mono text-[10px] text-text-secondary tabular-nums text-right">
                  {formatMs(row.step.durationMs)}
                </span>
              </div>
            );
          }

          // Fanout summary row.
          const label = labels[row.stepKey] ?? row.stepKey;
          const color = STEP_COLORS[row.stepKey] ?? FALLBACK_COLOR;
          const offsetMs = row.startMs - t0;
          const isExpanded = expandedFanouts.has(row.stepKey);
          // Striped fill so a fanout's wall-clock span reads as
          // "multiple things happening here" rather than as one long
          // monolithic operation.
          const stripeBg = `repeating-linear-gradient(45deg, ${color} 0 4px, ${color}99 4px 8px)`;
          return (
            <div
              key={key}
              className="grid grid-cols-[140px_1fr_56px] sm:grid-cols-[180px_1fr_72px] items-center gap-2"
              onMouseEnter={() => setHoverKey(key)}
              onMouseLeave={() => setHoverKey((cur) => (cur === key ? null : cur))}
              onFocus={() => setHoverKey(key)}
              onBlur={() => setHoverKey((cur) => (cur === key ? null : cur))}
            >
              <button
                type="button"
                onClick={() => toggleFanout(row.stepKey)}
                className="flex items-center gap-1 text-left font-mono text-[10px] text-text-dim truncate hover:text-text-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
                title={`${label} — ${row.count} iterations · click to ${isExpanded ? "collapse" : "expand"}`}
              >
                <span aria-hidden className="text-[8px] text-text-faint w-2 inline-block">
                  {isExpanded ? "▾" : "▸"}
                </span>
                <span className="truncate">{label}</span>
                <span className="shrink-0 rounded bg-bg-warm border border-border-subtle px-1 py-px text-[9px] text-text-secondary">
                  ×{row.count}
                </span>
              </button>
              <div className="relative h-2.5">
                <div className="absolute inset-0 rounded-sm bg-border-subtle/40" />
                <button
                  type="button"
                  onClick={() => toggleFanout(row.stepKey)}
                  className={`absolute top-0 h-2.5 rounded-sm cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-opacity ${
                    isHovered ? "opacity-100" : "opacity-90"
                  }`}
                  style={{
                    left: `${rr.offsetPct}%`,
                    width: `${rr.widthPct}%`,
                    background: stripeBg,
                  }}
                  aria-label={`${label} fanout — ${row.count} iterations, span ${formatMs(row.spanMs)} from +${formatMs(offsetMs)}, click to ${isExpanded ? "collapse" : "expand"}`}
                />
              </div>
              <span className="font-mono text-[10px] text-text-secondary tabular-nums text-right">
                {formatMs(row.avgMs)} avg
              </span>
            </div>
          );
        })}
      </div>

      {/* Time axis along the bottom — same column template as rows so
          ticks align with bar offsets. */}
      <div className="grid grid-cols-[140px_1fr_56px] sm:grid-cols-[180px_1fr_72px] gap-2 mt-2">
        <span />
        <div className="relative h-3">
          {ticks.map((tick) => (
            <div key={tick.ms} className="absolute top-0 h-full" style={{ left: `${tick.pct}%` }}>
              <div className="h-1 w-px bg-border-subtle" />
              <span className="absolute top-1 -translate-x-1/2 font-mono text-[9px] text-text-faint whitespace-nowrap">
                {formatMs(tick.ms)}
              </span>
            </div>
          ))}
        </div>
        <span />
      </div>

      {/* Hover tooltip — distinct content for backbone, fanout, and
          fanout-child rows. */}
      {hoverKey != null &&
        (() => {
          const target = rendered.find((r) => r.key === hoverKey);
          if (!target) return null;
          return <Tooltip target={target} t0={t0} labels={labels} />;
        })()}
    </div>
  );
}

function Tooltip({ target, t0, labels }: { target: RenderedRow; t0: number; labels: Record<string, string> }) {
  const { row } = target;

  if (row.kind === "child") {
    const label = labels[row.parentKey] ?? row.parentKey;
    return (
      <div className="absolute -top-1 right-0 z-10 pointer-events-none rounded-md border border-border bg-surface shadow-md px-3 py-2 text-[11px] font-mono text-text-secondary max-w-[260px]">
        <div className="font-ui font-semibold text-text-primary mb-0.5">↳ {label} iteration</div>
        <Stat name="duration" value={formatMs(row.child.durationMs)} />
        <Stat name="started at" value={`+${formatMs(row.startMs - t0)}`} />
        {row.child.modelUsed && <Stat name="model" value={shortModel(row.child.modelUsed)} />}
      </div>
    );
  }

  if (row.kind === "backbone") {
    const label = labels[row.stepKey] ?? row.stepKey;
    return (
      <div className="absolute -top-1 right-0 z-10 pointer-events-none rounded-md border border-border bg-surface shadow-md px-3 py-2 text-[11px] font-mono text-text-secondary max-w-[260px]">
        <div className="font-ui font-semibold text-text-primary mb-0.5">{label}</div>
        <Stat name="duration" value={formatMs(row.step.durationMs)} />
        <Stat name="started at" value={`+${formatMs(row.startMs - t0)}`} />
        {row.step.modelUsed && <Stat name="model" value={shortModel(row.step.modelUsed)} />}
        {row.step.itemsProcessed != null && row.step.itemsProcessed > 0 && (
          <Stat name="items" value={String(row.step.itemsProcessed)} />
        )}
      </div>
    );
  }

  // Fanout summary tooltip — count + parallel-aware span + per-child
  // distribution.
  const label = labels[row.stepKey] ?? row.stepKey;
  return (
    <div className="absolute -top-1 right-0 z-10 pointer-events-none rounded-md border border-border bg-surface shadow-md px-3 py-2 text-[11px] font-mono text-text-secondary max-w-[280px]">
      <div className="font-ui font-semibold text-text-primary mb-0.5">
        {label} <span className="text-text-faint">· ×{row.count}</span>
      </div>
      <Stat name="span (parallel)" value={formatMs(row.spanMs)} />
      <Stat name="started at" value={`+${formatMs(row.startMs - t0)}`} />
      <Stat name="avg" value={formatMs(row.avgMs)} />
      <Stat name="p50" value={formatMs(row.p50Ms)} />
      <Stat name="p95" value={formatMs(row.p95Ms)} />
      <Stat name="max" value={formatMs(row.maxMs)} />
      <div className="mt-1 text-[10px] text-text-faint">click to expand iterations</div>
    </div>
  );
}

function Stat({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-faint">{name}</span>
      <span className="text-text-primary tabular-nums truncate">{value}</span>
    </div>
  );
}

/**
 * Linear-interpolation percentile over a sorted-ascending array. Used
 * for the fanout summary's p50 / p95. Defensive on empty arrays
 * because the caller guards group.length > 1, but easy to reuse
 * elsewhere if a pipeline ever introduces another multi-row step.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * Pick 2–4 evenly-spaced ticks for the time axis based on the total span.
 * We aim for tick values that fall on natural-feeling boundaries (200ms,
 * 500ms, 1s, 2s, 5s, 10s, …) rather than arithmetic 25%/50%/75% splits
 * which look awkward at fractional second values.
 */
function computeAxisTicks(totalMs: number): Array<{ ms: number; pct: number }> {
  if (totalMs <= 0) return [];
  const niceUnits = [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  const step = niceUnits.reverse().find((u) => u <= totalMs / 3) ?? Math.max(1, Math.floor(totalMs / 4));
  const ticks: Array<{ ms: number; pct: number }> = [];
  for (let t = step; t < totalMs; t += step) {
    ticks.push({ ms: t, pct: (t / totalMs) * 100 });
  }
  return ticks;
}

function formatMs(ms: number): string {
  if (ms < 1) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function shortModel(model: string): string {
  if (model.includes("haiku")) return "haiku";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("opus")) return "opus";
  if (model.includes("gpt-5")) return "gpt-5";
  if (model.includes("gpt-4o")) return "gpt-4o";
  if (model.includes("gpt-4")) return "gpt-4";
  return model;
}
