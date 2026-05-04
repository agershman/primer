---
name: source-providers
description: >-
  Create or modify source providers that feed data into Primer briefings.
  Covers the full stack: integration client, source provider, registry,
  settings manifest, and optional custom frontend panel. Use when adding
  a new data source, modifying an existing source's filters or behavior,
  or working in src/worker/sources/.
---

# Source Providers

The user wants to create or modify a source provider:

> $ARGUMENTS

## Architecture

Source providers are the abstraction through which all external data enters
Primer. Every source — Linear, Slack, GitHub, incident.io, RSS, HN, ArXiv —
implements the same `SourceProvider` interface and is registered in a central
`SourceRegistry`. The briefing pipeline iterates over registered providers
instead of containing per-source logic.

```
src/worker/
├── integrations/      # HTTP clients / SDK wrappers (unchanged)
│   ├── linear.ts
│   ├── slack.ts
│   ├── github.ts
│   ├── incident-io.ts
│   ├── feeds.ts       # HN, RSS, ArXiv fetchers
│   └── anthropic.ts
├── sources/           # Source provider layer
│   ├── types.ts       # SourceProvider interface, types
│   ├── registry.ts    # SourceRegistry class
│   ├── index.ts       # Registry instance + all registrations
│   ├── linear.ts      # linearProvider
│   ├── slack.ts       # slackProvider
│   ├── github.ts      # githubProvider
│   ├── incident-io.ts # incidentIoProvider
│   ├── hn.ts          # hnProvider
│   ├── rss.ts         # rssProvider — handles RSS 2.0 + Atom 1.0 (auto-detect)
│   └── arxiv.ts       # arxivProvider
└── services/
    ├── briefing-generator.ts  # Iterates sourceRegistry.getSingletons()
    └── adjacent-scanner.ts    # Dispatches via sourceRegistry.get(kind)
```

### Key types

```typescript
interface SourceProvider {
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
}
```

- **Singleton** (`multiInstance: false`): One per deployment, env-key gated.
  Fetched by the briefing generator in parallel. (Linear, Slack, GitHub, incident.io)
- **Multi-instance** (`multiInstance: true`): Many per user, stored as DB rows
  in `source_instances`. Each row is passed to the provider via
  `ctx.instanceRow`. (RSS, HN, ArXiv)
- **Return type** determines pipeline routing: `WorkContextItem[]` feeds
  concept extraction; `FeedItem[]` feeds relevance scoring.

## Decision Tree

1. **Does it need an API key / token?** → Singleton provider, add env key
2. **Is it public (RSS, API without auth)?** → Multi-instance provider, user adds instances via settings
3. **Does it return items from the user's own activity?** → Return `WorkContextItem[]`
4. **Does it return items from the broader world?** → Return `FeedItem[]`
5. **Does the settings panel need custom UI?** → Register a custom panel override

## Facet 1: Integration Client

If the source needs a new HTTP client, create `src/worker/integrations/<source>.ts`.

- Export a client class or standalone functions
- Handle retries using `RETRY_CONFIG` from `config/constants.ts`
- Export typed response interfaces
- See `integrations/incident-io.ts` for a minimal example, `integrations/github.ts` for a fuller one

Skip this facet if reusing an existing integration (e.g. `feeds.ts` for a new RSS-like feed).

## Facet 2: Source Provider

Create `src/worker/sources/<source>.ts`.

```typescript
import type { Env } from "../types.js";
import type { SourceFetchContext, SourceFetchResult, SourceProvider } from "./types.js";

export const myProvider: SourceProvider = {
  id: "my_source",
  name: "My Source",
  requiredEnv: ["MY_SOURCE_API_KEY"],
  multiInstance: false,

  isAvailable(env: Env) {
    return !!env.MY_SOURCE_API_KEY;
  },

  isConfigured() {
    return true;
  },

  async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
    // Fetch data and return WorkContextItem[] or FeedItem[]
    return { items: [], details: [] };
  },

  settingsManifest: {
    nav: { label: "My Source", icon: "plug", group: "Sources" },
    fields: [
      { type: "toggle", key: "includeArchived", label: "Include archived", default: false },
    ],
  },
};
```

### Settings manifest field types

| Type | Renders as | Config value |
|------|-----------|-------------|
| `toggle` | Switch | `boolean` |
| `select` | Dropdown | `string` |
| `number` | Number input | `number` |
| `chips` | Pill buttons (multi-select from fixed options) | `string[]` |
| `multiSelect` | Searchable list (options from metadata endpoint) | `string[]` |
| `readonlyTags` | Non-editable tag list | `string[]` |
| `text` | Text input | `string` |

### Multi-instance providers

For multi-instance providers, `ctx.instanceRow` contains the DB row being fetched:

```typescript
async fetch(ctx: SourceFetchContext): Promise<SourceFetchResult> {
  const row = ctx.instanceRow;
  if (!row?.url) return { items: [], details: [], error: "Missing URL" };
  const cfg = row.config ?? {};
  // Use row.url, cfg.limit, etc.
}
```

## Facet 3: Registration

1. Import and register in `src/worker/sources/index.ts`:

```typescript
import { myProvider } from "./my-source.js";
sourceRegistry.register(myProvider);
```

2. Add new env keys to `Env` in `src/worker/types.ts`:

```typescript
export interface Env {
  // ...existing...
  MY_SOURCE_API_KEY?: string;
}
```

3. Add placeholder to `wrangler.api.example.toml`:

```toml
MY_SOURCE_API_KEY = "<your-api-key>"
```

## Facet 4: Settings UI

### Manifest-driven (default)

If your provider declares a `settingsManifest` with `fields`, a settings panel
renders automatically via `GenericSourcePanel`. No frontend files to edit.

The `GET /api/sources` endpoint returns manifests for all available providers.
The frontend `SettingsModal` uses these to build the nav dynamically.

### Custom panel override

For sources that need bespoke UI (e.g. Slack's `ChannelPicker`), register a
custom panel in `src/frontend/sources/registry.ts`:

```typescript
import { registerCustomPanel } from "./registry.js";
import { SlackPanel } from "../components/settings/SlackPanel.js";

registerCustomPanel("slack", SlackPanel);
```

Custom panels receive the same props as `GenericSourcePanel`.

### Metadata endpoints

When a field needs dynamic options (e.g. a channel list from the Slack API),
declare a `metadata` section in the manifest and add a route:

```typescript
// In the manifest
metadata: {
  channels: {
    endpoint: "/api/slack/channels",
    labelKey: "name",
    valueKey: "id",
  },
},
```

Add the corresponding route in `src/worker/routes/`.

## Facet 5: Tests

- Unit test the provider's `fetch` method: `tests/unit/<source>-provider.test.ts`
- Test with mock env, mock DB, mock integration responses
- If adding a custom route, add a route test
- Verify existing briefing/scanner tests still pass

## End-to-End Checklist

### Adding a new singleton source

| # | File | Action |
|---|------|--------|
| 1 | `src/worker/integrations/<source>.ts` | Create HTTP client (skip if reusing) |
| 2 | `src/worker/sources/<source>.ts` | Implement `SourceProvider` with `settingsManifest` |
| 3 | `src/worker/sources/index.ts` | Import + register |
| 4 | `src/worker/types.ts` | Add env key to `Env` |
| 5 | `wrangler.api.example.toml` | Add env placeholder |
| 6 | `tests/unit/<source>-provider.test.ts` | Unit tests |

### Adding a new multi-instance source

| # | File | Action |
|---|------|--------|
| 1 | `src/worker/integrations/feeds.ts` (or new file) | Add fetcher function |
| 2 | `src/worker/sources/<source>.ts` | Implement `SourceProvider` with `multiInstance: true` |
| 3 | `src/worker/sources/index.ts` | Import + register |
| 4 | `src/worker/db/source-queries.ts` | Update `DEFAULT_FEED_SOURCES` if adding a default |
| 5 | `tests/unit/<source>-provider.test.ts` | Unit tests |

### Modifying an existing source

| Change | What to update |
|--------|---------------|
| Add a filter field | Add to `settingsManifest.fields` + handle in `fetch()` |
| Change what items are returned | Update `fetch()` return type and mapping |
| Add a metadata endpoint | Add route, add to `settingsManifest.metadata` |
| Switch to custom panel | Create panel component, call `registerCustomPanel()` |

## Key Files

| File | Role |
|------|------|
| `src/worker/sources/types.ts` | Interface definitions |
| `src/worker/sources/registry.ts` | `SourceRegistry` class |
| `src/worker/sources/index.ts` | Registry instance + registrations |
| `src/worker/sources/<provider>.ts` | Individual provider implementations |
| `src/worker/integrations/` | HTTP clients (low-level) |
| `src/worker/services/briefing-generator.ts` | Consumes singleton providers |
| `src/worker/services/adjacent-scanner.ts` | Consumes multi-instance providers |
| `src/worker/routes/sources.ts` | `GET /api/sources` — manifests for frontend |
| `src/frontend/sources/` | Frontend registry, types, generic panel |
| `src/frontend/sources/GenericSourcePanel.tsx` | Renders settings from manifest |
