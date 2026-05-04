import Database from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Test-only D1Database adapter backed by an in-memory better-sqlite3
 * connection. Implements just the surface our worker code touches —
 * `prepare(sql).bind(...).run() / .first() / .all()` — so a route
 * handler that already targets `D1Database` can run unmodified
 * against this fake.
 *
 * Why a custom adapter instead of `@cloudflare/vitest-pool-workers`:
 *
 *   1. Zero infrastructure to add — no workerd binary, no separate
 *      vitest pool config, no service-worker module-format
 *      ceremony for tests that just want to assert on JSON
 *      responses.
 *   2. The CI runner is plain ubuntu — no Cloudflare account, no
 *      special permissions. better-sqlite3 builds against the
 *      stock node toolchain.
 *   3. The diverging semantics between SQLite and D1 (locking,
 *      batch atomicity, distributed transactions) don't matter
 *      for the routes we need to cover here. If a future route
 *      depends on D1-specific semantics we can layer
 *      vitest-pool-workers in just for that surface.
 *
 * Migration application is included so each test gets a fresh DB
 * with the same schema the worker sees in production.
 */

type Bindable = string | number | bigint | boolean | null | Uint8Array;

interface FakePreparedStatement {
  bind(...values: Bindable[]): FakePreparedStatement;
  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ success: true; results: T[] }>;
}

export interface FakeD1 {
  // The shape Hono's `c.env.DB` references at runtime — only the
  // methods we actually call. Cast to `D1Database` at the call site
  // when handing it to a Hono app.
  prepare(sql: string): FakePreparedStatement;
  exec(sql: string): Promise<void>;
  /** Test-only escape hatch — direct access to better-sqlite3 for
   *  setup / introspection. Don't use in route code. */
  raw: Database.Database;
}

function makePreparedStatement(
  db: Database.Database,
  sql: string,
  bound: Bindable[] = [],
): FakePreparedStatement {
  return {
    bind(...values: Bindable[]): FakePreparedStatement {
      return makePreparedStatement(db, sql, [...bound, ...values]);
    },
    async run() {
      const stmt = db.prepare(sql);
      const result = stmt.run(...(bound as unknown as Bindable[]));
      return {
        success: true as const,
        meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
      };
    },
    async first<T = unknown>(): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...(bound as unknown as Bindable[]));
      return (row as T | undefined) ?? null;
    },
    async all<T = unknown>(): Promise<{ success: true; results: T[] }> {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(bound as unknown as Bindable[]));
      return { success: true as const, results: rows as T[] };
    },
  };
}

export function makeFakeD1(): FakeD1 {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  return {
    prepare(sql: string) {
      return makePreparedStatement(db, sql);
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    raw: db,
  };
}

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Apply every migration file from `migrations/` in numeric order to
 * the given fake D1. Mirrors what `bun run db:migrate` does in
 * production but inline, so each test gets a fresh schema without
 * shelling out to wrangler.
 *
 * The optional `upTo` argument lets a test apply only a prefix of
 * migrations — useful for asserting "what does the DB look like
 * after 0004 but before 0005?" the way the incident_io regression
 * would have surfaced.
 */
export async function applyMigrations(d1: FakeD1, opts: { upTo?: string } = {}): Promise<string[]> {
  const dir = resolve(REPO_ROOT, "migrations");
  const entries = await readdir(dir);
  const files = entries.filter((e) => e.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (opts.upTo && file > opts.upTo) break;
    const sql = await readFile(resolve(dir, file), "utf-8");
    d1.raw.exec(sql);
    applied.push(file);
  }
  return applied;
}
