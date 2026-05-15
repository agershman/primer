import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";

export interface ConversationInsight {
  threadId: string;
  title: string;
  url?: string;
  channel?: string;
  topics: string[];
  questionsRaised: string[];
  decisionsOrOutcomes: string[];
  knowledgeGaps: string[];
  learningOpportunities: string[];
  summary: string;
  participantCount: number;
  messageCount: number;
}

interface AnalyzerInput {
  threadId: string;
  title: string;
  url?: string;
  channel?: string;
  messages: string[];
  participantCount: number;
  /** Texts of messages within this thread that carry an explicit
   *  `:bookmark:` reaction. When non-empty, the analyzer prompt
   *  highlights them as the user-flagged emphasis points so the model
   *  weights its summary / learningOpportunities toward them rather
   *  than treating every reply equally. Optional — most threads have
   *  no emphasis. */
  bookmarkedExcerpts?: string[];
}

interface AnalysisResult {
  topics: string[];
  questionsRaised: string[];
  decisionsOrOutcomes: string[];
  knowledgeGaps: string[];
  learningOpportunities: string[];
  summary: string;
}

const MAX_THREADS_TO_ANALYZE = 8;
const MAX_MESSAGES_PER_THREAD = 20;
const MAX_CHARS_PER_THREAD = 3000;

function defaultAnalyzerSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.conceptExtraction);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.conceptExtraction };
}

export async function analyzeSlackConversations(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  threads: AnalyzerInput[],
  modelSpec?: ModelSpec,
): Promise<ConversationInsight[]> {
  if (threads.length === 0) return [];

  const spec = modelSpec ?? defaultAnalyzerSpec();
  const substantive = threads.filter((t) => t.messages.length >= 2).slice(0, MAX_THREADS_TO_ANALYZE);

  if (substantive.length === 0) return [];

  const threadBlocks = substantive.map((t) => {
    const msgs = t.messages.slice(0, MAX_MESSAGES_PER_THREAD);
    const transcript = msgs.join("\n---\n").slice(0, MAX_CHARS_PER_THREAD);
    // When specific messages within the thread carry a `:bookmark:`
    // reaction, surface them as an emphasized block AHEAD of the
    // transcript. The block uses a clearly-labeled sentinel
    // (`[EMPHASIS — BOOKMARKED MESSAGES]`) the system prompt knows to
    // weight more heavily when picking learningOpportunities and the
    // summary. Cap at ~5 excerpts to keep the prompt budget bounded.
    const emphasisBlock =
      t.bookmarkedExcerpts && t.bookmarkedExcerpts.length > 0
        ? `\n\n[EMPHASIS — BOOKMARKED MESSAGES] The user explicitly flagged these messages with a \`:bookmark:\` reaction; weight them above the rest of the transcript when picking topics + learning opportunities:\n${t.bookmarkedExcerpts
            .slice(0, 5)
            .map((e, i) => `${i + 1}. ${e.slice(0, 400)}`)
            .join("\n")}`
        : "";
    return `## Thread: ${t.title.slice(0, 100)}\nParticipants: ${t.participantCount} | Messages: ${t.messages.length}${emphasisBlock}\n\n${transcript}`;
  });

  const system = `You analyze Slack conversations to identify learning opportunities for a software engineer.

For each thread, identify:
- topics: Technical topics discussed (2-5 keywords each)
- questionsRaised: Questions that were asked or implied (verbatim or paraphrased)
- decisionsOrOutcomes: Decisions made, conclusions reached, or actions taken
- knowledgeGaps: Areas where participants showed uncertainty, asked for help, or debated without resolution
- learningOpportunities: Specific things someone could learn from this conversation (e.g. "How Karpenter handles node consolidation" or "Tradeoffs between ALB and NLB for gRPC")
- summary: One sentence capturing the conversation's core topic and outcome

Focus on TECHNICAL substance. Skip social chatter, scheduling logistics, and off-topic tangents.
For learningOpportunities, be specific and actionable — not "learn about Kubernetes" but "How pod disruption budgets interact with node draining during consolidation."

EMPHASIS — when a thread block begins with \`[EMPHASIS — BOOKMARKED MESSAGES]\`, the listed excerpts were explicitly flagged by the reader. Weight them above the rest of the transcript when picking topics + learningOpportunities, and let them steer the summary toward what the reader actually saved. Anchor at least one learningOpportunity to the substance of the bookmarked excerpts when possible.

Return JSON: { "threads": [{ "threadIndex": 0, "topics": [...], "questionsRaised": [...], "decisionsOrOutcomes": [...], "knowledgeGaps": [...], "learningOpportunities": [...], "summary": "..." }, ...] }`;

  const userMessage = threadBlocks.join("\n\n---\n\n");

  try {
    const { result, usage } = await llm.generateJson<{
      threads: Array<{
        threadIndex: number;
        topics: string[];
        questionsRaised: string[];
        decisionsOrOutcomes: string[];
        knowledgeGaps: string[];
        learningOpportunities: string[];
        summary: string;
      }>;
    }>({ spec, system, user: userMessage });

    await recordTokenUsage(db, userId, "slack_analysis", spec, usage);

    const insights: ConversationInsight[] = [];
    for (const analyzed of result.threads ?? []) {
      const source = substantive[analyzed.threadIndex];
      if (!source) continue;
      insights.push({
        threadId: source.threadId,
        title: source.title,
        url: source.url,
        channel: source.channel,
        topics: analyzed.topics ?? [],
        questionsRaised: analyzed.questionsRaised ?? [],
        decisionsOrOutcomes: analyzed.decisionsOrOutcomes ?? [],
        knowledgeGaps: analyzed.knowledgeGaps ?? [],
        learningOpportunities: analyzed.learningOpportunities ?? [],
        summary: analyzed.summary ?? "",
        participantCount: source.participantCount,
        messageCount: source.messages.length,
      });
    }

    return insights;
  } catch (err) {
    console.error("[slack-analyzer] Analysis failed:", err);
    return [];
  }
}
