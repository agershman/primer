import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, PanelHeader, ProviderGroupedSelect } from "../shared";

// Provider order for the TTS picker. Cloudflare always renders
// first because its voices ship with the Workers AI binding (no
// key needed); paid providers follow in registration order.
const PROVIDER_ORDER = ["cloudflare", "openai", "elevenlabs"] as const;

const PROVIDER_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare Workers AI",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
};

// Strip provider prefixes from voice labels so the optgroup header
// carries the brand and the option text reads as the voice name —
// "Asteria (premium)" instead of "Aura — Asteria (premium)".
const PREFIX_STRIPPER = /^(Aura — |OpenAI tts-1(-hd)? — |ElevenLabs (Multilingual|Turbo|Flash) — )/;

const renderVoiceLabel = (m: { label: string; tier?: string }) =>
  `${m.label.replace(PREFIX_STRIPPER, "")}${m.tier ? ` (${m.tier})` : ""}`;

/**
 * Per-operation TTS rows — mirrors `ModelsPanel`'s per-operation LLM
 * picks. Each surface in Primer that synthesizes speech (teaching
 * pieces, deep dives, chat replies) can carry its own voice via a
 * sibling key under `signalSurfaceMap.models`. Leave a row on "Use
 * default voice" to fall back to the global `ttsModel`.
 *
 * Keys are kept in lockstep with `worker/services/tts.ts ⇒
 * TTS_OPERATION_SETTINGS_KEY`.
 */
const TTS_OPERATIONS: Array<{ key: string; label: string; desc: string }> = [
  {
    key: "ttsModelTeachingPiece",
    label: "Teaching pieces",
    desc: "Briefing pieces' Listen audio",
  },
  {
    key: "ttsModelDeepDive",
    label: "Deep dives",
    desc: "Extended drill-down content",
  },
  {
    key: "ttsModelChat",
    label: "Chat replies",
    desc: "Listen on assistant chat messages",
  },
];

const USE_DEFAULT = "__use_default__";

export function VoicePanel() {
  const { settings, ttsModels } = useSettingsCtx();
  const { settings: data, updateSettings } = settings;
  if (!data) return null;

  // `null` here means "user picked Use default" — stored verbatim so
  // the worker's `resolveTtsModel` falls through to the global voice
  // via its `??` chain.
  const models = (data.signalSurfaceMap?.models ?? {}) as Record<string, string | null>;
  const globalVoice = models.ttsModel ?? "aura-asteria";
  const globalMeta = ttsModels.find((m) => m.id === globalVoice);

  const updateModels = (partial: Record<string, string | null>) => {
    // `null` is the "clear this override" sentinel. The worker's
    // `deepMerge` writes null through verbatim, and `resolveTtsModel`
    // treats null as "no override" via its `??` chain (null falls
    // through to the global `ttsModel`). We can't just omit the key
    // because deepMerge keeps existing values for missing source keys.
    updateSettings({
      signalSurfaceMap: {
        ...data.signalSurfaceMap,
        models: { ...models, ...partial } as Record<string, string>,
      },
    });
  };

  return (
    <div>
      <PanelHeader
        title="Voice"
        description="Text-to-speech configuration for Listen mode. Set a default voice plus optional per-surface overrides — different voices for teaching pieces vs. deep dives vs. chat replies."
      />

      <Field
        label="Default voice"
        hint={
          globalMeta
            ? `${globalMeta.description} · $${globalMeta.costPer1kChars.toFixed(4)}/1k chars. Used everywhere unless you override below.`
            : "Used everywhere unless you override below."
        }
      >
        <Card>
          <ProviderGroupedSelect
            models={ttsModels}
            value={globalVoice}
            onChange={(id) => updateModels({ ttsModel: id })}
            providerOrder={PROVIDER_ORDER}
            providerLabels={PROVIDER_LABELS}
            renderLabel={renderVoiceLabel}
          />
        </Card>
      </Field>

      <Field
        label="Per-surface overrides"
        hint="Pick a different voice for any of these surfaces. Leave on 'Use default voice' to inherit the setting above."
      >
        <Card>
          <div className="space-y-2.5">
            {TTS_OPERATIONS.map((op) => {
              const overrideId = models[op.key] ?? null;
              const effectiveId = overrideId ?? globalVoice;
              const effectiveMeta = ttsModels.find((m) => m.id === effectiveId);
              return (
                <div key={op.key} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-text-primary">{op.label}</div>
                    <div className="text-[10px] font-mono text-text-dim truncate">
                      {overrideId
                        ? op.desc
                        : `${op.desc} · using default (${effectiveMeta ? renderVoiceLabel(effectiveMeta) : effectiveId})`}
                    </div>
                  </div>
                  <select
                    value={overrideId ?? USE_DEFAULT}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateModels({ [op.key]: v === USE_DEFAULT ? null : v });
                    }}
                    className="shrink-0 bg-surface border border-border rounded-md px-2 py-1 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors max-w-[260px]"
                  >
                    <option value={USE_DEFAULT}>Use default voice</option>
                    {PROVIDER_ORDER.map((provider) => {
                      const group = ttsModels.filter((m) => m.provider === provider);
                      if (group.length === 0) return null;
                      return (
                        <optgroup key={provider} label={PROVIDER_LABELS[provider] ?? provider}>
                          {group.map((m) => (
                            <option key={m.id} value={m.id}>
                              {renderVoiceLabel(m)}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
              );
            })}
          </div>
        </Card>
      </Field>

      <p className="text-[10px] font-mono text-text-dim leading-relaxed">
        The per-article voice picker on each Listen control overrides this for individual pieces; selecting a voice
        there updates the matching surface's default above so your last pick sticks for that surface.
      </p>
    </div>
  );
}
