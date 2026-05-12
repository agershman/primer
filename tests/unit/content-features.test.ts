import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const readRepoFile = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("verifiable citation rules", () => {
  it("teaching generator prompt includes citation rules", async () => {
    const src = await readRepoFile("src/worker/services/teaching-generator.ts");
    expect(src).toContain("CITATIONS AND LINKS:");
    expect(src).toContain("NEVER link to company homepages");
    expect(src).toContain("qualify it");
  });

  it("deep-dive generator prompt includes citation rules", async () => {
    const src = await readRepoFile("src/worker/services/deep-dive-generator.ts");
    expect(src).toContain("CITATIONS AND LINKS:");
    expect(src).toContain("NEVER link to company homepages");
  });

  it("chat responder prompt includes citation rules", async () => {
    const src = await readRepoFile("src/worker/services/chat-responder.ts");
    expect(src).toContain("CITATIONS:");
    expect(src).toContain("Never link to company homepages");
  });
});

describe("inline visual aides", () => {
  // ContentBlock and Resource now live in the single-source-of-truth
  // shared types file (`src/shared/types.ts`) so worker and frontend
  // can't drift on the wire shape. The worker / frontend type files
  // re-export from there.
  it("ContentBlock literal union lives in shared types and supports diagram + code", async () => {
    const src = await readRepoFile("src/shared/types.ts");
    expect(src).toMatch(/"text" \| "heading" \| "diagram" \| "code"/);
    expect(src).toContain("language?: string");
    expect(src).toContain("label?: string");
  });

  it("worker/types.ts re-exports ContentBlock from the shared module", async () => {
    const src = await readRepoFile("src/worker/types.ts");
    // See sibling assertion for `frontend/types.ts` — widened to
    // accommodate the audit type re-exports (AuditSummary,
    // AuditTrail, etc.).
    expect(src).toMatch(/export type \{[\s\S]{0,300}ContentBlock[\s\S]{0,300}\}\s*from\s*"\.\.\/shared\/types"/);
  });

  it("frontend/types.ts re-exports ContentBlock from the shared module", async () => {
    const src = await readRepoFile("src/frontend/types.ts");
    // Widened from 80 → 300 chars after the export-list grew to
    // include the audit types (AuditSummary, AuditTrail, etc. —
    // see migration 0007 + ADR 0007). The invariant being pinned
    // is "ContentBlock is re-exported from shared/types", not
    // "the re-export list is short", so the larger window is
    // appropriate.
    expect(src).toMatch(/export type \{[\s\S]{0,300}ContentBlock[\s\S]{0,300}\}\s*from\s*"\.\.\/shared\/types"/);
  });

  it("deep-dive prompt uses inline content for diagrams, not visualAides", async () => {
    const src = await readRepoFile("src/worker/services/deep-dive-generator.ts");
    expect(src).toContain('"type": "diagram"');
    expect(src).toContain("Do NOT put visuals in a separate section");
    expect(src).not.toMatch(/"visualAides":\s*\[/);
  });

  it("teaching prompt supports inline diagram and code blocks", async () => {
    const src = await readRepoFile("src/worker/services/teaching-generator.ts");
    expect(src).toContain('"type": "code"');
    expect(src).toContain('"type": "diagram"');
  });

  it("RichText renders diagram and code blocks", async () => {
    const src = await readRepoFile("src/frontend/components/RichText.tsx");
    expect(src).toContain("DiagramBlock");
    expect(src).toContain("CodeBlock");
    expect(src).toContain('block.type === "diagram"');
    expect(src).toContain('block.type === "code"');
  });

  it("DeepDiveView no longer has a Visual aides section", async () => {
    const src = await readRepoFile("src/frontend/pages/DeepDiveView.tsx");
    expect(src).not.toContain("Visual aides");
    expect(src).not.toContain("aidesExpanded");
  });
});

describe("chat fenced code blocks", () => {
  it("ChatPanel MarkdownText extracts fenced code blocks", async () => {
    const src = await readRepoFile("src/frontend/components/ChatPanel.tsx");
    expect(src).toContain("extractFencedBlocks");
    expect(src).toContain("```");
  });

  it("renders mermaid blocks with a diagram label", async () => {
    const src = await readRepoFile("src/frontend/components/ChatPanel.tsx");
    expect(src).toContain("isMermaid");
    expect(src).toContain('"diagram"');
  });
});

describe("audio playback (TTS)", () => {
  it("wrangler.api.example.toml has AI binding", async () => {
    const src = await readRepoFile("wrangler.api.example.toml");
    expect(src).toContain('[ai]');
    expect(src).toContain('binding = "AI"');
  });

  it("Env interface includes AI binding", async () => {
    const src = await readRepoFile("src/worker/types.ts");
    expect(src).toContain("AI: Ai");
  });

  it("piece audio route exists", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toContain('"/piece/:id/audio"');
    expect(src).toContain("generateTtsResponse");
    // The actual audio/mpeg header is set in the shared TTS module that
    // pieces.ts now imports from.
    const ttsSrc = await readRepoFile("src/worker/services/tts.ts");
    expect(ttsSrc).toContain("audio/mpeg");
  });

  it("deep-dive audio route exists", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toContain('"/piece/:id/deep-dive/audio"');
  });

  it("strips markup from content blocks for plain text TTS", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toContain("contentToPlainText");
    expect(src).toContain(".replace(");
  });

  it("AudioPlayer component exists with play/pause/seek", async () => {
    const src = await readRepoFile("src/frontend/components/AudioPlayer.tsx");
    expect(src).toContain("AudioPlayer");
    expect(src).toContain("PlayIcon");
    expect(src).toContain("PauseIcon");
    expect(src).toContain("seek");
  });

  it("TeachingPiece includes AudioPlayer", async () => {
    const src = await readRepoFile("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("AudioPlayer");
    expect(src).toContain("/api/piece/");
    expect(src).toContain("/audio");
  });

  it("DeepDiveView includes AudioPlayer for deep dive audio", async () => {
    const src = await readRepoFile("src/frontend/pages/DeepDiveView.tsx");
    expect(src).toContain("AudioPlayer");
    expect(src).toContain("deep-dive/audio");
  });
});
