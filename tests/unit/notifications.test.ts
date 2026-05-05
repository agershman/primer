import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("consolidated schema + bootstrap registration", () => {
  it("has notifications table with kind/status/title/payload + index", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("CREATE TABLE notifications");
    // Lifecycle states pinned in CHECK constraint so we can never
    // transition into an unrecognised state without a migration.
    expect(sql).toMatch(/CHECK \(status IN \('in_progress', 'ready', 'failed', 'dismissed'\)\)/);
    // Display + dispatch fields
    expect(sql).toMatch(/title TEXT NOT NULL/);
    expect(sql).toMatch(/body TEXT/);
    expect(sql).toMatch(/action_url TEXT/);
    expect(sql).toMatch(/payload TEXT NOT NULL DEFAULT '\{\}'/);
    // Acknowledged separate from dismissed: a row can be "seen" but
    // still in the list as a record.
    expect(sql).toMatch(/acknowledged_at TEXT/);
    // Indexes for fast bell polling.
    expect(sql).toMatch(/CREATE INDEX[\s\S]*?ON notifications\(user_id, status, created_at DESC\)/);
    expect(sql).toMatch(/CREATE INDEX[\s\S]*?ON notifications\(user_id, acknowledged_at\)/);
  });

  it("bootstrap-remote-migrations.sh tracks 0015 as already applied", async () => {
    const src = await read("scripts/bootstrap-remote-migrations.sh");
    expect(src).toContain("0015_notifications.sql");
  });
});

describe("notifications queries", () => {
  it("exposes the full lifecycle (create, transition, acknowledge, dismiss, reap)", async () => {
    const src = await read("src/worker/db/notifications-queries.ts");
    expect(src).toContain("export async function createNotification");
    expect(src).toContain("export async function transitionNotification");
    expect(src).toContain("export async function listActiveNotifications");
    expect(src).toContain("export async function acknowledgeNotification");
    expect(src).toContain("export async function acknowledgeAllNotifications");
    expect(src).toContain("export async function dismissNotification");
    expect(src).toContain("export async function dismissAllNotifications");
    expect(src).toContain("export async function reapStuckNotifications");
  });

  it("dismissAllNotifications skips in_progress rows so it can't kill in-flight work", async () => {
    const src = await read("src/worker/db/notifications-queries.ts");
    // Only ready/failed rows get cleared; in_progress is owned by
    // ActivityIndicator and a bell "Clear all" must not touch it.
    expect(src).toMatch(/dismissAllNotifications[\s\S]{0,400}status IN \('ready', 'failed'\)/);
  });

  it("listActiveNotifications excludes dismissed rows and orders newest first", async () => {
    const src = await read("src/worker/db/notifications-queries.ts");
    expect(src).toContain("status != 'dismissed'");
    expect(src).toMatch(/ORDER BY created_at DESC/);
  });

  it("reapStuckNotifications flips in-flight rows older than the threshold to failed", async () => {
    const src = await read("src/worker/db/notifications-queries.ts");
    expect(src).toMatch(/SET status = 'failed'/);
    expect(src).toMatch(/status = 'in_progress'/);
    expect(src).toMatch(/updated_at < datetime\('now', '-' \|\| \? \|\| ' minutes'\)/);
  });
});

describe("notifications routes", () => {
  it("exposes list / acknowledge / acknowledge-all / dismiss / dismiss-all handlers", async () => {
    const src = await read("src/worker/routes/notifications.ts");
    expect(src).toMatch(/notificationRoutes\.get\("\/notifications"/);
    expect(src).toMatch(/notificationRoutes\.post\("\/notifications\/:id\/acknowledge"/);
    expect(src).toMatch(/notificationRoutes\.post\("\/notifications\/acknowledge-all"/);
    expect(src).toMatch(/notificationRoutes\.post\("\/notifications\/:id\/dismiss"/);
    expect(src).toMatch(/notificationRoutes\.post\("\/notifications\/dismiss-all"/);
  });

  it("list response includes unreadCount and inProgressCount aggregates", async () => {
    const src = await read("src/worker/routes/notifications.ts");
    // unread = ready/failed AND not yet acknowledged; in-progress
    // counted regardless of acknowledged_at.
    expect(src).toContain("unreadCount");
    expect(src).toContain("inProgressCount");
    expect(src).toMatch(/n\.status === "in_progress"/);
    expect(src).toMatch(/n\.acknowledgedAt/);
  });

  it("worker mounts the notification route bundle on /api", async () => {
    const src = await read("src/worker/index.ts");
    expect(src).toContain('import { notificationRoutes } from "./routes/notifications.js"');
    expect(src).toContain('app.route("/api", notificationRoutes)');
  });
});

describe("deep-dive emits notifications + survives navigation", () => {
  it("creates a notification at start, transitions on ready/failed, runs in foreground via streaming response", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    // Notification import is wired.
    expect(src).toContain("createNotification");
    expect(src).toContain("transitionNotification");
    // Start: kind=deep_dive with action_url back to the deep-dive view.
    expect(src).toMatch(/kind:\s*"deep_dive"/);
    expect(src).toMatch(/actionUrl:\s*`\/briefing\/\$\{piece\.briefing_date\}\/\$\{pieceId\}`/);
    // Success transition.
    expect(src).toMatch(/transitionNotification\([\s\S]{0,200}status:\s*"ready"/);
    // Failure transition.
    expect(src).toMatch(/transitionNotification\([\s\S]{0,200}status:\s*"failed"/);
    // Background-survival: generation runs in the foreground while
    // a streaming response keeps the worker alive. Earlier shape used
    // `c.executionCtx.waitUntil(generationPromise)` which got
    // cancelled at Cloudflare's documented 30s post-response cap on
    // waitUntil. The streaming pattern keeps the request open for the
    // full LLM duration. See ADR 0005 for the runtime evidence.
    expect(src).toContain("await runGeneration()");
    expect(src).toMatch(/new ReadableStream<Uint8Array>/);
    // Pin the absence of the broken pattern so a future regression
    // gets caught loudly.
    expect(src).not.toMatch(/c\.executionCtx\.waitUntil\(generationPromise\)/);
  });

  it("maintenance cron reaps stuck notifications", async () => {
    const src = await read("src/worker/services/maintenance.ts");
    expect(src).toContain("reapStuckNotifications");
    expect(src).toMatch(/try\s*\{[\s\S]{0,200}reapStuckNotifications/);
    expect(src).toMatch(/notification reap failed/);
  });
});

describe("frontend bell + hook", () => {
  it("useNotifications polls every 4s while in-progress, 30s otherwise, pauses on hidden tabs", async () => {
    const src = await read("src/frontend/hooks/useNotifications.ts");
    expect(src).toContain("POLL_FAST_MS = 4_000");
    expect(src).toContain("POLL_SLOW_MS = 30_000");
    // Cadence flips with inProgressCount.
    expect(src).toMatch(/inProgressRef\.current > 0 \?\s*POLL_FAST_MS\s*:\s*POLL_SLOW_MS/);
    // visibilitychange handler pauses + resumes polling.
    expect(src).toContain('document.addEventListener("visibilitychange"');
  });

  it("acknowledge/dismiss/refresh helpers match the route shape", async () => {
    const src = await read("src/frontend/hooks/useNotifications.ts");
    expect(src).toContain('"/api/notifications"');
    expect(src).toContain('`/api/notifications/${id}/acknowledge`');
    expect(src).toContain('`/api/notifications/${id}/dismiss`');
    expect(src).toContain('"/api/notifications/acknowledge-all"');
    expect(src).toContain('"/api/notifications/dismiss-all"');
  });

  it("NotificationBell renders unread badge + dropdown with dismiss + click-through (no in_progress signaling)", async () => {
    const src = await read("src/frontend/components/NotificationBell.tsx");
    // The bell ONLY surfaces actionable rows now — the in-progress
    // pulsing dot moved to <ActivityIndicator>. Pin the absence so a
    // future "let's add a working indicator back to the bell"
    // regression gets caught loudly.
    expect(src).toContain("badgeText");
    expect(src).not.toMatch(/showInProgressDot/);
    expect(src).not.toMatch(/animate-ping/);

    // Dropdown filters out in_progress rows so they don't appear here
    // either — the ActivityIndicator panel owns those.
    expect(src).toMatch(/notifications\.filter\([\s\S]{0,200}status\s*!==\s*"in_progress"/);

    // Dropdown row click navigates to actionUrl when status is 'ready'.
    expect(src).toMatch(/n\.status === "ready"[\s\S]{0,200}n\.actionUrl/);
    // Acknowledge-all fires the moment the dropdown opens with unread
    // — the badge clears, but rows remain visible until dismissed.
    expect(src).toMatch(/open && unreadCount > 0[\s\S]{0,200}acknowledgeAll/);
    // Per-row dismiss button.
    expect(src).toContain("onDismiss");
  });

  it("NotificationBell exposes a 'Clear all' button that empties the bell list", async () => {
    const src = await read("src/frontend/components/NotificationBell.tsx");
    // The bulk version of per-row dismiss. Visibility gate is
    // `bellNotifications.length > 0` (not `unreadCount > 0`) because
    // the open-on-focus auto-ack flips unread to 0 the moment the
    // panel paints — a stricter gate hides the button before the
    // user can see it. Action is `dismissAll`, not `acknowledgeAll`,
    // because the previous "Mark all as read" only flipped ack state
    // and left the rows visible with no way to bulk-clear them. Pin
    // both so a future refactor doesn't regress either half.
    expect(src).toMatch(
      /bellNotifications\.length > 0[\s\S]{0,500}onClick[\s\S]{0,200}dismissAll[\s\S]{0,400}Clear all/,
    );
  });

  it("ActivityIndicator owns in_progress notifications (separate from bell)", async () => {
    const src = await read("src/frontend/components/ActivityIndicator.tsx");
    // The whole point of splitting bell vs activity: pin that this
    // component reads in_progress and the bell does not.
    expect(src).toMatch(/notifications\.filter\([\s\S]{0,200}status === "in_progress"/);
    // Hides itself entirely when nothing is in flight so the header
    // doesn't carry a permanent dead utility.
    expect(src).toMatch(/inProgressCount === 0[\s\S]{0,40}return null/);
    // Spinner icon (animate-spin) telegraphs "loading" without the
    // urgency of the bell's red badge.
    expect(src).toContain("animate-spin");
    // No dismiss / acknowledge buttons per row — these resolve
    // automatically. Pin that to prevent a regression that
    // re-introduces ad-hoc cancel UI here.
    expect(src).not.toMatch(/onDismiss|acknowledge\b/);
  });

  it("ActivityIndicator auto-closes when the last in-flight item finishes", async () => {
    const src = await read("src/frontend/components/ActivityIndicator.tsx");
    // Without auto-close, a user opens the panel mid-run, the work
    // finishes, and they're left staring at a blank "Activity"
    // popover with nothing in it — feels broken. Pin the effect.
    expect(src).toMatch(
      /useEffect\([\s\S]{0,200}activeWork\.length === 0 && open[\s\S]{0,80}setOpen\(false\)/,
    );
  });

  it("Header mounts NotificationBell + ActivityIndicator (both gated on user)", async () => {
    const src = await read("src/frontend/components/Header.tsx");
    expect(src).toContain('import { NotificationBell } from "./NotificationBell"');
    expect(src).toContain('import { ActivityIndicator } from "./ActivityIndicator"');
    expect(src).toMatch(/\{user && <NotificationBell \/>\}/);
    expect(src).toMatch(/\{user && <ActivityIndicator \/>\}/);
    // Activity LEFT of bell so reading order is "working" → "ready
    // for you" — and so the bell stays the rightmost utility when
    // nothing is in flight (avoiding a layout shift as the activity
    // icon comes and goes).
    expect(src).toMatch(
      /\{user && <ActivityIndicator \/>\}[\s\S]{0,200}\{user && <NotificationBell \/>\}/,
    );
  });
});
