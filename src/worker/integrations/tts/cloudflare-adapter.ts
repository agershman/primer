/**
 * Cloudflare Workers AI TTS adapter.
 *
 * Handles two distinct CF model shapes:
 *   - Aura (`@cf/deepgram/aura-1`) — streaming MP3, fast and cheap.
 *   - MeloTTS (`@cf/myshell-ai/melotts`) — base64-wrapped one-shot,
 *     budget tier. No streaming.
 *
 * Both go through the same `TtsAdapter.generate()` entry point — the
 * model id discriminates.
 */

import type { TtsModel } from "../../config/constants.js";
import { chunkText } from "../../services/tts.js";
import type { Env } from "../../types.js";
import type { TtsAdapter, TtsResult } from "./types.js";

const AUDIO_HEADERS = {
  "Content-Type": "audio/mpeg",
  "Cache-Control": "public, max-age=86400",
};

export class CloudflareTtsAdapter implements TtsAdapter {
  readonly provider = "cloudflare";

  isConfigured(_env: Env): boolean {
    // Workers AI uses the `AI` binding, which is always present in
    // a deployed Worker. No API key check needed.
    return true;
  }

  async generate(env: Env, text: string, model: TtsModel): Promise<TtsResult> {
    if (model.model === "@cf/deepgram/aura-1") {
      return this.generateAura(env, text, model);
    }
    return this.generateMelo(env, text, model);
  }

  private async generateAura(env: Env, text: string, model: TtsModel): Promise<TtsResult> {
    const chunks = chunkText(text, 1900);
    const streamPromises = chunks.map(async (chunk): Promise<ReadableStream<Uint8Array>> => {
      // Workers AI types the model id as a tagged string union; the
      // catalog stores it as a plain string. Cast at the boundary.
      const result = await env.AI.run(model.model as never, {
        text: chunk,
        speaker: model.speaker ?? "asteria",
      });
      if (result instanceof ReadableStream) {
        return result as ReadableStream<Uint8Array>;
      }
      // Aura sometimes returns ArrayBuffer when generation is fast
      // enough that streaming wasn't engaged. Wrap as a one-shot
      // stream so the response pipeline is uniform.
      const buf = new Uint8Array(result as unknown as ArrayBuffer);
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(buf);
          c.close();
        },
      });
    });
    return {
      response: streamingTtsResponse(streamPromises),
      charCount: text.length,
    };
  }

  private async generateMelo(env: Env, text: string, model: TtsModel): Promise<TtsResult> {
    const chunks = chunkText(text, 4500);
    const allBytes: Uint8Array[] = [];

    for (const chunk of chunks) {
      const result = await env.AI.run(model.model as never, {
        prompt: chunk,
        lang: "en",
      });
      const audioData = (result as { audio?: string }).audio;
      if (!audioData) throw new Error("No audio returned from MeloTTS");

      const binaryStr = atob(audioData);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      allBytes.push(bytes);
    }

    const totalLen = allBytes.reduce((s, b) => s + b.length, 0);
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const b of allBytes) {
      combined.set(b, off);
      off += b.length;
    }

    return {
      response: new Response(combined.buffer, { headers: AUDIO_HEADERS }),
      charCount: text.length,
    };
  }
}

/**
 * Build a streaming Response that drains a list of upstream audio
 * streams in order. Streams fire in PARALLEL (caller dispatches them
 * concurrently); we read them out one at a time so the browser sees a
 * single contiguous MP3 byte sequence.
 *
 * Total wall time ≈ slowest chunk; time-to-first-audio ≈ first chunk's
 * TTFB. Large win for multi-chunk synthesis.
 */
export function streamingTtsResponse(streamPromises: Promise<ReadableStream<Uint8Array>>[]): Response {
  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const upstreamPromise of streamPromises) {
          const upstream = await upstreamPromise;
          const reader = upstream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(out, { headers: AUDIO_HEADERS });
}
