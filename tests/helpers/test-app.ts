import { Hono } from "hono";
import type { Env, UserContext, UserSettings } from "../../src/worker/types.js";
import type { FakeD1 } from "./d1-fake";

/**
 * Minimum-viable Hono app for route integration tests.
 *
 * Production's auth middleware (`userContext`) talks to Cloudflare
 * Access JWT claims to derive the request user; that middleware is
 * not what we're testing here, so this helper bypasses it and
 * injects a known `UserContext` directly. Tests can override fields
 * like `isAdmin` or `userId` to exercise admin gating without
 * spinning up a real auth provider.
 *
 * The `db` and any other env bindings get attached to `c.env` so
 * routes that read `c.env.DB` work unchanged. Cast `FakeD1 as
 * unknown as D1Database` at the call site — the surface our routes
 * touch (prepare/bind/run/first/all) is faithfully implemented.
 */

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export interface BuildAppOptions {
  db: FakeD1;
  /** Per-request user. Tests typically override `isAdmin` and
   *  `userId`. The settings reader assumes a non-null `settings`
   *  object — we provide a minimal default. */
  user?: Partial<UserContext>;
  /** Additional env bindings (e.g. ANTHROPIC_API_KEY for routes
   *  that gate on key presence). Merged onto a default empty
   *  binding map. */
  envOverrides?: Partial<Env>;
  /** Mounts to register on `/api`. Pass the production route
   *  modules — tests can mount only the ones they exercise. */
  mount: Array<(app: Hono<AppEnv>) => void>;
}

export interface TestApp {
  app: Hono<AppEnv>;
  env: Env;
}

function defaultSettings(): UserSettings {
  return {
    budgetCapMonthly: 35,
    briefingCron: "0 5 * * 1-5",
    relevanceThreshold: 0.4,
    nearMissFloor: 0.25,
    retentionDays: 365,
    signalSurfaceMap: {},
    filterPrompt: null,
    sourceFilterOverrides: {},
    enabledSourceIds: [],
  };
}

export function buildTestApp(opts: BuildAppOptions): TestApp {
  const app = new Hono<AppEnv>();

  // Inject a fake user context on every request — this is what
  // production's `userContext` middleware would have set.
  app.use("*", async (c, next) => {
    const user: UserContext = {
      userId: "usr_test",
      email: "test@example.com",
      displayName: "Test User",
      focusStatement: null,
      focusVersionId: null,
      aboutStatement: null,
      aboutVersionId: null,
      timezone: "UTC",
      settings: defaultSettings(),
      identity: { email: "test@example.com" },
      isDev: true,
      isAdmin: true,
      welcomedAsAdminAt: null,
      ...(opts.user ?? {}),
    };
    c.set("user", user);
    await next();
  });

  // The `c.env` bag — production gets `Env` from the worker
  // runtime; in tests we pass the same shape in as the second
  // argument to `app.fetch()`. The `request` helper below
  // remembers to pass this so callers don't have to.
  const env: Env = {
    DB: opts.db as unknown as D1Database,
    AI: {} as Ai,
    ANTHROPIC_API_KEY: "",
    LINEAR_API_KEY: "",
    SLACK_TOKEN: "",
    INCIDENT_IO_API_KEY: "",
    BUDGET_CAP_MONTHLY: "35",
    RETENTION_DAYS: "365",
    NEAR_MISS_RETENTION_DAYS: "30",
    RELEVANCE_THRESHOLD: "0.4",
    NEAR_MISS_FLOOR: "0.25",
    PRIMER_AUTH_MODE: "dev-header",
    ...(opts.envOverrides ?? {}),
  };

  for (const m of opts.mount) m(app);

  return { app, env };
}

/**
 * Convenience: issue a JSON request against the test app, parse
 * the response. Most tests want `(testApp, "PATCH", "/api/settings",
 * { …body })` and don't care about lower-level Request setup.
 */
export async function request<T = unknown>(
  testApp: TestApp,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  // Hono accepts a Request and an env binding object as the second
  // argument, plumbing it into `c.env` for the duration of the
  // request. Pass the per-test env so route handlers see DB and
  // any keys we configured.
  const res = await testApp.app.fetch(new Request(`http://test${path}`, init), testApp.env);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
  return { status: res.status, json };
}
