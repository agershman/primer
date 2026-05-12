import { isRetryableStatus, parseRetryAfter, RETRY_CONFIG, retryDelay } from "../config/constants.js";

/**
 * One reaction on a Slack message. `name` comes back as the bare
 * emoji name from `conversations.history` (`"bookmark"`, not
 * `":bookmark:"`). `users` is the list of user ids who reacted, in
 * the order they reacted.
 */
export interface SlackReaction {
  name: string;
  count: number;
  users?: string[];
}

interface SlackMessage {
  text: string;
  ts: string;
  user: string;
  channel?: string;
  thread_ts?: string;
  permalink?: string;
  /** Reactions on the message. `conversations.history` returns this
   *  inline by default; `search.messages` doesn't, so search results
   *  carry an empty / undefined value here. */
  reactions?: SlackReaction[];
}

/**
 * Reaction name used by the "bookmark this for later" workflow.
 * Slack's bookmark / save flow has many emoji variants in practice;
 * we currently match exactly `:bookmark:` per the user-facing
 * config. Surfaced as a constant so docs / tests / call sites all
 * agree on the canonical name.
 */
export const BOOKMARK_REACTION_NAME = "bookmark";

/**
 * Predicate — does this Slack message carry a `:bookmark:` reaction
 * from anyone in the channel? Returns `false` when reactions are
 * missing entirely (e.g. the message came from `search.messages`,
 * which doesn't include reaction data).
 */
export function hasBookmarkReaction(message: { reactions?: SlackReaction[] }): boolean {
  if (!message.reactions || message.reactions.length === 0) return false;
  return message.reactions.some((r) => r.name === BOOKMARK_REACTION_NAME);
}

/**
 * Predicate — did the given Slack user id react `:bookmark:` to this
 * message? Differs from `hasBookmarkReaction` (which is true for any
 * reactor) by checking the `users[]` array on the bookmark reaction
 * itself. Used by the cross-channel personal-bookmark scan: only the
 * Primer user's own reactions promote a message into scope when it
 * comes from outside the monitored channel list.
 */
export function hasBookmarkReactionFromUser(message: { reactions?: SlackReaction[] }, slackUserId: string): boolean {
  if (!message.reactions || message.reactions.length === 0) return false;
  const reaction = message.reactions.find((r) => r.name === BOOKMARK_REACTION_NAME);
  if (!reaction) return false;
  return reaction.users?.includes(slackUserId) ?? false;
}

/**
 * Build a Slack message permalink from a workspace domain, channel id, and
 * message timestamp. Slack permalinks follow a deterministic format:
 *
 *   https://<domain>.slack.com/archives/<channelId>/p<ts-without-dot>
 *
 * Used for messages returned by `conversations.history`, which doesn't
 * include a `permalink` field. (`search.messages` does, so its results don't
 * need this.) Returns `undefined` if any input is missing so callers can
 * gracefully fall back to no link.
 */
export function buildSlackPermalink(
  domain: string | null | undefined,
  channelId: string | null | undefined,
  ts: string | null | undefined,
): string | undefined {
  if (!domain || !channelId || !ts) return undefined;
  // ts comes in as "1777011336.200000" → strip the dot for the permalink form
  const tsClean = ts.replace(/\./g, "");
  return `https://${domain}.slack.com/archives/${channelId}/p${tsClean}`;
}

/**
 * Strip Slack's mrkdwn formatting from message text so it renders as clean
 * prose in the UI and reads naturally to the LLM.
 *
 * Slack wraps URLs in angle brackets, encodes user/channel mentions as
 * `<@U…>`/`<#C…|name>`, and HTML-encodes ampersands and angle brackets in
 * message text. Unprocessed, this leaks into source titles and teaching piece
 * inputs as garbage like "<https://example.com>" or "<@U12345>". This utility
 * is the canonical normalization step — apply it at any boundary where Slack
 * message text crosses into the rest of Primer.
 *
 * See https://api.slack.com/reference/surfaces/formatting for the source spec.
 */
export function normalizeSlackText(text: string): string {
  if (!text) return text;
  let out = text;

  // <https://example.com|Display Text> → Display Text
  out = out.replace(/<((?:https?:\/\/|mailto:)[^|>]+)\|([^>]+)>/g, "$2");
  // <https://example.com> → https://example.com
  out = out.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1");
  // <#C12345|channel-name> → #channel-name
  out = out.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");
  // <#C12345> → #channel  (mention without resolved name)
  out = out.replace(/<#[A-Z0-9]+>/g, "#channel");
  // <@U12345|name> → @name
  out = out.replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1");
  // <@U12345> → @user
  out = out.replace(/<@[A-Z0-9]+>/g, "@user");
  // <!subteam^S12345|name> → @name
  out = out.replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "@$1");
  // <!channel>, <!here>, <!everyone> → @channel etc.
  out = out.replace(/<!(channel|here|everyone)>/g, "@$1");

  // HTML-entity decode (Slack escapes &, <, > in text)
  out = out.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  return out;
}

interface SlackSearchResult {
  messages: {
    matches: SlackMessage[];
    total: number;
  };
}

export class SlackClient {
  constructor(private token: string) {}

  private async apiCall<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok && isRetryableStatus(res.status) && attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt, parseRetryAfter(res))));
          continue;
        }
        const data = (await res.json()) as T & { ok: boolean; error?: string };
        if (!data.ok) {
          throw new Error(`Slack API error: ${data.error}`);
        }
        return data;
      } catch (err) {
        lastError = err as Error;
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
        }
      }
    }
    throw lastError;
  }

  async searchMessages(query: string, count = 20): Promise<SlackMessage[]> {
    const result = await this.apiCall<SlackSearchResult>("search.messages", {
      query,
      sort: "timestamp",
      count: String(count),
    });
    return result.messages.matches;
  }

  async getChannelHistory(channel: string, limit = 20): Promise<SlackMessage[]> {
    const result = await this.apiCall<{
      messages: SlackMessage[];
    }>("conversations.history", { channel, limit: String(limit) });
    return result.messages;
  }

  async getChannelHistorySince(channel: string, sinceTs: string, limit = 50): Promise<SlackMessage[]> {
    const result = await this.apiCall<{ messages: SlackMessage[] }>("conversations.history", {
      channel,
      oldest: sinceTs,
      limit: String(limit),
    });
    return result.messages;
  }

  async getThreadReplies(channel: string, threadTs: string, limit = 30): Promise<SlackMessage[]> {
    const result = await this.apiCall<{ messages: SlackMessage[] }>("conversations.replies", {
      channel,
      ts: threadTs,
      limit: String(limit),
    });
    return result.messages ?? [];
  }

  /**
   * Fetch the team's slack domain (the subdomain in <domain>.slack.com).
   * Used to construct permalinks for messages returned by
   * `conversations.history`, which (unlike `search.messages`) doesn't include
   * a `permalink` field. Cached as a string by the caller within a single
   * briefing run so we only call this once.
   *
   * Requires the `team:read` scope. Falls back to `getPermalink` per
   * message at the slackProvider layer if this scope is missing — the
   * fallback works on any token that already has channel-read scopes
   * (which we always need anyway).
   */
  async getTeamInfo(): Promise<{ domain: string }> {
    const result = await this.apiCall<{
      team: { id: string; name: string; domain: string };
    }>("team.info", {});
    return { domain: result.team.domain };
  }

  /**
   * Fetch a real Slack permalink for a single message. Used as a
   * fallback when `team.info` is unavailable (missing `team:read`
   * scope, gov-cloud quirks, custom enterprise domain) so we can
   * still link Slack items in the briefing's "SOURCES" rail.
   *
   * Requires only the channel-read scopes we already have for
   * fetching message history — no new scope to add. Slack's docs:
   * https://api.slack.com/methods/chat.getPermalink
   */
  async getPermalink(channel: string, messageTs: string): Promise<string | undefined> {
    try {
      const result = await this.apiCall<{ permalink: string }>("chat.getPermalink", {
        channel,
        message_ts: messageTs,
      });
      return result.permalink;
    } catch (err) {
      // Fail-soft: a missing permalink degrades the briefing's
      // SOURCES rail to non-clickable Slack items, which is a worse
      // UX than clickable but a far cry from breaking generation.
      console.warn(`[slack] chat.getPermalink failed for ${channel}/${messageTs}:`, err);
      return undefined;
    }
  }

  /**
   * Resolve a Slack user id from an email address. Used to map a
   * Primer user → Slack user automatically so the cross-channel
   * bookmark scan can filter `reactions.list` by that user.
   *
   * Requires the `users:read.email` scope. Returns `null` (instead of
   * throwing) when the user isn't found or the scope is missing —
   * callers want to soft-fail and skip the personal-bookmark path
   * rather than break the whole Slack fetch.
   */
  async lookupUserByEmail(email: string): Promise<string | null> {
    try {
      const result = await this.apiCall<{ user: { id: string } }>("users.lookupByEmail", { email });
      return result.user.id;
    } catch (err) {
      console.warn(`[slack] users.lookupByEmail failed for ${email}:`, err);
      return null;
    }
  }

  /**
   * List the items a Slack user has reacted to, paginated. Returns
   * the message bodies with reactions inline (`full=true`), so the
   * caller can filter to a specific reaction (e.g. `:bookmark:`)
   * without an extra round-trip per item.
   *
   * `reactions.list` orders most-recent-reaction-first but exposes no
   * reaction-added timestamp — callers wanting a time bound must use
   * `message.ts` as a proxy. We cap pagination (default 5 × 100
   * = 500 items) so a heavy reactor doesn't make this unbounded.
   *
   * Requires the `reactions:read` scope. Returns `[]` on auth /
   * scope errors so the slack source can still surface the
   * configured-channel results.
   */
  async listUserReactions(
    userId: string,
    opts: { maxPages?: number } = {},
  ): Promise<Array<{ channel: string; message: SlackMessage }>> {
    const maxPages = opts.maxPages ?? 5;
    const items: Array<{ channel: string; message: SlackMessage }> = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = {
        user: userId,
        full: "true",
        count: "100",
      };
      if (cursor) params.cursor = cursor;

      try {
        const result = await this.apiCall<{
          items: Array<{
            type: string;
            channel?: string;
            message?: SlackMessage;
          }>;
          response_metadata?: { next_cursor?: string };
        }>("reactions.list", params);

        for (const item of result.items) {
          if (item.type === "message" && item.message && item.channel) {
            items.push({ channel: item.channel, message: item.message });
          }
        }

        cursor = result.response_metadata?.next_cursor;
        if (!cursor) break;
      } catch (err) {
        // Soft-fail: missing `reactions:read` scope, or any other
        // failure, leaves the cross-channel bookmark scan a no-op
        // for this run. The configured-channel pipeline is unaffected.
        console.warn(`[slack] reactions.list failed for user=${userId}:`, err);
        break;
      }
    }

    return items;
  }

  async listChannels(): Promise<Array<{ id: string; name: string; numMembers: number; topic: string }>> {
    const all: Array<{ id: string; name: string; numMembers: number; topic: string }> = [];
    let cursor: string | undefined;

    for (let page = 0; page < 20; page++) {
      const params: Record<string, string> = {
        types: "public_channel",
        exclude_archived: "true",
        limit: "1000",
      };
      if (cursor) params.cursor = cursor;

      const result = await this.apiCall<{
        channels: Array<{
          id: string;
          name: string;
          num_members: number;
          topic: { value: string };
        }>;
        response_metadata?: { next_cursor?: string };
      }>("conversations.list", params);

      for (const ch of result.channels) {
        all.push({
          id: ch.id,
          name: ch.name,
          numMembers: ch.num_members,
          topic: ch.topic?.value || "",
        });
      }

      cursor = result.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    return all;
  }
}
