/**
 * Web-search server-tool helpers.
 *
 * The actual translation from our normalized `ServerToolSpec` to each
 * provider's hosted tool format lives in the LLM adapters
 * (`anthropic-adapter.ts`, `openai-adapter.ts`). This module is the
 * thin seam writers call to decide *whether* to attach the web_search
 * server tool at all, and to parse the citations back out of the
 * normalized response.
 *
 * Why a separate file: keeping `supportsWebSearch` and the normalized
 * citation parser away from the adapters means we can extend support
 * to non-LLM-hosted providers (Tavily, Brave, Perplexity) by adding
 * a new branch here rather than touching every adapter.
 */

import type { ModelSpec, NormalizedMessageResponse, WebSearchResult } from "./llm/types.js";

/**
 * Does the given model support hosted web search through the LLM
 * adapter today?
 *
 * Anthropic models all support `web_search_20250305` natively
 * through the Messages API. OpenAI's hosted `web_search` tool is
 * available through the Responses API, which our chat-completions
 * adapter does NOT call — so for now we return false for OpenAI and
 * writers skip attaching the server tool rather than firing a no-op
 * tool call. When the OpenAI adapter is extended to the Responses API
 * (or a future search-capable chat-completions model lands), flip the
 * predicate.
 *
 * Writers must still be correct when this returns false: the
 * grounding prompt instructs them to qualify or omit external claims
 * they can't verify, so a missing tool reduces piece quality but
 * never produces fabricated citations.
 */
export function supportsWebSearch(spec: ModelSpec): boolean {
  return spec.provider === "anthropic";
}

/**
 * Extract web-search citations from a normalized LLM response. The
 * adapter populates `response.webSearchResults` when the provider
 * surfaces citations; this helper is just a stable accessor so call
 * sites don't have to remember the field is optional.
 */
export function parseWebEvidence(response: NormalizedMessageResponse): WebSearchResult[] {
  return response.webSearchResults ?? [];
}

