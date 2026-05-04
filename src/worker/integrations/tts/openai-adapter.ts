/**
 * OpenAI TTS adapter.
 *
 * Streams MP3 from `https://api.openai.com/v1/audio/speech` per chunk.
 * Handles both `tts-1` (standard) and `tts-1-hd` (premium); the catalog
 * entry's `model` field carries the choice. Voice selection comes from
 * `model.speaker` (alloy, echo, fable, onyx, nova, shimmer).
 */

import type { TtsModel } from "../../config/constants.js";
import { chunkText } from "../../services/tts.js";
import type { Env } from "../../types.js";
import { streamingTtsResponse } from "./cloudflare-adapter.js";
import type { TtsAdapter, TtsResult } from "./types.js";

export class OpenAITtsAdapter implements TtsAdapter {
  readonly provider = "openai";

  isConfigured(env: Env): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  async generate(env: Env, text: string, model: TtsModel): Promise<TtsResult> {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not configured");
    }
    const chunks = chunkText(text, 4000);
    const apiKey = env.OPENAI_API_KEY;
    const streamPromises = chunks.map(
      (chunk): Promise<ReadableStream<Uint8Array>> =>
        fetchOpenAiTtsChunk(apiKey, chunk, model.model, model.speaker ?? "alloy"),
    );
    return {
      response: streamingTtsResponse(streamPromises),
      charCount: text.length,
    };
  }
}

async function fetchOpenAiTtsChunk(
  apiKey: string,
  chunk: string,
  model: string,
  voice: string,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: chunk,
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error("OpenAI TTS returned no response body");
  }
  return res.body as ReadableStream<Uint8Array>;
}
