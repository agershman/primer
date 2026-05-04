/**
 * OpenAI adapter for the provider-agnostic `LLMClient` interface.
 *
 * Translates `ModelSpec` -> OpenAI Chat Completions API request, and OpenAI
 * response/usage shapes -> normalized vocabulary. Mirrors the structure of
 * `AnthropicAdapter` so the dispatcher stays uniform — the public surface
 * is just `createMessage` / `streamMessage` / `generateJson`, all of which
 * speak the same `NormalizedMessageResponse` / `StreamEvent` / `NormalizedUsage`
 * vocabulary as every other adapter.
 *
 * Two OpenAI-specific shape mismatches the adapter has to bridge:
 *
 *   1. **Tool results live in their own message role**. Anthropic packs
 *      `tool_result` blocks inside a user-turn `content: ContentBlock[]`;
 *      OpenAI requires a separate `role: "tool"` message per result with
 *      a `tool_call_id`. We unfold during request build and re-fold on
 *      streaming responses so the rest of the system never has to know
 *      about the difference.
 *
 *   2. **`completion_tokens` includes reasoning tokens already**. To match
 *      our normalized convention (output / reasoning are sibling counts),
 *      we subtract `completion_tokens_details.reasoning_tokens` from the
 *      headline `completion_tokens` before reporting it as `outputTokens`.
 *      Cost math (`estimateLlmCost`) charges output rate on both buckets,
 *      so the dollar figure is identical either way; the split just gives
 *      analytics a separate "reasoning" line.
 */

import {
  isRetryableStatus,
  LLM_REQUEST_TIMEOUT_MS,
  parseRetryAfter,
  RETRY_CONFIG,
  retryDelay,
} from "../../config/constants.js";
import type {
  ChatMessage,
  ContentBlock,
  CreateMessageOptions,
  GenerateJsonOptions,
  LLMClient,
  NormalizedMessageResponse,
  NormalizedUsage,
  StopReason,
  StreamEvent,
  ToolDef,
} from "./types.js";

interface OpenAIWireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIWireUsage;
}

interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: OpenAIChoice["finish_reason"];
}

interface OpenAIStreamChunk {
  id: string;
  model?: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIWireUsage;
}

/**
 * Translate normalized `ChatMessage[]` into OpenAI's request-side
 * shape. `tool_result` blocks get unfolded into their own
 * `role: "tool"` messages because OpenAI's API rejects them when
 * embedded in a user message.
 */
function buildMessages(system: string | undefined, messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system) {
    out.push({ role: "system", content: system });
  }
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "user") {
      // User-turn content can mix `tool_result` blocks (which OpenAI
      // wants as separate `role: "tool"` messages) with `text` blocks
      // (which stay on a normal user message).
      const textParts: string[] = [];
      for (const block of m.content) {
        if (block.type === "tool_result") {
          // Each tool result becomes its own message — but flush any
          // accumulated text first so the API sees them in a stable
          // order relative to the user's commentary.
          if (textParts.length > 0) {
            out.push({ role: "user", content: textParts.join("\n") });
            textParts.length = 0;
          }
          out.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        } else if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("\n") });
      }
      continue;
    }

    // Assistant turn: split out tool_use blocks into `tool_calls` and
    // text blocks into `content`. OpenAI accepts both in the same
    // assistant message.
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    for (const block of m.content) {
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === "text") {
        textParts.push(block.text);
      }
    }
    const assistantMsg: Record<string, unknown> = { role: "assistant" };
    if (textParts.length > 0) assistantMsg.content = textParts.join("\n");
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    out.push(assistantMsg);
  }
  return out;
}

function buildTools(tools: ToolDef[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/**
 * Build the OpenAI request body. Reasoning models (o-series, gpt-5
 * with reasoning) take a `reasoning_effort` knob ("minimal" / "low" /
 * "medium" / "high") instead of the budget-tokens shape Anthropic
 * uses. Reasoning models also disallow `temperature`, so we drop it
 * when the spec asks for an effort level.
 */
function buildRequestBody(opts: CreateMessageOptions, stream: boolean): Record<string, unknown> {
  const { spec } = opts;
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: buildMessages(opts.system, opts.messages),
    // GPT-5 / o-series prefer `max_completion_tokens` over the
    // legacy `max_tokens`. The newer name is accepted by every
    // chat-completions model on the API today.
    max_completion_tokens: opts.maxTokens ?? spec.maxTokens ?? 4096,
  };

  const tools = buildTools(opts.tools);
  if (tools) body.tools = tools;

  const effort = spec.reasoning?.effort;
  if (effort) {
    body.reasoning_effort = effort;
    // Reasoning models reject custom temperature; let it default.
  } else if (typeof spec.temperature === "number") {
    body.temperature = spec.temperature;
  }

  if (stream) {
    body.stream = true;
    // Without this flag the final `[DONE]` event arrives without a
    // usage block, which means we couldn't report token counts on
    // streamed messages — and our analytics + budget cap depend on
    // every call recording usage.
    body.stream_options = { include_usage: true };
  }

  return body;
}

function normalizeUsage(usage: OpenAIWireUsage | undefined): NormalizedUsage {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  // OpenAI's `completion_tokens` already includes reasoning tokens.
  // Split them so analytics can show "reasoning" as its own line —
  // cost is identical either way (`estimateLlmCost` charges both at
  // output rate when no `reasoningPer1M` is configured).
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: Math.max(0, completion - reasoning),
    reasoningTokens: reasoning > 0 ? reasoning : undefined,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
    // OpenAI's prompt cache is automatic and doesn't bill writes
    // separately, so cacheWriteTokens stays undefined.
  };
}

const FINISH_TO_STOP: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
  // Content-filter stops are rare and don't really fit Anthropic's
  // four buckets; closest analogue is `stop_sequence` (a forced
  // stop the model didn't initiate).
  content_filter: "stop_sequence",
};

function mapFinishReason(reason: OpenAIChoice["finish_reason"]): StopReason {
  if (!reason) return null;
  return FINISH_TO_STOP[reason] ?? null;
}

function normalizeChoice(choice: OpenAIChoice): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (choice.message.content && choice.message.content.length > 0) {
    blocks.push({ type: "text", text: choice.message.content });
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      // Malformed tool args — surface the raw string so the caller
      // can decide what to do, rather than crashing the whole turn.
      input = { __raw: tc.function.arguments ?? "" };
    }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  return blocks;
}

export class OpenAIAdapter implements LLMClient {
  private apiKey: string;
  private baseUrl = "https://api.openai.com/v1";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createMessage(opts: CreateMessageOptions): Promise<NormalizedMessageResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(buildRequestBody(opts, false)),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1 && isRetryableStatus(res.status)) {
            const wait = retryDelay(attempt, parseRetryAfter(res));
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          const text = await res.text();
          throw new Error(`OpenAI API ${res.status}: ${text}`);
        }

        const json = (await res.json()) as OpenAIChatResponse;
        const choice = json.choices?.[0];
        if (!choice) {
          throw new Error("OpenAI API returned no choices");
        }
        return {
          id: json.id,
          model: json.model,
          content: normalizeChoice(choice),
          stopReason: mapFinishReason(choice.finish_reason),
          usage: normalizeUsage(json.usage),
        };
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError") {
          lastError = new Error(`OpenAI API timeout after ${LLM_REQUEST_TIMEOUT_MS / 1000}s`);
        } else {
          lastError = error;
        }
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /**
   * Streaming chat completions. OpenAI's stream is a sequence of
   * `data: <json>` SSE events, each with a `choices[0].delta` that
   * contains either text content or a tool-call delta. Tool calls
   * stream as a sequence: first chunk carries `id` + `function.name`,
   * subsequent chunks deliver `function.arguments` in pieces.
   *
   * We translate to the same `StreamEvent` vocabulary the Anthropic
   * adapter emits — the chat panel and any other streaming consumer
   * is provider-agnostic at the seam.
   */
  async *streamMessage(opts: CreateMessageOptions): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(opts, true)),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API ${res.status}: ${text}`);
      }

      if (!res.body) throw new Error("No response body for streaming");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Tool-call deltas arrive over multiple chunks; track which
      // tool indices we've already announced via `tool_use_start` so
      // we only emit it once per tool. The OpenAI stream uses the
      // numeric `delta.tool_calls[*].index` to associate continuation
      // chunks with their starting chunk.
      const announcedToolIndices = new Set<number>();
      let messageStarted = false;
      let pendingStop: StopReason | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          if (json === "[DONE]") {
            yield { type: "done" };
            return;
          }

          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(json) as OpenAIStreamChunk;
          } catch {
            continue;
          }

          if (!messageStarted) {
            yield { type: "message_start" };
            messageStarted = true;
          }

          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            yield { type: "text_delta", text: choice.delta.content };
          }

          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!announcedToolIndices.has(tc.index) && (tc.id || tc.function?.name)) {
                yield {
                  type: "tool_use_start",
                  toolUseId: tc.id ?? `call_${tc.index}`,
                  toolName: tc.function?.name ?? "",
                };
                announcedToolIndices.add(tc.index);
              }
              if (tc.function?.arguments) {
                yield { type: "tool_input_delta", partialJson: tc.function.arguments };
              }
            }
          }

          if (choice?.finish_reason) {
            pendingStop = mapFinishReason(choice.finish_reason);
            // Mirror Anthropic's emit pattern — emit a content_block_stop
            // before the message_delta so consumers that finalize blocks
            // on this event flush cleanly.
            yield { type: "content_block_stop" };
          }

          if (chunk.usage) {
            yield {
              type: "message_delta",
              stopReason: pendingStop,
              usage: normalizeUsage(chunk.usage),
            };
          }
        }
      }

      // If the stream ended without an explicit `[DONE]` marker, still
      // emit a terminal event so consumers can close cleanly.
      yield { type: "done" };
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        yield { type: "error", text: `Timeout after ${LLM_REQUEST_TIMEOUT_MS / 1000}s` };
      } else {
        yield { type: "error", text: error.message };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Structured-JSON shorthand. Uses OpenAI's native
   * `response_format: { type: "json_object" }` so the model is
   * constrained to emit a parseable JSON object — no need for the
   * lenient "strip markdown fences / slice outermost braces"
   * recovery the Anthropic path needs.
   */
  async generateJson<T>({
    spec,
    system,
    user,
    maxTokens = 8192,
  }: GenerateJsonOptions): Promise<{ result: T; usage: NormalizedUsage }> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: spec.model,
            messages: [
              {
                role: "system",
                content: `${system}\n\nRespond with valid JSON only.`,
              },
              { role: "user", content: user },
            ],
            max_completion_tokens: maxTokens,
            response_format: { type: "json_object" },
            ...(spec.reasoning?.effort
              ? { reasoning_effort: spec.reasoning.effort }
              : typeof spec.temperature === "number"
                ? { temperature: spec.temperature }
                : {}),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1 && isRetryableStatus(res.status)) {
            await new Promise((r) => setTimeout(r, retryDelay(attempt, parseRetryAfter(res))));
            continue;
          }
          const text = await res.text();
          throw new Error(`OpenAI API ${res.status}: ${text}`);
        }

        const json = (await res.json()) as OpenAIChatResponse;
        const text = json.choices?.[0]?.message?.content ?? "{}";
        try {
          const result = JSON.parse(text) as T;
          return { result, usage: normalizeUsage(json.usage) };
        } catch (err) {
          throw new Error(`Invalid JSON from OpenAI: ${(err as Error).message} — preview: ${text.slice(0, 200)}...`);
        }
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError") {
          lastError = new Error(`OpenAI API timeout after ${LLM_REQUEST_TIMEOUT_MS / 1000}s`);
        } else {
          lastError = error;
        }
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
