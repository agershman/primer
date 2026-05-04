import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../src/worker/sources/registry";
import type { SourceProvider, SourceFetchContext, SourceFetchResult, SourceContext } from "../../src/worker/sources/types";
import type { Env } from "../../src/worker/types";

function makeProvider(overrides: Partial<SourceProvider> = {}): SourceProvider {
  return {
    id: "test",
    name: "Test",
    requiredEnv: [],
    multiInstance: false,
    isAvailable: () => true,
    isConfigured: () => true,
    fetch: async () => ({ items: [], details: [] }),
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    ANTHROPIC_API_KEY: "sk-xxx",
    LINEAR_API_KEY: "lin_xxx",
    SLACK_TOKEN: "xoxp-xxx",
    INCIDENT_IO_API_KEY: "inc-xxx",
    BUDGET_CAP_MONTHLY: "35",
    RETENTION_DAYS: "365",
    NEAR_MISS_RETENTION_DAYS: "30",
    RELEVANCE_THRESHOLD: "0.4",
    NEAR_MISS_FLOOR: "0.25",
    ...overrides,
  };
}

describe("SourceRegistry", () => {
  it("registers and retrieves a provider by id", () => {
    const registry = new SourceRegistry();
    const provider = makeProvider({ id: "my_source" });
    registry.register(provider);
    expect(registry.get("my_source")).toBe(provider);
  });

  it("throws on duplicate registration", () => {
    const registry = new SourceRegistry();
    registry.register(makeProvider({ id: "dupe" }));
    expect(() => registry.register(makeProvider({ id: "dupe" }))).toThrow(
      /already registered/,
    );
  });

  it("returns undefined for unregistered id", () => {
    const registry = new SourceRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("getAll returns all registered providers", () => {
    const registry = new SourceRegistry();
    registry.register(makeProvider({ id: "a" }));
    registry.register(makeProvider({ id: "b" }));
    expect(registry.getAll()).toHaveLength(2);
  });

  it("getAvailable filters by isAvailable", () => {
    const registry = new SourceRegistry();
    registry.register(makeProvider({ id: "avail", isAvailable: () => true }));
    registry.register(makeProvider({ id: "unavail", isAvailable: () => false }));

    const env = makeEnv();
    expect(registry.getAvailable(env)).toHaveLength(1);
    expect(registry.getAvailable(env)[0].id).toBe("avail");
  });

  it("getSingletons excludes multiInstance providers", () => {
    const registry = new SourceRegistry();
    registry.register(makeProvider({ id: "single", multiInstance: false }));
    registry.register(makeProvider({ id: "multi", multiInstance: true }));

    const env = makeEnv();
    const singletons = registry.getSingletons(env);
    expect(singletons).toHaveLength(1);
    expect(singletons[0].id).toBe("single");
  });

  it("getMultiInstance excludes singleton providers", () => {
    const registry = new SourceRegistry();
    registry.register(makeProvider({ id: "single", multiInstance: false }));
    registry.register(makeProvider({ id: "multi", multiInstance: true }));

    const env = makeEnv();
    const multis = registry.getMultiInstance(env);
    expect(multis).toHaveLength(1);
    expect(multis[0].id).toBe("multi");
  });

  it("hasProvider checks existence", () => {
    const registry = new SourceRegistry();
    registry.register(makeProvider({ id: "exists" }));
    expect(registry.hasProvider("exists")).toBe(true);
    expect(registry.hasProvider("nope")).toBe(false);
  });
});

describe("built-in provider availability", () => {
  it("linear requires LINEAR_API_KEY", async () => {
    const { linearProvider } = await import("../../src/worker/sources/linear");
    expect(linearProvider.isAvailable(makeEnv())).toBe(true);
    expect(linearProvider.isAvailable(makeEnv({ LINEAR_API_KEY: "" }))).toBe(false);
  });

  it("incident_io requires INCIDENT_IO_API_KEY", async () => {
    const { incidentIoProvider } = await import("../../src/worker/sources/incident-io");
    expect(incidentIoProvider.isAvailable(makeEnv())).toBe(true);
    expect(incidentIoProvider.isAvailable(makeEnv({ INCIDENT_IO_API_KEY: "" }))).toBe(false);
  });

  it("github requires GITHUB_TOKEN", async () => {
    const { githubProvider } = await import("../../src/worker/sources/github");
    expect(githubProvider.isAvailable(makeEnv({ GITHUB_TOKEN: "ghp_xxx" }))).toBe(true);
    expect(githubProvider.isAvailable(makeEnv({ GITHUB_TOKEN: undefined }))).toBe(false);
  });

  it("slack requires SLACK_TOKEN", async () => {
    const { slackProvider } = await import("../../src/worker/sources/slack");
    expect(slackProvider.isAvailable(makeEnv())).toBe(true);
    expect(slackProvider.isAvailable(makeEnv({ SLACK_TOKEN: "" }))).toBe(false);
  });

  it("multi-instance providers (hn, rss, arxiv) are always available", async () => {
    const { hnProvider } = await import("../../src/worker/sources/hn");
    const { rssProvider } = await import("../../src/worker/sources/rss");
    const { arxivProvider } = await import("../../src/worker/sources/arxiv");

    const env = makeEnv();
    expect(hnProvider.isAvailable(env)).toBe(true);
    expect(rssProvider.isAvailable(env)).toBe(true);
    expect(arxivProvider.isAvailable(env)).toBe(true);
    expect(hnProvider.multiInstance).toBe(true);
    expect(rssProvider.multiInstance).toBe(true);
    expect(arxivProvider.multiInstance).toBe(true);
  });
});

describe("settings manifests", () => {
  it("all built-in providers declare a settingsManifest", async () => {
    const { sourceRegistry } = await import("../../src/worker/sources/index");
    for (const provider of sourceRegistry.getAll()) {
      expect(provider.settingsManifest, `${provider.id} missing settingsManifest`).toBeDefined();
      expect(provider.settingsManifest!.nav.label).toBeTruthy();
      expect(provider.settingsManifest!.nav.icon).toBeTruthy();
    }
  });

  it("the global registry has all 7 providers", async () => {
    const { sourceRegistry } = await import("../../src/worker/sources/index");
    const ids = sourceRegistry.getAll().map((p) => p.id).sort();
    expect(ids).toEqual(["arxiv", "github", "hn", "incident_io", "linear", "rss", "slack"]);
  });
});
