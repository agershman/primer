/**
 * Tests for the Slack source pipeline — specifically the
 * `:bookmark:` reaction bypass and surrounding plumbing.
 *
 * Coverage:
 *   - `hasBookmarkReaction` reaction-name detection (any reactor)
 *   - `hasBookmarkReactionFromUser` (specific reactor — used by the
 *     cross-channel personal-bookmark scan)
 *   - `groupAndFilterSlackMessages` internal grouping/filter logic:
 *     - default behavior (bookmarks are ignored, noise filter applies)
 *     - includeBookmarked: noise messages with :bookmark: are kept
 *     - includeBookmarked: short threads with a bookmarked root pass
 *       the per-thread length floor
 *     - bookmarked threads sort to the top
 *     - bookmark on a reply (not the root) still flags the thread
 *   - Source-text contracts pinning the always-on bookmark behavior
 *     (no opt-in toggle; includeBookmarked: true is forced; the
 *     SlackPanel shows an info row instead of a switch).
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  hasBookmarkReaction,
  hasBookmarkReactionFromUser,
  BOOKMARK_REACTION_NAME,
} from "../../src/worker/integrations/slack";
import { groupAndFilterSlackMessages } from "../../src/worker/sources/slack";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("hasBookmarkReaction", () => {
  it("matches the bare 'bookmark' name (Slack returns reactions without colons)", () => {
    expect(BOOKMARK_REACTION_NAME).toBe("bookmark");
    expect(
      hasBookmarkReaction({
        reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated reactions", () => {
    expect(
      hasBookmarkReaction({
        reactions: [
          { name: "eyes", count: 1 },
          { name: "thumbsup", count: 3 },
        ],
      }),
    ).toBe(false);
  });

  it("returns false when reactions are absent / empty", () => {
    expect(hasBookmarkReaction({})).toBe(false);
    expect(hasBookmarkReaction({ reactions: [] })).toBe(false);
  });

  it("does NOT match reaction-name lookalikes", () => {
    expect(
      hasBookmarkReaction({
        reactions: [{ name: "bookmark_tabs", count: 1 }],
      }),
    ).toBe(false);
  });
});

describe("hasBookmarkReactionFromUser", () => {
  it("matches when the given user id appears in the bookmark reaction's users[]", () => {
    expect(
      hasBookmarkReactionFromUser(
        {
          reactions: [
            { name: "bookmark", count: 2, users: ["U1", "U2"] },
          ],
        },
        "U2",
      ),
    ).toBe(true);
  });

  it("returns false when a different user reacted but not the given one", () => {
    expect(
      hasBookmarkReactionFromUser(
        {
          reactions: [{ name: "bookmark", count: 1, users: ["U1"] }],
        },
        "U2",
      ),
    ).toBe(false);
  });

  it("returns false when the bookmark reaction has no users[] field", () => {
    expect(
      hasBookmarkReactionFromUser(
        {
          reactions: [{ name: "bookmark", count: 1 }],
        },
        "U1",
      ),
    ).toBe(false);
  });

  it("returns false when the message has reactions but none are :bookmark:", () => {
    expect(
      hasBookmarkReactionFromUser(
        {
          reactions: [{ name: "eyes", count: 1, users: ["U1"] }],
        },
        "U1",
      ),
    ).toBe(false);
  });

  it("returns false when reactions are absent / empty", () => {
    expect(hasBookmarkReactionFromUser({}, "U1")).toBe(false);
    expect(hasBookmarkReactionFromUser({ reactions: [] }, "U1")).toBe(false);
  });
});

describe("groupAndFilterSlackMessages — default behavior (no bookmarks)", () => {
  it("filters out a noise-only thread", () => {
    const result = groupAndFilterSlackMessages([
      { text: "thanks!", ts: "1.0", user: "U1" },
    ]);
    expect(result).toEqual([]);
  });

  it("filters out a thread under the 30-char / 2-message floor", () => {
    const result = groupAndFilterSlackMessages([
      { text: "short msg", ts: "1.0", user: "U1" },
    ]);
    expect(result).toEqual([]);
  });

  it("keeps substantive threads even without bookmarks", () => {
    const result = groupAndFilterSlackMessages([
      {
        text: "Hey team, we should think about migrating off of Postgres for the search index — performance has been suffering lately.",
        ts: "1.0",
        user: "U1",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBeUndefined();
  });

  it("ignores bookmark reactions when includeBookmarked is off", () => {
    const result = groupAndFilterSlackMessages([
      {
        text: "thanks!",
        ts: "1.0",
        user: "U1",
        reactions: [{ name: "bookmark", count: 1 }],
      },
    ]);
    // Without the toggle, "thanks!" stays filtered out.
    expect(result).toEqual([]);
  });
});

describe("groupAndFilterSlackMessages — includeBookmarked bypass", () => {
  it("keeps a noise message that carries a :bookmark: reaction", () => {
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "thanks!",
          ts: "1.0",
          user: "U1",
          reactions: [{ name: "bookmark", count: 1 }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
  });

  it("keeps a short message that carries a :bookmark: reaction (length-floor bypass)", () => {
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "ship it",
          ts: "2.0",
          user: "U2",
          reactions: [{ name: "bookmark", count: 2 }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
  });

  it("sorts bookmarked threads to the top", () => {
    const result = groupAndFilterSlackMessages(
      [
        {
          text: "Hey team, we should think about migrating off of Postgres for the search index — performance has been suffering lately.",
          ts: "1.0",
          user: "U1",
        },
        {
          text: "yep",
          ts: "2.0",
          user: "U2",
          reactions: [{ name: "bookmark", count: 1 }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(2);
    expect(result[0].bookmarked).toBe(true);
    expect(result[1].bookmarked).toBeUndefined();
  });

  it("flags the thread when the bookmark sits on a reply (not the root)", () => {
    // Both messages share `thread_ts: 1.0`, so they collapse into
    // one thread. The reply carries the :bookmark:; the bypass
    // semantic is "any bookmarked message in the thread → keep it".
    const result = groupAndFilterSlackMessages(
      [
        { text: "huh", ts: "1.0", user: "U1" },
        {
          text: "this matters",
          ts: "2.0",
          user: "U2",
          thread_ts: "1.0",
          reactions: [{ name: "bookmark", count: 1 }],
        },
      ],
      { includeBookmarked: true },
    );
    expect(result).toHaveLength(1);
    expect(result[0].bookmarked).toBe(true);
  });

  it("non-bookmarked noise still gets filtered when includeBookmarked is on", () => {
    // The toggle is a bypass for *bookmarked* messages only — it
    // shouldn't flood the work-context bar with every "thanks!" in
    // the channel.
    const result = groupAndFilterSlackMessages(
      [{ text: "thanks!", ts: "1.0", user: "U1" }],
      { includeBookmarked: true },
    );
    expect(result).toEqual([]);
  });
});

describe("Slack source — option plumbing", () => {
  it("source provider no longer declares the includeBookmarked toggle", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // The opt-in toggle is gone — bookmark-bypass is built-in now.
    expect(src).not.toMatch(/key:\s*"includeBookmarked"/);
    expect(src).not.toMatch(/!!slackFilters\.includeBookmarked/);
  });

  it("source fetch threads reactions through and always passes includeBookmarked: true", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // Reactions field gets carried from the Slack API response into
    // the message buffer that `groupAndFilterSlackMessages` sees.
    expect(src).toMatch(/reactions:\s*m\.reactions/);
    // Both call sites force the bypass on unconditionally — the
    // user-curated bookmark is, by construction, an explicit signal.
    const trueCalls = src.match(/groupAndFilterSlackMessages\([^)]+\{\s*includeBookmarked:\s*true\s*\}\)/g);
    expect(trueCalls?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("fetch resolves the Slack user id and uses listUserReactions for cross-channel bookmarks", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toContain("lookupUserByEmail");
    expect(src).toContain("listUserReactions");
    expect(src).toContain("hasBookmarkReactionFromUser");
    // The scan is scoped to the same `sinceTs` floor as channel history
    expect(src).toMatch(/tsNumber\s*<\s*sinceTs/);
  });

  it("bookmarked threads get the 🔖 prefix and explicit description tag", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toContain("🔖");
    expect(src).toMatch(/Bookmarked by a teammate/);
  });

  it("SlackPanel drops the toggle and shows an always-on info row instead", async () => {
    const src = await read("src/frontend/components/settings/panels/SlackPanel.tsx");
    // No more ToggleRow / includeBookmarked plumbing
    expect(src).not.toContain("ToggleRow");
    expect(src).not.toContain("includeBookmarked");
    // Field still renders with the BookmarkReactionTag and an
    // "always in scope" message in the card.
    expect(src).toMatch(/always in scope/i);
  });

  it("BookmarkReactionTag pairs the 🔖 emoji with the literal :bookmark: shortcode in inline-code styling", async () => {
    const src = await read("src/frontend/components/settings/panels/SlackPanel.tsx");
    // Helper exists and is used in both the field hint AND the info
    // card body (so the user sees the emoji + shortcode in both spots).
    expect(src).toContain("function BookmarkReactionTag");
    const usages = src.match(/<BookmarkReactionTag\s*\/>/g) ?? [];
    expect(usages.length).toBeGreaterThanOrEqual(2);
    // Visual emoji + literal shortcode in parens, with the shortcode
    // styled as inline code (font-mono + bg-bg-warm pill, mirroring
    // `RichText.tsx`).
    expect(src).toContain("🔖");
    expect(src).toMatch(/\{["']\s*\(\s*["']\}/);
    expect(src).toMatch(/font-mono[^"]*bg-bg-warm[\s\S]{0,200}:bookmark:/);
  });
});
