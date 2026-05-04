/**
 * Pins the "briefing refresh fires a notification when ready" contract.
 *
 * Bug this test prevents regressing:
 *   1. Click Refresh on the briefing page → generation kicks off as a
 *      streaming response.
 *   2. Navigate away (close tab, hit the back button, switch to the
 *      Concepts page — anything that aborts the open `apiPost`).
 *   3. Generation halts mid-flight because the worker exits when the
 *      response stream closes; briefing row stays at status='generating'
 *      until the maintenance sweep reaps it; bell never lights up.
 *
 * Fix shape:
 *   - `/briefing/generate` creates an `in_progress` notification with
 *     kind `briefing_generation` right after inserting the briefing
 *     row, BEFORE calling the generator.
 *   - The generation promise is wrapped with success / failure handlers
 *     that transition the notification to `ready` / `failed`.
 *   - The wrapped promise is pinned to `c.executionCtx.waitUntil`, so
 *     the work survives the client disconnect — this is the whole
 *     point of the contract.
 *   - Stale `in_progress` rows from a previous run get dismissed at
 *     the start of the new request so the bell never shows two
 *     in-flight briefing notifications at once.
 *   - Cancellation surfaces as "Briefing generation cancelled" rather
 *     than a generic "failed" so the bell verb matches the user's
 *     intent.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFile(resolve(REPO_ROOT, p), "utf-8");
const readSrc = readSplitSource;

describe("POST /briefing/generate — notification kicks off at start", () => {
  it("imports createNotification + transitionNotification from the queries module", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Importing the helpers (rather than inlining INSERT/UPDATE
    // statements) keeps the contract aligned with deep-dive and
    // baseline-calibration: same lifecycle helpers, same notification
    // shape, same idempotency semantics.
    // Tolerate either depth — pre-split the import resolves from
    // `routes/briefing.ts` (`../db/...`); post-split the lifecycle
    // handler lives one folder deeper (`../../db/...`).
    expect(src).toMatch(
      /import\s*\{[^}]*\bcreateNotification\b[^}]*\btransitionNotification\b[^}]*\}\s*from\s*"(\.\.\/)+db\/notifications-queries\.js"/,
    );
  });

  it("declares a stable BRIEFING_NOTIFICATION_KIND constant", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Hard-coding the kind string in two places is a recipe for
    // typos that silently break the bell. Constant declaration
    // forces a single source of truth.
    expect(src).toMatch(/BRIEFING_NOTIFICATION_KIND\s*=\s*"briefing_generation"/);
  });

  it("creates the in_progress notification AFTER the briefing row exists", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Order matters: the notification's payload references
    // `briefingId`, so we need the INSERT INTO briefings to have
    // run first. A regression that flipped these would still
    // compile but the notification's payload.briefingId would
    // point at a row that doesn't exist yet — bell-side click-
    // through would 404.
    expect(src).toMatch(
      /INSERT INTO briefings[\s\S]{0,2000}createNotification\([\s\S]{0,400}kind:\s*BRIEFING_NOTIFICATION_KIND[\s\S]{0,400}status:\s*"in_progress"/,
    );
  });

  it("notification payload carries the briefingId so the bell click can route", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toMatch(
      /createNotification\([\s\S]{0,800}payload:\s*\{[^}]*briefingId[^}]*briefingDate[^}]*\}/,
    );
  });

  it("uses actionUrl '/' so the bell click lands on the briefing page", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Briefings live at the root route ("/"), not "/briefing" — pin
    // that here so a future router change doesn't leave the bell
    // pointing at a 404.
    expect(src).toMatch(/createNotification\([\s\S]{0,400}actionUrl:\s*"\/"/);
  });

  it("dismisses any stale in_progress briefing notification before starting", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Without this cleanup, two consecutive refreshes (e.g. a
    // double-click on the Refresh button, or a retry after a
    // zombie sweep) would leave two `in_progress` rows in the
    // bell — confusing.
    expect(src).toMatch(
      /UPDATE notifications SET status = 'dismissed'[\s\S]{0,200}WHERE user_id = \? AND kind = \?[\s\S]{0,200}AND status = 'in_progress'/,
    );
  });

  it("create-notification failures don't abort generation", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // Generation is the user's primary intent; the bell ping is
    // secondary. A transient D1 hiccup creating the notification
    // row must not cascade into a refresh failure.
    expect(src).toMatch(
      /try\s*\{[\s\S]{0,400}createNotification\([\s\S]{0,800}\}\s*catch\s*\([^)]*\)\s*\{[\s\S]{0,200}console\.warn/,
    );
  });
});

describe("POST /briefing/generate — work survives client disconnect", () => {
  it("pins the generation promise to ctx.waitUntil", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // This is the load-bearing line for the whole "navigate away
    // and get a notification when ready" feature. Without
    // waitUntil, the worker exits as soon as the response stream
    // closes (which happens immediately when the client aborts).
    expect(src).toMatch(/c\.executionCtx\.waitUntil\(generationWithNotification\)/);
  });

  it("the response stream still consumes the original generationPromise for live progress", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // The streaming response (heartbeats + final JSON) is for the
    // foreground UX while the page is open. It awaits the same
    // source promise as the waitUntil chain, so live progress
    // and the navigate-away path both work.
    expect(src).toMatch(
      /const stream = new ReadableStream[\s\S]{0,1500}await generationPromise/,
    );
  });

  it("waitUntil chain runs the notification transitions, not the stream consumer", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // The success/failure transitions live on the .then() chain
    // attached to generationPromise (becoming generationWithNotification).
    // This is the ONLY chain pinned to waitUntil — the stream
    // consumer's catch arm only updates the briefing row's status,
    // not the notification. Splitting concerns this way means the
    // bell flips even when the response stream was already gone.
    expect(src).toMatch(
      /generationWithNotification\s*=\s*generationPromise\.then\(/,
    );
  });
});

describe("POST /briefing/generate — notification transitions on completion", () => {
  it("success arm reads the briefing's final status before transitioning", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // `partial` is a real outcome (some pieces succeeded, others
    // didn't) and the bell wording should match. Reading the row
    // back is the cheapest way to know which arm to take without
    // changing the generator's return type.
    expect(src).toMatch(
      /SELECT status FROM briefings WHERE id = \? AND user_id = \?[\s\S]{0,500}status === "generated"[\s\S]{0,800}status === "partial"/,
    );
  });

  it("transitions to ready with title 'Today's briefing is ready' on success", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toMatch(
      /transitionNotification\([\s\S]{0,400}status:\s*"ready"[\s\S]{0,200}title:\s*"Today's briefing is ready"/,
    );
  });

  it("partial outcome surfaces as a 'ready (partial)' bell row", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // We deliberately DON'T mark partial briefings as failed —
    // the user got useful content, just not the full set. The bell
    // copy reflects that nuance so they're not surprised.
    expect(src).toMatch(/title:\s*"Today's briefing is ready \(partial\)"/);
  });

  it("failure arm distinguishes cancellation from generic errors", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // The user explicitly clicking Cancel is fundamentally
    // different from a backend error — the bell copy should
    // reflect that or it reads as if the system broke when the
    // user themselves stopped it.
    expect(src).toMatch(
      /\/cancel\/i\.test\(msg\)[\s\S]{0,400}title:\s*cancelled\s*\?\s*"Briefing generation cancelled"\s*:\s*"Briefing generation failed"/,
    );
  });

  it("transitionNotification failures only warn, don't crash the worker", async () => {
    const src = await readSrc("src/worker/routes/briefing.ts");
    // The success transition has its own try/catch wrapper so a
    // transient D1 error here doesn't propagate up to waitUntil
    // and tank the whole worker invocation.
    expect(src).toMatch(
      /transitionNotification\([\s\S]{0,800}\}\s*catch\s*\([^)]*\)\s*\{\s*console\.warn\([^)]*Failed to transition notification/,
    );
  });
});

describe("Help docs reflect the new notification kind", () => {
  it("notifications.md lists briefing_generation alongside deep_dive and baseline_calibration", async () => {
    const md = await read("src/frontend/help/reference/notifications.md");
    expect(md).toMatch(/`kind = "briefing_generation"`/);
    // The doc must mention the navigate-away + waitUntil contract
    // so future readers understand WHY this notification kind
    // exists and don't try to "simplify" it back to a fire-and-
    // forget bell ping.
    expect(md).toMatch(/waitUntil/);
    expect(md).toMatch(/navigat/i);
  });

  it("api-endpoints.md mentions the briefing_generation kind on the generate row", async () => {
    const md = await read("src/frontend/help/reference/api-endpoints.md");
    expect(md).toMatch(/POST.{0,200}\/api\/briefing\/generate[\s\S]{0,1500}briefing_generation/);
  });

  it("how-generation-works.md links to the bell contract", async () => {
    const md = await read("src/frontend/help/briefings/how-generation-works.md");
    // The generator-side doc was previously claiming "we don't
    // depend on ctx.waitUntil" — that statement is now wrong, so
    // the doc must explicitly mention the waitUntil pinning and
    // the bell handoff to keep readers in sync.
    expect(md).toMatch(/waitUntil/);
    expect(md).toMatch(/briefing_generation|notifications#what-triggers-notifications-today/);
  });
});
