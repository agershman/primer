import { DEFAULT_MODELS, lookupCatalogById, resolveModel } from "../config/models.js";
import { genId, recordTokenUsage } from "../db/queries.js";
import { llmClient } from "../integrations/llm/dispatcher.js";
import type {
  ContentBlock,
  LLMClient,
  ChatMessage as LlmChatMessage,
  ModelSpec,
  NormalizedUsage,
  ToolDef,
} from "../integrations/llm/types.js";
import type { Env } from "../types.js";

interface ChatContext {
  concepts: Array<{
    canonical_name: string;
    depth_score: number;
    confidence: number;
  }>;
  briefingPieces: Array<{
    title: string;
    piece_type: string;
    concepts: string;
  }>;
  quizAssessments: Array<{
    concept_name: string;
    assessed_depth: number;
    assessment_gaps: string | null;
  }>;
  activeQuizzes: Array<{
    concept_name: string;
    question: string;
  }>;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

const SUMMARY_MAX_TOKENS = 1024;
const RESPONSE_MAX_TOKENS = 4096;
const COMPACTION_THRESHOLD = 40;
const COMPACTION_KEEP_RECENT = 10;

const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "search_web",
    description:
      "Search the web for documentation, articles, and current information to enrich explanations. Read-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_primer_data",
    description:
      "Look up a specific item from the user's Primer data: a concept, briefing, teaching piece, or quiz. Read-only.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string" as const,
          enum: ["concept", "briefing", "piece", "quiz"],
          description: "The type of data to look up",
        },
        id: {
          type: "string" as const,
          description: "The ID of the item to look up",
        },
      },
      required: ["type", "id"],
    },
  },
];

function defaultChatSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.chat);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.chat };
}

/**
 * LLM-generated topical title for a chat thread, modeled on the way
 * Cursor / ChatGPT / Claude name conversations: a tight 3-6 word
 * Title-Case phrase that captures the *topic*, not a verbatim slice
 * of the user's first message.
 *
 * Generated on the very first exchange (when `chat_threads.title` is
 * still NULL). Uses the same chat model the user has configured —
 * cost is negligible (~400 in / ~30 out tokens, well under a cent on
 * Sonnet 4) and avoids the awkwardness of needing a separate
 * provider just for naming.
 *
 * Returns `null` on any failure path (timeout, model error, weirdly
 * shaped output) so the caller can fall back to a placeholder
 * derived from the user's message rather than leaving "Untitled" up.
 */
const TITLE_MAX_TOKENS = 30;
const TITLE_TIMEOUT_MS = 8000;
const TITLE_MIN_CHARS = 12;
const TITLE_MAX_CHARS = 80;

export async function generateChatTitle(
  client: LLMClient,
  spec: ModelSpec,
  userMessage: string,
  assistantMessage: string,
): Promise<{ title: string | null; usage: NormalizedUsage }> {
  const empty: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

  // Don't burn a model call on trivially short exchanges ("hi", "?",
  // "thanks") — the LLM has too little signal and tends to hallucinate
  // a generic title. Caller falls back to the placeholder.
  const combinedLength = userMessage.trim().length + assistantMessage.trim().length;
  if (combinedLength < 40) {
    return { title: null, usage: empty };
  }

  const system =
    "You generate concise, descriptive titles for chat conversations. Output ONLY the title — no quotes, no markdown, no trailing punctuation, no preamble like 'Title:'. Use Title Case. 3-6 words, max 80 characters. Capture the *topic* (what's being discussed), not the action ('How to fix X', not 'Fixing X for the User').";

  const userTurn = [
    "Generate a title for this conversation:",
    "",
    `User: ${userMessage.slice(0, 1500)}`,
    "",
    // Assistant content is much longer than the user message; cap it
    // tighter so we don't pay for tokens that don't add signal to the
    // title-generation task.
    `Assistant: ${assistantMessage.slice(0, 1500)}`,
  ].join("\n");

  try {
    const result = await Promise.race([
      client.createMessage({
        spec,
        maxTokens: TITLE_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userTurn }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("title generation timed out")), TITLE_TIMEOUT_MS),
      ),
    ]);

    const raw = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    // Strip stray quoting / markdown / "Title:" prefixes / trailing
    // punctuation that the model might have leaked despite the
    // instruction. Belt-and-suspenders, not a crutch.
    const cleaned = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^title\s*[:\-—]\s*/i, "")
      .replace(/[.!?,;:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length < TITLE_MIN_CHARS || cleaned.length > TITLE_MAX_CHARS) {
      return { title: null, usage: result.usage };
    }
    // Reject obvious refusals / non-titles ("I cannot generate…",
    // "Here is a title…", anything with sentence-ending punctuation
    // mid-text suggesting it's prose).
    if (/^(i\s|here\b|sorry\b)/i.test(cleaned) || /\.\s/.test(cleaned)) {
      return { title: null, usage: result.usage };
    }

    return { title: cleaned, usage: result.usage };
  } catch {
    return { title: null, usage: empty };
  }
}

/**
 * Conservative immediate-display placeholder derived from the user's
 * first message. Used as a stopgap so the conversation never reads
 * "Untitled" in the sidebar while the LLM-generated title is being
 * computed. Trimmed to a sentence-ish boundary, cropped to ~50 chars.
 */
export function placeholderChatTitle(userMessage: string): string {
  const trimmed = userMessage.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) return "New conversation";
  // Prefer cutting at the first sentence boundary if one's nearby.
  const sentenceBreak = trimmed.search(/[.!?]\s/);
  const cut = sentenceBreak > 0 && sentenceBreak < 50 ? trimmed.slice(0, sentenceBreak) : trimmed.slice(0, 50);
  return cut.length < trimmed.length ? `${cut.trim()}…` : cut.trim();
}

export async function gatherChatContext(db: D1Database, userId: string, threadId: string): Promise<ChatContext> {
  const [conceptsResult, piecesResult, quizzesResult, activeQuizzesResult, messagesResult] = await Promise.all([
    db
      .prepare(
        `SELECT c.canonical_name, cd.depth_score, cd.confidence
         FROM concepts c
         LEFT JOIN concept_depth cd ON c.id = cd.concept_id
         WHERE c.user_id = ?
         ORDER BY cd.last_exposed_at DESC NULLS LAST
         LIMIT 15`,
      )
      .bind(userId)
      .all<{
        canonical_name: string;
        depth_score: number;
        confidence: number;
      }>(),

    db
      .prepare(
        `SELECT tp.title, tp.piece_type, tp.concepts
         FROM teaching_pieces tp
         JOIN briefings b ON tp.briefing_id = b.id
         WHERE tp.user_id = ? AND b.briefing_date = date('now')
         ORDER BY tp.created_at DESC`,
      )
      .bind(userId)
      .all<{ title: string; piece_type: string; concepts: string }>(),

    db
      .prepare(
        `SELECT c.canonical_name as concept_name,
                cq.assessed_depth, cq.assessment_gaps
         FROM calibration_quizzes cq
         JOIN concepts c ON cq.concept_id = c.id
         WHERE cq.user_id = ? AND cq.status = 'answered'
         ORDER BY cq.completed_at DESC
         LIMIT 3`,
      )
      .bind(userId)
      .all<{
        concept_name: string;
        assessed_depth: number;
        assessment_gaps: string | null;
      }>(),

    db
      .prepare(
        `SELECT c.canonical_name as concept_name, cq.question
         FROM calibration_quizzes cq
         JOIN concepts c ON cq.concept_id = c.id
         WHERE cq.user_id = ? AND cq.status = 'pending'
         ORDER BY cq.created_at DESC
         LIMIT 10`,
      )
      .bind(userId)
      .all<{ concept_name: string; question: string }>(),

    db
      .prepare(
        `SELECT role, content
         FROM chat_messages
         WHERE thread_id = ? AND user_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(threadId, userId)
      .all<{ role: "user" | "assistant"; content: string }>(),
  ]);

  return {
    concepts: conceptsResult.results,
    briefingPieces: piecesResult.results,
    quizAssessments: quizzesResult.results,
    activeQuizzes: activeQuizzesResult.results,
    conversationHistory: messagesResult.results.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  };
}

async function compactConversation(
  client: LLMClient,
  spec: ModelSpec,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<{
  summary: string;
  usage: NormalizedUsage;
}> {
  const toSummarize = messages.slice(0, messages.length - COMPACTION_KEEP_RECENT);
  const transcript = toSummarize.map((m) => `${m.role}: ${m.content}`).join("\n\n");

  const response = await client.createMessage({
    spec,
    maxTokens: SUMMARY_MAX_TOKENS,
    system:
      "Summarize this conversation concisely, preserving key facts, decisions, and context. " +
      "This summary will replace the messages in the conversation window. Be thorough but brief.",
    messages: [{ role: "user", content: transcript }],
  });

  const firstText = response.content.find((b): b is ContentBlock & { type: "text" } => b.type === "text");
  return {
    summary: firstText?.text ?? "",
    usage: response.usage,
  };
}

export function buildSystemPrompt(
  context: ChatContext,
  pageContext?: string | null,
  options: { aboutStatement?: string | null; focusStatement?: string | null } = {},
): string {
  const { aboutStatement = null, focusStatement = null } = options;
  const conceptLines = context.concepts.length
    ? context.concepts
        .map((c) => `- ${c.canonical_name} (depth: ${c.depth_score}, confidence: ${c.confidence})`)
        .join("\n")
    : "(no concepts yet)";

  const pieceLines = context.briefingPieces.length
    ? context.briefingPieces.map((p) => `- [${p.piece_type}] ${p.title}`).join("\n")
    : "(no briefing today)";

  const quizLines = context.quizAssessments.length
    ? context.quizAssessments
        .map(
          (q) =>
            `- ${q.concept_name}: depth ${q.assessed_depth}${q.assessment_gaps ? ` — gaps: ${q.assessment_gaps}` : ""}`,
        )
        .join("\n")
    : "(no recent quizzes)";

  const pageLine = pageContext
    ? `The user is currently viewing: ${pageContext}`
    : "The user has no specific page context.";

  const aboutBlock = aboutStatement
    ? `\nABOUT THE USER (use to calibrate tone, depth, and audience modeling — never quote back):\n${aboutStatement.trim()}\n`
    : "";

  const focusBlock = focusStatement
    ? `\nUSER'S CURRENT FOCUS (areas they're currently learning about):\n${focusStatement.trim()}\n`
    : "";

  return `You are Primer's built-in assistant. You help the user understand and engage with their learning content within Primer.
${aboutBlock}${focusBlock}

You CAN:
- Explain concepts from their concept graph in more depth
- Discuss teaching pieces from their briefings
- Clarify quiz assessments, gaps, and learning paths
- Analyze their depth scores, trends, and decay patterns
- Suggest which concepts to focus on or calibrate next
- Reference their Linear tickets, Slack threads, or incidents that appear in their work context
- Look up documentation, articles, and current information from the web to enrich explanations
- Pull additional context from Primer's data sources to answer questions about their work

You CANNOT:
- Modify, write to, or take action on any external system — strictly read-only
- Create, update, or close tickets, post messages, or trigger workflows
- Act as a general-purpose coding assistant or write production code
- Make up information — only reference data from context or cite sources
- Help the user cheat on calibration quizzes (see CALIBRATION INTEGRITY below)

You are READ-ONLY with respect to all systems. If the user asks you to take an action on an external system, explain that Primer's chat is read-only and suggest they take that action directly in the relevant tool.

CITATIONS: When linking to sources, only link to specific pages (docs, blog posts, RFCs, GitHub repos). Never link to company homepages or Wikipedia. If you can't cite a specific source, state the fact without a link. Qualify uncertain claims rather than asserting them.

CALIBRATION INTEGRITY:
${context.activeQuizzes.length > 0 ? `The user has ${context.activeQuizzes.length} pending calibration quiz(zes) on: ${context.activeQuizzes.map((q) => q.concept_name).join(", ")}.` : "No active calibration quizzes."}
${
  context.activeQuizzes.length > 0 || (pageContext && pageContext.includes("calibrat"))
    ? `The user may be taking or about to take a calibration quiz. You MUST NOT:
- Directly answer quiz questions or provide model answers
- Explain the specific concept being quizzed in a way that would give away the answer
- Provide frameworks, checklists, or structured answers the user could copy-paste
- Help them "prepare" for a specific quiz question they've just seen

If the user asks you something that is clearly the quiz question (or closely paraphrased), kindly decline and explain:
"I can see you're working on a calibration quiz. I want to help you learn, but giving you the answer would undermine the calibration — Primer needs to know what you genuinely understand so it can target your briefings to the right depth. If you're unsure, it's much better to say 'I don't know' or give your honest best attempt. After you submit, I'm happy to discuss the concept in depth and help you fill any gaps the assessment identifies."

You CAN still:
- Discuss concepts the user has ALREADY been assessed on (past quizzes, not pending ones)
- Help the user understand their assessment results after submission
- Explain general learning strategies
- Answer questions clearly unrelated to any pending quiz topic`
    : ""
}

Current concept graph (top 15 by recent activity):
${conceptLines}

Today's briefing:
${pieceLines}

Recent quiz results:
${quizLines}

${pageLine}`;
}

async function executeToolCall(
  db: D1Database,
  userId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  if (toolName === "search_web") {
    return JSON.stringify({
      error: "Web search is not yet configured. This feature will be available soon.",
      query: toolInput.query,
    });
  }

  if (toolName === "lookup_primer_data") {
    const dataType = toolInput.type as string;
    const id = toolInput.id as string;

    switch (dataType) {
      case "concept": {
        const row = await db
          .prepare(
            `SELECT c.*, cd.depth_score, cd.confidence, cd.last_exposed_at, cd.exposure_count
             FROM concepts c
             LEFT JOIN concept_depth cd ON c.id = cd.concept_id
             WHERE c.id = ? AND c.user_id = ?`,
          )
          .bind(id, userId)
          .first();
        return JSON.stringify(row ?? { error: "Concept not found" });
      }
      case "briefing": {
        const row = await db.prepare(`SELECT * FROM briefings WHERE id = ? AND user_id = ?`).bind(id, userId).first();
        return JSON.stringify(row ?? { error: "Briefing not found" });
      }
      case "piece": {
        const row = await db
          .prepare(`SELECT * FROM teaching_pieces WHERE id = ? AND user_id = ?`)
          .bind(id, userId)
          .first();
        return JSON.stringify(row ?? { error: "Teaching piece not found" });
      }
      case "quiz": {
        const row = await db
          .prepare(
            `SELECT cq.*, c.canonical_name as concept_name
             FROM calibration_quizzes cq
             JOIN concepts c ON cq.concept_id = c.id
             WHERE cq.id = ? AND cq.user_id = ?`,
          )
          .bind(id, userId)
          .first();
        return JSON.stringify(row ?? { error: "Quiz not found" });
      }
      default:
        return JSON.stringify({ error: `Unknown data type: ${dataType}` });
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${toolName}` });
}

export interface ChatPersona {
  aboutStatement?: string | null;
  focusStatement?: string | null;
}

/**
 * Resolve the chat model from either a structured override or the
 * legacy bare-string override path used by the chat routes today.
 */
function resolveChatSpec(_env: Env, modelOverride?: string): ModelSpec {
  if (!modelOverride) return defaultChatSpec();
  // Re-use the catalog-aware resolver. Falls back to default if invalid.
  return resolveModel({ models: { chat: modelOverride } }, "chat");
}

export async function respondToChat(
  db: D1Database,
  userId: string,
  env: Env,
  threadId: string,
  userMessage: string,
  pageContext?: string | null,
  modelOverride?: string,
  persona: ChatPersona = {},
  isFirstExchange = false,
): Promise<{
  content: string;
  usage: NormalizedUsage;
  modelUsed: string;
  /**
   * LLM-generated topical title, returned only on the first
   * exchange of a thread. The route handler persists it and echoes
   * it back to the client so the UI can update without re-fetching.
   * Null if generation failed — caller leaves whatever placeholder
   * is already on the thread row in place.
   */
  threadTitle?: string | null;
}> {
  const spec = resolveChatSpec(env, modelOverride);
  const client = llmClient(env);
  const context = await gatherChatContext(db, userId, threadId);

  const totalUsage: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

  let conversationMessages: LlmChatMessage[] = [];

  if (context.conversationHistory.length > COMPACTION_THRESHOLD) {
    const { summary, usage: compactUsage } = await compactConversation(client, spec, context.conversationHistory);
    totalUsage.inputTokens += compactUsage.inputTokens;
    totalUsage.outputTokens += compactUsage.outputTokens;

    const recentMessages = context.conversationHistory.slice(-COMPACTION_KEEP_RECENT);
    conversationMessages = [
      {
        role: "user",
        content: `[Conversation summary so far]\n${summary}`,
      },
      { role: "assistant", content: "Understood — I have the context. Go on." },
      ...recentMessages,
    ];

    await db
      .prepare(
        `UPDATE chat_threads SET summary = ?, compacted_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      )
      .bind(summary, threadId, userId)
      .run();
  } else {
    conversationMessages = context.conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  conversationMessages.push({ role: "user", content: userMessage });

  const systemPrompt = buildSystemPrompt(context, pageContext, persona);

  let response = await client.createMessage({
    spec,
    maxTokens: RESPONSE_MAX_TOKENS,
    system: systemPrompt,
    tools: TOOL_DEFINITIONS,
    messages: conversationMessages,
  });

  totalUsage.inputTokens += response.usage.inputTokens;
  totalUsage.outputTokens += response.usage.outputTokens;

  const MAX_TOOL_ROUNDS = 5;
  let toolRound = 0;

  while (toolRound < MAX_TOOL_ROUNDS && response.stopReason === "tool_use") {
    toolRound++;
    const toolUseBlocks = response.content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) break;

    conversationMessages.push({
      role: "assistant",
      content: response.content,
    });

    const toolResultBlocks: ContentBlock[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeToolCall(db, userId, block.name, block.input);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    conversationMessages.push({ role: "user", content: toolResultBlocks });

    response = await client.createMessage({
      spec,
      maxTokens: RESPONSE_MAX_TOKENS,
      system: systemPrompt,
      tools: TOOL_DEFINITIONS,
      messages: conversationMessages,
    });

    totalUsage.inputTokens += response.usage.inputTokens;
    totalUsage.outputTokens += response.usage.outputTokens;
  }

  const textBlocks = response.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");
  const assistantContent = textBlocks.map((b) => b.text).join("\n\n") || "I wasn't able to generate a response.";

  await recordTokenUsage(db, userId, "chat", spec, totalUsage);

  // First-exchange title generation — see createChatStream for the
  // mirroring logic on the streaming path. Persists to the row and
  // echoes back so the route can return it on the wire.
  let threadTitle: string | null = null;
  if (isFirstExchange) {
    const { title, usage: titleUsage } = await generateChatTitle(client, spec, userMessage, assistantContent);
    if (title) {
      await db
        .prepare(
          `UPDATE chat_threads SET title = ?, updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`,
        )
        .bind(title, threadId, userId)
        .run();
      threadTitle = title;
    }
    if (titleUsage.inputTokens || titleUsage.outputTokens) {
      await recordTokenUsage(db, userId, "chat_title", spec, titleUsage);
    }
  }

  return {
    content: assistantContent,
    usage: totalUsage,
    modelUsed: spec.model,
    threadTitle,
  };
}

export function createChatStream(
  db: D1Database,
  userId: string,
  env: Env,
  threadId: string,
  userMessage: string,
  userMsgId: string,
  pageContext?: string | null,
  modelOverride?: string,
  persona: ChatPersona = {},
  /**
   * True if the thread had no real title at the start of this
   * exchange — i.e. this is the first user/assistant turn. The route
   * passes this in so the stream can decide whether to LLM-generate
   * a topical title once the response is done.
   */
  isFirstExchange = false,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  function sseEvent(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return new ReadableStream({
    async start(controller) {
      try {
        const spec = resolveChatSpec(env, modelOverride);
        const client = llmClient(env);
        const context = await gatherChatContext(db, userId, threadId);

        const totalUsage: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };
        let conversationMessages: LlmChatMessage[] = [];

        if (context.conversationHistory.length > COMPACTION_THRESHOLD) {
          const { summary, usage: compactUsage } = await compactConversation(client, spec, context.conversationHistory);
          totalUsage.inputTokens += compactUsage.inputTokens;
          totalUsage.outputTokens += compactUsage.outputTokens;

          const recentMessages = context.conversationHistory.slice(-COMPACTION_KEEP_RECENT);
          conversationMessages = [
            { role: "user", content: `[Conversation summary so far]\n${summary}` },
            { role: "assistant", content: "Understood — I have the context. Go on." },
            ...recentMessages,
          ];

          await db
            .prepare(
              `UPDATE chat_threads SET summary = ?, compacted_at = datetime('now')
               WHERE id = ? AND user_id = ?`,
            )
            .bind(summary, threadId, userId)
            .run();
        } else {
          conversationMessages = context.conversationHistory.map((m) => ({
            role: m.role,
            content: m.content,
          }));
        }

        conversationMessages.push({ role: "user", content: userMessage });

        const systemPrompt = buildSystemPrompt(context, pageContext, persona);
        let fullText = "";
        let toolRound = 0;

        const MAX_TOOL_ROUNDS = 5;
        let needsToolLoop = true;

        while (needsToolLoop && toolRound <= MAX_TOOL_ROUNDS) {
          needsToolLoop = false;
          let currentToolUseId = "";
          let currentToolName = "";
          let currentToolInput = "";
          const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
          let roundText = "";

          for await (const event of client.streamMessage({
            spec,
            maxTokens: RESPONSE_MAX_TOKENS,
            system: systemPrompt,
            tools: TOOL_DEFINITIONS,
            messages: conversationMessages,
          })) {
            if (event.type === "message_start" && event.usage) {
              totalUsage.inputTokens += event.usage.inputTokens;
            }
            if (event.type === "text_delta" && event.text) {
              fullText += event.text;
              roundText += event.text;
              controller.enqueue(sseEvent("delta", { text: event.text }));
            }
            if (event.type === "tool_use_start") {
              currentToolUseId = event.toolUseId ?? "";
              currentToolName = event.toolName ?? "";
              currentToolInput = "";
              controller.enqueue(sseEvent("tool_start", { tool: currentToolName }));
            }
            if (event.type === "tool_input_delta") {
              currentToolInput += event.partialJson ?? "";
            }
            if (event.type === "content_block_stop" && currentToolUseId) {
              let parsedInput: Record<string, unknown> = {};
              try {
                parsedInput = JSON.parse(currentToolInput || "{}");
              } catch {
                // empty
              }
              pendingToolUses.push({
                id: currentToolUseId,
                name: currentToolName,
                input: parsedInput,
              });
              currentToolUseId = "";
              currentToolName = "";
              currentToolInput = "";
            }
            if (event.type === "message_delta") {
              if (event.usage) {
                totalUsage.outputTokens += event.usage.outputTokens;
              }
              if (event.stopReason === "tool_use" && pendingToolUses.length > 0) {
                needsToolLoop = true;
              }
            }
            if (event.type === "error") {
              controller.enqueue(sseEvent("error", { message: event.text }));
              controller.close();
              return;
            }
          }

          if (needsToolLoop && pendingToolUses.length > 0) {
            toolRound++;

            const assistantContent: ContentBlock[] = [];
            if (roundText) {
              assistantContent.push({ type: "text", text: roundText });
            }
            for (const tu of pendingToolUses) {
              assistantContent.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: tu.input,
              });
            }
            conversationMessages.push({ role: "assistant", content: assistantContent });

            const toolResults: ContentBlock[] = [];
            for (const tu of pendingToolUses) {
              const result = await executeToolCall(db, userId, tu.name, tu.input);
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: result,
              });
            }
            conversationMessages.push({ role: "user", content: toolResults });

            controller.enqueue(sseEvent("tool_end", { tools: pendingToolUses.map((t) => t.name) }));
          }
        }

        const assistantContent = fullText || "I wasn't able to generate a response.";

        const assistantMsgId = genId("chatMessage");
        await db
          .prepare(
            `INSERT INTO chat_messages (id, user_id, thread_id, role, content, created_at)
             VALUES (?, ?, ?, 'assistant', ?, datetime('now'))`,
          )
          .bind(assistantMsgId, userId, threadId, assistantContent)
          .run();

        await db
          .prepare(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
          .bind(threadId, userId)
          .run();

        await recordTokenUsage(db, userId, "chat", spec, totalUsage);

        const [savedUser, savedAssistant] = await Promise.all([
          db
            .prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE id = ?`)
            .bind(userMsgId)
            .first<{ id: string; role: string; content: string; created_at: string }>(),
          db
            .prepare(`SELECT id, role, content, created_at FROM chat_messages WHERE id = ?`)
            .bind(assistantMsgId)
            .first<{ id: string; role: string; content: string; created_at: string }>(),
        ]);

        controller.enqueue(
          sseEvent("done", {
            userMessage: savedUser
              ? { id: savedUser.id, role: savedUser.role, content: savedUser.content, createdAt: savedUser.created_at }
              : { id: userMsgId, role: "user", content: userMessage, createdAt: new Date().toISOString() },
            assistantMessage: savedAssistant
              ? {
                  id: savedAssistant.id,
                  role: savedAssistant.role,
                  content: savedAssistant.content,
                  createdAt: savedAssistant.created_at,
                }
              : {
                  id: assistantMsgId,
                  role: "assistant",
                  content: assistantContent,
                  createdAt: new Date().toISOString(),
                },
          }),
        );

        // First-message thread title generation runs *after* `done` so
        // the user sees the response render immediately and the title
        // appears a moment later. Modeled on Cursor / ChatGPT / Claude:
        // a tight 3-6 word topical summary of the conversation, NOT
        // a verbatim slice of the user's message.
        //
        // We use a CAS-style update (only set the title if it's still
        // the placeholder we wrote at message-send time) so a parallel
        // / racy second message can't have its title clobbered. If
        // generation fails for any reason, we leave the placeholder
        // in place — that's already a big improvement over "Untitled".
        if (isFirstExchange) {
          const { title, usage: titleUsage } = await generateChatTitle(client, spec, userMessage, assistantContent);
          if (title) {
            await db
              .prepare(
                `UPDATE chat_threads SET title = ?, updated_at = datetime('now')
                 WHERE id = ? AND user_id = ?`,
              )
              .bind(title, threadId, userId)
              .run();
            controller.enqueue(sseEvent("title", { title }));
          }
          if (titleUsage.inputTokens || titleUsage.outputTokens) {
            await recordTokenUsage(db, userId, "chat_title", spec, titleUsage);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[chat-stream] error:", msg);
        controller.enqueue(sseEvent("error", { message: msg }));
      } finally {
        controller.close();
      }
    },
  });
}

export { COMPACTION_KEEP_RECENT, COMPACTION_THRESHOLD, TOOL_DEFINITIONS };
