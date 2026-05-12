import { useSettingsCtx } from "../SettingsContext";
import { Card, PanelHeader, ProviderGroupedSelect } from "../shared";

const MODEL_OPERATIONS: Array<{ key: string; label: string; desc: string }> = [
  { key: "teachingPiece", label: "Teaching pieces", desc: "The main daily briefing content" },
  { key: "deepDive", label: "Deep dives", desc: "Extended drill-down content" },
  { key: "quizAssessment", label: "Quiz assessment", desc: "Evaluating your quiz answers" },
  { key: "chat", label: "Chat", desc: "Conversational assistant" },
  {
    key: "conceptExtraction",
    label: "Concept extraction",
    desc: "Identifying concepts from work context",
  },
  {
    key: "adjacentScoring",
    label: "Adjacent scoring",
    desc: "Ranking external sources for relevance",
  },
  { key: "quizGeneration", label: "Quiz generation", desc: "Writing calibration questions" },
  {
    key: "continuationClassifier",
    label: "Continuation classifier",
    desc: "Decides if a draft is novel, a continuation, or redundant",
  },
  {
    key: "audit",
    label: "Audit",
    desc: "Classifies factual claims after generation; flags hallucinations and patches/drops them",
  },
  {
    key: "auditPatch",
    label: "Audit patch",
    desc: "Rewrites flagged claims into defensible form (defaults to the teaching-piece model for voice consistency)",
  },
];

// Provider ordering for the optgroup. Listed broadly enough that
// future provider entries (OpenAI, Google, Workers AI, OpenRouter)
// land in a consistent slot once their adapters register. Mirrors
// the LLM `ProviderId` union; unknown providers fall through and
// render with the bare provider id as the group header.
const PROVIDER_ORDER = ["anthropic", "openai", "google", "workers-ai", "openrouter"] as const;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "workers-ai": "Cloudflare Workers AI",
  openrouter: "OpenRouter",
};

export function ModelsPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings, availableModels, modelDefaults } = settings;
  if (!data) return null;

  const models = (data.signalSurfaceMap?.models ?? {}) as Record<string, string>;
  const updateModels = (partial: Record<string, string>) => {
    updateSettings({
      signalSurfaceMap: {
        ...data.signalSurfaceMap,
        models: { ...models, ...partial },
      },
    });
  };

  return (
    <div>
      <PanelHeader
        title="AI models"
        description="Pick which model powers each step of Primer. Models from each provider show up grouped together — providers without an API key configured stay hidden."
      />

      <Card>
        <div className="space-y-2.5">
          {MODEL_OPERATIONS.map((op) => {
            const current = models[op.key] ?? modelDefaults[op.key as keyof typeof modelDefaults] ?? "";
            return (
              <div key={op.key} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-mono text-text-primary">{op.label}</div>
                  <div className="text-[10px] font-mono text-text-dim truncate">{op.desc}</div>
                </div>
                <ProviderGroupedSelect
                  models={availableModels}
                  value={current}
                  onChange={(id) => updateModels({ [op.key]: id })}
                  providerOrder={PROVIDER_ORDER}
                  providerLabels={PROVIDER_LABELS}
                  className="shrink-0 bg-surface border border-border rounded-md px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors"
                />
              </div>
            );
          })}
        </div>
      </Card>

      <p className="mt-3 text-[10px] font-mono text-text-dim leading-relaxed">
        Click <span className="text-text-primary">Build full briefing preview</span> at the bottom of this modal to see
        how these settings affect cost and timing.
      </p>
    </div>
  );
}
