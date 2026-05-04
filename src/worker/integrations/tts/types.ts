/**
 * Provider-agnostic TTS types.
 *
 * Mirrors the shape the LLM adapter layer uses (see
 * `integrations/llm/types.ts`). Each TTS adapter speaks a uniform
 * interface; the dispatcher picks the right one based on the
 * catalog-resolved `TtsModel.provider`.
 *
 * Adding a new TTS provider is a single new adapter file plus catalog
 * entries — no service-layer changes, no DB migration, no UI changes
 * (the Voice picker groups by provider automatically).
 */

import type { TtsModel } from "../../config/constants.js";
import type { Env } from "../../types.js";

export type TtsResult = {
  /** Streaming `audio/mpeg` Response ready to return to the browser. */
  response: Response;
  /** Number of characters synthesized — used for usage recording.
   *  Always `text.length` of the input passed in (the request unit
   *  every provider bills on, regardless of how chunking happens
   *  upstream). */
  charCount: number;
};

export interface TtsAdapter {
  /** Provider id matching `TtsModel.provider`. */
  readonly provider: string;

  /** Whether this adapter has the credentials it needs to run. The
   *  dispatcher uses this to skip the adapter cleanly with an error
   *  the caller can show. Cloudflare adapter is always configured
   *  (no API key — uses the `AI` binding); paid adapters require
   *  the relevant `*_API_KEY` env. */
  isConfigured(env: Env): boolean;

  /** Generate audio for the given text using the given catalog
   *  voice. The adapter is responsible for chunking, streaming, and
   *  any provider-specific request shape. */
  generate(env: Env, text: string, model: TtsModel): Promise<TtsResult>;
}
