import type { FeedItem } from "../integrations/feeds.js";
import type { LLMClient } from "../integrations/llm/types.js";
import type { Env, UserSettings } from "../types.js";

export interface WorkContextItem {
  type: string;
  id: string;
  title: string;
  url?: string;
  description?: string;
  labels?: string[];
  dueAt?: string | null;
  dueReason?: string | null;
}

export interface SourceInstanceRow {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface SourceContext {
  env: Env;
  db: D1Database;
  userId: string;
  /**
   * Primary email for the Primer user. Source providers use this when
   * they need to resolve the Primer user → some external-system user
   * (e.g. Slack's `users.lookupByEmail` for the cross-channel bookmark
   * scan). Always populated at the call sites that build the context.
   */
  userEmail: string;
  userSettings: UserSettings;
  sourceConfig: Record<string, unknown>;
}

export interface SourceFetchContext extends SourceContext {
  llm: LLMClient;
  /** For multi-instance providers, the DB row being fetched. */
  instanceRow?: SourceInstanceRow;
}

export interface SourceFetchResult {
  items: WorkContextItem[] | FeedItem[];
  details: string[];
  error?: string;
}

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

export interface SourceProvider {
  id: string;
  name: string;

  requiredEnv: string[];
  optionalEnv?: string[];

  multiInstance: boolean;

  isAvailable(env: Env): boolean;
  isConfigured(ctx: SourceContext): boolean;

  fetch(ctx: SourceFetchContext): Promise<SourceFetchResult>;

  getSettingsMetadata?(ctx: SourceContext): Promise<unknown>;

  settingsManifest?: SettingsManifest;

  /** Per-user preference fields. Sources that declare userFields
   *  appear in the user's Settings panel. The fields are stored in
   *  `user_settings.source_config.<providerId>`. */
  userFields?: SettingsFieldType[];
}
