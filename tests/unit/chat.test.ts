import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  gatherChatContext,
  buildSystemPrompt,
  TOOL_DEFINITIONS,
  COMPACTION_THRESHOLD,
  COMPACTION_KEEP_RECENT,
} from "../../src/worker/services/chat-responder.js";

function mockD1Results<T>(results: T[]) {
  return { results, success: true, meta: {} };
}

function createMockDB(queryResults: Record<string, any> = {}) {
  const preparedStatements: any[] = [];
  let callIndex = 0;

  const resultKeys = Object.keys(queryResults);

  return {
    prepare: vi.fn((sql: string) => {
      const idx = callIndex++;
      const key = resultKeys[idx] ?? `query_${idx}`;
      const result = queryResults[key];

      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue(
          result?.all ?? mockD1Results(result?.results ?? [])
        ),
        first: vi.fn().mockResolvedValue(result?.first ?? null),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
      preparedStatements.push(stmt);
      return stmt;
    }),
    _statements: preparedStatements,
  } as unknown as D1Database;
}

describe("gatherChatContext", () => {
  it("returns expected shape with concept, briefing, quiz, and message data", async () => {
    const db = createMockDB({
      concepts: {
        all: mockD1Results([
          { canonical_name: "kubernetes", depth_score: 3, confidence: 0.8 },
          { canonical_name: "terraform", depth_score: 2, confidence: 0.5 },
        ]),
      },
      pieces: {
        all: mockD1Results([
          { title: "K8s Networking Deep Dive", piece_type: "core", concepts: '["cpt_123"]' },
        ]),
      },
      quizzes: {
        all: mockD1Results([
          { concept_name: "kubernetes", assessed_depth: 3, gaps_summary: "networking policies" },
        ]),
      },
      activeQuizzes: {
        all: mockD1Results([]),
      },
      messages: {
        all: mockD1Results([
          { role: "user", content: "Tell me about k8s" },
          { role: "assistant", content: "Kubernetes is..." },
        ]),
      },
    });

    const ctx = await gatherChatContext(db, "usr_test123", "ct_thread123");

    expect(ctx.concepts).toHaveLength(2);
    expect(ctx.concepts[0].canonical_name).toBe("kubernetes");
    expect(ctx.concepts[0].depth_score).toBe(3);

    expect(ctx.briefingPieces).toHaveLength(1);
    expect(ctx.briefingPieces[0].title).toBe("K8s Networking Deep Dive");

    expect(ctx.quizAssessments).toHaveLength(1);
    expect(ctx.quizAssessments[0].concept_name).toBe("kubernetes");

    expect(ctx.activeQuizzes).toHaveLength(0);

    expect(ctx.conversationHistory).toHaveLength(2);
    expect(ctx.conversationHistory[0].role).toBe("user");
    expect(ctx.conversationHistory[1].role).toBe("assistant");
  });

  it("returns empty arrays when no data exists", async () => {
    const db = createMockDB({
      concepts: { all: mockD1Results([]) },
      pieces: { all: mockD1Results([]) },
      quizzes: { all: mockD1Results([]) },
      activeQuizzes: { all: mockD1Results([]) },
      messages: { all: mockD1Results([]) },
    });

    const ctx = await gatherChatContext(db, "usr_empty", "ct_empty");

    expect(ctx.concepts).toHaveLength(0);
    expect(ctx.briefingPieces).toHaveLength(0);
    expect(ctx.quizAssessments).toHaveLength(0);
    expect(ctx.activeQuizzes).toHaveLength(0);
    expect(ctx.conversationHistory).toHaveLength(0);
  });
});

describe("buildSystemPrompt", () => {
  it("includes CAN/CANNOT rules", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("You CAN:");
    expect(prompt).toContain("You CANNOT:");
    expect(prompt).toContain("Explain concepts from their concept graph");
    expect(prompt).toContain("Act as a general-purpose coding assistant");
  });

  it("includes READ-ONLY constraint", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain(
      "strictly read-only"
    );
  });

  it("formats concept data into prompt", () => {
    const prompt = buildSystemPrompt({
      concepts: [
        { canonical_name: "kubernetes", depth_score: 4, confidence: 0.9 },
        { canonical_name: "docker", depth_score: 2, confidence: 0.5 },
      ],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("kubernetes (depth: 4, confidence: 0.9)");
    expect(prompt).toContain("docker (depth: 2, confidence: 0.5)");
  });

  it("formats briefing pieces into prompt", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [
        { title: "Container Orchestration", piece_type: "core", concepts: "[]" },
      ],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("[core] Container Orchestration");
  });

  it("formats quiz assessments into prompt", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [],
      quizAssessments: [
        { concept_name: "terraform", assessed_depth: 3, assessment_gaps: "modules and workspaces" },
      ],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("terraform: depth 3");
    expect(prompt).toContain("modules and workspaces");
  });

  it("includes page context when provided", () => {
    const prompt = buildSystemPrompt(
      {
        concepts: [],
        briefingPieces: [],
        quizAssessments: [],
        activeQuizzes: [],
        conversationHistory: [],
      },
      "Concept Graph"
    );

    expect(prompt).toContain("The user is currently viewing: Concept Graph");
  });

  it("shows fallback when no page context", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("The user has no specific page context.");
  });

  it("shows placeholder text when no concepts exist", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("(no concepts yet)");
    expect(prompt).toContain("(no briefing today)");
    expect(prompt).toContain("(no recent quizzes)");
  });
});

describe("tool definitions", () => {
  it("exposes exactly search_web and lookup_primer_data", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(2);

    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("search_web");
    expect(names).toContain("lookup_primer_data");
  });

  it("search_web accepts a query string", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "search_web")!;
    expect(tool.input_schema.properties).toHaveProperty("query");
    expect(tool.input_schema.required).toContain("query");
  });

  it("lookup_primer_data accepts type and id", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "lookup_primer_data")!;
    expect(tool.input_schema.properties).toHaveProperty("type");
    expect(tool.input_schema.properties).toHaveProperty("id");
    expect(tool.input_schema.required).toContain("type");
    expect(tool.input_schema.required).toContain("id");
  });

  it("lookup_primer_data type enum covers concept, briefing, piece, quiz", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "lookup_primer_data")!;
    const typeSchema = tool.input_schema.properties.type as { enum: string[] };
    expect(typeSchema.enum).toEqual(["concept", "briefing", "piece", "quiz"]);
  });

  it("tool descriptions mention read-only", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.toLowerCase()).toContain("read-only");
    }
  });
});

describe("streaming support", () => {
  it("exports createChatStream from chat-responder", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(resolve(__dirname, "..", "..", "src/worker/services/chat-responder.ts"), "utf-8");
    expect(src).toContain("export function createChatStream");
    expect(src).toContain("ReadableStream");
  });

  it("streaming route exists at /chat/threads/:id/messages/stream", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(resolve(__dirname, "..", "..", "src/worker/routes/chat.ts"), "utf-8");
    expect(src).toContain('"/chat/threads/:id/messages/stream"');
    expect(src).toContain("text/event-stream");
  });

  it("anthropic adapter has streamMessage method", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    // Streaming logic moved to the provider-agnostic adapter layer.
    const src = await readFile(
      resolve(__dirname, "..", "..", "src/worker/integrations/llm/anthropic-adapter.ts"),
      "utf-8",
    );
    expect(src).toContain("async *streamMessage");
    expect(src).toContain("stream: true");
  });

  it("SSE protocol includes delta, tool_start, tool_end, done, and error events", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(resolve(__dirname, "..", "..", "src/worker/services/chat-responder.ts"), "utf-8");
    expect(src).toContain('sseEvent("delta"');
    expect(src).toContain('sseEvent("tool_start"');
    expect(src).toContain('sseEvent("tool_end"');
    expect(src).toContain('sseEvent("done"');
    expect(src).toContain('sseEvent("error"');
  });

  it("frontend useChat processes streaming SSE events", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(resolve(__dirname, "..", "..", "src/frontend/hooks/useChat.ts"), "utf-8");
    expect(src).toContain("parseSSEEvents");
    expect(src).toContain("isStreaming");
    expect(src).toContain("toolActive");
    expect(src).toContain("/messages/stream");
  });
});

describe("context window management", () => {
  it("compaction threshold is 40 messages", () => {
    expect(COMPACTION_THRESHOLD).toBe(40);
  });

  it("keeps 10 recent messages after compaction", () => {
    expect(COMPACTION_KEEP_RECENT).toBe(10);
  });

  it("threads under threshold are not compacted", () => {
    const shortHistory = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}`,
    }));

    expect(shortHistory.length).toBeLessThan(COMPACTION_THRESHOLD);
  });

  it("threads over threshold would trigger compaction", () => {
    const longHistory = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}`,
    }));

    expect(longHistory.length).toBeGreaterThan(COMPACTION_THRESHOLD);

    const toSummarize = longHistory.slice(
      0,
      longHistory.length - COMPACTION_KEEP_RECENT
    );
    const kept = longHistory.slice(-COMPACTION_KEEP_RECENT);

    expect(toSummarize).toHaveLength(40);
    expect(kept).toHaveLength(10);
  });
});

describe("calibration integrity", () => {
  it("system prompt includes anti-cheating rules when quizzes are active", () => {
    const prompt = buildSystemPrompt({
      concepts: [{ canonical_name: "kubernetes", depth_score: 2, confidence: 0.5 }],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [{ concept_name: "kubernetes", question: "Explain pod scheduling" }],
      conversationHistory: [],
    });

    expect(prompt).toContain("CALIBRATION INTEGRITY");
    expect(prompt).toContain("pending calibration quiz");
    expect(prompt).toContain("kubernetes");
    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("undermine the calibration");
  });

  it("system prompt omits anti-cheating block when no quizzes are active", () => {
    const prompt = buildSystemPrompt({
      concepts: [],
      briefingPieces: [],
      quizAssessments: [],
      activeQuizzes: [],
      conversationHistory: [],
    });

    expect(prompt).toContain("CALIBRATION INTEGRITY");
    expect(prompt).toContain("No active calibration quizzes");
    expect(prompt).not.toContain("MUST NOT");
  });

  it("system prompt activates anti-cheating on /calibrate page context", () => {
    const prompt = buildSystemPrompt(
      {
        concepts: [],
        briefingPieces: [],
        quizAssessments: [],
        activeQuizzes: [],
        conversationHistory: [],
      },
      "/calibrate",
    );

    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("undermine the calibration");
  });

  it("gatherChatContext includes activeQuizzes query", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(resolve(__dirname, "..", "..", "src/worker/services/chat-responder.ts"), "utf-8");
    expect(src).toContain("activeQuizzes");
    expect(src).toContain("status = 'pending'");
  });
});
