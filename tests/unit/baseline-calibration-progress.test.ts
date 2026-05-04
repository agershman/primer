/**
 * Pins the "calibration progress survives navigation" contract.
 *
 * Bug this test prevents regressing:
 *   1. Click "Start calibration" → progress shown.
 *   2. Navigate away and back → progress lost, button reverts to
 *      the regular "Start calibration →" link.
 *   3. Notification stuck at in_progress forever even though
 *      questions were generated.
 *
 * Fix shape:
 *   - New `GET /api/quiz/baseline/status` (read-only) returns the
 *     server-side state: `idle` / `generating` / `ready`.
 *   - The status GET self-heals stuck notifications: if pending
 *     baseline rows exist but a notification is still in_progress,
 *     it's transitioned to ready right there (so the bell catches
 *     up even if the prepare endpoint's `waitUntil` lost the
 *     transition for any reason).
 *   - `StartCalibrationButton` mounts against the status endpoint
 *     and polls every ~3s while generating, so the user's progress
 *     view comes back exactly as they left it after navigation.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("GET /api/quiz/baseline/status — server-side calibration state", () => {
  it("endpoint exists and returns idle / generating / ready", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Either the legacy single-router (`quizRoutes`) or the
    // post-split per-surface router (`quizBaselineRoutes`) — the
    // wire path is unchanged either way.
    expect(src).toMatch(/(quizRoutes|quizBaselineRoutes)\.get\("\/quiz\/baseline\/status"/);
    // All three states must be reachable from this single handler so
    // the client doesn't have to assemble them from multiple calls.
    expect(src).toMatch(/status:\s*"idle"/);
    expect(src).toMatch(/status:\s*"generating"/);
    expect(src).toMatch(/status:\s*"ready"/);
  });

  it("counts pending baseline rows as the source of truth for `ready`", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The status endpoint must read `calibration_quizzes.status =
    // 'pending'` so it agrees with what /api/quiz/baseline returns.
    // If these two diverge, the button could stay in `generating`
    // forever even after the quiz is taken.
    expect(src).toMatch(
      /quiz_type = 'baseline' AND status = 'pending'[\s\S]{0,500}status:\s*"ready"/,
    );
  });

  it("returns `startedAt` from the in-progress notification on `generating`", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // Future UX could surface "Generating for 12s…" using this
    // timestamp; pin it now so the field doesn't get dropped.
    expect(src).toMatch(/loadInFlightBaselineNotification/);
    expect(src).toMatch(/startedAt:\s*notif\.createdAt/);
  });

  it("self-heals a stuck in_progress notification when pending rows exist", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The user reported: "got the notification as pending, never saw
    // it go green, revisited and click start calibration and it was
    // there ready for me." That can only happen if the transition
    // call from the prepare endpoint's `waitUntil` was lost (worker
    // killed, transient D1 hiccup). The status GET now reconciles:
    // pending rows + in_progress notification → flip notification
    // to ready right there.
    expect(src).toMatch(
      /if \(pendingCount > 0 && notif\)[\s\S]{0,500}transitionNotification\([\s\S]{0,400}status:\s*"ready"/,
    );
  });

  it("does not touch the notification when self-heal isn't needed", async () => {
    const src = await readSrc("src/worker/routes/quiz.ts");
    // The pure `pendingCount > 0` (no notification) and `notif`-only
    // (no pending rows) branches must be separate from the self-heal
    // branch — otherwise we'd over-transition and confuse the bell.
    // We pin this by asserting the three returns appear in source
    // order: self-heal → ready-only → generating. (The exact JSON
    // payloads include a `coverage` field too; the regex matches
    // the leading `status:` segment of each return so a future
    // coverage-shape change doesn't break the test.)
    expect(src).toMatch(
      /transitionNotification[\s\S]{0,500}status:\s*"ready"[\s\S]{0,800}return c\.json\(\{ status: "ready", conceptCount: pendingCount,[\s\S]{0,800}if \(pendingCount > 0\)[\s\S]{0,500}if \(notif\)[\s\S]{0,300}status:\s*"generating"/,
    );
  });
});

describe("StartCalibrationButton — mount-aware progress reflection", () => {
  it("fetches /api/quiz/baseline/status on mount", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    // The OLD implementation only knew about progress via local
    // React state, which got lost on navigation. The fix MUST hit
    // the status endpoint on mount so a returning user sees the
    // same view they left.
    expect(src).toMatch(/apiGet<[^>]+>\("\/api\/quiz\/baseline\/status"\)/);
    expect(src).toMatch(/useEffect\([\s\S]{0,200}fetchStatus/);
  });

  it("polls every ~3s while generating, cleans up otherwise", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/POLL_INTERVAL_MS\s*=\s*3000/);
    // The poll-effect must early-return + clear the interval when
    // status is anything other than "generating". Without this,
    // sitting on the `ready` state would keep hammering the API.
    expect(src).toMatch(
      /if \(status !== "generating"\)[\s\S]{0,300}clearInterval/,
    );
    // Cleanup on unmount + status change.
    expect(src).toMatch(/return \(\) => \{[\s\S]{0,100}clearInterval/);
  });

  it("renders nothing during the initial status fetch (no flash of wrong CTA)", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    // First-paint must be empty so the user doesn't see "Start
    // calibration" flash before snapping to "Generating" when they
    // land mid-job.
    expect(src).toMatch(/if \(status === "loading"\)[\s\S]{0,200}aria-hidden="true"/);
  });

  it("renders the in-flight pulse + 'we'll ping the bell' message on `generating`", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/status === "generating"/);
    expect(src).toMatch(/Calibration is being prepared in the background/);
    expect(src).toMatch(/animate-pulse/);
  });

  it("on `ready`, renders a 'Calibration ready (N) →' CTA that jumps to /calibrate", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/status === "ready"/);
    expect(src).toMatch(/Calibration ready/);
    // Pluralization handled inline.
    expect(src).toMatch(/conceptCount === 1 \?/);
    expect(src).toMatch(/navigate\("\/calibrate"\)/);
  });

  it("idle click still POSTs /prepare and transitions in-component to `generating`", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/apiPost<[^>]+>\("\/api\/quiz\/baseline\/prepare"/);
    // POST returning `in_progress` flips local status to `generating`
    // immediately so the user gets the spinner without waiting for
    // the next status poll tick.
    expect(src).toMatch(
      /resp\.status === "in_progress"[\s\S]{0,200}setStatus\("generating"\)/,
    );
  });

  it("`no_concepts` server response surfaces the inline error", async () => {
    const src = await read("src/frontend/components/StartCalibrationButton.tsx");
    expect(src).toMatch(/resp\.status === "no_concepts"[\s\S]{0,200}setError/);
    expect(src).toMatch(/status === "error" && error/);
  });
});

describe("API endpoints help doc surfaces the new status endpoint", () => {
  // Keep the help docs honest — if a future refactor renames the
  // endpoint, we'd rather catch the drift here than have an admin
  // chase a 404 from the published doc.
  it("api-endpoints.md mentions /api/quiz/baseline/status", async () => {
    const src = await read("src/frontend/help/reference/api-endpoints.md");
    expect(src).toMatch(/\/api\/quiz\/baseline\/status/);
  });
});
