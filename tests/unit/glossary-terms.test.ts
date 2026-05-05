/**
 * Inline glossary terms in deep dives.
 *
 * Deep dives can introduce jargon the reader (per their ABOUT
 * statement) might not know. To surface a definition without
 * leaving the page we extend the existing inline-markup syntax with
 * `[[term||definition]]`: the LLM emits the marker exactly where
 * jargon appears, the frontend renders the term with a dotted
 * underline + help cursor, and a hover tooltip shows the
 * definition. The marker rides along inside the existing
 * `deep_dive_content` JSON so no migration is required.
 *
 * Pre-feature, the deep-dive prompt only asked the LLM to "calibrate
 * vocabulary to the reader" — but with no marker syntax the model
 * had no way to tag specific terms for tooltip rendering. The
 * frontend's `parseInlineMarkup` knew about links / bold / italic /
 * code but not glossary terms; the audio path's `contentToPlainText`
 * stripped those markers but would have spoken the literal `[[`
 * brackets if the prompt change had landed without this strip.
 *
 * These contract tests pin the four moving parts so a future edit
 * can't silently regress one of them and leave the feature
 * half-wired.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");

describe("deep-dive generator prompt teaches the LLM the glossary marker", () => {
  it("includes the GLOSSARY TERMS section anchored to the ABOUT block", async () => {
    const src = await read("src/worker/services/deep-dive-generator.ts");
    expect(src).toContain("GLOSSARY TERMS");
    // The marker syntax must appear verbatim in the prompt — the
    // LLM has no other way to learn the literal characters to emit.
    expect(src).toMatch(/\[\[term\|\|short definition\]\]/);
  });

  it("instructs the model to mark only the FIRST occurrence", async () => {
    const src = await read("src/worker/services/deep-dive-generator.ts");
    // Repeated tooltips on every mention are visual noise — pin the
    // "first occurrence only" rule so a future prompt edit can't
    // drop it accidentally.
    expect(src).toMatch(/FIRST occurrence/);
  });

  it("shows the marker in the OUTPUT FORMAT JSON example", async () => {
    const src = await read("src/worker/services/deep-dive-generator.ts");
    // Example-driven prompts work much better than rule-only ones;
    // pin that the JSON example demonstrates valid usage.
    expect(src).toMatch(/\[\[CRDT\|\|conflict-free replicated data type/);
  });
});

describe("RichText parser recognizes the glossary marker", () => {
  it("imports the Tooltip component", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toMatch(/import \{ Tooltip \} from "\.\/Tooltip"/);
  });

  it("matches `[[term||definition]]` with a dedicated regex", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    // Non-greedy on both halves so adjacent markers don't merge.
    expect(src).toMatch(/glossaryMatch[\s\S]{0,80}\\\[\\\[\(\.\+\?\)\\\|\\\|\(\.\+\?\)\\\]\\\]/);
  });

  it("renders the matched term with a dotted underline + help cursor", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    expect(src).toMatch(/border-dotted[\s\S]{0,80}cursor-help/);
  });

  it("wraps the term in a Tooltip whose content is the definition", async () => {
    const src = await read("src/frontend/components/RichText.tsx");
    // The tooltip content comes from the second capture group of the
    // glossary match — definition, not the term.
    expect(src).toMatch(/<Tooltip[\s\S]{0,200}content=\{glossaryMatch\[2\]\}/);
  });
});

describe("audio path strips glossary markers before TTS", () => {
  it("contentToPlainText replaces `[[term||definition]]` with the term only", async () => {
    const src = await read("src/worker/routes/pieces/audio.ts");
    // Worker-side strip — without this the TTS engine would speak
    // the literal "double-bracket" punctuation.
    expect(src).toMatch(/\.replace\(\/\\\[\\\[\(\.\+\?\)\\\|\\\|\.\+\?\\\]\\\]\/g, "\$1"\)/);
  });
});

describe("audio duration estimator strips glossary markers", () => {
  it("contentBlocksToSpokenText strips `[[term||definition]]` to the term", async () => {
    const src = await read("src/frontend/utils/audioEstimate.ts");
    // Frontend-side strip keeps the duration estimate honest — the
    // unspoken definition shouldn't inflate the chars-per-second
    // calculation.
    expect(src).toMatch(/\.replace\(\/\\\[\\\[\(\.\+\?\)\\\|\\\|\.\+\?\\\]\\\]\/g, "\$1"\)/);
  });
});

describe("RichText behaviour: glossary marker renders correctly", () => {
  it("does not leak `[[` or `||` into the parsed output for a glossary block", async () => {
    // Parse via a minimal regex stand-in for parseInlineMarkup: we
    // don't import the React module directly here (it pulls in
    // prism + mermaid via static imports and that's a heavy boot
    // for a unit test). Instead we lift the same regex the parser
    // uses and assert on the captures, which is what the runtime
    // ultimately renders.
    const text =
      "The [[CRDT||conflict-free replicated data type — converges deterministically]] resolves merges.";
    const m = text.match(/\[\[(.+?)\|\|(.+?)\]\]/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("CRDT");
    expect(m?.[2]).toBe("conflict-free replicated data type — converges deterministically");
    // After substitution the bracket characters should be gone — the
    // tooltip captures the definition; only the term shows in prose.
    const stripped = text.replace(/\[\[(.+?)\|\|.+?\]\]/g, "$1");
    expect(stripped).toBe("The CRDT resolves merges.");
    expect(stripped).not.toContain("[[");
    expect(stripped).not.toContain("||");
  });

  it("does not greedily merge two adjacent glossary markers", async () => {
    // Pre-fix `[[(.*)\|\|(.*)\]\]` (greedy) would have swallowed
    // the gap between two markers in the same paragraph and
    // collapsed them into a single mismatched pair. Non-greedy is
    // the correct shape — assert it here so a future "let me make
    // this more permissive" edit can't drop the `?`.
    const text = "[[A||def of A]] and [[B||def of B]]";
    const matches = [...text.matchAll(/\[\[(.+?)\|\|(.+?)\]\]/g)];
    expect(matches.length).toBe(2);
    expect(matches[0][1]).toBe("A");
    expect(matches[1][1]).toBe("B");
  });
});
