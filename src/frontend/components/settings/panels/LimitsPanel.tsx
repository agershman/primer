import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, InfoRow, PanelHeader } from "../shared";

export function LimitsPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings } = settings;
  if (!data) return null;

  return (
    <div>
      <PanelHeader
        title="Briefing limits"
        description="Spend cap and relevance threshold for the daily generation pipeline."
      />

      <Field label="Monthly budget cap" hint="Generation halts when this Anthropic spend is reached.">
        <Card>
          <InfoRow label="Current cap" value={`$${data.budgetCapMonthly}`} />
          <div className="pt-2">
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
