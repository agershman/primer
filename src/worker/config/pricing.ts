/**
 * LLM cost estimation.
 *
 * The single source of truth for per-token rates is the catalog entry on
 * each model in `config/models.ts` — `pricing.inputPer1M`, `outputPer1M`,
 * etc. That keeps every (provider, model) pair self-describing: adding a
 * model is one entry, and analytics + budget math automatically pick up
 * the new rate.
 *
 * Reasoning tokens (OpenAI o-series, Anthropic extended thinking, Gemini
 * thoughts) are billed at output rates by every provider, but we accept a
 * dedicated `reasoningPer1M` knob in case a future provider deviates.
 *
 * Cache reads are typically ~0.1× input rate; cache writes are typically
 * ~1.25× input rate. Both default to 0 when the catalog entry doesn't
 * specify, which is the safe fallback for any model that doesn't bill
 * separately for cache traffic.
 */

import type { ModelSpec, NormalizedUsage } from "../integrations/llm/types.js";
import { lookupCatalog } from "./models.js";

export function estimateLlmCost(spec: ModelSpec, usage: NormalizedUsage): number {
  const entry = lookupCatalog(spec.provider, spec.model);
  if (!entry) {
    // Unknown (provider, model) — return 0 rather than guessing a price.
    // Analytics will surface this as $0 for the row, which is a clear
    // signal to add the model to the catalog.
    return 0;
  }
  const p = entry.pricing;
  const inputCost = (usage.inputTokens * p.inputPer1M) / 1_000_000;
  const outputCost = (usage.outputTokens * p.outputPer1M) / 1_000_000;
  const reasoningCost = ((usage.reasoningTokens ?? 0) * (p.reasoningPer1M ?? p.outputPer1M)) / 1_000_000;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) * (p.cacheReadPer1M ?? 0)) / 1_000_000;
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) * (p.cacheWritePer1M ?? 0)) / 1_000_000;
  return inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost;
}
