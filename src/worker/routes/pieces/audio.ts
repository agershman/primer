/**
 * Audio (TTS) endpoints — converts a teaching piece's body text into
 * spoken audio with a natural sign-off outro.
 *
 * - GET `/piece/:id/audio`            — briefing-piece body
 * - GET `/piece/:id/deep-dive/audio`  — deep-dive body
 *
 * @see ../pieces.ts — assembly entry point
 */

import { Hono } from "hono";
import { audioErrorResponse, generateTtsResponse, resolveTtsModel } from "../../services/tts.js";
import type { ContentBlock, Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const pieceAudioRoutes = new Hono<AppEnv>();

function contentToPlainText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text" || b.type === "heading")
    .map((b) => {
      return b.value
        .replace(/\{\{(.+?)\|\|.+?\}\}/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
    })
    .join("\n\n");
}

/**
 * Audio outros — short closing lines tacked onto the end of TTS playback
 * so a listener gets natural sign-off cues instead of an abrupt cut at
 * the last sentence. Two variants:
 *
 * - **Briefing teaching piece**: invites the listener to use the
 *   `Go deeper` button if they want more. We adapt the wording slightly
 *   based on whether the deep dive has already been generated for this
 *   piece (so we don't promise generation that's already done, and so
 *   listeners who expanded it don't hear a stale "tap to generate" pitch).
 * - **Deep dive**: a sign-off thanking the listener — closure to a
 *   long-form piece rather than the awkward stop the previous version had.
 *
 * Both written for the ear, not the eye: contractions, short clauses,
 * a clean period at the end so chunked TTS stops at a natural pause.
 * The blank line before each is a cue the chunker uses to insert a
 * brief breath between content and outro.
 */
const BRIEFING_AUDIO_OUTRO_NO_DEEP_DIVE =
  "If you'd like to go deeper on this, tap Go deeper at the end of the piece, and I'll put together a longer take for you.";
const BRIEFING_AUDIO_OUTRO_WITH_DEEP_DIVE =
  "If you want more on this, the deep dive is ready — open it from the end of the piece for a fuller take.";
const DEEP_DIVE_AUDIO_OUTRO = "That's the deep dive. I hope you found it helpful. Thanks for listening.";

pieceAudioRoutes.get("/piece/:id/audio", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");

  // Pull `has_deep_dive` so the outro can be honest about whether the
  // deep dive is already generated and ready, vs. needs to be triggered.
  const piece = await c.env.DB.prepare(
    "SELECT content, title, has_deep_dive FROM teaching_pieces WHERE id = ? AND user_id = ?",
  )
    .bind(pieceId, user.userId)
    .first<{ content: string; title: string; has_deep_dive: number | boolean | null }>();

  if (!piece) {
    return c.json({ error: "Piece not found" }, 404);
  }

  const blocks: ContentBlock[] = JSON.parse(piece.content || "[]");
  const body = contentToPlainText(blocks);

  if (!body.trim()) {
    return c.json({ error: "No text content to convert" }, 400);
  }

  // Pick the outro variant before we slice — the outro should always
  // play in full, even when the body is truncated to the 5000-char cap.
  // `has_deep_dive` is stored as an integer on D1 (1 = ready, 0 = none,
  // -1 = generating). Treat anything > 0 as "ready". `-1` (mid-flight
  // generation) is rare during audio playback but not certain enough
  // to promise — fall back to the no-deep-dive copy.
  const deepDiveReady = (piece.has_deep_dive as unknown as number) > 0;
  const outro = deepDiveReady ? BRIEFING_AUDIO_OUTRO_WITH_DEEP_DIVE : BRIEFING_AUDIO_OUTRO_NO_DEEP_DIVE;

  // Cap the body to leave room for the title prefix and outro within
  // a comfortable 5000-char total budget.
  const titlePrefix = `${piece.title}.\n\n`;
  const overheadChars = titlePrefix.length + outro.length + 8; // 8 = "\n\n" separators
  const bodyBudget = Math.max(500, 5000 - overheadChars);
  const trimmedBody = body.length > bodyBudget ? body.slice(0, bodyBudget) : body;
  const plainText = `${titlePrefix}${trimmedBody}\n\n${outro}`;

  try {
    const override = c.req.query("voice");
    return await generateTtsResponse(c.env, plainText, resolveTtsModel(user, override, "teachingPiece"), {
      db: c.env.DB,
      userId: user.userId,
      operation: "audio_teaching_piece",
      ctx: c.executionCtx as { waitUntil(p: Promise<unknown>): void } | undefined,
    });
  } catch (err) {
    return audioErrorResponse("teaching piece", err);
  }
});

pieceAudioRoutes.get("/piece/:id/deep-dive/audio", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");

  const piece = await c.env.DB.prepare(
    "SELECT title, deep_dive_content FROM teaching_pieces WHERE id = ? AND user_id = ?",
  )
    .bind(pieceId, user.userId)
    .first<{ title: string; deep_dive_content: string | null }>();

  if (!piece || !piece.deep_dive_content) {
    return c.json({ error: "Deep dive not found" }, 404);
  }

  const blocks: ContentBlock[] = JSON.parse(piece.deep_dive_content);
  const body = contentToPlainText(blocks);

  // Same pattern as the briefing audio — slice the body to leave room
  // for the title prefix and the sign-off outro within a 10000-char
  // budget. Without this, a long deep dive would clip the outro and
  // the listener would still get an abrupt cut.
  const titlePrefix = `${piece.title} — Deep Dive.\n\n`;
  const overheadChars = titlePrefix.length + DEEP_DIVE_AUDIO_OUTRO.length + 8;
  const bodyBudget = Math.max(1000, 10000 - overheadChars);
  const trimmedBody = body.length > bodyBudget ? body.slice(0, bodyBudget) : body;
  const plainText = `${titlePrefix}${trimmedBody}\n\n${DEEP_DIVE_AUDIO_OUTRO}`;

  try {
    const override = c.req.query("voice");
    return await generateTtsResponse(c.env, plainText, resolveTtsModel(user, override, "deepDive"), {
      db: c.env.DB,
      userId: user.userId,
      operation: "audio_deep_dive",
      ctx: c.executionCtx as { waitUntil(p: Promise<unknown>): void } | undefined,
    });
  } catch (err) {
    return audioErrorResponse("deep dive", err);
  }
});
