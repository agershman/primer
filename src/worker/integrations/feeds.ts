import { isRetryableStatus, RETRY_CONFIG, retryDelay } from "../config/constants.js";

export interface FeedItem {
  title: string;
  url: string;
  summary?: string;
  published?: string;
  /** Generic source kind (e.g. "rss", "hn", "arxiv"). Already set by
   *  the fetch helpers in this file. Used by the prompt + result
   *  rendering. */
  source: string;
  /** Source instance id (e.g. `ecs_xxx`). Set by the adjacent
   *  scanner *after* fetching, when it knows which configured
   *  instance the items came from. Used to look up per-instance
   *  relevance-filter overrides. Optional because the fetch helpers
   *  themselves don't know about instance ids. */
  sourceInstanceId?: string;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1 && isRetryableStatus(res.status)) {
          await new Promise((r) => setTimeout(r, retryDelay(attempt)));
          continue;
        }
        throw new Error(`Feed ${res.status}: ${url}`);
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, retryDelay(attempt)));
      }
    }
  }
  throw lastError;
}

export async function fetchHackerNewsTop(limit = 30): Promise<FeedItem[]> {
  const res = await fetchWithRetry("https://hacker-news.firebaseio.com/v0/beststories.json");
  const ids = ((await res.json()) as number[]).slice(0, limit);

  const items: FeedItem[] = [];
  const batchSize = 10;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        try {
          const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          const item = (await itemRes.json()) as {
            title: string;
            url?: string;
            id: number;
          };
          return {
            title: item.title,
            url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
            source: "hn",
          };
        } catch {
          return null;
        }
      }),
    );
    items.push(...(batchResults.filter(Boolean) as FeedItem[]));
  }
  return items;
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Pulls a named attribute value out of a tag's attribute string.
 * Handles both `attr="..."` and `attr='...'`.
 */
function extractAttr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m?.[2] ?? m?.[3];
}

interface ParsedItem {
  title: string;
  url: string;
  summary?: string;
  published?: string;
}

/**
 * RSS 2.0 / RDF (RSS 1.0) item parser. Both use `<item>...<link>URL</link>...</item>`
 * with the URL as text content.
 */
function parseRss(xml: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const c = m[1];
    const title = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const link = c.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1];
    const desc = c.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1];
    const pub =
      c.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ?? c.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i)?.[1];
    if (title && link) {
      const url = decodeXmlText(link);
      if (!url || !/^https?:/i.test(url)) continue;
      items.push({
        title: decodeXmlText(title),
        url,
        summary: desc ? decodeXmlText(desc) : undefined,
        published: pub ? decodeXmlText(pub) : undefined,
      });
    }
  }
  return items;
}

/**
 * Atom 1.0 entry parser. Atom links are typically *self-closing* with the
 * URL in an `href` attribute, e.g. `<link rel="alternate" href="..."/>`.
 * An entry may have multiple `<link>` elements (alternate, self, edit,
 * enclosure, hub, …). We pick the one most likely to be the human-facing
 * permalink — `rel="alternate"` (or no `rel`, since Atom defaults to
 * alternate) with an HTML-ish `type` if specified.
 */
function pickAtomLink(entryContent: string): string | undefined {
  const linkRe = /<link\b([^>]*)\/?>/gi;
  const candidates: Array<{ href: string; score: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(entryContent)) !== null) {
    const attrs = m[1];
    const href = extractAttr(attrs, "href");
    if (!href) continue;
    const rel = (extractAttr(attrs, "rel") ?? "alternate").toLowerCase();
    const type = (extractAttr(attrs, "type") ?? "").toLowerCase();
    if (rel === "self" || rel === "edit" || rel === "hub" || rel === "enclosure") {
      continue;
    }
    let score = 0;
    if (rel === "alternate") score += 10;
    if (type.includes("html")) score += 5;
    if (!type) score += 1;
    candidates.push({ href: decodeXmlText(href), score });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].href;
}

function parseAtom(xml: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const c = m[1];
    const title = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const url = pickAtomLink(c);
    const summary =
      c.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? c.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1];
    const published =
      c.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1] ?? c.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1];
    if (title && url && /^https?:/i.test(url)) {
      items.push({
        title: decodeXmlText(title),
        url,
        summary: summary ? decodeXmlText(summary) : undefined,
        published: published ? decodeXmlText(published) : undefined,
      });
    }
  }
  return items;
}

export async function fetchRssFeed(url: string, source: string, limit = 20): Promise<FeedItem[]> {
  const res = await fetchWithRetry(url);
  const xml = await res.text();

  // Try RSS 2.0 / RDF first (most common). If we got nothing, fall back
  // to Atom — many indie blogs, Substack, GitHub `releases.atom`,
  // Mastodon, Blogger, etc. ship Atom only.
  let parsed = parseRss(xml);
  if (parsed.length === 0) {
    parsed = parseAtom(xml);
  }

  return parsed.slice(0, limit).map((p) => ({ ...p, source }));
}

export async function fetchArxivPapers(categories: string[], limit = 20): Promise<FeedItem[]> {
  const catQuery = categories.map((c) => `cat:${c}`).join("+OR+");
  const url = `http://export.arxiv.org/api/query?search_query=${catQuery}&sortBy=submittedDate&max_results=${limit}`;

  const res = await fetchWithRetry(url);
  const xml = await res.text();

  const items: FeedItem[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const content = match[1];
    const title = content.match(/<title>([\s\S]*?)<\/title>/);
    const id = content.match(/<id>([\s\S]*?)<\/id>/);
    const summary = content.match(/<summary>([\s\S]*?)<\/summary>/);
    if (title && id) {
      items.push({
        title: title[1].replace(/\s+/g, " ").trim(),
        url: id[1].trim(),
        summary: summary?.[1].replace(/\s+/g, " ").trim(),
        source: "arxiv",
      });
    }
  }
  return items.slice(0, limit);
}
