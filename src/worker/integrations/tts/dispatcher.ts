/**
 * TTS dispatcher.
 *
 * Service-layer code (`generateTtsResponse` in `services/tts.ts`)
 * resolves a `TtsModel` from the catalog and asks the dispatcher for
 * the right adapter. Adding a new provider is a one-line addition
 * here plus a new adapter file.
 *
 * Mirrors the LLM dispatcher pattern — same shape, same call site
 * pattern, same registration model.
 *
 * Adding a new provider? Read `.cursor/skills/add-tts-adapter/SKILL.md`
 * BEFORE writing the adapter — it documents the `TtsAdapter` contract,
 * the `TTS_MODELS` catalog format, the per-operation voice-picker
 * integration, and the cost-ledger character counting. The
 * Settings → Voice panel filters by `isProviderConfigured(...)` from
 * this file, so missing the registry entry means the new voices
 * silently never appear in the UI.
 *
 * @see .cursor/skills/add-tts-adapter/SKILL.md — task playbook
 * @see .cursor/rules/tts-integrations.mdc — auto-surfaces when editing this folder
 * @see dev-docs/architecture.md — the three-registry pattern in context
 */

import type { TtsModel } from "../../config/constants.js";
import type { Env } from "../../types.js";
import { CloudflareTtsAdapter } from "./cloudflare-adapter.js";
import { ElevenLabsTtsAdapter } from "./elevenlabs-adapter.js";
import { OpenAITtsAdapter } from "./openai-adapter.js";
import type { TtsAdapter } from "./types.js";

let registry: Map<string, TtsAdapter> | null = null;

function buildRegistry(): Map<string, TtsAdapter> {
  const r = new Map<string, TtsAdapter>();
  const adapters = [new CloudflareTtsAdapter(), new OpenAITtsAdapter(), new ElevenLabsTtsAdapter()];
  for (const a of adapters) r.set(a.provider, a);
  return r;
}

/**
 * Resolve the right `TtsAdapter` for a given catalog model. Throws
 * with a clear message when no adapter is registered for the
 * provider — this only happens during development if a catalog entry
 * declares a provider before its adapter exists.
 */
export function ttsAdapterFor(model: TtsModel): TtsAdapter {
  if (!registry) registry = buildRegistry();
  const adapter = registry.get(model.provider);
  if (!adapter) {
    throw new Error(`No TTS adapter registered for provider: ${model.provider}`);
  }
  return adapter;
}

/**
 * Predicate the `/api/health` and Voice picker use to filter out
 * voices for providers whose API keys aren't set. Cloudflare is always
 * configured (uses the AI binding); paid providers require their
 * `*_API_KEY` env.
 */
export function isProviderConfigured(provider: string, env: Env): boolean {
  if (!registry) registry = buildRegistry();
  const adapter = registry.get(provider);
  if (!adapter) return false;
  return adapter.isConfigured(env);
}
