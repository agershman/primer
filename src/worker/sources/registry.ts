/**
 * Source registry — the abstraction through which all external data
 * enters Primer. Singleton sources (Linear, Slack, GitHub, incident.io)
 * and multi-instance sources (RSS feeds, HN, ArXiv) all implement the
 * same `SourceProvider` interface and register here. The briefing
 * pipeline iterates over `getSingletons()` and `get(kind)` — it never
 * contains per-source logic.
 *
 * Adding a new source? Read `.cursor/skills/source-providers/SKILL.md`
 * BEFORE writing the provider — it has the full architecture
 * (integration client → SourceProvider → registry → settings manifest →
 * optional custom panel), the multi-instance vs singleton distinction,
 * and the test pinning. Diverging silently from the `SourceProvider`
 * shape means the pipeline won't see your source at all even if the
 * integration HTTP client works.
 *
 * @see .cursor/skills/source-providers/SKILL.md — task playbook
 * @see .cursor/rules/source-providers.mdc — auto-surfaces when editing this folder
 * @see dev-docs/architecture.md — the three-registry pattern in context
 */

import type { Env } from "../types.js";
import type { SourceProvider } from "./types.js";

export class SourceRegistry {
  private providers = new Map<string, SourceProvider>();

  register(provider: SourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Source provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): SourceProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): SourceProvider[] {
    return [...this.providers.values()];
  }

  getAvailable(env: Env): SourceProvider[] {
    return this.getAll().filter((p) => p.isAvailable(env));
  }

  getSingletons(env: Env): SourceProvider[] {
    return this.getAvailable(env).filter((p) => !p.multiInstance);
  }

  getMultiInstance(env: Env): SourceProvider[] {
    return this.getAvailable(env).filter((p) => p.multiInstance);
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }
}
