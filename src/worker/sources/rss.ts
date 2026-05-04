import { fetchRssFeed } from "../integrations/feeds.js";
import type { Env } from "../types.js";
import type { SourceFetchContext, SourceFetchResult, SourceProvider } from "./types.js";

export const rssProvider: SourceProvider = {
  id: "rss",
  name: "RSS / Atom Feed",
  requiredEnv: [],
  multiInstance: true,

  isAvailable() {
    return true;
  },

  isConfigured() {
    return true;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const row = ctx.instanceRow;
    if (!row?.url) {
      return { items: [], details: [], error: "RSS source missing URL" };
    }

    const cfg = row.config ?? {};
    const limit = typeof cfg.limit === "number" && cfg.limit > 0 ? cfg.limit : 20;
    const sourceType = (cfg.source_type as string | undefined) ?? "blog";

    const items = await fetchRssFeed(row.url, sourceType, limit);
    return {
      items,
      details: [`Fetched ${items.length} items from ${row.label}`],
    };
  },

  settingsManifest: {
    nav: {
      label: "RSS / Atom",
      icon: "rss",
      group: "Sources",
      keywords: ["rss", "atom", "feed", "blog"],
    },
  },
};
