import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicClient } from "../../src/worker/integrations/anthropic";

// These tests use fake timers to fast-forward through the AbortController
// timeout rather than actually waiting 120 seconds.

describe("AnthropicClient timeout", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("aborts a hung fetch and surfaces a timeout error (no retries masking the root cause)", async () => {
    // Simulate a fetch that never resolves but honors the abort signal.
    globalThis.fetch = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const client = new AnthropicClient("sk-test");
    const promise = client.createMessage({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    // Attach catch handler BEFORE timers advance so we don't hit an
    // unhandled rejection while fake timers step through retries.
    const caught = promise.catch((err: Error) => err);

    // Advance enough to trigger 3 attempts (each 120s timeout + backoff).
    await vi.advanceTimersByTimeAsync(400_000);

    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timeout after \d+s/);
  });

  it("does NOT treat a successful fast response as a timeout", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "msg_1",
          content: [{ type: "text", text: "ok" }],
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const client = new AnthropicClient("sk-test");
    const resultPromise = client.createMessage({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;
    expect(result.content[0].text).toBe("ok");
  });
});
