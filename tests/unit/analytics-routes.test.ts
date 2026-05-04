import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { analyticsRoutes } from "../../src/worker/routes/analytics";

interface BriefingRow {
  id: string;
  user_id: string;
  briefing_date: string;
  status: string;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
  models_used: string | null;
}

interface TimingRow {
  id: string;
  briefing_id: string;
  user_id: string;
  step_key: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  items_processed: number | null;
  model_used: string | null;
  metadata: string | null;
  created_at: string;
}

interface ConceptRow {
  id: string;
  user_id: string;
  canonical_name: string;
  depth_score: number | null;
  confidence: number | null;
  created_at: string;
}

interface DepthHistoryRow {
  id: string;
  user_id: string;
  concept_id: string;
  depth_score: number;
  change_source: string;
  recorded_at: string;
}

interface QuizRow {
  id: string;
  user_id: string;
  status: string;
  completed_at: string | null;
}

interface FeedbackRow {
  user_id: string;
  feedback: string | null;
  created_at: string;
}

interface UsageEventRow {
  user_id: string;
  estimated_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  audio_chars?: number;
  provider: string;
  modality: "text" | "tts";
  created_at: string;
}

class FakeD1 {
  briefings: BriefingRow[] = [];
  timings: TimingRow[] = [];
  concepts: ConceptRow[] = [];
  depthHistory: DepthHistoryRow[] = [];
  quizzes: QuizRow[] = [];
  feedback: FeedbackRow[] = [];
  /** Mirrors the unified `usage_events` table; kept named after the
   *  legacy field so tests don't need restructuring. */
  tokenUsage: UsageEventRow[] = [];

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();

    return {
      bind(...params: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            if (normalized.startsWith("SELECT COUNT(*) as count FROM concepts")) {
              const [userId] = params as [string];
              return { count: db.concepts.filter((c) => c.user_id === userId).length } as T;
            }
            if (normalized.startsWith("SELECT COALESCE(SUM(gain), 0)")) {
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const total = db.depthHistory
                .filter(
                  (h) =>
                    h.user_id === userId &&
                    h.change_source === "quiz" &&
                    new Date(h.recorded_at).getTime() > cutoff,
                )
                .reduce((s, h) => s + Math.max(0, h.depth_score), 0);
              return { total } as T;
            }
            throw new Error(`Unhandled first SELECT: ${normalized}`);
          },

          async all<T>(): Promise<{ results: T[] }> {
            if (normalized.startsWith("SELECT id, briefing_date, status")) {
              const [userId, limit] = params as [string, number];
              const results = db.briefings
                .filter((b) => b.user_id === userId)
                .sort((a, b) => b.briefing_date.localeCompare(a.briefing_date))
                .slice(0, Number(limit));
              return { results: results as unknown as T[] };
            }

            if (normalized.includes("FROM briefing_timings WHERE briefing_id IN")) {
              const ids = params as string[];
              const results = db.timings.filter((t) => ids.includes(t.briefing_id));
              return { results: results as unknown as T[] };
            }

            if (normalized.startsWith("SELECT step_key, model_used, duration_ms")) {
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const results = db.timings.filter(
                (t) =>
                  t.user_id === userId && new Date(t.created_at).getTime() > cutoff,
              );
              return { results: results as unknown as T[] };
            }

            if (normalized.includes("LEFT JOIN briefing_timings t ON t.briefing_id")) {
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const results = db.briefings
                .filter(
                  (b) =>
                    b.user_id === userId &&
                    ["generated", "partial"].includes(b.status) &&
                    new Date(b.created_at).getTime() > cutoff,
                )
                .map((b) => ({
                  id: b.id,
                  briefing_date: b.briefing_date,
                  total_ms: db.timings
                    .filter((t) => t.briefing_id === b.id)
                    .reduce((s, t) => s + t.duration_ms, 0),
                }));
              return { results: results as unknown as T[] };
            }

            if (normalized.startsWith("SELECT date(created_at) as day, provider, modality")) {
              // Per-(day, provider, modality) bucketed cost roll-up
              // straight off `usage_events`. The route then groups
              // these into per-day records JS-side; the fake just
              // needs to return rows in the expected shape.
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const grouped = new Map<
                string,
                {
                  day: string;
                  provider: string;
                  modality: string;
                  cost_usd: number;
                  tokens: number;
                  chars: number;
                }
              >();
              for (const u of db.tokenUsage) {
                if (u.user_id !== userId) continue;
                if (new Date(u.created_at).getTime() <= cutoff) continue;
                const day = u.created_at.slice(0, 10);
                const key = `${day}::${u.provider}::${u.modality}`;
                const cur =
                  grouped.get(key) ??
                  {
                    day,
                    provider: u.provider,
                    modality: u.modality,
                    cost_usd: 0,
                    tokens: 0,
                    chars: 0,
                  };
                cur.cost_usd += u.estimated_cost_usd;
                cur.tokens += u.input_tokens + u.output_tokens + (u.reasoning_tokens ?? 0);
                cur.chars += u.audio_chars ?? 0;
                grouped.set(key, cur);
              }
              const results = Array.from(grouped.values());
              return { results: results as unknown as T[] };
            }

            if (normalized.includes("CAST(ROUND(COALESCE(cd.depth_score")) {
              const [userId] = params as [string];
              const buckets = new Map<number, number>();
              for (const c of db.concepts) {
                if (c.user_id !== userId) continue;
                const bucket = Math.round(c.depth_score ?? 0);
                buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
              }
              const results = Array.from(buckets.entries())
                .map(([bucket, count]) => ({ bucket, count }))
                .sort((a, b) => a.bucket - b.bucket);
              return { results: results as unknown as T[] };
            }

            if (normalized.startsWith("SELECT date(c.created_at) as day, COUNT(*)")) {
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const grouped = new Map<string, number>();
              for (const c of db.concepts) {
                if (c.user_id !== userId) continue;
                if (new Date(c.created_at).getTime() <= cutoff) continue;
                const day = c.created_at.slice(0, 10);
                grouped.set(day, (grouped.get(day) ?? 0) + 1);
              }
              const results = Array.from(grouped.entries()).map(([day, count]) => ({ day, count }));
              return { results: results as unknown as T[] };
            }

            if (normalized.includes("SELECT c.id, c.canonical_name, cd.depth_score")) {
              const [userId, days] = params as [string, number, string];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const results = db.concepts
                .filter((c) => c.user_id === userId)
                .map((c) => {
                  const baselineRow = db.depthHistory
                    .filter(
                      (h) =>
                        h.user_id === userId &&
                        h.concept_id === c.id &&
                        new Date(h.recorded_at).getTime() <= cutoff,
                    )
                    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
                  return {
                    id: c.id,
                    canonical_name: c.canonical_name,
                    depth_score: c.depth_score,
                    confidence: c.confidence,
                    baseline: baselineRow?.depth_score ?? null,
                  };
                });
              return { results: results as unknown as T[] };
            }

            if (normalized.startsWith("SELECT status, completed_at FROM calibration_quizzes")) {
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const results = db.quizzes.filter(
                (q) =>
                  q.user_id === userId &&
                  q.completed_at != null &&
                  new Date(q.completed_at).getTime() > cutoff,
              );
              return { results: results as unknown as T[] };
            }

            if (normalized.startsWith("SELECT feedback, COUNT(*)")) {
              const [userId, days] = params as [string, number];
              const cutoff = Date.now() - Number(days) * 86400_000;
              const grouped = new Map<string, number>();
              for (const f of db.feedback) {
                if (f.user_id !== userId) continue;
                if (!f.feedback) continue;
                if (new Date(f.created_at).getTime() <= cutoff) continue;
                grouped.set(f.feedback, (grouped.get(f.feedback) ?? 0) + 1);
              }
              const results = Array.from(grouped.entries()).map(([feedback, count]) => ({
                feedback,
                count,
              }));
              return { results: results as unknown as T[] };
            }

            throw new Error(`Unhandled all SELECT: ${normalized}`);
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
  app.route("/api", analyticsRoutes);
  return app;
}

async function fetchJson(app: ReturnType<typeof makeApp>, path: string, db: FakeD1) {
  const res = await app.fetch(new Request(`https://example.com${path}`), {
    DB: db,
  } as unknown as Record<string, unknown>);
  return { status: res.status, body: await res.json() };
}

let db: FakeD1;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  db = new FakeD1();
  app = makeApp(db);
});

describe("GET /api/analytics/briefings", () => {
  it("returns empty list when no briefings exist", async () => {
    const { status, body } = await fetchJson(app, "/api/analytics/briefings", db);
    expect(status).toBe(200);
    expect(body).toEqual({ briefings: [] });
  });

  it("aggregates step durations into totalMs per briefing", async () => {
    const now = new Date().toISOString();
    db.briefings.push({
      id: "brf_1",
      user_id: "user_1",
      briefing_date: "2026-04-24",
      status: "generated",
      generated_at: now,
      created_at: now,
      updated_at: now,
      models_used: JSON.stringify({ teachingPiece: "claude-sonnet-4-20250514" }),
    });
    db.timings.push(
      {
        id: "t1",
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "work_context",
        started_at: now,
        finished_at: now,
        duration_ms: 2500,
        items_processed: 10,
        model_used: null,
        metadata: null,
        created_at: now,
      },
      {
        id: "t2",
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "concepts",
        started_at: now,
        finished_at: now,
        duration_ms: 8000,
        items_processed: 24,
        model_used: "claude-haiku-4-5-20251001",
        metadata: JSON.stringify({ workContextItems: 10 }),
        created_at: now,
      },
    );

    const { body } = (await fetchJson(app, "/api/analytics/briefings", db)) as unknown as {
      body: {
        briefings: Array<{
          id: string;
          totalMs: number;
          modelsUsed: Record<string, string>;
          steps: Array<{ stepKey: string; durationMs: number; modelUsed: string | null }>;
        }>;
      };
    };
    expect(body.briefings).toHaveLength(1);
    expect(body.briefings[0].totalMs).toBe(10500);
    expect(body.briefings[0].modelsUsed.teachingPiece).toBe("claude-sonnet-4-20250514");
    expect(body.briefings[0].steps.map((s) => s.stepKey).sort()).toEqual([
      "concepts",
      "work_context",
    ]);
  });

  it("user-scoped — does not leak another user's briefings", async () => {
    const now = new Date().toISOString();
    db.briefings.push({
      id: "brf_other",
      user_id: "other_user",
      briefing_date: "2026-04-24",
      status: "generated",
      generated_at: now,
      created_at: now,
      updated_at: now,
      models_used: null,
    });

    const { body } = (await fetchJson(app, "/api/analytics/briefings", db)) as unknown as {
      body: { briefings: unknown[] };
    };
    expect(body.briefings).toEqual([]);
  });
});

describe("GET /api/analytics/performance", () => {
  it("aggregates step stats: avg/p50/p95 per (step, model)", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    db.briefings.push({
      id: "brf_1",
      user_id: "user_1",
      briefing_date: "2026-04-24",
      status: "generated",
      generated_at: recent,
      created_at: recent,
      updated_at: recent,
      models_used: null,
    });

    // Three concepts runs all on Haiku — durations 1000, 2000, 3000
    for (const d of [1000, 2000, 3000]) {
      db.timings.push({
        id: `t_${d}`,
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "concepts",
        started_at: recent,
        finished_at: recent,
        duration_ms: d,
        items_processed: 10,
        model_used: "claude-haiku-4-5-20251001",
        metadata: null,
        created_at: recent,
      });
    }

    const { body } = (await fetchJson(app, "/api/analytics/performance?days=30", db)) as unknown as {
      body: {
        stepStats: Array<{
          stepKey: string;
          modelUsed: string | null;
          avgMs: number;
          p50Ms: number;
          p95Ms: number;
          runs: number;
        }>;
        briefingTotals: unknown[];
      };
    };

    const concepts = body.stepStats.find((s) => s.stepKey === "concepts");
    expect(concepts).toBeDefined();
    expect(concepts!.runs).toBe(3);
    expect(concepts!.avgMs).toBe(2000);
    expect(concepts!.p50Ms).toBe(2000);
    expect(concepts!.p95Ms).toBe(3000);
    expect(concepts!.modelUsed).toBe("claude-haiku-4-5-20251001");
  });

  it("groups separately by (step_key, model_used) so model swaps are visible", async () => {
    const now = new Date().toISOString();
    db.briefings.push({
      id: "brf_1",
      user_id: "user_1",
      briefing_date: "2026-04-24",
      status: "generated",
      generated_at: now,
      created_at: now,
      updated_at: now,
      models_used: null,
    });
    db.timings.push(
      {
        id: "t_haiku",
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "concepts",
        started_at: now,
        finished_at: now,
        duration_ms: 1500,
        items_processed: 10,
        model_used: "claude-haiku-4-5-20251001",
        metadata: null,
        created_at: now,
      },
      {
        id: "t_sonnet",
        briefing_id: "brf_1",
        user_id: "user_1",
        step_key: "concepts",
        started_at: now,
        finished_at: now,
        duration_ms: 6000,
        items_processed: 10,
        model_used: "claude-sonnet-4-20250514",
        metadata: null,
        created_at: now,
      },
    );

    const { body } = (await fetchJson(app, "/api/analytics/performance", db)) as unknown as {
      body: { stepStats: Array<{ stepKey: string; modelUsed: string | null; avgMs: number }> };
    };
    const conceptsBuckets = body.stepStats.filter((s) => s.stepKey === "concepts");
    expect(conceptsBuckets).toHaveLength(2);
    const haiku = conceptsBuckets.find((b) => b.modelUsed?.includes("haiku"));
    const sonnet = conceptsBuckets.find((b) => b.modelUsed?.includes("sonnet"));
    expect(haiku!.avgMs).toBe(1500);
    expect(sonnet!.avgMs).toBe(6000);
  });

  it("returns empty stepStats with no timings", async () => {
    const { body } = (await fetchJson(app, "/api/analytics/performance", db)) as unknown as {
      body: { stepStats: unknown[]; briefingTotals: unknown[] };
    };
    expect(body.stepStats).toEqual([]);
    expect(body.briefingTotals).toEqual([]);
  });
});

describe("GET /api/analytics/learning", () => {
  it("returns concept count, depth distribution, quizzes, and feedback", async () => {
    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    db.concepts.push(
      {
        id: "c1",
        user_id: "user_1",
        canonical_name: "kubernetes",
        depth_score: 2,
        confidence: 0.7,
        created_at: recent,
      },
      {
        id: "c2",
        user_id: "user_1",
        canonical_name: "raft",
        depth_score: 3,
        confidence: 0.5,
        created_at: recent,
      },
    );
    db.depthHistory.push({
      id: "h1",
      user_id: "user_1",
      concept_id: "c1",
      depth_score: 0.5,
      change_source: "quiz",
      recorded_at: now,
    });
    db.quizzes.push({
      id: "q1",
      user_id: "user_1",
      status: "answered",
      completed_at: now,
    });
    db.feedback.push(
      { user_id: "user_1", feedback: "positive", created_at: recent },
      { user_id: "user_1", feedback: "positive", created_at: recent },
      { user_id: "user_1", feedback: "negative", created_at: recent },
    );

    const { body } = (await fetchJson(app, "/api/analytics/learning?days=30", db)) as unknown as {
      body: {
        totalConcepts: number;
        depthDistribution: Array<{ bucket: number; count: number }>;
        quizzes: { completed: number; cumulativeDepthGain: number };
        feedback: { positive: number; negative: number };
      };
    };

    expect(body.totalConcepts).toBe(2);
    expect(body.depthDistribution).toContainEqual({ bucket: 2, count: 1 });
    expect(body.depthDistribution).toContainEqual({ bucket: 3, count: 1 });
    expect(body.quizzes.completed).toBe(1);
    expect(body.quizzes.cumulativeDepthGain).toBe(0.5);
    expect(body.feedback).toEqual({ positive: 2, negative: 1 });
  });

  it("returns zeros for an empty graph", async () => {
    const { body } = (await fetchJson(app, "/api/analytics/learning", db)) as unknown as {
      body: { totalConcepts: number; quizzes: { completed: number }; feedback: { positive: number; negative: number } };
    };
    expect(body.totalConcepts).toBe(0);
    expect(body.quizzes.completed).toBe(0);
    expect(body.feedback).toEqual({ positive: 0, negative: 0 });
  });
});
