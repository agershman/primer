import { useMemo, useState } from "react";
import type { UsageData, UsageMetrics } from "../hooks/useAnalytics";
import { Bars } from "./Trendline";
import { fmtUsd, operationLabel } from "./usage-format";

/**
 * Token + audio-character usage breakdown.
 *
 * Three cuts of the unified `usage_events` ledger:
 *
 *   1. Aggregate totals — what's the bottom line over this window?
 *   2. Per-operation table — which Primer use case is consuming the
 *      most tokens / chars / dollars? Drives prompt-tuning intuitions
 *      ("concept extraction is using 4× the input tokens of teaching
 *      pieces, that prompt is too verbose").
 *   3. Per-model table — which provider/model rows are the biggest
 *      contributors? Drives tier-down decisions ("`chat_title` is
 *      using Sonnet but only ~30 output tokens; switch to Haiku").
 *
 * Plus a TTS provider projection card: takes the current TTS char
 * volume and projects what it WOULD cost on each catalog candidate.
 * Useful when deciding whether to swap to ElevenLabs (warmer voice,
 * higher per-char rate) or down to Cloudflare Aura (cheaper, more
 * synthetic).
 */

function fmtTokens(n: number): string {
  if (n === 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtChars(n: number): string {
  if (n === 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

interface UsageBreakdownProps {
  data: UsageData;
}

export function UsageBreakdown({ data }: UsageBreakdownProps) {
  const { totals, byOperation, byModel, byDay, currentTtsCharsInWindow, ttsCatalog } = data;

  // Aggregate "current TTS cost" across all TTS rows in the window
  // — the baseline against which projections compare. Sum across
  // byModel TTS rows so it includes voice variants the user has
  // tried mid-window.
  const currentTtsCostUsd = useMemo(
    () => byModel.filter((m) => m.modality === "tts").reduce((s, m) => s + m.costUsd, 0),
    [byModel],
  );

  return (
    <section>
      <h2 className="font-display text-lg font-medium text-text-primary mb-1">Token + audio usage</h2>
      <p className="font-mono text-[10px] text-text-dim mb-3">
        Volume + cost per use case and per model, recorded into{" "}
        <span className="text-text-secondary">usage_events</span> every time Primer calls a model. Use this to spot
        prompt bloat, decide when to tier down a model, or project the cost of switching TTS providers.
      </p>

      {/* ─── Aggregate totals ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Calls" value={totals.calls.toLocaleString()} hint={`Last ${data.windowDays} days`} />
        <Stat label="Input tokens" value={fmtTokens(totals.inputTokens)} hint="LLM prompt + context" />
        <Stat
          label="Output tokens"
          value={fmtTokens(totals.outputTokens + totals.reasoningTokens)}
          hint={
            totals.reasoningTokens > 0 ? `${fmtTokens(totals.reasoningTokens)} reasoning included` : "LLM completions"
          }
        />
        <Stat label="Audio chars" value={fmtChars(totals.audioChars)} hint="TTS synthesis input" />
      </div>

      {/* ─── Per-operation table ─── */}
      <UsageTable
        title="By use case"
        subtitle="Which Primer surface is consuming the most? Sorted by spend."
        rows={byOperation}
        primaryColumn={{
          header: "Use case",
          render: (r) => (
            <>
              <div className="font-ui text-sm text-text-primary truncate">{operationLabel(r.operation)}</div>
              <div className="font-mono text-[10px] text-text-dim truncate">
                <span className="uppercase tracking-wider">{r.modality}</span>
                <span className="ml-2 text-text-faint">{r.operation}</span>
              </div>
            </>
          ),
        }}
      />

      {/* ─── Per-model table ─── */}
      <div className="mt-4">
        <UsageTable
          title="By model"
          subtitle="Roll-up across use cases. Pick a tier-down candidate by comparing tokens/call."
          rows={byModel}
          primaryColumn={{
            header: "Provider · model",
            render: (r) => (
              <>
                <div className="font-ui text-sm text-text-primary truncate">{r.model}</div>
                <div className="font-mono text-[10px] text-text-dim truncate">
                  <span className="uppercase tracking-wider">{r.provider}</span>
                  <span className="ml-2 text-text-faint">{r.modality}</span>
                </div>
              </>
            ),
          }}
        />
      </div>

      {/* ─── Daily token volume ─── */}
      {byDay.length > 0 && (
        <div className="mt-4 rounded-lg border border-border-subtle p-4">
          <h3 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">
            Daily volume
          </h3>
          <p className="font-mono text-[10px] text-text-dim mb-3">
            Stacked bars: input vs output tokens (LLM) and audio chars (TTS) per day. Useful for spotting traffic spikes
            and projecting future spend.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <DailyChart label="Input tokens" values={byDay.map((d) => d.inputTokens)} accent />
            <DailyChart label="Output tokens" values={byDay.map((d) => d.outputTokens + d.reasoningTokens)} accent />
            <DailyChart label="Audio chars" values={byDay.map((d) => d.audioChars)} />
          </div>
        </div>
      )}

      {/* ─── TTS provider projection ─── */}
      {currentTtsCharsInWindow > 0 && (
        <TtsProjection
          chars={currentTtsCharsInWindow}
          currentCostUsd={currentTtsCostUsd}
          catalog={ttsCatalog}
          windowDays={data.windowDays}
        />
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-dim">{label}</div>
      <div className="mt-1 font-display text-xl text-text-primary tabular-nums">{value}</div>
      {hint ? <div className="font-mono text-[10px] text-text-faint mt-0.5">{hint}</div> : null}
    </div>
  );
}

interface UsageRow extends UsageMetrics {
  modality?: "text" | "tts";
}

interface UsageTableProps<R extends UsageRow> {
  title: string;
  subtitle: string;
  rows: R[];
  primaryColumn: {
    header: string;
    render: (row: R) => React.ReactNode;
  };
}

function UsageTable<R extends UsageRow>({ title, subtitle, rows, primaryColumn }: UsageTableProps<R>) {
  // Show the top N rows by default; "Show all" expands. Most users
  // have ~10 unique operations and ~5 models so the cap is gentle.
  const TOP_LIMIT = 8;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, TOP_LIMIT);
  const hidden = Math.max(0, rows.length - TOP_LIMIT);

  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden">
      <div className="px-4 py-2.5 bg-bg-warm border-b border-border-subtle">
        <h3 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-secondary">{title}</h3>
        <p className="font-mono text-[10px] text-text-dim mt-0.5">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center font-ui text-sm text-text-dim italic">
          No usage events recorded in this window.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-12 gap-2 px-4 py-1.5 border-b border-border-subtle text-text-faint">
            <div className="col-span-4 font-mono text-[10px] uppercase tracking-wider">{primaryColumn.header}</div>
            <div className="col-span-1 font-mono text-[10px] uppercase tracking-wider text-right">Calls</div>
            <div className="col-span-2 font-mono text-[10px] uppercase tracking-wider text-right">Input</div>
            <div className="col-span-2 font-mono text-[10px] uppercase tracking-wider text-right">Output</div>
            <div className="col-span-1 font-mono text-[10px] uppercase tracking-wider text-right">Chars</div>
            <div className="col-span-2 font-mono text-[10px] uppercase tracking-wider text-right">Cost</div>
          </div>
          <div className="divide-y divide-border-subtle">
            {visible.map((r, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 px-4 py-2 items-center">
                <div className="col-span-4 min-w-0">{primaryColumn.render(r)}</div>
                <div className="col-span-1 font-mono text-xs text-text-primary tabular-nums text-right">
                  {r.calls.toLocaleString()}
                </div>
                <div className="col-span-2 font-mono text-xs text-text-secondary tabular-nums text-right">
                  {fmtTokens(r.inputTokens)}
                </div>
                <div className="col-span-2 font-mono text-xs text-text-secondary tabular-nums text-right">
                  {fmtTokens(r.outputTokens + r.reasoningTokens)}
                  {r.reasoningTokens > 0 ? (
                    <span className="ml-1 text-[9px] text-text-faint">(+{fmtTokens(r.reasoningTokens)} reasoning)</span>
                  ) : null}
                </div>
                <div className="col-span-1 font-mono text-xs text-text-secondary tabular-nums text-right">
                  {fmtChars(r.audioChars)}
                </div>
                <div className="col-span-2 font-mono text-xs text-text-primary tabular-nums text-right">
                  {fmtUsd(r.costUsd)}
                </div>
              </div>
            ))}
          </div>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="w-full px-4 py-2 border-t border-border-subtle font-mono text-[10px] uppercase tracking-wider text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              {expanded ? "Show top 8" : `Show all (${rows.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function DailyChart({ label, values, accent }: { label: string; values: number[]; accent?: boolean }) {
  const total = values.reduce((s, v) => s + v, 0);
  return (
    <div className="rounded-md border border-border-subtle p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-dim">{label}</div>
      <div className="mt-1 font-display text-base text-text-primary tabular-nums">{fmtTokens(total)}</div>
      <div className="mt-1.5">
        <Bars values={values} width={180} height={28} className={accent ? "" : ""} />
      </div>
    </div>
  );
}

function TtsProjection({
  chars,
  currentCostUsd,
  catalog,
  windowDays,
}: {
  chars: number;
  currentCostUsd: number;
  catalog: UsageData["ttsCatalog"];
  windowDays: number;
}) {
  // Each candidate's projected cost = char volume × per-1k rate.
  // The "delta" column compares against the user's CURRENT TTS spend
  // for the same window so a candidate cheaper than the current pick
  // shows a negative delta (savings).
  const projections = useMemo(() => {
    return catalog
      .map((m) => {
        const projectedCost = (chars / 1000) * m.costPer1kChars;
        return {
          ...m,
          projectedCost,
          delta: projectedCost - currentCostUsd,
          // Per-day projected cost so users can extrapolate
          // monthly / yearly spend ("if I keep this voice, I'll
          // spend ~$X/mo").
          perDay: projectedCost / Math.max(1, windowDays),
        };
      })
      .sort((a, b) => a.projectedCost - b.projectedCost);
  }, [catalog, chars, currentCostUsd, windowDays]);

  if (projections.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-border-subtle overflow-hidden">
      <div className="px-4 py-2.5 bg-bg-warm border-b border-border-subtle">
        <h3 className="font-ui text-xs font-semibold uppercase tracking-wider text-text-secondary">
          What if I switched TTS provider?
        </h3>
        <p className="font-mono text-[10px] text-text-dim mt-0.5">
          Projecting your current <span className="text-text-secondary tabular-nums">{fmtChars(chars)}</span> chars over
          the last {windowDays} days against every catalog voice. Δ vs your{" "}
          <span className="text-text-secondary tabular-nums">{fmtUsd(currentCostUsd)}</span> current TTS spend.
        </p>
      </div>
      <div className="grid grid-cols-12 gap-2 px-4 py-1.5 border-b border-border-subtle text-text-faint">
        <div className="col-span-6 font-mono text-[10px] uppercase tracking-wider">Voice</div>
        <div className="col-span-2 font-mono text-[10px] uppercase tracking-wider text-right">Per 1k chars</div>
        <div className="col-span-2 font-mono text-[10px] uppercase tracking-wider text-right">Projected</div>
        <div className="col-span-2 font-mono text-[10px] uppercase tracking-wider text-right">Δ vs current</div>
      </div>
      <div className="divide-y divide-border-subtle max-h-[280px] overflow-y-auto">
        {projections.map((p) => (
          <div key={p.id} className="grid grid-cols-12 gap-2 px-4 py-2 items-center">
            <div className="col-span-6 min-w-0">
              <div className="font-ui text-sm text-text-primary truncate">{p.label}</div>
              <div className="font-mono text-[10px] text-text-dim truncate">
                <span className="uppercase tracking-wider">{p.provider}</span>
                <span className="ml-2 text-text-faint">~{fmtUsd(p.perDay)}/day</span>
              </div>
            </div>
            <div className="col-span-2 font-mono text-xs text-text-secondary tabular-nums text-right">
              ${p.costPer1kChars.toFixed(3)}
            </div>
            <div className="col-span-2 font-mono text-xs text-text-primary tabular-nums text-right">
              {fmtUsd(p.projectedCost)}
            </div>
            <div
              className={`col-span-2 font-mono text-xs tabular-nums text-right ${
                Math.abs(p.delta) < 0.005 ? "text-text-faint" : p.delta > 0 ? "text-negative" : "text-positive"
              }`}
            >
              {Math.abs(p.delta) < 0.005
                ? "≈ current"
                : `${p.delta > 0 ? "+" : ""}${fmtUsd(Math.abs(p.delta)).replace("$", p.delta < 0 ? "−$" : "$")}`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
