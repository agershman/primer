/**
 * Shared text-to-speech service.
 *
 * Top-level entry point — routes call this; provider dispatch lives
 * in the `integrations/tts/` adapter layer. Adding a new provider is
 * one new adapter file plus catalog entries — no changes here.
 *
 * Voice resolution precedence (used by routes via `resolveTtsModel`):
 *   1. Explicit `?voice=<id>` query string override (per-message picker
 *      and serves as Cloudflare cache key for the response).
 *   2. Per-operation default — `signalSurfaceMap.models.ttsModel${Operation}`
 *      (e.g. `ttsModelDeepDive`). Mirrors how per-operation LLM model
 *      picks work in the AI Models panel; lets a user pick a different
 *      voice for chat replies than for deep dives.
 *   3. Global default — `signalSurfaceMap.models.ttsModel` (catch-all
 *      so existing single-voice users keep their pick across all
 *      surfaces without re-saving anything).
 *   4. `DEFAULT_TTS_MODEL` constant fallback.
 *
 * Cost tracking: every successful TTS call writes a row to
 * `usage_events` with `modality='tts'`, the provider id, the speaker
 * voice, character count, and pre-computed cost. Cache hits don't
 * re-enter `generateTtsResponse` (CF cache short-circuits before the
 * Worker), so cached re-listens are free and naturally excluded from
 * the ledger.
 */

import { DEFAULT_TTS_MODEL, TTS_MODELS } from "../config/constants.js";
import { recordAudioUsage } from "../db/queries.js";
import { ttsAdapterFor } from "../integrations/tts/dispatcher.js";
import type { Env, UserContext } from "../types.js";

export type TtsModel = (typeof TTS_MODELS)[number];

/**
 * The handful of surfaces in Primer that synthesize speech. Each can
 * carry its own default voice via a sibling key under
 * `signalSurfaceMap.models` (e.g. `ttsModelTeachingPiece`), letting
 * a user pick a Friendly female (US) voice for teaching pieces and a
 * deeper narrator voice for deep dives. Kept as a closed union so the
 * settings shape, the resolver, and the UI panel stay in lockstep.
 */
export type TtsOperation = "teachingPiece" | "deepDive" | "chat";

/**
 * Maps a TTS operation to its settings key under
 * `signalSurfaceMap.models`. Mirrors the LLM operation key naming
 * (`teachingPiece` / `deepDive` / `chat` / …) so a user reading the
 * stored config can match each operation row against its model and
 * voice settings side-by-side.
 */
export const TTS_OPERATION_SETTINGS_KEY: Record<TtsOperation, string> = {
  teachingPiece: "ttsModelTeachingPiece",
  deepDive: "ttsModelDeepDive",
  chat: "ttsModelChat",
};

export function resolveTtsModel(user: UserContext, override?: string | null, operation?: TtsOperation): TtsModel {
  if (override) {
    const m = TTS_MODELS.find((x) => x.id === override);
    if (m) return m;
  }
  const surfaceMap = user.settings?.signalSurfaceMap as Record<string, unknown> | undefined;
  const models = (surfaceMap?.models ?? {}) as Record<string, string>;
  const opPref = operation ? models[TTS_OPERATION_SETTINGS_KEY[operation]] : undefined;
  const pref = opPref ?? models.ttsModel;
  return TTS_MODELS.find((m) => m.id === pref) ?? TTS_MODELS.find((m) => m.id === DEFAULT_TTS_MODEL) ?? TTS_MODELS[0];
}

/**
 * Optional usage-recording context. When provided, `generateTtsResponse`
 * writes a `usage_events` row after the synthesis call returns. We use
 * `ctx?.waitUntil` so recording doesn't block the audio response — it's
 * fine for the row to land slightly after the audio reaches the
 * browser. Cache hits skip this entirely (no Worker invocation).
 */
export interface TtsRecordingContext {
  db: D1Database;
  userId: string;
  /** Operation tag persisted into `usage_events.operation` so analytics
   *  can distinguish a teaching-piece listen from a deep-dive listen
   *  from a chat reply playback. */
  operation: string;
  /** Optional ExecutionContext from the Worker request — its
   *  `waitUntil` keeps recording alive after the response closes. When
   *  absent the recording happens synchronously after stream drain. */
  ctx?: { waitUntil(promise: Promise<unknown>): void };
}

function audioCostUsd(model: TtsModel, chars: number): number {
  return (chars / 1000) * model.costPer1kChars;
}

/**
 * Top-level entry point — pick the right provider adapter for the model
 * and return a streaming `Response` with audio/mpeg headers. The body
 * is a contiguous MP3 byte stream the browser can pipe straight into
 * an `<audio>` element.
 *
 * When `recording` is provided, a `usage_events` row is written after
 * the synthesis call returns. Recording is best-effort — a failed
 * insert never blocks audio playback. The recording happens at the
 * service layer (here) rather than inside each adapter so adding new
 * providers stays a single new file with no usage-recording wiring.
 */
export async function generateTtsResponse(
  env: Env,
  text: string,
  model: TtsModel,
  recording?: TtsRecordingContext,
): Promise<Response> {
  const adapter = ttsAdapterFor(model);
  const { response, charCount } = await adapter.generate(env, text, model);

  if (recording) {
    const cost = audioCostUsd(model, charCount);
    const promise = recordAudioUsage(
      recording.db,
      recording.userId,
      recording.operation,
      model.provider,
      model.id,
      model.speaker,
      charCount,
      cost,
    ).catch((err) => {
      console.warn("[tts] failed to record usage:", err);
    });
    if (recording.ctx?.waitUntil) {
      recording.ctx.waitUntil(promise);
    } else {
      // Best-effort fire-and-forget; cost rows that don't land are
      // not worth blocking the audio response over.
      void promise;
    }
  }

  return response;
}

/**
 * Split a text body at sentence/word boundaries so each chunk fits below
 * the per-provider request size cap. Tries `". "` first (sentence), falls
 * back to a word boundary, then to a hard cut as a last resort.
 *
 * Exported because each adapter pulls it in — keeps chunking logic in
 * one place across providers.
 */
export function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf(". ", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt + 1).trim());
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return chunks;
}

/**
 * Audio-route error response.
 *
 * The `<audio>` element on the frontend can't read JSON error
 * bodies — when it loads `/api/.../audio` and the response isn't
 * audio bytes, it just fires an opaque `error` event and the player
 * shows "Audio unavailable" with no actionable info. This helper
 * preserves enough diagnostic info that the frontend can recover
 * the underlying error via TWO channels that survive the audio
 * element's opaque failure mode:
 *
 *   1. `X-Audio-Error` response header — readable by `fetch()`
 *      even when the audio decoder is the only consumer that saw
 *      the response. AudioPlayer reads this on `<audio>.error` to
 *      show a per-instance inline message.
 *   2. JSON body `{ error, detail, provider, surface }` — for
 *      direct cURL / browser-tab debugging and for AudioPlayer's
 *      diagnostic fallback fetch.
 *
 * Provider name is sniffed from the error message prefix our
 * adapters set ("ElevenLabs TTS 401: …", "OpenAI TTS 429: …").
 * Logs include the same provider tag so worker logs can be
 * filtered.
 */
export function audioErrorResponse(surface: string, err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  const provider = /^ElevenLabs/i.test(detail)
    ? "elevenlabs"
    : /^OpenAI/i.test(detail)
      ? "openai"
      : detail.includes("@cf/")
        ? "cloudflare"
        : "unknown";
  console.error(`[audio] ${surface} TTS failed (${provider}):`, err);
  return new Response(
    JSON.stringify({
      error: "Audio generation failed",
      surface,
      provider,
      // Cap so an upstream HTML error page (worst case) doesn't
      // bloat the response body or echo SSRF-leakable internals.
      detail: detail.slice(0, 500),
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        // Header survives the audio element's opaque failure —
        // AudioPlayer's diagnostic fetch reads this directly so we
        // never need to re-parse the response body in the success
        // path.
        "X-Audio-Error": detail.slice(0, 200).replace(/[\r\n]+/g, " "),
      },
    },
  );
}

/**
 * Strip the lightweight markdown the LLM emits in chat replies down to plain
 * speakable prose. Removes fenced code blocks (TTS would just spell punctuation
 * letter-by-letter), normalizes inline code/bold/italic to bare text, replaces
 * `[label](url)` with just the label, and collapses multiple blank lines.
 *
 * Intentionally conservative — better to read a slightly awkward sentence than
 * to drop content the user wanted to hear.
 */
export function chatMarkdownToSpeech(text: string): string {
  return (
    text
      // Drop fenced code blocks entirely — they read terribly.
      .replace(/```[\s\S]*?```/g, " ")
      // Drop indented code blocks (4-space) — also unreadable.
      .replace(/(^|\n)( {4,}[^\n]+)/g, "$1")
      // Inline code: keep the contents, drop the backticks.
      .replace(/`([^`]+)`/g, "$1")
      // Bold/italic markers — drop the markers, keep the text.
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
      .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1")
      // Links: keep the visible label, drop the URL.
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      // Headings — strip the leading hashes but keep the text.
      .replace(/^#{1,6}\s+/gm, "")
      // Bullet/numbered list markers — drop the marker, keep the item.
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      // Block quotes.
      .replace(/^\s*>\s?/gm, "")
      // Trim trailing whitespace on each line so collapsed code-block runs
      // (now empty) don't leave " " noise between paragraphs.
      .replace(/[ \t]+$/gm, "")
      // Collapse lines that are entirely whitespace into bare blank lines.
      .replace(/^[ \t]+$/gm, "")
      // Collapse runs of blank lines.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
