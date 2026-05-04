import { useCallback } from "react";
import type { SettingsFieldType, SettingsManifest } from "./types.js";

/**
 * Generic settings panel rendered for any source whose
 * `settingsManifest.fields` describes its config surface (toggles,
 * selects, chip groups, free-text).
 *
 * All visual styling uses Primer design tokens (`bg-accent`,
 * `bg-surface`, `text-text-dim`, etc.) rather than raw Tailwind
 * palette colours so the panel theme-switches uniformly with the
 * rest of the app and matches the AdminSourcesPage / Settings
 * panel visual vocabulary. Pre-fix it used `bg-zinc-*` /
 * `bg-blue-*` palette classes which broke in light mode.
 */

interface GenericSourcePanelProps {
  sourceId: string;
  manifest: SettingsManifest;
  sourceConfig: Record<string, unknown>;
  onConfigChange: (sourceId: string, patch: Record<string, unknown>) => void;
}

function ToggleField({
  field,
  value,
  onChange,
}: {
  field: Extract<SettingsFieldType, { type: "toggle" }>;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between py-2">
      <span className="text-sm text-text-primary">{field.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
          value ? "bg-accent" : "bg-border"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-bg shadow transition-transform mt-0.5 ${
            value ? "translate-x-4 ml-0.5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

function SelectField({
  field,
  value,
  onChange,
}: {
  field: Extract<SettingsFieldType, { type: "select" }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block py-2">
      <span className="text-sm block mb-1 text-text-primary">{field.label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded bg-surface border border-border-subtle px-2 py-1.5 text-sm text-text-primary"
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChipsField({
  field,
  value,
  onChange,
}: {
  field: Extract<SettingsFieldType, { type: "chips" }>;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (val: string) => {
    onChange(value.includes(val) ? value.filter((v) => v !== val) : [...value, val]);
  };

  return (
    <div className="py-2">
      <span className="text-sm block mb-1.5 text-text-primary">{field.label}</span>
      <div className="flex flex-wrap gap-1.5">
        {field.options.map((opt) => {
          const active = value.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                active ? "bg-accent text-bg" : "bg-surface text-text-dim hover:text-text-primary"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReadonlyTagsField({
  field,
  value,
}: {
  field: Extract<SettingsFieldType, { type: "readonlyTags" }>;
  value: string[];
}) {
  if (!value?.length) return null;
  return (
    <div className="py-2">
      <span className="text-sm block mb-1.5 text-text-primary">{field.label}</span>
      <div className="flex flex-wrap gap-1.5">
        {value.map((tag) => (
          <span key={tag} className="px-2 py-0.5 rounded-full text-xs bg-surface text-text-dim">
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

function TextField({
  field,
  value,
  onChange,
}: {
  field: Extract<SettingsFieldType, { type: "text" }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block py-2">
      <span className="text-sm block mb-1 text-text-primary">{field.label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="w-full rounded bg-surface border border-border-subtle px-2 py-1.5 text-sm text-text-primary"
      />
    </label>
  );
}

function renderField(
  field: SettingsFieldType,
  config: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void,
) {
  const key = field.key;
  switch (field.type) {
    case "toggle":
      return (
        <ToggleField
          key={key}
          field={field}
          value={(config[key] as boolean | undefined) ?? field.default ?? false}
          onChange={(v) => onChange(key, v)}
        />
      );
    case "select":
      return (
        <SelectField
          key={key}
          field={field}
          value={(config[key] as string | undefined) ?? field.default ?? ""}
          onChange={(v) => onChange(key, v)}
        />
      );
    case "chips":
      return (
        <ChipsField
          key={key}
          field={field}
          value={(config[key] as string[] | undefined) ?? []}
          onChange={(v) => onChange(key, v)}
        />
      );
    case "readonlyTags":
      return <ReadonlyTagsField key={key} field={field} value={(config[key] as string[] | undefined) ?? []} />;
    case "text":
      return (
        <TextField
          key={key}
          field={field}
          value={(config[key] as string | undefined) ?? ""}
          onChange={(v) => onChange(key, v)}
        />
      );
    default:
      return null;
  }
}

export function GenericSourcePanel({ sourceId, manifest, sourceConfig, onConfigChange }: GenericSourcePanelProps) {
  const currentConfig = (sourceConfig[sourceId] ?? {}) as Record<string, unknown>;

  const handleChange = useCallback(
    (key: string, value: unknown) => {
      onConfigChange(sourceId, { ...currentConfig, [key]: value });
    },
    [sourceId, currentConfig, onConfigChange],
  );

  return (
    <div className="space-y-1">
      <h3 className="text-lg font-semibold mb-3 text-text-primary">{manifest.nav.label}</h3>
      {manifest.fields?.map((field) => renderField(field, currentConfig, handleChange))}
      {(!manifest.fields || manifest.fields.length === 0) && (
        <p className="text-sm text-text-dim">
          {manifest.nav.label} is automatically configured. No settings to adjust.
        </p>
      )}
    </div>
  );
}
