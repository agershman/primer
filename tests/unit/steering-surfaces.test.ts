/**
 * Pin the steering surfaces — `AGENTS.md`, `.cursor/rules/`, and the
 * skills + ADRs they reference — so a future change that deletes
 * one of these can't silently break the active discoverability
 * mechanism that points new contributors and AI agents at the
 * right pattern.
 *
 * The reasoning: skills and ADRs are passive — they only help if
 * someone reads them. The active steering layer is:
 *
 *   1. `AGENTS.md` (auto-loaded by Cursor / Claude Code).
 *   2. `.cursor/rules/*.mdc` (path-globbed — auto-surfaces when an
 *      agent edits the matching files).
 *   3. In-code `@see` comments at extension points (visible when an
 *      agent reads the file before editing it).
 *
 * Each layer points at the same skills + ADRs. If a skill or ADR
 * is renamed or deleted, every layer needs to update. This test
 * makes that explicit by failing when a referenced skill / ADR
 * doesn't exist.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(resolve(REPO_ROOT, p));
    return true;
  } catch {
    return false;
  }
};

const SKILLS = [
  ".cursor/skills/source-providers/SKILL.md",
  ".cursor/skills/add-llm-adapter/SKILL.md",
  ".cursor/skills/add-tts-adapter/SKILL.md",
  ".cursor/skills/add-route/SKILL.md",
  ".cursor/skills/add-pipeline-step/SKILL.md",
];

const ADRS = [
  "dev-docs/adrs/0001-custom-event-bus.md",
  "dev-docs/adrs/0002-source-text-contract-tests.md",
  "dev-docs/adrs/0003-single-user-settings-row.md",
  "dev-docs/adrs/0004-shared-types-module.md",
  "dev-docs/adrs/0005-streaming-plus-waituntil.md",
];

const CURSOR_RULES = [
  ".cursor/rules/llm-integrations.mdc",
  ".cursor/rules/tts-integrations.mdc",
  ".cursor/rules/source-providers.mdc",
  ".cursor/rules/api-routes.mdc",
  ".cursor/rules/briefing-pipeline.mdc",
  ".cursor/rules/frontend-conventions.mdc",
  ".cursor/rules/shared-types.mdc",
];

describe("steering surfaces — AGENTS.md, .cursor/rules, in-code pointers", () => {
  it("AGENTS.md exists at the repo root (auto-loaded by Cursor / Claude Code)", async () => {
    expect(await exists("AGENTS.md")).toBe(true);
  });

  it("AGENTS.md references every skill in the steering map", async () => {
    const md = await read("AGENTS.md");
    for (const skill of SKILLS) {
      expect(md, `AGENTS.md must reference ${skill}`).toContain(skill);
    }
  });

  it("AGENTS.md references every ADR", async () => {
    const md = await read("AGENTS.md");
    for (const adr of ADRS) {
      expect(md, `AGENTS.md must reference ${adr}`).toContain(adr);
    }
  });

  it("AGENTS.md surfaces the critical conventions (apiGet, design tokens, registry pattern)", async () => {
    const md = await read("AGENTS.md");
    // These are the contract-level rules with CI checks behind them.
    // AGENTS.md is the first place an agent reads — they need to land
    // on these before they write a single line.
    expect(md).toMatch(/apiGet/);
    expect(md).toMatch(/design tokens/i);
    expect(md).toMatch(/raw Tailwind palette|bg-zinc/);
    expect(md).toMatch(/waitUntil/);
    expect(md).toMatch(/registry/i);
  });

  it("every skill referenced from AGENTS.md exists on disk", async () => {
    for (const skill of SKILLS) {
      expect(await exists(skill), `Missing skill: ${skill}`).toBe(true);
    }
  });

  it("every ADR referenced from AGENTS.md exists on disk", async () => {
    for (const adr of ADRS) {
      expect(await exists(adr), `Missing ADR: ${adr}`).toBe(true);
    }
  });
});

describe(".cursor/rules/*.mdc — path-globbed steering", () => {
  it("every cursor rule exists and uses the .mdc frontmatter shape", async () => {
    for (const rule of CURSOR_RULES) {
      expect(await exists(rule), `Missing rule: ${rule}`).toBe(true);
      const src = await read(rule);
      // Frontmatter with `globs:` (path-globbed activation) and a
      // human-readable `description:`. Both are required for Cursor
      // to surface the rule at the right moment.
      expect(src, `${rule} must have frontmatter with globs + description`).toMatch(
        /^---[\s\S]+description:[\s\S]+globs:[\s\S]+---/m,
      );
    }
  });

  it("each cursor rule surfaces a matching skill or ADR (mdc: link)", async () => {
    for (const rule of CURSOR_RULES) {
      const src = await read(rule);
      // The whole point of the rule is to point at a skill or ADR.
      // A rule with no link to either is decoration, not steering —
      // pin that we always include at least one.
      expect(
        src,
        `${rule} must surface a skill or ADR via mdc: links`,
      ).toMatch(/mdc:\.cursor\/skills\/|mdc:dev-docs\/adrs\//);
    }
  });
});

describe("in-code pointers at extension points", () => {
  // Files where a @see / mdc: pointer to the matching skill / ADR
  // gives the in-editor reader a breadcrumb to the canonical
  // pattern. Pinned here so a future cleanup can't silently strip
  // the reference.
  const EXTENSION_POINTS: Array<{ file: string; mustReference: string }> = [
    {
      file: "src/worker/integrations/llm/dispatcher.ts",
      mustReference: ".cursor/skills/add-llm-adapter/SKILL.md",
    },
    {
      file: "src/worker/integrations/tts/dispatcher.ts",
      mustReference: ".cursor/skills/add-tts-adapter/SKILL.md",
    },
    {
      file: "src/worker/sources/registry.ts",
      mustReference: ".cursor/skills/source-providers/SKILL.md",
    },
    {
      file: "src/worker/services/briefing-generator.ts",
      mustReference: ".cursor/skills/add-pipeline-step/SKILL.md",
    },
    {
      file: "src/worker/routes/briefing.ts",
      mustReference: "dev-docs/adrs/0005-streaming-plus-waituntil.md",
    },
    {
      file: "src/frontend/lib/events.ts",
      mustReference: "0001-custom-event-bus.md",
    },
    {
      file: "src/shared/types.ts",
      mustReference: "0004-shared-types-module.md",
    },
  ];

  for (const { file, mustReference } of EXTENSION_POINTS) {
    it(`${file} references ${mustReference}`, async () => {
      const src = await read(file);
      expect(src).toContain(mustReference);
    });
  }
});

describe("PR template requires pattern conformance", () => {
  it("PR template has a 'Pattern conformance' section linking the skills folder", async () => {
    const md = await read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(md).toMatch(/Pattern conformance/);
    expect(md).toMatch(/\.cursor\/skills\//);
    expect(md).toMatch(/dev-docs\/adrs\//);
  });

  it("PR template surfaces the convention checks (apiGet + tokens) with their pinning tests", async () => {
    const md = await read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(md).toMatch(/apiGet/);
    expect(md).toMatch(/design tokens/i);
    expect(md).toMatch(/api-helper-usage\.test\.ts/);
    expect(md).toMatch(/design-tokens\.test\.ts/);
  });
});

describe("CONTRIBUTING.md actively steers contributors", () => {
  it("CONTRIBUTING.md has a 'Before you add X — read Y' table", async () => {
    const md = await read("CONTRIBUTING.md");
    expect(md).toMatch(/Before you add X/);
    // Each of the five "add a thing" skills should be linked from
    // the CONTRIBUTING table.
    for (const skill of SKILLS) {
      expect(md, `CONTRIBUTING.md must link ${skill}`).toContain(skill);
    }
  });

  it("CONTRIBUTING.md warns against silently undoing ADR-documented patterns", async () => {
    const md = await read("CONTRIBUTING.md");
    // The "if you propose to undo a pattern in dev-docs/adrs, surface
    // the ADR" rule. Pin the wording loosely so a rewrite doesn't
    // break the test on minor copy edits.
    expect(md).toMatch(/proposing to undo|undo a pattern|surface the trade-offs/i);
    expect(md).toMatch(/dev-docs\/adrs/);
  });
});
