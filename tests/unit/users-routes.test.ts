// @vitest-environment node
/**
 * Execution tests for the users-management routes.
 *
 * Covers the load-bearing branches the source-text contract test
 * can't reach:
 *
 *   - Last-admin demotion is refused with 409 when the target is
 *     the only admin remaining. Without this, a single-admin
 *     deployment could lock itself out via the UI.
 *   - Self-demotion is allowed when another admin exists, and the
 *     response includes `selfDemoted: true` so the frontend can
 *     refresh /api/me upstream.
 *   - The PATCH response shape mirrors the GET row shape so the
 *     panel can patch its local list optimistically.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { userRoutes } from "../../src/worker/routes/users";

interface FakeUserRow {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: number;
  created_at: string;
  welcomed_as_admin_at: string | null;
}

class FakeD1 {
  public users: FakeUserRow[] = [];

  prepare(sql: string) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();

    const runWithParams = (params: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (normalized.startsWith("SELECT id, is_admin FROM users WHERE id = ?")) {
          const [id] = params as [string];
          const row = db.users.find((u) => u.id === id);
          return (row ? { id: row.id, is_admin: row.is_admin } : null) as T | null;
        }
        if (normalized.startsWith("SELECT COUNT(*) as count FROM users WHERE is_admin = 1")) {
          const count = db.users.filter((u) => u.is_admin === 1).length;
          return { count } as T;
        }
        if (
          normalized.startsWith(
            "SELECT id, email, display_name, is_admin, created_at, welcomed_as_admin_at FROM users WHERE id = ?",
          )
        ) {
          const [id] = params as [string];
          const row = db.users.find((u) => u.id === id);
          return row ? ({ ...row } as unknown as T) : null;
        }
        throw new Error(`Unhandled SELECT.first in FakeD1: ${normalized}`);
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (
          normalized.startsWith(
            "SELECT id, email, display_name, is_admin, created_at, welcomed_as_admin_at FROM users",
          )
        ) {
          return { results: db.users.map((u) => ({ ...u })) as unknown as T[] };
        }
        throw new Error(`Unhandled SELECT.all in FakeD1: ${normalized}`);
      },
      async run() {
        if (normalized.startsWith("UPDATE users SET is_admin = ?")) {
          const [isAdmin, id] = params as [number, string];
          const row = db.users.find((u) => u.id === id);
          if (row) row.is_admin = isAdmin;
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        throw new Error(`Unhandled UPDATE/DELETE in FakeD1: ${normalized}`);
      },
    });

    // D1 lets callers either `.bind(...).all()` or `.all()` directly
    // when the query has no parameters. Mirror that here so route
    // code calling `.prepare(sql).all()` (without `.bind`) works
    // the same as in production.
    return {
      bind(...params: unknown[]) {
        return runWithParams(params);
      },
      ...runWithParams([]),
    };
  }
}

function makeApp(callerId: string, callerIsAdmin: boolean) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", {
      userId: callerId,
      email: "caller@acme.test",
      displayName: "Caller",
      identity: { type: "access", email: "caller@acme.test" },
      isAdmin: callerIsAdmin,
      isDev: false,
      welcomedAsAdminAt: null,
      timezone: "UTC",
      focusStatement: null,
      focusVersionId: null,
      aboutStatement: null,
      aboutVersionId: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal shim
      settings: {} as any,
    });
    await next();
  });
  app.route("/api", userRoutes);
  return app;
}

async function callApi(
  app: Hono,
  db: FakeD1,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await app.fetch(
    new Request(`https://example.com${path}`, init),
    { DB: db } as unknown as Record<string, unknown>,
  );
  return { status: res.status, body: await res.json() };
}

function seedDb(): FakeD1 {
  const db = new FakeD1();
  db.users = [
    {
      id: "usr_a",
      email: "alice@acme.test",
      display_name: "Alice",
      is_admin: 1,
      created_at: "2026-01-01T00:00:00Z",
      welcomed_as_admin_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "usr_b",
      email: "bob@acme.test",
      display_name: "Bob",
      is_admin: 0,
      created_at: "2026-02-01T00:00:00Z",
      welcomed_as_admin_at: null,
    },
  ];
  return db;
}

describe("Users routes — admin gating", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = seedDb();
  });

  it("GET /api/users returns 403 for non-admin callers", async () => {
    const app = makeApp("usr_b", false);
    const { status } = await callApi(app, db, "/api/users");
    expect(status).toBe(403);
  });

  it("GET /api/users returns the full list for admins", async () => {
    const app = makeApp("usr_a", true);
    const { status, body } = await callApi(app, db, "/api/users");
    expect(status).toBe(200);
    const typed = body as { users: Array<{ email: string; isAdmin: boolean }> };
    expect(typed.users).toHaveLength(2);
    expect(typed.users[0].email).toBe("alice@acme.test");
    expect(typed.users[0].isAdmin).toBe(true);
    expect(typed.users[1].isAdmin).toBe(false);
  });

  it("PATCH /api/users/:id returns 403 for non-admin callers", async () => {
    const app = makeApp("usr_b", false);
    const { status } = await callApi(app, db, "/api/users/usr_b", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: true }),
    });
    expect(status).toBe(403);
  });
});

describe("Users routes — last-admin guard", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = seedDb();
  });

  it("PATCH /api/users/:id refuses to demote the only remaining admin (409)", async () => {
    // Alice is the only admin. Demoting her would lock the
    // deployment into an unconfigurable state — recovery would
    // require D1 SQL access, which is exactly what the UI exists
    // to avoid.
    const app = makeApp("usr_a", true);
    const { status, body } = await callApi(app, db, "/api/users/usr_a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: false }),
    });
    expect(status).toBe(409);
    const typed = body as { error: string; reason: string };
    expect(typed.error).toBe("Last admin");
    expect(typed.reason).toMatch(/Promote another user/i);
    // Alice is unchanged.
    expect(db.users.find((u) => u.id === "usr_a")?.is_admin).toBe(1);
  });

  it("permits self-demotion when another admin exists, returns selfDemoted: true", async () => {
    // Promote Bob first so Alice has a peer.
    db.users.find((u) => u.id === "usr_b")!.is_admin = 1;
    const app = makeApp("usr_a", true);
    const { status, body } = await callApi(app, db, "/api/users/usr_a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: false }),
    });
    expect(status).toBe(200);
    const typed = body as { user: { isAdmin: boolean }; selfDemoted: boolean };
    expect(typed.user.isAdmin).toBe(false);
    expect(typed.selfDemoted).toBe(true);
    expect(db.users.find((u) => u.id === "usr_a")?.is_admin).toBe(0);
  });

  it("promoting a regular user to admin returns selfDemoted: false", async () => {
    const app = makeApp("usr_a", true);
    const { status, body } = await callApi(app, db, "/api/users/usr_b", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: true }),
    });
    expect(status).toBe(200);
    const typed = body as { user: { isAdmin: boolean }; selfDemoted: boolean };
    expect(typed.user.isAdmin).toBe(true);
    expect(typed.selfDemoted).toBe(false);
  });

  it("returns 404 when the target user doesn't exist", async () => {
    const app = makeApp("usr_a", true);
    const { status } = await callApi(app, db, "/api/users/usr_nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAdmin: true }),
    });
    expect(status).toBe(404);
  });

  it("returns 400 when the body lacks isAdmin: boolean", async () => {
    const app = makeApp("usr_a", true);
    const { status } = await callApi(app, db, "/api/users/usr_b", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
  });
});
