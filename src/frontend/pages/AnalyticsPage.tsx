import { useMemo } from "react";
import { BriefingWaterfall } from "../components/BriefingWaterfall";
import { Bars, Trendline } from "../components/Trendline";
import { UsageBreakdown } from "../components/UsageBreakdown";
import { useAnalytics } from "../hooks/useAnalytics";

const STEP_LABELS: Record<string, string> = {
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

const DEPTH_LABELS = ["Unknown", "Aware", "Understands", "Applies", "Teaches", "Authoritative"];

const WINDOW_OPTIONS = [
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
  { value: 365, label: "1y" },
];

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Tier label for the waterfall. Catalog-backed labelling lands in PR 4
 * (when multi-provider entries appear); for now we fall through to a
 * provider-aware substring scan so OpenAI / Gemini ids will still
 * resolve to a sensible tier label without reshipping the page.
 */
function modelTier(model: string | null): string {
  if (!model) return "—";
  // Anthropic
  if (model.includes("haiku")) return "haiku";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("opus")) return "opus";
  // OpenAI (forward-looking)
  if (model.startsWith("gpt-5")) return "gpt-5";
  if (model.startsWith("gpt-4")) return "gpt-4";
  if (/^o[1-9]/.test(model)) return "o-series";
  // Google (forward-looking)
  if (model.includes("gemini")) return "gemini";
  return model;
}

export function AnalyticsPage() {
  const { days, setDays, performance, learning, usage, briefings, loading, error } = useAnalytics();

  const briefingTotalsValues = useMemo(() => performance?.briefingTotals.map((b) => b.totalMs) ?? [], [performance]);
  const conceptsAddedValues = useMemo(() => learning?.conceptsAddedByDay.map((d) => d.count) ?? [], [learning]);
  const costValues = useMemo(() => performance?.costByDay.map((c) => c.costUsd) ?? [], [performance]);

  const totalRecentBriefings = performance?.briefingTotals.length ?? 0;
  const avgTotal = totalRecentBriefings
    ? Math.round(briefingTotalsValues.reduce((a, b) => a + b, 0) / totalRecentBriefings)
    : 0;
  const totalCost = costValues.reduce((a, b) => a + b, 0);

  return (
    <div className="animate-fade-in space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary mb-1">Analytics</h1>
          <p className="font-ui text-sm text-text-dim">
            How long Primer takes to build your briefings, how your tuning affects performance, and how your learning is
            progressing.
          </p>
        </div>

        <div className="flex items-center rounded-md border border-border overflow-hidden">
          {WINDOW_OPTIONS.map((opt) => {
            const active = days === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setDays(opt.value)}
                className={`px-3 py-1 font-mono text-xs transition-colors ${
                  active ? "bg-surface-active text-text-primary" : "text-text-dim hover:text-text-primary"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 px-4 py-3 font-ui text-sm text-text-secondary">
          {error}
        </div>
      )}

      {loading && !performance && !learning && (
        <div className="space-y-4">
          <div className="h-32 rounded-lg bg-surface-active animate-pulse" />
          <div className="h-32 rounded-lg bg-surface-active animate-pulse" />
        </div>
      )}

      {/* ─── Performance ─── */}
      {performance && (
        <section>
          <h2 className="font-display text-lg font-medium text-text-primary mb-3">Performance</h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <SummaryCard
              label="Avg briefing"
              value={avgTotal > 0 ? formatMs(avgTotal) : "—"}
              detail={`${totalRecentBriefings} briefings in window`}
              spark={<Trendline values={briefingTotalsValues} width={140} height={32} />}
            />
            <SummaryCard
              label="API cost"
              value={`$${totalCost.toFixed(2)}`}
              detail={`Last ${days} days`}
              spark={<Bars values={costValues} width={140} height={32} />}
            />
            <SummaryCard
              label="Concepts added"
              value={String(conceptsAddedValues.reduce((a, b) => a + b, 0))}
              detail={`Across ${conceptsAddedValues.length} active days`}
              spark={<Bars values={conceptsAddedValues} width={140} height={32} />}
            />
          </div>

          <div className="rounded-lg border border-border-subtle overflow-hidden">
            <div className="px-4 py-2.5 bg-bg-warm border-b border-border-subtle">
              <h3 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-secondary">
                Per-step timing by model
              </h3>
              <p className="font-mono text-[10px] text-text-dim mt-0.5">
                Compare how long each pipeline step takes. Switch models in Settings to see the impact here.
              </p>
            </div>
            <div className="divide-y divide-border-subtle">
              {performance.stepStats.length === 0 && (
                <div className="px-4 py-6 text-center font-ui text-sm text-text-dim italic">
                  No briefings yet. Generate a briefing to start collecting timings.
                </div>
              )}
              {performance.stepStats.map((s, i) => (
                <div key={i} className="px-4 py-2.5 grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-5 min-w-0">
                    <div className="font-ui text-sm text-text-primary truncate">
                      {STEP_LABELS[s.stepKey] ?? s.stepKey}
                    </div>
                    <div className="font-mono text-[10px] text-text-dim truncate">
                      {s.modelUsed ? modelTier(s.modelUsed) : s.stepKey === "teaching_piece" ? "" : "no model"}
                      {s.itemsTotal > 0 && <span className="ml-2">{s.itemsTotal} items total</span>}
                    </div>
                  </div>
                  <div className="col-span-2 font-mono text-xs text-text-primary tabular-nums">
                    {formatMs(s.avgMs)}
                    <div className="text-[10px] text-text-faint">avg</div>
                  </div>
                  <div className="col-span-2 font-mono text-xs text-text-primary tabular-nums">
                    {formatMs(s.p50Ms)}
                    <div className="text-[10px] text-text-faint">p50</div>
                  </div>
                  <div className="col-span-2 font-mono text-xs text-text-primary tabular-nums">
                    {formatMs(s.p95Ms)}
                    <div className="text-[10px] text-text-faint">p95</div>
                  </div>
                  <div className="col-span-1 font-mono text-[10px] text-text-faint tabular-nums text-right">
                    n={s.runs}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ─── Token + audio usage breakdown ─── */}
      {usage && <UsageBreakdown data={usage} />}

      {/* ─── Learning ─── */}
      {learning && (
        <section>
          <h2 className="font-display text-lg font-medium text-text-primary mb-3">Learning</h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <SummaryCard label="Concepts tracked" value={String(learning.totalConcepts)} detail="Across your graph" />
            <SummaryCard
              label="Quizzes completed"
              value={String(learning.quizzes.completed)}
              detail={`+${(learning.quizzes.cumulativeDepthGain ?? 0).toFixed(1)} depth gained`}
            />
            <SummaryCard
              label="Feedback"
              value={`${learning.feedback.positive} 👍 / ${learning.feedback.negative} 👎`}
              detail={`Last ${days} days`}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border-subtle p-4">
              <h3 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">
                Depth distribution
              </h3>
              <DepthDistribution distribution={learning.depthDistribution} />
            </div>

            <div className="rounded-lg border border-border-subtle p-4">
              <h3 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3">
                Top movers
              </h3>
              {learning.topMovers.length === 0 ? (
                <p className="font-ui text-sm text-text-dim italic">No concept depths have moved in this window.</p>
              ) : (
                <div className="space-y-1.5">
                  {learning.topMovers.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-text-primary truncate">{m.name}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono text-[10px] text-text-faint tabular-nums">
                          d={(m.currentDepth ?? 0).toFixed(1)}
                        </span>
                        <span
                          className={`font-mono text-xs tabular-nums ${
                            m.delta > 0 ? "text-positive" : "text-negative"
                          }`}
                        >
                          {m.delta > 0 ? "+" : ""}
                          {(m.delta ?? 0).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ─── Recent briefings ─── */}
      {briefings.length > 0 && (
        <section>
          <h2 className="font-display text-lg font-medium text-text-primary mb-1">Recent briefings</h2>
          <p className="font-mono text-[10px] text-text-dim mb-3">
            Trace-style waterfall. Solid bars are <span className="text-text-secondary">backbone</span> steps that run
            once per briefing; striped bars with a <span className="text-text-secondary">×N</span> badge are
            <span className="text-text-secondary"> iterative</span> steps that fan out in parallel — click one to expand
            its individual iterations. Hover any bar for exact timing, distribution, and the model used.
          </p>
          <div className="rounded-lg border border-border-subtle overflow-hidden">
            <div className="divide-y divide-border-subtle">
              {briefings.slice(0, 10).map((b) => (
                <div key={b.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div>
                      <div className="font-ui text-sm text-text-primary">{b.briefingDate}</div>
                      <div className="font-mono text-[10px] text-text-dim">{b.status}</div>
                    </div>
                    <div className="font-mono text-xs text-text-primary tabular-nums">{formatMs(b.totalMs)}</div>
                  </div>
                  {b.steps.length > 0 && (
                    <BriefingWaterfall steps={b.steps} totalMs={b.totalMs} stepLabels={STEP_LABELS} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  spark,
}: {
  label: string;
  value: string;
  detail: string;
  spark?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-dim">{label}</div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div>
          <div className="font-display text-xl text-text-primary">{value}</div>
          <div className="font-mono text-[10px] text-text-faint">{detail}</div>
        </div>
        {spark}
      </div>
    </div>
  );
}

function DepthDistribution({ distribution }: { distribution: Array<{ bucket: number; count: number }> }) {
  const buckets = [0, 1, 2, 3, 4, 5];
  const counts = buckets.map((b) => distribution.find((d) => d.bucket === b)?.count ?? 0);
  const max = Math.max(...counts, 1);
  return (
    <div className="space-y-1.5">
      {buckets.map((b, i) => {
        const count = counts[i];
        const pct = (count / max) * 100;
        return (
          <div key={b} className="flex items-center gap-2 text-xs font-mono">
            <div className="w-24 text-text-dim shrink-0">{DEPTH_LABELS[b]}</div>
            <div className="flex-1 bg-bg-warm rounded h-3 overflow-hidden border border-border-subtle">
              <div className="h-full bg-accent transition-all" style={{ width: `${pct}%`, opacity: 0.6 + b * 0.08 }} />
            </div>
            <div className="w-8 text-right tabular-nums text-text-primary">{count}</div>
          </div>
        );
      })}
    </div>
  );
}
