import { Hono } from "hono";
import {
  createSourceInstance,
  deleteSourceInstance,
  listSourceInstances,
  seedDefaultSourceInstancesIfEmpty,
  updateSourceInstance,
} from "../db/source-instance-queries.js";
import { llmClient } from "../integrations/llm/dispatcher.js";
import { assertAdmin } from "../middleware/require-admin.js";
import { suggestSourceInstances } from "../services/source-suggester.js";
import type { Env, UserContext } from "../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const sourceInstanceRoutes = new Hono<AppEnv>();

/**
 * List all source instances. The Feeds panel starts empty on a
 * fresh deploy — admins paste RSS URLs or use the AI suggester to
 * populate it from their About + Focus rather than getting a
 * one-size-fits-all starter pack baked in.
 *
 * `seedDefaultSourceInstancesIfEmpty` is currently a no-op (the
 * default array is empty) but stays wired in case a future "opt-in
 * starter pack" wizard wants to use it.
 */
sourceInstanceRoutes.get("/source-instances", async (c) => {
  await seedDefaultSourceInstancesIfEmpty(c.env.DB);
  const sources = await listSourceInstances(c.env.DB);
  return c.json({ sources });
});

/**
 * Add a new source instance. Accepts `kind`, `label`, `url`,
 * optional `config`. AI-suggester payloads also accepted.
 */
sourceInstanceRoutes.post("/source-instances", async (c) => {
  const block = assertAdmin(c.get("user"));
  if (block) return block;
  let body: {
    kind?: string;
    label?: string;
    url?: string | null;
    config?: Record<string, unknown>;
    enabled?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const kind = body.kind;
  if (kind !== "rss" && kind !== "hn" && kind !== "arxiv") {
    return c.json({ error: "kind must be 'rss', 'hn', or 'arxiv'" }, 400);
  }
  const label = (body.label ?? "").trim();
  if (!label) {
    return c.json({ error: "label is required" }, 400);
  }
  if ((kind === "rss" || kind === "hn") && !body.url) {
    return c.json({ error: `${kind} requires a url` }, 400);
  }

  try {
    const source = await createSourceInstance(c.env.DB, {
      kind,
      label,
      url: body.url ?? null,
      config: body.config ?? {},
      enabled: body.enabled !== false,
    });
    return c.json({ source });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create source";
    if (/UNIQUE/i.test(msg)) {
      return c.json({ error: "This source already exists." }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Update an existing source instance. Most edits are toggle
 * (enabled/disabled) and label rename.
 */
sourceInstanceRoutes.patch("/source-instances/:id", async (c) => {
  const block = assertAdmin(c.get("user"));
  if (block) return block;
  const id = c.req.param("id");
  let body: {
    label?: string;
    url?: string | null;
    config?: Record<string, unknown>;
    enabled?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const updated = await updateSourceInstance(c.env.DB, id, body);
  if (!updated) return c.json({ error: "Source not found" }, 404);
  return c.json({ source: updated });
});

sourceInstanceRoutes.delete("/source-instances/:id", async (c) => {
  const block = assertAdmin(c.get("user"));
  if (block) return block;
  const id = c.req.param("id");
  const deleted = await deleteSourceInstance(c.env.DB, id);
  return c.json({ ok: true, deleted });
});

/**
 * AI-suggest endpoint. Returns ~8 candidate RSS feeds based on the
 * user's About + Focus + existing source list. Suggestions are NOT
 * persisted — the frontend renders them as one-click "Add" cards
 * that POST back to `/source-instances` on accept.
 */
sourceInstanceRoutes.post("/source-instances/suggest", async (c) => {
  const user = c.get("user");
  const block = assertAdmin(user);
  if (block) return block;
  await seedDefaultSourceInstancesIfEmpty(c.env.DB);
  const existing = await listSourceInstances(c.env.DB);

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "Suggestions require an Anthropic API key" }, 400);
  }
  const llm = llmClient(c.env);

  const suggestions = await suggestSourceInstances(c.env.DB, user.userId, llm, {
    aboutStatement: user.aboutStatement,
    focusStatement: user.focusStatement,
    existingSourceKeys: existing.map((s) => `${s.label} (${s.url ?? "no url"})`),
  });
  return c.json({ suggestions });
});
