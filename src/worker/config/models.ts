/**
 * LLM model catalog + per-operation override resolution.
 *
 * Each `ModelEntry` is provider-aware and self-describes its own pricing,
 * tier, reasoning capability, and feature flags. Adding a new model (or a
 * new provider) is a single entry — analytics, cost estimation, settings
 * UI, and budget math all read from this same list.
 *
 * Pricing rates last verified: 2026-04-27.
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - OpenAI:    https://platform.openai.com/docs/pricing
 *   - Google:    https://ai.google.dev/pricing
 * Treat these as informational — provider rates change often. The catalog
 * is the single edit point.
 */

import type { ModelSpec, ProviderId } from "../integrations/llm/types.js";

export type ModelTier = "fast" | "balanced" | "quality";

export type ReasoningCapability = "none" | "effort" | "budget";

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M reasoning tokens. Defaults to `outputPer1M` for providers
   *  that bill reasoning at the regular output rate (the common case). */
  reasoningPer1M?: number;
  /** USD per 1M cached-input tokens read. 0 / omitted when the provider
   *  doesn't bill cache traffic separately. */
  cacheReadPer1M?: number;
  /** USD per 1M cache-write tokens (Anthropic only today). */
  cacheWritePer1M?: number;
}

export interface ModelEntry {
  /** Catalog id; also the override key in `signalSurfaceMap.models`.
   *  Anthropic entries reuse the provider's native id for backwards
   *  compatibility with overrides written before the catalog refactor. */
  id: string;
  provider: ProviderId;
  /** Provider-native model id passed on the wire. For Anthropic this
   *  matches `id`; for cross-provider entries (OpenRouter etc.) it can
   *  differ. */
  providerModel: string;
  label: string;
  tier: ModelTier;
  description: string;
  pricing: ModelPricing;
  reasoning: ReasoningCapability;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  contextWindow: number;
}

/**
 * Catalog of available models. Order matters in the Settings panel
 * dropdown — fastest first, then balanced, then quality.
 */
export const AVAILABLE_MODELS: readonly ModelEntry[] = [
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    providerModel: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    tier: "fast",
    description: "Fast and cost-efficient. Matches Sonnet 4 on most tasks.",
    pricing: {
      // Haiku 4.5 list pricing: $1 / 1M input, $5 / 1M output.
      // Cache: read 0.10x input, write 1.25x input.
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 1.25,
    },
    reasoning: "budget",
    supportsTools: true,
    supportsJsonMode: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    providerModel: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4",
    tier: "balanced",
    description: "Balanced quality and speed. Good default for user-facing content.",
    pricing: {
      // Sonnet 4 list pricing: $3 / 1M input, $15 / 1M output.
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
    },
    reasoning: "budget",
    supportsTools: true,
    supportsJsonMode: false,
    contextWindow: 200_000,
  },
  {
    id: "claude-opus-4-20250514",
    provider: "anthropic",
    providerModel: "claude-opus-4-20250514",
    label: "Claude Opus 4",
    tier: "quality",
    description: "Highest quality, slowest, most expensive.",
    pricing: {
      // Opus 4 list pricing: $15 / 1M input, $75 / 1M output.
      inputPer1M: 15,
      outputPer1M: 75,
      cacheReadPer1M: 1.5,
      cacheWritePer1M: 18.75,
    },
    reasoning: "budget",
    supportsTools: true,
    supportsJsonMode: false,
    contextWindow: 200_000,
  },

  // ── OpenAI ──
  //
  // Pricing rates last verified: 2026-04-27 against the public
  // pricing page. Update the comment + numbers when rates change.
  // Cache reads use OpenAI's automatic prompt cache (no separate
  // write rate, so cacheWritePer1M stays unset). Reasoning uses
  // the `effort` knob (minimal/low/medium/high) — billed at the
  // same output rate per OpenAI's docs.
  {
    id: "gpt-5-nano",
    provider: "openai",
    providerModel: "gpt-5-nano",
    label: "GPT-5 nano",
    tier: "fast",
    description: "Smallest, fastest GPT-5 — well-suited to bulk classification and structured extraction.",
    pricing: {
      inputPer1M: 0.05,
      outputPer1M: 0.4,
      cacheReadPer1M: 0.005,
    },
    reasoning: "effort",
    supportsTools: true,
    supportsJsonMode: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    providerModel: "gpt-5-mini",
    label: "GPT-5 mini",
    tier: "balanced",
    description: "Mid-tier GPT-5 — strong reasoning at a fraction of the full model's cost.",
    pricing: {
      inputPer1M: 0.25,
      outputPer1M: 2,
      cacheReadPer1M: 0.025,
    },
    reasoning: "effort",
    supportsTools: true,
    supportsJsonMode: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5",
    provider: "openai",
    providerModel: "gpt-5",
    label: "GPT-5",
    tier: "quality",
    description: "Full GPT-5. Highest quality OpenAI option; use for deep dives and nuanced grading.",
    pricing: {
      inputPer1M: 1.25,
      outputPer1M: 10,
      cacheReadPer1M: 0.125,
    },
    reasoning: "effort",
    supportsTools: true,
    supportsJsonMode: true,
    contextWindow: 400_000,
  },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]["id"];

export type ModelOperation =
  | "conceptExtraction"
  | "adjacentScoring"
  | "teachingPiece"
  | "deepDive"
  | "quizGeneration"
  | "quizAssessment"
  | "chat"
  | "continuationClassifier"
  | "focusScoring";

export const DEFAULT_MODELS: Record<ModelOperation, ModelId> = {
  conceptExtraction: "claude-haiku-4-5-20251001",
  adjacentScoring: "claude-haiku-4-5-20251001",
  teachingPiece: "claude-sonnet-4-20250514",
  deepDive: "claude-sonnet-4-20250514",
  quizGeneration: "claude-haiku-4-5-20251001",
  quizAssessment: "claude-sonnet-4-20250514",
  chat: "claude-sonnet-4-20250514",
  // Classification-only — short JSON output, low temperature use case.
  // Haiku is more than capable here and keeps the per-piece overhead
  // negligible relative to the teaching-piece generation it gates.
  continuationClassifier: "claude-haiku-4-5-20251001",
  // One-shot ranking call — score each teaching-target candidate
  // against the user's focus statement. Same shape as adjacent
  // scoring (short JSON, structured output), so Haiku is the right
  // default tier.
  focusScoring: "claude-haiku-4-5-20251001",
};

/**
 * Catalog lookups.
 *
 * `lookupCatalog(provider, providerModel)` is the path used by cost
 * estimation when we have a `ModelSpec` in hand. `lookupCatalogById(id)`
 * is the path used when only the override id is known (e.g. resolving
 * a user's saved preference into a full `ModelSpec`).
 */
export function lookupCatalog(provider: ProviderId, providerModel: string): ModelEntry | null {
  return AVAILABLE_MODELS.find((m) => m.provider === provider && m.providerModel === providerModel) ?? null;
}

export function lookupCatalogById(id: string): ModelEntry | null {
  return AVAILABLE_MODELS.find((m) => m.id === id) ?? null;
}

/**
 * Resolve a per-operation override into a full `ModelSpec`.
 *
 * The override slot lives at `signalSurfaceMap.models.<operation>` and may
 * contain either a string (legacy: just the catalog id) or a structured
 * spec (forward-compat: includes provider + reasoning). The legacy string
 * form is normalized into a spec by catalog lookup.
 *
 * Falls back to the per-operation default catalog entry when the override
 * is missing, invalid, or refers to an unknown id. This keeps the
 * pipeline running even if a user's stored preference points at a model
 * that's been retired from the catalog.
 */
export function resolveModel(
  signalSurfaceMap: Record<string, unknown> | null | undefined,
  operation: ModelOperation,
): ModelSpec {
  const models = (signalSurfaceMap?.models ?? {}) as Record<string, unknown>;
  const raw = models[operation];

  // Forward-compat: structured spec stored directly. Validate against the
  // catalog so a missing entry falls back to the default cleanly.
  if (raw && typeof raw === "object" && "provider" in raw && "model" in raw) {
    const spec = raw as Partial<ModelSpec> & { provider: ProviderId; model: string };
    const entry = lookupCatalog(spec.provider, spec.model);
    if (entry) {
      return {
        provider: entry.provider,
        model: entry.providerModel,
        ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
        ...(typeof spec.maxTokens === "number" ? { maxTokens: spec.maxTokens } : {}),
        ...(typeof spec.temperature === "number" ? { temperature: spec.temperature } : {}),
      };
    }
  }

  // Legacy form: stored as a bare model id string. Look it up in the
  // catalog to find the provider; fall through to default if not found.
  if (typeof raw === "string") {
    const entry = lookupCatalogById(raw);
    if (entry) return { provider: entry.provider, model: entry.providerModel };
  }

  const fallback = lookupCatalogById(DEFAULT_MODELS[operation]);
  if (!fallback) {
    // Catalog was misconfigured. Return the literal default id so callers
    // at least produce a coherent error from the provider rather than a
    // null-deref here.
    return { provider: "anthropic", model: DEFAULT_MODELS[operation] };
  }
  return { provider: fallback.provider, model: fallback.providerModel };
}

/**
 * Validate a catalog id (or a structured spec). Used by the regenerate-
 * with-different-model route to reject bogus overrides before hitting
 * the LLM.
 */
export function isValidModel(id: string): boolean {
  return AVAILABLE_MODELS.some((m) => m.id === id);
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "Claude";
  const match = AVAILABLE_MODELS.find((m) => m.id === id || m.providerModel === id);
  return match?.label ?? id;
}

/**
 * Tier lookup that works across providers — used by the analytics
 * waterfall in place of the old "haiku/sonnet/opus" substring sniff.
 */
export function tierOf(id: string | null | undefined): ModelTier | "unknown" {
  if (!id) return "unknown";
  const match = AVAILABLE_MODELS.find((m) => m.id === id || m.providerModel === id);
  return match?.tier ?? "unknown";
}
