/**
 * Anthropic adapter for the provider-agnostic `LLMClient` interface.
 *
 * Translates `ModelSpec` -> Anthropic Messages API request, and Anthropic
 * response/usage shapes -> normalized vocabulary. The wire-format logic
 * (HTTP, retries, timeouts, SSE parsing) is the same as the original
 * `AnthropicClient` — only the in/out type contract changed.
 */

import {
  ANTHROPIC_REQUEST_TIMEOUT_MS,
  isRetryableStatus,
  parseRetryAfter,
  RETRY_CONFIG,
  retryDelay,
} from "../../config/constants.js";
import type {
  ContentBlock,
  CreateMessageOptions,
  GenerateJsonOptions,
  GenerateJsonResult,
  LLMClient,
  NormalizedMessageResponse,
  NormalizedUsage,
  StopReason,
  StreamEvent,
  WebSearchResult,
} from "./types.js";

interface AnthropicWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Citation block emitted by Anthropic's hosted `web_search_20250305`
 * tool. We don't render these inline as content — writers consume
 * them via `webSearchResults` on the normalized response and attach
 * them to the piece's resource list. Shape verified against the
 * public tool-use docs as of 2026-05.
 */
interface AnthropicWebSearchResult {
  type: "web_search_tool_result";
  content?: Array<{ type: "web_search_result"; url: string; title?: string; encrypted_content?: string }>;
}

interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | AnthropicWebSearchResult
  >;
  stop_reason: StopReason;
  usage: AnthropicWireUsage;
}

function buildRequestBody(opts: CreateMessageOptions, stream: boolean): Record<string, unknown> {
  const { spec } = opts;
  const body: Record<string, unknown> = {
    model: spec.model,
    max_tokens: opts.maxTokens ?? spec.maxTokens ?? 4096,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (opts.system) body.system = opts.system;
  // Merge regular tools + server tools into Anthropic's `tools` array.
  // Server tools (`web_search_20250305`) use a `type` discriminator
  // instead of `input_schema`; we don't dispatch on their results — the
  // provider runs them and surfaces citations inline.
  const tools: Array<Record<string, unknown>> = [];
  if (opts.tools) {
    for (const t of opts.tools) tools.push({ ...t });
  }
  if (opts.serverTools) {
    for (const st of opts.serverTools) {
      if (st.kind === "web_search") {
        const entry: Record<string, unknown> = {
          type: "web_search_20250305",
          name: "web_search",
        };
        if (typeof st.maxUses === "number") entry.max_uses = st.maxUses;
        tools.push(entry);
      }
    }
  }
  if (tools.length > 0) body.tools = tools;
  if (typeof spec.temperature === "number") body.temperature = spec.temperature;
  // Anthropic extended thinking config — only attach when the caller
  // asked for it so non-reasoning calls stay fast.
  if (typeof spec.reasoning?.budgetTokens === "number") {
    body.thinking = { type: "enabled", budget_tokens: spec.reasoning.budgetTokens };
  }
  if (stream) body.stream = true;
  return body;
}

function extractWebSearchResults(blocks: AnthropicMessageResponse["content"]): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  for (const b of blocks) {
    if (b.type !== "web_search_tool_result" || !b.content) continue;
    for (const r of b.content) {
      if (r.type === "web_search_result" && r.url) {
        out.push({ url: r.url, title: r.title ?? r.url, snippet: undefined });
      }
    }
  }
  return out;
}

function normalizeUsage(usage: AnthropicWireUsage): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  };
}

function normalizeContent(blocks: AnthropicMessageResponse["content"]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) {
    if (b.type === "tool_use") {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    } else if (b.type === "text") {
      out.push({ type: "text", text: b.text });
    }
    // `web_search_tool_result` blocks are surfaced separately via
    // `webSearchResults` on the normalized response — they're not
    // chat content the caller should iterate over.
  }
  return out;
}

export class AnthropicAdapter implements LLMClient {
  private apiKey: string;
  private baseUrl = "https://api.anthropic.com/v1";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createMessage(opts: CreateMessageOptions): Promise<NormalizedMessageResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ANTHROPIC_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${this.baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
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
          throw new Error(`Anthropic API ${res.status}: ${text}`);
        }

        const json = (await res.json()) as AnthropicMessageResponse;
        const webSearchResults = extractWebSearchResults(json.content);
        return {
          id: json.id,
          model: json.model,
          content: normalizeContent(json.content),
          stopReason: json.stop_reason,
          usage: normalizeUsage(json.usage),
          ...(webSearchResults.length > 0 ? { webSearchResults } : {}),
        };
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError") {
          lastError = new Error(`Anthropic API timeout after ${ANTHROPIC_REQUEST_TIMEOUT_MS / 1000}s`);
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

  async *streamMessage(opts: CreateMessageOptions): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANTHROPIC_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(buildRequestBody(opts, true)),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${text}`);
      }

      if (!res.body) throw new Error("No response body for streaming");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json || json === "[DONE]") continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(json);
          } catch {
            continue;
          }

          const eventType = parsed.type as string;

          if (eventType === "message_start") {
            const msg = parsed.message as Record<string, unknown>;
            const usage = msg?.usage as AnthropicWireUsage | undefined;
            yield { type: "message_start", usage: usage ? normalizeUsage(usage) : undefined };
          } else if (eventType === "content_block_start") {
            const block = parsed.content_block as Record<string, unknown>;
            if (block?.type === "tool_use") {
              yield {
                type: "tool_use_start",
                toolUseId: block.id as string,
                toolName: block.name as string,
              };
            }
          } else if (eventType === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            if (delta?.type === "text_delta") {
              yield { type: "text_delta", text: delta.text as string };
            } else if (delta?.type === "input_json_delta") {
              yield { type: "tool_input_delta", partialJson: delta.partial_json as string };
            }
          } else if (eventType === "content_block_stop") {
            yield { type: "content_block_stop" };
          } else if (eventType === "message_delta") {
            const delta = parsed.delta as Record<string, unknown>;
            const usage = parsed.usage as AnthropicWireUsage | undefined;
            yield {
              type: "message_delta",
              stopReason: delta?.stop_reason as StopReason | undefined,
              usage: usage ? normalizeUsage(usage) : undefined,
            };
          } else if (eventType === "message_stop") {
            yield { type: "done" };
          }
        }
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        yield { type: "error", text: `Timeout after ${ANTHROPIC_REQUEST_TIMEOUT_MS / 1000}s` };
      } else {
        yield { type: "error", text: error.message };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async generateJson<T>({
    spec,
    system,
    user,
    maxTokens = 8192,
    serverTools,
  }: GenerateJsonOptions): Promise<GenerateJsonResult<T>> {
    const response = await this.createMessage({
      spec,
      maxTokens,
      system: system + "\n\nRespond with valid JSON only. No markdown fences.",
      messages: [{ role: "user", content: user }],
      ...(serverTools ? { serverTools } : {}),
    });

    const firstText = response.content.find((b): b is ContentBlock & { type: "text" } => b.type === "text");
    const text = firstText?.text ?? "{}";
    try {
      const result = parseClaudeJson<T>(text);
      return {
        result,
        usage: response.usage,
        ...(response.webSearchResults ? { webSearchResults: response.webSearchResults } : {}),
      };
    } catch (err) {
      console.error(
        "[anthropic] JSON parse failed, response length:",
        text.length,
        "stop_reason:",
        response.stopReason,
      );
      if (response.stopReason === "max_tokens") {
        throw new Error(`Claude response truncated at ${text.length} chars — max_tokens too low`);
      }
      throw new Error(`Invalid JSON from Claude: ${(err as Error).message} — preview: ${text.slice(0, 200)}...`);
    }
  }
}

/**
 * Robust JSON extraction from Claude responses.
 *
 * Claude (especially Haiku) often ignores "no markdown fences" instructions
 * and wraps output in ```json ... ``` blocks, prefixes with prose like
 * "Here's the JSON:", or appends explanations. We try parsing strategies in
 * order from strict to lenient:
 *   1. Direct JSON.parse on the full text
 *   2. Strip a fenced code block wrapper (```json ... ```)
 *   3. Slice from the first { to the matching final } (or [ to ])
 *
 * Exported for testing.
 */
export function parseClaudeJson<T>(raw: string): T {
  const trimmed = raw.trim();

  // Strategy 1: direct parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  // Strategy 2: strip code fence wrapper
  const fenced = stripCodeFence(trimmed);
  if (fenced !== trimmed) {
    try {
      return JSON.parse(fenced) as T;
    } catch {
      // fall through
    }
  }

  // Strategy 3: extract the largest JSON object/array substring. Some
  // responses include leading prose ("Here's the JSON:") or trailing
  // commentary; locate the outermost braces.
  const sliced = sliceOutermostJson(fenced);
  if (sliced) {
    return JSON.parse(sliced) as T;
  }

  // Last resort: throw with the original text so the caller can log it.
  return JSON.parse(trimmed) as T;
}

function stripCodeFence(text: string): string {
  // Match ```json ... ``` or ``` ... ``` (with optional language tag),
  // handling both single-line and multi-line forms.
  const match = text.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (match) return match[1].trim();

  // If only a leading fence is present (e.g. truncated output), strip it
  // and any trailing fence we can find.
  if (text.startsWith("```")) {
    return text
      .replace(/^```(?:json|JSON)?\s*\n?/, "")
      .replace(/\n?\s*```\s*$/, "")
      .trim();
  }
  return text;
}

function sliceOutermostJson(text: string): string | null {
  // Find the first JSON-looking opener and the matching closer. We don't
  // do full bracket matching (overkill); we trust structured output ends
  // with } or ] and slice from the first opener to the last closer.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  let start = -1;
  let openChar = "";
  if (firstObj === -1 && firstArr === -1) return null;
  if (firstObj === -1) {
    start = firstArr;
    openChar = "[";
  } else if (firstArr === -1) {
    start = firstObj;
    openChar = "{";
  } else {
    start = Math.min(firstObj, firstArr);
    openChar = start === firstObj ? "{" : "[";
  }
  const closeChar = openChar === "{" ? "}" : "]";
  const end = text.lastIndexOf(closeChar);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}
