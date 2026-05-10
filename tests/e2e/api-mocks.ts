import type { Page, Route } from "@playwright/test";

/**
 * In-browser API mocking for Playwright E2E.
 *
 * Every `/api/*` request the frontend makes gets intercepted at the
 * browser level via `page.route()`. This means E2E tests never reach
 * a real worker, never need a Cloudflare account, and never depend
 * on Linear / Slack / GitHub / incident.io creds. The Vite preview
 * server only ever serves static assets.
 *
 * The default mock-set covers the calls FirstRunSetup + Settings
 * make on first paint. Tests can override individual endpoints via
 * `mockApi(page, { '/api/me': customResponse, ... })` — earlier
 * routes win, so a per-test override registered after the defaults
 * takes precedence on the same path.
 *
 * Recording stub: `recorder.calls` accumulates `{ method, url,
 * body }` for every intercepted request, which lets a test assert
 * that the frontend actually hit a particular endpoint with a
 * particular payload — the E2E equivalent of `expect(mock).toHaveBeenCalled`.
 */

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RecordedCall {
  method: Method;
  url: string;
  body: unknown;
}

export interface ApiRecorder {
  calls: RecordedCall[];
  byPath(pathSuffix: string): RecordedCall[];
}

export interface MockOverrides {
  // Map of "/api/path" → response body OR a function returning one.
  // Functions get the request body so tests can vary the response
  // by what was sent.
  [path: string]: unknown | ((reqBody: unknown) => unknown);
}

const DEFAULT_USER = {
  email: "test@example.com",
  displayName: "Test User",
  avatarUrl: null,
  focusStatement: null,
  focusVersionId: null,
  aboutStatement: null,
  aboutVersionId: null,
  settings: {
    budgetCapMonthly: 35,
    briefingCron: "0 5 * * *",
    relevanceThreshold: 0.4,
    nearMissFloor: 0.25,
    retentionDays: 365,
    signalSurfaceMap: {},
  },
  identity: { email: "test@example.com", type: "dev-header" },
  isAdmin: true,
  needsBootstrapWelcome: false,
};

const DEFAULT_SOURCES = {
  sources: [
    { id: "linear", name: "Linear", multiInstance: false, available: true, settingsManifest: null },
    { id: "slack", name: "Slack", multiInstance: false, available: true, settingsManifest: null },
    { id: "github", name: "GitHub", multiInstance: false, available: true, settingsManifest: null },
    { id: "incident_io", name: "incident.io", multiInstance: false, available: true, settingsManifest: null },
  ],
};

const DEFAULT_SUGGESTIONS = {
  suggestions: [
    { id: "linear", recommended: true, rationale: "Matches your engineering background." },
    { id: "github", recommended: true, rationale: "Aligns with your interest in shipping." },
    { id: "slack", recommended: false, rationale: "" },
    { id: "incident_io", recommended: false, rationale: "" },
  ],
};

/**
 * Install the default mock-set on a page. Returns a recorder so
 * tests can assert on what the frontend ended up calling.
 *
 * Order matters. Playwright matches `page.route` handlers in
 * REVERSE registration order — the most-recently-added route runs
 * first. So we register them outermost-first: the wildcard
 * fallback goes on first (so it runs last), then the canned
 * defaults, then per-test overrides last (so they run first and
 * win over both).
 */
export async function mockApi(page: Page, overrides: MockOverrides = {}): Promise<ApiRecorder> {
  const calls: RecordedCall[] = [];
  const recorder: ApiRecorder = {
    calls,
    byPath: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix) || c.url.includes(suffix)),
  };

  // Wildcard fallback for any /api/* the test didn't anticipate.
  // Returns 200 with an empty object so the frontend's optional
  // background loads (briefings list, models catalog, tts voices,
  // etc.) don't error and tank the test. Registered FIRST so it
  // runs LAST — anything matched by a more specific route below
  // shadows this catch-all.
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const reqBody = req.postData();
    let parsed: unknown = null;
    try {
      parsed = reqBody ? JSON.parse(reqBody) : null;
    } catch {
      parsed = reqBody;
    }
    calls.push({ method: req.method() as Method, url: req.url(), body: parsed });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  // Default canned shapes for the calls the app makes on first
  // paint. Registered AFTER the wildcard so they win over it, but
  // BEFORE per-test overrides so the overrides win over these.
  //
  // Anything App.tsx / Header.tsx / BriefingPage fire automatically
  // needs to be here — `{}` from the wildcard fallback is enough
  // for hooks that swallow malformed shapes, but several of them
  // (`useNotifications`, `useBriefing`, `useBookmarks`) read fields
  // off the response without a default and crash the React tree if
  // the shape is wrong. Crashing during initial paint hides the
  // FirstRunSetup overlay this spec is trying to drive, which is
  // why this list looks long for a single-spec test.
  const defaults: Record<string, unknown> = {
    "/api/me": DEFAULT_USER,
    "/api/sources": DEFAULT_SOURCES,
    "/api/sources/suggest-enabled": DEFAULT_SUGGESTIONS,
    "/api/settings": { settings: DEFAULT_USER.settings },
    "/api/me/about": { ok: true },
    "/api/me/focus": { ok: true },
    "/api/notifications": { notifications: [], unreadCount: 0, inProgressCount: 0 },
    "/api/briefing/today": { briefing: null, pieces: [], quiz: null },
    "/api/bookmarks": { bookmarks: [] },
  };

  for (const [path, body] of Object.entries(defaults)) {
    if (path in overrides) continue; // already handled
    await page.route(`**${path}`, async (route: Route) => {
      const req = route.request();
      const reqBody = req.postData();
      let parsed: unknown = null;
      try {
        parsed = reqBody ? JSON.parse(reqBody) : null;
      } catch {
        parsed = reqBody;
      }
      calls.push({ method: req.method() as Method, url: req.url(), body: parsed });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }

  // Per-test overrides go on LAST so they're matched FIRST and
  // shadow both the defaults and the wildcard.
  for (const [path, body] of Object.entries(overrides)) {
    await page.route(`**${path}`, async (route: Route) => {
      const req = route.request();
      const reqBody = req.postData();
      let parsed: unknown = null;
      try {
        parsed = reqBody ? JSON.parse(reqBody) : null;
      } catch {
        parsed = reqBody;
      }
      calls.push({ method: req.method() as Method, url: req.url(), body: parsed });
      const resolved = typeof body === "function" ? (body as (b: unknown) => unknown)(parsed) : body;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(resolved),
      });
    });
  }

  return recorder;
}
