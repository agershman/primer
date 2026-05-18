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

/**
 * Server-tool requests are provider-hosted tools that run inside the
 * provider's stack (no round trip back to us between the model call
 * and the tool execution). `web_search` is the only kind supported
 * today — Anthropic's `web_search_20250305` and OpenAI's hosted
 * Responses-API `web_search` both translate from this normalized
 * spec at the adapter layer.
 *
 * Distinct from regular `ToolDef` because server tools are NOT
 * callable from the host — we don't supply an `input_schema` or
 * receive `tool_use` blocks to dispatch on. The provider runs them
 * transparently and surfaces results inline in the assistant message.
 */
export type ServerToolSpec = { kind: "web_search"; maxUses?: number };

/**
 * Normalized result of a hosted web_search call. Both providers
 * surface citations inline in the assistant response; the adapter
 * extracts them into this shape so callers (today: the teaching
 * piece + deep dive writers) don't need to know which provider
 * answered.
 */
export interface WebSearchResult {
  url: string;
  title: string;
  snippet?: string;
}

export interface NormalizedMessageResponse {
  id: string;
  /** Resolved model id from the provider (may differ from `spec.model` if
   *  the provider routed the request — e.g. OpenRouter). */
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: NormalizedUsage;
  /** Web-search citations the provider gathered while answering, when
   *  `serverTools` included `web_search`. Empty array when no server
   *  tools were requested, when the model didn't invoke them, or when
   *  the provider returned no citations. */
  webSearchResults?: WebSearchResult[];
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
  /** Provider-hosted server tools (e.g. `web_search`). Distinct from
   *  `tools` — adapters translate this to the provider's native
   *  hosted-tool format and we don't dispatch on the returned blocks;
   *  the provider runs them transparently. See `ServerToolSpec`. */
  serverTools?: ServerToolSpec[];
  /** Override `spec.maxTokens`. Some callers prefer to keep `spec` fixed
   *  per use-case and pass tokens per-call. */
  maxTokens?: number;
}

export interface GenerateJsonOptions {
  spec: ModelSpec;
  system: string;
  user: string;
  maxTokens?: number;
  /** Provider-hosted server tools (e.g. `web_search`) the model can
   *  invoke while drafting the JSON response. Citations come back via
   *  `webSearchResults` on the return value. Adapters that don't
   *  support the requested tools (e.g. the OpenAI chat-completions
   *  adapter for web_search) silently ignore them — callers should
   *  gate on `supportsWebSearch(spec)` before relying on the result. */
  serverTools?: ServerToolSpec[];
}

export interface GenerateJsonResult<T> {
  result: T;
  usage: NormalizedUsage;
  /** Web-search citations the provider gathered while drafting, when
   *  `serverTools` included `web_search` and the model invoked it.
   *  Undefined when no server tools were requested or none ran. */
  webSearchResults?: WebSearchResult[];
}

/**
 * Provider-agnostic LLM client. Service-layer code depends on this
 * interface, not on `AnthropicClient`. The dispatcher in
 * `integrations/llm/dispatcher.ts` returns one of these per request.
 */
export interface LLMClient {
  createMessage(opts: CreateMessageOptions): Promise<NormalizedMessageResponse>;
  streamMessage(opts: CreateMessageOptions): AsyncGenerator<StreamEvent>;
  generateJson<T>(opts: GenerateJsonOptions): Promise<GenerateJsonResult<T>>;
}
