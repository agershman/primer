import { resolveModel } from "../config/models.js";
import {
  buildSlackPermalink,
  hasBookmarkReaction,
  hasBookmarkReactionFromUser,
  normalizeSlackText,
  SlackClient,
  type SlackReaction,
} from "../integrations/slack.js";
import type { Env } from "../types.js";
import type { SourceContext, SourceFetchContext, SourceFetchResult, SourceProvider, WorkContextItem } from "./types.js";

const NOISE_PATTERNS =
  /^(ok|okay|sure|thanks|thank you|thx|ty|yep|yup|yes|no|nope|absolutely|sounds good|got it|will do|on it|ack|lgtm|nice|\+1|👍|👎|🎉|✅|❌|🙏|💯|🔥|👀|😊|😂|🤔|❤️|💪|🫡|🚀)\s*[.!?]*$/i;

function isNoiseMessage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 15) return true;
  if (NOISE_PATTERNS.test(trimmed)) return true;
  if (/^:[a-z_+-]+:\s*$/.test(trimmed)) return true;
  return false;
}

interface SlackThread {
  id: string;
  title: string;
  url?: string;
  /** Slack channel id (e.g. `C01ABCD...`) the root message lives in.
   *  Carried through so that even when `url` is empty (team.info
   *  scope missing → no domain → no buildable permalink) the
   *  downstream fallback can call `chat.getPermalink(channel, ts)`
   *  to construct a real link. */
  channel?: string;
  description?: string;
  /** True when this thread was kept because it carries a
   *  `:bookmark:` reaction from someone in the channel. Used to
   *  surface a "bookmarked" tag on the resulting WorkContextItem so
   *  the LLM (and the user, if they peek at the work-context bar)
   *  can see why the otherwise-quiet message was included. */
  bookmarked?: boolean;
}

interface RawSlackMessage {
  text: string;
  ts: string;
  user: string;
  channel?: string;
  thread_ts?: string;
  permalink?: string;
  reactions?: SlackReaction[];
}

interface GroupOptions {
  /** When true, messages with a `:bookmark:` reaction bypass the
   *  noise filter and the per-thread length floor — bookmarking is
   *  treated as an explicit "include this regardless" signal from
   *  whoever reacted. */
  includeBookmarked?: boolean;
}

// Exported for unit testing — the bookmark-bypass / sort behavior
// is the kind of pure-data transform that's much cleaner to verify
// against fixed input than to reach through `fetch()`.
export function groupAndFilterSlackMessages(rawMessages: RawSlackMessage[], options: GroupOptions = {}): SlackThread[] {
  const includeBookmarked = !!options.includeBookmarked;
  const messages = rawMessages.map((m) => ({ ...m, text: normalizeSlackText(m.text) }));

  const threads = new Map<
    string,
    {
      firstText: string;
      firstTs: string;
      firstPermalink?: string;
      channel?: string;
      messages: string[];
      participants: Set<string>;
      totalChars: number;
      bookmarked: boolean;
    }
  >();

  for (const msg of messages) {
    const threadKey = msg.thread_ts ?? msg.ts;
    // A bookmark anywhere in the thread counts. The root carries
    // most bookmarks in practice (people save threads at the top),
    // but allowing replies to qualify keeps the semantic clean: any
    // bookmarked message in a thread → include the thread.
    const isBookmarked = includeBookmarked && hasBookmarkReaction(msg);
    // Bookmarked messages bypass the noise / brevity filters; the
    // user has explicitly told us to keep them.
    const passesFilter = isBookmarked || !isNoiseMessage(msg.text);

    const existing = threads.get(threadKey);
    if (existing) {
      if (passesFilter) {
        existing.messages.push(msg.text);
        existing.totalChars += msg.text.length;
      }
      existing.participants.add(msg.user);
      if (isBookmarked) existing.bookmarked = true;
    } else {
      threads.set(threadKey, {
        firstText: msg.text,
        firstTs: msg.ts,
        firstPermalink: msg.permalink,
        channel: msg.channel,
        messages: passesFilter ? [msg.text] : [],
        participants: new Set([msg.user]),
        totalChars: passesFilter ? msg.text.length : 0,
        bookmarked: isBookmarked,
      });
    }
  }

  const result: SlackThread[] = [];
  for (const [threadKey, thread] of threads) {
    // Bookmarked threads always make it through, even if they're
    // short or quiet. Normal threads still need to clear the 30-char
    // / 2-message floor.
    if (!thread.bookmarked && thread.totalChars < 30 && thread.messages.length <= 1) continue;

    const title = thread.firstText.slice(0, 120);
    const substantiveMessages = thread.messages.filter((m) => !isNoiseMessage(m)).slice(0, 5);
    const description = substantiveMessages.length > 1 ? substantiveMessages.join("\n").slice(0, 500) : undefined;

    result.push({
      id: threadKey,
      title,
      url: thread.firstPermalink,
      channel: thread.channel,
      description,
      bookmarked: thread.bookmarked || undefined,
    });
  }

  // Sort: bookmarked threads first (highest-signal), then by
  // description richness as before.
  result.sort((a, b) => {
    if (!!a.bookmarked !== !!b.bookmarked) return a.bookmarked ? -1 : 1;
    return (b.description?.length ?? 0) - (a.description?.length ?? 0);
  });
  return result;
}

export const slackProvider: SourceProvider = {
  id: "slack",
  name: "Slack",
  requiredEnv: ["SLACK_TOKEN"],
  multiInstance: false,

  isAvailable(env: Env) {
    return !!env.SLACK_TOKEN;
  },

  isConfigured() {
    return true;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    const sourceConfig = ctx.sourceConfig;
    const slackFilters = (sourceConfig.slack ?? {}) as {
      channels?: string[];
      historyDays?: number;
    };

    const client = new SlackClient(ctx.env.SLACK_TOKEN);
    const configuredChannels = slackFilters.channels;

    // Window applies to both the configured-channel pull AND the
    // cross-channel bookmark scan — bookmarks on messages older
    // than the window are dropped so the work-context bar doesn't
    // accumulate permanent residents. `reactions.list` exposes no
    // reaction-added timestamp, so `message.ts` is the proxy.
    const historyDays = slackFilters.historyDays ?? 1;
    const sinceTs = Math.floor(Date.now() / 1000) - historyDays * 86400;
    const sinceTsStr = String(sinceTs);

    // Resolve the Primer user → Slack user id once per fetch via
    // email match. Soft-fail: when this returns null (missing
    // `users:read.email` scope, no matching workspace user, OR the
    // user's Primer email differs from their Slack one), the
    // cross-channel bookmark scan becomes a no-op and we fall back
    // to the configured-channel pipeline unchanged.
    const slackUserId = ctx.userEmail ? await client.lookupUserByEmail(ctx.userEmail) : null;

    let rawThreads: SlackThread[];

    if (configuredChannels?.length || slackUserId) {
      // Try team.info for the workspace domain. Fast path: if it
      // works (token has `team:read`), we can build all permalinks
      // locally with zero extra API calls. If it fails, the
      // chat.getPermalink fallback below fills in URLs per kept
      // thread — slower (one API call per thread, ~10 calls total
      // post-filter) but works on any token that has the channel-
      // read scopes we already require.
      let teamDomain: string | undefined;
      try {
        const teamInfo = await client.getTeamInfo();
        teamDomain = teamInfo.domain;
      } catch (err) {
        // The most common failure here is `missing_scope` —
        // `team.info` requires `team:read`, which not every Slack
        // app has by default. Log loudly so the operator knows
        // to add the scope OR rely on the fallback below.
        console.error(
          "[slack] team.info failed — falling back to chat.getPermalink per thread for permalinks. " +
            `Add the team:read scope to your Slack app to skip this fallback. Error: ${err}`,
        );
      }

      const allMessages: RawSlackMessage[] = [];
      // De-dupe key: (channel, ts). A message bookmarked by the user
      // inside a monitored channel would otherwise land in
      // `allMessages` twice — once from `getChannelHistorySince`
      // and once from `reactions.list` — and confuse the grouping
      // step.
      const seen = new Set<string>();
      const push = (msg: RawSlackMessage) => {
        const channelKey = msg.channel ?? "";
        const key = `${channelKey}:${msg.ts}`;
        if (seen.has(key)) return;
        seen.add(key);
        allMessages.push(msg);
      };

      if (configuredChannels?.length) {
        for (const channelId of configuredChannels) {
          try {
            const msgs = await client.getChannelHistorySince(channelId, sinceTsStr);
            for (const m of msgs) {
              push({
                ...m,
                channel: channelId,
                permalink: m.permalink ?? buildSlackPermalink(teamDomain, channelId, m.ts),
                // `conversations.history` returns reactions inline by
                // default — preserve them through the pipeline so the
                // grouping step can detect bookmarks.
                reactions: m.reactions,
              });
            }
          } catch (err) {
            console.error(`[slack] Failed to fetch channel ${channelId}:`, err);
          }
        }
      }

      // Always-on cross-channel personal-bookmark scan: pull every
      // message the Primer user reacted `:bookmark:` to, filter to
      // those inside the history window, and merge them into the
      // pool. Bookmarks on messages already pulled by the channel
      // history above are deduped by `push`. Soft-fails to empty
      // when `reactions:read` is missing — see `listUserReactions`.
      if (slackUserId) {
        try {
          const reactionItems = await client.listUserReactions(slackUserId);
          for (const item of reactionItems) {
            const msg = item.message;
            const tsNumber = Number.parseFloat(msg.ts);
            if (!Number.isFinite(tsNumber) || tsNumber < sinceTs) continue;
            if (!hasBookmarkReactionFromUser(msg, slackUserId)) continue;
            push({
              text: msg.text,
              ts: msg.ts,
              user: msg.user,
              channel: item.channel,
              thread_ts: msg.thread_ts,
              permalink: msg.permalink ?? buildSlackPermalink(teamDomain, item.channel, msg.ts),
              reactions: msg.reactions,
            });
          }
        } catch (err) {
          console.error("[slack] Cross-channel bookmark scan failed:", err);
        }
      }

      rawThreads = groupAndFilterSlackMessages(allMessages, { includeBookmarked: true });
    } else {
      // No configured channels and no resolvable Slack user — last-
      // resort fallback to `search.messages from:me` so the source
      // still produces something. Bookmarks aren't available on this
      // path (search.messages doesn't return reactions), but the
      // grouping step still treats anything that arrives here as
      // bookmark-eligible for filter-bypass semantics symmetry.
      const searchResults = await client.searchMessages("from:me", 20);
      rawThreads = groupAndFilterSlackMessages(searchResults, { includeBookmarked: true });
    }

    interface EnrichedThread {
      id: string;
      title: string;
      url?: string;
      channel?: string;
      description?: string;
      messages: string[];
      participantCount: number;
      bookmarked?: boolean;
      insight?: import("../services/slack-analyzer.js").ConversationInsight;
    }

    const threadsWithReplies: EnrichedThread[] = [];
    const slackClient = new SlackClient(ctx.env.SLACK_TOKEN);
    const topThreads = rawThreads.slice(0, 10);

    for (const thread of topThreads) {
      // Prefer the channel id we threaded through directly (always
      // populated when configuredChannels was used); fall back to
      // parsing the URL (only relevant on the search.messages path
      // where channels weren't pre-tagged).
      const channelId = thread.channel ?? thread.url?.match(/archives\/([A-Z0-9]+)/)?.[1] ?? undefined;
      const base: EnrichedThread = {
        id: thread.id,
        title: thread.title,
        url: thread.url,
        channel: channelId,
        description: thread.description,
        messages: thread.description ? [thread.title, thread.description] : [thread.title],
        participantCount: 1,
        bookmarked: thread.bookmarked,
      };

      if (channelId) {
        try {
          const replies = await slackClient.getThreadReplies(channelId, thread.id, 30);
          if (replies.length > 1) {
            const participants = new Set(replies.map((r) => r.user));
            base.messages = replies.map((r) => normalizeSlackText(r.text)).filter((t) => t.trim().length > 10);
            base.participantCount = participants.size;
            base.description = base.messages.slice(0, 8).join("\n").slice(0, 1000);
          }
        } catch {
          // Fall back to grouped messages.
        }

        // Permalink fallback: if buildSlackPermalink couldn't build
        // a URL because team.info failed, fetch the real permalink
        // from chat.getPermalink. One API call per kept thread
        // (~10 total post-filter), which is cheap and keeps the
        // SOURCES rail clickable even when the workspace domain
        // isn't available.
        if (!base.url) {
          base.url = await slackClient.getPermalink(channelId, thread.id);
        }
      }
      threadsWithReplies.push(base);
    }

    for (const thread of rawThreads.slice(10)) {
      threadsWithReplies.push({
        id: thread.id,
        title: thread.title,
        url: thread.url,
        description: thread.description,
        messages: thread.description ? [thread.title, thread.description] : [thread.title],
        participantCount: 1,
        bookmarked: thread.bookmarked,
      });
    }

    // Run LLM conversation analysis on threads with enough content.
    if (threadsWithReplies.some((t) => t.messages.length >= 2)) {
      try {
        const { analyzeSlackConversations } = await import("../services/slack-analyzer.js");
        const conceptExtractionSpec = resolveModel(sourceConfig, "conceptExtraction");
        const insights = await analyzeSlackConversations(
          ctx.db,
          ctx.userId,
          ctx.llm,
          threadsWithReplies
            .filter((t) => t.messages.length >= 2)
            .map((t) => ({
              threadId: t.id,
              title: t.title,
              url: t.url,
              channel: t.channel,
              messages: t.messages,
              participantCount: t.participantCount,
            })),
          conceptExtractionSpec,
        );
        const insightMap = new Map(insights.map((i) => [i.threadId, i]));
        for (const thread of threadsWithReplies) {
          thread.insight = insightMap.get(thread.id);
        }
      } catch (err) {
        console.error("[slack] Conversation analysis failed:", err);
      }
    }

    const items: WorkContextItem[] = [];
    for (const thread of threadsWithReplies) {
      const insight = thread.insight;
      let description = thread.description ?? "";
      if (insight) {
        const parts: string[] = [];
        if (insight.summary) parts.push(insight.summary);
        if (insight.learningOpportunities.length > 0) {
          parts.push("Learning opportunities: " + insight.learningOpportunities.join("; "));
        }
        if (insight.knowledgeGaps.length > 0) {
          parts.push("Knowledge gaps: " + insight.knowledgeGaps.join("; "));
        }
        if (insight.questionsRaised.length > 0) {
          parts.push("Questions: " + insight.questionsRaised.slice(0, 3).join("; "));
        }
        description = parts.join("\n");
      }

      // Tag bookmarked threads in both the title (for human
      // scannability in the work-context bar) and the description
      // (so the LLM has explicit "this is a saved-for-later
      // message" context when extracting concepts). Title prefix
      // uses the bookmark glyph so it stays compact.
      const bookmarkLabel = thread.bookmarked ? "Bookmarked by a teammate (`:bookmark:` reaction)." : null;
      const fullTitle = insight?.summary ? `${thread.title.slice(0, 60)} — ${insight.summary}` : thread.title;
      const finalTitle = thread.bookmarked ? `🔖 ${fullTitle}` : fullTitle;
      const finalDescription = bookmarkLabel
        ? description
          ? `${bookmarkLabel}\n${description}`
          : bookmarkLabel
        : description || undefined;

      items.push({
        type: "slack_thread",
        id: thread.id,
        title: finalTitle,
        url: thread.url,
        description: finalDescription,
        // Carry the bookmark signal as a first-class field so the
        // concept extractor + teaching-target selector can act on it
        // without parsing the 🔖 title prefix.
        bookmarked: thread.bookmarked || undefined,
      });
    }

    const details: string[] = [];
    if (threadsWithReplies.length > 0) {
      const analyzed = threadsWithReplies.filter((t) => t.insight).length;
      const bookmarkedCount = threadsWithReplies.filter((t) => t.bookmarked).length;
      const bookmarkSuffix = bookmarkedCount > 0 ? `, ${bookmarkedCount} 🔖 bookmarked` : "";
      details.push(`◈ ${threadsWithReplies.length} Slack threads (${analyzed} analyzed${bookmarkSuffix})`);
    }

    return { items, details };
  },

  async getSettingsMetadata(ctx: SourceContext) {
    const client = new SlackClient(ctx.env.SLACK_TOKEN);
    return { channels: await client.listChannels() };
  },

  settingsManifest: {
    nav: {
      label: "Slack",
      icon: "hash",
      group: "Sources",
      keywords: ["channels", "messages", "threads", "conversations"],
    },
    metadata: {
      channels: {
        endpoint: "/api/slack/channels",
        labelKey: "name",
        valueKey: "id",
      },
    },
  },

  userFields: [
    { type: "multiSelect", key: "channels", label: "Channels to monitor", metadataRef: "channels" },
    {
      type: "select",
      key: "historyDays",
      label: "History window",
      options: [
        { value: "1", label: "1 day" },
        { value: "3", label: "3 days" },
        { value: "7", label: "7 days" },
        { value: "14", label: "14 days" },
      ],
      default: "7",
    },
  ],
};
