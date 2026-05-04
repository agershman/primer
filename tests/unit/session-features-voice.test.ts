/**
 * Per-article voice switcher + AudioPlayer source-text contracts.
 *
 * Extracted from `session-features.test.ts` so that unrelated
 * session-feature describe blocks don't all live in one 3600-line
 * file. The cleanup-roadmap note in `dev-docs/cleanup-roadmap.md`
 * (item 10) tracks the further splits.
 *
 * This file owns:
 *   - VoiceSwitcher component contract (provider grouping,
 *     persistence, surface-scoped events)
 *   - AudioPlayer contract (voice prop, scrubbing, rate cycling,
 *     keyboard shortcuts, surface fit)
 *   - Per-piece / DeepDive / Chat / Settings wiring of voice state
 *
 * @see ./session-features.test.ts — the residual session-feature
 *      tests still co-located with the rest
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("per-article voice switcher", () => {
  it("audio routes accept ?voice= query param and pass it as override to resolveTtsModel", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toContain('c.req.query("voice")');
    // Each route now passes its operation tag so per-surface defaults
    // resolve correctly under the new TTS_OPERATION_SETTINGS_KEY chain.
    expect(src).toMatch(/resolveTtsModel\(user,\s*override,\s*"teachingPiece"\)/);
    expect(src).toMatch(/resolveTtsModel\(user,\s*override,\s*"deepDive"\)/);
  });

  it("resolveTtsModel honors override before falling back to user setting", async () => {
    // resolveTtsModel now lives in the shared services/tts.ts module so chat
    // and pieces share one source of truth for voice resolution. The third
    // optional `operation` arg added per-surface defaults; legacy callers
    // still work without it (falls back to the global `ttsModel`).
    const src = await read("src/worker/services/tts.ts");
    expect(src).toMatch(
      /export function resolveTtsModel\(\s*user: UserContext,\s*override\?:\s*string \| null,\s*operation\?:\s*TtsOperation,?\s*\)/,
    );
    expect(src).toContain("if (override) {");
    expect(src).toContain("TTS_MODELS.find((x) => x.id === override)");
    // Per-op key is read first, then falls through to `models.ttsModel` global.
    expect(src).toContain("TTS_OPERATION_SETTINGS_KEY");
    expect(src).toMatch(/opPref\s*\?\?\s*models\.ttsModel/);
  });

  it("VoiceSwitcher component exists with provider grouping and persists via PATCH /api/settings", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    expect(src).toContain("VoiceSwitcher");
    expect(src).toContain('apiGet<TtsModelsResponse>("/api/tts-models")');
    expect(src).toContain('apiPatch("/api/settings"');
    // Persist scoped to the active surface — global `ttsModel` for the
    // legacy unscoped switcher, otherwise the per-op key from `SURFACE_KEY`.
    expect(src).toContain('signalSurfaceMap: { models: { [settingsKey]: newId } }');
    expect(src).toContain('SURFACE_KEY');
    expect(src).toContain("optgroup");
    expect(src).toContain("VOICE_CHANGED_EVENT");
    expect(src).toContain('primerEventName("tts-voice-changed")');
  });

  it("VoiceSwitcher dispatches and listens for tts-voice-changed via the typed bus", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    // Migrated to the typed event bus — the wire-format string is
    // unchanged but the dispatch + subscribe paths are now type-checked.
    expect(src).toContain("dispatchPrimerEvent");
    expect(src).toContain('onPrimerEvent("tts-voice-changed"');
  });

  it("AudioPlayer accepts voiceId prop and appends ?voice= to the src URL", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toContain("voiceId?: string | null");
    expect(src).toContain('`${srcBase}${srcBase.includes("?") ? "&" : "?"}voice=${encodeURIComponent(voiceId)}`');
  });

  it("AudioPlayer tears down audio element when src changes mid-life (voice switch)", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // useEffect dependency on src that pauses + nulls audioRef
    expect(src).toMatch(/useEffect\([\s\S]*?audioRef\.current\.pause\(\)[\s\S]*?audioRef\.current = null[\s\S]*?\},\s*\[src\]\)/);
  });

  it("AudioPlayer advances the bar against a buffered-end estimate while real duration is unknown", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Three retired placeholders we explicitly DON'T want back, each
    // of which read as a UI bug:
    //  - `width: 20%` static fill looked like real frozen progress.
    //  - The marquee animation looked like the bar was glitching.
    //  - The pinned-at-0 leading-edge dot made the bar appear stuck
    //    until duration arrived, then suddenly snap to wherever the
    //    user already was. (User-reported.)
    expect(src).not.toMatch(/width:\s*"20%"/);
    expect(src).not.toContain("animate-audio-marquee");

    // The replacement: while real duration is unknown we sample
    // `audio.buffered.end(...)` on every timeupdate as a live total
    // estimate. For our parallel-streamed TTS the browser receives
    // bytes far faster than 1× playback consumes them, so this
    // estimate quickly approaches the real total and the bar
    // advances smoothly with `currentTime` instead of pinning at 0%.
    expect(src).toContain("estimatedDuration");
    expect(src).toContain("setEstimatedDuration");
    expect(src).toMatch(/el\.buffered\.end\(/);
    expect(src).toMatch(/Math\.max\(cur, bufEnd \* 1\.05\)/); // small headroom

    // The fill uses `bestDuration = real ?? estimated`, capped at
    // 100% as defensive guard against currentTime briefly overshooting
    // a stale estimate.
    expect(src).toContain("bestDuration");
    expect(src).toContain("hasAnyDuration");
    expect(src).toMatch(/Math\.min\(100, \(progress \/ bestDuration\) \* 100\)/);

    // Estimated state is visually distinguishable from a fully-real
    // duration — slight opacity reduction on the fill plus a hollow
    // ring thumb (instead of solid accent) so the user can tell the
    // bar is informational rather than seekable.
    expect(src).toMatch(/hasKnownDuration \? "opacity-100" : "opacity-80"/);
    expect(src).toMatch(/hasKnownDuration\s*\?\s*"bg-accent"\s*:\s*"bg-bg border-2 border-accent"/);

    // Pre-first-timeupdate fallback is still the quiet pulsing dot —
    // before `buffered.end` has anything in it we have no estimate
    // and shouldn't pretend otherwise. This window is typically <250ms.
    expect(src).toMatch(/h-2 w-2 rounded-full bg-accent\/80 ring-2 ring-bg animate-pulse/);

    // Resetting on src change must clear the estimate too — otherwise
    // a voice switch would carry the previous clip's estimate over.
    expect(src).toContain("setEstimatedDuration(0)");

    // And the marquee keyframes are still gone from tokens.css.
    const tokens = await read("src/frontend/styles/tokens.css");
    expect(tokens).not.toMatch(/@keyframes audio-marquee\s*\{/);
    expect(tokens).not.toMatch(/@utility animate-audio-marquee\s*\{/);
  });

  it("AudioPlayer exposes its progress bar via aria-valuemin/max/now when duration is known", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toContain('role="progressbar"');
    expect(src).toContain("aria-valuemin");
    expect(src).toContain("aria-valuemax");
    expect(src).toContain("aria-valuenow");
    // While indeterminate, we omit valuemin/max/now and surface the
    // human-readable explanation via aria-valuetext.
    expect(src).toContain("aria-valuetext");
  });

  it("AudioPlayer formatTime returns '--:--' for non-finite durations (no Infinity:NaN)", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toContain('"--:--"');
    expect(src).toMatch(/Number\.isFinite\(s\)/);
  });

  it("AudioPlayer supports drag scrubbing on the track via pointer events", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Scrubbing uses the pointer events API so it works for mouse,
    // touch, and pen on the same code path.
    expect(src).toContain("handlePointerDown");
    expect(src).toContain("handlePointerMove");
    expect(src).toContain("handlePointerUp");
    expect(src).toContain("handlePointerCancel");
    // Pointer capture so a fast drag that wanders off the bar still
    // tracks — mandatory for usable touch scrubbing.
    expect(src).toContain("setPointerCapture");
    // While dragging we hold the picked position in a `scrubPct` state
    // and only commit `audio.currentTime` on pointer-up — repeatedly
    // mutating currentTime mid-drag would re-trigger buffering.
    expect(src).toContain("scrubPct");
    expect(src).toMatch(/audio\.currentTime\s*=\s*scrubPct \* duration/);
    // Track is `touch-none` so a vertical scroll gesture on the bar
    // doesn't fight with the horizontal scrub.
    expect(src).toContain("touch-none");
  });

  it("AudioPlayer renders a visible draggable thumb with hover-grow + active-grow", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Thumb circle positioned at `left: filledPct%`, with a ring so
    // it's visible against any track color.
    expect(src).toMatch(/left:\s*`\$\{filledPct\}%`/);
    expect(src).toMatch(/ring-2 ring-bg/);
    // Thumb sizes: 12px idle → 16px on hover (so the user gets
    // visual confirmation the bar is interactive before they grab
    // it) → 16px while actively dragging. The hover-grow uses the
    // wrapper's `group` class on the padded outer hit zone.
    expect(src).toMatch(
      /scrubPct != null\s*\?\s*"h-4 w-4"\s*:\s*"h-3 w-3 group-hover:h-4 group-hover:w-4"/,
    );
  });

  it("AudioPlayer's drag-to-scrub hit zone is taller than the visible 6px track to make grabbing it forgiving", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Outer wrapper holds the pointer handlers and has invisible
    // vertical padding so the click+drag zone is ~26px tall instead
    // of the 6px visible track. This was a critical UX fix —
    // previously the entire interactive area was the thin visible
    // bar, and the visible thumb (`pointer-events-none`) passed
    // through to it, making scrubbing essentially impossible.
    //
    // The track's `min-w` allows compression in narrow parents (e.g.
    // chat-message bubbles in a sidebar) so the player doesn't push
    // the rate button + time off-screen. On wider parents `flex-1`
    // claims the available space anyway.
    expect(src).toMatch(/group relative flex-1 min-w-\[40px\] py-2\.5/);
    // The visible track lives inside the wrapper as a separate
    // element so it stays slim while the wrapper takes the click.
    expect(src).toMatch(/relative h-1\.5 w-full rounded-full bg-surface-active/);
    // Pointer handlers are still on the wrapper (where trackRef
    // points), not the inner visible track, so `pctFromClientX`
    // resolves position from the wrapper's bounding rect.
    expect(src).toMatch(/ref=\{trackRef\}\s*\n\s*onPointerDown=\{handlePointerDown\}/);
  });

  it("teaching-generator + deep-dive-generator route code/prose on the ABOUT block (technical vs non-technical reader)", async () => {
    const teaching = await read("src/worker/services/teaching-generator.ts");
    const deepDive = await read("src/worker/services/deep-dive-generator.ts");
    for (const src of [teaching, deepDive]) {
      // Both prompts must explicitly tell the model how to route
      // code use on the ABOUT signal — the previous prompts
      // unconditionally framed pieces as "technical teaching",
      // which over-coded for non-technical readers (PMs,
      // designers, sales) and under-coded the inline-code-vs-
      // code-block decision for technical readers.
      expect(src).toMatch(/route on the ABOUT block/i);
      expect(src).toMatch(/non-technical/);
      // The prompt mentions inline code (with escaped backticks
      // inside the template literal — the source bytes contain
      // `\`code\``, hence the lenient regex below).
      expect(src).toMatch(/inline.{1,4}code/);
      expect(src).toMatch(/code-block/);
      // The renderer needs the language tag for syntax highlighting
      // — the prompt now explicitly requires it.
      expect(src).toMatch(/Always set[\s\S]{0,200}language[\s\S]{0,200}syntax-highlight/);
    }
  });

  it("inline code uses a neutral palette with a thin border (distinct from links, which use the accent color)", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    // Neutral foreground + warm bg + subtle border — visually a
    // "literal value" pill, not a link. The previous shape used
    // `text-accent bg-accent-dim` which read as link-styled.
    expect(src).toMatch(
      /font-mono text-text-primary bg-bg-warm border border-border-subtle rounded/,
    );
    // No more accent coloring on inline code.
    expect(src).not.toMatch(/font-mono text-accent bg-accent-dim/);
  });

  it("AudioPlayer accepts estimatedDurationSeconds and uses it as the duration floor", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Prop arrives via destructure on the function signature.
    expect(src).toMatch(/estimatedDurationSeconds\?:\s*number/);
    expect(src).toMatch(/estimatedDurationSeconds,\s*\n\s*\}/);
    // Initialized from the prop so the bar fills proportionally to
    // real elapsed time from t=0 — the buggy case the prop solves
    // is when the worker streams TTS at close to playback rate, so
    // `audio.buffered.end()` sits near `currentTime` and the
    // fill-ratio pegs near 80–95% the entire playback.
    expect(src).toMatch(/useState<number>\([\s\S]{0,200}estimatedDurationSeconds && estimatedDurationSeconds > 0/);
    // Also synced via effect so a late upgrade (caller fetched
    // text after the player mounted) raises the floor — but never
    // lowers it (Math.max preserves whatever buffered.end already
    // observed).
    expect(src).toMatch(/setEstimatedDuration\(\(cur\) => Math\.max\(cur, estimatedDurationSeconds\)\)/);
  });

  it("estimateTtsDurationSeconds uses ~13 chars/sec and biases toward overestimate", async () => {
    const { estimateTtsDurationSeconds, TTS_CHARS_PER_SECOND } = await import(
      "../../src/frontend/utils/audioEstimate"
    );
    // 13 chars/sec is the documented constant — slow end of the
    // observed range so the estimate biases long. Underestimates
    // would clamp the bar at 100% before audio ends, which is
    // exactly the bug the prop was added to fix.
    expect(TTS_CHARS_PER_SECOND).toBe(13);
    expect(estimateTtsDurationSeconds("a".repeat(130))).toBe(10);
    // Empty / falsy input returns 0 so the player falls back to
    // its existing buffered-end heuristic instead of rendering
    // a 0-second bar.
    expect(estimateTtsDurationSeconds("")).toBe(0);
    expect(estimateTtsDurationSeconds("   ")).toBe(0);
    expect(estimateTtsDurationSeconds(null)).toBe(0);
    expect(estimateTtsDurationSeconds(undefined)).toBe(0);
  });

  it("contentBlocksToSpokenText skips diagram + code blocks (matches what the TTS adapter sees)", async () => {
    const { contentBlocksToSpokenText } = await import("../../src/frontend/utils/audioEstimate");
    const out = contentBlocksToSpokenText([
      { type: "heading", value: "Why Postgres" },
      { type: "text", value: "It scales horizontally with read replicas." },
      { type: "code", value: "SELECT * FROM users;", language: "sql" },
      { type: "diagram", value: "graph TD; A-->B" },
      { type: "text", value: "And handles JSONB natively." },
    ]);
    // Code + diagram blocks are excluded — TTS reading SQL or
    // mermaid syntax is unhelpful, and the worker's
    // `contentToPlainText` skips them too. Headings + text join
    // with double newlines.
    expect(out).toContain("Why Postgres");
    expect(out).toContain("It scales horizontally");
    expect(out).toContain("JSONB natively");
    expect(out).not.toContain("SELECT");
    expect(out).not.toContain("graph TD");
  });

  it("TeachingPiece + DeepDiveView + ChatPanel all seed the AudioPlayer with a text-derived estimate", async () => {
    const piece = await read("src/frontend/components/TeachingPiece.tsx");
    expect(piece).toContain("estimatedDurationSeconds");
    expect(piece).toContain("estimateTtsDurationSeconds");
    expect(piece).toContain("contentBlocksToSpokenText(piece.content)");

    const dd = await read("src/frontend/pages/DeepDiveView.tsx");
    expect(dd).toContain("estimatedDurationSeconds");
    expect(dd).toContain("contentBlocksToSpokenText(deepDive.content)");

    const chat = await read("src/frontend/components/ChatPanel.tsx");
    expect(chat).toContain("estimatedDurationSeconds");
    expect(chat).toMatch(/estimateTtsDurationSeconds\(message\.content\)/);
  });

  it("AudioPlayer fits inside constrained parents (chat-message bubbles in narrow sidebars)", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Root flex container must declare `min-w-0 max-w-full` so the
    // player can shrink to its parent's width instead of pushing
    // controls past the bubble's right edge. A flex child can only
    // shrink below its content min-width when the parent grants
    // permission via `min-w-0`.
    expect(src).toMatch(
      /flex items-center gap-2 min-w-0 max-w-full min-h-\[44px\] focus:outline-none/,
    );
  });

  it("ChatPanel renders the audio area inside the bubble's padding (no negative-margin bleed) with min-w-0 wrappers", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    // The earlier `-mx-1` saved 4px of width but pushed the player
    // past the bubble's right edge in narrow chat-panel layouts.
    // The audio area now lives entirely inside the bubble's padding.
    expect(src).not.toMatch(/className="mt-2 -mx-1"/);
    // Both the wrap container and the inner flex row carry
    // `min-w-0` so the AudioPlayer's `min-w-0 max-w-full` self-
    // sizing can actually take effect (flex children only shrink
    // below content min-width when the parent is also min-w-0).
    expect(src).toMatch(/className="mt-2 min-w-0"/);
    expect(src).toMatch(/flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0/);
  });

  it("AudioPlayer has skip-back / skip-forward buttons for ±15s", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Match the same SKIP_SECONDS that Apple Podcasts / Spotify use.
    expect(src).toMatch(/SKIP_SECONDS\s*=\s*15/);
    // Both buttons exist and call skipBy with the configured constant.
    expect(src).toContain("Skip back");
    expect(src).toContain("Skip forward");
    expect(src).toContain("skipBy(-SKIP_SECONDS)");
    expect(src).toContain("skipBy(SKIP_SECONDS)");
    // skipBy clamps to [0, duration] when duration is known.
    expect(src).toMatch(/Math\.max\(0, Math\.min\(next, max\)\)/);
  });

  it("AudioPlayer supports keyboard scrubbing (Space / arrows / Home / End)", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // The container is focusable + has an onKeyDown handler so
    // keyboard scrubbing only fires when the player has focus.
    expect(src).toContain("tabIndex={0}");
    expect(src).toContain("onKeyDown={handleKeyDown}");
    // Arrow keys for ±15s skips, Shift modifier for ±5s fine jumps.
    expect(src).toContain('case "ArrowLeft"');
    expect(src).toContain('case "ArrowRight"');
    expect(src).toMatch(/skipBy\(-\(e\.shiftKey \? 5 : SKIP_SECONDS\)\)/);
    expect(src).toMatch(/skipBy\(e\.shiftKey \? 5 : SKIP_SECONDS\)/);
    // Space toggles play/pause, Home / End jump to start / end.
    expect(src).toContain('case " "');
    expect(src).toContain('case "Home"');
    expect(src).toContain('case "End"');
    // Modifier keys (Cmd/Ctrl/Alt) bail out so we don't fight with
    // browser/OS shortcuts.
    expect(src).toMatch(/e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey/);
  });

  it("AudioPlayer disables scrub-by-drag while streaming (duration unknown)", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // The pointerdown handler bails out when `hasKnownDuration` is
    // false — there's no meaningful position to drag to before the
    // total duration arrives.
    expect(src).toMatch(/if \(!hasKnownDuration\) return; \/\/ can't scrub/);
    // The skip buttons stay enabled (you can still rewind during
    // streaming), but the bar's pointer cursor reverts to default
    // when no scrubbing is possible.
    expect(src).toMatch(/hasKnownDuration \? "cursor-pointer" : "cursor-default"/);
    // The thumb visually distinguishes "estimated" (hollow ring) from
    // "real" (solid accent dot) so the user can tell whether the bar
    // is informational vs. seekable. The pointerdown handler's
    // `!hasKnownDuration` early return enforces the actual seek lock.
    expect(src).toMatch(/hasKnownDuration\s*\?\s*"bg-accent"\s*:\s*"bg-bg border-2 border-accent"/);
  });

  it("AudioPlayer supports playback speed cycling with persistence and cross-player sync", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Rate ladder matches what users will recognize from podcast apps.
    expect(src).toMatch(/PLAYBACK_RATES\s*=\s*\[0\.75,\s*1\.0,\s*1\.25,\s*1\.5,\s*1\.75,\s*2\.0\]/);
    // Persistence: localStorage read + write + safe fallback.
    expect(src).toContain("RATE_STORAGE_KEY");
    expect(src).toMatch(/localStorage\?\.getItem\(RATE_STORAGE_KEY\)/);
    expect(src).toMatch(/localStorage\?\.setItem\(RATE_STORAGE_KEY/);
    expect(src).toContain("readStoredRate()");
    // Cross-player broadcast — migrated to the typed bus.
    expect(src).toMatch(/dispatchPrimerEvent\("audio-rate-changed",\s*\{\s*rate:\s*next\s*\}\)/);
    expect(src).toMatch(/onPrimerEvent\("audio-rate-changed"/);
    // Cycling is bidirectional and wraps. cycleRate(-1) for slower,
    // cycleRate(1) for faster.
    expect(src).toContain("cycleRate(-1)");
    expect(src).toContain("cycleRate(1)");
    expect(src).toMatch(/% PLAYBACK_RATES\.length/);
    // The audio element's playbackRate is set both at element creation
    // and on subsequent rate changes, so it survives audio re-creation
    // (e.g. voice switches that drop audioRef).
    expect(src).toMatch(/el\.playbackRate = playbackRate/);
    expect(src).toMatch(/audioRef\.current\.playbackRate = playbackRate/);
  });

  it("AudioPlayer renders a clickable speed indicator with shift / right-click for slower", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // The button text comes from formatRate — keeps integer rates clean.
    expect(src).toContain("formatRate(playbackRate)");
    // Shift-click goes backward; default click goes forward; right-click
    // also goes backward as a power-user shortcut.
    expect(src).toMatch(/onClick=\{\(e\) => cycleRate\(e\.shiftKey \? -1 : 1\)\}/);
    expect(src).toContain("onContextMenu");
    // Visually emphasized when off-default so the user doesn't forget
    // they're listening at non-1× speed.
    expect(src).toMatch(/playbackRate === 1\s*\?[\s\S]*"text-accent bg-accent-dim/);
    // ARIA label includes the current rate so screen readers announce it.
    expect(src).toContain("Playback speed, currently");
  });

  it("AudioPlayer adds [ / ] keyboard shortcuts for slower / faster", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Match YouTube convention (< / > also work as shifted variants on
    // most US layouts, but [ / ] are the unshifted keys we listen on).
    expect(src).toContain('case "["');
    expect(src).toContain('case "]"');
    // cycleRate is in the keyboard handler's deps so it always sees the
    // latest closure.
    expect(src).toMatch(/\[skipBy, toggle, hasKnownDuration, duration, cycleRate\]/);
  });

  it("TeachingPiece renders VoiceSwitcher next to AudioPlayer with shared voiceId state", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(
      /import \{[^}]*\bVoiceSwitcher\b[^}]*\} from "\.\/VoiceSwitcher"/,
    );
    // Migrated to the typed event bus.
    expect(src).toMatch(/import \{ onPrimerEvent \} from "\.\.\/lib\/events"/);
    expect(src).toContain('onPrimerEvent("tts-voice-changed"');
    expect(src).toContain("const [voiceId, setVoiceId] = useState<string | null>(null)");
    // Assertions are flexible across single-line vs. multi-line
    // <AudioPlayer> JSX: the call site now passes
    // `estimatedDurationSeconds` to seed the progress-bar
    // denominator from the source-text length, which forced the
    // tag onto multiple lines.
    expect(src).toMatch(
      /<AudioPlayer\s+src=\{`\/api\/piece\/\$\{piece\.id\}\/audio`\}[\s\S]{0,800}voiceId=\{voiceId\}[\s\S]{0,800}compact[\s\S]{0,800}\/>/,
    );
    // Surface tag scopes the per-surface default + filters cross-surface
    // tts-voice-changed events so a chat or deep-dive pick doesn't
    // reload teaching-piece audio.
    expect(src).toContain(
      '<VoiceSwitcher currentVoiceId={voiceId} onChange={setVoiceId} surface="teachingPiece" />',
    );
  });

  it("DeepDiveView renders VoiceSwitcher next to AudioPlayer with shared voiceId state", async () => {
    const src = await read("src/frontend/pages/DeepDiveView.tsx");
    expect(src).toContain('import { VoiceSwitcher } from "../components/VoiceSwitcher"');
    // Migrated to the typed event bus.
    expect(src).toMatch(/import \{ onPrimerEvent \} from "\.\.\/lib\/events"/);
    expect(src).toContain('onPrimerEvent("tts-voice-changed"');
    expect(src).toContain("const [voiceId, setVoiceId] = useState<string | null>(null)");
    expect(src).toMatch(
      /<AudioPlayer\s+src=\{`\/api\/piece\/\$\{piece\.id\}\/deep-dive\/audio`\}[\s\S]{0,800}voiceId=\{voiceId\}[\s\S]{0,800}compact[\s\S]{0,800}\/>/,
    );
    expect(src).toContain(
      '<VoiceSwitcher currentVoiceId={voiceId} onChange={setVoiceId} surface="deepDive" />',
    );
  });

  it("SettingsPanel listens for tts-voice-changed and reloads settings to stay in sync", async () => {
    // The listener moved to the shell when SettingsPanel was split,
    // and was further migrated onto the typed event bus.
    const src = await read("src/frontend/components/settings/SettingsModal.tsx");
    expect(src).toMatch(/import \{ onPrimerEvent \} from "\.\.\/\.\.\/lib\/events"/);
    expect(src).toContain('onPrimerEvent("tts-voice-changed"');
  });
});
