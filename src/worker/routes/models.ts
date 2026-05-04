import { Hono } from "hono";
import { DEFAULT_TTS_MODEL, TTS_MODELS } from "../config/constants.js";
import { AVAILABLE_MODELS, DEFAULT_MODELS } from "../config/models.js";
import { isProviderConfigured as isLlmProviderConfigured } from "../integrations/llm/dispatcher.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const modelsRoutes = new Hono<AppEnv>();

modelsRoutes.get("/models", (c) => {
  // Filter to providers whose adapter is registered AND whose env key
  // is present — same gating philosophy as `/tts-models`. Saved
  // overrides that point at filtered-out models still resolve at the
  // catalog level (so existing settings don't break), but they no
  // longer surface in the picker. Adding a new provider's models to
  // the picker is one new entry in the LLM dispatcher's registry +
  // catalog entries; the route requires no further changes.
  const available = AVAILABLE_MODELS.filter((m) => isLlmProviderConfigured(m.provider, c.env));
  return c.json({
    models: available.map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      description: m.description,
      provider: m.provider,
      reasoning: m.reasoning,
      supportsTools: m.supportsTools,
      contextWindow: m.contextWindow,
      pricing: {
        inputPer1M: m.pricing.inputPer1M,
        outputPer1M: m.pricing.outputPer1M,
      },
    })),
    defaults: DEFAULT_MODELS,
  });
});

modelsRoutes.get("/tts-models", (c) => {
  // Filter out paid-tier providers whose API keys aren't configured.
  // Cloudflare uses the AI binding (always present) so its voices are
  // always listed.
  const available = TTS_MODELS.filter((m) => {
    if (m.provider === "openai") return !!c.env.OPENAI_API_KEY;
    if (m.provider === "elevenlabs") return !!c.env.ELEVENLABS_API_KEY;
    return true;
  });
  return c.json({
    models: available.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      tier: m.tier,
      description: m.description,
      costPer1kChars: m.costPer1kChars,
    })),
    default: DEFAULT_TTS_MODEL,
  });
});
