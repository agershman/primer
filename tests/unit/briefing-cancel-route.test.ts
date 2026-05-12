import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { briefingRoutes } from "../../src/worker/routes/briefing";

/**
 * In-memory D1 shim that understands the specific SQL the cancel/status
 * routes issue. We intentionally keep this minimal — if a test needs a query
 * that isn't matched below, add an explicit branch rather than a catch-all.
 */
type BriefingRow = {
  id: string;
  user_id: string;
  briefing_date: string;
  status: string;
  metadata: string;
  cancel_requested: number;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
};

class FakeD1 {
  public briefings: BriefingRow[] = [];

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();

    return {
      bind(...params: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            if (normalized.startsWith("SELECT id, status, updated_at FROM briefings WHERE user_id = ? AND briefing_date = ?")) {
              const [userId, date] = params as [string, string];
              const row = db.briefings.find((b) => b.user_id === userId && b.briefing_date === date);
              return (row
                ? { id: row.id, status: row.status, updated_at: row.updated_at }
                : null) as T | null;
            }

            if (normalized.startsWith("SELECT status, generated_at, created_at, updated_at, metadata, cancel_requested FROM briefings")) {
              const [userId, date] = params as [string, string];
              const row = db.briefings.find((b) => b.user_id === userId && b.briefing_date === date);
              return (row
                ? {
                    status: row.status,
                    generated_at: row.generated_at,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    metadata: row.metadata,
                    cancel_requested: row.cancel_requested,
                  }
                : null) as T | null;
            }

            if (normalized.startsWith("SELECT id FROM briefings WHERE user_id = ? AND briefing_date = ?")) {
              const [userId, date] = params as [string, string];
              const row = db.briefings.find((b) => b.user_id === userId && b.briefing_date === date);
              return (row ? { id: row.id } : null) as T | null;
            }

            // ETA query: averages elapsed time per briefing from the
            // `briefing_timings` table. The status route only uses the
            // result for cosmetic ETA copy, so returning null here is
            // safe — the UI falls back to "this usually takes 1–2 min".
            if (normalized.includes("FROM briefing_timings") && normalized.includes("AVG(elapsed_seconds)")) {
              return { avg_seconds: null } as T;
            }

            throw new Error(`Unhandled SELECT in FakeD1: ${normalized}`);
          },

          async run() {
            if (normalized.startsWith("UPDATE briefings SET cancel_requested = 1")) {
              const [id] = params as [string];
              const row = db.briefings.find((b) => b.id === id);
              if (row) row.cancel_requested = 1;
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }

            if (normalized.startsWith("UPDATE calibration_quizzes SET teaching_piece_id = NULL")) {
              return { success: true, meta: { changes: 0 } };
            }

            if (normalized.startsWith("DELETE FROM briefings WHERE user_id = ? AND briefing_date = ?")) {
              const [userId, date] = params as [string, string];
              const before = db.briefings.length;
              db.briefings = db.briefings.filter(
                (b) => !(b.user_id === userId && b.briefing_date === date),
              );
              return { success: true, meta: { changes: before - db.briefings.length } };
            }

            throw new Error(`Unhandled UPDATE/DELETE in FakeD1: ${normalized}`);
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
      identity: { type: "dev", email: "test@example.com" },
      settings: null,
    });
    await next();
  });
  app.route("/api", briefingRoutes);
  return app;
}

function makeBriefing(overrides: Partial<BriefingRow> = {}): BriefingRow {
  const today = new Date().toISOString().split("T")[0];
  return {
    id: "brf_test",
    user_id: "user_1",
    briefing_date: today,
    status: "generating",
    metadata: JSON.stringify({ step: "work_context", stepLabel: "Fetching…" }),
    cancel_requested: 0,
    generated_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

let db: FakeD1;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  db = new FakeD1();
  app = makeApp(db);
});

async function fetchJson(path: string, init?: RequestInit) {
  const res = await app.fetch(
    new Request(`https://example.com${path}`, init),
    { DB: db } as unknown as Record<string, unknown>,
  );
  return { status: res.status, body: await res.json() };
}

describe("POST /api/briefing/cancel", () => {
  it("returns 404 when no briefing exists for today", async () => {
    const { status, body } = await fetchJson("/api/briefing/cancel", { method: "POST" });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "No briefing to cancel" });
  });

  it("returns 400 when today's briefing is not currently generating", async () => {
    db.briefings.push(makeBriefing({ status: "generated" }));
    const { status, body } = await fetchJson("/api/briefing/cancel", { method: "POST" });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "Briefing is not currently generating" });
  });

  it("sets cancel_requested = 1 on a generating briefing", async () => {
    db.briefings.push(makeBriefing({ status: "generating" }));
    const { status, body } = await fetchJson("/api/briefing/cancel", { method: "POST" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, briefingId: "brf_test" });
    expect(db.briefings[0].cancel_requested).toBe(1);
  });

  it("preserves metadata untouched (no race with progress writes)", async () => {
    const originalMeta = JSON.stringify({
      step: "generating_pieces",
      stepLabel: "Writing piece 3/5",
      details: ["✓ Kubernetes", "✓ gRPC"],
    });
    db.briefings.push(makeBriefing({ status: "generating", metadata: originalMeta }));
    await fetchJson("/api/briefing/cancel", { method: "POST" });
    expect(db.briefings[0].metadata).toBe(originalMeta);
  });

  it("is idempotent — cancelling an already-cancelled briefing still succeeds", async () => {
    db.briefings.push(makeBriefing({ status: "generating", cancel_requested: 1 }));
    const { status } = await fetchJson("/api/briefing/cancel", { method: "POST" });
    expect(status).toBe(200);
    expect(db.briefings[0].cancel_requested).toBe(1);
  });

  it("scopes by user — cannot cancel another user's briefing", async () => {
    db.briefings.push(makeBriefing({ user_id: "other_user", status: "generating" }));
    const { status } = await fetchJson("/api/briefing/cancel", { method: "POST" });
    expect(status).toBe(404);
    expect(db.briefings[0].cancel_requested).toBe(0);
  });
});

describe("GET /api/briefing/status", () => {
  it("returns cancelRequested: false for a normal generating briefing", async () => {
    db.briefings.push(makeBriefing({ status: "generating", cancel_requested: 0 }));
    const { status, body } = await fetchJson("/api/briefing/status");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "generating",
      cancelRequested: false,
      stuck: false,
    });
  });

  it("returns cancelRequested: true after cancel is requested", async () => {
    db.briefings.push(makeBriefing({ status: "generating", cancel_requested: 1 }));
    const { body } = await fetchJson("/api/briefing/status");
    expect(body).toMatchObject({
      status: "generating",
      cancelRequested: true,
    });
  });

  it("returns idle status when no briefing exists", async () => {
    const { body } = await fetchJson("/api/briefing/status");
    expect(body).toMatchObject({ status: "idle", cancelRequested: false, stuck: false });
  });

  it("flags a generating briefing as stuck when updated_at is stale", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    db.briefings.push(makeBriefing({ status: "generating", updated_at: tenMinutesAgo }));
    const { body } = await fetchJson("/api/briefing/status") as unknown as {
      body: { stuck: boolean; status: string };
    };
    expect(body.stuck).toBe(true);
    expect(body.status).toBe("generating");
  });

  it("does NOT flag stuck when updated_at is recent", async () => {
    const justNow = new Date(Date.now() - 10_000).toISOString();
    db.briefings.push(makeBriefing({ status: "generating", updated_at: justNow }));
    const { body } = await fetchJson("/api/briefing/status") as unknown as {
      body: { stuck: boolean };
    };
    expect(body.stuck).toBe(false);
  });

  it("does NOT flag stuck on a completed briefing even if old", async () => {
    const anHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    db.briefings.push(makeBriefing({ status: "generated", updated_at: anHourAgo }));
    const { body } = await fetchJson("/api/briefing/status") as unknown as {
      body: { stuck: boolean };
    };
    expect(body.stuck).toBe(false);
  });
});

describe("POST /api/briefing/reset", () => {
  it("force-deletes today's briefing regardless of status", async () => {
    db.briefings.push(makeBriefing({ status: "generating" }));
    const { status, body } = await fetchJson("/api/briefing/reset", { method: "POST" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, deleted: true });
    expect(db.briefings).toHaveLength(0);
  });

  it("works even on a completed briefing (escape hatch)", async () => {
    db.briefings.push(makeBriefing({ status: "generated" }));
    const { body } = await fetchJson("/api/briefing/reset", { method: "POST" });
    expect(body).toMatchObject({ ok: true, deleted: true });
    expect(db.briefings).toHaveLength(0);
  });

  it("reports deleted: false when no row existed", async () => {
    const { status, body } = await fetchJson("/api/briefing/reset", { method: "POST" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, deleted: false });
  });

  it("scopes by user — cannot reset another user's briefing", async () => {
    db.briefings.push(makeBriefing({ user_id: "other_user", status: "generating" }));
    const { body } = await fetchJson("/api/briefing/reset", { method: "POST" });
    expect(body).toMatchObject({ ok: true, deleted: false });
    expect(db.briefings).toHaveLength(1);
  });
});
