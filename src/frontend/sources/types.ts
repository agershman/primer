export type SettingsFieldType =
  | { type: "toggle"; key: string; label: string; hint?: string; default?: boolean }
  | { type: "select"; key: string; label: string; options: Array<{ value: string; label: string }>; default?: string }
  | { type: "number"; key: string; label: string; min?: number; max?: number; default?: number }
  | { type: "multiSelect"; key: string; label: string; metadataRef: string }
  | { type: "chips"; key: string; label: string; options: Array<{ value: string; label: string }> }
  | { type: "readonlyTags"; key: string; label: string }
  | { type: "text"; key: string; label: string; placeholder?: string };

export interface SettingsManifest {
  nav: {
    label: string;
    icon: string;
    group?: string;
    keywords?: string[];
  };
  fields?: SettingsFieldType[];
  preview?: {
    endpoint: string;
    method?: "GET" | "POST";
  };
  metadata?: Record<
    string,
    {
      endpoint: string;
      labelKey: string;
      valueKey: string;
    }
  >;
}

/**
 * Shape of a single configured instance for a multi-instance provider
 * (e.g. one RSS feed, one ArXiv subject combo). The `/api/sources`
 * response embeds these on the parent provider's `instances` array.
 */
export interface SourceInstance {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SourceDescriptor {
  id: string;
  name: string;
  multiInstance: boolean;
  settingsManifest: SettingsManifest | null;
  /** Short, neutral one-liner describing what this source contributes
   *  — surfaced in the Sources overview panel as helper text under
   *  each toggle. `null` for sources with no description. */
  description?: string | null;
  /** Configured instances for multi-instance providers. `null` for
   *  singletons (Linear, Slack, etc.). Each instance is the unit
   *  users think about (e.g. "CNCF Blog", "Cloudflare Blog") rather
   *  than the umbrella provider ("RSS / Atom Feed"). */
  instances?: SourceInstance[] | null;
}
