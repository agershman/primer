/**
 * ElevenLabs TTS adapter.
 *
 * Streams MP3 directly from
 * `https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream`.
 * Authentication uses the `xi-api-key` header (NOT a bearer token).
 *
 * The catalog entry's `speaker` field carries the ElevenLabs voice id.
 * The `model` field carries the ElevenLabs model id (e.g.
 * `eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`).
 *
 * ElevenLabs is character-billed at the model's listed rate per 1k
 * chars (encoded in `costPer1kChars` on the catalog entry). The
 * unified `usage_events` ledger records the row at end-of-stream so
 * the user's monthly budget cap correctly includes this spend.
 */

import type { TtsModel } from "../../config/constants.js";
import { chunkText } from "../../services/tts.js";
import type { Env } from "../../types.js";
import { streamingTtsResponse } from "./cloudflare-adapter.js";
import type { TtsAdapter, TtsResult } from "./types.js";

export class ElevenLabsTtsAdapter implements TtsAdapter {
  readonly provider = "elevenlabs";

  isConfigured(env: Env): boolean {
    return Boolean(env.ELEVENLABS_API_KEY);
  }

  async generate(env: Env, text: string, model: TtsModel): Promise<TtsResult> {
    if (!env.ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY not configured");
    }
    if (!model.speaker) {
      throw new Error(`ElevenLabs model ${model.id} is missing a voice id`);
    }
    // ElevenLabs single-request char limit is generous (~5000 chars
    // per request). Chunk at 4500 to leave headroom and benefit from
    // the same parallel-streaming pattern as the OpenAI adapter.
    const chunks = chunkText(text, 4500);
    const apiKey = env.ELEVENLABS_API_KEY;
    const voiceId = model.speaker;
    const modelId = model.model;
    const streamPromises = chunks.map(
      (chunk): Promise<ReadableStream<Uint8Array>> => fetchElevenLabsChunk(apiKey, chunk, modelId, voiceId),
    );
    return {
      response: streamingTtsResponse(streamPromises),
      charCount: text.length,
    };
  }
}

async function fetchElevenLabsChunk(
  apiKey: string,
  chunk: string,
  modelId: string,
  voiceId: string,
): Promise<ReadableStream<Uint8Array>> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: chunk,
      model_id: modelId,
      // Defaults are sensible — ElevenLabs picks reasonable
      // similarity_boost / stability for each voice. Surface as
      // catalog-level overrides only if/when users complain.
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS ${res.status}: ${errText.slice(0, 200)}`);
  }
  if (!res.body) {
    throw new Error("ElevenLabs TTS returned no response body");
  }
  return res.body as ReadableStream<Uint8Array>;
}
