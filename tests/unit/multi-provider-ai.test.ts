/**
 * Tests for the multi-provider AI architecture and the recent UX
 * additions that landed alongside it:
 *
 *   1. LLM adapter layer (`integrations/llm/`) — provider-agnostic
 *      `LLMClient` interface, `ModelSpec`, `NormalizedUsage`, the
 *      Anthropic adapter, and the dispatcher.
 *   2. Unified `usage_events` ledger — schema shape, `recordTokenUsage`,
 *      `recordAudioUsage`, per-provider / per-modality rollups.
 *   3. Pricing catalog + `estimateLlmCost` — single source of truth
 *      pricing, all four token classes, fallback to 0 for unknown
 *      (provider, model) pairs.
 *   4. TTS adapter pattern — dispatcher registry, `isProviderConfigured`,
 *      ElevenLabs catalog entries.
 *   5. Per-source relevance filter overrides — bucketing in
 *      `concept-extractor` and `adjacent-scanner` so override prompts
 *      replace the global filter for items from that source.
 *   6. Async baseline calibration — `POST /api/quiz/baseline/prepare`,
 *      `baseline_calibration` notification kind, `{ generating: true }`
 *      short-circuit on the GET endpoint.
 *   7. Required `note` on About / Focus statement changes — server-side
 *      enforcement on `POST /api/me/focus` and `POST /api/me/about`.
 *   8. Enriched `GET /api/briefings` response (pieceCount, pieceTitles,
 *      topConcepts) for the Archive page summary card.
 *   9. `ConfirmDialog` replaces native `confirm()` for feed removal.
 *
 * Like the rest of the suite, these are mostly source-text contracts
 * — fast, no D1 fixtures, but enough to catch regressions on the seam
 * between layers.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AVAILABLE_MODELS,
  lookupCatalog,
  lookupCatalogById,
  resolveModel,
  tierOf,
} from "../../src/worker/config/models.js";
import { estimateLlmCost } from "../../src/worker/config/pricing.js";
import {
  isProviderConfigured,
  getConfiguredProviders,
  llmClient,
} from "../../src/worker/integrations/llm/dispatcher.js";
import type { Env } from "../../src/worker/types.js";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("LLM adapter layer", () => {
  it("provider-agnostic types live in integrations/llm/types.ts", async () => {
    const src = await read("src/worker/integrations/llm/types.ts");
    expect(src).toMatch(/export interface LLMClient/);
    expect(src).toMatch(/export interface ModelSpec/);
    expect(src).toMatch(/export interface NormalizedUsage/);
    expect(src).toMatch(/inputTokens:\s*number/);
    expect(src).toMatch(/outputTokens:\s*number/);
    expect(src).toMatch(/reasoningTokens\?:\s*number/);
    expect(src).toMatch(/cacheReadTokens\?:\s*number/);
    expect(src).toMatch(/cacheWriteTokens\?:\s*number/);
    expect(src).toMatch(/createMessage\(/);
    expect(src).toMatch(/streamMessage\(/);
    expect(src).toMatch(/generateJson</);
    expect(src).toMatch(/ProviderId.*=\s*"anthropic"/);
  });

  it("AnthropicAdapter implements LLMClient and normalizes Anthropic usage", async () => {
    const src = await read("src/worker/integrations/llm/anthropic-adapter.ts");
    expect(src).toMatch(/export class AnthropicAdapter\b[\s\S]{0,80}implements LLMClient/);
    expect(src).toContain("api.anthropic.com/v1");
    expect(src).toContain("x-api-key");
    expect(src).toContain("anthropic-version");
    // Normalizes Anthropic's `cache_*_input_tokens` -> NormalizedUsage
    expect(src).toContain("cache_read_input_tokens");
    expect(src).toContain("cache_creation_input_tokens");
    expect(src).toMatch(/cacheReadTokens/);
    expect(src).toMatch(/cacheWriteTokens/);
  });

  it("dispatcher returns a DispatchingLLMClient and routes by spec.provider via a registry", async () => {
    const src = await read("src/worker/integrations/llm/dispatcher.ts");
    expect(src).toMatch(/export function llmClient\(env: Env\): LLMClient/);
    // Registry is the source of truth — adding a provider is one
    // entry in this list, not a new branch in a switch.
    expect(src).toMatch(/LLM_ADAPTERS\s*:\s*readonly LLMAdapterRegistration\[\]/);
    // Anthropic registration is the seed entry; gate is on the
    // ANTHROPIC_API_KEY env var
    expect(src).toMatch(/provider:\s*"anthropic"[\s\S]{0,200}env\.ANTHROPIC_API_KEY/);
    // Future-provider fallthrough — clear error keeps unknown
    // providers from silently routing to a wrong adapter.
    expect(src).toMatch(/LLM provider not yet supported/);
    // Provider-specific "not configured" error helps the operator
    // figure out which key is missing without reading the source.
    expect(src).toMatch(/API key not configured/);
  });

  it("services route through the LLM adapter layer, not a hard-coded AnthropicClient", async () => {
    const services = [
      "src/worker/services/briefing-generator.ts",
      "src/worker/services/concept-extractor.ts",
      "src/worker/services/chat-responder.ts",
      "src/worker/services/adjacent-scanner.ts",
      "src/worker/services/teaching-generator.ts",
      "src/worker/services/quiz-assessor.ts",
      "src/worker/services/continuation-classifier.ts",
    ];
    for (const path of services) {
      const src = await read(path);
      // Every service either depends on the `LLMClient` interface
      // (typed param) or constructs one via `llmClient(env)`. Either
      // way they're routing through the new adapter dispatcher.
      expect(src, `${path} should use the LLM adapter layer`).toMatch(/LLMClient|llmClient\(/);
      // No service should call `new AnthropicClient(` directly anymore.
      // The legacy shim still exists for back-compat but service-layer
      // code goes through the dispatcher.
      expect(src, `${path} should not instantiate AnthropicClient`).not.toMatch(
        /new AnthropicClient\(/,
      );
    }
  });
});

describe("model catalog + pricing", () => {
  it("every catalog entry has a provider and full pricing rates", () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThan(0);
    for (const m of AVAILABLE_MODELS) {
      expect(m.provider).toBeTruthy();
      expect(m.providerModel).toBeTruthy();
      expect(m.pricing).toBeDefined();
      expect(typeof m.pricing.inputPer1M).toBe("number");
      expect(typeof m.pricing.outputPer1M).toBe("number");
      expect(m.pricing.inputPer1M).toBeGreaterThan(0);
      expect(m.pricing.outputPer1M).toBeGreaterThan(0);
    }
  });

  it("lookup helpers find by (provider, providerModel) and by id", () => {
    const sonnet = AVAILABLE_MODELS.find((m) => m.label.includes("Sonnet"));
    expect(sonnet).toBeDefined();
    if (!sonnet) return;
    expect(sonnet.provider).toBe("anthropic");
    expect(lookupCatalogById(sonnet.id)).toEqual(sonnet);
    expect(lookupCatalog(sonnet.provider, sonnet.providerModel)).toEqual(sonnet);
    expect(lookupCatalog("anthropic", "no-such-model")).toBeNull();
    expect(lookupCatalogById("no-such-id")).toBeNull();
  });

  it("resolveModel returns a ModelSpec for default operations", () => {
    const spec = resolveModel(null, "teachingPiece");
    expect(spec.provider).toBe("anthropic");
    // The model id should be a provider-native id (not the catalog id)
    expect(spec.model).toMatch(/^claude-/);
  });

  it("resolveModel honors a stored ModelSpec override (forward-compat)", () => {
    const haiku = AVAILABLE_MODELS.find((m) => m.label.includes("Haiku"));
    expect(haiku).toBeDefined();
    if (!haiku) return;
    const spec = resolveModel(
      { models: { teachingPiece: { provider: haiku.provider, model: haiku.providerModel } } },
      "teachingPiece",
    );
    expect(spec.provider).toBe(haiku.provider);
    expect(spec.model).toBe(haiku.providerModel);
  });

  it("resolveModel honors the legacy string-id override form", () => {
    const haiku = AVAILABLE_MODELS.find((m) => m.label.includes("Haiku"));
    expect(haiku).toBeDefined();
    if (!haiku) return;
    const spec = resolveModel({ models: { teachingPiece: haiku.id } }, "teachingPiece");
    expect(spec.provider).toBe(haiku.provider);
    expect(spec.model).toBe(haiku.providerModel);
  });

  it("resolveModel falls back to the default when the override is unknown", () => {
    const spec = resolveModel(
      { models: { teachingPiece: { provider: "anthropic", model: "ghost-model" } } },
      "teachingPiece",
    );
    // Should produce the default rather than the unknown spec
    expect(spec.model).not.toBe("ghost-model");
    expect(spec.provider).toBe("anthropic");
  });

  it("tierOf works for catalog id and provider-native id alike", () => {
    const sonnet = AVAILABLE_MODELS.find((m) => m.label.includes("Sonnet"));
    const haiku = AVAILABLE_MODELS.find((m) => m.label.includes("Haiku"));
    expect(sonnet).toBeDefined();
    expect(haiku).toBeDefined();
    if (!sonnet || !haiku) return;
    // Catalog id resolves to the configured tier
    expect(tierOf(sonnet.id)).toBe(sonnet.tier);
    expect(tierOf(haiku.id)).toBe(haiku.tier);
    // Provider-native id is the same as catalog id for Anthropic today,
    // but the lookup is also by `providerModel` so cross-provider entries
    // (where they differ) work too.
    expect(tierOf(sonnet.providerModel)).toBe(sonnet.tier);
    expect(tierOf(null)).toBe("unknown");
    expect(tierOf("unknown-model-id")).toBe("unknown");
  });

  it("estimateLlmCost computes cost across input / output / reasoning / cache tokens", () => {
    const sonnet = AVAILABLE_MODELS.find((m) => m.label.includes("Sonnet"));
    expect(sonnet).toBeDefined();
    if (!sonnet) return;
    const spec = { provider: sonnet.provider, model: sonnet.providerModel };
    const cost = estimateLlmCost(spec, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1M input + 1M output = inputPer1M + outputPer1M (in dollars)
    const expected = sonnet.pricing.inputPer1M + sonnet.pricing.outputPer1M;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("estimateLlmCost adds reasoning-token cost when provided", () => {
    const sonnet = AVAILABLE_MODELS.find((m) => m.label.includes("Sonnet"));
    expect(sonnet).toBeDefined();
    if (!sonnet) return;
    const spec = { provider: sonnet.provider, model: sonnet.providerModel };
    const baseline = estimateLlmCost(spec, { inputTokens: 0, outputTokens: 0 });
    const withReasoning = estimateLlmCost(spec, {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 500_000,
    });
    expect(withReasoning).toBeGreaterThan(baseline);
  });

  it("estimateLlmCost returns 0 for an unknown (provider, model) pair", () => {
    const cost = estimateLlmCost(
      { provider: "anthropic", model: "ghost-model-9000" },
      { inputTokens: 1000, outputTokens: 1000 },
    );
    expect(cost).toBe(0);
  });
});

describe("unified usage_events ledger", () => {
  it("0001_initial.sql defines usage_events with all required columns", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toMatch(/CREATE TABLE\s+usage_events/i);
    // Modality is the discriminator between text-LLM and TTS rows
    expect(sql).toContain("modality");
    expect(sql).toContain("provider");
    expect(sql).toContain("input_tokens");
    expect(sql).toContain("output_tokens");
    expect(sql).toContain("reasoning_tokens");
    expect(sql).toContain("cache_read_tokens");
    expect(sql).toContain("cache_write_tokens");
    expect(sql).toContain("audio_chars");
    expect(sql).toContain("voice");
    expect(sql).toContain("estimated_cost_usd");
    // The legacy token_usage table should be gone in the consolidated schema
    expect(sql).not.toMatch(/CREATE TABLE\s+token_usage\b/i);
  });

  it("recordTokenUsage writes a 'text' row and computes cost from the catalog", async () => {
    const src = await read("src/worker/db/queries.ts");
    expect(src).toMatch(/export async function recordTokenUsage/);
    // Modality is hard-coded in the SQL for the text path
    expect(src).toMatch(/INSERT INTO usage_events[\s\S]{0,400}'text'/);
    // estimateLlmCost is the fallback when caller doesn't pre-compute
    expect(src).toContain("estimateLlmCost(spec, usage)");
    // All four token classes get persisted (default 0 if missing)
    expect(src).toMatch(/usage\.reasoningTokens \?\? 0/);
    expect(src).toMatch(/usage\.cacheReadTokens \?\? 0/);
    expect(src).toMatch(/usage\.cacheWriteTokens \?\? 0/);
  });

  it("recordAudioUsage writes a 'tts' row with audio_chars + voice", async () => {
    const src = await read("src/worker/db/queries.ts");
    expect(src).toMatch(/export async function recordAudioUsage/);
    expect(src).toMatch(/INSERT INTO usage_events[\s\S]{0,400}'tts'/);
    expect(src).toContain("audio_chars");
    expect(src).toContain("voice");
  });

  it("monthly spend rollups query usage_events broken down by provider + modality", async () => {
    const src = await read("src/worker/db/queries.ts");
    expect(src).toMatch(/getMonthlySpendByProvider[\s\S]{0,300}FROM usage_events/);
    expect(src).toMatch(/getMonthlySpendByModality[\s\S]{0,300}FROM usage_events/);
    expect(src).toMatch(/GROUP BY provider/);
    expect(src).toMatch(/GROUP BY modality/);
  });

  it("services pass a ModelSpec (not a string id) into recordTokenUsage", async () => {
    // Spot-check representative services that record LLM usage.
    const checks = [
      "src/worker/services/concept-extractor.ts",
      "src/worker/services/teaching-generator.ts",
      "src/worker/services/quiz-assessor.ts",
      "src/worker/services/continuation-classifier.ts",
      "src/worker/services/adjacent-scanner.ts",
    ];
    for (const path of checks) {
      const src = await read(path);
      if (src.includes("recordTokenUsage")) {
        // Every recorded call should carry a spec object — we accept
        // either `spec` or `<name>Spec` as the local variable name.
        expect(src, `${path} should record usage with a ModelSpec`).toMatch(
          /recordTokenUsage\([\s\S]{0,200}[Ss]pec[,)]/,
        );
      }
    }
  });
});

describe("TTS adapter pattern", () => {
  it("dispatcher registers Cloudflare, OpenAI, and ElevenLabs adapters", async () => {
    const src = await read("src/worker/integrations/tts/dispatcher.ts");
    expect(src).toMatch(/new CloudflareTtsAdapter\(\)/);
    expect(src).toMatch(/new OpenAITtsAdapter\(\)/);
    expect(src).toMatch(/new ElevenLabsTtsAdapter\(\)/);
    expect(src).toMatch(/export function ttsAdapterFor/);
    expect(src).toMatch(/export function isProviderConfigured/);
  });

  it("isProviderConfigured delegates to each adapter's isConfigured(env)", async () => {
    const dispatcher = await read("src/worker/integrations/tts/dispatcher.ts");
    expect(dispatcher).toContain("adapter.isConfigured(env)");
    // Each adapter exposes its own gate so the dispatcher stays generic
    const openai = await read("src/worker/integrations/tts/openai-adapter.ts");
    expect(openai).toContain("isConfigured(");
    expect(openai).toContain("OPENAI_API_KEY");
    const eleven = await read("src/worker/integrations/tts/elevenlabs-adapter.ts");
    expect(eleven).toContain("isConfigured(");
    expect(eleven).toContain("ELEVENLABS_API_KEY");
    // Cloudflare doesn't need a key — its adapter returns true regardless
    const cf = await read("src/worker/integrations/tts/cloudflare-adapter.ts");
    expect(cf).toContain("isConfigured(");
  });

  it("TTS_MODELS catalog exposes ElevenLabs entries with char-billed pricing", async () => {
    const src = await read("src/worker/config/constants.ts");
    expect(src).toContain("eleven_multilingual_v2");
    expect(src).toContain("eleven_turbo_v2_5");
    expect(src).toContain("eleven_flash_v2_5");
    expect(src).toMatch(/provider:\s*"elevenlabs"/);
    // Char-billed pricing field present on every TTS entry — `costPer1kChars`
    // is the column the Voice picker, audio-recording flow, and analytics
    // ledger all read from.
    expect(src).toContain("costPer1kChars");
    // The TtsProvider union now includes elevenlabs
    expect(src).toMatch(/TtsProvider\s*=\s*"cloudflare"\s*\|\s*"openai"\s*\|\s*"elevenlabs"/);
  });

  it("services/tts.ts is a thin dispatcher wrapper that records audio usage", async () => {
    const src = await read("src/worker/services/tts.ts");
    expect(src).toContain("ttsAdapterFor");
    expect(src).toContain("chunkText");
    expect(src).toContain("recordAudioUsage");
    // Audio usage recording is hung off ctx.waitUntil so the user
    // doesn't pay for it in their request latency
    expect(src).toMatch(/waitUntil/);
  });

  it("/api/tts-models filters by configured provider keys", async () => {
    const src = await read("src/worker/routes/models.ts");
    // Voices for paid providers only show up when their key is set
    expect(src).toContain("OPENAI_API_KEY");
    expect(src).toContain("ELEVENLABS_API_KEY");
    expect(src).toMatch(/TTS_MODELS\.filter/);
  });
});

describe("per-source relevance filter overrides", () => {
  it("UserContext carries sourceFilterOverrides and exposes filterPromptForSource", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toMatch(/sourceFilterOverrides\?:\s*Record<string,\s*string>/);
    // Helper resolves the effective filter prompt for a given source id
    expect(src).toMatch(/settings\.sourceFilterOverrides\?\.\[sourceId\]/);
  });

  it("settings route validates and persists sourceFilterOverrides", async () => {
    const src = await read("src/worker/routes/settings.ts");
    expect(src).toContain("sourceFilterOverrides");
    expect(src).toContain("source_filter_overrides");
    // Reject non-object payloads — we store JSON-encoded objects
    expect(src).toMatch(/sourceFilterOverrides must be a JSON object/);
  });

  it("concept-extractor buckets items by effective filter prompt", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toMatch(/sourceFilterOverrides\?:\s*Record<string,\s*string>/);
    // Build per-filter buckets: items from a source with an override
    // share a bucket, others land in the global-filter bucket
    expect(src).toMatch(/buckets\s*=\s*new Map/);
    expect(src).toMatch(/const override\s*=\s*sourceKey \?\s*overrides\[sourceKey\]/);
    // Each bucket chunks separately at BATCH_SIZE so override prompts
    // don't bleed across batches
    expect(src).toMatch(/bucketBatches/);
    // Per-batch prompts use the bucket's filter, not the global one
    expect(src).toMatch(/buildSystemPrompt\([\s\S]{0,400}bucket\.filter/);
  });

  it("adjacent-scanner buckets feed items by per-instance overrides", async () => {
    const src = await read("src/worker/services/adjacent-scanner.ts");
    expect(src).toMatch(/sourceFilterOverrides\?:\s*Record<string,\s*string>/);
    // FeedItems are stamped with sourceInstanceId so the scorer can
    // look up the override that applies (per-instance, not just per-provider)
    expect(src).toContain("sourceInstanceId: src.id");
    expect(src).toMatch(/item\.sourceInstanceId \?\s*overrides\[item\.sourceInstanceId\]/);
    expect(src).toMatch(/buckets\s*=\s*new Map/);
  });

  it("briefing-generator passes sourceFilterOverrides through to extractors and scanners", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // Both pipeline stages receive the user-configured overrides
    const occurrences = src.match(/sourceFilterOverrides:\s*userSettings\?\.sourceFilterOverrides/g);
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("FilterPanel flattens singleton + multi-instance sources into per-source override rows", async () => {
    const src = await read("src/frontend/components/settings/panels/FilterPanel.tsx");
    // OverrideRow flattens each configured source (incl. each
    // individual feed instance) into its own row
    expect(src).toMatch(/OverrideRow/);
    // Multi-instance feeds expand into one row per enabled instance
    expect(src).toMatch(/instances/);
  });
});

describe("async baseline calibration", () => {
  it("POST /api/quiz/baseline/prepare exists and uses the baseline_calibration kind", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Either the legacy single-router (`quizRoutes`) or the post-split
    // per-surface router (`quizBaselineRoutes`).
    expect(src).toMatch(/(quizRoutes|quizBaselineRoutes)\.post\("\/quiz\/baseline\/prepare"/);
    expect(src).toMatch(/BASELINE_NOTIFICATION_KIND\s*=\s*"baseline_calibration"/);
  });

  it("prepare endpoint is idempotent on in-flight runs", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/hasInFlightBaselinePrep/);
    // Re-clicking while a row is in flight returns "in_progress"
    // without spawning a duplicate notification
    expect(src).toMatch(/status:\s*"in_progress"/);
  });

  it("prepare endpoint runs generation under ctx.waitUntil so the user can navigate away", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/c\.executionCtx\.waitUntil/);
    // On success the notification flips to ready with /calibrate as the action url
    expect(src).toMatch(/actionUrl:\s*"\/calibrate"/);
    expect(src).toMatch(/transitionNotification\([\s\S]{0,200}status:\s*"ready"/);
  });

  it("GET /api/quiz/baseline short-circuits with { generating: true } while a prep is in flight", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(/generating:\s*true/);
    // The same idempotency helper is what gates the GET path
    expect(src).toMatch(/hasInFlightBaselinePrep[\s\S]{0,400}generating:\s*true/);
  });

  it("StartCalibrationButton wires the prepare endpoint", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toContain("/api/quiz/baseline/prepare");
    // Surfaces the in-progress state so the user knows the work is
    // continuing on the server even after they navigate away
    expect(src).toMatch(/prepar(ed|ing|ation)/i);
    // On `status: "ready"` it navigates straight to /calibrate
    expect(src).toMatch(/navigate\(\s*["']\/calibrate["']\s*\)/);
  });
});

describe("About / Focus saves do NOT require a free-text 'why' note", () => {
  // We previously asked the user for a free-text "why this change?" /
  // "what changed?" note on every save, and rejected empty notes
  // server-side. That was friction with no real payoff: the version
  // history modal already surfaces the textual diff between
  // consecutive versions, which is what users actually scan history
  // for. The contract pinned here is the *opposite* of the old one:
  // empty notes are accepted, and no UI input is rendered.

  it("POST /api/me/focus accepts a body with no note", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    // No 400 short-circuit on empty note for /me/focus.
    expect(src).not.toMatch(/note is required — describe why you're updating your focus/);
    // Whatever the client sends (or omits) is normalized to nullable.
    expect(src).toMatch(/const note: string \| null = noteRaw\.length > 0 \? noteRaw : null/);
  });

  it("POST /api/me/about accepts a body with no note", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).not.toMatch(/note is required — describe why you're updating your About statement/);
  });

  it("/me/focus + /me/about still reject a *too-long* note (300 char cap)", async () => {
    // We removed the empty-note 400 but kept the upper bound — a
    // restored-from-version write still needs a sane cap. The cap
    // moved to the shared zod schema (single source of truth used by
    // both `/me/focus` and `/me/about`), so we now pin the schema
    // declaration instead of two separate inline checks in the route.
    const schemaSrc = await readFile(resolve(REPO_ROOT, "src/shared/schemas.ts"), "utf-8");
    expect(schemaSrc).toMatch(/note too long \(max 300 chars\)/);
    expect(schemaSrc).toContain("StatementVersionRequest");
    // Both routes must consume the schema — pin via the import.
    const routesSrc = await readSrc("src/worker/routes/system.ts");
    expect(routesSrc.match(/StatementVersionRequest/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("frontend StatementPanel does not render a 'why this change?' input", async () => {
    const src = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    expect(src).not.toMatch(/Why this change\?/);
    expect(src).not.toMatch(/setNote\(/);
    // Save is gated on dirty + saving only, not on a note value.
    expect(src).toMatch(/canSave = isDirty && !saving/);
    // Wire payload no longer carries a note field.
    expect(src).toMatch(/apiPost\(copy\.endpoint, \{ statement: trimmedDraft \}\)/);
  });

  it("FocusEditor quick-edit modal does not render a 'what changed?' input", async () => {
    const src = await read("src/frontend/components/FocusEditor.tsx");
    expect(src).not.toMatch(/What changed\?/);
    expect(src).not.toMatch(/setNote\(/);
    expect(src).toMatch(/canSave = dirty && !saving/);
    expect(src).toMatch(/apiPost\("\/api\/me\/focus", \{ statement: draft\.trim\(\) \}\)/);
  });
});

describe("enriched briefings list response", () => {
  it("GET /api/briefings returns pieceCount, pieceTitles, topConcepts per briefing", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("pieceCount");
    expect(src).toContain("pieceTitles");
    expect(src).toContain("topConcepts");
  });

  it("ArchivePage renders the thematic summary block from those fields", async () => {
    const src = await read("src/frontend/pages/ArchivePage.tsx");
    expect(src).toContain("pieceCount");
    expect(src).toMatch(/pieceTitles/);
    expect(src).toMatch(/topConcepts/);
  });

  it("BriefingListItem type includes the new fields", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toMatch(/pieceCount/);
    expect(src).toMatch(/pieceTitles/);
    expect(src).toMatch(/topConcepts/);
  });
});

describe("ConfirmDialog replaces native confirm()", () => {
  it("ConfirmDialog component exists and is keyboard-accessible", async () => {
    const src = await read("src/frontend/components/ConfirmDialog.tsx");
    expect(src).toContain("export function ConfirmDialog");
    // Standard a11y bits: role, aria-modal, escape-to-close
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/Escape/);
  });

  it("FeedsPanel uses ConfirmDialog and does not call window.confirm", async () => {
    const src = await read("src/frontend/components/settings/panels/FeedsPanel.tsx");
    expect(src).toContain("import { ConfirmDialog }");
    expect(src).toContain("<ConfirmDialog");
    expect(src).not.toMatch(/window\.confirm\s*\(/);
    // No raw confirm() either (some bundlers polyfill it as a global)
    expect(src).not.toMatch(/[^\w]confirm\s*\(/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Provider-aware UI (env-key gating + optgroup grouping)
// ────────────────────────────────────────────────────────────────────

// Minimal Env stub that satisfies the dispatcher's lookups. The
// dispatcher only reads `ANTHROPIC_API_KEY` (today); other fields
// have to exist on the type but aren't read in these unit tests.
const STUB_ENV_BASE: Env = {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub for unit tests
  DB: undefined as any,
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub for unit tests
  AI: undefined as any,
  ANTHROPIC_API_KEY: "",
  LINEAR_API_KEY: "",
  SLACK_TOKEN: "",
  INCIDENT_IO_API_KEY: "",
  BUDGET_CAP_MONTHLY: "35",
  RETENTION_DAYS: "365",
  NEAR_MISS_RETENTION_DAYS: "30",
  RELEVANCE_THRESHOLD: "0.4",
  NEAR_MISS_FLOOR: "0.25",
};

describe("LLM dispatcher — isProviderConfigured / getConfiguredProviders", () => {
  it("returns true for anthropic when ANTHROPIC_API_KEY is set", () => {
    const env = { ...STUB_ENV_BASE, ANTHROPIC_API_KEY: "sk-ant-test" };
    expect(isProviderConfigured("anthropic", env)).toBe(true);
  });

  it("returns false for anthropic when the key is missing / empty", () => {
    const env = { ...STUB_ENV_BASE, ANTHROPIC_API_KEY: "" };
    expect(isProviderConfigured("anthropic", env)).toBe(false);
  });

  it("returns true for openai only when OPENAI_API_KEY is set", () => {
    expect(
      isProviderConfigured("openai", { ...STUB_ENV_BASE, OPENAI_API_KEY: "sk-test" }),
    ).toBe(true);
    expect(isProviderConfigured("openai", { ...STUB_ENV_BASE })).toBe(false);
  });

  it("returns false for unregistered providers regardless of any env var", () => {
    // Google / Workers AI / OpenRouter don't have adapters yet —
    // the predicate must NOT leak them into the picker even if a
    // future env var were set somewhere. Adapter registration is
    // the gate, env keys are the second gate.
    const env = { ...STUB_ENV_BASE, ANTHROPIC_API_KEY: "sk-ant-test" };
    expect(isProviderConfigured("google", env)).toBe(false);
    expect(isProviderConfigured("workers-ai", env)).toBe(false);
    expect(isProviderConfigured("openrouter", env)).toBe(false);
    expect(isProviderConfigured("nonexistent", env)).toBe(false);
  });

  it("getConfiguredProviders returns only the providers whose env keys are set, in registration order", () => {
    // Anthropic is registered first, OpenAI second. The order of
    // the returned list mirrors that so the settings UI's optgroup
    // ordering is deterministic.
    expect(
      getConfiguredProviders({ ...STUB_ENV_BASE, ANTHROPIC_API_KEY: "sk-ant" }),
    ).toEqual(["anthropic"]);
    expect(
      getConfiguredProviders({ ...STUB_ENV_BASE, OPENAI_API_KEY: "sk-oai" }),
    ).toEqual(["openai"]);
    expect(
      getConfiguredProviders({
        ...STUB_ENV_BASE,
        ANTHROPIC_API_KEY: "sk-ant",
        OPENAI_API_KEY: "sk-oai",
      }),
    ).toEqual(["anthropic", "openai"]);
    expect(getConfiguredProviders({ ...STUB_ENV_BASE })).toEqual([]);
  });

  it("DispatchingLLMClient throws a clear error when the provider is unregistered", async () => {
    const env = { ...STUB_ENV_BASE, ANTHROPIC_API_KEY: "sk-ant-test" };
    const client = llmClient(env);
    await expect(
      client.createMessage({
        spec: { provider: "google", model: "gemini-2.5-pro" },
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/LLM provider not yet supported/);
  });

  it("DispatchingLLMClient throws a key-specific error when the env key is missing", async () => {
    const env = { ...STUB_ENV_BASE, ANTHROPIC_API_KEY: "" };
    const client = llmClient(env);
    await expect(
      client.createMessage({
        spec: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/API key not configured/);
    // Same contract for OpenAI when its key is missing.
    await expect(
      client.createMessage({
        spec: { provider: "openai", model: "gpt-5" },
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/API key not configured/);
  });
});

describe("OpenAI adapter (LLMClient implementation)", () => {
  it("declares the right module exports + base URL", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    expect(src).toMatch(/export class OpenAIAdapter\b[\s\S]{0,80}implements LLMClient/);
    expect(src).toContain("api.openai.com/v1");
    // Bearer auth (NOT x-api-key — that's Anthropic's header)
    expect(src).toMatch(/Authorization:\s*`Bearer \$\{this\.apiKey\}`/);
  });

  it("uses the new max_completion_tokens shape (not legacy max_tokens)", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    expect(src).toContain("max_completion_tokens");
    // The legacy `max_tokens` key should not appear in the request
    // body — newer GPT-5 / o-series models reject it.
    expect(src).not.toMatch(/body\.max_tokens\s*=/);
  });

  it("attaches reasoning_effort only when the spec requests it (no temperature override on reasoning)", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    expect(src).toMatch(/reasoning_effort/);
    expect(src).toMatch(/spec\.reasoning\?\.effort/);
    // Reasoning models reject custom temperature, so the adapter
    // mustn't set both at once. Verify the if/else branch shape.
    expect(src).toMatch(/if \(effort\)[\s\S]{0,300}else if \(typeof spec\.temperature === "number"\)/);
  });

  it("normalizes usage by splitting reasoning tokens out of completion tokens", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    // OpenAI's `completion_tokens` already includes reasoning. To
    // match the normalized convention (output / reasoning are
    // sibling buckets) the adapter subtracts.
    expect(src).toMatch(
      /outputTokens:\s*Math\.max\(0,\s*completion - reasoning\)/,
    );
    expect(src).toMatch(
      /cacheReadTokens:\s*usage\.prompt_tokens_details\?\.cached_tokens/,
    );
    // OpenAI doesn't bill cache writes separately, so the field
    // should NOT be set — leaving it undefined so estimateLlmCost
    // skips that bucket.
    expect(src).not.toMatch(/cacheWriteTokens:/);
  });

  it("unfolds tool_result blocks into role:tool messages (OpenAI shape)", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    expect(src).toMatch(/role:\s*"tool"/);
    expect(src).toContain("tool_call_id");
    // Assistant tool_use blocks become OpenAI's `tool_calls` array
    expect(src).toMatch(/tool_calls\s*=\s*toolCalls/);
  });

  it("includes stream_options.include_usage so streamed calls report token counts", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    // Accept either the object-literal form (`stream_options: {...}`)
    // or the property-assignment form (`body.stream_options = {...}`)
    // — both produce the same wire shape.
    expect(src).toMatch(/stream_options\s*[:=]\s*\{\s*include_usage:\s*true/);
  });

  it("uses native response_format json_object on generateJson (no markdown-fence recovery needed)", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    expect(src).toMatch(/response_format:\s*\{\s*type:\s*"json_object"/);
  });

  it("inherits the 120s LLM timeout from the shared constant", async () => {
    const src = await read("src/worker/integrations/llm/openai-adapter.ts");
    expect(src).toContain("LLM_REQUEST_TIMEOUT_MS");
    expect(src).not.toContain("ANTHROPIC_REQUEST_TIMEOUT_MS");
  });

  it("dispatcher routes openai spec.provider to OpenAIAdapter", async () => {
    const src = await read("src/worker/integrations/llm/dispatcher.ts");
    expect(src).toContain("OpenAIAdapter");
    expect(src).toMatch(/provider:\s*"openai"[\s\S]{0,200}env\.OPENAI_API_KEY/);
    expect(src).toMatch(/build:\s*\(env\)\s*=>\s*new OpenAIAdapter/);
  });
});

describe("model catalog — OpenAI entries", () => {
  it("AVAILABLE_MODELS includes GPT-5 nano / mini / full with provider=openai", () => {
    const openaiEntries = AVAILABLE_MODELS.filter((m) => m.provider === "openai");
    expect(openaiEntries.length).toBeGreaterThanOrEqual(3);
    const ids = openaiEntries.map((m) => m.id);
    expect(ids).toContain("gpt-5-nano");
    expect(ids).toContain("gpt-5-mini");
    expect(ids).toContain("gpt-5");
  });

  it("each OpenAI entry declares full pricing + reasoning='effort'", () => {
    const openaiEntries = AVAILABLE_MODELS.filter((m) => m.provider === "openai");
    for (const e of openaiEntries) {
      expect(e.pricing.inputPer1M).toBeGreaterThan(0);
      expect(e.pricing.outputPer1M).toBeGreaterThan(0);
      expect(e.reasoning).toBe("effort");
      expect(e.supportsTools).toBe(true);
      expect(e.contextWindow).toBeGreaterThan(0);
    }
  });

  it("estimateLlmCost honors GPT-5 entries (catalog lookup succeeds)", () => {
    const cost = estimateLlmCost(
      { provider: "openai", model: "gpt-5" },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    );
    // gpt-5 catalog: $1.25 / 1M input, $10 / 1M output
    expect(cost).toBeCloseTo(11.25, 4);
  });
});

describe("/api/models env-key gating", () => {
  it("filters AVAILABLE_MODELS through the LLM dispatcher's isProviderConfigured", async () => {
    const src = await read("src/worker/routes/models.ts");
    // The route must import the LLM-side gate (not just the TTS one).
    expect(src).toMatch(
      /isProviderConfigured[\s\S]{0,200}from\s+"\.\.\/integrations\/llm\/dispatcher\.js"/,
    );
    // And actually use it to filter the catalog before projecting
    // the response shape. The import is aliased to
    // `isLlmProviderConfigured` to disambiguate from the
    // identically-named TTS helper, so the call site reads as
    // `isLlmProviderConfigured(m.provider, c.env)`.
    expect(src).toMatch(
      /AVAILABLE_MODELS\.filter\([\s\S]{0,120}is(Llm)?ProviderConfigured\(m\.provider,\s*c\.env\)/,
    );
  });
});

describe("ProviderGroupedSelect (settings/shared.tsx)", () => {
  it("exists, takes provider order + labels, and renders empty groups as nothing", async () => {
    const src = await read("src/frontend/components/settings/shared.tsx");
    expect(src).toMatch(/export function ProviderGroupedSelect/);
    // Groups are rendered as <optgroup>; empty groups must be
    // null-out (not headerless empty <optgroup>) so absent
    // providers don't leak as orphan headers.
    expect(src).toMatch(/<optgroup key=\{provider\}/);
    expect(src).toMatch(/group\.length === 0\) return null/);
    // Loading state when models is empty (e.g. /api/models still in flight)
    expect(src).toMatch(/loadingLabel/);
  });

  it("ModelsPanel uses ProviderGroupedSelect with the LLM provider order", async () => {
    const src = await read("src/frontend/components/settings/panels/ModelsPanel.tsx");
    expect(src).toContain("ProviderGroupedSelect");
    // The provider order constant lists every ProviderId so the
    // optgroup ordering is stable as new adapters land.
    expect(src).toMatch(/PROVIDER_ORDER\s*=\s*\[\s*"anthropic"/);
    expect(src).toContain('"openai"');
    expect(src).toContain('"google"');
    // Header description loosens "Claude model" to a provider-
    // agnostic phrasing — Sonnet, GPT-5, and Gemini all sit under
    // the same picker.
    expect(src).not.toMatch(/Claude model/);
    expect(src).toMatch(/Pick which model/);
  });

  it("VoicePanel uses ProviderGroupedSelect — the duplicated grouping logic is gone", async () => {
    const src = await read("src/frontend/components/settings/panels/VoicePanel.tsx");
    expect(src).toContain("ProviderGroupedSelect");
    // The old hand-rolled `["cloudflare", "openai", "elevenlabs"].map`
    // pattern should be gone; the panel just wraps the shared
    // component now.
    expect(src).not.toMatch(/\["cloudflare",\s*"openai",\s*"elevenlabs"\]\.map/);
    // Cloudflare still lists first (no API key needed)
    expect(src).toMatch(/PROVIDER_ORDER\s*=\s*\[\s*"cloudflare"/);
  });

  it("ChatPanel groups its model picker by provider with the same order as Settings", async () => {
    const src = await read("src/frontend/components/ChatPanel.tsx");
    // Provider order constant mirrors the Settings → AI models
    // picker so the user sees a consistent grouping across both
    // surfaces.
    expect(src).toMatch(/CHAT_PROVIDER_ORDER\s*=\s*\[\s*"anthropic"/);
    expect(src).toContain('"openai"');
    // Custom popover (not a <select>) so we group inline rather
    // than via ProviderGroupedSelect — but still skip empty groups
    // so absent providers don't leave orphan headers.
    expect(src).toMatch(/group\.length === 0\) return null/);
    // Group header label comes from the same map shape used by
    // ModelsPanel / VoicePanel.
    expect(src).toMatch(/CHAT_PROVIDER_LABELS\[provider\]/);
  });
});
