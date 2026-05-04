import { Hono } from "hono";
import { listSourceInstances } from "../db/source-instance-queries.js";
import { llmClient } from "../integrations/llm/dispatcher.js";
import { suggestEnabledSources } from "../services/source-suggester.js";
import { sourceRegistry } from "../sources/index.js";
import type { Env, UserContext } from "../types.js";

/**
 * Short, neutral description per source kind. Surfaced to the LLM
 * suggester (so it can reason about fit) and to the onboarding
 * "sources" step as helper text under each suggestion. Kept in one
 * place so we don't sprinkle marketing copy across the registry.
 */
const SOURCE_DESCRIPTIONS: Record<string, string> = {
  linear: "Issues and projects from Linear — surfaces engineering work in flight.",
  slack: "Recent Slack threads — captures cross-team discussion and decisions.",
  github: "Recent GitHub PRs and issues — surfaces what your engineers are shipping.",
  incident_io: "Active and recent incidents from incident.io — high-signal context for SREs and platform engineers.",
  hn: "Hacker News story feeds — broad tech news and discussion.",
  rss: "Configured RSS / Atom feeds — vendor blogs, conference proceedings, newsletters.",
  arxiv: "ArXiv paper feeds — research-heavy, useful for ML / systems researchers.",
};

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const sourcesRoutes = new Hono<AppEnv>();

sourcesRoutes.get("/sources", async (c) => {
  const env = c.env;
  const db = env.DB;
  const all = sourceRegistry.getAll();
  const instances = await listSourceInstances(db);

  const sources = all.map((provider) => {
    const available = provider.isAvailable(env);
    const base = {
      id: provider.id,
      name: provider.name,
      multiInstance: provider.multiInstance,
      available,
      description: SOURCE_DESCRIPTIONS[provider.id] ?? null,
      settingsManifest: provider.settingsManifest ?? null,
      userFields: provider.userFields ?? null,
    };

    if (provider.multiInstance) {
      return {
        ...base,
        instances: instances.filter((inst) => inst.kind === provider.id),
      };
    }

    return {
      ...base,
      instances: null,
    };
  });

  return c.json({ sources });
});

/**
 * AI-driven recommendation for which built-in source kinds the
 * caller should enable. Drives the visual highlight on the
 * onboarding "sources" step — the AI never auto-selects, the user
 * always picks. User-level (no admin gate) because the suggestion is
 * scoped to the caller's own About + Focus.
 *
 * Falls back to an empty list (no recommendations) when no LLM key
 * is configured or when the underlying call fails. The frontend
 * degrades cleanly: it shows every available source plainly without
 * highlights.
 */
sourcesRoutes.post("/sources/suggest-enabled", async (c) => {
  const user = c.get("user");
  const env = c.env;
  if (!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return c.json({ suggestions: [] });
  }

  const available = sourceRegistry.getAvailable(env).map((p) => ({
    id: p.id,
    name: p.name,
    description: SOURCE_DESCRIPTIONS[p.id],
  }));

  const llm = llmClient(env);
  const suggestions = await suggestEnabledSources(env.DB, user.userId, llm, available, {
    aboutStatement: user.aboutStatement,
    focusStatement: user.focusStatement,
  });

  return c.json({ suggestions });
});
