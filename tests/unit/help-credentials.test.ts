/**
 * Tests for the per-integration credential help docs.
 *
 * These docs are the canonical place admins / ops folks go to learn
 * how to set up a Linear / Slack / GitHub / etc. credential and what
 * specific scopes / permissions Primer needs. They're easy to drift
 * from the actual integration code (e.g. someone widens a Slack
 * call from `conversations.history` to `users.list` without
 * updating the doc), so each test pins:
 *
 *   1. The doc exists with the right audience tag.
 *   2. The doc names the env variable Primer reads from.
 *   3. The doc names the specific scopes / permissions / endpoints
 *      that map back to the integration code. If those drift, the
 *      test forces an update.
 *
 * Cross-cutting tests confirm:
 *   - The `credentials` category is wired into the registry and the
 *     index page's descriptions / icons.
 *   - The overview doc lists every integration.
 *   - README + setup.md + admin-overview + ops/deploying-primer all
 *     link out to the credentials section.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("Credentials category is wired into the help registry + index", () => {
  it("appears in CATEGORY_ORDER between admins and developers", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    const orderMatch = src.match(/CATEGORY_ORDER\s*=\s*\[([\s\S]+?)\]/);
    expect(orderMatch).not.toBeNull();
    const orderText = orderMatch![1];
    expect(orderText.indexOf("credentials")).toBeGreaterThan(orderText.indexOf("admins"));
    expect(orderText.indexOf("credentials")).toBeLessThan(orderText.indexOf("developers"));
  });

  it("has a human-readable CATEGORY_LABEL", async () => {
    const src = await read("src/frontend/lib/helpRegistry.ts");
    expect(src).toMatch(/credentials:\s*"Credentials & Permissions"/);
  });

  it("has a description + icon on the Help index page", async () => {
    const src = await read("src/frontend/pages/HelpIndexPage.tsx");
    expect(src).toMatch(/credentials:\s*"[^"]*credential[^"]*"/i);
    expect(src).toMatch(/credentials:\s*"🔑"/);
  });
});

describe("Credentials overview doc", () => {
  it("exists and is tagged for admins + ops", async () => {
    const src = await read("src/frontend/help/credentials/overview.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
  });

  it("names every integration's env variable", async () => {
    const src = await read("src/frontend/help/credentials/overview.md");
    for (const env of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "LINEAR_API_KEY",
      "SLACK_TOKEN",
      "GITHUB_TOKEN",
      "INCIDENT_IO_API_KEY",
      "ELEVENLABS_API_KEY",
    ]) {
      expect(src, `overview should mention ${env}`).toContain(env);
    }
  });

  it("links to every per-integration walkthrough", async () => {
    const src = await read("src/frontend/help/credentials/overview.md");
    for (const slug of [
      "credentials/anthropic",
      "credentials/openai",
      "credentials/linear",
      "credentials/slack",
      "credentials/github",
      "credentials/incident-io",
      "credentials/elevenlabs",
    ]) {
      expect(src, `overview should link to /help/${slug}`).toContain(`/help/${slug}`);
    }
  });

  it("notes Primer is read-only across the board", async () => {
    const src = await read("src/frontend/help/credentials/overview.md");
    expect(src).toMatch(/read-only/i);
    expect(src).toMatch(/Principle of least privilege/);
  });
});

describe("Linear credential doc", () => {
  it("is tagged [admin, ops] and names LINEAR_API_KEY", async () => {
    const src = await read("src/frontend/help/credentials/linear.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("LINEAR_API_KEY");
  });

  it("documents the actual GraphQL surfaces Primer queries", async () => {
    const src = await read("src/frontend/help/credentials/linear.md");
    // These match the operations called via @linear/sdk in
    // worker/integrations/linear.ts.
    expect(src).toMatch(/viewer\.assignedIssues/);
    expect(src).toMatch(/viewer\.subscribedIssues/);
    expect(src).toMatch(/teams/);
    expect(src).toMatch(/comments/);
  });

  it("calls out the personal API key model (no OAuth scope dance)", async () => {
    const src = await read("src/frontend/help/credentials/linear.md");
    expect(src).toMatch(/personal API key/i);
  });
});

describe("Slack credential doc", () => {
  it("is tagged [admin, ops] and names SLACK_TOKEN", async () => {
    const src = await read("src/frontend/help/credentials/slack.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("SLACK_TOKEN");
  });

  it("documents every Slack method Primer calls + the matching scope", async () => {
    const src = await read("src/frontend/help/credentials/slack.md");
    // Methods (must match the surfaces in worker/integrations/slack.ts).
    expect(src).toContain("conversations.list");
    expect(src).toContain("conversations.history");
    expect(src).toContain("conversations.replies");
    expect(src).toContain("team.info");
    // Cross-channel personal-bookmark scan.
    expect(src).toContain("users.lookupByEmail");
    expect(src).toContain("reactions.list");
    // Optional fallback method.
    expect(src).toContain("search.messages");
    // Scopes that map to those methods.
    expect(src).toContain("channels:read");
    expect(src).toContain("channels:history");
    expect(src).toContain("team:read");
    expect(src).toContain("reactions:read");
    expect(src).toContain("users:read.email");
    expect(src).toContain("search:read");
  });

  it("notes the bot vs user token distinction (search:read needs user token)", async () => {
    const src = await read("src/frontend/help/credentials/slack.md");
    expect(src).toMatch(/bot tokens?/i);
    expect(src).toMatch(/user tokens?/i);
    expect(src).toMatch(/invite the bot/i);
  });
});

describe("GitHub credential doc", () => {
  it("is tagged [admin, ops] and names GITHUB_TOKEN", async () => {
    const src = await read("src/frontend/help/credentials/github.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("GITHUB_TOKEN");
  });

  it("documents both classic and fine-grained PATs with their scopes", async () => {
    const src = await read("src/frontend/help/credentials/github.md");
    expect(src).toMatch(/classic PAT/i);
    expect(src).toMatch(/fine-grained PAT/i);
    // Classic scopes Primer needs.
    expect(src).toContain("repo");
    expect(src).toContain("read:org");
    // Fine-grained permissions Primer needs.
    expect(src).toMatch(/Pull requests/);
    expect(src).toMatch(/Issues/);
    expect(src).toMatch(/Members/);
  });

  it("documents the actual REST endpoints Primer hits", async () => {
    const src = await read("src/frontend/help/credentials/github.md");
    expect(src).toContain("/search/issues");
    expect(src).toMatch(/\/repos\/\{owner\}\/\{repo\}\/pulls/);
    expect(src).toMatch(/\/orgs\/\{org\}\/teams/);
    expect(src).toMatch(/\/orgs\/\{org\}\/repos/);
  });
});

describe("incident.io credential doc", () => {
  it("is tagged [admin, ops] and names INCIDENT_IO_API_KEY", async () => {
    const src = await read("src/frontend/help/credentials/incident-io.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("INCIDENT_IO_API_KEY");
  });

  it("calls out the v2 base URL + the read-incidents permission", async () => {
    const src = await read("src/frontend/help/credentials/incident-io.md");
    expect(src).toContain("api.incident.io/v2");
    expect(src).toMatch(/incidents\.read/);
    expect(src).toMatch(/read access/i);
  });
});

describe("Anthropic credential doc", () => {
  it("is tagged [admin, ops] and names ANTHROPIC_API_KEY", async () => {
    const src = await read("src/frontend/help/credentials/anthropic.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("ANTHROPIC_API_KEY");
  });

  it("calls out the actual model IDs Primer uses by default", async () => {
    const src = await read("src/frontend/help/credentials/anthropic.md");
    expect(src).toContain("claude-haiku-4-5-20251001");
    expect(src).toContain("claude-sonnet-4-20250514");
    expect(src).toContain("claude-opus-4-20250514");
  });

  it("notes the messages endpoint + x-api-key header", async () => {
    const src = await read("src/frontend/help/credentials/anthropic.md");
    expect(src).toMatch(/api\.anthropic\.com\/v1\/messages/);
    expect(src).toContain("x-api-key");
  });
});

describe("OpenAI credential doc", () => {
  it("is tagged [admin, ops] and names OPENAI_API_KEY", async () => {
    const src = await read("src/frontend/help/credentials/openai.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("OPENAI_API_KEY");
  });

  it("documents the two surfaces (LLM + TTS) the same key unlocks", async () => {
    const src = await read("src/frontend/help/credentials/openai.md");
    expect(src).toMatch(/Chat completions/);
    expect(src).toMatch(/Text-to-speech/);
    expect(src).toContain("/v1/chat/completions");
    expect(src).toContain("/v1/audio/speech");
  });

  it("documents Restricted-key permissions + GPT-5 model access", async () => {
    const src = await read("src/frontend/help/credentials/openai.md");
    expect(src).toMatch(/Restricted/);
    // Models Primer ships with in the catalog.
    expect(src).toContain("gpt-5");
    expect(src).toContain("gpt-5-mini");
    expect(src).toContain("gpt-5-nano");
  });
});

describe("ElevenLabs credential doc", () => {
  it("is tagged [admin, ops] and names ELEVENLABS_API_KEY", async () => {
    const src = await read("src/frontend/help/credentials/elevenlabs.md");
    expect(src).toMatch(/audiences:\s*\[admin,\s*ops\]/);
    expect(src).toContain("ELEVENLABS_API_KEY");
  });

  it("documents the endpoint shape + the xi-api-key header (not Bearer)", async () => {
    const src = await read("src/frontend/help/credentials/elevenlabs.md");
    expect(src).toContain("xi-api-key");
    expect(src).toContain("/v1/text-to-speech/");
    expect(src).toMatch(/eleven_multilingual_v2/);
    expect(src).toMatch(/eleven_turbo_v2_5/);
    expect(src).toMatch(/eleven_flash_v2_5/);
  });
});

describe("Cross-document links", () => {
  it("setup.md links to the credentials overview + each per-integration doc", async () => {
    const src = await read("src/frontend/help/getting-started/setup.md");
    expect(src).toContain("/help/credentials/overview");
    expect(src).toContain("/help/credentials/linear");
    expect(src).toContain("/help/credentials/slack");
    expect(src).toContain("/help/credentials/github");
    expect(src).toContain("/help/credentials/incident-io");
    expect(src).toContain("/help/credentials/anthropic");
    expect(src).toContain("/help/credentials/openai");
    expect(src).toContain("/help/credentials/elevenlabs");
  });

  it("admin-overview.md links to the credentials overview", async () => {
    const src = await read("src/frontend/help/admins/admin-overview.md");
    expect(src).toContain("/help/credentials/overview");
  });

  it("ops/deploying-primer.md links to the credentials overview + each per-integration doc", async () => {
    const src = await read("src/frontend/help/ops/deploying-primer.md");
    expect(src).toContain("/help/credentials/overview");
    expect(src).toContain("/help/credentials/anthropic");
    expect(src).toContain("/help/credentials/openai");
  });

  it("README points at the credentials help section", async () => {
    const src = await read("README.md");
    expect(src).toMatch(/credentials/i);
    expect(src).toContain("help/credentials");
  });
});
