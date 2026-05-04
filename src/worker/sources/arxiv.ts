import { fetchArxivPapers } from "../integrations/feeds.js";
import type { Env } from "../types.js";
import type { SourceFetchContext, SourceFetchResult, SourceProvider } from "./types.js";

export const arxivProvider: SourceProvider = {
  id: "arxiv",
  name: "ArXiv",
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
    const cats = Array.isArray(cfg.categories) ? (cfg.categories as string[]) : ["cs.DC", "cs.SE"];
    const limit = typeof cfg.limit === "number" && cfg.limit > 0 ? cfg.limit : 20;

    const items = await fetchArxivPapers(cats, limit);
    return {
      items: items.map((it) => ({ ...it, source: "arxiv" })),
      details: [`Fetched ${items.length} ArXiv papers`],
    };
  },

  settingsManifest: {
    nav: {
      label: "ArXiv",
      icon: "book-open",
      group: "Sources",
      keywords: ["arxiv", "papers", "research", "academic"],
    },
  },
};
