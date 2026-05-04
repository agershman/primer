import { fetchHackerNewsTop } from "../integrations/feeds.js";
import type { Env } from "../types.js";
import type { SourceFetchContext, SourceFetchResult, SourceProvider } from "./types.js";

export const hnProvider: SourceProvider = {
  id: "hn",
  name: "Hacker News",
  requiredEnv: [],
  multiInstance: true,

  isAvailable() {
    return true;
  },

  isConfigured() {
    return true;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const cfg = ctx.instanceRow?.config ?? {};
    const limit = typeof cfg.limit === "number" && cfg.limit > 0 ? cfg.limit : 20;

    const items = await fetchHackerNewsTop(limit);
    return {
      items: items.map((it) => ({ ...it, source: "hn" })),
      details: [`Fetched ${items.length} HN stories`],
    };
  },

  settingsManifest: {
    nav: {
      label: "Hacker News",
      icon: "flame",
      group: "Sources",
      keywords: ["hacker news", "hn", "tech news"],
    },
  },
};
