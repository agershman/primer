import { DEPTH_LABELS } from "../config/constants.js";
import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";

interface QuizQuestion {
  question: string;
  context: string;
  expectedDepthIndicators: Record<string, string>;
}

interface GeneratedQuiz extends QuizQuestion {
  modelUsed: string;
}

interface GapDetail {
  summary: string;
  specifics: string[];
}

interface LearningPathItem {
  action: string;
  rationale: string;
  resources: Array<{ label: string; url: string }>;
}

interface AssessmentResult {
  assessedDepth: number;
  reasoning: string;
  gaps: GapDetail;
  learningPath: LearningPathItem[];
  modelUsed: string;
}

export interface QuizGenerationOptions {
  /** Resolved model spec for this operation. Defaults to the catalog
   *  entry for `quizGeneration` when omitted. */
  modelSpec?: ModelSpec;
  /** "About me" persona — calibrates difficulty + framing for this reader. */
  aboutStatement?: string | null;
  /** "Current focus" statement — biases question framing toward angles
   *  relevant to what the reader is currently steering toward. */
  focusStatement?: string | null;
}

function defaultQuizGenSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.quizGeneration);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.quizGeneration };
}

function defaultQuizAssessmentSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.quizAssessment);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.quizAssessment };
}

export async function generateQuiz(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  conceptName: string,
  depthScore: number,
  options: QuizGenerationOptions = {},
): Promise<GeneratedQuiz> {
  const spec = options.modelSpec ?? defaultQuizGenSpec();
  const aboutStatement = options.aboutStatement ?? null;
  const focusStatement = options.focusStatement ?? null;
  const depthLabel = DEPTH_LABELS[Math.floor(depthScore)] ?? "Unknown";

  const aboutBlock = aboutStatement
    ? `\nABOUT THE READER (calibrate question framing — assume their stated experience level, do not over-explain basics they likely know):\n${aboutStatement.trim()}\n`
    : "";

  const focusBlock = focusStatement
    ? `\nCURRENT FOCUS — what the reader is steering toward right now. When this concept intersects their focus, prefer questions that probe the angles most relevant to that direction. Never quote the focus back:\n${focusStatement.trim()}\n`
    : "";

  const system = `You generate calibration questions to assess a person's understanding depth.
${aboutBlock}${focusBlock}
The question should be open-ended and reveal HOW DEEPLY they understand the concept, not just whether they've heard of it.

FACTUAL DISCIPLINE — calibration depends on the question being well-grounded:
- Do NOT embed factual claims that could be wrong (e.g. "Kubernetes 2.0 introduced X..."). Frame the question conceptually so the premise doesn't carry version numbers, release dates, or specific quotes you can't verify.
- If you must reference a specific tool/version/feature, only do so when it is widely-known and durable (e.g. "Linux containers" is fine; "the new feature shipped last month" is not).
- A flawed premise in the question miscalibrates the user's depth score and is the highest-cost mistake here — prefer a more general framing over a precise-but-uncertain one.

Current estimated depth: ${depthScore.toFixed(1)} (${depthLabel})

Scale:
0 = Unknown: never encountered
1 = Aware: heard of it, can't explain
2 = Understands: can explain the concept
3 = Applies: uses it in practice
4 = Teaches: can teach others, knows edge cases
5 = Authoritative: deep expertise, shapes direction

Ask a question that could differentiate between adjacent depth levels.

OUTPUT FORMAT (JSON):
{
  "question": "The open-ended question",
  "context": "Brief context about why this question is calibrating",
  "expectedDepthIndicators": {
    "1": "What a depth-1 answer looks like",
    "2": "What a depth-2 answer looks like",
    "3": "What a depth-3 answer looks like",
    "4": "What a depth-4 answer looks like",
    "5": "What a depth-5 answer looks like"
  }
}`;

  const { result, usage } = await llm.generateJson<QuizQuestion>({
    spec,
    system,
    user: `Generate a calibration question for the concept: "${conceptName}"`,
  });

  await recordTokenUsage(db, userId, "quiz_generation", spec, usage);

  return { ...result, modelUsed: spec.model };
}

export async function assessQuizAnswer(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  conceptName: string,
  currentDepth: number,
  question: string,
  userAnswer: string,
  depthIndicators?: string,
  quizAssessmentSpec?: ModelSpec,
): Promise<AssessmentResult> {
  const spec = quizAssessmentSpec ?? defaultQuizAssessmentSpec();
  const system = `You assess a person's understanding depth based on their answer to a calibration question.

Depth scale:
0 = Unknown: never encountered
1 = Aware: heard of it, can't explain
2 = Understands: can explain the concept
3 = Applies: uses it in practice, knows tradeoffs
4 = Teaches: can teach others, knows edge cases
5 = Authoritative: deep expertise, shapes best practices

Be fair but precise. A vague or surface-level answer should NOT score above 2.
Practical experience indicators (mentioning specific tools, real incidents, edge cases) push toward 3-4.
Novel insights or contrarian-but-justified positions push toward 5.

Previous estimated depth: ${currentDepth.toFixed(1)}
${depthIndicators ? `Expected indicators:\n${depthIndicators}` : ""}

OUTPUT FORMAT (JSON):
{
  "assessedDepth": 2.5,
  "reasoning": "Why this depth was assessed",
  "gaps": {
    "summary": "One-line summary of what they're missing",
    "specifics": ["Specific gap 1", "Specific gap 2"]
  },
  "learningPath": [
    {
      "action": "What to do next",
      "rationale": "Why this helps",
      "resources": [{"label": "Resource name", "url": "https://..."}]
    }
  ]
}`;

  const userMessage = `Concept: "${conceptName}"
Question: "${question}"
Their answer: "${userAnswer}"`;

  const { result, usage } = await llm.generateJson<AssessmentResult>({
    spec,
    system,
    user: userMessage,
  });

  await recordTokenUsage(db, userId, "quiz_assessment", spec, usage);

  return {
    assessedDepth: Math.min(Math.max(result.assessedDepth ?? 0, 0), 5),
    reasoning: result.reasoning ?? "",
    gaps: result.gaps ?? { summary: "", specifics: [] },
    learningPath: result.learningPath ?? [],
    modelUsed: spec.model,
  };
}
