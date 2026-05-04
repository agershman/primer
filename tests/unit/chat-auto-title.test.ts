/**
 * Pins the auto-titling contract for chat threads.
 *
 * Modeled on Cursor / ChatGPT / Claude: a tight 3-6 word topical
 * summary instead of a verbatim slice of the user's first message.
 *
 * Flow on the very first exchange of a thread:
 *   1. Route writes a sentence-trimmed PLACEHOLDER to chat_threads.title
 *      so the sidebar / header read something useful while the LLM is
 *      working (no flash of "Untitled").
 *   2. respondToChat / createChatStream invokes generateChatTitle
 *      AFTER the assistant response is finalized. On success the row
 *      is updated and:
 *        - non-streaming: returned via the JSON `threadTitle` field.
 *        - streaming: emitted as an SSE `title` event after `done`.
 *   3. Frontend (`useChat`) listens for the `title` SSE event and
 *      patches both `currentThread` and the threads sidebar list so
 *      the rename is live without a manual refresh.
 *
 * On failure (timeout, empty/refusal output, weird length) the LLM
 * call returns null and the placeholder stays — a reasonable
 * degraded mode that's still better than "Untitled".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  generateChatTitle,
  placeholderChatTitle,
} from "../../src/worker/services/chat-responder.js";
import type {
  CreateMessageResponse,
  LLMClient,
} from "../../src/worker/integrations/llm/types.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

const stubSpec = { provider: "anthropic" as const, model: "claude-sonnet-4" };

function fakeClient(
  textOutput: string,
  inputTokens = 400,
  outputTokens = 12,
): LLMClient {
  return {
    createMessage: vi.fn(async (): Promise<CreateMessageResponse> => ({
      content: [{ type: "text", text: textOutput }],
      stopReason: "end_turn",
      usage: { inputTokens, outputTokens },
    })),
    streamMessage: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

describe("placeholderChatTitle", () => {
  it("trims whitespace and crops to ~50 chars with an ellipsis", () => {
    const long =
      "I would like to understand how Kubernetes pod-to-pod networking actually works under the hood";
    const out = placeholderChatTitle(long);
    expect(out.length).toBeLessThanOrEqual(52);
    expect(out.endsWith("…")).toBe(true);
    // The cut should preserve the leading content.
    expect(out.startsWith("I would like to understand")).toBe(true);
  });

  it("prefers a sentence boundary if one falls within the first ~50 chars", () => {
    const msg = "Quick question. Then a long second sentence that goes on and on for many words";
    expect(placeholderChatTitle(msg)).toBe("Quick question…");
  });

  it("returns the message verbatim when it's already short", () => {
    expect(placeholderChatTitle("Hello there")).toBe("Hello there");
  });

  it("falls back to 'New conversation' for an empty/whitespace message", () => {
    expect(placeholderChatTitle("")).toBe("New conversation");
    expect(placeholderChatTitle("   ")).toBe("New conversation");
  });

  it("collapses internal whitespace runs to single spaces", () => {
    expect(placeholderChatTitle("foo   bar\n\nbaz")).toBe("foo bar baz");
  });
});

describe("generateChatTitle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the LLM's clean Title-Case output when valid", async () => {
    const client = fakeClient("Pod-to-pod Networking Issues");
    const promise = generateChatTitle(
      client,
      stubSpec,
      "How do pods talk to each other in Kubernetes? I'm seeing flaky connection drops.",
      "Pod-to-pod traffic flows through the CNI plugin. The most common drop causes are…",
    );
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out.title).toBe("Pod-to-pod Networking Issues");
    expect(out.usage.inputTokens).toBeGreaterThan(0);
  });

  it("strips stray surrounding quotes / 'Title:' prefixes / trailing punctuation", async () => {
    const client = fakeClient('"Title: React Hooks Refactor."');
    const promise = generateChatTitle(
      client,
      stubSpec,
      "Help me refactor these hooks…",
      "Sure — the cleanest approach here is…",
    );
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out.title).toBe("React Hooks Refactor");
  });

  it("rejects refusal-shaped output and falls back to null", async () => {
    const client = fakeClient(
      "I cannot generate a title for this conversation as it is too short.",
    );
    const promise = generateChatTitle(
      client,
      stubSpec,
      "Some user message that is long enough to pass the min-content gate easily.",
      "Some assistant message that is also long enough to pass the gate.",
    );
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out.title).toBeNull();
  });

  it("rejects too-short outputs (< 12 chars) and too-long outputs (> 80 chars)", async () => {
    const tooShort = fakeClient("X");
    const p1 = generateChatTitle(
      tooShort,
      stubSpec,
      "Some user message that is long enough to pass the min-content gate easily.",
      "Some assistant message that is also long enough to pass the gate.",
    );
    await vi.runAllTimersAsync();
    expect((await p1).title).toBeNull();

    const tooLong = fakeClient("X".repeat(120));
    const p2 = generateChatTitle(
      tooLong,
      stubSpec,
      "Some user message that is long enough to pass the min-content gate easily.",
      "Some assistant message that is also long enough to pass the gate.",
    );
    await vi.runAllTimersAsync();
    expect((await p2).title).toBeNull();
  });

  it("skips the LLM call entirely on trivially short exchanges", async () => {
    const spy = vi.fn();
    const client = {
      createMessage: spy,
      streamMessage: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any as LLMClient;
    const out = await generateChatTitle(client, stubSpec, "hi", "hello");
    expect(out.title).toBeNull();
    expect(out.usage.inputTokens).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("times out and returns null if the model hangs (no Untitled regression)", async () => {
    const hangingClient = {
      createMessage: vi.fn(() => new Promise(() => {})),
      streamMessage: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any as LLMClient;
    const promise = generateChatTitle(
      hangingClient,
      stubSpec,
      "Some user message that is long enough to pass the min-content gate easily.",
      "Some assistant message that is also long enough to pass the gate.",
    );
    // 8s timeout in the helper; advance past it.
    await vi.advanceTimersByTimeAsync(9000);
    const out = await promise;
    expect(out.title).toBeNull();
  });
});

describe("chat-responder wires title generation into both response paths", () => {
  it("respondToChat accepts an isFirstExchange flag and returns threadTitle", async () => {
    const src = await read("src/worker/services/chat-responder.ts");
    expect(src).toMatch(/isFirstExchange = false/);
    expect(src).toMatch(/threadTitle\?:\s*string \| null/);
    // Title-gen runs only when the flag is true and persists the row.
    expect(src).toMatch(
      /if \(isFirstExchange\) \{[\s\S]{0,400}generateChatTitle\([\s\S]{0,400}UPDATE chat_threads SET title/,
    );
  });

  it("createChatStream emits a 'title' SSE event after 'done' on the first exchange", async () => {
    const src = await read("src/worker/services/chat-responder.ts");
    // The 'title' event must come AFTER the 'done' event so the user
    // sees the assistant response render first and the rename
    // appears a moment later (matches Cursor / ChatGPT timing).
    expect(src).toMatch(
      /sseEvent\("done"[\s\S]{0,2000}if \(isFirstExchange\)[\s\S]{0,800}sseEvent\("title", \{ title \}\)/,
    );
  });

  it("title-gen tokens are recorded under a distinct 'chat_title' operation", async () => {
    const src = await read("src/worker/services/chat-responder.ts");
    // Separate operation tag keeps cost analytics honest — naming
    // tokens shouldn't roll up under generic 'chat' usage.
    expect(src.match(/recordTokenUsage\([^)]*"chat_title"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("route handlers replace the dumb 60-char slice with a proper placeholder + LLM title", () => {
  it("/chat/threads/:id/messages writes the placeholder and forwards isFirstExchange", async () => {
    const src = await read("src/worker/routes/chat.ts");
    expect(src).not.toMatch(/body\.content\.slice\(0, 60\)\.trim\(\)/);
    expect(src).toMatch(/placeholderChatTitle\(body\.content\)/);
    expect(src).toMatch(/const isFirstExchange = !thread\.title/);
  });

  it("/chat/threads/:id/messages echoes threadTitle in the JSON response", async () => {
    const src = await read("src/worker/routes/chat.ts");
    expect(src).toMatch(/threadTitle:\s*generatedThreadTitle/);
  });

  it("/chat/threads/:id/messages/stream also writes the placeholder + flags first exchange", async () => {
    const src = await read("src/worker/routes/chat.ts");
    // The streaming endpoint had its own slice(0,60) — assert both
    // paths now use the shared helper.
    expect(src.match(/placeholderChatTitle\(body\.content\)/g)?.length ?? 0).toBe(2);
    expect(src).toMatch(/createChatStream\([\s\S]{0,800}isFirstExchange,?\s*\)/);
  });
});

describe("frontend useChat reflects the rename live", () => {
  it("listens for the 'title' SSE event and patches currentThread + threads list", async () => {
    const src = await read("src/frontend/hooks/useChat.ts");
    // Both pieces of state must update — the header reads
    // currentThread.title, the sidebar list reads threads[i].title,
    // and a partial update would leave one of them stale.
    expect(src).toMatch(/sse\.event === "title"/);
    expect(src).toMatch(
      /setCurrentThread\(\(prev\) => \(prev \? \{ \.\.\.prev, title: newTitle \} : prev\)\)/,
    );
    expect(src).toMatch(
      /setThreads\(\(prev\) =>\s*prev\.map\(\(t\) => \(t\.id === thread!\.id \? \{ \.\.\.t, title: newTitle \} : t\)\)/,
    );
  });
});
