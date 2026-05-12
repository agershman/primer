import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { briefingRoutes } from "../../src/worker/routes/briefing";

/**
 * Tests for the `noContentReason` field on `GET /api/briefing/today`.
 *
 * Background: a finalized briefing row with zero teaching pieces used
 * to render an empty UI shell with no explanation — the "missing
 * briefing" bug. The generator now tags such rows with
 * `metadata.reason` and the read endpoint promotes that to a
 * top-level `noContentReason` so the frontend can show an explicit
 * empty state. These tests pin that contract.
 *
 * The fake D1 below only handles SQL the read endpoint actually
 * issues — anything else throws so test failures point at the
 * specific unhandled query rather than a vague null-deref.
 */

interface BriefingRow {
  id: string;
  user_id: string;
  briefing_date: string;
  status: string;
  metadata: string;
  greeting: string | null;
  work_context_summary: string | null;
  work_context_sources: string;
  models_used: string;
  cancel_requested: number;
  focus_version_id: string | null;
  redundant_drafts: string | null;
  generated_at: string;
  created_at: string;
  updated_at: string;
}

interface PieceRow {
  id: string;
  briefing_id: string;
  position: number;
  title: string;
  content: string;
  concepts: string;
  source_context: string;
  model_used: string | null;
  feedback: string | null;
  read_at: string | null;
}

class FakeD1 {
  briefings: BriefingRow[] = [];
  pieces: PieceRow[] = [];

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();

    return {
      bind(...params: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            // Exact-date lookup (the case noContentReason cares about).
            if (
              normalized.startsWith(
                "SELECT b.*, fv.statement AS focus_statement_at_briefing FROM briefings b LEFT JOIN focus_statement_versions fv ON fv.id = b.focus_version_id WHERE b.user_id = ? AND b.briefing_date = ?",
              )
            ) {
              const [userId, date] = params as [string, string];
              const row = db.briefings.find((b) => b.user_id === userId && b.briefing_date === date);
              return (row ? { ...row, focus_statement_at_briefing: null } : null) as T | null;
            }

            // Fallback: most recent finalized briefing-with-pieces.
            if (
              normalized.startsWith(
                "SELECT b.*, fv.statement AS focus_statement_at_briefing FROM briefings b LEFT JOIN focus_statement_versions fv ON fv.id = b.focus_version_id WHERE b.user_id = ? AND b.briefing_date <= ? AND EXISTS",
              )
            ) {
              const [userId, date] = params as [string, string];
              const candidates = db.briefings
                .filter((b) => b.user_id === userId && b.briefing_date <= date)
                .filter((b) => db.pieces.some((p) => p.briefing_id === b.id))
                .sort((a, b) => (a.briefing_date < b.briefing_date ? 1 : -1));
              const row = candidates[0];
              return (row ? { ...row, focus_statement_at_briefing: null } : null) as T | null;
            }

            // Pending quiz lookup — none in these tests.
            if (normalized.startsWith("SELECT * FROM calibration_quizzes")) {
              return null as T | null;
            }

            throw new Error(`Unhandled SELECT.first in FakeD1: ${normalized}`);
          },

          async all<T>(): Promise<{ results: T[] }> {
            // Accept the new audit-aware SELECT shape (LEFT JOIN
            // audits a_piece / a_dd) as well as the legacy
            // `SELECT * FROM teaching_pieces ...`. The piece set is
            // the same either way; the audit columns are absent in
            // this fake DB and the route's buildAuditSummary helper
            // produces null for them, which is exactly the "no audit
            // yet" branch the no-content-reason tests want.
            if (
              normalized.includes("FROM teaching_pieces") &&
              normalized.includes("briefing_id") &&
              normalized.includes("ORDER BY") &&
              normalized.includes("position")
            ) {
              const [briefingId] = params as [string];
              const results = db.pieces
                .filter((p) => p.briefing_id === briefingId)
                .sort((a, b) => b.position - a.position);
              return { results: results as unknown as T[] };
            }

            if (normalized.startsWith("SELECT * FROM piece_resources WHERE teaching_piece_id = ?")) {
              return { results: [] as T[] };
            }

            throw new Error(`Unhandled SELECT.all in FakeD1: ${normalized}`);
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
      displayName: "Test User",
      focusStatement: null,
      focusVersionId: null,
      aboutStatement: null,
      aboutVersionId: null,
      timezone: "UTC",
      identity: { type: "dev", email: "test@example.com" },
      settings: null,
    });
    await next();
  });
  app.route("/api", briefingRoutes);
  return app;
}

function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

function makeBriefing(overrides: Partial<BriefingRow> = {}): BriefingRow {
  const now = new Date().toISOString();
  return {
    id: "brf_today",
    user_id: "user_1",
    briefing_date: isoDay(0),
    status: "generated",
    metadata: JSON.stringify({}),
    greeting: null,
    work_context_summary: null,
    work_context_sources: "[]",
    models_used: "{}",
    cancel_requested: 0,
    focus_version_id: null,
    redundant_drafts: null,
    generated_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makePiece(briefingId: string, position = 0): PieceRow {
  return {
    id: `pc_${briefingId}_${position}`,
    briefing_id: briefingId,
    position,
    title: "Test piece",
    content: "[]",
    concepts: "[]",
    source_context: "[]",
    model_used: null,
    feedback: null,
    read_at: null,
  };
}

let db: FakeD1;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  db = new FakeD1();
  app = makeApp(db);
});

async function getToday() {
  const res = await app.fetch(
    new Request("https://example.com/api/briefing/today"),
    { DB: db } as unknown as Record<string, unknown>,
  );
  return { status: res.status, body: (await res.json()) as { briefing: { noContentReason?: string | null } | null } };
}

describe("GET /api/briefing/today — noContentReason", () => {
  it("is null when the briefing has teaching pieces", async () => {
    const briefing = makeBriefing({ status: "generated" });
    db.briefings.push(briefing);
    db.pieces.push(makePiece(briefing.id));

    const { status, body } = await getToday();
    expect(status).toBe(200);
    expect(body.briefing?.noContentReason).toBeNull();
  });

  it("surfaces 'no_candidates' when a finalized briefing has zero pieces and that reason in metadata", async () => {
    db.briefings.push(
      makeBriefing({
        status: "generated",
        metadata: JSON.stringify({ reason: "no_candidates", totalPieces: 0 }),
      }),
    );

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBe("no_candidates");
  });

  it("surfaces 'all_pieces_failed' on a partial briefing with no pieces", async () => {
    db.briefings.push(
      makeBriefing({
        status: "partial",
        metadata: JSON.stringify({ reason: "all_pieces_failed", errors: ["x", "y"] }),
      }),
    );

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBe("all_pieces_failed");
  });

  it("surfaces 'monthly_budget_exceeded' on a failed briefing with that reason", async () => {
    db.briefings.push(
      makeBriefing({
        status: "failed",
        metadata: JSON.stringify({
          step: "failed",
          stepLabel: "Monthly budget cap exceeded",
          reason: "monthly_budget_exceeded",
        }),
      }),
    );

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBe("monthly_budget_exceeded");
  });

  it("falls back to 'unknown' when a finalized briefing has zero pieces but no reason in metadata", async () => {
    // Pre-existing rows from before the reason field shipped — the
    // worker shouldn't crash, the UI shouldn't misclassify them as
    // intentional. "unknown" is the conservative bucket.
    db.briefings.push(makeBriefing({ status: "generated", metadata: JSON.stringify({}) }));

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBe("unknown");
  });

  it("is null while the briefing is still generating, even with zero pieces", async () => {
    // During generation the row exists with 0 pieces by definition;
    // emitting noContentReason here would flicker an "empty" state
    // before pieces stream in.
    db.briefings.push(
      makeBriefing({
        status: "generating",
        metadata: JSON.stringify({ step: "work_context", stepLabel: "Fetching..." }),
      }),
    );

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBeNull();
  });

  it("is null on a successful briefing whose metadata happens to carry a reason field", async () => {
    // Defense-in-depth: if a stale `reason` somehow survived from a
    // prior generation but pieces were ultimately written, the read
    // endpoint must NOT report no-content — pieces.length is the
    // ground truth.
    const briefing = makeBriefing({
      status: "generated",
      metadata: JSON.stringify({ reason: "no_candidates" }),
    });
    db.briefings.push(briefing);
    db.pieces.push(makePiece(briefing.id, 0));
    db.pieces.push(makePiece(briefing.id, 1));

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBeNull();
  });

  it("falls back to a previous briefing-with-pieces when no row exists for today", async () => {
    // The fallback path predates this change but is exercised here
    // to confirm noContentReason on the fallback row reflects ITS
    // pieces (non-empty → null), not today's absence.
    const yesterday = makeBriefing({
      id: "brf_yesterday",
      briefing_date: isoDay(-1),
      status: "generated",
      metadata: JSON.stringify({}),
    });
    db.briefings.push(yesterday);
    db.pieces.push(makePiece(yesterday.id));

    const { body } = await getToday();
    expect(body.briefing?.noContentReason).toBeNull();
  });
});
