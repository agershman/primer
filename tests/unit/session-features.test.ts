/**
 * Tests for features added in the latest session: bookmarks, TTS selection,
 * dictation, font size, archive dedup, baseline quiz UX,
 * and learning trails load-all.
 */
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("bookmarks system", () => {
  it("consolidated schema has bookmarks table with scroll and audio position", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("scroll_position REAL");
    expect(sql).toContain("audio_position REAL");
    expect(sql).toContain("bookmark_type");
    expect(sql).toContain("UNIQUE(user_id, piece_id)");
  });

  it("bookmark routes use PUT for upsert, not POST", async () => {
    const src = await read("src/worker/routes/bookmarks.ts");
    expect(src).toContain('.put("/bookmark/:pieceId"');
    expect(src).toContain('.delete("/bookmark/:pieceId"');
    expect(src).toContain('.get("/bookmarks"');
    expect(src).toContain('.get("/bookmark/:pieceId"');
  });

  it("useBookmarks hook uses apiPut, not apiPost", async () => {
    const src = await read("src/frontend/hooks/useBookmarks.ts");
    expect(src).toContain("apiPut");
    expect(src).not.toMatch(/apiPost\(`\/api\/bookmark/);
  });

  it("RichText supports paragraph-level bookmarking", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toContain("onBookmarkBlock");
    expect(src).toContain("bookmarkedBlock");
    expect(src).toContain("Bookmark here");
  });

  it("BookmarksPage links to briefing date, not deep dive", async () => {
    const src = await read("src/frontend/pages/BookmarksPage.tsx");
    expect(src).toMatch(/to=\{`\/briefing\/\$\{bookmark\.briefingDate\}`\}/);
    expect(src).not.toContain("bookmark.pieceId}`}");
  });

  it("DeepDiveView loads existing bookmark on mount", async () => {
    const src = await read("src/frontend/pages/DeepDiveView.tsx");
    expect(src).toContain("getBookmark(piece.id)");
    expect(src).toContain("setBookmarkedBlock");
  });

  it("bookmarks icon in header nav (not text label)", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The desktop bookmark trigger is a button (not a Link) so it can
    // act as a toggle — see bookmark-toggle.test.ts. The mobile menu
    // still uses a Link to "/bookmarks" since the mobile flow is a
    // straight nav list. Either path keeps "/bookmarks" in the source.
    expect(src).toContain('"/bookmarks"');
    expect(src).toMatch(/aria-label=\{onBookmarks \?[^}]*"Bookmarks"[^}]*\}/);
    const navItems = src.match(/const NAV_ITEMS[\s\S]*?\];/);
    expect(navItems?.[0]).not.toContain("Bookmarks");
  });
});

describe("TTS model selection", () => {
  it("TTS_MODELS includes Cloudflare Aura speakers, MeloTTS, and OpenAI providers", async () => {
    const src = await read("src/worker/config/constants.ts");
    expect(src).toContain("TTS_MODELS");
    expect(src).toContain("aura-asteria");
    expect(src).toContain("aura-orion");
    expect(src).toContain("melotts");
    expect(src).toContain("openai-tts-1-alloy");
    expect(src).toContain("openai-tts-1-hd-nova");
    expect(src).toContain('DEFAULT_TTS_MODEL = "aura-asteria"');
    expect(src).toContain('provider: "openai"');
    expect(src).toContain('provider: "cloudflare"');
  });

  it("audio routes dispatch based on TTS model provider via the adapter layer", async () => {
    const routesSrc = await readSrc("src/worker/routes/pieces.ts");
    // Routes still call into the shared service entry point; provider
    // dispatch lives behind it.
    expect(routesSrc).toContain("resolveTtsModel");
    expect(routesSrc).toContain("generateTtsResponse");
    // Tolerate either depth — pre-split (`../services/tts.js`) or
    // post-split sub-file (`../../services/tts.js`).
    expect(routesSrc).toMatch(/from "(\.\.\/)+services\/tts\.js"/);

    // The actual provider dispatch is now in a TtsAdapter registry —
    // one adapter per provider, shared parallel-streaming pipeline.
    const ttsSrc = await read("src/worker/services/tts.ts");
    expect(ttsSrc).toContain("ttsAdapterFor");
    expect(ttsSrc).toContain("chunkText");

    const dispatcher = await read("src/worker/integrations/tts/dispatcher.ts");
    expect(dispatcher).toContain("CloudflareTtsAdapter");
    expect(dispatcher).toContain("OpenAITtsAdapter");
    expect(dispatcher).toContain("ElevenLabsTtsAdapter");
  });

  it("chunks text at 1900 chars for Deepgram Aura", async () => {
    const src = await read("src/worker/integrations/tts/cloudflare-adapter.ts");
    expect(src).toMatch(/chunkText\(text,\s*1900\)/);
  });

  it("OpenAI TTS uses Bearer auth and 4000-char chunks", async () => {
    const src = await read("src/worker/integrations/tts/openai-adapter.ts");
    expect(src).toContain("api.openai.com/v1/audio/speech");
    // The fetch helper takes `apiKey` as a parameter; the env-var read happens
    // in the OpenAITtsAdapter.generate method and is passed in.
    expect(src).toMatch(/Bearer \$\{(env\.OPENAI_API_KEY|apiKey)\}/);
    expect(src).toMatch(/chunkText\(text,\s*4000\)/);
  });

  it("OpenAI TTS streams chunks in parallel (no buffering before response)", async () => {
    const src = await read("src/worker/integrations/tts/openai-adapter.ts");
    // streamingTtsResponse drains parallel-fired upstream streams in order
    expect(src).toContain("streamingTtsResponse");
    expect(src).toContain("streamPromises");
    // Caller fires all chunks via .map (parallel), not awaited in a loop
    expect(src).toMatch(/chunks\.map\([^)]*\)\s*:\s*Promise<ReadableStream/);
  });

  it("Aura TTS also streams chunks in parallel (no full buffering)", async () => {
    const src = await read("src/worker/integrations/tts/cloudflare-adapter.ts");
    // generateAura uses the same streaming helper
    expect(src).toMatch(/generateAura[\s\S]{0,1500}streamingTtsResponse/);
    // It maps chunks in parallel, not a sequential await-in-loop
    expect(src).toMatch(/generateAura[\s\S]{0,1500}chunks\.map/);
  });

  it("ElevenLabs adapter uses xi-api-key auth, NOT Bearer", async () => {
    const src = await read("src/worker/integrations/tts/elevenlabs-adapter.ts");
    expect(src).toContain("xi-api-key");
    // ElevenLabs auth is the API key directly in the xi-api-key header,
    // not a Bearer token in Authorization.
    expect(src).not.toMatch(/Authorization.*Bearer/);
    expect(src).toContain("api.elevenlabs.io");
  });
});

describe("Slack mrkdwn normalization", () => {
  it("worker normalizeSlackText strips angle-bracketed URLs and mentions", async () => {
    const { normalizeSlackText } = await import("../../src/worker/integrations/slack.ts");
    // Bare URL
    expect(normalizeSlackText("see <https://example.com>")).toBe("see https://example.com");
    // URL with display text
    expect(normalizeSlackText("read <https://example.com|the docs>")).toBe("read the docs");
    // Mailto
    expect(normalizeSlackText("email <mailto:foo@bar.com>")).toBe("email mailto:foo@bar.com");
    // Channel mention with name
    expect(normalizeSlackText("in <#C123|eng-platform>")).toBe("in #eng-platform");
    // Channel mention without name
    expect(normalizeSlackText("ping <#C123>")).toBe("ping #channel");
    // User mention with name
    expect(normalizeSlackText("hey <@U456|alice>")).toBe("hey @alice");
    // User mention without name
    expect(normalizeSlackText("hey <@U456>")).toBe("hey @user");
    // Subteam
    expect(normalizeSlackText("cc <!subteam^S789|platform>")).toBe("cc @platform");
    // Special mentions
    expect(normalizeSlackText("<!channel> heads up")).toBe("@channel heads up");
    expect(normalizeSlackText("<!here> please")).toBe("@here please");
    // HTML entities
    expect(normalizeSlackText("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d");
    // The exact bug case from the screenshot (truncated URL still cleans)
    expect(normalizeSlackText("ooh fun one. <https://co.slack.com/archives/C/p123>")).toBe("ooh fun one. https://co.slack.com/archives/C/p123");
  });

  it("normalizeSlackText is a no-op on already-clean text", async () => {
    const { normalizeSlackText } = await import("../../src/worker/integrations/slack.ts");
    expect(normalizeSlackText("plain text with no markup")).toBe("plain text with no markup");
    expect(normalizeSlackText("https://example.com unwrapped url stays")).toBe("https://example.com unwrapped url stays");
  });

  it("slack source applies normalizeSlackText at the boundary in groupAndFilterSlackMessages", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toMatch(
      /import \{[^}]*SlackClient[^}]*\} from "..\/integrations\/slack\.js"/,
    );
    expect(src).toMatch(
      /import \{[^}]*normalizeSlackText[^}]*\} from "..\/integrations\/slack\.js"/,
    );
    expect(src).toMatch(/rawMessages\.map\([\s\S]{0,200}normalizeSlackText/);
  });

  it("slack source also normalizes thread reply text", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toMatch(/getThreadReplies[\s\S]{0,500}normalizeSlackText\(r\.text\)/);
  });

  it("frontend utils/text.ts mirrors the worker normalizer", async () => {
    const src = await read("src/frontend/utils/text.ts");
    expect(src).toContain("export function normalizeSlackText");
    expect(src).toContain("export function cleanSlackText");
    // Pattern coverage parity with worker
    expect(src).toContain("https?:\\/\\/");
    expect(src).toContain("&amp;");
  });

  it("SourceItem in TeachingPiece cleans Slack text from source.title and source.summary", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain('import { cleanSlackText } from "../utils/text"');
    expect(src).toContain("cleanSlackText(source.title)");
    expect(src).toContain("cleanSlackText(source.summary)");
  });

  it("WorkContextBar applies normalizeSlackText alongside emoji shortcodes", async () => {
    const src = await read("src/frontend/components/WorkContextBar.tsx");
    expect(src).toContain('import { normalizeSlackText } from "../utils/text"');
    expect(src).toMatch(/cleanText[\s\S]{0,200}normalizeSlackText/);
  });
});

describe("Slack permalink construction (links from Triggered by)", () => {
  it("buildSlackPermalink constructs the standard permalink format", async () => {
    const { buildSlackPermalink } = await import("../../src/worker/integrations/slack.ts");
    expect(buildSlackPermalink("workspace", "C04BEPTB1D1", "1777011336.200000"))
      .toBe("https://workspace.slack.com/archives/C04BEPTB1D1/p1777011336200000");
    // Multiple dots in ts (rare but possible)
    expect(buildSlackPermalink("ws", "C123", "1777.011.336"))
      .toBe("https://ws.slack.com/archives/C123/p1777011336");
  });

  it("buildSlackPermalink returns undefined when any input is missing", async () => {
    const { buildSlackPermalink } = await import("../../src/worker/integrations/slack.ts");
    expect(buildSlackPermalink(null, "C123", "1234.567")).toBeUndefined();
    expect(buildSlackPermalink("ws", null, "1234.567")).toBeUndefined();
    expect(buildSlackPermalink("ws", "C123", null)).toBeUndefined();
    expect(buildSlackPermalink(undefined, undefined, undefined)).toBeUndefined();
    expect(buildSlackPermalink("", "C123", "1234.567")).toBeUndefined();
  });

  it("SlackClient exposes getTeamInfo for fetching workspace domain", async () => {
    const src = await read("src/worker/integrations/slack.ts");
    expect(src).toContain("async getTeamInfo");
    expect(src).toContain('"team.info"');
    expect(src).toContain("domain: result.team.domain");
  });

  it("slack source constructs permalinks for conversations.history messages", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toMatch(
      /import \{[^}]*\bSlackClient\b[^}]*\} from "..\/integrations\/slack\.js"/,
    );
    expect(src).toMatch(
      /import \{[^}]*\bnormalizeSlackText\b[^}]*\} from "..\/integrations\/slack\.js"/,
    );
    expect(src).toMatch(
      /import \{[^}]*\bbuildSlackPermalink\b[^}]*\} from "..\/integrations\/slack\.js"/,
    );
    expect(src).toContain("client.getTeamInfo()");
    expect(src).toMatch(/permalink:\s*m\.permalink\s*\?\?\s*buildSlackPermalink/);
  });

  it("slack source gracefully handles missing team info — logs the scope hint and falls back to chat.getPermalink per kept thread", async () => {
    const src = await read("src/worker/sources/slack.ts");
    // Friendly log message so the operator immediately knows this
    // is fixable by adding the `team:read` scope (or accepted by
    // relying on the per-thread permalink fallback).
    expect(src).toContain("team.info failed");
    expect(src).toContain("team:read");
    expect(src).toContain("let teamDomain");
    // Per-thread permalink fallback: if buildSlackPermalink came up
    // empty (no domain), the route fills in URL via
    // `slackClient.getPermalink(channelId, thread.id)`. This is
    // what kept the briefing's SOURCES rail clickable when the
    // workspace token lost its `team:read` scope in production.
    expect(src).toMatch(/if \(!base\.url\)\s*\{[\s\S]{0,200}slackClient\.getPermalink/);
    // Channel id is threaded all the way through SlackThread →
    // EnrichedThread so the fallback can call chat.getPermalink
    // even on the path where the URL never got built.
    expect(src).toMatch(/SlackThread[\s\S]{0,400}channel\?: string/);
  });

  it("SlackClient exposes a getPermalink helper backed by chat.getPermalink", async () => {
    const src = await read("src/worker/integrations/slack.ts");
    // The fallback in slackProvider depends on this method
    // existing on SlackClient. Pin the signature + the underlying
    // API method so a future refactor doesn't accidentally drop
    // the fallback path.
    expect(src).toMatch(/async getPermalink\(channel: string, messageTs: string\)/);
    expect(src).toContain('"chat.getPermalink"');
  });

});

describe("Diagram expand modal", () => {
  it("DiagramBlock includes an expand button visible on hover", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toContain('aria-label="Expand diagram"');
    expect(src).toContain("setExpanded(true)");
    // Visible on hover (group-hover) and on touch devices (no-hover media query)
    expect(src).toContain("group-hover:opacity-100");
    expect(src).toContain("[@media(hover:none)]:opacity-100");
  });

  it("DiagramModal portals to body and dismisses on Esc + backdrop click", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toContain("function DiagramModal");
    expect(src).toContain("createPortal");
    expect(src).toContain("document.body");
    // Esc handler in capture phase so it beats other Esc handlers
    expect(src).toMatch(/window\.addEventListener\("keydown"[\s\S]{0,200}true/);
    expect(src).toContain('e.key === "Escape"');
    // Backdrop click dismisses; inner click doesn't propagate
    expect(src).toMatch(/onClick=\{onClose\}[\s\S]{0,500}onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });

  it("DiagramModal locks background scroll while open", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toContain('document.body.style.overflow = "hidden"');
    // Restored on unmount
    expect(src).toContain("document.body.style.overflow = prevOverflow");
  });

  it("DiagramModal scales SVG to fit viewport (max 90vw / 85-90vh)", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toContain("max-w-[90vw]");
    expect(src).toMatch(/max-h-\[(85|90)vh\]/);
    // SVG inside scales to fit
    expect(src).toContain("[&_svg]:max-w-full");
    expect(src).toContain("[&_svg]:max-h-full");
  });
});

describe("Briefing feed (root view: reverse-chrono log of dated sections)", () => {
  it("BriefingFeed component exists and includes today in the feed", async () => {
    // The feed treats every date the same — today is just the
    // newest section, not a special hero. No `excludeDate` filtering
    // any more; "Generate now" lives above the feed instead of as a
    // refresh button on a today-hero block.
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).toContain("export function BriefingFeed");
    expect(src).not.toContain("excludeDate");
  });

  it("BriefingFeed uses infinite scroll for paginated date list", async () => {
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).toContain("useInfiniteScroll");
    expect(src).toContain("/api/briefings?");
    expect(src).toMatch(/PAGE_SIZE\s*=\s*\d+/);
  });

  it("BriefingSection lazy-loads each day's content via IntersectionObserver", async () => {
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).toContain("function BriefingSection");
    expect(src).toContain("IntersectionObserver");
    expect(src).toContain('rootMargin: "400px 0px"');
    expect(src).toContain("/api/briefing/${item.briefing_date}");
  });

  it("BriefingSection has a sticky date header with relative time label", async () => {
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).toContain("function DateHeader");
    expect(src).toContain("sticky top-0");
    expect(src).toContain('"today"');
    expect(src).toContain('"yesterday"');
    expect(src).toContain("days ago");
  });

  it("BriefingSection wires through feedback + regeneration handlers", async () => {
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    // onFeedback handler is passed down from the feed; POST happens
    // in the feed-level handler that owns the depth-delta toast.
    expect(src).toContain("/api/piece/${pieceId}/feedback");
    expect(src).toContain("onFeedback={onFeedback}");
    expect(src).toContain("onRegenerated=");
  });

  it("BriefingPage mounts the feed only on the root view, not on past dates or deep dives", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).toContain('import { BriefingFeed }');
    // Root branch: no date param AND no deepDive id → render the feed.
    expect(src).toMatch(/!date\s*&&\s*!deepDiveId[\s\S]{0,100}<BriefingFeed/);
  });

  it("BriefingFeed surfaces a top-level 'Generate now' action above the feed", async () => {
    // "Generate now" replaced the per-briefing "Refresh" icon. The
    // action is date-agnostic — clicks just kick off an on-demand
    // run of what the daily cron does, appending any new pieces to
    // the log. An empty run yields a toast + bell notification
    // instead of replacing the feed with a "no content today" state.
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).toContain("Generate now");
    expect(src).toContain("FeedActionBar");
    // Uses the generation hook (not useBriefing) — generation acts
    // on today regardless of which date(s) the feed is showing.
    expect(src).toContain("useGeneration");
  });

  it("BriefingFeed hides zero-piece briefings from the visible feed", async () => {
    // An empty run still stamps a row server-side (with
    // noContentReason), but the user-facing feed is about *content*.
    // Surfacing a "0 pieces" section would duplicate the toast that
    // already fires on completion.
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).toMatch(/pieceCount[\s\S]{0,40}>\s*0/);
  });
});

describe("rules-of-hooks compliance (no hooks after early returns)", () => {
  it("BaselineQuiz declares all hooks before any conditional return", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // Find the position of the first conditional return inside the function.
    const firstConditionalReturn = src.search(/^\s*if \([^)]+\) \{[\s\S]{0,200}return \(/m);
    expect(firstConditionalReturn).toBeGreaterThan(0);
    // Find the position of the LAST hook call (useState/useEffect/useRef/useCallback/useMemo).
    const hookCallRegex = /\b(useState|useEffect|useRef|useCallback|useMemo|useReducer|useContext|useLayoutEffect)\(/g;
    let lastHookPosition = 0;
    let match: RegExpExecArray | null;
    while ((match = hookCallRegex.exec(src)) !== null) {
      lastHookPosition = match.index;
    }
    // All hooks must be declared BEFORE the first conditional return.
    expect(lastHookPosition).toBeLessThan(firstConditionalReturn);
  });

  it("DictationButton declares all hooks before any conditional return", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    // Match the early `return null` for unsupported browsers.
    const firstConditionalReturn = src.search(/^\s*if \(!SpeechRecognitionImpl\) return null/m);
    expect(firstConditionalReturn).toBeGreaterThan(0);
    const hookCallRegex = /\b(useState|useEffect|useRef|useCallback|useMemo)\(/g;
    let lastHookPosition = 0;
    let match: RegExpExecArray | null;
    while ((match = hookCallRegex.exec(src)) !== null) {
      lastHookPosition = match.index;
    }
    expect(lastHookPosition).toBeLessThan(firstConditionalReturn);
  });

  it("DictationButton stops the mic on Escape without dismissing the surrounding panel", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    // Escape handler is gated on the `listening` flag — no listener
    // is attached when dictation is off, so it never interferes with
    // other Escape handlers in the app.
    expect(src).toMatch(/if \(!listening\) return;/);
    // Escape: stop the mic
    expect(src).toMatch(/e\.key !== "Escape"/);
    expect(src).toMatch(/stopRecognition\(\)/);
    // Capture phase + stopImmediatePropagation so we beat (and halt)
    // ancestor / sibling Escape listeners — that's how a single
    // Escape stops the mic without also closing the chat panel /
    // settings modal the user was dictating into.
    expect(src).toMatch(/addEventListener\("keydown"[\s\S]{0,80}true\)/);
    expect(src).toMatch(/removeEventListener\("keydown"[\s\S]{0,80}true\)/);
    expect(src).toContain("stopImmediatePropagation");
    // Don't swallow Escape during IME composition (would prevent the
    // user dismissing a candidate window).
    expect(src).toMatch(/isComposing/);
    // The button's a11y / tooltip surface mentions Esc so it's
    // discoverable, not just a hidden shortcut.
    expect(src).toMatch(/Esc/i);
  });
});

describe("TTS models endpoint and Settings UI", () => {
  it("models route exposes /tts-models with provider grouping", async () => {
    const src = await read("src/worker/routes/models.ts");
    expect(src).toContain("/tts-models");
    expect(src).toContain("OPENAI_API_KEY");
    expect(src).toContain("TTS_MODELS");
  });

  it("Settings panel has dynamic TTS voice selector grouped by provider", async () => {
    // Voice settings now live in their own panel under settings/.
    const panel = await read("src/frontend/components/settings/panels/VoicePanel.tsx");
    expect(panel).toContain("optgroup");
    expect(panel).toContain("Cloudflare Workers AI");
    expect(panel).toContain("OpenAI");
    // The shell loads /api/tts-models once and threads it down via context;
    // the panel itself reads from the context.
    const shell = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(shell).toContain("/api/tts-models");
    expect(shell).toContain("ttsModels");
  });

  it("OPENAI_API_KEY is wired into Env type", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toContain("OPENAI_API_KEY");
  });
});

// The "per-article voice switcher" describe block (~470 lines)
// was extracted to `session-features-voice.test.ts` to keep this
// file under control. Other large blocks remain inline; further
// splits are tracked in dev-docs/cleanup-roadmap.md (item 10).


// The "concept extraction overhaul", "buildSystemPrompt", "about
// statement", "About wired", and "About + Refine UI" describe
// blocks (~590 lines) were extracted to
// `session-features-personalization.test.ts`.


describe("concept sparklines (real depth history, not placeholder)", () => {
  it("/api/concepts returns depthHistory[] per concept via one bulk join", async () => {
    const src = await read("src/worker/routes/concepts.ts");
    // Single bulk query for history rows across all loaded concepts —
    // not N+1 per-concept queries.
    expect(src).toMatch(/SELECT concept_id, depth_score, recorded_at[\s\S]+FROM concept_depth_history[\s\S]+IN \(\$\{placeholders\}\)/);
    // Grouped + capped at 24 most-recent points per concept so payload
    // stays bounded for active concepts that have been quizzed many times.
    expect(src).toContain("historyByConcept");
    expect(src).toMatch(/arr\.length > 24/);
    expect(src).toMatch(/arr\.slice\(-24\)/);
    // Field is named `depthHistory` on the response so the frontend
    // type stays self-documenting.
    expect(src).toContain("depthHistory: history");
  });

  it("ConceptList renders the real depthHistory and removed placeholder generator", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    // The fake placeholder generator is gone — its presence misled the
    // user into thinking the rising sparkline meant something.
    expect(src).not.toContain("generatePlaceholderData");
    // The Sparkline reads from `concept.depthHistory` directly.
    expect(src).toContain("concept.depthHistory");
    // Empty-state honesty: a `SparklinePlaceholder` (faint dashed
    // line in the same 80×20 box the real chart occupies) is rendered
    // when there are < 2 points to plot, with a tooltip explaining
    // what to do about it. Bare em-dashes were ambiguous next to
    // adjacent em-dashes (e.g. the never-exposed "—" in the same row),
    // so we replaced them with shapes that read as their own column.
    expect(src).toContain("SparklinePlaceholder");
    expect(src).toMatch(/Not enough history yet/);
    // The placeholder is rendered when history is missing — verify
    // the rendering site uses the new component, not a bare em-dash.
    expect(src).toMatch(/<SparklinePlaceholder \/>/);
  });

  it("ConceptList replaces the never-exposed em-dash with the word 'never' + tooltip", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    // Bare em-dash for "lastExposed is null" was ambiguous when
    // sitting next to other em-dashes. Now the column shows the word
    // `never` (italicized + dim so it visually recedes vs. real
    // values like "today" / "3d ago"), with a tooltip explaining
    // what "never" means in this context.
    expect(src).toMatch(/<span className="italic">never<\/span>/);
    expect(src).toMatch(/Not yet seen in a briefing piece/);
    // Real values keep their tooltip too so hovering any cell in this
    // column gives consistent context, not just the empty state.
    expect(src).toMatch(/Last seen in a briefing \$\{formatRelative/);
  });

  it("Concept type carries depthHistory so list + detail share one shape", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toContain("depthHistory?: number[]");
  });

  it("sparklines help doc reflects the real bulk-history wiring + empty state", async () => {
    const src = await read("src/frontend/help/concepts/sparklines.md");
    // Both surfaces are documented (list + detail).
    expect(src).toMatch(/concepts list view/i);
    expect(src).toMatch(/detail panel/i);
    // The 24-point cap on the list view is called out so users know
    // why the list might truncate vs. the full detail view.
    expect(src).toMatch(/24/);
    // The "not enough history yet" empty state is documented so users
    // know what the dashed-line placeholder means.
    expect(src).toMatch(/Not enough history yet/);
    // And the corresponding lastExposed empty state ("never" word +
    // tooltip) is documented too — both columns share the same
    // disambiguation principle.
    expect(src).toMatch(/never/i);
  });
});

describe("first-run onboarding + in-flow focus editing", () => {
  it("FirstRunSetup walks the user through About then Focus then Sources with skip option", async () => {
    const src = await read("src/frontend/components/FirstRunSetup.tsx");
    // Four-step flow: intro → about → focus → sources (then internal "done").
    // The sources step lets the user opt in to which sources fan into
    // their briefing — AI suggestions visually highlight the recommended
    // ones, but every checkbox starts unchecked and the user picks.
    expect(src).toMatch(/type Step\s*=\s*"intro"\s*\|\s*"about"\s*\|\s*"focus"\s*\|\s*"sources"\s*\|\s*"done"/);
    // Hits the existing endpoints — no new write surface.
    expect(src).toContain('apiPost("/api/me/about"');
    expect(src).toContain('apiPost("/api/me/focus"');
    // Both saves tag the version with a note so the history modal in
    // Settings can distinguish onboarding vs. later edits.
    expect(src).toContain("Set during first-run onboarding");
    // ✨ Refine with AI is reachable for both fields without saving first.
    expect(src).toContain('setRefineKind("about")');
    expect(src).toContain('setRefineKind("focus")');
    // Skip button is present and dismisses without saving.
    expect(src).toContain("Skip for now");
    expect(src).toContain("onSkip");
    // Minimum-length gates so the user can't accidentally save a one-word draft.
    expect(src).toMatch(/aboutValid\s*=\s*aboutDraft\.trim\(\)\.length\s*>=\s*30/);
    expect(src).toMatch(/focusValid\s*=\s*focusDraft\.trim\(\)\.length\s*>=\s*20/);
  });

  it("App mounts FirstRunSetup when user is missing About OR Focus, and skips persist for the session", async () => {
    const src = await read("src/frontend/App.tsx");
    // The check is OR (either field empty triggers onboarding) — the
    // value of having both means we shouldn't let one slide.
    expect(src).toContain("!user.aboutStatement?.trim()");
    expect(src).toContain("!user.focusStatement?.trim()");
    expect(src).toMatch(/!user\.aboutStatement\?\.trim\(\) \|\| !user\.focusStatement\?\.trim\(\)/);
    // Skip is session-scoped — sessionStorage so a refresh re-prompts
    // until the user actually saves both.
    expect(src).toContain("ONBOARDING_SKIP_KEY");
    expect(src).toMatch(/sessionStorage\.(getItem|setItem|removeItem)\(ONBOARDING_SKIP_KEY/);
    // Completion calls back into useCurrentUser.refresh() so the rest
    // of the app picks up the new statements without a full reload.
    expect(src).toContain("refresh()");
    expect(src).toContain("<FirstRunSetup");
  });

  it("FocusEditor lets the user save a new focus version (no free-text 'why' note + AI refine)", async () => {
    const src = await read("src/frontend/components/FocusEditor.tsx");
    expect(src).toMatch(/export function FocusEditor/);
    // Pre-fills with the current focus and creates a *new version*
    // (not a destructive overwrite — the /api/me/focus endpoint is
    // idempotent and version-aware). No "what changed?" free-text
    // input — the version history modal already shows the textual
    // diff between consecutive versions, which is what users
    // actually scan history for.
    expect(src).toContain('apiPost("/api/me/focus"');
    expect(src).toContain("Save as new version");
    expect(src).not.toMatch(/What changed\?/);
    expect(src).not.toMatch(/setNote\(/);
    // ✨ Refine with AI uses the same shared dialog Settings uses.
    expect(src).toContain('import { RefineDialog }');
    // The "today's briefing already ran" disclaimer is surfaced so the
    // user isn't confused why today's content didn't change.
    expect(src).toMatch(/Today's briefing already ran/);
    // Dirty check prevents redundant saves.
    expect(src).toMatch(/draft\.trim\(\)\.length > 0 && draft\.trim\(\) !== \(currentFocus \?\? ""\)\.trim\(\)/);
  });

  it("BriefingPage no longer renders an inline focus pill (focus moved to avatar dropdown)", async () => {
    // The in-flow focus pill was removed in favor of an avatar-menu
    // entry — focus is a profile-level concept, not a per-briefing
    // one, and surfacing it in every briefing header was visual
    // noise. The page no longer reads or renders the user's focus,
    // and the FocusEditor mount lives in the Header instead.
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).not.toContain("FocusEditor");
    expect(src).not.toContain("setFocusEditorOpen");
    expect(src).not.toContain("focusFlashUntil");
    expect(src).not.toContain("user.focusStatement");
  });

  it("BriefingFeed no longer renders a 'focus then' chip per section", async () => {
    // Same shift as the BriefingPage pill — focus is no longer
    // surfaced per-briefing. The backend still tracks
    // `focus_version_id` on every briefing for analytics + history,
    // but the feed is a clean read of the briefing content without
    // an inline historical-focus chip.
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).not.toContain("currentFocusStatement");
    expect(src).not.toContain("showFocusAtTime");
    expect(src).not.toContain("focus then");
    expect(src).not.toContain("useCurrentUser");
  });

  it("/briefing/today and /briefing/:date join focus_statement_versions to surface historical focus", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // The JOIN aliases the column to `focus_statement_at_briefing` so
    // the server can re-emit it under the camelCase API name.
    expect(src).toMatch(
      /LEFT JOIN focus_statement_versions fv ON fv\.id = b\.focus_version_id/,
    );
    expect(src).toContain("focus_statement_at_briefing");
    // Both endpoints must surface the field on the response — the
    // briefing page header pill (today's route) AND the per-section
    // load (BriefingFeed → /briefing/:date) need it.
    expect(src).toContain("focusStatementAtBriefing:");
    // Pre-versioning briefings (focus_version_id NULL) get null on the
    // wire, which the UI uses to hide the historical badge.
    expect(src).toMatch(/\?\? null/);
  });

  it("Header avatar opens a dropdown menu with Set focus + Settings entries (FocusEditor mounts in the Header)", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    // The avatar is no longer a direct shortcut to settings — clicking
    // it now opens a small dropdown menu rendered by `AvatarMenu`.
    // Both `Set focus` and `Settings` are reachable from there.
    expect(src).toMatch(/function AvatarMenu/);
    expect(src).toContain("<AvatarMenu");
    expect(src).toContain('onOpenFocus={() => setFocusEditorOpen(true)}');
    expect(src).toContain('onOpenSettings={() => setSettingsOpen(true)}');
    // Menu items — match across whitespace because the JSX text may
    // wrap with the surrounding span across multiple lines.
    expect(src).toMatch(/>\s*Set focus\s*</);
    expect(src).toMatch(/>\s*Settings\s*</);
    // FocusEditor lives in the Header now (so it's reachable from any
    // route, not just the briefing page).
    expect(src).toContain('import { FocusEditor } from "./FocusEditor"');
    expect(src).toContain("<FocusEditor");
    // Menu state is dismissable via Escape and click-outside, with
    // proper ARIA on the menu container.
    expect(src).toContain('role="menu"');
    expect(src).toContain('role="menuitem"');
    expect(src).toMatch(/aria-haspopup="menu"/);
    expect(src).toMatch(/aria-expanded=/);
    expect(src).toMatch(/e\.key === "Escape"/);
  });

  it("FocusEditor, FirstRunSetup, and SettingsPanel about/focus textareas all support continuous dictation", async () => {
    // Same DictationButton + continuous voice mode pattern that's
    // already on quiz answers and the chat input. Long-form
    // narrative textareas where dictation is most useful — talking
    // out your About/Focus is often easier than typing it.
    // The about/focus surface inside settings now lives in the shared
    // StatementPanel (used by both AboutPanel and FocusPanel), so the
    // dictation contract gets verified there.
    for (const path of [
      "src/frontend/components/FocusEditor.tsx",
      "src/frontend/components/FirstRunSetup.tsx",
      "src/frontend/components/settings/panels/StatementPanel.tsx",
    ]) {
      const src = await read(path);
      expect(src, `${path} should import DictationButton`).toContain(
        "DictationButton",
      );
      // Each surface uses the canonical continuous-mode opt-in: the
      // `continuous` prop, an `onInterim` handler, and an
      // `onListeningChange` handler. Spell each out explicitly here so
      // a future refactor can't quietly drop one.
      expect(src, `${path} should pass continuous prop`).toMatch(
        /continuous\s*\n\s*className=/,
      );
      // The handler is wired with either a generic `setInterim` (single
      // dictating field per surface, e.g. FocusEditor) or a prefixed
      // `setAboutInterim` / `setFocusInterim` (multiple fields per
      // surface, e.g. FirstRunSetup / SettingsPanel). Both patterns
      // satisfy the contract.
      expect(src, `${path} should wire onInterim`).toMatch(
        /onInterim=\{set(About|Focus)?Interim\}/,
      );
      expect(src, `${path} should wire onListeningChange`).toMatch(
        /onListeningChange=\{set(About|Focus)?Dictating\}/,
      );
      // Read-only-while-listening prevents typing from fighting the
      // live transcript (matches quiz-answer + chat-input behavior).
      expect(src, `${path} should set readOnly while dictating`).toMatch(
        /readOnly=\{\w*[Dd]ictating\}/,
      );
      // Live transcript display: textarea value combines committed
      // draft + interim while dictating. Matches both the bare
      // `dictating && interim` (single field) and prefixed
      // `aboutDictating && aboutInterim` (multi-field) variants.
      expect(src, `${path} should display interim transcript inline`).toMatch(
        /\w*[Dd]ictating && \w*[Ii]nterim/,
      );
    }
  });

  it("FirstRunSetup tracks per-step dictation state so toggling between About and Focus doesn't carry stale interim", async () => {
    const src = await read("src/frontend/components/FirstRunSetup.tsx");
    // Independent state per step: aboutInterim/aboutDictating vs.
    // focusInterim/focusDictating. Without this split, switching
    // back from Focus to About would briefly show the previous step's
    // interim text in the wrong textarea.
    expect(src).toContain("aboutInterim");
    expect(src).toContain("aboutDictating");
    expect(src).toContain("focusInterim");
    expect(src).toContain("focusDictating");
  });

  it("BriefingData still carries focusStatementAtBriefing for analytics/history (display removed)", async () => {
    // Even though we no longer surface the historical focus inline,
    // the backend continues to track which focus version drove each
    // briefing — the `focus_version_id` join + `focusStatementAtBriefing`
    // field stay on the response so analytics, the version-history
    // modal in Settings, and any future surface (a "this briefing was
    // written under focus X" hover, etc.) all have the data they need.
    const types = await read("src/frontend/types.ts");
    expect(types).toContain("focusStatementAtBriefing?: string | null");
    expect(types).toContain("focus_version_id?: string | null");

    const route = await readSrc("src/worker/routes/briefing.ts");
    expect(route).toMatch(
      /LEFT JOIN focus_statement_versions fv ON fv\.id = b\.focus_version_id/,
    );
    expect(route).toContain("focusStatementAtBriefing:");
  });
});

describe("audio outros (briefing CTA + deep dive sign-off)", () => {
  it("briefing piece audio appends a 'Go deeper' CTA that adapts to whether the deep dive is already generated", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    // Two outro variants depending on whether the deep dive has been
    // generated already — never promise generation that's done, never
    // hide the option from listeners who haven't expanded it yet.
    expect(src).toContain("BRIEFING_AUDIO_OUTRO_NO_DEEP_DIVE");
    expect(src).toContain("BRIEFING_AUDIO_OUTRO_WITH_DEEP_DIVE");
    expect(src).toMatch(/tap Go deeper at the end of the piece/);
    expect(src).toMatch(/the deep dive is ready/);
    // The audio route reads `has_deep_dive` so it can branch the outro.
    expect(src).toMatch(/SELECT content, title, has_deep_dive FROM teaching_pieces/);
    expect(src).toContain("deepDiveReady");
    expect(src).toMatch(/deepDiveReady\s*\?\s*BRIEFING_AUDIO_OUTRO_WITH_DEEP_DIVE\s*:\s*BRIEFING_AUDIO_OUTRO_NO_DEEP_DIVE/);
  });

  it("deep dive audio appends a thanks-for-listening sign-off so playback doesn't end abruptly", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toContain("DEEP_DIVE_AUDIO_OUTRO");
    expect(src).toMatch(/Thanks for listening/);
    // The deep-dive route must concatenate the outro after the body
    // (with separator) so the chunked TTS gives a natural pause before
    // the closing.
    expect(src).toMatch(/\$\{titlePrefix\}\$\{trimmedBody\}\\n\\n\$\{DEEP_DIVE_AUDIO_OUTRO\}/);
  });

  it("audio outros always play in full — body is sliced to make room for them", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    // Both routes compute a body budget that subtracts the title prefix,
    // outro length, and the inter-paragraph separator chars from the
    // total cap. Without this, a long body would clip the outro.
    expect(src).toMatch(/overheadChars\s*=\s*titlePrefix\.length \+ outro\.length \+ 8/);
    expect(src).toMatch(/overheadChars\s*=\s*titlePrefix\.length \+ DEEP_DIVE_AUDIO_OUTRO\.length \+ 8/);
    // Body budget falls back to a sane minimum so the slice expression
    // never goes negative even with absurdly long titles/outros.
    expect(src).toMatch(/Math\.max\(500, 5000 - overheadChars\)/);
    expect(src).toMatch(/Math\.max\(1000, 10000 - overheadChars\)/);
  });
});

describe("time-aware greeting (removed)", () => {
  // The time-aware "Good morning. / Good afternoon. / Good evening."
  // greeting was removed from the briefing page header — it added
  // visual noise without offering useful info, and the date heading
  // + focus pill already orient the reader.
  it("BriefingPage no longer renders the time-aware greeting", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).not.toContain("timeAwareGreeting");
    expect(src).not.toMatch(/Good morning\./);
    expect(src).not.toMatch(/Good afternoon\./);
    expect(src).not.toMatch(/Good evening\./);
  });
});

describe("AI-generated briefing greeting (removed)", () => {
  // The per-briefing greeting + work-context summary used to be
  // generated by a dedicated chat-tier LLM call at the end of the
  // briefing pipeline (the Step 8 "greeting" stage). It rendered as
  // an italic "Good morning! …" line above each briefing on the
  // briefing page and the archive list. Both the LLM call and the
  // render were removed — the date heading + the piece titles
  // already give each briefing a "what was this about" identity.
  // The DB columns (`greeting`, `work_context_summary`) remain in
  // the schema for legacy rows; new briefings persist them as NULL.

  it("briefing-generator no longer makes a greeting LLM call", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The old generator had a `safeStep("greeting", ...)` block that
    // called `llm.generateJson<{ greeting, workSummary }>`. Both
    // should be gone — including the prompt phrasing, the
    // recordTokenUsage("briefing_greeting"), and the
    // greetingStep.data references that wired it into the UPDATE.
    expect(src).not.toMatch(/safeStep\(\s*"greeting"/);
    expect(src).not.toMatch(/generateJson<\{\s*greeting:/);
    expect(src).not.toContain("briefing_greeting");
    expect(src).not.toMatch(/greetingStep\.data\./);
  });

  it("briefing-generator persists greeting=NULL, work_context_summary=NULL on new briefings", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(
      /UPDATE briefings SET status = \?, greeting = NULL, work_context_summary = NULL/,
    );
  });

  it("/api/briefings list response no longer selects b.greeting", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Only the dedicated `/api/briefings` list query needs to be
    // greeting-free. The single-briefing routes (`/today`, `/:date`)
    // use `SELECT b.*` which still returns the field for legacy
    // rows; the frontend just doesn't render it anymore.
    expect(src).toMatch(
      /SELECT b\.id, b\.briefing_date, b\.status, b\.generated_at, b\.created_at\b/,
    );
  });

  it("BriefingListItem no longer carries greeting", async () => {
    const src = await read("src/frontend/types.ts");
    // Find the BriefingListItem block specifically (BriefingData
    // keeps an optional/legacy field for older rows that come back
    // through the single-briefing fetch).
    const match = src.match(/export interface BriefingListItem \{[\s\S]*?\n\}/);
    expect(match).toBeTruthy();
    expect(match?.[0]).not.toMatch(/^\s*greeting:/m);
  });

  it("ArchivePage no longer renders the greeting line", async () => {
    const src = await read("src/frontend/pages/ArchivePage.tsx");
    expect(src).not.toMatch(/b\.greeting\s*\|\|/);
    expect(src).not.toMatch(/{b\.greeting}/);
  });

  it("BriefingFeed no longer renders the greeting line", async () => {
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    expect(src).not.toMatch(/{item\.greeting}/);
    expect(src).not.toMatch(/item\.greeting && \(/);
  });
});

describe("bookmarks", () => {
  it("Bookmarks page renders a context snippet under each row so users know where the bookmark points", async () => {
    // Backend computes the snippet on the worker — front end just
    // displays it. We pin three behaviors:
    //   1. The route resolves the right block for each bookmark
    //      type (block-level → that block; reading-progress →
    //      proportional block; piece-level → first block).
    //   2. Lightweight markdown is stripped so the snippet reads
    //      as plain prose.
    //   3. The result is a `contextSnippet` field on every bookmark
    //      in the GET /bookmarks response.
    const route = await read("src/worker/routes/bookmarks.ts");
    expect(route).toContain("computeBookmarkSnippet");
    // The route SELECTs `tp.content` so the snippet helper has the
    // raw block array to work with.
    expect(route).toMatch(/tp\.content as piece_content/);
    // Three bookmark-type branches are present.
    expect(route).toMatch(/bookmarkType === "saved" && scrollPosition >= 1/);
    expect(route).toMatch(/bookmarkType === "reading"[\s\S]{0,80}scrollPosition > 0[\s\S]{0,40}scrollPosition < 1/);
    expect(route).toMatch(/textBlocks\[0\]/); // piece-level fallback
    // Markdown stripping — same patterns the audio TTS pipeline uses.
    expect(route).toMatch(/\\\{\\\{.+?\\\|\\\|.+?\\\}\\\}/); // {{label||url}} resource refs
    expect(route).toMatch(/\\\*\\\*.+?\\\*\\\*/);
    // 260-char cap with word-boundary truncation so a snippet doesn't
    // stop mid-word. The cap is tuned to the frontend's 3-line clamp
    // (~240 visible chars) so the ellipsis lands inside the visible
    // box rather than on a hidden line.
    expect(route).toContain("plain.length <= 260");
    expect(route).toContain("lastIndexOf(\" \")");
    // Response surfaces the field.
    expect(route).toMatch(/contextSnippet:\s*computeBookmarkSnippet/);
  });

  it("Bookmark type carries contextSnippet for the BookmarksPage to render", async () => {
    const src = await read("src/frontend/hooks/useBookmarks.ts");
    expect(src).toContain("contextSnippet?: string | null");
  });

  it("BookmarkRow renders the contextSnippet under the title with a 3-line clamp", async () => {
    const src = await read("src/frontend/pages/BookmarksPage.tsx");
    // The snippet is rendered directly under the title row, with
    // a -webkit-line-clamp: 3 to bound the row height even for long
    // passages. The clamp pairs with the 260-char snippet cap on
    // the worker — 3 lines × ~80 chars/line gives a comfortable
    // visible budget without rows growing unboundedly.
    // `bookmark.contextSnippet` gates rendering so legacy bookmarks
    // without a snippet (e.g. piece content pruned by retention)
    // don't render an empty paragraph.
    expect(src).toContain("bookmark.contextSnippet &&");
    expect(src).toContain("{bookmark.contextSnippet}");
    expect(src).toMatch(/WebkitLineClamp:\s*3/);
    // Layout switched from `items-center` to `items-start` so the
    // X button stays top-aligned even when the snippet wraps to
    // multiple lines — otherwise the button would slide down with
    // the longest row in the list.
    expect(src).toMatch(/className="flex items-start gap-3 rounded-lg/);
    // Tooltip surfaces the full untruncated snippet on hover so the
    // user can read it in full without opening the piece.
    expect(src).toMatch(/title=\{bookmark\.contextSnippet\}/);
  });

  it("teaching pieces carry due-date metadata sourced from Linear dueDate", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("due_at TEXT");
    expect(sql).toContain("due_reason TEXT");
    expect(sql).toMatch(/CREATE INDEX[\s\S]*?idx_teaching_pieces_due_at/);

    // Linear client returns dueDate as part of LinearIssueData.
    const linear = await read("src/worker/integrations/linear.ts");
    expect(linear).toMatch(/dueDate:\s*string \| null/);
    // The subscribedIssues GraphQL fallback explicitly selects
    // `dueDate` — without that the field would be undefined on
    // half the codepath.
    expect(linear).toMatch(/dueDate\b/);
    expect(linear).toMatch(/id identifier title description url priority updatedAt dueDate/);

    // WorkContextItem carries dueAt + dueReason; briefing generator
    // populates them from Linear sources and propagates to
    // SourceDescriptor on each teaching target.
    const gen = await read("src/worker/services/briefing-generator.ts");
    expect(gen).toMatch(/dueAt\?:\s*string \| null/);
    expect(gen).toMatch(/dueReason\?:\s*string \| null/);
    // Linear → end-of-day-UTC normalization now lives in the Linear source provider.
    const linearSource = await read("src/worker/sources/linear.ts");
    expect(linearSource).toMatch(/T23:59:59Z/);
    expect(linearSource).toMatch(/Linear ticket \$\{issue\.identifier\} is due \$\{issue\.dueDate\}/);
  });

  it("teaching-piece insert derives due_at = min(source dueAt) and due_reason from that source", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // The insert iterates target.sourceContext, picks the soonest
    // dueAt (so the most-urgent deadline is what the user sees), and
    // copies *that* source's reason — not the first source's, not a
    // generic "due soon" string.
    expect(src).toMatch(/let pieceDueAt:\s*string \| null = null/);
    expect(src).toMatch(/let pieceDueReason:\s*string \| null = null/);
    expect(src).toMatch(/src\.dueAt < pieceDueAt/);
    expect(src).toMatch(/pieceDueReason = src\.dueReason \?\? null/);
    // The INSERT writes due_at + due_reason. Series columns
    // (series_id, part_number) live between due_reason and created_at
    // post-migration 0012, so we assert the due columns appear and
    // that pieceDueAt / pieceDueReason are bound, without pinning the
    // exact comma layout (Biome formatter may split bind args across
    // lines).
    expect(src).toContain("due_at, due_reason");
    expect(src).toMatch(/pieceDueAt,\s*\n?\s*pieceDueReason/);
  });

  it("BriefingPage sorts pieces by due-first, then soonest, then alphanumeric title", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    // The sort is implemented inside the displayPieces useMemo so a
    // single render produces both the patch-merged + the sort-applied
    // list. It must:
    //  (1) Place pieces with a due_at before pieces without.
    //  (2) Among due pieces, sort by ISO string ascending (soonest first).
    //  (3) Tiebreak on the same day with title.localeCompare,
    //      numeric: true so "Migration 2" < "Migration 10".
    //  (4) Among non-due pieces, preserve the original server order
    //      (stable index-based fallback).
    expect(src).toContain("due_at");
    expect(src).toMatch(/if \(aDue \&\& bDue\)/);
    expect(src).toMatch(/aDue < bDue/);
    expect(src).toMatch(/localeCompare\(b\.p\.title.*numeric:\s*true/s);
    expect(src).toMatch(/if \(aDue\) return -1/);
    expect(src).toMatch(/if \(bDue\) return 1/);
    expect(src).toMatch(/return a\.idx - b\.idx/);
  });

  it("TeachingPiece DueBadge renders urgency tiers (overdue/today/soon/this-week/later) with distinct colors", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/function DueBadge/);
    // Each tier has a recognizable copy + color pairing.
    expect(src).toMatch(/Overdue · was due/);
    expect(src).toMatch(/Due today/);
    expect(src).toMatch(/Due tomorrow/);
    expect(src).toMatch(/Due in \$\{daysUntil\} days/);
    // Color tiers cover the four severity levels — overdue/today
    // share the negative-dim style, soon uses warning, this-week
    // uses accent, later uses calm bg-warm.
    expect(src).toContain("text-negative bg-negative-dim");
    expect(src).toContain("text-warning bg-warning-dim");
    expect(src).toContain("text-accent bg-accent-dim");
    expect(src).toContain("text-text-secondary bg-bg-warm");
    // Calendar-day math, not 24-hour windows — so "Due tomorrow"
    // means the next calendar day regardless of the current time.
    expect(src).toMatch(/todayMidnight/);
    expect(src).toMatch(/dueMidnight/);
    // Tooltip surfaces the underlying rationale (e.g. "Linear
    // ticket CIN-1234 is due 2026-04-30").
    expect(src).toMatch(/title=\{dueReason \?\?/);
  });

  it("TeachingPieceData type includes due_at + due_reason", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toContain("due_at?: string | null");
    expect(src).toContain("due_reason?: string | null");
    // SourceDescriptor too — we keep the per-source dueAt around so
    // future surfaces (e.g. "this piece has 3 sources due on…") can
    // be richer than a single aggregate.
    expect(src).toContain("dueAt?: string | null");
    expect(src).toContain("dueReason?: string | null");
  });

  it("GenerationProgress renders ABOVE the feed sections so streaming pieces don't push the panel down the page", async () => {
    // The feed mounts `<GenerationProgress>` directly above its
    // `items.map(...)` date-section render. Mid-generation, new
    // pieces append to today's section *below* the panel, so the
    // user's focal point — the progress panel — stays anchored.
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    const progressIdx = src.indexOf("<GenerationProgress");
    const piecesIdx = src.indexOf("items.map((b) =>");
    expect(progressIdx).toBeGreaterThan(0);
    expect(piecesIdx).toBeGreaterThan(0);
    expect(progressIdx).toBeLessThan(piecesIdx);
  });
});

describe("DictationButton (speech-to-text)", () => {
  it("DictationButton component uses Web Speech API", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    expect(src).toContain("SpeechRecognition");
    expect(src).toContain("webkitSpeechRecognition");
    expect(src).toContain("onTranscript");
  });

  it("DictationButton gracefully degrades when unsupported", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    expect(src).toContain("if (!SpeechRecognitionImpl) return null");
  });

  it("wired into chat input", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    expect(src).toContain("DictationButton");
  });

  it("wired into baseline quiz", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toContain("DictationButton");
  });

  it("wired into inline calibration quiz", async () => {
    const src = await read("src/frontend/components/CalibrationQuiz.tsx");
    expect(src).toContain("DictationButton");
  });

  it("supports continuous + interim mode for stream-of-consciousness answers", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    // The component must accept opt-in props for continuous and interim
    expect(src).toContain("continuous?:");
    expect(src).toContain("onInterim?:");
    expect(src).toContain("onListeningChange?:");
    // The recognizer must wire those props through to the underlying SpeechRecognition
    expect(src).toMatch(/recognition\.continuous\s*=\s*continuous/);
    expect(src).toMatch(/recognition\.interimResults\s*=\s*!!onInterimRef\.current/);
    // And it must walk the result list using resultIndex (continuous-mode safe)
    expect(src).toContain("event.resultIndex");
    expect(src).toContain("result.isFinal");
  });

  it("auto-restarts the recognizer in continuous mode (voice-mode UX)", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    // The user-stopped flag distinguishes browser auto-end (silence
    // detector kicks in) from user-initiated stop. Only the latter should
    // tear down the session.
    expect(src).toContain("userStoppedRef");
    // onend must conditionally restart when continuous && !userStopped.
    expect(src).toMatch(/if \(continuous && !userStoppedRef\.current\)/);
    // Restart goes through a small backoff timer so the browser has a
    // moment to release the mic before we ask for it again — avoids
    // InvalidStateError on Chromium.
    expect(src).toContain("restartTimerRef");
    expect(src).toContain("if (!userStoppedRef.current) startRecognition();");
    // Transient errors (no-speech, aborted, audio-capture) must NOT tear
    // down the session — they're how Chrome signals "user paused".
    expect(src).toContain("TRANSIENT_ERRORS");
    expect(src).toContain('"no-speech"');
    expect(src).toContain('"aborted"');
  });

  it("idle-timeout auto-stops on 5s of no actual speech (not lifecycle events)", async () => {
    const src = await read("src/frontend/components/DictationButton.tsx");
    // Default lowered from 30s to 5s — "the user finished their thought"
    // rather than "the user walked away". Configurable via prop so a
    // future caller could opt into a longer window if needed.
    expect(src).toMatch(/idleTimeoutMs\s*=\s*5_000/);
    expect(src).toContain("idleTimerRef");
    expect(src).toContain("bumpIdleTimer");
    // CRITICAL: the watchdog must only reset on `onresult` (real
    // speech). The original implementation also reset on `onstart` /
    // `onaudiostart`, which fire on every silence-driven auto-restart
    // — so the timer never actually fired in continuous mode. The
    // negative assertions here lock in that bug-fix.
    expect(src).toContain("recognition.onresult");
    expect(src).not.toMatch(/recognition\.onstart\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,80}bumpIdleTimer/);
    expect(src).not.toMatch(/recognition\.onaudiostart\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,80}bumpIdleTimer/);
    // The initial timer is armed by `toggle` (user-initiated start),
    // NOT by `startRecognition` (which is called on every restart).
    // Without this split, restarts would re-arm the timer and the
    // bug returns.
    expect(src).toContain("armIdleTimer");
    expect(src).toMatch(/armIdleTimer\(\);\s*\}, \[listening, startRecognition/);
  });

  it("chat input mic uses the same continuous voice mode as the quiz mic", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    // Same prop set as BaselineQuiz / CalibrationQuiz — `continuous`,
    // `onInterim`, `onListeningChange`. So the mic behaves identically
    // wherever the user encounters it.
    expect(src).toMatch(/continuous\s*\n\s*className="h-7 w-7"/);
    expect(src).toContain("onInterim={setInterim}");
    expect(src).toContain("onListeningChange={setDictating}");
    // Live transcript display — textarea shows committed input + interim
    // while dictating, falls back to plain input otherwise.
    expect(src).toMatch(/dictating && interim \?/);
    // While dictating the textarea is read-only (matching quiz UX) and
    // shows a "Listening" hint that mentions both stop affordances:
    // the 5s pause auto-stop and the manual mic-tap.
    expect(src).toContain("readOnly={dictating}");
    expect(src).toMatch(/Listening — pause for 5 s or tap the mic to send/);
    // Sending clears interim too (so a stale partial doesn't survive).
    expect(src).toMatch(/setInterim\(""\);/);
  });

  it("baseline quiz opts into continuous dictation with live preview", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    // continuous prop set
    expect(src).toMatch(/continuous\s*\n/);
    // interim handler tracks live partial transcript
    expect(src).toContain("onInterim={setInterim}");
    // listening state drives readOnly and visible "● Listening" hint
    expect(src).toContain("onListeningChange={setDictating}");
    expect(src).toContain("readOnly={dictating}");
    expect(src).toContain("● Listening");
    // textarea displays answer + interim while dictating
    expect(src).toMatch(/dictating && interim \?/);
  });

  it("daily calibration quiz opts into continuous dictation with live preview", async () => {
    const src = await read("src/frontend/components/CalibrationQuiz.tsx");
    expect(src).toMatch(/continuous\s*\n/);
    expect(src).toContain("onInterim={setInterim}");
    expect(src).toContain("onListeningChange={setDictating}");
    expect(src).toContain("readOnly={dictating}");
    expect(src).toContain("● Listening");
    expect(src).toMatch(/dictating && interim \?/);
  });
});

describe("chat audio playback (TTS for assistant replies)", () => {
  it("shared services/tts.ts module exists with provider dispatch", async () => {
    const src = await read("src/worker/services/tts.ts");
    expect(src).toContain("export async function generateTtsResponse");
    expect(src).toContain("export function resolveTtsModel");
    expect(src).toContain("export function chatMarkdownToSpeech");
  });

  it("chatMarkdownToSpeech strips fenced code blocks and link URLs", async () => {
    const { chatMarkdownToSpeech } = await import(
      "../../src/worker/services/tts.ts"
    );
    // Fenced code blocks become whitespace (TTS would spell each character).
    expect(
      chatMarkdownToSpeech(
        "Try this:\n```ts\nconst x = 1;\n```\nThat works.",
      ),
    ).toBe("Try this:\n\nThat works.");
    // Bold/italic markers are dropped, text is preserved.
    expect(chatMarkdownToSpeech("**bold** and *italic*")).toBe("bold and italic");
    // Inline code keeps the contents.
    expect(chatMarkdownToSpeech("Run `kubectl get pods`")).toBe("Run kubectl get pods");
    // Links keep the visible label, drop the URL.
    expect(chatMarkdownToSpeech("See [docs](https://example.com)")).toBe("See docs");
    // Headings drop the leading hashes.
    expect(chatMarkdownToSpeech("# Hello\n## World")).toBe("Hello\nWorld");
    // List markers go away.
    expect(chatMarkdownToSpeech("- one\n- two\n1. three")).toBe("one\ntwo\nthree");
  });

  it("chat route exposes /chat/messages/:messageId/audio", async () => {
    const src = await read("src/worker/routes/chat.ts");
    expect(src).toContain('"/chat/messages/:messageId/audio"');
    // It must verify the message belongs to the requesting user and that
    // it's an assistant message (we don't echo user input back as TTS).
    expect(src).toContain("WHERE id = ? AND user_id = ?");
    expect(src).toMatch(/role !== "assistant"/);
    // It must use the shared TTS pipeline + markdown stripper.
    expect(src).toContain("chatMarkdownToSpeech");
    expect(src).toContain("generateTtsResponse");
    // It honors ?voice= override like the piece audio route does, and now passes
    // its operation tag so the chat surface can carry its own per-op default.
    expect(src).toContain('c.req.query("voice")');
    expect(src).toMatch(/resolveTtsModel\(user,\s*override,\s*"chat"\)/);
  });

  it("ChatPanel MessageBubble shows a Listen button on assistant replies", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    // The button only appears on finished assistant messages.
    expect(src).toContain("canSpeak");
    expect(src).toMatch(/!isUser && !message\.isStreaming/);
    // Inline AudioPlayer + VoiceSwitcher on demand (cost-conscious — we
    // don't auto-fire TTS for every reply).
    expect(src).toContain("/api/chat/messages/${message.id}/audio");
    expect(src).toContain("AudioPlayer");
    expect(src).toContain("VoiceSwitcher");
    // Voice changes elsewhere on the page propagate via the typed bus.
    expect(src).toContain('onPrimerEvent("tts-voice-changed"');
  });

  it("chat audio reuses the same per-message voice override + cache key pattern as pieces", async () => {
    const chatSrc = await read("src/worker/routes/chat.ts");
    const piecesSrc = await readSrc("src/worker/routes/pieces.ts");
    // Both routes pull the override from the same query param so the
    // Cloudflare cache layer keys both surfaces consistently.
    expect(chatSrc).toContain('c.req.query("voice")');
    expect(piecesSrc).toContain('c.req.query("voice")');
    // Both go through the same resolver in services/tts.ts; each route passes its
    // operation tag so per-op defaults light up correctly.
    expect(chatSrc).toMatch(/resolveTtsModel\(user,\s*override,\s*"chat"\)/);
    expect(piecesSrc).toMatch(/resolveTtsModel\(user,\s*override,\s*"teachingPiece"\)/);
    expect(piecesSrc).toMatch(/resolveTtsModel\(user,\s*override,\s*"deepDive"\)/);
  });
});

describe("help docs reflect this session's features", () => {
  it("baseline calibration help mentions voice-mode dictation specifics", async () => {
    const src = await read("src/frontend/help/calibration/baseline.md");
    expect(src).toContain("voice mode");
    expect(src).toMatch(/auto.?restart/i);
    // Auto-stop on silence — was a 30s watchdog, lowered to 5s as the
    // "user finished their thought" cutoff. Either window's wording
    // can stand here so the assertion survives future tuning, but the
    // help doc must explain that silence ends the session.
    expect(src).toMatch(/(5|30).?second|auto-?stops?/i);
  });

  it("daily quiz help cross-links to baseline for voice mode behavior", async () => {
    const src = await read("src/frontend/help/calibration/quizzes.md");
    expect(src).toContain("voice mode");
    expect(src).toMatch(/calibration\/baseline/);
    // Cross-links must be ROOT-ABSOLUTE (`/help/...`). The help-page
    // markdown renderer doesn't rewrite hrefs, so a relative link like
    // `(calibration/baseline)` from `/help/calibration/quizzes`
    // resolves to `/help/calibration/calibration/baseline` — broken.
    expect(src).toMatch(/\]\(\/help\/calibration\/baseline\)/);
    expect(src).toMatch(/\]\(\/help\/calibration\/assessment\)/);
    // Silence wording: 5 seconds of silence (matches the constant in
    // DictationButton). Earlier copy said "30s of total silence",
    // which contradicted the rest of the product.
    expect(src).toMatch(/5 seconds? of silence/);
  });

  it("chat help documents Listen + voice picker", async () => {
    const src = await read("src/frontend/help/briefings/chat.md");
    expect(src).toMatch(/Listen/);
    expect(src).toMatch(/voice picker|voice: <name>|voice picker/);
    // User messages are explicitly excluded.
    expect(src).toMatch(/User messages don't get/);
  });

  it("configuration doc lists chat as a Listen surface", async () => {
    const src = await read("src/frontend/help/reference/configuration.md");
    expect(src).toContain("Chat replies");
    expect(src).toContain("primer:tts-voice-changed");
  });

  it("api endpoints doc includes /briefings/dates and chat audio", async () => {
    const src = await read("src/frontend/help/reference/api-endpoints.md");
    expect(src).toContain("/api/briefings/dates");
    expect(src).toContain("/api/chat/messages/:messageId/audio");
    expect(src).toContain("/api/chat/threads/:id/messages/stream");
    // Analytics row mentions the new startedAt/finishedAt fields that
    // power the waterfall.
    expect(src).toContain("startedAt");
    expect(src).toContain("finishedAt");
  });

  it("analytics doc describes the waterfall and color separation", async () => {
    const src = await read("src/frontend/help/reference/analytics.md");
    expect(src).toMatch(/trace.?waterfall/i);
    // Mentions parallel iterations / fanout — phrasing changed when
    // the visualization moved from "overlapping bars" to a collapsed
    // fanout summary row + drill-in expansion.
    expect(src).toMatch(/parallel/i);
    expect(src).toMatch(/hue separation/i);
    // Backbone vs iterative distinction is now part of the doc.
    expect(src).toMatch(/Backbone/);
    expect(src).toMatch(/Iterative/);
    // Tooltip dimensions + a11y mention
    expect(src).toContain("started at");
    expect(src).toMatch(/aria-label|screen reader/i);
  });

  it("navigating-history help doc exists and covers both surfaces", async () => {
    const src = await read("src/frontend/help/briefings/navigating-history.md");
    // Frontmatter
    expect(src).toMatch(/^---/);
    expect(src).toContain("title:");
    expect(src).toContain("subtitle:");
    // Both surfaces.
    expect(src).toMatch(/scroll.?timeline scrubber|scrubber/i);
    expect(src).toMatch(/calendar.*week|week.?window/i);
    // Retention is called out — both surfaces honor `RETENTION_DAYS`.
    expect(src).toMatch(/RETENTION_DAYS|365 days/);
    // Cross-references the shared endpoint.
    expect(src).toContain("/api/briefings/dates");
  });

  it("welcome doc mentions chat Listen + history scrubber/calendar", async () => {
    const src = await read("src/frontend/help/getting-started/welcome.md");
    expect(src).toMatch(/chat repl(y|ies).+Listen|Listen.+chat/i);
    expect(src).toMatch(/scroll.?timeline scrubber/i);
    expect(src).toMatch(/calendar/i);
  });

  it("teaching-pieces + how-generation-works docs cover the due-date badge and sort rules", async () => {
    const teaching = await read("src/frontend/help/briefings/teaching-pieces.md");
    expect(teaching).toMatch(/Due-date badge/);
    expect(teaching).toMatch(/text-negative bg-negative-dim|Overdue/);
    expect(teaching).toMatch(/Linear `dueDate`/);
    expect(teaching).toMatch(/sort to the top of the briefing/);

    const generation = await read("src/frontend/help/briefings/how-generation-works.md");
    expect(generation).toMatch(/Due-Date Prioritization/);
    expect(generation).toMatch(/soonest.*one wins/i);
    expect(generation).toMatch(/numeric:\s*true/);
    expect(generation).toMatch(/migration 0011/i);
  });

  it("welcome + first-briefing docs cover the onboarding wizard and the avatar-menu focus entry", async () => {
    const welcome = await read("src/frontend/help/getting-started/welcome.md");
    expect(welcome).toMatch(/First.?run onboarding/i);
    expect(welcome).toMatch(/two-step welcome wizard|two-step welcome/i);
    // Updated to describe the avatar-menu surface (the in-flow focus
    // pill on the briefing page was removed).
    expect(welcome).toMatch(/avatar.*menu|avatar.*Set focus|click your.*avatar/i);

    const firstBriefing = await read(
      "src/frontend/help/getting-started/your-first-briefing.md",
    );
    expect(firstBriefing).toMatch(/First.?run onboarding wizard/i);
    expect(firstBriefing).toMatch(/Updating focus from the avatar menu/);
    // The "today's briefing already ran" disclaimer is documented so
    // the user knows when the change actually takes effect.
    expect(firstBriefing).toMatch(/already generated against your.*previous.*focus/i);
  });

  it("README + dev-docs/usage.md mention waterfall analytics + chat TTS + history navigation", async () => {
    // Same rationale as the README + usage union test above: the
    // README split (Apr 2026) moved per-feature behaviour into
    // `dev-docs/usage.md`. These features must still be discoverable
    // somewhere in the project's first-class docs.
    const readme = await read("README.md");
    const usage = await read("dev-docs/usage.md");
    const combined = `${readme}\n${usage}`;
    expect(combined).toMatch(/trace.?waterfall/i);
    expect(combined).toMatch(/chat repl(y|ies)/i);
    expect(combined).toMatch(/scroll.?timeline scrubber|right edge/i);
    expect(combined).toMatch(/week.?window|calendar popover/i);
  });

  // Documentation drift watchdogs. These keep the help docs from
  // silently rolling back to old terminology after we restructured
  // Settings (single-file panel → sidenav, "Reset concepts" moved
  // from a top-level "Concepts" section to General → Account, Voice
  // moved out from under "AI Models" into its own Intelligence panel,
  // preview moved from a right-column pane to a footer-driven flow
  // with per-source "In scope" subpanels).

  it("no help doc references the deprecated 'Settings → Concepts' path", async () => {
    const docsDir = "src/frontend/help";
    const { readdir } = await import("node:fs/promises");
    const { resolve, join } = await import("node:path");
    const ROOT = resolve(__dirname, "..", "..");
    const dirs = await readdir(resolve(ROOT, docsDir), { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = await readdir(resolve(ROOT, docsDir, d.name));
      for (const f of sub) {
        if (!f.endsWith(".md")) continue;
        const src = await read(join(docsDir, d.name, f));
        // Reset moved: was "Settings → Concepts → Reset concepts",
        // now lives under "Settings → General → Account → Reset concepts".
        expect(src, `${d.name}/${f}: should not reference old "Settings → Concepts" path`).not.toMatch(
          /Settings\s*[→>-]\s*Concepts\s*[→>-]\s*Reset/,
        );
      }
    }
  });

  it("no help doc references the deprecated 'AI Models → Voice' path", async () => {
    // Voice settings now live in their own "Intelligence → Voice"
    // panel after the settings split — they're not nested under
    // AI Models in the nav anymore.
    for (const path of [
      "src/frontend/help/briefings/teaching-pieces.md",
      "src/frontend/help/troubleshooting/common-issues.md",
      "src/frontend/help/reference/configuration.md",
      "README.md",
    ]) {
      const src = await read(path);
      expect(src, `${path} should not reference "AI Models → Voice" nav path`).not.toMatch(
        /AI Models\s*[→>-]\s*Voice/,
      );
    }
  });

  it("README + dev-docs/usage.md document every feature the user can directly interact with from this session", async () => {
    // The README split (Apr 2026) moved per-feature behaviour from the
    // README into `dev-docs/usage.md` to keep the README focused on
    // setup + deployment. This test still pins documentation
    // completeness across the two files combined — the user-facing
    // features below must be discoverable by anyone who opens either
    // doc on GitHub. Update the union if a feature genuinely moves to
    // a third doc.
    const readme = await read("README.md");
    const usage = await read("dev-docs/usage.md");
    const combined = `${readme}\n${usage}`;
    // Notifications + bell.
    expect(combined).toMatch(/notification/i);
    expect(combined).toMatch(/bell/i);
    // Per-user timezone.
    expect(combined).toContain("X-Client-Timezone");
    // Continuation classifier listed in the AI Models table.
    expect(combined).toContain("Continuation classifier");
    // Feeds (source instances) editable + AI suggester.
    expect(combined).toMatch(/Feeds|source instances/i);
    expect(combined).toMatch(/✨ Suggest|Suggest sources/i);
    // Streaming-keepalive briefing generate keeps Cloudflare from
    // 524-ing long runs.
    expect(combined).toMatch(/streaming|keepalive|524/i);
    // Settings nav structure called out so contributors learn the
    // grouping before they start writing copy that drifts.
    expect(combined).toMatch(/Sources \/ Intelligence \/ Personalization \/ General/);
  });

  it("notifications help doc covers lifecycle + polling cadence + reaper", async () => {
    const src = await read("src/frontend/help/reference/notifications.md");
    expect(src).toMatch(/in_progress.*ready/);
    expect(src).toContain("4 seconds");
    expect(src).toContain("30 seconds");
    expect(src).toMatch(/visibilitychange|hidden/);
    expect(src).toMatch(/5\+? min|reap|stuck/i);
  });

  it("source-instances help doc covers Suggest + add by URL", async () => {
    const src = await read("src/frontend/help/briefings/source-instances.md");
    expect(src).toMatch(/Suggest|suggest/);
    expect(src).toMatch(/RSS|feed/i);
  });

  it("continuations-and-series help doc covers classifier + part-N badges + redundant chip", async () => {
    const src = await read("src/frontend/help/briefings/continuations-and-series.md");
    expect(src).toMatch(/NOVEL.*ADDITIVE_CONTINUATION.*REDUNDANT/s);
    expect(src).toMatch(/Part \d+ of \d+|Part-N badge/i);
    expect(src).toMatch(/no new movement/i);
    expect(src).toMatch(/30.?day/);
  });
});

describe("briefing trace waterfall", () => {
  it("analytics endpoint exposes startedAt + finishedAt per step", async () => {
    const src = await read("src/worker/routes/analytics.ts");
    // Without these the frontend can only render stacked durations
    // (no parallelism visible). Required for proper waterfall offsets.
    expect(src).toContain("startedAt: t.started_at");
    expect(src).toContain("finishedAt: t.finished_at");
  });

  it("BriefingTiming type carries startedAt + finishedAt to the UI", async () => {
    const src = await read("src/frontend/hooks/useAnalytics.ts");
    expect(src).toMatch(/startedAt:\s*string/);
    expect(src).toMatch(/finishedAt:\s*string/);
  });

  it("BriefingWaterfall renders rows with offset+width bars derived from absolute timestamps", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    // Must derive t0 from the earliest start and a span out to the
    // latest end — otherwise we're back to a stacked bar.
    expect(src).toMatch(/Math\.min\(\.\.\.rows\.map\(\(r\) => r\.startMs\)\)/);
    expect(src).toMatch(/Math\.max\(\.\.\.rows\.map\(\(r\) => r\.endMs\)\)/);
    // Bar offset = (startedAt - t0) / span
    expect(src).toContain("offsetPct");
    expect(src).toContain("widthPct");
    // Each row shows the step label inline (no shared legend).
    expect(src).toContain("DEFAULT_STEP_LABELS");
  });

  it("waterfall uses a high-contrast color palette (not similar tones)", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    expect(src).toContain("STEP_COLORS");
    // Palette must include hex values from distinct hue families — these
    // are the canonical Tailwind color-500 picks we chose for max
    // separation. If someone collapses two of them we'll fail this test
    // and remember to keep the palette diverse.
    expect(src).toContain("#3b82f6"); // blue
    expect(src).toContain("#8b5cf6"); // violet
    expect(src).toContain("#10b981"); // emerald
    expect(src).toContain("#ef4444"); // red
    expect(src).toContain("#14b8a6"); // teal
    expect(src).toContain("#ec4899"); // pink
    expect(src).toContain("#84cc16"); // lime
  });

  it("waterfall has hover tooltip with step + duration + offset + model", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    // Hover state, not just title= attr — title attrs delay too long to
    // be useful and don't pick up on focus events for keyboard users.
    // Tracks rows by stable key (handles backbone, fanout summary, and
    // expanded fanout-child rows in the same hover map).
    expect(src).toContain("hoverKey");
    expect(src).toContain("setHoverKey");
    expect(src).toMatch(/onMouseEnter/);
    expect(src).toMatch(/onMouseLeave/);
    // Must support keyboard focus too.
    expect(src).toMatch(/onFocus/);
    expect(src).toMatch(/onBlur/);
    // Tooltip surfaces the key dimensions per row kind. Stat is a
    // small helper that prints a name → value row inside the tooltip
    // body for each labelled metric.
    expect(src).toContain('name="duration"');
    expect(src).toContain('name="started at"');
    expect(src).toContain('name="model"');
    expect(src).toContain('name="items"');
    // Fanout-specific tooltip stats — count, parallel-aware span,
    // distribution.
    expect(src).toContain('name="span (parallel)"');
    expect(src).toContain('name="avg"');
    expect(src).toContain('name="p50"');
    expect(src).toContain('name="p95"');
  });

  it("waterfall renders a time axis with proportional ticks", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    expect(src).toContain("computeAxisTicks");
    // Ticks must use natural-feeling unit boundaries (not arbitrary
    // 25%/50%/75% splits) — the niceUnits array drives that choice.
    expect(src).toContain("niceUnits");
  });

  /**
   * Recurring step kinds (today only `teaching_piece`, which fans out
   * one row per generated piece in parallel) collapse into ONE
   * fanout summary row instead of N separate rows. The user's
   * complaint was that 4 "Each teaching piece" rows at the same
   * hierarchy as the backbone made it impossible to tell the
   * pipeline shape — and would have scaled badly to 50-piece
   * briefings down the road.
   */
  it("waterfall collapses repeated step keys into a fanout summary row", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    // Group input by stepKey, treat groups of size > 1 as fanouts.
    expect(src).toMatch(/grouped\s*=\s*new Map/);
    expect(src).toMatch(/group\.length\s*===\s*1/);
    expect(src).toMatch(/group\.length\s*[!><]/);
    // Two row-kind discriminator: "backbone" for size-1 groups,
    // "fanout" for size>1.
    expect(src).toMatch(/kind:\s*"backbone"/);
    expect(src).toMatch(/kind:\s*"fanout"/);
  });

  it("fanout summary row carries count + avg + p50 + p95 + parallel-aware span", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    // These fields drive the right-column readout and the tooltip.
    expect(src).toMatch(/count:\s*group\.length/);
    expect(src).toMatch(/avgMs:\s*totalDurationMs\s*\/\s*group\.length/);
    expect(src).toContain("p50Ms");
    expect(src).toContain("p95Ms");
    // Span is the wall-clock band — earliest start to latest end —
    // NOT the sum of child durations (which would over-count
    // parallel work).
    expect(src).toMatch(/spanMs:\s*Math\.max\(1,\s*endMs\s*-\s*startMs\)/);
    // ×N badge in the label so the cardinality is visible at a
    // glance even before hovering.
    expect(src).toMatch(/×\{row\.count\}/);
  });

  it("fanout summary uses a striped fill so it's visually distinct from solid backbone bars", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    // The repeating-linear-gradient pattern denotes "this bar represents
    // multiple things happening" rather than one monolithic operation.
    expect(src).toMatch(/repeating-linear-gradient/);
    expect(src).toMatch(/stripeBg/);
  });

  it("fanout rows are click-to-expand to reveal individual iterations", async () => {
    const src = await read("src/frontend/components/BriefingWaterfall.tsx");
    expect(src).toMatch(/expandedFanouts/);
    expect(src).toMatch(/toggleFanout/);
    // Expanded children render as smaller, indented bars under the
    // summary row.
    expect(src).toMatch(/kind:\s*"child"/);
    expect(src).toMatch(/isChildOfExpanded/);
  });

  it("AnalyticsPage uses BriefingWaterfall instead of stacked bar + legend", async () => {
    const src = await read("src/frontend/pages/AnalyticsPage.tsx");
    expect(src).toContain("BriefingWaterfall");
    // The old stacked-bar legend pattern is gone — verify by absence.
    expect(src).not.toContain("legend");
    expect(src).not.toContain("stepColor");
    // Waterfall is wired with the live data + step labels.
    expect(src).toContain("steps={b.steps}");
    expect(src).toContain("stepLabels={STEP_LABELS}");
  });
});

describe("scroll-timeline scrubber + calendar archive", () => {
  it("backend exposes /briefings/dates with retention + dates payload", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain('"/briefings/dates"');
    // The endpoint must return the user's retention boundary so the
    // frontend can disable navigation past it.
    expect(src).toContain("retentionDays");
    expect(src).toContain("earliestAllowed");
    expect(src).toContain("earliestRetained");
    expect(src).toContain("todayDate");
    // Must be deduplicated by date so a re-generated day doesn't double up.
    expect(src).toContain("DISTINCT briefing_date");
    // Newest-first so frontend mapping (index 0 = top of rail) is straightforward.
    expect(src).toContain("ORDER BY briefing_date DESC");
  });

  it("/briefings/dates anchors today + earliestAllowed to the user's local timezone, not UTC", async () => {
    // Without this, an 11 PM Sunday EDT user sees the archive seed
    // to UTC-Monday's empty week and the "This week" shortcut
    // disappears. Anchoring to userToday(user.timezone) keeps the
    // archive aligned with the user's wall clock.
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toMatch(/userToday\(user\.timezone\)/);
    // earliestAllowed is computed from the user-local today, not from
    // a UTC-anchored helper.
    expect(src).toMatch(/shiftDate\(todayDate, -retentionDays\)/);
    // Strip comments before checking that the legacy UTC-only helper
    // (`isoDaysAgo`) is no longer used in code.
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("isoDaysAgo");
  });

  it("ScrollTimeline component implements a week-scoped day-dot scrubber", async () => {
    const src = await read("src/frontend/components/ScrollTimeline.tsx");
    // Auto-fade behavior — visible during scroll, hides ~1.2s after.
    expect(src).toContain("HIDE_AFTER_MS");
    expect(src).toMatch(/window\.addEventListener\("scroll"/);
    // Pointer-based drag scrubbing (so it works on touch + mouse + pen).
    expect(src).toContain("handlePointerDown");
    expect(src).toContain("handlePointerMove");
    expect(src).toContain("setPointerCapture");
    // Dragging keeps the rail visible — auto-hide is suppressed mid-drag.
    expect(src).toContain('setVisible((prev) => (dragging ? prev : false))');
    // Tooltip surfaces the date being scrubbed to.
    expect(src).toContain("formatTimelineDate");

    // Week-scoped: rail shows at most the last N days. Briefings are
    // daily, so anything beyond that quickly becomes uninteresting on a
    // continuous rail — the Archive page's calendar handles month/year
    // navigation instead.
    expect(src).toMatch(/RAIL_WINDOW_DAYS\s*=\s*7/);
    expect(src).toMatch(/dates\.slice\(0,\s*RAIL_WINDOW_DAYS\)/);
    expect(src).toContain("railDates");

    // One day-dot per day — filled when active, hollow when not.
    expect(src).toContain("dayMarkers");
    expect(src).toMatch(/isActive\s*=\s*displayedDate === date/);
    expect(src).toMatch(/h-2\.5 w-2\.5 bg-text-primary/); // active filled dot
    expect(src).toMatch(/border border-border-subtle bg-bg/); // hollow dot
    expect(src).toMatch(/ring-2 ring-bg/); // halo so dots survive any underlying content

    // Old visual elements that the year-scoped rail had — and are
    // intentionally gone in this design — must NOT come back without
    // explicitly updating this test:
    expect(src).not.toContain("yearMarkers");
    expect(src).not.toContain("MAX_TICKS");
    expect(src).not.toContain("Horizontal focus bar");

    // Tooltip is a dark "notification pill" matching mobile-app
    // conventions — `bg-text-primary text-bg`. Shows the full weekday
    // name + month/day so the user has unambiguous date feedback.
    expect(src).toContain("bg-text-primary text-bg");

    // formatTimelineDate must include the weekday so the tooltip reads
    // "Thursday, Apr 23" rather than just "Apr 23".
    expect(src).toMatch(/weekday:\s*"long"/);

    // Hidden until the App-level layout reserves a guaranteed right
    // gutter (`lg:pr-16` at ≥1024px). Below `lg` the rail wouldn't
    // have anywhere to sit without overlapping the centered content
    // column, so it doesn't render at all.
    expect(src).toContain("hidden lg:flex");

    // The page-level layout must actually reserve gutter for the rail,
    // otherwise the centered content column extends into the rail's
    // viewport region. `lg:pr-16` (64px) on the outer wrapper is the
    // counterpart to `hidden lg:flex` here — both must move together.
    const appSrc = await read("src/frontend/App.tsx");
    expect(appSrc).toContain("lg:pr-16");
  });

  it("BriefingFeed tracks visible date and wires ScrollTimeline", async () => {
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    // Must fetch the full date list (not just the paginated chunk) so the
    // scrubber rail represents the user's complete retention window.
    expect(src).toContain('apiGet<BriefingDatesResponse>("/api/briefings/dates")');
    // IntersectionObserver tracks which date is currently in view.
    expect(src).toContain("intersectingDatesRef");
    expect(src).toContain("handleSectionIntersection");
    // Scrubbing triggers eager loading of intermediate pages until the
    // requested section is in the DOM.
    expect(src).toContain("handleScrub");
    expect(src).toContain("scrollIntoView");
    // ScrollTimeline is rendered with the live state.
    expect(src).toContain("<ScrollTimeline");
    expect(src).toContain("dates={allDates}");
    expect(src).toContain("onScrub={handleScrub}");
  });

  it("WeekNavigator enforces retention boundary on prev navigation and calendar grid", async () => {
    const src = await read("src/frontend/components/WeekNavigator.tsx");
    // Prev button disables when stepping would cross retention.
    expect(src).toContain("canGoPrev");
    expect(src).toContain("prevWeekStart >= earliestAllowed");
    // Next button disables at current week (no future).
    expect(src).toContain("canGoNext");
    expect(src).toMatch(/weekStart < weekStartFor\(today\)/);
    // Calendar cells outside retention or in the future are visually disabled.
    expect(src).toContain("disabled: iso < earliestAllowed || iso > today");
    // Days with briefings get a dot indicator for at-a-glance scanning.
    expect(src).toContain("hasBriefing");
    expect(src).toMatch(/datesWithBriefings\.has\(iso\)/);
    // Monday-anchored weeks (matches workweek mental model).
    expect(src).toMatch(/Monday-anchored|Mon.*anchored/i);
  });

  it("WeekNavigator exposes weekStartFor + addDays utilities for ArchivePage to share", async () => {
    const src = await read("src/frontend/components/WeekNavigator.tsx");
    expect(src).toMatch(/export function weekStartFor/);
    expect(src).toMatch(/export function addDays/);
  });

  it("ArchivePage uses WeekNavigator and filters briefings by week window", async () => {
    const src = await read("src/frontend/pages/ArchivePage.tsx");
    expect(src).toContain("WeekNavigator");
    expect(src).toContain("weekStartFor");
    // Initial state is "this week" — set once dates response lands.
    expect(src).toMatch(/setWeekStart\(weekStartFor\(data\.todayDate\)\)/);
    // Filter is week-based: briefing_date in [weekStart, weekStart + 6].
    expect(src).toContain("addDays(start, 6)");
    expect(src).toMatch(/b\.briefing_date >= start && b\.briefing_date <= end/);
    // Calendar cells get the set of dates with briefings to render dots.
    expect(src).toContain("datesWithBriefings");
    // Retention range is surfaced in the page subtitle so the user knows
    // the boundary up front.
    expect(src).toContain("formatRetentionRange");
    expect(src).toContain("earliestAllowed");
  });
});

describe("font size selector", () => {
  it("useFontSize hook sets root element fontSize", async () => {
    const src = await read("src/frontend/hooks/useFontSize.ts");
    expect(src).toContain("document.documentElement.style.fontSize");
    expect(src).toContain('"small"');
    expect(src).toContain('"medium"');
    expect(src).toContain('"large"');
  });

  it("QuickPrefs in Header includes font size options", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toContain("QuickPrefs");
    expect(src).toContain("FONT_SIZE_OPTIONS");
    expect(src).toContain("fontSize");
    expect(src).toContain("setFontSize");
  });

  it("QuickPrefs closes on Escape", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toContain('"Escape"');
    expect(src).toContain("setOpen(false)");
  });
});

describe("archive dedup", () => {
  it("briefings list route deduplicates by date", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("GROUP BY briefing_date");
    expect(src).toContain("COUNT(DISTINCT briefing_date)");
  });

  it("briefing today fallback prefers briefings with content", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("EXISTS (SELECT 1 FROM teaching_pieces");
  });
});

describe("baseline quiz UX", () => {
  it("auto-advances to next question after submit", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toContain("Submit & next");
    expect(src).not.toMatch(/setShowResult\(true\)/);
  });

  it("has I don't know button", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toContain("I don't know");
  });

  it("has Back button for navigation", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toContain("← Back");
    expect(src).toContain("prev()");
  });

  it("useBaseline hook exposes prev function", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toContain("prev:");
    expect(src).toMatch(/currentIndex > 0/);
  });

  it("inline calibration quiz also has I don't know", async () => {
    const src = await read("src/frontend/components/CalibrationQuiz.tsx");
    expect(src).toContain("I don't know");
  });

  it("loading state starts as true to prevent flash", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toMatch(/useState\(true\).*submitting/s);
  });
});

describe("concepts trails load all", () => {
  it("useConcepts exposes loadAll function", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    expect(src).toContain("loadAll");
    expect(src).toContain("ALL_SIZE");
  });

  it("ConceptsPage calls loadAll when in trails view", async () => {
    const src = await read("src/frontend/pages/ConceptsPage.tsx");
    expect(src).toContain("loadAll()");
    expect(src).toContain('viewMode === "trails"');
  });
});

describe("content width", () => {
  it("main content area is 860px wide", async () => {
    const app = await read("src/frontend/App.tsx");
    expect(app).toContain("max-w-[860px]");
    const header = await read("src/frontend/components/Header.tsx");
    expect(header).toContain("max-w-[860px]");
  });
});

describe("piece timestamps", () => {
  it("TeachingPieceData has created_at field", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toContain("created_at?: string");
  });

  it("TeachingPiece renders formatPieceTime", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("formatPieceTime");
    expect(src).toContain("toLocaleTimeString");
  });
});

describe("quiz assessment wiring", () => {
  it("quiz answer route imports and calls assessQuizAnswer", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain("assessQuizAnswer");
    expect(src).toContain("runAssessment");
    // The route now goes through the provider-agnostic LLM dispatcher
    // rather than instantiating AnthropicClient directly.
    expect(src).toContain("llmClient");
  });

  it("quiz answer route updates concept depth after assessment", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain("UPDATE concept_depth");
    expect(src).toContain("last_calibrated_at");
    expect(src).toContain("recordDepthChange");
  });

  it("quiz answer route stores assessment in calibration_quizzes table", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain("assessed_depth");
    expect(src).toContain("assessment_reasoning");
    expect(src).toContain("assessment_gaps");
    expect(src).toContain("assessment_learning_path");
  });

  it("batch baseline route uses real assessment, not placeholder", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).not.toMatch(/assessments\.push\(\{[^}]*reasoning: "Batch assessment pending"/);
    expect(src).toContain("runAssessment");
  });

  it("quiz route gracefully falls back on assessment failure", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain("Assessment could not be completed");
  });
});

describe("cold-start active concepts fix", () => {
  it("getActiveConcepts includes concepts with null last_exposed_at", async () => {
    const src = await read("src/worker/db/queries.ts");
    expect(src).toContain("cd.last_exposed_at IS NULL");
  });
});

describe("chat model picker", () => {
  it("ChatPanel fetches available models from /api/models", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    expect(src).toContain('apiGet<ModelsResponse>("/api/models")');
    expect(src).toContain("activeModelLabel");
  });

  it("model picker renders as a popover with checkmark on active model", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    expect(src).toContain("modelPickerOpen");
    expect(src).toContain("setSelectedModel");
    expect(src).toContain("polyline points");
  });
});

describe("Biome linting setup", () => {
  it("biome.json exists with linter enabled", async () => {
    const config = await read("biome.json");
    const parsed = JSON.parse(config);
    expect(parsed.linter.enabled).toBe(true);
    expect(parsed.formatter.enabled).toBe(true);
  });

  it("package.json has lint and format scripts", async () => {
    const pkg = JSON.parse(await read("package.json"));
    expect(pkg.scripts.lint).toContain("biome");
    expect(pkg.scripts.format).toContain("biome");
    expect(pkg.scripts.check).toContain("biome");
  });
});

describe("Slack conversation analysis pipeline", () => {
  it("SlackClient has getThreadReplies method", async () => {
    const src = await read("src/worker/integrations/slack.ts");
    expect(src).toContain("getThreadReplies");
    expect(src).toContain("conversations.replies");
  });

  it("slack-analyzer service extracts learning opportunities", async () => {
    const src = await read("src/worker/services/slack-analyzer.ts");
    expect(src).toContain("learningOpportunities");
    expect(src).toContain("knowledgeGaps");
    expect(src).toContain("questionsRaised");
    expect(src).toContain("decisionsOrOutcomes");
  });

  it("slack-analyzer prompt instructs specificity over generality", async () => {
    const src = await read("src/worker/services/slack-analyzer.ts");
    expect(src).toContain("not \"learn about Kubernetes\"");
    expect(src).toContain("TECHNICAL substance");
  });

  it("slack source fetches thread replies and runs analysis", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toContain("getThreadReplies");
    expect(src).toContain("analyzeSlackConversations");
    expect(src).toContain("slack-analyzer.js");
  });

  it("enriched Slack insights flow into work context descriptions", async () => {
    const src = await read("src/worker/sources/slack.ts");
    expect(src).toContain("Learning opportunities:");
    expect(src).toContain("Knowledge gaps:");
    expect(src).toContain("insight.summary");
  });

  it("emoji shortcodes are converted in WorkContextBar", async () => {
    const src = await read("src/frontend/components/WorkContextBar.tsx");
    expect(src).toContain("replaceEmojiShortcodes");
    expect(src).toContain("EMOJI_MAP");
  });
});

describe("GitHub source integration", () => {
  it("GitHubClient has all required methods", async () => {
    const src = await read("src/worker/integrations/github.ts");
    expect(src).toContain("getReviewRequestedPRs");
    expect(src).toContain("getAssignedPRs");
    expect(src).toContain("getCommentedPRs");
    expect(src).toContain("getTeamReviewPRs");
    expect(src).toContain("getRepoActivity");
    expect(src).toContain("listUserTeams");
    expect(src).toContain("listOrgRepos");
  });

  it("GitHub routes expose repo and team pickers", async () => {
    const src = await read("src/worker/routes/github.ts");
    expect(src).toContain('"/github/repos"');
    expect(src).toContain('"/github/teams"');
    expect(src).toContain('"/github/preview"');
  });

  it("GitHub routes are wired into the app", async () => {
    const src = await read("src/worker/index.ts");
    expect(src).toContain("githubRoutes");
  });

  it("github source fetches PRs when configured", async () => {
    const src = await read("src/worker/sources/github.ts");
    expect(src).toContain("GITHUB_TOKEN");
    expect(src).toContain("github_pr");
    expect(src).toContain("GitHub PRs");
  });

  it("concept extractor accepts any source type (extensible)", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("type: string");
    expect(src).toContain("WorkContextItem");
  });

  it("WorkContextBar has GitHub icons", async () => {
    const src = await read("src/frontend/components/WorkContextBar.tsx");
    expect(src).toContain("github_pr");
    expect(src).toContain("GitHub");
  });

  it("TeachingPiece has GitHub source labels", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("GitHub PR");
    expect(src).toContain("GitHub Issue");
  });

  it("GitHub settings type exists in useSettings", async () => {
    const src = await read("src/frontend/hooks/useSettings.ts");
    expect(src).toContain("GitHubSourceSettings");
    expect(src).toContain("includeReviewRequested");
    expect(src).toContain("includeTeamReviews");
  });

  it("SettingsPanel has GitHub custom panel + dynamic source nav", async () => {
    const panel = await read("src/frontend/components/settings/panels/GitHubPanel.tsx");
    expect(panel).toContain("updateGitHub");
    expect(panel).toContain("Pull requests");
    const shell = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(shell).toContain("CUSTOM_SOURCE_PANELS");
    expect(shell).toContain("github");
    expect(shell).toContain("buildSourceNavEntries");
  });

  it("/api/me returns avatarUrl derived from source_config", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toContain("avatarUrl");
    expect(src).toContain("github.com");
    expect(src).toContain(".png?size=80");
    expect(src).toContain("signalSurfaceMap");
  });

  it("Header UserAvatar shows GitHub avatar when available", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toContain("avatarUrl");
    expect(src).toContain("<img");
    expect(src).toContain("object-cover");
  });

  it("Env type includes GITHUB_TOKEN and GITHUB_ORG", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toContain("GITHUB_TOKEN");
    expect(src).toContain("GITHUB_ORG");
  });
});

describe("deep-dive stuck detection and inline generation", () => {
  it("detects stuck deep-dive generation after the stuck threshold", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toContain("has_deep_dive = -1");
    // Stuck threshold lowered from 2 min → 90 s once the streaming
    // pattern landed (typical deep-dive completes in 30–60 s, so
    // 90 s is generous but cuts the user-visible spinner-stuck
    // window in half when the original streaming request was
    // killed mid-flight).
    expect(src).toContain("90_000");
    expect(src).toContain("resetting");
  });

  it("runs deep-dive generation inline, not in waitUntil", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).not.toContain("ctx.waitUntil");
    expect(src).toContain("generateDeepDive");
    expect(src).toContain('status: "ready"');
  });
});

describe("async baseline quiz with polling", () => {
  it("quiz answer route returns pending:true immediately", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain("pending: true");
    expect(src).toContain("Assessing your answer");
  });

  it("quiz assessment polling endpoint exists", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain('"/quiz/:id/assessment"');
    expect(src).toContain("assessed_depth");
  });

  it("BaselineQuiz polls for assessment results", async () => {
    const src = await read("src/frontend/components/BaselineQuiz.tsx");
    expect(src).toContain("polledAssessments");
    expect(src).toContain("/assessment");
    expect(src).toContain("Assessing your answers");
  });

  it("useQuiz submitAnswer handles pending response with polling", async () => {
    const src = await read("src/frontend/hooks/useQuiz.ts");
    expect(src).toContain("pending");
    expect(src).toContain("/assessment");
  });
});

describe("FK constraint fix on briefing delete", () => {
  it("generate route nullifies quiz teaching_piece_id before deleting briefing", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("UPDATE calibration_quizzes SET teaching_piece_id = NULL");
  });

  it("reset route also nullifies quiz teaching_piece_id", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    const resetMatch = src.match(/briefing\/reset[\s\S]*?UPDATE calibration_quizzes SET teaching_piece_id = NULL/);
    expect(resetMatch).not.toBeNull();
  });
});

describe("pipeline parallelization", () => {
  it("source providers fetch in parallel via registry", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/Promise\.all\(\s*\n?\s*singletonProviders\.map/);
  });

  it("teaching pieces generate in batches of 2", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("ti += 2");
    expect(src).toContain("Promise.all(");
    expect(src).toContain("batch.map");
  });
});

describe("retry with jitter across integrations", () => {
  it("all integration clients import retryDelay", async () => {
    for (const file of [
      // Anthropic logic now lives in the provider-agnostic LLM adapter.
      "src/worker/integrations/llm/anthropic-adapter.ts",
      "src/worker/integrations/slack.ts",
      "src/worker/integrations/github.ts",
      "src/worker/integrations/incident-io.ts",
      "src/worker/integrations/feeds.ts",
    ]) {
      const src = await read(file);
      expect(src, `${file} should import retryDelay`).toContain("retryDelay");
    }
  });

  it("Anthropic adapter checks isRetryableStatus before retrying", async () => {
    const src = await read("src/worker/integrations/llm/anthropic-adapter.ts");
    expect(src).toContain("isRetryableStatus");
    expect(src).toContain("parseRetryAfter");
  });
});

describe("CodeBlock — syntax highlighting + line numbers + independent theme", () => {
  // The previous CodeBlock used `var(--primer-code-*)` CSS tokens
  // so the block followed the site theme. That design coupled the
  // block's theme to the page chrome, which made it impossible to,
  // say, read prose on a light page while keeping code in a darker
  // editor-style theme. The new CodeBlock decouples the two: it
  // uses prism-react-renderer with hardcoded light + dark palettes
  // chosen specifically for code legibility, and a per-page user
  // toggle persisted in localStorage + synced via window event.

  it("renders via prism-react-renderer with both light and dark themes registered", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toMatch(
      /import \{[^}]*Highlight[^}]*themes as prismThemes[^}]*\} from "prism-react-renderer"/,
    );
    // Both themes are wired in — `vsDark` for the dark variant
    // (workhorse VS Code theme) and `github` for light.
    expect(src).toMatch(/prismThemes\.vsDark/);
    expect(src).toMatch(/prismThemes\.github/);
    // Old CSS-token approach is gone — block theme is now
    // independent of the site theme by design.
    expect(src).not.toMatch(/var\(--primer-code-bg\)/);
    expect(src).not.toMatch(/var\(--primer-code-text\)/);
  });

  it("supports a per-page code theme toggle persisted in localStorage and synced across blocks", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    // Storage key for per-tab persistence; the change event itself
    // is now plumbed through the typed `code-theme-changed` bus so
    // all CodeBlock instances on the page stay in sync when one is
    // flipped.
    expect(src).toContain('"primer:code-theme"');
    // Three states: site (follow page), light (force light), dark
    // (force dark) — clicking the header toggle cycles them.
    expect(src).toMatch(/CodeTheme\s*=\s*"site"\s*\|\s*"light"\s*\|\s*"dark"/);
    // Listening + dispatching go through the typed bus.
    expect(src).toMatch(/onPrimerEvent\("code-theme-changed"/);
    expect(src).toContain("writeStoredCodeTheme(next)");
    expect(src).toMatch(/dispatchPrimerEvent\("code-theme-changed",\s*\{\s*theme:\s*next\s*\}\)/);
  });

  it("renders a line-number gutter with shrink-0 + select-none + tabular-nums", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    // The gutter has all three properties so it stays aligned
    // (shrink-0), doesn't get grabbed by copy-paste (select-none),
    // and lines digits up vertically (tabular-nums).
    expect(src).toMatch(/shrink-0[\s\S]{0,200}select-none[\s\S]{0,200}tabular-nums/);
    // Row is keyed `line-${i}` and renders a `{i + 1}` line
    // number — the canonical 1-indexed gutter contract.
    expect(src).toMatch(/key=\{`line-\$\{i\}`\}/);
    expect(src).toMatch(/\{i \+ 1\}/);
  });

  it("retains the copy-to-clipboard control", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toContain("navigator.clipboard.writeText(value)");
    // Visual feedback for the brief moment after click — same
    // shape as before so the tooltip + accessible name stay
    // pinned to the existing copy.
    expect(src).toMatch(/copied\s*\?\s*"✓ copied"\s*:\s*"copy"/);
  });

  it("strips a trailing newline so LLM-emitted snippets don't render with a stray gap at the bottom", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toMatch(/value\.replace\(\/\\n\+\$\/, ""\)/);
  });
});

describe("isZombie early detection for runtime cancellation", () => {
  it("isZombie checks metadata step for faster stuck detection", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain('parsed.step === "starting"');
    expect(src).toContain("45_000");
  });
});

describe("CI/CD — GitHub Actions workflows", () => {
  it("checks.yml runs on PR and exercises the full check suite", async () => {
    const yml = await read(".github/workflows/checks.yml");
    expect(yml).toContain("pull_request:");
    expect(yml).toContain("workflow_dispatch:");
    expect(yml).toContain("oven-sh/setup-bun");
    expect(yml).toContain('bun-version: "1.3.10"');
    expect(yml).toContain("bun install --frozen-lockfile");
    expect(yml).toContain("bun run lint");
    expect(yml).toContain("bun run typecheck");
    expect(yml).toContain("bun x vitest run");
    expect(yml).toContain("bun x vite build");
  });

  it.skip("deploy.yml triggers on push to main, gates on the check job, and deploys in correct order (deploy.yml removed)", async () => {
    const yml = await read(".github/workflows/deploy.yml");
    expect(yml).toContain("branches: [main]");
  });

  it.skip("deploy.yml uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID secrets and a production environment (deploy.yml removed)", async () => {
    const yml = await read(".github/workflows/deploy.yml");
    expect(yml).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
  });

  it("workflows pin third-party actions by SHA (security best practice)", async () => {
    const checks = await read(".github/workflows/checks.yml");
    const shaPattern = /actions\/checkout@[a-f0-9]{40} # v\d/;
    expect(checks).toMatch(shaPattern);
  });

  it("EVERY external action in EVERY workflow is pinned to a 40-char SHA", async () => {
    // Mirrors the GitHub repo setting "Require actions to be pinned
    // to a full-length commit SHA". GitHub enforces this at workflow
    // run time; this test catches the regression at PR time so a
    // contributor sees a clear failure instead of an opaque
    // workflow-blocked error after merge. Local actions
    // (`uses: ./.github/actions/...`) are exempt — they're our own
    // composite actions, versioned by commit anyway.
    const workflowsDir = resolve(REPO_ROOT, ".github/workflows");
    const files = (await readdir(workflowsDir)).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
    );
    expect(files.length, "should be at least one workflow file").toBeGreaterThan(0);

    for (const file of files) {
      const src = await read(`.github/workflows/${file}`);
      const usesLines = src.match(/^\s+uses:.+$/gm) ?? [];
      for (const line of usesLines) {
        // Local composite actions are exempt — they're versioned by
        // the same commit as the calling workflow.
        if (/uses:\s*\.\//.test(line)) continue;
        // Everything else (third-party + cross-repo) MUST pin to a
        // 40-char SHA. The trailing `\b` rejects shorter prefixes.
        expect(
          line,
          `${file}: \`${line.trim()}\` should pin to a 40-char SHA (got tag-style ref)`,
        ).toMatch(/uses:\s*[\w./-]+@[a-f0-9]{40}\b/);
      }
    }
  });

  it("workflows use github-hosted ubuntu-latest runners", async () => {
    const checks = await read(".github/workflows/checks.yml");
    expect(checks).toContain("runs-on: ubuntu-latest");
    expect(checks).not.toContain("depot-");
  });
});

describe("server-canonical timezone handling", () => {
  // The worker is the single source of truth for "today". Browser
  // sends its IANA timezone via `X-Client-Timezone` on every request;
  // worker resolves and persists it on `users.timezone` so cron can
  // stamp `briefing_date` correctly even with no live session.

  it("consolidated schema has users.timezone with a UTC default", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("timezone TEXT NOT NULL DEFAULT 'UTC'");
  });

  it("bootstrap-remote-migrations.sh tracks 0013 as already applied", async () => {
    const src = await read("scripts/bootstrap-remote-migrations.sh");
    expect(src).toContain("0013_user_timezone.sql");
  });

  it("worker exposes a single userToday helper used by every route", async () => {
    const util = await read("src/worker/util/time.ts");
    expect(util).toContain("export function userToday");
    expect(util).toContain("export function isValidTimezone");
    expect(util).toContain("export function resolveRequestTimezone");
    // Uses Intl with `en-CA` to natively get YYYY-MM-DD parts.
    expect(util).toContain("en-CA");
    // Defensive: invalid TZs from the network never reach Intl, since
    // both `userToday` and `resolveRequestTimezone` fall back to "UTC".
    expect(util).toContain('"UTC"');
  });

  it("userToday returns YYYY-MM-DD in the requested timezone (behaviour)", async () => {
    const { userToday, isValidTimezone, resolveRequestTimezone } = await import(
      "../../src/worker/util/time"
    );
    // Pin a known instant: Sun Apr 26 2026 23:30 UTC.
    // - America/New_York (UTC-4 EDT): 19:30 Sun Apr 26 → date 2026-04-26
    // - Asia/Tokyo (UTC+9): 08:30 Mon Apr 27 → date 2026-04-27
    // - UTC: 23:30 Sun Apr 26 → date 2026-04-26
    const instant = new Date("2026-04-26T23:30:00Z");
    expect(userToday("America/New_York", instant)).toBe("2026-04-26");
    expect(userToday("Asia/Tokyo", instant)).toBe("2026-04-27");
    expect(userToday("UTC", instant)).toBe("2026-04-26");

    // Validation accepts real IANA names + common UTC aliases, and
    // rejects garbage from the X-Client-Timezone header.
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Etc/UTC")).toBe(true);
    expect(isValidTimezone("America/Pluto")).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone("")).toBe(false);

    // Header wins over persisted; persistence flag flips iff they
    // differ. Travelers in Tokyo on a NYC-stored account get Tokyo
    // for the live session and the cron updates next morning.
    expect(
      resolveRequestTimezone("Asia/Tokyo", "America/New_York"),
    ).toEqual({ timezone: "Asia/Tokyo", shouldPersist: true });
    expect(
      resolveRequestTimezone("America/New_York", "America/New_York"),
    ).toEqual({ timezone: "America/New_York", shouldPersist: false });
    // Garbage header falls through to persisted.
    expect(
      resolveRequestTimezone("nonsense", "America/New_York"),
    ).toEqual({ timezone: "America/New_York", shouldPersist: false });
    // Neither header nor persisted → UTC default (cold-start case).
    expect(resolveRequestTimezone(null, null)).toEqual({
      timezone: "UTC",
      shouldPersist: false,
    });
  });

  it("UserContext exposes a per-request `timezone` string", async () => {
    const types = await read("src/worker/types.ts");
    expect(types).toMatch(/timezone:\s*string/);
  });

  it("user-context middleware reads X-Client-Timezone, persists if changed", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    expect(src).toContain("X-Client-Timezone");
    expect(src).toContain("resolveRequestTimezone");
    // The persistence write is fire-and-forget so the request stays
    // fast — we tolerate a failed write and try again next request.
    expect(src).toMatch(/UPDATE users SET timezone = \?/);
  });

  it("/briefing/today resolves today via userToday, never via a client ?date= param", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("function todayFor");
    expect(src).toContain("userToday(user.timezone)");
    // The route does NOT read `c.req.query("date")` for today resolution.
    // Tolerate either router name — pre-split (`briefingRoutes`)
    // or post-split (`briefingReadRoutes`).
    const todayRoute = src.match(
      /(?:briefingRoutes|briefingReadRoutes)\.get\("\/briefing\/today"[\s\S]*?\}\);/,
    );
    expect(todayRoute).not.toBeNull();
    expect(todayRoute?.[0]).not.toContain('c.req.query("date")');
    // Fallback only returns rows whose date is <= today (no future
    // briefings ever surface as "today").
    expect(todayRoute?.[0]).toMatch(/b\.briefing_date <= \?/);
  });

  it("/briefing/generate uses todayFor(user) and never accepts a client date", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    const generateRoute = src.match(
      /(?:briefingRoutes|briefingLifecycleRoutes)\.post\("\/briefing\/generate"[\s\S]*?\}\);/,
    );
    expect(generateRoute).not.toBeNull();
    expect(generateRoute?.[0]).toContain("const today = todayFor(user)");
    expect(generateRoute?.[0]).not.toContain('c.req.query("date")');
  });

  it("briefing-generator stamps briefing_date with userToday(timezone), not UTC", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("userToday(timezone)");
    // The generator no longer constructs UTC date strings for the row.
    // (Comments may mention them as anti-patterns; check non-comment lines.)
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\]/);
  });

  it("frontend api wrappers send X-Client-Timezone on every method", async () => {
    const src = await read("src/frontend/utils/api.ts");
    // Every wrapper goes through `authHeaders()` which adds the
    // header; every wrapper passes it through to fetch.
    expect(src).toContain("X-Client-Timezone");
    expect(src).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    // The cache is invalidated when the document regains focus so
    // travelers get the new TZ on the next request without a reload.
    expect(src).toContain("visibilitychange");
    // Each method resolves its URL via `resolvePath` and passes
    // headers from `authHeaders` — no method bypasses the wrapper.
    const methodCount = (src.match(/headers: authHeaders\(/g) ?? []).length;
    expect(methodCount).toBeGreaterThanOrEqual(5);
  });
});

describe("local-day boundary correctness", () => {
  // The worker is now the canonical source of truth for "today",
  // resolved per-request from the X-Client-Timezone header. The
  // frontend no longer constructs a date string and sends it via
  // `?date=` — that plumbing was the source of the "Monday April 27
  // in the header while my wall clock says Sunday" bug.

  it("useBriefing does not interpolate a ?date= query param anywhere", async () => {
    const src = await read("src/frontend/hooks/useBriefing.ts");
    // No `?date=` plumbing remains in code. The worker derives today
    // from user.timezone (resolved from X-Client-Timezone in
    // middleware). Strip line/jsdoc comments before checking — the
    // hook may legitimately reference the removed plumbing in its
    // explanatory comments.
    const code = src
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toMatch(/\?date=/);
    expect(code).not.toContain("function localTodayDate");
  });

  it("BriefingPage.todayDate falls back to user's local date, not UTC", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    // todayDate() is the fallback when briefing.briefing_date is null
    // (e.g. nothing has been generated yet). It must use local
    // components for the same reason as useBriefing.
    expect(src).toMatch(
      /function todayDate\(\)[\s\S]*?d\.getFullYear\(\)[\s\S]*?d\.getMonth\(\) \+ 1[\s\S]*?d\.getDate\(\)/,
    );
    expect(src).not.toMatch(/toISOString\(\)\.split\("T"\)\[0\]/);
  });

  it("TeachingPiece.isTodaysBriefing compares against local date", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The "new continuation" pill on Part-2+ pieces should fire when
    // the briefing is today's *in the user's calendar* — not when the
    // briefing's date matches UTC's date.
    expect(src).toMatch(
      /function isTodaysBriefing[\s\S]*?d\.getFullYear\(\)[\s\S]*?d\.getMonth\(\) \+ 1[\s\S]*?d\.getDate\(\)/,
    );
    expect(src).not.toMatch(/isTodaysBriefing[\s\S]{0,200}toISOString\(\)\.split/);
  });
});

describe("past briefings stay readable during today's regeneration", () => {
  it("BriefingFeed renders past sections regardless of generation state", async () => {
    // Past briefings are independent of today's regeneration. The
    // feed renders its date sections at all times; only the
    // generation progress panel (above the feed) is gated on the
    // generating flag.
    const src = await read("src/frontend/components/BriefingFeed.tsx");
    // The list-mapping render of items is unconditional — no
    // `!generating &&` guard around it.
    const itemsRender = src.indexOf("items.map((b) => (");
    expect(itemsRender).toBeGreaterThan(-1);
    const openBrace = src.lastIndexOf("{", itemsRender);
    const guard = src.slice(openBrace, itemsRender);
    expect(guard).not.toContain("!generation.generating");
    expect(guard).not.toContain("!isStillGenerating");
  });
});

describe("post-generate polling does not orphan setInterval", () => {
  // The streaming-keepalive `/briefing/generate` resolves only after
  // generation completes. Earlier code did
  //
  //   pollRef.current = setInterval(fetchBriefing, 3000);
  //
  // *after* the await, which overwrote the pollStatus interval ID
  // already stored in pollRef without clearing it — orphaning that
  // interval to run forever and rapidly re-render the page (the
  // "flashing content" bug). The fix is to drop that setInterval
  // entirely. pollStatus already polls every 2s and self-terminates
  // on status flip to 'generated'.
  //
  // Generation lifecycle moved out of useBriefing into useGeneration
  // so it could be decoupled from any specific date. The same
  // anti-pattern guard now applies there.

  it("useGeneration.generate does not start a fetch setInterval after the apiPost", async () => {
    const src = await read("src/frontend/hooks/useGeneration.ts");
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(
      /setInterval\(\s*resolveOutcome\s*,\s*\d+\s*\)/,
    );
    expect(code).not.toMatch(
      /setInterval\(\s*fetchBriefing\s*,\s*\d+\s*\)/,
    );
  });

  it("useGeneration.generate kicks pollStatus after the stream resolves", async () => {
    // The poll loop is the source of truth for completion. After
    // the stream returns, generate() drives one more pollStatus()
    // so the hook's `lastOutcome` is ready before any caller-driven
    // refetch fires.
    const src = await read("src/frontend/hooks/useGeneration.ts");
    expect(src).toMatch(
      /await apiPost\(["']\/api\/briefing\/generate["'][\s\S]{0,800}await pollStatus\(\)/,
    );
  });
});
