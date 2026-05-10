/**
 * AI-assisted refinement of About / Focus drafts.
 *
 * Two modes share this endpoint, distinguished by whether the request
 * carries an `instruction` field:
 *
 *   - No instruction: the user wrote a freeform paragraph and wants
 *     Sonnet to tighten it into a prompt-ready paragraph. Original
 *     behaviour.
 *   - With instruction: the user is mostly happy with their existing
 *     statement and wants a targeted edit applied to it ("shorter",
 *     "add that I love TypeScript", "remove the bit about
 *     Kubernetes"). Sonnet applies the instruction while preserving
 *     everything else.
 *
 * Both modes return the same `{ refined, rationale }` shape so the
 * frontend's side-by-side diff dialog handles them identically.
 *
 * @see ../system.ts — assembly entry point
 */

import { Hono } from "hono";
import { parseBody, RefinePromptRequest } from "../../../shared/schemas.js";
import { recordTokenUsage } from "../../db/queries.js";
import { llmClient } from "../../integrations/llm/dispatcher.js";
import type { ModelSpec } from "../../integrations/llm/types.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const systemRefineRoutes = new Hono<AppEnv>();

systemRefineRoutes.post("/me/refine-prompt", async (c) => {
  const user = c.get("user");
  // Validate at the edge via the shared zod schema. Pre-zod this
  // route did three separate ad-hoc checks (kind enum, draft
  // required, draft length) — all of which are now declared once
  // in the schema and shared with the frontend's inferred type.
  const parsed = await parseBody(c.req.raw, RefinePromptRequest);
  if (!parsed.ok) return c.json(parsed.error, 400);
  const { kind } = parsed.data;
  const draft = parsed.data.draft.trim();
  if (!draft) {
    return c.json({ error: "draft is required" }, 400);
  }
  // Zod already trims `instruction`; treat empty-string-after-trim as absent
  // so the route falls back cleanly to the original "tighten this draft"
  // behaviour rather than feeding a blank instruction to Claude.
  const instruction = parsed.data.instruction?.trim() || undefined;

  const purposeBlock =
    kind === "about"
      ? `The text is the user's "About me" / persona statement. It is injected into Primer's
LLM prompts as a stable signal of WHO the user is — their role, expertise level,
communication preferences, learning style, what excites them. It influences the
voice, depth, and audience-modeling of all user-facing AI generation: teaching
pieces, deep dives, chat, quiz framing, and feed relevance scoring. A good
About statement is a tight 3-6 sentence paragraph that gives the model enough
to write to the right person without being so verbose it crowds out the
actual task.`
      : `The text is the user's "Focus" statement. It is injected into Primer's concept
extractor as a signal of WHAT the user wants to learn / focus on right now. It
biases extraction toward concepts that intersect this focus and away from
technically-valid-but-off-topic noise. A good Focus statement is a tight 3-6
sentence paragraph that names the technical areas + topics the user cares
about, and explicitly calls out what they DON'T care about (org/process/people
topics, irrelevant adjacent stacks).`;

  const exemplarBlock =
    kind === "about"
      ? `Example of a good "About" statement:

  "Fullstack engineer at a small SaaS company. ~6 years experience;
  comfortable with deep technical detail in my stack. I learn best from
  concrete examples and trade-off discussions, not exhaustive overviews.
  Direct, slightly skeptical tone — give me the substance and the gotchas,
  not a tutorial."

What that example does well: states role + experience, says what kind of
explanation works, and sets a tone preference. Concrete and testable.`
      : `Example of a good "Focus" statement:

  "Fullstack engineer focused on TypeScript/React, Postgres performance,
  and deployment workflows. Care about: API design pitfalls, common
  production failure modes in my stack, and the trade-offs between popular
  libraries. Don't care about: machine learning, mobile-native development,
  organizational/process topics like standups or OKRs."

What that example does well: lists technical areas with specificity, lists
cross-cutting concerns, and explicitly excludes off-topic surfaces.`;

  // Two refinement modes share the same purpose/exemplar context but
  // diverge on rules + user-message shape:
  //   - "tighten" (no instruction): rewrite the whole draft into a
  //     prompt-ready paragraph. This is the original behaviour.
  //   - "instruction": apply a specific user-supplied edit ("shorter",
  //     "add that I love TypeScript", "remove Kubernetes") to the
  //     existing statement, preserving everything the instruction
  //     doesn't touch. Output shape is identical so the dialog
  //     consumes both responses the same way.
  const rulesBlock = instruction
    ? `APPLY-INSTRUCTION RULES:
- The user's instruction tells you what to change about their existing
  statement. You MUST produce a paragraph that reflects that change.
  Returning the existing statement unchanged is a failure.
- Apply the instruction directly. If the instruction says "shorter",
  the output must be shorter. If it says "add that I love X", the
  output must mention X. If it says "remove the bit about Y", Y must
  be gone.
- Preserve the parts of the existing statement that the instruction
  doesn't touch. Don't take the opportunity to do an unrelated rewrite
  while you're in there.
- If the instruction is genuinely vague (e.g. "make it better"),
  make your best judgment edit AND explain in the rationale what you
  chose to interpret it as. Do not punt by returning the original.
- Do not invent facts the instruction didn't supply. If it says "add
  that I love TypeScript", add exactly that — don't also add years of
  experience or other stack details the user didn't mention.
- Use first-person ("I work on...", "I prefer..."). Never second-person.
- Keep within 3-6 sentences and ~150-400 chars unless the instruction
  explicitly asks for more or less. Hard cap 1500 chars.
- Plain prose, no bullet points, no markdown.

OUTPUT FORMAT (strict JSON, both fields required and non-empty):
{
  "refined": "the updated paragraph with the instruction applied",
  "rationale": "1-3 sentence explanation of how you applied the instruction"
}`
    : `REWRITE RULES:
- Keep the user's actual content and intent. Do NOT invent facts about them.
  If the draft is vague ("I'm a software engineer"), keep it vague — don't
  fabricate seniority or stack details.
- Tighten verbose phrasing. Cut filler. Move from "I think I'm sort of a..."
  to "I am a..."
- Surface implicit signals. If the draft lists technologies but never says
  experience level, leave that out rather than guessing.
- Use first-person ("I work on...", "I prefer..."). Never second-person
  ("you" referring to the user).
- 3-6 sentences. Aim for ~150-400 chars. Hard cap 1500 chars.
- Plain prose, no bullet points, no markdown.
- If the user's draft is already excellent, return it nearly unchanged and say
  so in the rationale.

OUTPUT FORMAT (strict JSON):
{
  "refined": "<the rewritten paragraph>",
  "rationale": "<1-3 sentence explanation of what you changed and why>"
}`;

  const taskLine = instruction
    ? `Your job is to apply the user's refinement instruction to their existing
statement, preserving everything else. The output must still work well as
prompt-injected user context for downstream models.`
    : `Your job is to rewrite the user's draft into a tight, prompt-ready
paragraph that is more useful for downstream models.`;

  const system = `You are helping refine a user-supplied paragraph that will be
injected into other LLM prompts as user context. ${taskLine}

${purposeBlock}

${exemplarBlock}

${rulesBlock}`;

  const userMessage = instruction
    ? `Existing statement:\n\n${draft}\n\nUser's refinement instruction:\n\n${instruction}`
    : `User's draft:\n\n${draft}`;

  const llm = llmClient(c.env);
  // Hard-coded to Sonnet 4 — the persona refinement step is short,
  // user-visible, and benefits from the smarter model. The override is
  // not exposed to per-use-case selection because the call site is rare.
  const refinementSpec: ModelSpec = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
  try {
    const { result, usage } = await llm.generateJson<{ refined: string; rationale: string }>({
      spec: refinementSpec,
      system,
      user: userMessage,
      maxTokens: 1024,
    });
    await recordTokenUsage(c.env.DB, user.userId, "prompt_refinement", refinementSpec, usage);

    const refinedOut = result.refined?.trim() ?? "";
    const rationaleOut = result.rationale?.trim() ?? "";

    // Fail loudly instead of silently echoing the draft. Pre-fix, a missing
    // `refined` field fell back to the original draft via `?? draft`, which
    // made model failures look identical to a successful no-op refinement —
    // user saw "Before == After" in the diff and accepting it changed
    // nothing in the textarea. Surface a real error so the dialog shows it.
    if (!refinedOut) {
      console.error(
        "[refine-prompt] empty refined field",
        JSON.stringify({ kind, hasInstruction: !!instruction, result }).slice(0, 800),
      );
      return c.json({ error: "AI returned an empty refinement. Try a clearer instruction." }, 502);
    }

    // In instruction mode, the model echoing back the draft verbatim is also a
    // failure mode — the instruction wasn't applied. Warn (don't block) so we
    // get diagnostics from real traffic if this turns out to be common.
    if (instruction && refinedOut === draft) {
      console.warn(
        "[refine-prompt] refined output identical to draft",
        JSON.stringify({ kind, instructionPreview: instruction.slice(0, 120) }).slice(0, 400),
      );
    }

    return c.json({ refined: refinedOut, rationale: rationaleOut });
  } catch (err) {
    console.error("[refine-prompt] failed:", err);
    return c.json({ error: "Refinement failed" }, 500);
  }
});
