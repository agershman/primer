import { useState } from "react";
import { useBudgetUsage, type BudgetUsageData } from "../../../hooks/useBudgetUsage";
import { fmtUsd, operationLabel } from "../../usage-format";
import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, PanelHeader } from "../shared";

export function LimitsPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings } = settings;
  const { data: budget, loading: budgetLoading } = useBudgetUsage();
  if (!data) return null;

  return (
    <div>
      <PanelHeader
        title="Briefing limits"
        description="Spend cap and relevance threshold for the daily generation pipeline."
      />

      <Field
        label="Monthly budget cap"
        hint="Generation halts when total AI spend (LLM + voice, across every provider) reaches this cap."
      >
        <Card>
          <BudgetUsageSection cap={data.budgetCapMonthly} budget={budget} loading={budgetLoading} />
          <div className="pt-3 border-t border-border-subtle">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono text-text-dim">Current cap</span>
              <span className="text-xs font-mono text-text-primary">${data.budgetCapMonthly}</span>
            </div>
            <input
              type="number"
              min={1}
              step={1}
              value={data.budgetCapMonthly}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0) updateSettings({ budgetCapMonthly: v });
              }}
              className="w-full bg-surface border border-border rounded-md px-2.5 py-1.5 text-xs font-mono text-text-primary placeholder:text-text-faint outline-none focus:border-accent transition-colors"
            />
          </div>
        </Card>
      </Field>

      <Field label="Relevance threshold" hint="How selective the briefing is about which topics make the cut.">
        <Card>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-text-dim">Threshold</span>
            <span className="text-xs font-mono text-text-primary tabular-nums">
              {(data.relevanceThreshold ?? 0.4).toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.2}
            max={0.8}
            step={0.05}
            value={data.relevanceThreshold}
            onChange={(e) => updateSettings({ relevanceThreshold: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: "var(--primer-accent)" }}
          />
          <div className="flex justify-between text-[10px] font-mono text-text-faint mt-1">
            <span>More inclusive</span>
            <span>More selective</span>
          </div>
        </Card>
      </Field>
    </div>
  );
}

/**
 * "Battery usage"–style display: total spend vs. cap, a progress bar
 * that turns warning/red as it fills, and a per-use-case breakdown so
 * the user can see which Primer features are consuming the budget.
 * Mirrors what a phone's battery settings screen does for power.
 *
 * The cap value comes from the settings context (always fresh), not
 * from the budget endpoint's response, so the bar's denominator
 * updates immediately when the user edits the cap below.
 */
function BudgetUsageSection({
  cap,
  budget,
  loading,
}: {
  cap: number;
  budget: BudgetUsageData | null;
  loading: boolean;
}) {
  if (loading && !budget) {
    return (
      <div className="mb-3">
        <div className="h-3 rounded bg-surface-active animate-pulse" />
        <div className="mt-2 h-2 rounded bg-surface-active animate-pulse w-2/3" />
      </div>
    );
  }
  if (!budget) return null;

  const { spend, byOperation, byProvider } = budget;
  const ratio = cap > 0 ? spend / cap : 0;
  const pctUsed = Math.round(ratio * 100);
  const remaining = Math.max(0, cap - spend);
  const exceeded = spend >= cap && cap > 0;

  // Bar fill colour: green-zone accent until 75%, warning hue
  // 75–99%, red at/over the cap. Mirrors how mobile battery
  // indicators darken as you approach empty.
  const barFillClass = exceeded
    ? "bg-negative"
    : ratio >= 0.75
      ? "bg-warning"
      : "bg-accent";

  return (
    <div className="mb-3">
      {exceeded && (
        <div
          role="alert"
          className="mb-3 rounded-md bg-negative-dim border border-negative/30 px-3 py-2.5"
        >
          <div className="text-[11px] font-semibold text-negative">Generation halted</div>
          <div className="mt-0.5 text-[10px] font-mono text-negative/90 leading-relaxed">
            You've reached your ${cap} monthly cap. Briefings resume next month, or raise the cap below to unblock now.
          </div>
        </div>
      )}

      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs font-mono text-text-dim">This month</span>
        <span className="text-xs font-mono text-text-primary tabular-nums">
          <span className="text-text-primary">{fmtUsd(spend)}</span>
          <span className="text-text-dim"> of ${cap}</span>
          <span className="ml-1.5 text-text-faint">({pctUsed}%)</span>
        </span>
      </div>

      <div
        className="h-1.5 w-full rounded-full bg-surface-active overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.min(pctUsed, 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Monthly budget used"
      >
        <div
          className={`h-full ${barFillClass} transition-all duration-300`}
          style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
        />
      </div>

      <div className="mt-1 text-[10px] font-mono text-text-faint">
        {exceeded ? "$0 remaining" : `${fmtUsd(remaining)} remaining`}
      </div>

      {byOperation.length > 0 && <OperationBreakdown rows={byOperation} totalSpend={spend} />}
      {byProvider.length > 0 && <ProviderSummary rows={byProvider} />}
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  cloudflare: "Cloudflare",
};

function providerLabel(p: string): string {
  return PROVIDER_LABELS[p] ?? p;
}

/**
 * Top contributors as labeled rows with a share-of-spend bar — the
 * "what used the most power" half of the battery metaphor. The bar
 * length is per-row's share of the user's CURRENT month spend, not
 * of the cap, so the rows visually add to 100% regardless of how
 * far through the budget they are.
 */
function OperationBreakdown({
  rows,
  totalSpend,
}: {
  rows: BudgetUsageData["byOperation"];
  totalSpend: number;
}) {
  const TOP_LIMIT = 5;
  const [expanded, setExpanded] = useState(false);
  const sorted = rows.filter((r) => r.costUsd > 0);
  if (sorted.length === 0) return null;

  const visible = expanded ? sorted : sorted.slice(0, TOP_LIMIT);
  const hidden = Math.max(0, sorted.length - TOP_LIMIT);

  return (
    <div className="mt-4">
      <div className="text-[10px] font-mono uppercase tracking-wider text-text-dim mb-2">By use case</div>
      <div className="space-y-1.5">
        {visible.map((r) => {
          const share = totalSpend > 0 ? r.costUsd / totalSpend : 0;
          return (
            <div key={`${r.operation}::${r.modality}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-ui text-text-primary truncate">{operationLabel(r.operation)}</span>
                <span className="text-[11px] font-mono text-text-secondary tabular-nums shrink-0">
                  {fmtUsd(r.costUsd)}
                </span>
              </div>
              <div className="mt-1 h-1 w-full rounded-full bg-surface-active overflow-hidden">
                <div
                  className="h-full bg-accent/70"
                  style={{ width: `${Math.min(100, Math.max(0, share * 100))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 text-[10px] font-mono text-text-dim hover:text-text-primary transition-colors"
        >
          {expanded ? "Show top 5" : `+ ${hidden} more`}
        </button>
      )}
    </div>
  );
}

/**
 * One-line provider summary. Single row so it stays compact, but
 * conveys that the cap covers every AI provider in use (Anthropic,
 * OpenAI, Cloudflare, ElevenLabs) — not just one of them.
 */
function ProviderSummary({ rows }: { rows: BudgetUsageData["byProvider"] }) {
  const nonZero = rows.filter((r) => r.costUsd > 0);
  if (nonZero.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-border-subtle">
      <div className="text-[10px] font-mono uppercase tracking-wider text-text-dim mb-1.5">By provider</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono">
        {nonZero.map((r) => (
          <span key={r.provider} className="text-text-secondary">
            {providerLabel(r.provider)}{" "}
            <span className="text-text-primary tabular-nums">{fmtUsd(r.costUsd)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
