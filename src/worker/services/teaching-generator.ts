import { DEPTH_LABELS } from "../config/constants.js";
import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";
import type { ContentBlock, Resource } from "../types.js";

export type PieceType = "60-second" | "walkthrough" | "deep-dive" | "readiness";

interface TeachingTarget {
  conceptName: string;
  conceptId: string;
  depthScore: number;
  category?: string;
  sourceType: "current-work" | "adjacent" | "readiness-gap" | "decay-recalibrate";
  sourceReference?: string;
  sourceDescription?: string;
  selectionReasoning: string;
}

interface GeneratedPiece {
  title: string;
  pieceType: PieceType;
  content: ContentBlock[];
  resources: Resource[];
  readTimeMinutes: number;
  modelUsed: string;
}

const WORD_TARGETS: Record<PieceType, number> = {
  "60-second": 150,
  walkthrough: 400,
  "deep-dive": 800,
  readiness: 300,
};

function depthSystemPrompt(depth: number): string {
  if (depth <= 1) {
    return "The reader is NEW to this topic. Explain from scratch. Define all technical terms. Use analogies to familiar concepts. Build up from first principles.";
  }
  if (depth === 2) {
    return "The reader UNDERSTANDS the basics. Skip introductory definitions. Focus on HOW and WHEN to apply the concept. Include practical examples and decision criteria.";
  }
  if (depth === 3) {
    return "The reader APPLIES this concept regularly. Skip mechanics they already know. Focus on edge cases, tradeoffs, and design considerations they might miss.";
  }
  return "The reader is EXPERT-level. Offer a contrarian take, a recent development they may have missed, or an adjacent connection that reframes their understanding.";
}

function pieceTypeForDepth(depth: number, sourceType: string): PieceType {
  if (sourceType === "readiness-gap") return "readiness";
  if (depth <= 1) return "60-second";
  if (depth <= 3) return "walkthrough";
  return "deep-dive";
}

export interface TeachingGenerateOptions {
  /** Resolved model spec for this operation. Defaults to the catalog
   *  entry for `teachingPiece` when omitted. */
  modelSpec?: ModelSpec;
  /** "About me" persona text — tailors voice and depth assumptions to the reader. */
  aboutStatement?: string | null;
  /** "Current focus" statement — steers the angle/framing of the piece
   *  toward the reader's currently-prioritized direction. Voice is
   *  governed by About; Focus governs *what aspect* of the topic to
   *  emphasize when the topic intersects the focus. */
  focusStatement?: string | null;
  /**
   * When set, the new piece is being written as Part N of a series and
   * the writer should explicitly acknowledge the predecessor. Without
   * this, the body would still be standalone-shaped (which reads
   * jarring after we slap a "Part 2" badge onto it). Optional because
   * most drafts are NOVEL and have no predecessor.
   */
  continuation?: ContinuationContext | null;
}

function defaultTeachingSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.teachingPiece);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.teachingPiece };
}

export interface ContinuationContext {
  /** Title of the prior part — used in the opening callback line. */
  predecessorTitle: string;
  /** Date the prior part was published (YYYY-MM-DD). Surfaced to the
   *  reader as "Last time (Apr 12)..." so they can locate it. */
  predecessorDate: string;
  /** Plain-text excerpt of the prior part's claims. Keeps the new
   *  piece grounded — without this the LLM tends to recap the prior
   *  part instead of building on it. */
  predecessorExcerpt: string;
  /** The part number this NEW piece will become (the predecessor is
   *  N-1). Lets the prompt say "Part 3" rather than guessing. */
  newPartNumber: number;
}

export async function generateTeachingPiece(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  target: TeachingTarget,
  options: TeachingGenerateOptions = {},
): Promise<GeneratedPiece> {
  const spec = options.modelSpec ?? defaultTeachingSpec();
  const aboutStatement = options.aboutStatement ?? null;
  const focusStatement = options.focusStatement ?? null;
  const pieceType = pieceTypeForDepth(target.depthScore, target.sourceType);
  const wordTarget = WORD_TARGETS[pieceType];
  const depthLabel = DEPTH_LABELS[Math.floor(target.depthScore)] ?? "Unknown";

  const aboutBlock = aboutStatement
    ? `\nABOUT THE READER (use this to calibrate voice and depth — never mention it explicitly):\n${aboutStatement.trim()}\n`
    : "";

  const focusBlock = focusStatement
    ? `\nCURRENT FOCUS — what the reader is steering toward right now. When this topic intersects their focus, lean into that intersection: emphasize the angles, tradeoffs, and connections most useful for that direction. If the topic is orthogonal to the focus, ignore this block. Never quote it back:\n${focusStatement.trim()}\n`
    : "";

  const continuation = options.continuation ?? null;
  // Continuation block: only inserted when the classifier decided this
  // new draft is genuinely Part N of a series. The instructions are
  // intentionally directive ("open with a brief callback") so the
  // body reads like a magazine series, not a standalone with a
  // sticky-note "Part 2" badge slapped on top.
  const continuationBlock = continuation
    ? `\nCONTINUATION CONTEXT — this piece is Part ${continuation.newPartNumber} in a series. The prior part is:
Title: "${continuation.predecessorTitle}"
Published: ${continuation.predecessorDate}
Recap: ${continuation.predecessorExcerpt.slice(0, 600)}

Open with a brief one-sentence callback referencing the prior part by name and date (e.g. "Last time (${continuation.predecessorDate}) we looked at ${continuation.predecessorTitle} ..."). Then move on to what's NEW since then. Do NOT repeat the prior part's claims — assume the reader read it. Focus on the new movement.\n`
    : "";

  const system = `You are a knowledgeable peer writing a concise teaching piece for the reader described below.
${aboutBlock}${focusBlock}${continuationBlock}
VOICE: Conversational but precise. Calibrate to the reader: for an engineer this reads like a senior peer at a whiteboard; for a non-technical reader (PM, designer, ops, sales, leadership) this reads like a smart colleague explaining the substance without the jargon. Match the depth and vocabulary the ABOUT block implies — never explain something the reader already knows, never assume jargon the reader doesn't.
Be evidence-grounded. Cite real tools, projects, or patterns where relevant.
If the ABOUT block above gave you signals about the reader's tone preferences (e.g. direct, skeptical, no MBA-speak), apply them here without ever quoting them back.

CODE AND TECHNICAL DETAIL — route on the ABOUT block:

- If the reader is **technical** (mentions code, programming, software engineering, specific languages, dev tools, infrastructure, or any equivalent technical role): use inline \`code\` for command names, function names, file paths, config keys, and short literal values. Use code-block content blocks (\`{"type": "code", "value": "...", "language": "..."}\`) when a multi-line snippet, command, or config example genuinely clarifies what the prose is describing. Pick the most accurate \`language\` tag (\`bash\`, \`typescript\`, \`python\`, \`yaml\`, \`json\`, \`sql\`, \`go\`, \`rust\`, \`hcl\`, \`dockerfile\`, etc.) — the renderer uses it for syntax highlighting.
- If the reader is **non-technical**: prefer prose. Avoid code blocks unless the source material the piece is grounded in genuinely contains code (e.g. you're explaining a PR snippet they need context on), and even then introduce the snippet with a one-line plain-English summary. Inline \`code\` is fine for product / system names and concrete values the reader will see in their tools. Don't show shell commands or pseudocode that the reader has no use for.
- When in doubt, lean toward less code and more prose — code that doesn't earn its space is noise.

CITATIONS AND LINKS:
- ONLY use inline links ({{Label||url}}) when you can point to a SPECIFIC page the reader can visit: official docs, a blog post, an RFC, a GitHub repo, a paper, or release notes.
- NEVER link to company homepages, Wikipedia articles, or generic marketing pages. If you mention Kubernetes, link to the relevant docs page, not kubernetes.io.
- If you cannot point to a specific source for a claim, do NOT create a link — just state the fact plainly.
- If you are uncertain whether something is accurate, qualify it: "some organizations have adopted..." rather than asserting "Company X published...".
- Resources at the end should be pages the reader can actually learn from — not vanity URLs.

${depthSystemPrompt(target.depthScore)}

TARGET: ~${wordTarget} words. Piece type: "${pieceType}".
Current depth: ${target.depthScore.toFixed(1)} (${depthLabel})

OUTPUT FORMAT (JSON):
{
  "title": "short, engaging title",
  "content": [
    {"type": "heading", "value": "Section heading"},
    {"type": "text", "value": "Paragraph text with {{Display Label||https://url.com}} for inline links and \`inline code\` via single backticks"},
    {"type": "code", "value": "kubectl get nodes -o wide", "language": "bash"},
    {"type": "diagram", "value": "graph TD; A-->B", "label": "Architecture overview"}
  ],
  "resources": [
    {"label": "Resource name", "url": "https://...", "type": "docs|article|other"}
  ]
}

Content can include code blocks (type "code" with a language) and mermaid diagrams (type "diagram") inline where they help explain the concept. Place them naturally within the content flow, right after the paragraph that introduces what they illustrate. Always set the \`language\` field on code blocks so the renderer can syntax-highlight correctly.`;

  const sourceContextLines: string[] = [];
  if (target.sourceReference) {
    sourceContextLines.push(`This came up in their work via: ${target.sourceReference}`);
  }
  if (target.sourceDescription) {
    sourceContextLines.push(`Source material from their work:\n${target.sourceDescription.slice(0, 1500)}`);
  }
  if (target.sourceType === "decay-recalibrate") {
    sourceContextLines.push(
      "This concept is decaying from disuse. Re-engage the reader and highlight what's changed recently.",
    );
  }
  if (target.sourceType === "readiness-gap") {
    sourceContextLines.push(
      "Focus on what the reader needs to know to be implementation-ready. Identify practical gaps.",
    );
  }

  const userMessage = `Write a ${pieceType} teaching piece about "${target.conceptName}" (category: ${target.category ?? "general"}).
${sourceContextLines.length > 0 ? "\n" + sourceContextLines.join("\n\n") : ""}`;

  const { result, usage } = await llm.generateJson<{
    title: string;
    content: ContentBlock[];
    resources: Resource[];
  }>({ spec, system, user: userMessage });

  await recordTokenUsage(db, userId, "teaching_generation", spec, usage);

  const wordCount = result.content
    .filter((b) => b.type === "text")
    .reduce((sum, b) => sum + b.value.split(/\s+/).length, 0);
  const readTime = Math.max(1, Math.ceil(wordCount / 200));

  return {
    title: result.title,
    pieceType,
    content: result.content,
    resources: (result.resources ?? []).map((r) => ({
      label: r.label,
      url: r.url,
      type: r.type ?? "other",
    })),
    readTimeMinutes: readTime,
    modelUsed: spec.model,
  };
}
