import { Hono } from "hono";
import { listSourceInstances } from "../db/source-instance-queries.js";
import { sourceRegistry } from "../sources/index.js";
import type { Env, UserContext } from "../types.js";

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
