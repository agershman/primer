/**
 * Tests for per-operation TTS voice defaults — the multi-surface
 * extension to the TTS layer that mirrors the per-operation LLM model
 * picks in `ModelsPanel`. Three surfaces in Primer synthesize speech
 * (teaching pieces, deep dives, chat replies) and each can carry its
 * own voice via a sibling key under `signalSurfaceMap.models`. When a
 * surface has no override set, resolution falls back to the global
 * `ttsModel` and finally `DEFAULT_TTS_MODEL`.
 *
 * Coverage:
 *   1. `resolveTtsModel` resolution chain — query override > per-op
 *      key > global > catalog default — exercised across each
 *      operation tag and each fallback level.
 *   2. `TTS_OPERATION_SETTINGS_KEY` shape — pin the key naming so the
 *      worker, the Settings panel, and the inline switcher all stay
 *      in lockstep on the storage shape.
 *   3. VoicePanel source-text contract — Default voice + per-surface
 *      override rows + the `null` "Use default" sentinel sent on
 *      clear.
 *   4. VoiceSwitcher source-text contract — accepts the `surface`
 *      prop, persists scoped to that surface, broadcasts the surface
 *      in the `VoiceChangedDetail` so parent listeners can filter
 *      cross-surface noise.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  resolveTtsModel,
  TTS_OPERATION_SETTINGS_KEY,
  type TtsOperation,
} from "../../src/worker/services/tts.js";
import type { UserContext } from "../../src/worker/types.js";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

function userWithVoiceModels(models: Record<string, string | null>): UserContext {
  return {
    userId: "user-1",
    email: "test@example.com",
    settings: {
      signalSurfaceMap: { models },
      // Other settings fields aren't read by `resolveTtsModel`; cast
      // to satisfy the type without dragging in the full shape.
    } as UserContext["settings"],
    aboutStatement: null,
    focusStatement: null,
    timezone: "UTC",
  } as unknown as UserContext;
}

describe("TTS_OPERATION_SETTINGS_KEY", () => {
  it("maps each operation to its `ttsModel${Operation}` settings key", () => {
    expect(TTS_OPERATION_SETTINGS_KEY).toEqual({
      teachingPiece: "ttsModelTeachingPiece",
      deepDive: "ttsModelDeepDive",
      chat: "ttsModelChat",
    });
  });

  it("covers every TtsOperation — adding a new operation forces this map to grow", () => {
    const operations: TtsOperation[] = ["teachingPiece", "deepDive", "chat"];
    for (const op of operations) {
      expect(TTS_OPERATION_SETTINGS_KEY[op]).toMatch(/^ttsModel/);
    }
  });
});

describe("resolveTtsModel — per-operation resolution chain", () => {
  it("query override wins over everything", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      ttsModelChat: "openai-tts-1-onyx",
    });
    const m = resolveTtsModel(user, "openai-tts-1-nova", "chat");
    expect(m.id).toBe("openai-tts-1-nova");
  });

  it("falls back to per-operation key when there's no query override", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      ttsModelDeepDive: "openai-tts-1-onyx",
    });
    expect(resolveTtsModel(user, undefined, "deepDive").id).toBe("openai-tts-1-onyx");
  });

  it("falls back to the global ttsModel when the per-op key is absent", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      // No ttsModelChat set.
    });
    expect(resolveTtsModel(user, undefined, "chat").id).toBe("aura-luna");
  });

  it("treats a per-op value of null as 'no override' (Use default sentinel)", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      ttsModelTeachingPiece: null, // user picked "Use default voice"
    });
    expect(resolveTtsModel(user, undefined, "teachingPiece").id).toBe("aura-luna");
  });

  it("falls back to DEFAULT_TTS_MODEL when no override, no per-op, and no global is set", () => {
    const user = userWithVoiceModels({});
    const m = resolveTtsModel(user, undefined, "teachingPiece");
    // Whatever the catalog default points to — `aura-asteria` today —
    // we just assert it's a real catalog entry, so a default-id rename
    // doesn't break the test.
    expect(m.id).toBeTruthy();
    expect(m.provider).toBe("cloudflare");
  });

  it("ignores an unknown override and still uses the per-op chain", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      ttsModelChat: "openai-tts-1-nova",
    });
    expect(resolveTtsModel(user, "not-a-real-voice-id", "chat").id).toBe("openai-tts-1-nova");
  });

  it("works without an operation tag — legacy call path uses global ttsModel", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      ttsModelChat: "openai-tts-1-nova", // shouldn't be selected
    });
    expect(resolveTtsModel(user, undefined).id).toBe("aura-luna");
  });

  it("each operation isolates its own override from the others", () => {
    const user = userWithVoiceModels({
      ttsModel: "aura-luna",
      ttsModelTeachingPiece: "openai-tts-1-fable",
      ttsModelDeepDive: "openai-tts-1-onyx",
      ttsModelChat: "openai-tts-1-nova",
    });
    expect(resolveTtsModel(user, undefined, "teachingPiece").id).toBe("openai-tts-1-fable");
    expect(resolveTtsModel(user, undefined, "deepDive").id).toBe("openai-tts-1-onyx");
    expect(resolveTtsModel(user, undefined, "chat").id).toBe("openai-tts-1-nova");
  });
});

describe("VoicePanel — Default voice + per-surface override rows", () => {
  it("lists each TTS operation alongside its settings key, mirroring the worker mapping", async () => {
    const src = await read("src/frontend/components/settings/panels/VoicePanel.tsx");
    expect(src).toContain('"ttsModelTeachingPiece"');
    expect(src).toContain('"ttsModelDeepDive"');
    expect(src).toContain('"ttsModelChat"');
    expect(src).toMatch(/Per-surface overrides/i);
    expect(src).toMatch(/Use default voice/);
  });

  it("uses null as the 'Use default voice' sentinel — preserves global fallback through deepMerge", async () => {
    const src = await read("src/frontend/components/settings/panels/VoicePanel.tsx");
    // The clear branch sends `null` (not undefined), so the worker's
    // deepMerge writes a real null which `resolveTtsModel` then treats
    // as "no override" via the `??` chain.
    expect(src).toMatch(/v\s*===\s*USE_DEFAULT\s*\?\s*null\s*:\s*v/);
  });

  it("PATCHes the full models map so existing keys stay intact and cleared keys land as null", async () => {
    const src = await read("src/frontend/components/settings/panels/VoicePanel.tsx");
    expect(src).toMatch(/signalSurfaceMap:\s*\{[\s\S]{0,300}models:/);
  });
});

describe("VoiceSwitcher — surface-scoped persistence + cross-surface event filter", () => {
  it("accepts an optional surface prop matching the worker's TtsOperation union", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    expect(src).toMatch(/export type TtsSurface\s*=/);
    expect(src).toMatch(/teachingPiece/);
    expect(src).toMatch(/deepDive/);
    expect(src).toMatch(/"chat"/);
  });

  it("persists scoped to the surface when set, otherwise to the global ttsModel", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    // Surface → per-op settings key, no surface → global ttsModel.
    expect(src).toContain('SURFACE_KEY');
    expect(src).toMatch(/surface\s*\?\s*SURFACE_KEY\[surface\]\s*:\s*"ttsModel"/);
  });

  it("includes the surface in the tts-voice-changed payload so listeners can filter", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    // Migrated to the typed bus — the dispatch now goes through
    // `dispatchPrimerEvent` with the same payload shape.
    expect(src).toMatch(
      /dispatchPrimerEvent\("tts-voice-changed",\s*\{\s*voiceId:\s*newId,\s*surface\s*\}\)/,
    );
    // The event detail interface advertises the optional surface field.
    expect(src).toMatch(/interface VoiceChangedDetail/);
    expect(src).toMatch(/surface\?:\s*TtsSurface/);
  });

  it("filters incoming events by surface when its own surface is set", async () => {
    const src = await read("src/frontend/components/VoiceSwitcher.tsx");
    // The handler ignores cross-surface events. Allow optional chaining
    // (`detail?.surface`) on the existence check.
    expect(src).toMatch(/detail\??\.surface\s*&&\s*detail\??\.surface\s*!==\s*surface/);
  });
});

describe("Parent listeners filter cross-surface VoiceChangedEvents", () => {
  it("TeachingPiece ignores chat / deep-dive scoped voice picks", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/detail\.surface\s*&&\s*detail\.surface\s*!==\s*"teachingPiece"/);
  });

  it("DeepDiveView ignores chat / teaching-piece scoped voice picks", async () => {
    const src = await read("src/frontend/pages/DeepDiveView.tsx");
    expect(src).toMatch(/detail\.surface\s*&&\s*detail\.surface\s*!==\s*"deepDive"/);
  });

  it("ChatPanel ignores deep-dive / teaching-piece scoped voice picks", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    expect(src).toMatch(/detail\.surface\s*&&\s*detail\.surface\s*!==\s*"chat"/);
  });
});

describe("Routes pass operation tags into resolveTtsModel", () => {
  it("piece audio route → teachingPiece", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toMatch(/resolveTtsModel\(user,\s*override,\s*"teachingPiece"\)/);
  });

  it("deep-dive audio route → deepDive", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toMatch(/resolveTtsModel\(user,\s*override,\s*"deepDive"\)/);
  });

  it("chat audio route → chat", async () => {
    const src = await read("src/worker/routes/chat.ts");
    expect(src).toMatch(/resolveTtsModel\(user,\s*override,\s*"chat"\)/);
  });
});
