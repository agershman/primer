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
    return `## Thread: ${t.title.slice(0, 100)}\nParticipants: ${t.participantCount} | Messages: ${t.messages.length}\n\n${transcript}`;
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
