import { describe, it, expect, beforeEach } from "vitest";
import { recordTiming, measureStep } from "../../src/worker/services/timing";

interface InsertedRow {
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
}

class FakeD1 {
  public rows: InsertedRow[] = [];

  prepare(_sql: string) {
    const rows = this.rows;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const [
              id,
              briefing_id,
              user_id,
              step_key,
              started_at,
              finished_at,
              duration_ms,
              items_processed,
              model_used,
              metadata,
            ] = params as [
              string,
              string,
              string,
              string,
              string,
              string,
              number,
              number | null,
              string | null,
              string | null,
            ];
            rows.push({
              id,
              briefing_id,
              user_id,
              step_key,
              started_at,
              finished_at,
              duration_ms,
              items_processed,
              model_used,
              metadata,
            });
            return { success: true };
          },
        };
      },
    };
  }
}

let db: FakeD1;
beforeEach(() => {
  db = new FakeD1();
});

describe("recordTiming", () => {
  it("inserts a row with the expected columns", async () => {
    const startedAt = Date.now() - 5_000;
    await recordTiming(db as unknown as D1Database, {
      briefingId: "brf_x",
      userId: "usr_x",
      stepKey: "concepts",
      startedAt,
      itemsProcessed: 12,
      modelUsed: "claude-haiku-4-5-20251001",
      metadata: { batches: 3 },
    });
    expect(db.rows).toHaveLength(1);
    const r = db.rows[0];
    expect(r.briefing_id).toBe("brf_x");
    expect(r.user_id).toBe("usr_x");
    expect(r.step_key).toBe("concepts");
    expect(r.items_processed).toBe(12);
    expect(r.model_used).toBe("claude-haiku-4-5-20251001");
    expect(r.duration_ms).toBeGreaterThanOrEqual(4_900);
    expect(r.duration_ms).toBeLessThanOrEqual(6_000);
    expect(JSON.parse(r.metadata!)).toEqual({ batches: 3 });
    expect(r.id).toMatch(/^bt_/);
  });

  it("computes duration as max(0, finishedAt - startedAt)", async () => {
    await recordTiming(db as unknown as D1Database, {
      briefingId: "brf_x",
      userId: "usr_x",
      stepKey: "work_context",
      startedAt: 1000,
      finishedAt: 1500,
    });
    expect(db.rows[0].duration_ms).toBe(500);
  });

  it("clamps negative durations to 0 (clock skew safety)", async () => {
    await recordTiming(db as unknown as D1Database, {
      briefingId: "brf_x",
      userId: "usr_x",
      stepKey: "work_context",
      startedAt: 2000,
      finishedAt: 1000,
    });
    expect(db.rows[0].duration_ms).toBe(0);
  });

  it("does not throw if the underlying insert fails", async () => {
    const failingDb = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error("D1 unavailable");
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      recordTiming(failingDb, {
        briefingId: "brf_x",
        userId: "usr_x",
        stepKey: "concepts",
        startedAt: Date.now(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("measureStep", () => {
  it("records on success and returns the result", async () => {
    const out = await measureStep(
      db as unknown as D1Database,
      "brf_x",
      "usr_x",
      "concepts",
      async () => ({ concepts: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      { modelUsed: "claude-haiku-4-5-20251001" },
    );

    expect(out.ok).toBe(true);
    expect(out.itemsProcessed).toBe(3);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].step_key).toBe("concepts");
    expect(db.rows[0].items_processed).toBe(3);
  });

  it("records timing AND rethrows on failure", async () => {
    const error = new Error("fetch hung");
    await expect(
      measureStep(
        db as unknown as D1Database,
        "brf_x",
        "usr_x",
        "adjacent",
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].step_key).toBe("adjacent");
    expect(db.rows[0].items_processed).toBeNull();
    expect(JSON.parse(db.rows[0].metadata!)).toMatchObject({ error: expect.stringContaining("fetch hung") });
  });

  it("infers item count from arrays returned directly", async () => {
    const out = await measureStep(
      db as unknown as D1Database,
      "brf_x",
      "usr_x",
      "work_context",
      async () => [1, 2, 3, 4, 5],
    );
    expect(out.itemsProcessed).toBe(5);
  });
});
