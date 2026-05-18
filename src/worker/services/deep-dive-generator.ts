import { DEPTH_LABELS } from "../config/constants.js";
import { DEFAULT_MODELS, lookupCatalogById } from "../config/models.js";
import { recordTokenUsage } from "../db/queries.js";
import type { LLMClient, ModelSpec } from "../integrations/llm/types.js";
import { supportsWebSearch } from "../integrations/web-search.js";
import type { ContentBlock, Resource } from "../types.js";
import { stripCiteTags } from "./content-cleanup.js";

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
  /**
   * Source bundle inherited from the parent teaching piece. Used for
   * company-internal facts (ticket / incident / team specifics). For
   * external technical claims the writer is told to reach for the
   * hosted `web_search` tool. Optional because the regenerate path can
   * still call us without sources.
   */
  sources?: Array<{ type: string; id?: string; url?: string; title?: string; summary?: string }>;
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

GROUNDING — every factual claim must be anchored:
1. For company-internal facts (project names, team behavior, incident details, ticket status, internal metrics, named individuals): use ONLY the supplied parent-piece source bundle below. Do NOT search the web for these — you will not find them. If the bundle doesn't cover an internal claim, qualify it or omit it.
2. For external technical claims (version numbers, vendor behavior, public APIs, RFCs, well-known incidents, library defaults, syntax): prefer the source bundle when it covers the claim. Otherwise invoke the \`web_search\` tool to verify against official docs, RFCs, vendor changelogs, or the project's own repo. Deep dives benefit most from this — go beyond the supplied bundle when the topic warrants it. Prefer authoritative primary sources over blog posts.
3. If you cannot anchor a claim either way, qualify it ("some teams report...", "in many setups...") or omit it. Never assert a specific percentage, version, vendor behavior, date, or quote you have not verified.

CITATIONS AND LINKS:
- ONLY use inline links ({{Label||url}}) when you can point to a SPECIFIC page: official docs, a blog post, an RFC, a GitHub repo, a paper, or release notes.
- NEVER link to company homepages, Wikipedia articles, or generic marketing pages.
- If you cannot point to a specific source for a claim, do NOT create a link — just state the fact.
- Resources at the end should be pages the reader can actually learn from.
- Do NOT wrap cited spans in \`<cite>\` tags, \`[1]\`-style footnote markers, or any other inline citation markup. The web_search tool's results are captured separately and surfaced to the reader as a list of consulted sources beneath your prose — your job is to write clean readable prose, not to annotate which spans came from which result.

GLOSSARY TERMS — define jargon the reader (per ABOUT) might not know:
- Wrap any term, acronym, or phrase the reader might not know in the marker [[term||short definition]]. The frontend renders these as the term with a dotted underline; hovering shows the definition in a tooltip.
- Definitions should be ≤25 words, plain language, and self-contained (no nested markers, no links inside).
- Mark a term ONLY on its FIRST occurrence in the deep dive. Later mentions are plain text.
- DO NOT mark a term that the prose already explains in the same sentence — the tooltip would be redundant.
- Calibrate aggressiveness to the ABOUT block: for a clearly technical reader, only mark genuinely niche terms (specific RFC numbers, niche protocols, internal-team acronyms); for a non-technical reader, mark widely-used technical jargon as well.
- If the term is itself a piece of inline code (e.g. a function name), prefer leaving it as \`code\` and explaining it in prose rather than wrapping in a glossary marker.

Current reader depth: ${depthScore.toFixed(1)} (${depthLabel})

OUTPUT FORMAT (JSON):
{
  "content": [
    {"type": "heading", "value": "Section heading"},
    {"type": "text", "value": "Paragraph with {{Link Label||https://url.com}} inline links, \`inline code\` via single backticks, and [[CRDT||conflict-free replicated data type — converges deterministically across replicas]] for jargon"},
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

  // Render the parent piece's source bundle for company-internal
  // grounding. External claims go through `web_search` instead.
  const bundleLines = (options.sources ?? []).map((s) => {
    const key = s.id ?? s.url;
    const label = key ? `${s.type}:${key}` : s.type;
    return `  - ${label}${s.title ? ` — ${s.title}` : ""}`;
  });
  const bundleBlock =
    bundleLines.length > 0
      ? `\n\nSources available for grounding (company-internal — use these for ticket/incident/team specifics, never invent them):\n${bundleLines.join("\n")}`
      : "";

  const userMessage = `Write a deep-dive expansion for "${conceptName}".

The reader already saw this summary:
"${existingSummary}"

Now go deeper. Cover implementation details, edge cases, tradeoffs, and real-world patterns.${bundleBlock}`;

  const { result, usage, webSearchResults } = await llm.generateJson<{
    content: ContentBlock[];
    resources: Resource[];
  }>({
    spec,
    system,
    user: userMessage,
    ...(supportsWebSearch(spec) ? { serverTools: [{ kind: "web_search", maxUses: 4 }] } : {}),
  });

  await recordTokenUsage(db, userId, "deep_dive_generation", spec, usage);

  // Defensive: strip any `<cite>` tags the model wrapped around cited
  // spans (see `content-cleanup.ts` for the full rationale). The
  // actual citations come back on `webSearchResults` and surface as
  // `web`-type resources below.
  const cleanedContent = stripCiteTags(result.content);

  const wordCount = cleanedContent
    .filter((b) => b.type === "text")
    .reduce((sum, b) => sum + b.value.split(/\s+/).length, 0);
  const readTime = Math.max(2, Math.ceil(wordCount / 200));

  const writerResources: Resource[] = (result.resources ?? []).map((r) => ({
    label: r.label,
    url: r.url,
    type: r.type ?? "other",
  }));

  // Append public sources the writer consulted via `web_search` during
  // drafting, de-duplicated against URLs the writer already cited.
  const seenUrls = new Set(writerResources.map((r) => r.url));
  const webResources: Resource[] = (webSearchResults ?? [])
    .filter((w) => w.url && !seenUrls.has(w.url))
    .map((w) => ({ label: w.title || w.url, url: w.url, type: "web" as const }));

  return {
    content: cleanedContent,
    resources: [...writerResources, ...webResources],
    visualAides: [],
    readTimeMinutes: readTime,
    modelUsed: spec.model,
  };
}
