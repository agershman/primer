/**
 * Provider-agnostic LLM types.
 *
 * Every adapter (`AnthropicAdapter`, future `OpenAIAdapter`, etc.) speaks
 * this normalized vocabulary. Service-layer code never reaches into a
 * provider's wire format directly — it constructs a `ModelSpec` (provider +
 * model + reasoning), calls the dispatcher, and consumes `NormalizedUsage`.
 *
 * The shapes mirror Anthropic's today since it's the only adapter wired
 * up — but they live here, in the adapter layer, rather than leaking the
 * provider's vocabulary into every service file.
 */

export type ProviderId = "anthropic" | "openai" | "google" | "workers-ai" | "openrouter";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Resolved per-operation model selection. The catalog (`AVAILABLE_MODELS`)
 * is the source of truth for valid (provider, model) pairs, so a `ModelSpec`
 * is what `resolveModel()` produces from a user override (or the default).
 */
export interface ModelSpec {
  provider: ProviderId;
  /** Provider-native model id (e.g. `claude-sonnet-4-20250514`, `gpt-5`). */
  model: string;
  /** Optional reasoning configuration. Adapters ignore fields that don't
   *  apply to the underlying provider (e.g. OpenAI consumes `effort`,
   *  Anthropic consumes `budgetTokens`). */
  reasoning?: {
    effort?: ReasoningEffort;
    budgetTokens?: number;
  };
  maxTokens?: number;
  temperature?: number;
}

/**
 * Normalized usage shape across providers.
 *
 * - `inputTokens` / `outputTokens` — always present.
 * - `reasoningTokens` — billed-as-output reasoning tokens (OpenAI o-series,
 *   Anthropic extended thinking, Gemini thoughts).
 * - `cacheReadTokens` / `cacheWriteTokens` — Anthropic prompt caching;
 *   OpenAI cached input maps to `cacheReadTokens`.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  /** Either plain text (legacy shape) or a normalized content-block list
   *  (carries tool-use / tool-result blocks for the chat tool loop). */
  content: string | ContentBlock[];
}

/**
 * Normalized content blocks. The text + tool-use shapes mirror Anthropic's
 * format because Anthropic is currently the only provider — but the names
 * and key paths are stable enough that an OpenAI adapter can translate
 * `tool_calls` <-> `ToolUseBlock` and `tool` role messages <-> `ToolResultBlock`.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema for the tool input. Provider adapters translate this to
   *  the provider's native tool definition format. */
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;

export interface NormalizedMessageResponse {
  id: string;
  /** Resolved model id from the provider (may differ from `spec.model` if
   *  the provider routed the request — e.g. OpenRouter). */
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: NormalizedUsage;
}

/**
 * Streaming event vocabulary. Mirrors Anthropic's SSE event taxonomy
 * since that's the only adapter wired up; future adapters re-emit this
 * shape from their native streams.
 */
export interface StreamEvent {
  type:
    | "text_delta"
    | "tool_use_start"
    | "tool_input_delta"
    | "message_start"
    | "message_delta"
    | "content_block_stop"
    | "done"
    | "error";
  text?: string;
  toolUseId?: string;
  toolName?: string;
  partialJson?: string;
  stopReason?: StopReason;
  usage?: NormalizedUsage;
}

export interface CreateMessageOptions {
  spec: ModelSpec;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Override `spec.maxTokens`. Some callers prefer to keep `spec` fixed
   *  per use-case and pass tokens per-call. */
  maxTokens?: number;
}

export interface GenerateJsonOptions {
  spec: ModelSpec;
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Provider-agnostic LLM client. Service-layer code depends on this
 * interface, not on `AnthropicClient`. The dispatcher in
 * `integrations/llm/dispatcher.ts` returns one of these per request.
 */
export interface LLMClient {
  createMessage(opts: CreateMessageOptions): Promise<NormalizedMessageResponse>;
  streamMessage(opts: CreateMessageOptions): AsyncGenerator<StreamEvent>;
  generateJson<T>(opts: GenerateJsonOptions): Promise<{ result: T; usage: NormalizedUsage }>;
}
