/**
 * Frontend-side estimator for TTS audio duration.
 *
 * Why this exists: the AudioPlayer's progress-bar fill needs to know
 * the total duration to render a meaningful proportion. For streamed
 * TTS responses the browser doesn't expose `audio.duration` until the
 * stream finishes (it's `Infinity` mid-stream), and the previous
 * fallback — using `audio.buffered.end(last)` × 1.05 as a proxy —
 * fails when the worker's TTS streaming rate is close to playback
 * rate. In that case `buffered.end` tracks `currentTime` closely, so
 * the fill ratio sits near 80–95% the entire playback while crawling
 * imperceptibly toward 100%.
 *
 * The fix is to estimate the total duration from the *source text*
 * length up-front. TTS providers all output speech at roughly the
 * same human-natural rate (~150 wpm ≈ 13 chars/sec including
 * spaces). The frontend already has the source text in component
 * state when it renders an AudioPlayer, so we can compute a
 * sensible estimate before the audio request even starts.
 *
 * The estimate is intentionally biased to overestimate slightly
 * (rate constant chosen at the lower end of natural-speech rates,
 * with a small headroom multiplier). Overestimating means the bar
 * fills slowly and the real `audio.duration` snaps it to 100% at
 * end — graceful degradation. Underestimating would clamp the bar
 * at 100% before audio finishes, which is exactly the bug we're
 * fixing.
 */

import type { ContentBlock } from "../types";

/**
 * Average characters-per-second for natural-sounding TTS output.
 *
 * Empirically: 150 wpm × ~5 chars/word + spaces ≈ 13 chars/sec for
 * Aura, MeloTTS, OpenAI tts-1/-hd, ElevenLabs multilingual/turbo/
 * flash. Picked at the slow end of the observed range so the
 * resulting estimate biases slightly long (graceful) rather than
 * slightly short (clipped bar).
 */
export const TTS_CHARS_PER_SECOND = 13;

/**
 * Estimate audio duration in seconds for the given source text.
 *
 * `text` is the *spoken* form — what the TTS engine actually
 * vocalizes. Markdown should already be stripped and unspeakable
 * blocks (code fences, mermaid diagrams) excluded by the caller, so
 * the character count maps cleanly to spoken duration. See
 * `contentBlocksToSpokenText` for the content-block flow.
 *
 * Returns 0 for empty / falsy input so the player falls back to its
 * existing buffered-end heuristic rather than rendering a 0-second
 * bar.
 */
export function estimateTtsDurationSeconds(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.length / TTS_CHARS_PER_SECOND;
}

/**
 * Flatten a content-block array down to its speakable text, mirroring
 * what the worker's `contentToPlainText` produces before handing
 * audio to the TTS adapter:
 *
 *   - `text` and `heading` blocks contribute their `value`.
 *   - `code` and `diagram` blocks are skipped — TTS reading code
 *     punctuation letter-by-letter is unhelpful, and the worker
 *     skips them too.
 *   - Blocks are joined with double newlines to approximate the
 *     paragraph spacing the worker passes to the TTS request (and
 *     to keep the character count close — newlines do count for
 *     the rate divisor).
 *
 * Used by callers (TeachingPiece, DeepDiveView) that have the
 * structured content blocks rather than a pre-flattened string.
 */
export function contentBlocksToSpokenText(blocks: ContentBlock[] | null | undefined): string {
  if (!blocks || blocks.length === 0) return "";
  const speakable: string[] = [];
  for (const block of blocks) {
    if (block.type === "code" || block.type === "diagram") continue;
    if (typeof block.value === "string" && block.value.trim().length > 0) {
      speakable.push(block.value);
    }
  }
  return speakable.join("\n\n");
}
