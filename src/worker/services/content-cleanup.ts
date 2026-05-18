import type { ContentBlock } from "../types.js";

/**
 * Strip Anthropic-style inline citation markup from rendered prose.
 *
 * When the writer model has the hosted `web_search` tool available
 * and successfully invokes it, it has a strong habit of wrapping
 * cited spans in XML-ish `<cite index="1-1">...</cite>` tags inside
 * the JSON `text` blocks — despite the prompt telling it not to.
 * Those tags leak into the persisted content and render literally
 * for the reader (we've seen "<cite index=\"1-12,1-13\">..." in the
 * wild in the briefing UI).
 *
 * The model's actual web-search citations come back on the normalized
 * response's `webSearchResults` field; the generators turn those into
 * `web`-type rows on `piece.resources`. The inline tags carry no
 * additional information for the reader — they're noise to strip.
 *
 * Defensive: prompt-side rules can fail; this runs unconditionally on
 * every text/heading block before persistence. Applies to `text` and
 * `heading` content blocks only — `code` and `diagram` are literal
 * source material the writer should never have touched.
 */
const CITE_TAG_RE = /<cite\b[^>]*>([\s\S]*?)<\/cite>/gi;
const ORPHAN_CITE_OPEN_RE = /<cite\b[^>]*>/gi;
const ORPHAN_CITE_CLOSE_RE = /<\/cite>/gi;

export function stripCiteTagsFromText(value: string): string {
  return value.replace(CITE_TAG_RE, "$1").replace(ORPHAN_CITE_OPEN_RE, "").replace(ORPHAN_CITE_CLOSE_RE, "");
}

export function stripCiteTags(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((b) => {
    if (b.type !== "text" && b.type !== "heading") return b;
    const stripped = stripCiteTagsFromText(b.value);
    return stripped === b.value ? b : { ...b, value: stripped };
  });
}
