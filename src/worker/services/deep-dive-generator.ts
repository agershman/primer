import { DEPTH_LABELS } from "../config/constants.js";
import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";
import type { ContentBlock, Resource } from "../types.js";

export interface VisualAide {
  type: "diagram" | "table" | "comparison" | "flowchart";
  label: string;
  desc: string;
  url?: string;
  mermaidCode?: string;
}

interface DeepDiveResult {
  content: ContentBlock[];
  resources: Resource[];
  visualAides: VisualAide[];
  readTimeMinutes: number;
  modelUsed: string;
}

export interface DeepDiveOptions {
  /** Resolved model spec for this operation. Defaults to the catalog
   *  entry for `deepDive` when omitted. */
  modelSpec?: ModelSpec;
  /** "About me" persona — tailors voice / depth assumptions to the reader. */
  aboutStatement?: string | null;
}

function defaultDeepDiveSpec(): ModelSpec {
  const entry = lookupCatalogById(DEFAULT_MODELS.deepDive);
  return entry
    ? { provider: entry.provider, model: entry.providerModel }
    : { provider: "anthropic", model: DEFAULT_MODELS.deepDive };
}

export async function generateDeepDive(
  db: D1Database,
  userId: string,
  llm: LLMClient,
  conceptName: string,
  depthScore: number,
  existingContent: ContentBlock[],
  options: DeepDiveOptions = {},
): Promise<DeepDiveResult> {
  const spec = options.modelSpec ?? defaultDeepDiveSpec();
  const aboutStatement = options.aboutStatement ?? null;
  const depthLabel = DEPTH_LABELS[Math.floor(depthScore)] ?? "Unknown";

  const aboutBlock = aboutStatement
    ? `\nABOUT THE READER (use to calibrate voice and depth — do not mention explicitly):\n${aboutStatement.trim()}\n`
    : "";

  const system = `You are a knowledgeable peer writing an extended deep-dive for the reader described below.
${aboutBlock}
This is a drill-down from a shorter teaching piece. Go deeper. Target 800-1500 words.

VOICE: Same knowledgeable-peer tone. Evidence-grounded. Cite real projects, tools, RFCs, papers where relevant. Apply any tone preferences from the ABOUT block above without ever quoting them. Calibrate vocabulary to the reader — never explain what they obviously know, never assume jargon they don't.

CODE AND TECHNICAL DETAIL — route on the ABOUT block:

- If the reader is **technical** (engineer, programmer, infra/data/ML practitioner, technical PM): use inline \`code\` for command names, function names, file paths, config keys, and short literal values. Use code-block content blocks (\`{"type": "code", "value": "...", "language": "..."}\`) when a multi-line snippet, config example, or query genuinely earns its space. Always set the most accurate \`language\` tag (\`bash\`, \`typescript\`, \`python\`, \`yaml\`, \`json\`, \`sql\`, \`go\`, \`rust\`, \`hcl\`, \`dockerfile\`, etc.) — the renderer uses it for syntax highlighting. Deep dives are the right place for thorough code examples; don't shy away from showing the actual implementation patterns the reader needs.
- If the reader is **non-technical**: prefer prose. Use mermaid diagrams instead of code where possible — they communicate architecture and flow without requiring code literacy. If you must reference code (e.g. a PR snippet on the source ticket the deep dive grew from), introduce it with one line of plain-English context first. Inline \`code\` is fine for product / system / config names the reader will encounter in their tools.
- When uncertain, lean toward fewer code snippets and more diagrams + prose — code that doesn't earn its space hurts a deep dive more than it helps.

CITATIONS AND LINKS:
- ONLY use inline links ({{Label||url}}) when you can point to a SPECIFIC page: official docs, a blog post, an RFC, a GitHub repo, a paper, or release notes.
- NEVER link to company homepages, Wikipedia articles, or generic marketing pages.
- If you cannot point to a specific source for a claim, do NOT create a link — just state the fact.
- If you are uncertain whether something is accurate, qualify it rather than asserting it as fact.
- Resources at the end should be pages the reader can actually learn from.

Current reader depth: ${depthScore.toFixed(1)} (${depthLabel})

OUTPUT FORMAT (JSON):
{
  "content": [
    {"type": "heading", "value": "Section heading"},
    {"type": "text", "value": "Paragraph with {{Link Label||https://url.com}} inline links and \`inline code\` via single backticks"},
    {"type": "diagram", "value": "graph TD; A-->B; B-->C", "label": "System architecture"},
    {"type": "text", "value": "More explanation after the diagram..."},
    {"type": "code", "value": "kubectl get pods -n kube-system", "language": "bash"}
  ],
  "resources": [
    {"label": "Resource name", "url": "https://...", "type": "docs|article|other"}
  ]
}

Include at least one diagram (type "diagram" with mermaid syntax) or code block (type "code" with language) INLINE in the content array, placed right after the paragraph it illustrates. Do NOT put visuals in a separate section — weave them into the narrative. Always set the \`language\` field on code blocks so the renderer can syntax-highlight correctly.`;

  const existingSummary = existingContent
    .filter((b) => b.type === "text")
    .map((b) => b.value)
    .join(" ")
    .slice(0, 500);

  const userMessage = `Write a deep-dive expansion for "${conceptName}".

The reader already saw this summary:
"${existingSummary}"

Now go deeper. Cover implementation details, edge cases, tradeoffs, and real-world patterns.`;

  const { result, usage } = await llm.generateJson<{
    content: ContentBlock[];
    resources: Resource[];
  }>({ spec, system, user: userMessage });

  await recordTokenUsage(db, userId, "deep_dive_generation", spec, usage);

  const wordCount = result.content
    .filter((b) => b.type === "text")
    .reduce((sum, b) => sum + b.value.split(/\s+/).length, 0);
  const readTime = Math.max(2, Math.ceil(wordCount / 200));

  return {
    content: result.content,
    resources: (result.resources ?? []).map((r) => ({
      label: r.label,
      url: r.url,
      type: r.type ?? "other",
    })),
    visualAides: [],
    readTimeMinutes: readTime,
    modelUsed: spec.model,
  };
}
