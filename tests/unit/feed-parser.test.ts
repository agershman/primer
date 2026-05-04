/**
 * Pins the contract for `fetchRssFeed` — the parser behind the
 * "Add a source by RSS URL" flow in Settings → Sources → Feeds.
 *
 * The parser must handle both RSS 2.0 (`<item>` + text-content
 * `<link>`) AND Atom 1.0 (`<entry>` + self-closing `<link href="..."/>`).
 * Earlier versions only matched `<link>...</link>` text content,
 * which silently parsed zero items for most real Atom feeds
 * (Substack, GitHub releases.atom, Mastodon, Blogger, etc.).
 *
 * Tests stub `globalThis.fetch` so we exercise the full `fetchRssFeed`
 * path, not just the inner parsers (which aren't exported).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRssFeed } from "../../src/worker/integrations/feeds.js";

function mockFetchOnceWithBody(body: string) {
  // biome-ignore lint/suspicious/noExplicitAny: vi.stubGlobal uses any-shaped fetch
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })) as any);
}

describe("fetchRssFeed — RSS 2.0", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses standard RSS 2.0 with text-content links", async () => {
    mockFetchOnceWithBody(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <title>Example Blog</title>
        <item>
          <title>Hello world</title>
          <link>https://example.com/hello</link>
          <description>First post</description>
          <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
        </item>
        <item>
          <title>Second</title>
          <link>https://example.com/two</link>
        </item>
      </channel></rss>`);

    const items = await fetchRssFeed("https://example.com/feed", "blog", 10);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Hello world",
      url: "https://example.com/hello",
      summary: "First post",
      source: "blog",
    });
    expect(items[0].published).toMatch(/Jan 2024/);
    expect(items[1].url).toBe("https://example.com/two");
  });

  it("decodes CDATA + entity-escaped titles in RSS 2.0", async () => {
    mockFetchOnceWithBody(`<rss><channel>
      <item>
        <title><![CDATA[Why "Postgres > MySQL" matters]]></title>
        <link>https://example.com/x</link>
      </item>
      <item>
        <title>A &amp; B &lt;tags&gt;</title>
        <link>https://example.com/y</link>
      </item>
    </channel></rss>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items[0].title).toBe('Why "Postgres > MySQL" matters');
    expect(items[1].title).toBe("A & B <tags>");
  });

  it("respects the limit parameter", async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      `<item><title>Post ${i}</title><link>https://example.com/${i}</link></item>`,
    ).join("");
    mockFetchOnceWithBody(`<rss><channel>${items}</channel></rss>`);

    const out = await fetchRssFeed("u", "blog", 5);
    expect(out).toHaveLength(5);
  });
});

describe("fetchRssFeed — Atom 1.0", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses Atom feeds with self-closing <link href='...'/> (the historical bug)", async () => {
    // Shape mirrors what Substack / Blogger / Mastodon / many indie
    // blogs actually serve. Pre-fix this returned [] silently.
    mockFetchOnceWithBody(`<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Indie Blog</title>
        <entry>
          <title>Atom post one</title>
          <link rel="alternate" type="text/html" href="https://indie.example/post-1"/>
          <published>2024-03-15T12:00:00Z</published>
          <summary>A short summary</summary>
        </entry>
        <entry>
          <title>Atom post two</title>
          <link href="https://indie.example/post-2"/>
          <updated>2024-03-16T12:00:00Z</updated>
        </entry>
      </feed>`);

    const items = await fetchRssFeed("u", "blog", 10);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "Atom post one",
      url: "https://indie.example/post-1",
      summary: "A short summary",
      source: "blog",
    });
    expect(items[0].published).toBe("2024-03-15T12:00:00Z");
    expect(items[1].url).toBe("https://indie.example/post-2");
  });

  it("prefers rel='alternate' over rel='self' / rel='edit' when an entry has multiple links", async () => {
    // GitHub releases.atom and many CMS-generated feeds emit multiple
    // <link> tags per entry. We must pick the human-facing one, not
    // the API self-link.
    mockFetchOnceWithBody(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Multi-link entry</title>
        <link rel="self" href="https://api.example.com/items/123"/>
        <link rel="edit" href="https://api.example.com/items/123/edit"/>
        <link rel="alternate" type="text/html" href="https://example.com/items/123"/>
        <link rel="enclosure" href="https://example.com/items/123.mp3"/>
      </entry>
    </feed>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://example.com/items/123");
  });

  it("treats a <link> with no `rel` as alternate (Atom default)", async () => {
    // Per RFC 4287, an Atom <link> with no rel attribute defaults to
    // rel="alternate". Many feeds rely on that.
    mockFetchOnceWithBody(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Default rel entry</title>
        <link href="https://example.com/default"/>
      </entry>
    </feed>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items[0].url).toBe("https://example.com/default");
  });

  it("falls back to <content> when an Atom entry has no <summary>", async () => {
    mockFetchOnceWithBody(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Content-only entry</title>
        <link href="https://example.com/c"/>
        <content type="html">&lt;p&gt;Body of post&lt;/p&gt;</content>
      </entry>
    </feed>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items[0].summary).toContain("Body of post");
  });

  it("silently drops entries with no parseable link rather than crashing", async () => {
    mockFetchOnceWithBody(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>No link</title>
      </entry>
      <entry>
        <title>Has link</title>
        <link href="https://example.com/ok"/>
      </entry>
    </feed>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Has link");
  });

  it("rejects non-http(s) hrefs (mailto:, javascript:, etc.)", async () => {
    mockFetchOnceWithBody(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Sketchy link</title>
        <link href="javascript:alert(1)"/>
      </entry>
      <entry>
        <title>Email link</title>
        <link href="mailto:foo@bar.com"/>
      </entry>
      <entry>
        <title>Real link</title>
        <link href="https://example.com/real"/>
      </entry>
    </feed>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://example.com/real");
  });
});

describe("fetchRssFeed — format detection", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back from RSS to Atom when no <item> elements parse cleanly", async () => {
    // Atom-only feed — RSS pass yields zero, Atom pass yields one.
    mockFetchOnceWithBody(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Atom-only</title>
        <link href="https://example.com/atom"/>
      </entry>
    </feed>`);

    const items = await fetchRssFeed("u", "blog");
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://example.com/atom");
  });

  it("returns an empty array for a malformed feed rather than throwing", async () => {
    mockFetchOnceWithBody(`<html><body>Not a feed</body></html>`);
    const items = await fetchRssFeed("u", "blog");
    expect(items).toEqual([]);
  });
});
