import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { briefingRoutes } from "../../src/worker/routes/briefing";

/**
 * Route tests for GET /api/briefing/:id/pipeline.
 *
 * The pipeline endpoint assembles a trace from five tables:
 * `briefings`, `briefing_timings`, `near_misses`, `discovered_items`,
 * and `teaching_pieces` (LEFT JOIN audits for the per-piece audit
 * summary). The shim below answers exactly those queries so the
 * test pins the wire contract — adding a new query in the handler
 * without adding a branch here is a deliberate failure signal.
 */

interface BriefingRow {
  id: string;
  user_id: string;
  status: string;
  briefing_date: string;
  created_at: string;
  updated_at: string;
  generated_at: string | null;
  work_context_sources: string | null;
  metadata: string | null;
  models_used: string | null;
  redundant_drafts: string | null;
}

interface TimingRow {
  briefing_id: string;
  user_id: string;
  step_key: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  items_processed: number | null;
  model_used: string | null;
  metadata: string | null;
}

interface NearMissRow {
  briefing_id: string;
  user_id: string;
  title: string;
  source_type: string;
  source_label: string | null;
  relevance_score: number | null;
  exclusion_reason: string | null;
  url: string | null;
}

interface DiscoveredRow {
  user_id: string;
  used_in_briefing_id: string | null;
  title: string;
  source_type: string;
  url: string;
  summary: string | null;
  relevance_score: number | null;
  relevance_concepts: string;
}

interface PieceRow {
  id: string;
  user_id: string;
  briefing_id: string;
  title: string;
  selection_reasoning: string | null;
  source_type: string;
  series_id: string | null;
  part_number: number | null;
  position: number;
  target_depth: number | null;
}

interface AuditRow {
  target_kind: "piece" | "deep_dive" | "quiz";
  target_id: string;
  pass: number;
  status: string;
  total_claims: number;
  patched_count: number;
  dropped_count: number;
  grounded_web_count: number;
}

class FakeD1 {
  briefings: BriefingRow[] = [];
  timings: TimingRow[] = [];
  nearMisses: NearMissRow[] = [];
  discovered: DiscoveredRow[] = [];
  pieces: PieceRow[] = [];
  audits: AuditRow[] = [];

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...params: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            if (normalized.startsWith("SELECT id, status, briefing_date, created_at, updated_at, generated_at,")) {
              const [briefingId, userId] = params as [string, string];
              const row = db.briefings.find((b) => b.id === briefingId && b.user_id === userId);
              return (row ?? null) as T | null;
            }
            throw new Error(`Unhandled SELECT (first) in FakeD1: ${normalized}`);
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (normalized.startsWith("SELECT step_key, started_at, finished_at, duration_ms,")) {
              const [briefingId, userId] = params as [string, string];
              const rows = db.timings.filter((t) => t.briefing_id === briefingId && t.user_id === userId);
              rows.sort((a, b) => a.started_at.localeCompare(b.started_at));
              return { results: rows as unknown as T[] };
            }
            if (normalized.startsWith("SELECT title, source_type, source_label, relevance_score, exclusion_reason, url")) {
              const [briefingId, userId] = params as [string, string];
              const rows = db.nearMisses.filter((n) => n.briefing_id === briefingId && n.user_id === userId);
              rows.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
              return { results: rows as unknown as T[] };
            }
            if (normalized.startsWith("SELECT title, source_type, url, summary, relevance_score, relevance_concepts")) {
              const [briefingId, userId] = params as [string, string];
              const rows = db.discovered.filter(
                (d) => d.used_in_briefing_id === briefingId && d.user_id === userId,
              );
              rows.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
              return { results: rows as unknown as T[] };
            }
            if (normalized.startsWith("SELECT tp.id, tp.title, tp.selection_reasoning, tp.source_type,")) {
              const [briefingId, userId] = params as [string, string];
              const rows = db.pieces
                .filter((p) => p.briefing_id === briefingId && p.user_id === userId)
                .sort((a, b) => a.position - b.position)
                .map((p) => {
                  const audit = db.audits.find((a) => a.target_kind === "piece" && a.target_id === p.id);
                  return {
                    id: p.id,
                    title: p.title,
                    selection_reasoning: p.selection_reasoning,
                    source_type: p.source_type,
                    series_id: p.series_id,
                    part_number: p.part_number,
                    position: p.position,
                    target_depth: p.target_depth,
                    audit_status: audit?.status ?? null,
                    audit_total_claims: audit?.total_claims ?? null,
                    audit_patched_count: audit?.patched_count ?? null,
                    audit_dropped_count: audit?.dropped_count ?? null,
                    audit_grounded_web_count: audit?.grounded_web_count ?? null,
                  };
                });
              return { results: rows as unknown as T[] };
            }
            throw new Error(`Unhandled SELECT (all) in FakeD1: ${normalized}`);
          },
        };
      },
    };
  }
}

function makeApp(db: FakeD1, userId = "user_1") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", {
      userId,
      email: "test@example.com",
      displayName: "Test",
      identity: { type: "dev", email: "test@example.com" },
      settings: null,
    });
    await next();
  });
  app.route("/api", briefingRoutes);
  return app;
}

async function fetchJson(app: ReturnType<typeof makeApp>, db: FakeD1, path: string) {
  const res = await app.fetch(
    new Request(`https://example.com${path}`),
    { DB: db } as unknown as Record<string, unknown>,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let db: FakeD1;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  db = new FakeD1();
  app = makeApp(db);
});

describe("GET /api/briefing/:id/pipeline", () => {
  it("returns 404 for an unknown briefing id", async () => {
    const { status, body } = await fetchJson(app, db, "/api/briefing/brf_missing/pipeline");
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "Briefing not found" });
  });

  it("returns 404 when the briefing belongs to a different user", async () => {
    db.briefings.push({
      id: "brf_other",
      user_id: "user_2",
      status: "generated",
      briefing_date: "2026-05-15",
      created_at: "2026-05-15T05:00:00Z",
      updated_at: "2026-05-15T05:05:00Z",
      generated_at: "2026-05-15T05:05:00Z",
      work_context_sources: "[]",
      metadata: "{}",
      models_used: "{}",
      redundant_drafts: null,
    });
    const { status } = await fetchJson(app, db, "/api/briefing/brf_other/pipeline");
    expect(status).toBe(404);
  });

  it("assembles the full trace payload from briefings + timings + near_misses + discovered + pieces", async () => {
    db.briefings.push({
      id: "brf_1",
      user_id: "user_1",
      status: "generated",
      briefing_date: "2026-05-15",
      created_at: "2026-05-15T05:00:00Z",
      updated_at: "2026-05-15T05:05:00Z",
      generated_at: "2026-05-15T05:05:00Z",
      work_context_sources: JSON.stringify([{ type: "linear_issue", label: "2 linear_issues", count: 2, items: [] }]),
      metadata: JSON.stringify({
        candidateCount: 5,
        selectedCount: 3,
        totalPieces: 3,
        conceptsExtracted: 4,
        existingConceptsReferenced: 1,
        adjacentItemsScored: 8,
        errors: [],
      }),
      models_used: JSON.stringify({ teachingPiece: "claude-sonnet-4-6" }),
      redundant_drafts: JSON.stringify([
        {
          predecessor_id: "tp_old",
          predecessor_title: "Older piece",
          predecessor_briefing_date: "2026-05-10",
          predecessor_series_id: null,
          predecessor_part_number: null,
          reason: "covers the same topic",
        },
      ]),
    });

    db.timings.push(
      {
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "work_context",
        started_at: "2026-05-15T05:00:00Z",
        finished_at: "2026-05-15T05:00:02Z",
        duration_ms: 2000,
        items_processed: 5,
        model_used: null,
        metadata: JSON.stringify({
          providers: [
            { id: "linear", name: "Linear", enabled: true, fetched: true, itemCount: 2, errored: false, sampleItems: [] },
            { id: "slack", name: "Slack", enabled: false, fetched: false, itemCount: 0, errored: false, sampleItems: [] },
          ],
        }),
      },
      {
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "selecting",
        started_at: "2026-05-15T05:00:10Z",
        finished_at: "2026-05-15T05:00:11Z",
        duration_ms: 1000,
        items_processed: 3,
        model_used: null,
        metadata: JSON.stringify({
          candidates: 5,
          outcomes: [
            {
              conceptName: "concept-A",
              conceptId: "c1",
              priority: 1,
              depthScore: 1.5,
              sourceType: "current-work",
              focusScore: 0.8,
              selected: true,
              droppedReason: null,
            },
            {
              conceptName: "concept-B",
              conceptId: "c2",
              priority: 3,
              depthScore: 0.5,
              sourceType: "adjacent",
              focusScore: 0.3,
              selected: false,
              droppedReason: "cap_max_pieces",
            },
          ],
        }),
      },
    );

    db.nearMisses.push({
      briefing_id: "brf_1",
      user_id: "user_1",
      title: "Tangential article",
      source_type: "rss",
      source_label: "Some Blog",
      relevance_score: 0.3,
      exclusion_reason: "Score 0.30 below threshold 0.4",
      url: "https://example.com/article",
    });

    db.discovered.push({
      user_id: "user_1",
      used_in_briefing_id: "brf_1",
      title: "Relevant article",
      source_type: "rss",
      url: "https://example.com/kept",
      summary: null,
      relevance_score: 0.7,
      relevance_concepts: JSON.stringify(["concept-A"]),
    });

    db.pieces.push({
      id: "tp_1",
      user_id: "user_1",
      briefing_id: "brf_1",
      title: "First piece",
      selection_reasoning: "low-depth active concept",
      source_type: "current-work",
      series_id: null,
      part_number: null,
      position: 0,
      target_depth: 1.5,
    });
    db.audits.push({
      target_kind: "piece",
      target_id: "tp_1",
      pass: 1,
      status: "clean",
      total_claims: 4,
      patched_count: 0,
      dropped_count: 0,
      grounded_web_count: 1,
    });

    const { status, body } = await fetchJson(app, db, "/api/briefing/brf_1/pipeline");
    expect(status).toBe(200);

    expect(body.briefingId).toBe("brf_1");
    expect(body.status).toBe("generated");
    expect(body.finalize).toMatchObject({
      candidateCount: 5,
      selectedCount: 3,
      totalPieces: 3,
      errors: [],
    });
    expect(body.redundantDrafts).toHaveLength(1);

    const steps = body.steps as Array<{ stepKey: string; metadata: Record<string, unknown> | null }>;
    expect(steps.map((s) => s.stepKey)).toEqual(["work_context", "selecting"]);

    // Source-agnostic shape: the work_context metadata enumerates
    // every configured provider (enabled or not) with a `sourceType`
    // tag the panel can render generically.
    const wc = steps[0].metadata as { providers: Array<{ id: string; enabled: boolean; itemCount: number }> };
    expect(wc.providers).toHaveLength(2);
    expect(wc.providers.find((p) => p.id === "slack")?.enabled).toBe(false);

    // Selector outcomes carry per-candidate kept/dropped reasons.
    const sel = steps[1].metadata as { outcomes: Array<{ conceptName: string; selected: boolean; droppedReason: string | null }> };
    expect(sel.outcomes).toHaveLength(2);
    expect(sel.outcomes.find((o) => o.conceptName === "concept-B")?.droppedReason).toBe("cap_max_pieces");

    expect(body.nearMisses).toMatchObject([
      { title: "Tangential article", sourceType: "rss", relevanceScore: 0.3 },
    ]);
    expect(body.discovered).toMatchObject([
      { title: "Relevant article", sourceType: "rss", relevanceScore: 0.7 },
    ]);

    const pieces = body.pieces as Array<{ id: string; auditSummary: { status: string; totalClaims: number } | null }>;
    expect(pieces).toHaveLength(1);
    expect(pieces[0].auditSummary).toMatchObject({ status: "clean", totalClaims: 4 });
  });
});
