import { Hono } from "hono";
import { genId } from "../db/queries.js";
import type { ContentBlock, Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const bookmarkRoutes = new Hono<AppEnv>();

/**
 * Compute a short text snippet describing *where* in a teaching piece a
 * bookmark points. This is what powers the "context" line under each
 * row on the Bookmarks page — without it, all the user sees is the
 * piece title, which doesn't help them recall what specifically they
 * pinned. We resolve the target block based on bookmark type:
 *
 *   • **`saved` with `scroll_position >= 1`** — block-level bookmark
 *     ("I pinned paragraph 5 of this piece"). The integer is the
 *     1-based block index in the piece's content array. We grab that
 *     block's text and clip it.
 *   • **`reading` with 0 < `scroll_position` < 1** — reading-progress
 *     bookmark ("I was 60% of the way through"). We pick the text
 *     block at the proportional position. Approximate but useful.
 *   • **`saved` with `scroll_position` === 0** — piece-level bookmark
 *     (the user hit the bookmark icon at the top, no specific block).
 *     We use the first text/heading block as a teaser of the piece's
 *     opening.
 *
 * In every case we strip the lightweight markdown the LLM emits
 * (`{{label||url}}` resource links, `**bold**`, `*italic*`,
 * `` `code` ``) so the snippet reads as plain prose, then truncate
 * to ~180 chars with an ellipsis at a word boundary.
 */
function computeBookmarkSnippet(
  contentJson: string | null,
  bookmarkType: string,
  scrollPosition: number,
): string | null {
  if (!contentJson) return null;
  let blocks: ContentBlock[];
  try {
    blocks = JSON.parse(contentJson) as ContentBlock[];
  } catch {
    return null;
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  // Only text-bearing blocks are useful for a snippet — diagrams and
  // code blocks would read as garbage out of context.
  const textBlocks = blocks.filter((b) => b.type === "text" || b.type === "heading");
  if (textBlocks.length === 0) return null;

  let targetText: string | null = null;
  if (bookmarkType === "saved" && scrollPosition >= 1) {
    // Block-level bookmark. `scroll_position` is the 1-based block
    // index across ALL blocks (the BriefingPage handler stores
    // whatever block index the user clicked). Translate to 0-based
    // and clamp; if that block isn't text-bearing, fall back to the
    // nearest text block.
    const idx = Math.round(scrollPosition);
    const direct = blocks[idx - 1] ?? blocks[idx];
    if (direct && (direct.type === "text" || direct.type === "heading")) {
      targetText = direct.value;
    } else {
      // Fall back: pick the closest text block by index distance.
      let bestText: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type !== "text" && b.type !== "heading") continue;
        const dist = Math.abs(i + 1 - idx);
        if (dist < bestDist) {
          bestDist = dist;
          bestText = b.value;
        }
      }
      targetText = bestText;
    }
  } else if (bookmarkType === "reading" && scrollPosition > 0 && scrollPosition < 1) {
    // Reading-progress bookmark. Pick the text block at the
    // proportional position so the snippet is ~where the user was.
    const idx = Math.min(textBlocks.length - 1, Math.floor(scrollPosition * textBlocks.length));
    targetText = textBlocks[idx]?.value ?? null;
  } else {
    // Piece-level bookmark — use the first text block as a teaser.
    targetText = textBlocks[0]?.value ?? null;
  }

  if (!targetText) return null;

  // Strip lightweight markdown emitted by the teaching-piece
  // generator. Same set the audio TTS pipeline strips, except we
  // keep paragraph structure (no need to flatten — we're only
  // showing one block).
  const plain = targetText
    .replace(/\{\{(.+?)\|\|.+?\}\}/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!plain) return null;
  // Snippet character budget. Tuned with the frontend `WebkitLineClamp`
  // (3 lines): 3 lines × ~80 chars/line ≈ 240 visible characters in
  // the bookmark row. We give a touch more headroom (260) so the
  // truncation routinely lands at a word boundary inside the visible
  // 3-line box rather than the ellipsis appearing on the line below.
  // Smaller caps (180) clipped paragraphs too aggressively — users
  // couldn't see enough to remember why they pinned the spot.
  if (plain.length <= 260) return plain;
  // Truncate at the last whitespace within the budget so we don't
  // cut a word in half. Falls back to a hard slice if the text has
  // no whitespace within range (shouldn't happen for prose). The
  // `> 120` floor is a sanity check: if for some reason the last
  // word in the budget starts past char 120, prefer the hard cut
  // over an unnaturally short snippet.
  const truncated = plain.slice(0, 260);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 120 ? truncated.slice(0, lastSpace) : truncated).trimEnd() + "…";
}

bookmarkRoutes.get("/bookmarks", async (c) => {
  const user = c.get("user");

  // Pull `tp.content` so we can compute a context snippet for each
  // bookmark in JS. The content column stores a JSON-encoded
  // `ContentBlock[]`; for a typical 50-bookmark page the total
  // payload is still small, well under any worker memory cap.
  const rows = await c.env.DB.prepare(
    `SELECT b.*, tp.title as piece_title, tp.piece_type, tp.read_time_minutes,
            tp.content as piece_content,
            br.briefing_date
     FROM bookmarks b
     JOIN teaching_pieces tp ON b.piece_id = tp.id
     JOIN briefings br ON tp.briefing_id = br.id
     WHERE b.user_id = ?
     ORDER BY b.updated_at DESC
     LIMIT 50`,
  )
    .bind(user.userId)
    .all<{
      id: string;
      piece_id: string;
      bookmark_type: string;
      scroll_position: number;
      audio_position: number;
      note: string | null;
      created_at: string;
      updated_at: string;
      piece_title: string;
      piece_type: string;
      read_time_minutes: number | null;
      piece_content: string | null;
      briefing_date: string;
    }>();

  return c.json({
    bookmarks: rows.results.map((b) => ({
      id: b.id,
      pieceId: b.piece_id,
      type: b.bookmark_type,
      scrollPosition: b.scroll_position,
      audioPosition: b.audio_position,
      note: b.note,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
      pieceTitle: b.piece_title,
      pieceType: b.piece_type,
      readTimeMinutes: b.read_time_minutes,
      briefingDate: b.briefing_date,
      contextSnippet: computeBookmarkSnippet(b.piece_content, b.bookmark_type, b.scroll_position),
    })),
  });
});

bookmarkRoutes.get("/bookmark/:pieceId", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("pieceId");

  const bookmark = await c.env.DB.prepare("SELECT * FROM bookmarks WHERE user_id = ? AND piece_id = ?")
    .bind(user.userId, pieceId)
    .first<{
      id: string;
      bookmark_type: string;
      scroll_position: number;
      audio_position: number;
      note: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!bookmark) {
    return c.json({ bookmark: null });
  }

  return c.json({
    bookmark: {
      id: bookmark.id,
      type: bookmark.bookmark_type,
      scrollPosition: bookmark.scroll_position,
      audioPosition: bookmark.audio_position,
      note: bookmark.note,
      createdAt: bookmark.created_at,
      updatedAt: bookmark.updated_at,
    },
  });
});

bookmarkRoutes.put("/bookmark/:pieceId", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("pieceId");
  const body = await c.req.json<{
    type?: "reading" | "saved";
    scrollPosition?: number;
    audioPosition?: number;
    note?: string;
  }>();

  const existing = await c.env.DB.prepare("SELECT id, bookmark_type FROM bookmarks WHERE user_id = ? AND piece_id = ?")
    .bind(user.userId, pieceId)
    .first<{ id: string; bookmark_type: string }>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE bookmarks SET
        bookmark_type = COALESCE(?, bookmark_type),
        scroll_position = COALESCE(?, scroll_position),
        audio_position = COALESCE(?, audio_position),
        note = COALESCE(?, note),
        updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(body.type ?? null, body.scrollPosition ?? null, body.audioPosition ?? null, body.note ?? null, existing.id)
      .run();
    return c.json({ ok: true, id: existing.id, created: false });
  }

  const id = genId("bookmark");
  await c.env.DB.prepare(
    `INSERT INTO bookmarks (id, user_id, piece_id, bookmark_type, scroll_position, audio_position, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      id,
      user.userId,
      pieceId,
      body.type ?? "reading",
      body.scrollPosition ?? 0,
      body.audioPosition ?? 0,
      body.note ?? null,
    )
    .run();

  return c.json({ ok: true, id, created: true }, 201);
});

bookmarkRoutes.delete("/bookmark/:pieceId", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("pieceId");

  await c.env.DB.prepare("DELETE FROM bookmarks WHERE user_id = ? AND piece_id = ?").bind(user.userId, pieceId).run();

  return c.json({ ok: true });
});
