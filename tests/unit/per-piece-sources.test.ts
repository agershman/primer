/**
 * Pins the per-piece source-attribution surface.
 *
 * The `usage_events`-style aggregate Sources line on the briefing
 * header tells you what fed the WHOLE briefing. The user wanted the
 * same affordance per piece — see WHICH inputs actually fed THIS
 * teaching piece without the full provenance list cluttering every
 * article.
 *
 * The data was already being stored (`teaching_pieces.source_context`
 * JSON; populated by `briefing-generator.ts`'s `SourceDescriptor[]`)
 * and was already plumbed to the UI (`piece.source_context` on the
 * API response). This change just refactors the display from
 * "always-expanded bordered box" to "collapsed-by-default summary
 * with expand-to-detail" — same shape as the briefing-level
 * `WorkContextBar`.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("server: per-piece source_context is captured + plumbed end-to-end", () => {
  it("teaching_pieces table has a source_context JSON column with sane default", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toMatch(/source_context TEXT DEFAULT '\[\]'/);
  });

  it("briefing-generator stringifies SourceDescriptor[] into source_context on insert", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(/JSON\.stringify\(target\.sourceContext \?\? \[\]\)/);
  });

  it("/briefing/today + /briefing/:date parse source_context back to an array", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    const parses = src.match(
      /source_context: JSON\.parse\(\(piece\.source_context as string\) \|\| "\[\]"\)/g,
    );
    // Two routes (today + :date) both parse — pin both so a future
    // refactor doesn't accidentally drop one.
    expect(parses?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("frontend: <SourceProvenance> renders collapsed by default", () => {
  it("declares the source-type icon + label maps used by the summary line", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // Same icons/labels as WorkContextBar's collapsed view so the
    // visual vocabulary stays consistent between briefing-level and
    // piece-level source attribution.
    expect(src).toMatch(/SOURCE_GROUP_ICONS:\s*Record<string, string>/);
    expect(src).toMatch(/SOURCE_GROUP_LABELS:\s*Record<string, string>/);
    expect(src).toMatch(/linear_issue:\s*"◆"/);
    expect(src).toMatch(/slack_thread:\s*"◈"/);
    expect(src).toMatch(/incident:\s*"▹"/);
  });

  it("default (collapsed) state shows preposition + per-type counts + 'details' toggle", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The collapsed line: "Triggered by · ◆ 3 Linear · ◈ 2 Slack · details"
    expect(src).toMatch(/uppercase tracking-wider[\s\S]{0,200}\{preposition\}/);
    // Counts come from a JS-side groupBy so type variants ("linear"
    // vs "linear_issue") consolidate into a single row.
    expect(src).toMatch(/grouped = new Map<string,/);
    expect(src).toMatch(/groups\.map/);
    // Toggle button.
    expect(src).toMatch(/setExpanded\(!expanded\)/);
    expect(src).toMatch(/expanded \? "hide" : "details"/);
  });

  it("expanded panel reuses the existing <SourceItem> per-source detail layout", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The pre-fix shape was an always-rendered bordered box with the
    // detail list inside. The new shape gates that block on `expanded`
    // so the default state is just the one-line summary.
    expect(src).toMatch(
      /\{expanded && \([\s\S]{0,400}sources\.map\(\(src, i\) => \([\s\S]{0,200}<SourceItem/,
    );
    // Pre-fix unconditional box is gone.
    expect(src).not.toMatch(
      /<div className="rounded-md bg-bg-warm border border-border-subtle px-3 py-2 mb-4">[\s\S]{0,200}\{preposition\}/,
    );
  });

  it("toggle button has aria-expanded + aria-label for accessibility", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/aria-expanded=\{expanded\}/);
    expect(src).toMatch(/aria-label=\{expanded \? "Hide source details" : "Show source details"\}/);
  });

  it("preposition adapts to source_type ('Triggered by' / 'Based on' / 'Refreshing')", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/sourceType === "adjacent"\s*\?\s*"Based on"/);
    expect(src).toMatch(/sourceType === "decay-recalibrate"\s*\?\s*"Refreshing"/);
    expect(src).toMatch(/:\s*"Triggered by"/);
  });

  it("renders nothing when a piece has no source attribution", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/if \(sources\.length === 0\) return null/);
  });
});

describe("frontend: <TeachingPiece> still mounts <SourceProvenance> on every piece", () => {
  it("piece passes its source_context + source_type through to SourceProvenance", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/const sources = piece\.source_context \?\? \[\]/);
    expect(src).toMatch(
      /<SourceProvenance sources=\{sources\} sourceType=\{piece\.source_type\} \/>/,
    );
  });
});
