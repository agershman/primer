export const ID_PREFIXES = {
  user: "usr_",
  concept: "cpt_",
  conceptRelation: "crl_",
  conceptArtifact: "car_",
  briefing: "brf_",
  teachingPiece: "tp_",
  pieceResource: "pr_",
  quiz: "qz_",
  discoveredItem: "adj_",
  nearMiss: "nm_",
  depthHistory: "dh_",
  gapSnapshot: "gs_",
  tokenUsage: "tu_",
  chatThread: "ct_",
  chatMessage: "cm_",
  briefingTiming: "bt_",
  bookmark: "bm_",
  pieceSeries: "ser_",
  sourceInstance: "ecs_",
  notification: "ntf_",
} as const;

export const DEPTH_SCALE = {
  UNKNOWN: 0,
  AWARE: 1,
  UNDERSTANDS: 2,
  APPLIES: 3,
  TEACHES: 4,
  AUTHORITATIVE: 5,
} as const;

export const DEPTH_LABELS: Record<number, string> = {
  0: "Unknown",
  1: "Aware",
  2: "Understands",
  3: "Applies",
  4: "Teaches",
  5: "Authoritative",
};

export const CONFIDENCE_THRESHOLDS = {
  VERIFIED: 0.7,
  ESTIMATED: 0.4,
} as const;

export const DECAY_RULES = {
  WARN_AFTER_DAYS: 30,
  DECAY_AFTER_DAYS: 60,
  SEVERE_DECAY_AFTER_DAYS: 90,
  DEPTH_DECAY_PER_PERIOD: 0.3,
  CONFIDENCE_DECAY_PER_PERIOD: 0.2,
  FLOOR_IF_CALIBRATED: 1.0,
} as const;

export const FEEDBACK_RULES = {
  POSITIVE_DEPTH_DELTA: 0.2,
  POSITIVE_CONFIDENCE_DELTA: 0.1,
  MAX_DEPTH_BUMP_ABOVE_CURRENT: 1,
} as const;

export const BRIEFING_RULES = {
  MIN_PIECES: 2,
  MAX_PIECES: 4,
  MAX_ADJACENT_PIECES: 1,
  MAX_DECAY_PIECES: 1,
  NO_REPEAT_WITHIN_DAYS: 5,
  // Cap on how many *additional* teaching pieces a same-day refresh
  // appends to an already-generated briefing. Existing pieces are
  // preserved (a focus-statement edit shouldn't retroactively wipe
  // earlier pieces just because the user changed direction); the
  // refresh adds up to this many new pieces shaped by the current
  // focus. Kept small so a chain of refreshes can't grow a briefing
  // without bound.
  MAX_REFRESH_ADDITIONS: 2,
} as const;

export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 3,
  INITIAL_DELAY_MS: 1000,
  BACKOFF_MULTIPLIER: 2,
  JITTER_FACTOR: 0.3,
} as const;

export function retryDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
  const base = RETRY_CONFIG.INITIAL_DELAY_MS * RETRY_CONFIG.BACKOFF_MULTIPLIER ** attempt;
  const jitter = base * RETRY_CONFIG.JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export type TtsProvider = "cloudflare" | "openai" | "elevenlabs";

export interface TtsModel {
  id: string;
  provider: TtsProvider;
  model: string;
  label: string;
  tier: "quality" | "balanced" | "budget";
  speaker: string | null;
  speakers?: string[];
  costPer1kChars: number;
  description: string;
}

export const TTS_MODELS: TtsModel[] = [
  // Cloudflare Workers AI — Deepgram Aura speakers
  {
    id: "aura-asteria",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Asteria",
    tier: "quality",
    speaker: "asteria",
    costPer1kChars: 0.015,
    description: "Friendly female (US)",
  },
  {
    id: "aura-luna",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Luna",
    tier: "quality",
    speaker: "luna",
    costPer1kChars: 0.015,
    description: "Polished female (US)",
  },
  {
    id: "aura-stella",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Stella",
    tier: "quality",
    speaker: "stella",
    costPer1kChars: 0.015,
    description: "Calm female (US)",
  },
  {
    id: "aura-athena",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Athena",
    tier: "quality",
    speaker: "athena",
    costPer1kChars: 0.015,
    description: "Mature female (UK)",
  },
  {
    id: "aura-hera",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Hera",
    tier: "quality",
    speaker: "hera",
    costPer1kChars: 0.015,
    description: "Business female (US)",
  },
  {
    id: "aura-orion",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Orion",
    tier: "quality",
    speaker: "orion",
    costPer1kChars: 0.015,
    description: "Confident male (US)",
  },
  {
    id: "aura-arcas",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Arcas",
    tier: "quality",
    speaker: "arcas",
    costPer1kChars: 0.015,
    description: "Warm male (US)",
  },
  {
    id: "aura-perseus",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Perseus",
    tier: "quality",
    speaker: "perseus",
    costPer1kChars: 0.015,
    description: "Casual male (US)",
  },
  {
    id: "aura-angus",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Angus",
    tier: "quality",
    speaker: "angus",
    costPer1kChars: 0.015,
    description: "Gravelly male (Irish)",
  },
  {
    id: "aura-orpheus",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Orpheus",
    tier: "quality",
    speaker: "orpheus",
    costPer1kChars: 0.015,
    description: "Smooth male (US)",
  },
  {
    id: "aura-helios",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Helios",
    tier: "quality",
    speaker: "helios",
    costPer1kChars: 0.015,
    description: "Upbeat male (UK)",
  },
  {
    id: "aura-zeus",
    provider: "cloudflare",
    model: "@cf/deepgram/aura-1",
    label: "Aura — Zeus",
    tier: "quality",
    speaker: "zeus",
    costPer1kChars: 0.015,
    description: "Deep male (US)",
  },

  // Cloudflare Workers AI — MeloTTS
  {
    id: "melotts",
    provider: "cloudflare",
    model: "@cf/myshell-ai/melotts",
    label: "MeloTTS",
    tier: "budget",
    speaker: null,
    costPer1kChars: 0.0002,
    description: "Open-source budget option",
  },

  // OpenAI TTS — tts-1 standard
  {
    id: "openai-tts-1-alloy",
    provider: "openai",
    model: "tts-1",
    label: "OpenAI tts-1 — Alloy",
    tier: "balanced",
    speaker: "alloy",
    costPer1kChars: 0.015,
    description: "Neutral, balanced",
  },
  {
    id: "openai-tts-1-echo",
    provider: "openai",
    model: "tts-1",
    label: "OpenAI tts-1 — Echo",
    tier: "balanced",
    speaker: "echo",
    costPer1kChars: 0.015,
    description: "Resonant male",
  },
  {
    id: "openai-tts-1-fable",
    provider: "openai",
    model: "tts-1",
    label: "OpenAI tts-1 — Fable",
    tier: "balanced",
    speaker: "fable",
    costPer1kChars: 0.015,
    description: "British, narrator",
  },
  {
    id: "openai-tts-1-onyx",
    provider: "openai",
    model: "tts-1",
    label: "OpenAI tts-1 — Onyx",
    tier: "balanced",
    speaker: "onyx",
    costPer1kChars: 0.015,
    description: "Deep male",
  },
  {
    id: "openai-tts-1-nova",
    provider: "openai",
    model: "tts-1",
    label: "OpenAI tts-1 — Nova",
    tier: "balanced",
    speaker: "nova",
    costPer1kChars: 0.015,
    description: "Bright female",
  },
  {
    id: "openai-tts-1-shimmer",
    provider: "openai",
    model: "tts-1",
    label: "OpenAI tts-1 — Shimmer",
    tier: "balanced",
    speaker: "shimmer",
    costPer1kChars: 0.015,
    description: "Soft female",
  },

  // OpenAI TTS — tts-1-hd high quality
  {
    id: "openai-tts-1-hd-alloy",
    provider: "openai",
    model: "tts-1-hd",
    label: "OpenAI tts-1-hd — Alloy",
    tier: "quality",
    speaker: "alloy",
    costPer1kChars: 0.03,
    description: "Neutral, balanced (HD)",
  },
  {
    id: "openai-tts-1-hd-nova",
    provider: "openai",
    model: "tts-1-hd",
    label: "OpenAI tts-1-hd — Nova",
    tier: "quality",
    speaker: "nova",
    costPer1kChars: 0.03,
    description: "Bright female (HD)",
  },
  {
    id: "openai-tts-1-hd-onyx",
    provider: "openai",
    model: "tts-1-hd",
    label: "OpenAI tts-1-hd — Onyx",
    tier: "quality",
    speaker: "onyx",
    costPer1kChars: 0.03,
    description: "Deep male (HD)",
  },

  // ElevenLabs — multilingual_v2 (highest quality, most expensive).
  // ElevenLabs voice IDs are stable identifiers from the public voice
  // library; speaker names are the human-readable display names.
  // Pricing last verified: 2026-04-27.
  // https://elevenlabs.io/pricing — list rate ~$0.30/1k chars.
  {
    id: "elevenlabs-multilingual-rachel",
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual — Rachel",
    tier: "quality",
    speaker: "21m00Tcm4TlvDq8ikWAM",
    costPer1kChars: 0.3,
    description: "Calm female narrator (US, English)",
  },
  {
    id: "elevenlabs-multilingual-adam",
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual — Adam",
    tier: "quality",
    speaker: "pNInz6obpgDQGcFmaJgB",
    costPer1kChars: 0.3,
    description: "Deep male narrator (US, English)",
  },
  {
    id: "elevenlabs-multilingual-domi",
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual — Domi",
    tier: "quality",
    speaker: "AZnzlk1XvdvUeBnXmlld",
    costPer1kChars: 0.3,
    description: "Strong young female (US, English)",
  },
  {
    id: "elevenlabs-multilingual-antoni",
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual — Antoni",
    tier: "quality",
    speaker: "ErXwobaYiN019PkySvjV",
    costPer1kChars: 0.3,
    description: "Well-rounded male (US, English)",
  },

  // ElevenLabs — turbo_v2_5 (balanced speed/quality, 50% cheaper).
  // Pricing last verified: 2026-04-27. ~$0.15/1k chars.
  {
    id: "elevenlabs-turbo-rachel",
    provider: "elevenlabs",
    model: "eleven_turbo_v2_5",
    label: "ElevenLabs Turbo — Rachel",
    tier: "balanced",
    speaker: "21m00Tcm4TlvDq8ikWAM",
    costPer1kChars: 0.15,
    description: "Faster Rachel (lower latency)",
  },
  {
    id: "elevenlabs-turbo-adam",
    provider: "elevenlabs",
    model: "eleven_turbo_v2_5",
    label: "ElevenLabs Turbo — Adam",
    tier: "balanced",
    speaker: "pNInz6obpgDQGcFmaJgB",
    costPer1kChars: 0.15,
    description: "Faster Adam (lower latency)",
  },

  // ElevenLabs — flash_v2_5 (fastest, cheapest, slightly lower quality).
  // Pricing last verified: 2026-04-27. ~$0.075/1k chars.
  {
    id: "elevenlabs-flash-rachel",
    provider: "elevenlabs",
    model: "eleven_flash_v2_5",
    label: "ElevenLabs Flash — Rachel",
    tier: "budget",
    speaker: "21m00Tcm4TlvDq8ikWAM",
    costPer1kChars: 0.075,
    description: "Lowest-latency Rachel (real-time tier)",
  },
  {
    id: "elevenlabs-flash-adam",
    provider: "elevenlabs",
    model: "eleven_flash_v2_5",
    label: "ElevenLabs Flash — Adam",
    tier: "budget",
    speaker: "pNInz6obpgDQGcFmaJgB",
    costPer1kChars: 0.075,
    description: "Lowest-latency Adam (real-time tier)",
  },
];

export const DEFAULT_TTS_MODEL = "aura-asteria";

// Per-request timeout on LLM HTTP calls. Without this, a hung socket
// can wedge concept extraction (and therefore cancellation) indefinitely.
// The contract is provider-agnostic — every adapter (`AnthropicAdapter`,
// `OpenAIAdapter`, future Google / Workers AI) is expected to honour
// the same 120-second ceiling so cancellation behaviour stays
// consistent across providers.
export const LLM_REQUEST_TIMEOUT_MS = 120_000;
/** @deprecated Use `LLM_REQUEST_TIMEOUT_MS`. Kept as an alias so older
 *  imports keep compiling during the gradual rename. */
export const ANTHROPIC_REQUEST_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;

// How long a briefing can sit in "generating" with no metadata updates before
// the status endpoint considers it a zombie. Generator writes metadata on
// every step transition, so 3 minutes is well beyond any healthy gap.
export const BRIEFING_STUCK_TIMEOUT_MS = 3 * 60_000;

// Continuation classifier configuration.
//
// LOOKBACK: how far back the predecessor search reaches when deciding
// whether a draft continues a prior piece. 30 days is roughly aligned
// with how long a typical reader still remembers a piece they saw.
// Beyond that, a fresh standalone read is friendlier than a callback
// to a piece the user has likely forgotten.
//
// MAX_CANDIDATES: cap on the number of predecessor pieces fed to the
// LLM classifier. Even with strong concept + source overlap, the
// recall-vs-cost tradeoff plateaus quickly. 5 keeps the prompt cheap
// (and bounded) while still handling weeks of overlapping work.
export const CONTINUATION_LOOKBACK_DAYS = 30;
export const MAX_PREDECESSOR_CANDIDATES = 5;
