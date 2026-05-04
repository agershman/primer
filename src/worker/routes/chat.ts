import { Hono } from "hono";
import { resolveModel } from "../config/models.js";
import { genId } from "../db/queries.js";
import { createChatStream, placeholderChatTitle, respondToChat } from "../services/chat-responder.js";
import { audioErrorResponse, chatMarkdownToSpeech, generateTtsResponse, resolveTtsModel } from "../services/tts.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/chat/threads", async (c) => {
  const user = c.get("user");

  const threads = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.summary, t.compacted_at, t.page_context,
            t.created_at, t.updated_at,
            COUNT(m.id) as message_count
     FROM chat_threads t
     LEFT JOIN chat_messages m ON t.id = m.thread_id
     WHERE t.user_id = ?
     GROUP BY t.id
     ORDER BY t.updated_at DESC
     LIMIT 20`,
  )
    .bind(user.userId)
    .all<{
      id: string;
      title: string | null;
      summary: string | null;
      compacted_at: string | null;
      page_context: string | null;
      created_at: string;
      updated_at: string;
      message_count: number;
    }>();

  return c.json({
    threads: threads.results.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
      compactedAt: t.compacted_at,
      pageContext: t.page_context,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      messageCount: t.message_count,
    })),
  });
});

chatRoutes.post("/chat/threads", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ pageContext?: string }>();
  const id = genId("chatThread");

  await c.env.DB.prepare(
    `INSERT INTO chat_threads (id, user_id, page_context, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(id, user.userId, body.pageContext ?? null)
    .run();

  const thread = await c.env.DB.prepare(`SELECT * FROM chat_threads WHERE id = ? AND user_id = ?`)
    .bind(id, user.userId)
    .first<{
      id: string;
      title: string | null;
      summary: string | null;
      compacted_at: string | null;
      page_context: string | null;
      created_at: string;
      updated_at: string;
    }>();

  return c.json(
    {
      thread: {
        id: thread!.id,
        title: thread!.title,
        summary: thread!.summary,
        compactedAt: thread!.compacted_at,
        pageContext: thread!.page_context,
        createdAt: thread!.created_at,
        updatedAt: thread!.updated_at,
      },
    },
    201,
  );
});

chatRoutes.get("/chat/threads/:id/messages", async (c) => {
  const user = c.get("user");
  const threadId = c.req.param("id");

  const thread = await c.env.DB.prepare(
    `SELECT id, title, summary, compacted_at FROM chat_threads
     WHERE id = ? AND user_id = ?`,
  )
    .bind(threadId, user.userId)
    .first<{
      id: string;
      title: string | null;
      summary: string | null;
      compacted_at: string | null;
    }>();

  if (!thread) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const messages = await c.env.DB.prepare(
    `SELECT id, role, content, created_at
     FROM chat_messages
     WHERE thread_id = ? AND user_id = ?
     ORDER BY created_at ASC`,
  )
    .bind(threadId, user.userId)
    .all<{
      id: string;
      role: string;
      content: string;
      created_at: string;
    }>();

  return c.json({
    messages: messages.results.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    })),
    thread: {
      id: thread.id,
      title: thread.title,
      summary: thread.summary,
      compactedAt: thread.compacted_at,
    },
  });
});

chatRoutes.post("/chat/threads/:id/messages", async (c) => {
  const user = c.get("user");
  const threadId = c.req.param("id");
  const body = await c.req.json<{ content: string; pageContext?: string }>();

  const thread = await c.env.DB.prepare(`SELECT id, title FROM chat_threads WHERE id = ? AND user_id = ?`)
    .bind(threadId, user.userId)
    .first<{ id: string; title: string | null }>();

  if (!thread) {
    return c.json({ error: "Thread not found" }, 404);
  }

  // Capture whether this is the very first exchange in the thread.
  // We need this BEFORE we write the placeholder title so a parallel
  // call doesn't see a title and wrongly skip generation. Read once,
  // remember, and pass through to respondToChat.
  const isFirstExchange = !thread.title;

  const userMsgId = genId("chatMessage");
  await c.env.DB.prepare(
    `INSERT INTO chat_messages (id, user_id, thread_id, role, content, created_at)
     VALUES (?, ?, ?, 'user', ?, datetime('now'))`,
  )
    .bind(userMsgId, user.userId, threadId, body.content)
    .run();

  // Set a sentence-trimmed placeholder title immediately so the
  // sidebar / header read something useful while the LLM-generated
  // title is being computed (it gets overwritten at the end of
  // respondToChat). Without this the user sees "Untitled" until
  // the first exchange completes.
  if (isFirstExchange) {
    await c.env.DB.prepare(`UPDATE chat_threads SET title = ? WHERE id = ? AND user_id = ?`)
      .bind(placeholderChatTitle(body.content), threadId, user.userId)
      .run();
  }

  const chatModel = resolveModel(user.settings?.signalSurfaceMap as Record<string, unknown> | null | undefined, "chat");

  let assistantContent: string;
  let generatedThreadTitle: string | null = null;
  try {
    const resp = await respondToChat(
      c.env.DB,
      user.userId,
      c.env,
      threadId,
      body.content,
      body.pageContext ?? thread.title,
      // Pass the bare model id; respondToChat re-resolves it through
      // the catalog so the spec drives provider dispatch.
      chatModel.model,
      { aboutStatement: user.aboutStatement, focusStatement: user.focusStatement },
      isFirstExchange,
    );
    assistantContent = resp.content;
    generatedThreadTitle = resp.threadTitle ?? null;
  } catch (err) {
    console.error("[chat] respondToChat failed:", err);
    assistantContent = "I'm sorry, I encountered an error processing your message. Please try again.";
  }

  const assistantMsgId = genId("chatMessage");
  await c.env.DB.prepare(
    `INSERT INTO chat_messages (id, user_id, thread_id, role, content, created_at)
     VALUES (?, ?, ?, 'assistant', ?, datetime('now'))`,
  )
    .bind(assistantMsgId, user.userId, threadId, assistantContent)
    .run();

  await c.env.DB.prepare(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .bind(threadId, user.userId)
    .run();

  const [savedUser, savedAssistant] = await Promise.all([
    c.env.DB.prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE id = ? AND user_id = ?`)
      .bind(userMsgId, user.userId)
      .first<{ id: string; role: string; content: string; created_at: string }>(),
    c.env.DB.prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE id = ? AND user_id = ?`)
      .bind(assistantMsgId, user.userId)
      .first<{ id: string; role: string; content: string; created_at: string }>(),
  ]);

  return c.json({
    userMessage: {
      id: savedUser!.id,
      role: savedUser!.role,
      content: savedUser!.content,
      createdAt: savedUser!.created_at,
    },
    assistantMessage: {
      id: savedAssistant!.id,
      role: savedAssistant!.role,
      content: savedAssistant!.content,
      createdAt: savedAssistant!.created_at,
    },
    // Echo the LLM-generated topical title (only on the first
    // exchange) so the client can patch its in-memory thread state
    // without needing a follow-up GET /chat/threads.
    threadTitle: generatedThreadTitle,
  });
});

chatRoutes.post("/chat/threads/:id/messages/stream", async (c) => {
  const user = c.get("user");
  const threadId = c.req.param("id");
  const body = await c.req.json<{ content: string; pageContext?: string }>();

  const thread = await c.env.DB.prepare(`SELECT id, title FROM chat_threads WHERE id = ? AND user_id = ?`)
    .bind(threadId, user.userId)
    .first<{ id: string; title: string | null }>();

  if (!thread) {
    return c.json({ error: "Thread not found" }, 404);
  }

  // Capture first-exchange flag BEFORE writing the placeholder title
  // so the stream knows whether to LLM-generate a topical title at
  // the end. (The placeholder write would otherwise mask the signal.)
  const isFirstExchange = !thread.title;

  const userMsgId = genId("chatMessage");
  await c.env.DB.prepare(
    `INSERT INTO chat_messages (id, user_id, thread_id, role, content, created_at)
     VALUES (?, ?, ?, 'user', ?, datetime('now'))`,
  )
    .bind(userMsgId, user.userId, threadId, body.content)
    .run();

  // Sentence-trimmed placeholder title goes in immediately so the
  // sidebar / header don't sit at "Untitled" while the LLM-generated
  // topical title is being computed at the end of the stream.
  if (isFirstExchange) {
    await c.env.DB.prepare(`UPDATE chat_threads SET title = ? WHERE id = ? AND user_id = ?`)
      .bind(placeholderChatTitle(body.content), threadId, user.userId)
      .run();
  }

  const chatModel = resolveModel(user.settings?.signalSurfaceMap as Record<string, unknown> | null | undefined, "chat");

  const stream = createChatStream(
    c.env.DB,
    user.userId,
    c.env,
    threadId,
    body.content,
    userMsgId,
    body.pageContext ?? thread.title,
    chatModel.model,
    { aboutStatement: user.aboutStatement, focusStatement: user.focusStatement },
    isFirstExchange,
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

/**
 * Speak an assistant chat message back to the user. Mirrors the
 * `/api/piece/:id/audio` endpoint: streams MP3 with `?voice=<id>` as
 * both the per-message override and the Cloudflare cache key. User-message
 * playback is intentionally not supported — the user knows what they typed,
 * and surfacing a "speak my own message" button is just visual noise.
 */
chatRoutes.get("/chat/messages/:messageId/audio", async (c) => {
  const user = c.get("user");
  const messageId = c.req.param("messageId");

  const msg = await c.env.DB.prepare(`SELECT id, role, content FROM chat_messages WHERE id = ? AND user_id = ?`)
    .bind(messageId, user.userId)
    .first<{ id: string; role: string; content: string }>();

  if (!msg) {
    return c.json({ error: "Message not found" }, 404);
  }
  if (msg.role !== "assistant") {
    return c.json({ error: "Only assistant messages can be spoken" }, 400);
  }

  const plainText = chatMarkdownToSpeech(msg.content || "");
  if (!plainText.trim()) {
    return c.json({ error: "No speakable text in this message" }, 400);
  }

  try {
    const override = c.req.query("voice");
    // Cap at 8000 chars — chat replies are usually short, but a verbose
    // explanation can run long. 8000 chars ≈ 6-7 minutes of speech, which is
    // already pushing what anyone wants to listen to in a chat context.
    return await generateTtsResponse(c.env, plainText.slice(0, 8000), resolveTtsModel(user, override, "chat"), {
      db: c.env.DB,
      userId: user.userId,
      operation: "audio_chat_reply",
      ctx: c.executionCtx as { waitUntil(p: Promise<unknown>): void } | undefined,
    });
  } catch (err) {
    return audioErrorResponse("chat reply", err);
  }
});

chatRoutes.delete("/chat/threads/:id", async (c) => {
  const user = c.get("user");
  const threadId = c.req.param("id");

  const thread = await c.env.DB.prepare(`SELECT id FROM chat_threads WHERE id = ? AND user_id = ?`)
    .bind(threadId, user.userId)
    .first();

  if (!thread) {
    return c.json({ error: "Thread not found" }, 404);
  }

  await c.env.DB.prepare(`DELETE FROM chat_messages WHERE thread_id = ? AND user_id = ?`)
    .bind(threadId, user.userId)
    .run();

  await c.env.DB.prepare(`DELETE FROM chat_threads WHERE id = ? AND user_id = ?`).bind(threadId, user.userId).run();

  return c.json({ ok: true });
});
