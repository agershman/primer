/**
 * Web-search server-tool helpers.
 *
 * The actual translation from our normalized `ServerToolSpec` to each
 * provider's hosted tool format lives in the LLM adapters
 * (`anthropic-adapter.ts`, `openai-adapter.ts`). This module is the
 * thin seam consumers (today: the piece-auditor) call to decide
 * *whether* to invoke web search at all, and to parse the citations
 * back out of the normalized response.
 *
 * Why a separate file: keeping `supportsWebSearch` and the normalized
 * citation parser away from the adapters means we can extend support
 * to non-LLM-hosted providers (Tavily, Brave, Perplexity) by adding
 * a new branch here rather than touching every adapter.
 */

import type { LLMClient, ModelSpec, NormalizedMessageResponse, WebSearchResult } from "./llm/types.js";

/**
 * Does the given model support hosted web search through the LLM
 * adapter today?
 *
 * Anthropic models all support `web_search_20250305` natively
 * through the Messages API. OpenAI's hosted `web_search` tool is
 * available through the Responses API, which our chat-completions
 * adapter does NOT call — so for now we return false for OpenAI and
 * the auditor's backstop skips the web-search step rather than firing
 * a no-op tool call. When the OpenAI adapter is extended to the
 * Responses API (or a future search-capable chat-completions model
 * lands), flip the predicate.
 *
 * The auditor must still be correct when this returns false: every
 * unverified claim falls straight through to the patch step, which
 * defaults to "drop" when the source bundle doesn't support the
 * claim. So a missing backstop reduces quality but never produces
 * incorrect output.
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

/**
 * Convenience wrapper — ask the LLM whether a claim is supported by
 * public sources via the hosted web_search tool. Returns the
 * normalized citations + the assistant's verdict text. The auditor
 * decides whether to upgrade the claim's verdict based on whether
 * any citations came back.
 *
 * Bounded to 2 tool uses per call so a worst-case claim doesn't burn
 * an entire conversation budget exploring the web. The auditor's
 * total search count is further capped by only invoking this on
 * un-cited flagged claims.
 */
export async function checkClaimWithWebSearch(
  llm: LLMClient,
  spec: ModelSpec,
  claim: string,
  context: string,
): Promise<{ citations: WebSearchResult[]; verdictText: string; usage: NormalizedMessageResponse["usage"] }> {
  const response = await llm.createMessage({
    spec,
    serverTools: [{ kind: "web_search", maxUses: 2 }],
    system:
      "You verify factual claims against trustworthy public sources (official docs, RFCs, papers, vendor changelogs, well-known engineering blogs). " +
      "Use the web_search tool only when you need external evidence. " +
      'Respond with the single word "SUPPORTED" or "NOT_SUPPORTED" followed by one short sentence of justification. ' +
      "Do not invent URLs. If the tool returns nothing relevant, answer NOT_SUPPORTED.",
    messages: [
      {
        role: "user",
        content: `Claim: "${claim}"\n\nSurrounding context (for disambiguation only — do NOT rely on it for verification):\n${context}\n\nIs this claim supported?`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return {
    citations: parseWebEvidence(response),
    verdictText: text,
    usage: response.usage,
  };
}
