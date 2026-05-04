/**
 * LLM dispatcher.
 *
 * Service-layer code calls `llmClient(env)` and gets back an object that
 * implements `LLMClient`. The dispatcher routes each request to the right
 * per-provider adapter based on `spec.provider`, instantiating adapters
 * lazily and only when their env key is configured.
 *
 * The registry pattern mirrors `integrations/tts/dispatcher.ts`: each
 * supported provider is one entry below — `provider` id, an
 * `isConfigured(env)` predicate, and a `build(env)` factory. Adding a new
 * provider (OpenAI, Google, Workers AI, OpenRouter) is one entry plus
 * one adapter file. Service code, the `/api/models` route, and the
 * settings UI all read from the same source of truth via
 * `isProviderConfigured` / `getConfiguredProviders`.
 *
 * Adding a new provider? Read `.cursor/skills/add-llm-adapter/SKILL.md`
 * BEFORE writing the adapter — it documents the registry shape, the
 * `LLMClient` contract, the model-id naming convention, the cost-ledger
 * normalization, and the test pinning. Diverging silently from the
 * pattern breaks the `/api/models` filter, the model picker grouping,
 * and the analytics waterfall — none of which fail in obvious ways
 * if you forget a step.
 *
 * @see .cursor/skills/add-llm-adapter/SKILL.md — task playbook
 * @see .cursor/rules/llm-integrations.mdc — auto-surfaces when editing this folder
 * @see dev-docs/architecture.md — the three-registry pattern in context
 */

import type { Env } from "../../types.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { OpenAIAdapter } from "./openai-adapter.js";
import type {
  CreateMessageOptions,
  GenerateJsonOptions,
  LLMClient,
  ModelSpec,
  NormalizedMessageResponse,
  NormalizedUsage,
  ProviderId,
  StreamEvent,
} from "./types.js";

/**
 * Per-provider registration. Adding a provider is one entry here plus
 * a new adapter file under `integrations/llm/`. The `build` factory is
 * only ever called when `isConfigured(env)` returns true, so adapters
 * can assume their required env keys exist by the time their
 * constructor runs.
 */
interface LLMAdapterRegistration {
  provider: ProviderId;
  isConfigured: (env: Env) => boolean;
  build: (env: Env) => LLMClient;
}

const LLM_ADAPTERS: readonly LLMAdapterRegistration[] = [
  {
    provider: "anthropic",
    isConfigured: (env) => !!env.ANTHROPIC_API_KEY,
    build: (env) => new AnthropicAdapter(env.ANTHROPIC_API_KEY),
  },
  {
    provider: "openai",
    isConfigured: (env) => !!env.OPENAI_API_KEY,
    // The non-null assertion is safe because `build` is only called
    // after `isConfigured` returns true.
    build: (env) => new OpenAIAdapter(env.OPENAI_API_KEY ?? ""),
  },
  // Future: google, workers-ai, openrouter — drop in one entry per
  // adapter and the rest of the system (catalog gating, /api/models
  // filtering, settings picker) picks it up automatically.
];

const ADAPTER_BY_PROVIDER = new Map(LLM_ADAPTERS.map((a) => [a.provider, a]));

class DispatchingLLMClient implements LLMClient {
  private cached = new Map<ProviderId, LLMClient>();

  constructor(private env: Env) {}

  private adapterFor(spec: ModelSpec): LLMClient {
    const cached = this.cached.get(spec.provider);
    if (cached) return cached;

    const reg = ADAPTER_BY_PROVIDER.get(spec.provider);
    if (!reg) {
      throw new Error(`LLM provider not yet supported: ${spec.provider}`);
    }
    if (!reg.isConfigured(this.env)) {
      // Throw a provider-specific message — easier to act on than
      // a generic "provider not configured". Mirrors how the
      // pre-registry code surfaced ANTHROPIC_API_KEY missing.
      throw new Error(`${spec.provider.toUpperCase()} API key not configured`);
    }

    const client = reg.build(this.env);
    this.cached.set(spec.provider, client);
    return client;
  }

  async createMessage(opts: CreateMessageOptions): Promise<NormalizedMessageResponse> {
    return this.adapterFor(opts.spec).createMessage(opts);
  }

  async *streamMessage(opts: CreateMessageOptions): AsyncGenerator<StreamEvent> {
    const adapter = this.adapterFor(opts.spec);
    yield* adapter.streamMessage(opts);
  }

  async generateJson<T>(opts: GenerateJsonOptions): Promise<{ result: T; usage: NormalizedUsage }> {
    return this.adapterFor(opts.spec).generateJson<T>(opts);
  }
}

/**
 * Build an LLM client for this Worker request. The result implements
 * `LLMClient` and dispatches each call to the right provider adapter
 * based on the `spec.provider` field of each request.
 */
export function llmClient(env: Env): LLMClient {
  return new DispatchingLLMClient(env);
}

/**
 * Predicate the `/api/models` route and the settings picker use to
 * decide whether a provider's models should appear in the UI. Returns
 * true only when (a) an adapter is registered for the provider AND
 * (b) the adapter's required env keys are present. Mirrors
 * `isProviderConfigured` in the TTS dispatcher.
 */
export function isProviderConfigured(provider: string, env: Env): boolean {
  const reg = ADAPTER_BY_PROVIDER.get(provider as ProviderId);
  if (!reg) return false;
  return reg.isConfigured(env);
}

/**
 * Convenience: list of provider ids whose adapters are registered AND
 * whose env keys are set. Stable order matches the registration order
 * above so the settings UI's optgroup ordering is deterministic.
 */
export function getConfiguredProviders(env: Env): ProviderId[] {
  return LLM_ADAPTERS.filter((a) => a.isConfigured(env)).map((a) => a.provider);
}
