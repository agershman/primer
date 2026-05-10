/**
 * Pins the audio-route diagnostic contract.
 *
 * Pre-fix, when ElevenLabs / OpenAI / Cloudflare TTS failed, the
 * route returned a generic `{ error: "Audio generation failed" }`
 * 500 — the `<audio>` element on the frontend then dropped the JSON
 * body trying to play it as audio bytes and the user just saw
 * "Audio unavailable" with no actionable info.
 *
 * The fix has two halves:
 *
 *   1. Worker — `audioErrorResponse` lives in services/tts.ts and:
 *        - Sniffs provider from the underlying error message prefix
 *          ("ElevenLabs TTS 401: …", "OpenAI TTS 429: …").
 *        - Logs `[audio] <surface> TTS failed (<provider>):` so
 *          worker-tail / Cloudflare logs are filterable per provider.
 *        - Returns 502 with `Content-Type: application/json` body
 *          `{ error, surface, provider, detail }` AND a custom
 *          `X-Audio-Error` header (single-line, capped at 200 chars).
 *        - Both the body and the header carry the upstream error so
 *          a curl debugger sees the JSON, the audio fallback fetch
 *          sees the header, and neither needs to know the other
 *          format.
 *
 *   2. Frontend AudioPlayer — when `<audio>` fires its opaque error
 *      event, it now does a follow-up `fetch(src)` and reads the
 *      `X-Audio-Error` header (or JSON body fallback) to populate
 *      an `errorDetail` state. The "Audio unavailable" line then
 *      shows the upstream message inline.
 *
 *   3. Voice switch resets the error state — so flipping voices
 *      after a 401 doesn't strand the player on the previous
 *      provider's error.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("worker: audioErrorResponse helper", () => {
  it("is exported from services/tts.ts so all audio routes share it", async () => {
    const src = await read("src/worker/services/tts.ts");
    expect(src).toMatch(/export function audioErrorResponse/);
  });

  it("sniffs provider from the error message prefix", async () => {
    const src = await read("src/worker/services/tts.ts");
    // Each branch of the ternary is allowed to break across lines
    // (Biome reformats the chain). Anchor on the regex pattern + the
    // string literal it maps to, with whitespace tolerance between.
    expect(src).toMatch(/\/\^ElevenLabs\/i\.test\(detail\)[\s\S]{0,40}"elevenlabs"/);
    expect(src).toMatch(/\/\^OpenAI\/i\.test\(detail\)[\s\S]{0,40}"openai"/);
    expect(src).toMatch(/detail\.includes\("@cf\/"\)[\s\S]{0,40}"cloudflare"/);
    expect(src).toMatch(/: "unknown"/);
  });

  it("returns 502 with surface + provider + detail in the JSON body", async () => {
    const src = await read("src/worker/services/tts.ts");
    expect(src).toMatch(/status:\s*502/);
    expect(src).toMatch(
      /JSON\.stringify\(\{[\s\S]{0,300}error: "Audio generation failed"[\s\S]{0,200}surface[\s\S]{0,200}provider[\s\S]{0,200}detail/,
    );
  });

  it("emits X-Audio-Error response header (single-line, capped at 200 chars)", async () => {
    const src = await read("src/worker/services/tts.ts");
    expect(src).toMatch(
      /"X-Audio-Error":\s*detail\.slice\(0, 200\)\.replace\(\/\[\\r\\n\]\+\/g, " "\)/,
    );
  });

  it("logs the failure with surface + provider tags so worker logs are filterable", async () => {
    const src = await read("src/worker/services/tts.ts");
    expect(src).toMatch(
      /console\.error\(`\[audio\] \$\{surface\} TTS failed \(\$\{provider\}\):`/,
    );
  });
});

describe("worker: audio routes use the shared helper", () => {
  it("piece audio + deep-dive audio funnel through audioErrorResponse", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    // Tolerate either depth — the audio handler may live in
    // `routes/pieces.ts` (legacy) or in a sibling sub-file under
    // `routes/pieces/audio.ts` (post-split, one folder deeper).
    expect(src).toMatch(/import \{[\s\S]{0,200}audioErrorResponse[\s\S]{0,200}\} from "(\.\.\/)+services\/tts\.js"/);
    expect(src).toMatch(/audioErrorResponse\("teaching piece", err\)/);
    expect(src).toMatch(/audioErrorResponse\("deep dive", err\)/);
    // The pre-fix `c.json({ error: "Audio generation failed" }, 500)`
    // shape is gone from this file.
    expect(src).not.toMatch(/c\.json\(\{ error: "Audio generation failed" \}, 500\)/);
  });

  it("chat audio funnels through audioErrorResponse with surface='chat reply'", async () => {
    const src = await read("src/worker/routes/chat.ts");
    expect(src).toMatch(
      /import \{[\s\S]{0,200}audioErrorResponse[\s\S]{0,200}\} from "\.\.\/services\/tts\.js"/,
    );
    expect(src).toMatch(/audioErrorResponse\("chat reply", err\)/);
    expect(src).not.toMatch(/c\.json\(\{ error: "Audio generation failed" \}, 500\)/);
  });

  it("ElevenLabs adapter awaits chunk response headers before returning, so upstream HTTP errors reach audioErrorResponse", async () => {
    // Pre-fix bug: ElevenLabs HTTP errors (401 bad key, 429 rate
    // limit, voice-not-allowed, free-tier concurrency cap) threw
    // inside `streamingTtsResponse`'s `start(controller)` callback —
    // *after* the worker had already flushed `200 OK + audio/mpeg`.
    // The route's try/catch never saw the error, audioErrorResponse
    // never ran, no X-Audio-Error header was set, and the player
    // showed a bare "Audio unavailable" with no diagnostic on the
    // user's screen.
    //
    // The fix awaits `Promise.all(streamPromises)` so every chunk's
    // response headers are confirmed before the Response is built.
    // Body streaming still happens lazily, so time-to-first-audio is
    // bounded by the slowest fetch's TTFB, not by full body download.
    const src = await read("src/worker/integrations/tts/elevenlabs-adapter.ts");
    expect(src).toMatch(/await Promise\.all\(streamPromises\)/);
  });
});

describe("AudioPlayer: surfaces upstream error inline", () => {
  it("tracks an errorDetail state separate from the player state machine", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toMatch(/const \[errorDetail, setErrorDetail\] = useState<string \| null>/);
  });

  it("on `<audio>.error`, fetches the URL and reads X-Audio-Error", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toMatch(/addEventListener\("error", \(\) => \{[\s\S]{0,800}fetch\(src/);
    expect(src).toMatch(/resp\.headers\.get\("X-Audio-Error"\)/);
  });

  it("falls back to JSON body `detail` / `error` when the header is absent", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toMatch(/ct\.includes\("application\/json"\)/);
    expect(src).toMatch(/body\.detail/);
    expect(src).toMatch(/body\.error/);
  });

  it("clears the error detail when the src changes (voice switch / retry)", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // The src-change teardown effect calls setErrorDetail(null) so
    // a previous provider's failure doesn't leak into the next one.
    expect(src).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,500}setErrorDetail\(null\)[\s\S]{0,200}\}, \[src\]\)/,
    );
  });

  it("renders 'Audio unavailable' as a click-toggleable popover trigger with an info icon", async () => {
    // Pre-fix the inline `Audio unavailable: <mono detail>` pattern
    // truncated long upstream messages in narrow chat bubbles, and
    // the affordance for "there is more detail here" was just a
    // hover title that touch users couldn't see at all. The click-
    // popover fixes both: the row stays uncluttered, the info-circle
    // signals the affordance, and the full detail (or troubleshooting
    // hints when no detail is available) renders in a floating panel.
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Trigger button — labelled "Audio unavailable" + ARIA popover
    // attributes so assistive tech announces it correctly.
    expect(src).toMatch(
      /<button[\s\S]{0,400}onClick=\{\(\) => setErrorOpen[\s\S]{0,400}aria-haspopup="dialog"[\s\S]{0,200}aria-expanded=\{errorOpen\}/,
    );
    expect(src).toMatch(/<span>Audio unavailable<\/span>[\s\S]{0,100}<InfoCircleIcon \/>/);
    // Popover content — the upstream detail when present, troubleshooting
    // hints when not.
    expect(src).toMatch(/role="dialog"[\s\S]{0,500}Couldn't play audio/);
    expect(src).toMatch(/errorDetail \?[\s\S]{0,300}font-mono[\s\S]{0,200}\{errorDetail\}/);
    expect(src).toMatch(/Common causes:/);
  });

  it("tracks an open/closed state for the error popover and clears it on src change", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    expect(src).toMatch(/const \[errorOpen, setErrorOpen\] = useState\(false\)/);
    // Voice switch / retry resets BOTH the detail and the open state
    // so a previous provider's popover doesn't stay pinned open after
    // the user swapped to a different voice.
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]{0,500}setErrorOpen\(false\)[\s\S]{0,200}\}, \[src\]\)/);
  });

  it("dismisses the error popover on outside click and Escape", async () => {
    const src = await read("src/frontend/components/AudioPlayer.tsx");
    // Without these, a user who peeked at the upstream message has
    // no obvious way to dismiss the popover — especially on touch
    // devices where there's no Escape key.
    expect(src).toMatch(/document\.addEventListener\("pointerdown"/);
    expect(src).toMatch(/e\.key === "Escape"[\s\S]{0,80}setErrorOpen\(false\)/);
  });
});
