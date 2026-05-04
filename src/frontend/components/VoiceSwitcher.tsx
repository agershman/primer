import { useEffect, useRef, useState } from "react";
import { dispatchPrimerEvent, onPrimerEvent, primerEventName } from "../lib/events";
import { apiGet, apiPatch } from "../utils/api";

interface TtsVoice {
  id: string;
  label: string;
  /**
   * Provider id from `/api/tts-models`. Includes ElevenLabs alongside
   * the original Cloudflare + OpenAI entries; future providers extend
   * this union without UI changes.
   */
  provider: "cloudflare" | "openai" | "elevenlabs" | string;
  tier: "quality" | "balanced" | "budget";
  description: string;
  costPer1kChars: number;
}

interface TtsModelsResponse {
  models: TtsVoice[];
  default: string;
}

interface SettingsResponse {
  settings: {
    signalSurfaceMap?: {
      models?: Record<string, string | null | undefined>;
    };
  };
}

/** Operation tag — must match `TtsOperation` in `worker/services/tts.ts`. */
export type TtsSurface = "teachingPiece" | "deepDive" | "chat";

const SURFACE_KEY: Record<TtsSurface, string> = {
  teachingPiece: "ttsModelTeachingPiece",
  deepDive: "ttsModelDeepDive",
  chat: "ttsModelChat",
};

// Backwards-compatible string alias. The typed bus
// (`dispatchPrimerEvent("tts-voice-changed", ...)` /
// `onPrimerEvent("tts-voice-changed", ...)`) is the source of truth;
// this re-export keeps any existing raw `addEventListener` callers
// working since the wire-format string didn't change.
export const VOICE_CHANGED_EVENT = primerEventName("tts-voice-changed");

export interface VoiceChangedDetail {
  voiceId: string;
  /**
   * Which surface's default this pick scoped to. `undefined` means the
   * pick scoped to the global `ttsModel` (legacy callers without an
   * operation tag, or the Settings → Voice panel's "Default voice"
   * row). Listeners use this to ignore changes from a different
   * surface — picking a chat voice shouldn't relabel the deep-dive
   * Listen player.
   */
  surface?: TtsSurface;
}

interface VoiceSwitcherProps {
  /** The voice currently driving this article's audio (parent-controlled). */
  currentVoiceId: string | null;
  /** Called when the user picks a new voice. The voice change is also persisted to user settings. */
  onChange: (voiceId: string) => void;
  /** Compact mode collapses to just the change link. */
  compact?: boolean;
  /**
   * Which surface this switcher is sitting on. When set, picking a
   * voice updates that surface's per-operation default
   * (`ttsModel${Surface}`) instead of the global `ttsModel` — so
   * changing the chat voice on the chat panel doesn't override the
   * voice you've set for teaching pieces. When omitted, behaves like
   * the legacy single-default switcher and writes `ttsModel`.
   */
  surface?: TtsSurface;
}

export function VoiceSwitcher({ currentVoiceId, onChange, compact = true, surface }: VoiceSwitcherProps) {
  const [expanded, setExpanded] = useState(false);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    apiGet<TtsModelsResponse>("/api/tts-models")
      .then((data) => {
        setVoices(data.models);
        setDefaultId(data.default);
      })
      .catch(() => {});
  }, []);

  useEffect(
    () =>
      onPrimerEvent("tts-voice-changed", (detail) => {
        // Cross-surface filter: only react to events that match this
        // switcher's surface (or are global, i.e. surface === undefined
        // → applies to the catch-all default and may bubble through).
        if (detail.surface && detail.surface !== surface) return;
        // Refresh local default in case user changed voice elsewhere
        // (e.g. Settings panel or another open switcher of the same
        // surface) — keeps multiple open switchers consistent.
        apiGet<SettingsResponse>("/api/settings")
          .then((data) => {
            const models = data.settings?.signalSurfaceMap?.models ?? {};
            const opKey = surface ? SURFACE_KEY[surface] : null;
            const next = (opKey ? models[opKey] : null) ?? models.ttsModel ?? null;
            if (next) setDefaultId(next);
          })
          .catch(() => {});
      }),
    [surface],
  );

  // Esc closes the inline voice picker. Capture phase + stop-
  // propagation so this handler wins against any parent surface's
  // Esc binding (e.g. ChatPanel's "Esc closes the chat panel"
  // listener) — without that race, pressing Esc to dismiss the
  // voice picker inside chat would accidentally close the chat.
  //
  // The native `<select>` element already collapses its dropdown on
  // Esc but keeps focus on the select itself, so the existing
  // `onBlur` doesn't fire. The user would otherwise be stuck with
  // the picker UI still expanded around a closed dropdown. This
  // listener brings Esc to parity with the inline "cancel" link.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [expanded]);

  const effectiveId = currentVoiceId ?? defaultId;
  const current = voices.find((v) => v.id === effectiveId);

  const handlePick = async (newId: string) => {
    if (!newId || newId === effectiveId) {
      setExpanded(false);
      return;
    }
    setSaving(true);
    try {
      // Persist as new default — scoped to this surface when one is
      // provided, otherwise the global `ttsModel` (legacy single-voice
      // behavior). Last-used wins for the surface.
      const settingsKey = surface ? SURFACE_KEY[surface] : "ttsModel";
      await apiPatch("/api/settings", {
        signalSurfaceMap: { models: { [settingsKey]: newId } },
      });
      setDefaultId(newId);
      onChange(newId);
      dispatchPrimerEvent("tts-voice-changed", { voiceId: newId, surface });
    } catch {
      // best-effort — even if persistence fails, surface the chosen voice to the player so
      // the user still hears their pick this session
      onChange(newId);
    } finally {
      setSaving(false);
      setExpanded(false);
    }
  };

  if (voices.length === 0) {
    return null;
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="inline-flex items-center gap-1.5 font-mono text-[10px] text-text-faint hover:text-accent transition-colors"
        title={
          surface
            ? `Try a different voice for ${surfaceTitle(surface)} — also updates this surface's default`
            : "Try a different voice — also updates your default"
        }
      >
        <span className="hidden sm:inline">voice:</span>
        <span className="text-text-dim">{voiceShortLabel(current)}</span>
        <span aria-hidden="true">↻</span>
        {!compact && <span>change</span>}
      </button>
    );
  }

  const providers = uniqueProviders(voices);

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        autoFocus
        value={effectiveId ?? ""}
        disabled={saving}
        onChange={(e) => handlePick(e.target.value)}
        onBlur={() => setExpanded(false)}
        className="bg-surface border border-border rounded-md px-2 py-1 text-[11px] font-mono text-text-primary outline-none focus:border-accent transition-colors disabled:opacity-50 max-w-[220px]"
      >
        {providers.map((provider) => {
          const group = voices.filter((v) => v.provider === provider);
          if (group.length === 0) return null;
          return (
            <optgroup key={provider} label={providerLabel(provider)}>
              {group.map((v) => (
                <option key={v.id} value={v.id}>
                  {voiceShortLabel(v)} ({v.tier})
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="font-mono text-[10px] text-text-dim hover:text-accent transition-colors"
      >
        cancel
      </button>
    </div>
  );
}

function voiceShortLabel(v: TtsVoice | undefined): string {
  if (!v) return "default";
  return v.label
    .replace(/^Aura — /, "")
    .replace(/^OpenAI tts-1-hd — /, "")
    .replace(/^OpenAI tts-1 — /, "")
    .replace(/^ElevenLabs (Multilingual|Turbo|Flash) — /, "");
}

function providerLabel(p: string): string {
  if (p === "cloudflare") return "Cloudflare";
  if (p === "openai") return "OpenAI";
  if (p === "elevenlabs") return "ElevenLabs";
  return p;
}

function uniqueProviders(voices: TtsVoice[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Stable order: Cloudflare → OpenAI → ElevenLabs → anything else.
  const preferred = ["cloudflare", "openai", "elevenlabs"];
  for (const p of preferred) {
    if (voices.some((v) => v.provider === p)) {
      out.push(p);
      seen.add(p);
    }
  }
  for (const v of voices) {
    if (!seen.has(v.provider)) {
      seen.add(v.provider);
      out.push(v.provider);
    }
  }
  return out;
}

function surfaceTitle(surface: TtsSurface): string {
  switch (surface) {
    case "teachingPiece":
      return "teaching pieces";
    case "deepDive":
      return "deep dives";
    case "chat":
      return "chat replies";
  }
}
