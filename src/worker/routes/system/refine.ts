/**
 * AI-assisted refinement of About / Focus drafts.
 *
 * The user writes a freeform paragraph; this endpoint asks Sonnet to
 * rewrite it into a tight, specific paragraph that works well as a
 * prompt injection. The frontend shows a side-by-side diff and the
 * user accepts or dismisses. Returns `{ refined, rationale }` so the
 * user can see why the rewrite chose what it chose.
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

  const system = `You are helping refine a user-supplied paragraph that will be
injected into other LLM prompts as user context. Your job is to rewrite the
user's draft into a tight, prompt-ready paragraph that is more useful for
downstream models.

${purposeBlock}

${exemplarBlock}

REWRITE RULES:
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

  const llm = llmClient(c.env);
  // Hard-coded to Sonnet 4 — the persona refinement step is short,
  // user-visible, and benefits from the smarter model. The override is
  // not exposed to per-use-case selection because the call site is rare.
  const refinementSpec: ModelSpec = { provider: "anthropic", model: "claude-sonnet-4-20250514" };
  try {
    const { result, usage } = await llm.generateJson<{ refined: string; rationale: string }>({
      spec: refinementSpec,
      system,
      user: `User's draft:\n\n${draft}`,
      maxTokens: 1024,
    });
    await recordTokenUsage(c.env.DB, user.userId, "prompt_refinement", refinementSpec, usage);
    return c.json({
      refined: result.refined?.trim() ?? draft,
      rationale: result.rationale?.trim() ?? "",
    });
  } catch (err) {
    console.error("[refine-prompt] failed:", err);
    return c.json({ error: "Refinement failed" }, 500);
  }
});
