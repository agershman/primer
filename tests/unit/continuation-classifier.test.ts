import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  findCandidatePredecessors,
  classifyDraft,
  type DraftPiece,
  type PredecessorCandidate,
} from "../../src/worker/services/continuation-classifier";
import type { LLMClient } from "../../src/worker/integrations/llm/types";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

/**
 * Minimal in-memory shim for the parts of D1 the classifier touches.
 * We intentionally don't model the whole interface — just the
 * teaching_pieces JOIN briefings query the candidate selector issues
 * and the (token usage) INSERT the classifier writes after it runs.
 */
type PieceRow = {
  id: string;
  user_id: string;
  briefing_id: string;
  briefing_date: string;
  created_at: string;
  title: string;
  content: string;
  concepts: string;
  source_context: string | null;
  series_id: string | null;
  part_number: number | null;
};

class FakeD1 {
  pieces: PieceRow[] = [];
  recordedTokenUsageRows: unknown[] = [];

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...params: unknown[]) {
        return {
          async all<T>() {
            // Predecessor candidate query.
            if (normalized.includes("FROM teaching_pieces tp JOIN briefings b ON b.id = tp.briefing_id")) {
              const [userId, lookbackOffset] = params as [string, string];
              // Simulate lookback: rows older than the offset are excluded.
              // The test fixtures use ISO strings; we treat the offset as
              // "any row whose created_at is after now() + offset".
              const cutoffMs = Date.now() + parseLookback(lookbackOffset);
              const rows = db.pieces
                .filter((p) => p.user_id === userId)
                .filter((p) => new Date(p.created_at).getTime() >= cutoffMs)
                .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
                .slice(0, 100)
                .map((p) => ({
                  id: p.id,
                  title: p.title,
                  briefing_date: p.briefing_date,
                  created_at: p.created_at,
                  concepts: p.concepts,
                  source_context: p.source_context,
                  content: p.content,
                  series_id: p.series_id,
                  part_number: p.part_number,
                }));
              return { results: rows as T[], success: true, meta: {} };
            }
            return { results: [], success: true, meta: {} };
          },
          async run() {
            // token_usage INSERTs swallowed
            db.recordedTokenUsageRows.push({ sql: normalized, params });
            return { success: true, meta: { changes: 1 } };
          },
          async first<T>(): Promise<T | null> {
            return null;
          },
        };
      },
    };
  }
}

function parseLookback(offset: string): number {
  // "-30 days" -> -30 * 86400_000
  const match = offset.match(/^-(\d+) days$/);
  if (!match) return 0;
  return -Number(match[1]) * 86_400_000;
}

function makeAnthropic(stubbed: { classification: string; predecessor_id: string | null; reason: string }): LLMClient {
  // Only the methods the classifier actually calls.
  return {
    async generateJson<T>() {
      return {
        result: stubbed as unknown as T,
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  } as unknown as LLMClient;
}

function makeDraft(overrides: Partial<DraftPiece> = {}): DraftPiece {
  return {
    title: "Today's Draft",
    content: [
      { type: "heading", value: "Today" },
      { type: "text", value: "We're looking at the same thing again." },
    ],
    conceptIds: ["cpt_a"],
    conceptName: "Concept A",
    sources: [{ type: "linear_issue", id: "CIN-1234" }],
    ...overrides,
  };
}

function recentIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

describe("findCandidatePredecessors", () => {
  it("returns empty when the draft has no concepts and no sources", async () => {
    const db = new FakeD1();
    db.pieces.push({
      id: "tp_1", user_id: "u1", briefing_id: "b1", briefing_date: "2026-04-20",
      created_at: recentIso(2), title: "Old", content: "[]",
      concepts: '["cpt_a"]', source_context: '[{"id":"CIN-1234"}]',
      series_id: null, part_number: null,
    });
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft({ conceptIds: [], sources: [] }),
    );
    expect(candidates).toEqual([]);
  });

  it("recalls a predecessor with concept overlap", async () => {
    const db = new FakeD1();
    db.pieces.push({
      id: "tp_1", user_id: "u1", briefing_id: "b1", briefing_date: "2026-04-20",
      created_at: recentIso(2), title: "Yesterday's piece",
      content: JSON.stringify([{ type: "text", value: "Some prior content" }]),
      concepts: '["cpt_a"]',
      source_context: '[{"type":"linear_issue","id":"CIN-9999"}]', // different source
      series_id: null, part_number: null,
    });
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft({ sources: [{ id: "CIN-1234" }] }), // different source from predecessor
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("tp_1");
    expect(candidates[0].bodyExcerpt).toContain("Some prior content");
  });

  it("recalls a predecessor with source overlap (URL or ID) but no concept overlap", async () => {
    const db = new FakeD1();
    db.pieces.push({
      id: "tp_1", user_id: "u1", briefing_id: "b1", briefing_date: "2026-04-20",
      created_at: recentIso(2), title: "Yesterday by URL",
      content: "[]", concepts: '["cpt_other"]',
      source_context: '[{"url":"https://linear.app/team/issue/CIN-1234"}]',
      series_id: null, part_number: null,
    });
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft({
        conceptIds: ["cpt_unrelated"],
        sources: [{ url: "https://linear.app/team/issue/CIN-1234" }],
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("tp_1");
  });

  it("excludes pieces that don't overlap on either concepts or sources", async () => {
    const db = new FakeD1();
    db.pieces.push({
      id: "tp_1", user_id: "u1", briefing_id: "b1", briefing_date: "2026-04-20",
      created_at: recentIso(2), title: "Unrelated piece",
      content: "[]", concepts: '["cpt_unrelated"]',
      source_context: '[{"id":"CIN-9999"}]',
      series_id: null, part_number: null,
    });
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft({ conceptIds: ["cpt_a"], sources: [{ id: "CIN-1234" }] }),
    );
    expect(candidates).toEqual([]);
  });

  it("excludes pieces older than the lookback window", async () => {
    const db = new FakeD1();
    db.pieces.push({
      id: "tp_old", user_id: "u1", briefing_id: "b1", briefing_date: "2026-01-01",
      created_at: recentIso(100), title: "Way older",
      content: "[]", concepts: '["cpt_a"]',
      source_context: "[]",
      series_id: null, part_number: null,
    });
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft(),
      30, // 30-day window
    );
    expect(candidates).toEqual([]);
  });

  it("respects the candidate cap so the LLM prompt stays bounded", async () => {
    const db = new FakeD1();
    for (let i = 0; i < 12; i++) {
      db.pieces.push({
        id: `tp_${i}`, user_id: "u1", briefing_id: "b1", briefing_date: "2026-04-20",
        created_at: recentIso(i + 1), title: `Piece ${i}`,
        content: "[]", concepts: '["cpt_a"]',
        source_context: "[]",
        series_id: null, part_number: null,
      });
    }
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft(),
      30,
      5, // cap
    );
    expect(candidates).toHaveLength(5);
  });

  it("includes series_id and part_number on candidates so the pipeline can chain", async () => {
    const db = new FakeD1();
    db.pieces.push({
      id: "tp_p1", user_id: "u1", briefing_id: "b1", briefing_date: "2026-04-20",
      created_at: recentIso(2), title: "Existing Part 1",
      content: "[]", concepts: '["cpt_a"]',
      source_context: "[]",
      series_id: "ser_abc", part_number: 1,
    });
    const candidates = await findCandidatePredecessors(
      db as unknown as D1Database,
      "u1",
      makeDraft(),
    );
    expect(candidates[0].seriesId).toBe("ser_abc");
    expect(candidates[0].partNumber).toBe(1);
  });
});

describe("classifyDraft", () => {
  function fakeCandidate(overrides: Partial<PredecessorCandidate> = {}): PredecessorCandidate {
    return {
      id: "tp_pred",
      title: "Yesterday's Piece",
      briefingDate: "2026-04-20",
      createdAt: recentIso(2),
      conceptIds: ["cpt_a"],
      sources: [{ id: "CIN-1234" }],
      bodyExcerpt: "Yesterday we covered the basics.",
      seriesId: null,
      partNumber: null,
      ...overrides,
    };
  }

  it("short-circuits to NOVEL when there are no candidates (no LLM call)", async () => {
    const db = new FakeD1();
    let called = false;
    const llm = {
      async generateJson<T>() {
        called = true;
        throw new Error("should not call");
      },
    } as unknown as LLMClient;

    const result = await classifyDraft(
      db as unknown as D1Database,
      "u1",
      llm,
      makeDraft(),
      [],
    );
    expect(result.classification).toBe("NOVEL");
    expect(result.predecessor).toBeNull();
    expect(called).toBe(false);
  });

  it("returns ADDITIVE_CONTINUATION pointing at the matched candidate", async () => {
    const db = new FakeD1();
    const anthropic = makeAnthropic({
      classification: "ADDITIVE_CONTINUATION",
      predecessor_id: "tp_pred",
      reason: "New PR landed since the prior part.",
    });
    const result = await classifyDraft(
      db as unknown as D1Database,
      "u1",
      anthropic,
      makeDraft(),
      [fakeCandidate()],
    );
    expect(result.classification).toBe("ADDITIVE_CONTINUATION");
    expect(result.predecessor?.id).toBe("tp_pred");
    expect(result.reason).toMatch(/New PR/);
  });

  it("returns REDUNDANT pointing at the matched candidate", async () => {
    const db = new FakeD1();
    const anthropic = makeAnthropic({
      classification: "REDUNDANT",
      predecessor_id: "tp_pred",
      reason: "Same sources, no new movement.",
    });
    const result = await classifyDraft(
      db as unknown as D1Database,
      "u1",
      anthropic,
      makeDraft(),
      [fakeCandidate()],
    );
    expect(result.classification).toBe("REDUNDANT");
    expect(result.predecessor?.id).toBe("tp_pred");
  });

  it("demotes to NOVEL when the LLM picks an unknown predecessor id", async () => {
    const db = new FakeD1();
    const anthropic = makeAnthropic({
      classification: "ADDITIVE_CONTINUATION",
      predecessor_id: "tp_does_not_exist",
      reason: "...",
    });
    const result = await classifyDraft(
      db as unknown as D1Database,
      "u1",
      anthropic,
      makeDraft(),
      [fakeCandidate()],
    );
    expect(result.classification).toBe("NOVEL");
    expect(result.predecessor).toBeNull();
  });

  it("fails open to NOVEL when the LLM call throws", async () => {
    const db = new FakeD1();
    const llm = {
      async generateJson<T>() {
        throw new Error("network");
      },
    } as unknown as LLMClient;

    const result = await classifyDraft(
      db as unknown as D1Database,
      "u1",
      llm,
      makeDraft(),
      [fakeCandidate()],
    );
    expect(result.classification).toBe("NOVEL");
    expect(result.predecessor).toBeNull();
  });

  it("treats unknown classification strings from the LLM as NOVEL", async () => {
    const db = new FakeD1();
    const anthropic = makeAnthropic({
      classification: "MAYBE",
      predecessor_id: "tp_pred",
      reason: "unsure",
    });
    const result = await classifyDraft(
      db as unknown as D1Database,
      "u1",
      anthropic,
      makeDraft(),
      [fakeCandidate()],
    );
    expect(result.classification).toBe("NOVEL");
  });
});

describe("classifier source pinning", () => {
  it("uses concept overlap OR source overlap to recall candidates", async () => {
    const src = await read("src/worker/services/continuation-classifier.ts");
    expect(src).toContain("conceptOverlap");
    expect(src).toContain("sourceOverlap");
    // The recall query bounds rows by both lookback and a hard 100-row cap
    expect(src).toContain("LIMIT 100");
    expect(src).toMatch(/datetime\('now', \?\)/);
  });

  it("caps candidate output by the explicit limit param so the LLM prompt is bounded", async () => {
    const src = await read("src/worker/services/continuation-classifier.ts");
    expect(src).toContain("if (candidates.length >= limit) break");
  });

  it("classifier prompt asks for {classification, predecessor_id, reason} JSON shape", async () => {
    const src = await read("src/worker/services/continuation-classifier.ts");
    expect(src).toContain("\"classification\": \"NOVEL\" | \"ADDITIVE_CONTINUATION\" | \"REDUNDANT\"");
    expect(src).toContain("\"predecessor_id\":");
    expect(src).toContain("\"reason\":");
  });

  it("classifier biases toward NOVEL when uncertain (anti-overlinking)", async () => {
    const src = await read("src/worker/services/continuation-classifier.ts");
    expect(src).toMatch(/Be conservative\.\s+Lean toward NOVEL/i);
  });

  it("config exposes CONTINUATION_LOOKBACK_DAYS = 30 and MAX_PREDECESSOR_CANDIDATES = 5", async () => {
    const src = await read("src/worker/config/constants.ts");
    expect(src).toContain("CONTINUATION_LOOKBACK_DAYS = 30");
    expect(src).toContain("MAX_PREDECESSOR_CANDIDATES = 5");
  });

  it("default model is the cheap haiku tier — classification doesn't need a smart model", async () => {
    const src = await read("src/worker/config/models.ts");
    expect(src).toMatch(/continuationClassifier:\s*"claude-haiku-4-5-20251001"/);
  });
});

describe("pipeline wiring (briefing-generator)", () => {
  it("imports the classifier and invokes both helpers", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(
      /import \{[\s\S]*findCandidatePredecessors[\s\S]*\}\s+from\s+"\.\/continuation-classifier\.js"/,
    );
    expect(src).toMatch(
      /import \{[\s\S]*classifyDraft[\s\S]*\}\s+from\s+"\.\/continuation-classifier\.js"/,
    );
    expect(src).toContain("findCandidatePredecessors(db, userId,");
    expect(src).toContain("classifyDraft(");
  });

  it("REDUNDANT branch skips the INSERT and accumulates a redundant_drafts entry", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain('classification?.classification === "REDUNDANT"');
    expect(src).toContain("redundantDrafts.push(");
    // The continue keeps the loop on the next target — no INSERT runs
    // for redundant drafts.
    expect(src).toMatch(/redundantDrafts\.push\([\s\S]*?\);[\s\S]*?continue;/);
  });

  it("ADDITIVE branch backfills the predecessor's series identity when needed", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain('classification?.classification === "ADDITIVE_CONTINUATION"');
    // First-time series formation: predecessor gets series_id + part_number = 1
    expect(src).toMatch(
      /UPDATE teaching_pieces SET series_id = \?, part_number = 1 WHERE id = \?/,
    );
    // New piece's part number is the max + 1, not pred.partNumber + 1
    // (avoids collisions on parallel batches).
    expect(src).toMatch(
      /SELECT MAX\(part_number\) AS max_part FROM teaching_pieces WHERE series_id = \?/,
    );
  });

  it("ADDITIVE branch passes a continuation context into the second teaching-piece pass", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("continuation: {");
    expect(src).toContain("predecessorTitle: pred.title");
    expect(src).toContain("newPartNumber: partNumber");
  });

  it("the INSERT writes series_id and part_number alongside the new piece", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("series_id, part_number, created_at)");
    // The bind list ends with seriesId and partNumber, immediately
    // before the trailing closing `)` of the bind() call.
    expect(src).toMatch(/seriesId,\s*\n?\s*partNumber,\s*\n?\s*\)/);
  });

  it("REDUNDANT entries snapshot the predecessor's briefing_date for the chip's deep link", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("predecessor_briefing_date: pred.briefingDate");
  });

  it("redundantDrafts is persisted in a single UPDATE at the end of the piece loop", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toMatch(
      /UPDATE briefings SET redundant_drafts = \? WHERE id = \?/,
    );
  });

  it("classifier failures fall through to NOVEL (pipeline never drops a piece)", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    // A try/catch wraps the classifier call site; the catch warns but
    // leaves classification null, which the rest of the loop treats as
    // NOVEL (no series fields set, INSERT runs as before).
    expect(src).toMatch(/treating as NOVEL/i);
  });
});

describe("teaching-generator continuation context", () => {
  it("accepts a `continuation` option with predecessor title, date, excerpt, and new part number", async () => {
    const src = await read("src/worker/services/teaching-generator.ts");
    expect(src).toContain("export interface ContinuationContext");
    expect(src).toContain("predecessorTitle: string");
    expect(src).toContain("predecessorDate: string");
    expect(src).toContain("predecessorExcerpt: string");
    expect(src).toContain("newPartNumber: number");
  });

  it("injects a CONTINUATION CONTEXT block into the system prompt when the option is set", async () => {
    const src = await read("src/worker/services/teaching-generator.ts");
    expect(src).toContain("CONTINUATION CONTEXT");
    // The prompt instructs the writer to open with a callback and not
    // recap — that's the whole point.
    expect(src).toMatch(/Open with a brief one-sentence callback/);
    expect(src).toMatch(/Do NOT repeat the prior part's claims/);
  });
});

describe("API surfaces", () => {
  it("/briefing/today and /briefing/:date both return parsed redundantDrafts", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("function parseRedundantDrafts");
    // Both routes call the parser with the JSON column.
    const occurrences = src.match(/redundantDrafts: parseRedundantDrafts/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("redundantDrafts parse tolerates NULL and malformed JSON without crashing", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Defensive: empty array on either NULL or a JSON.parse failure.
    expect(src).toMatch(/if \(!raw\) return \[\];/);
    expect(src).toContain("catch {");
  });

  it("GET /piece/:id/series returns ordered parts with briefing_date for deep linking", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    // Tolerate either router name — `pieceRoutes` (legacy assembly
    // file) or `pieceFeedbackReadRoutes` (post-split sub-file).
    expect(src).toMatch(/(?:pieceRoutes|pieceFeedbackReadRoutes)\.get\("\/piece\/:id\/series"/);
    // Standalone pieces (no series_id) get a clean "nothing here" response.
    expect(src).toContain("seriesId: null, parts: []");
    // Ordered ascending by part_number (smallest first).
    expect(src).toMatch(/ORDER BY tp\.part_number ASC/);
    // Briefing date is included so the frontend can build hash links.
    expect(src).toContain("b.briefing_date");
  });
});

describe("frontend types and components", () => {
  it("TeachingPieceData carries series_id + part_number nullables", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toMatch(/series_id\?:\s*string \| null/);
    expect(src).toMatch(/part_number\?:\s*number \| null/);
  });

  it("RedundantDraftEntry includes the predecessor's briefing date", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toContain("predecessor_briefing_date: string");
  });

  it("BriefingData exposes redundantDrafts so the chip can render", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toMatch(/redundantDrafts\?:\s*RedundantDraftEntry\[\]/);
  });

  it("TeachingPiece renders SeriesBadge when the piece has a series_id", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("function SeriesBadge");
    // Only renders when in a series — never on standalone pieces.
    expect(src).toMatch(/isInSeries && piece\.part_number && \(\s*<SeriesBadge/);
  });

  it("TeachingPiece renders SeriesStrip for any piece in a series (bidirectional nav)", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("function SeriesStrip");
    expect(src).toMatch(/isInSeries && \(\s*<SeriesStrip/);
  });

  it("SeriesStrip renders a previous-part link for Part N where N >= 2", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/← Part \{previous\.part_number\}: \{previous\.title\}/);
  });

  it("SeriesStrip renders a next-part link for any piece with a successor", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/Part \{next\.part_number\}: \{next\.title\}[\s\S]{0,200}→/);
  });

  it("Part 1 specifically gets the prominent 'A continuation was published' banner", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("isPart1WithContinuation");
    expect(src).toContain("A continuation was published");
    expect(src).toMatch(/partNumber === 1 && next !== null/);
  });

  it("series-strip links target /briefing/{publish_date}#piece-{id}", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(
      /\/briefing\/\$\{part\.briefing_date\}#piece-\$\{part\.id\}/,
    );
  });

  it("each rendered article has id={`piece-${piece.id}`} so hash links resolve", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toMatch(/id=\{`piece-\$\{piece\.id\}`\}/);
  });

  it("TeachingPiece renders a one-time 'new' continuation pill on Part-2+ in today's briefing", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    expect(src).toContain("function NewContinuationPill");
    // The render gate is exactly the spec: in a series, Part >= 2,
    // and the briefing date matches today.
    expect(src).toMatch(
      /piece\.part_number >= 2[\s\S]{0,200}isTodaysBriefing\(briefingDate\)/,
    );
  });

  it("TeachingPiece lazy-fetches series only for pieces with a series_id", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The fetch is gated on isInSeries — standalone pieces don't pay
    // a per-render round trip.
    expect(src).toContain("if (!isInSeries) {");
    expect(src).toContain("/api/piece/${piece.id}/series");
  });

  it("BriefingPage renders RedundantDraftsChip only when there are entries", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).toContain("import { RedundantDraftsChip }");
    expect(src).toMatch(
      /briefing\?\.redundantDrafts && briefing\.redundantDrafts\.length > 0[\s\S]{0,200}<RedundantDraftsChip/,
    );
  });

  it("BriefingPage scrolls to a `#piece-...` hash once pieces are mounted", async () => {
    const src = await read("src/frontend/pages/BriefingPage.tsx");
    expect(src).toMatch(/window\.location\.hash/);
    expect(src).toMatch(/scrollIntoView\(/);
    // Re-runs on `pieces` changing because the briefing payload arrives
    // async — anchor target only exists after pieces render.
    expect(src).toMatch(/\}, \[pieces\]\)/);
  });

  it("RedundantDraftsChip links each entry back to the predecessor briefing", async () => {
    const src = await read("src/frontend/components/RedundantDraftsChip.tsx");
    expect(src).toMatch(
      /to=\{`\/briefing\/\$\{d\.predecessor_briefing_date\}#piece-\$\{d\.predecessor_id\}`\}/,
    );
    // Pluralization is right ("1 topic" vs "N topics") so the heading
    // reads naturally on either side of the boundary.
    expect(src).toContain("1 topic had no new movement today");
    expect(src).toContain("topics had no new movement today");
  });
});

describe("consolidated schema — series columns", () => {
  it("has series_id, part_number, redundant_drafts columns", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("series_id TEXT");
    expect(sql).toContain("part_number INTEGER");
    expect(sql).toContain("redundant_drafts TEXT");
  });

  it("has an index on (series_id, part_number) for fast series fetches", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toMatch(
      /CREATE INDEX[\s\S]*?idx_teaching_pieces_series[\s\S]*?ON teaching_pieces\(series_id, part_number\)/i,
    );
  });

  it("bootstrap-remote-migrations.sh tracks 0012 as already applied", async () => {
    const src = await read("scripts/bootstrap-remote-migrations.sh");
    expect(src).toContain("0012_piece_series.sql");
  });
});
