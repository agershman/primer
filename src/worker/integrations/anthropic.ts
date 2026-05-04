/**
 * Backwards-compatibility shim.
 *
 * The provider-agnostic LLM client now lives at `integrations/llm/`.
 * This module re-exports a wrapper that preserves the legacy
 * `AnthropicClient` shape (`createMessage({ model, max_tokens, ... })`,
 * `streamMessage(...)`, `generateJson(...)`) so any external/legacy
 * imports keep compiling. New code should import from
 * `integrations/llm/` directly.
 */

import { AnthropicAdapter } from "./llm/anthropic-adapter.js";
import type { ContentBlock, CreateMessageOptions, ModelSpec, NormalizedUsage, StreamEvent } from "./llm/types.js";

interface LegacyMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  tools?: unknown[];
}

interface LegacyUsage {
  input_tokens: number;
  output_tokens: number;
}

interface LegacyMessageResponse {
  id: string;
  content: Array<
    { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  usage: LegacyUsage;
}

export interface LegacyStreamEvent {
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
  stopReason?: string;
  usage?: LegacyUsage;
}

function specFromModel(model: string): ModelSpec {
  return { provider: "anthropic", model };
}

function toCreateOpts(req: LegacyMessageRequest): CreateMessageOptions {
  return {
    spec: specFromModel(req.model),
    maxTokens: req.max_tokens,
    system: req.system,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content as string | ContentBlock[],
    })),
    tools: req.tools as CreateMessageOptions["tools"],
  };
}

function legacyUsage(usage: NormalizedUsage): LegacyUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
}

function toLegacyStreamEvent(event: StreamEvent): LegacyStreamEvent {
  return {
    type: event.type,
    text: event.text,
    toolUseId: event.toolUseId,
    toolName: event.toolName,
    partialJson: event.partialJson,
    stopReason: event.stopReason ?? undefined,
    usage: event.usage ? legacyUsage(event.usage) : undefined,
  };
}

/**
 * Legacy-shaped client retained for compatibility with un-migrated
 * callsites. New code should use `llmClient(env)` from
 * `integrations/llm/dispatcher.ts` instead.
 */
export class AnthropicClient {
  private adapter: AnthropicAdapter;

  constructor(apiKey: string) {
    this.adapter = new AnthropicAdapter(apiKey);
  }

  async createMessage(request: LegacyMessageRequest): Promise<LegacyMessageResponse> {
    const normalized = await this.adapter.createMessage(toCreateOpts(request));
    return {
      id: normalized.id,
      model: normalized.model,
      stop_reason: normalized.stopReason,
      usage: legacyUsage(normalized.usage),
      content: normalized.content
        .filter((b) => b.type === "text" || b.type === "tool_use")
        .map((b) => {
          if (b.type === "tool_use") {
            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
          }
          return { type: "text", text: (b as Extract<ContentBlock, { type: "text" }>).text };
        }),
    };
  }

  async *streamMessage(request: LegacyMessageRequest): AsyncGenerator<LegacyStreamEvent> {
    for await (const event of this.adapter.streamMessage(toCreateOpts(request))) {
      yield toLegacyStreamEvent(event);
    }
  }

  /**
   * Legacy `generateJson` — accepts (system, userMessage, model, maxTokens)
   * positional args and returns `{ result, usage: { input_tokens, output_tokens } }`.
   */
  async generateJson<T>(
    system: string,
    userMessage: string,
    model = "claude-sonnet-4-20250514",
    maxTokens = 8192,
  ): Promise<{ result: T; usage: LegacyUsage }> {
    const { result, usage } = await this.adapter.generateJson<T>({
      spec: specFromModel(model),
      system,
      user: userMessage,
      maxTokens,
    });
    return { result, usage: legacyUsage(usage) };
  }
}

// Re-export the JSON parser so existing tests can import it from the
// legacy path until the test file is migrated.
export { parseClaudeJson } from "./llm/anthropic-adapter.js";

// Re-export the streaming event type from the new types module so
// external imports of `StreamEvent` from this path keep working.
export type { StreamEvent };
