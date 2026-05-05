/**
 * Briefing lifecycle endpoints — cancel, reset, and the canonical
 * "streaming response + ctx.waitUntil + notification" generate flow.
 *
 * The generate handler is the reference implementation that new
 * long-running routes elsewhere in the codebase should pattern-match
 * against (see [ADR 0005](../../../../dev-docs/adrs/0005-streaming-plus-waituntil.md)).
 *
 * - POST `/briefing/cancel`   — cooperative cancel of an in-flight run
 * - POST `/briefing/reset`    — force-reset today's row (zombie escape)
 * - POST `/briefing/generate` — kick off a fresh generation
 *
 * @see ../briefing.ts — assembly entry point
 */

import { Hono } from "hono";
import { createNotification, transitionNotification } from "../../db/notifications-queries.js";
import type { Env, UserContext } from "../../types.js";
import { BRIEFING_NOTIFICATION_KIND, isZombie, todayFor } from "./shared.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const briefingLifecycleRoutes = new Hono<AppEnv>();

briefingLifecycleRoutes.post("/briefing/cancel", async (c) => {
  const user = c.get("user");
  const today = todayFor(user);

  const briefing = await c.env.DB.prepare(
    "SELECT id, status, updated_at FROM briefings WHERE user_id = ? AND briefing_date = ?",
  )
    .bind(user.userId, today)
    .first<{ id: string; status: string; updated_at: string }>();

  if (!briefing) {
    return c.json({ error: "No briefing to cancel" }, 404);
  }
  if (briefing.status !== "generating") {
    return c.json({ error: "Briefing is not currently generating" }, 400);
  }

  // Cancel flag lives in its own column so that concurrent updateProgress
  // calls (which replace the metadata JSON) can't stomp it.
  await c.env.DB.prepare("UPDATE briefings SET cancel_requested = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(briefing.id)
    .run();

  return c.json({ ok: true, briefingId: briefing.id });
});

// Force-reset today's briefing — nukes the row regardless of status. Use
// this to escape zombied generations (stuck fetches, orphaned workers) when
// cooperative cancellation can't reach a checkpoint.
briefingLifecycleRoutes.post("/briefing/reset", async (c) => {
  const user = c.get("user");
  const today = todayFor(user);

  const existing = await c.env.DB.prepare("SELECT id FROM briefings WHERE user_id = ? AND briefing_date = ?")
    .bind(user.userId, today)
    .first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE calibration_quizzes SET teaching_piece_id = NULL
         WHERE user_id = ? AND teaching_piece_id IN (
           SELECT id FROM teaching_pieces WHERE briefing_id = ?
         )`,
    )
      .bind(user.userId, existing.id)
      .run();
  }

  const result = await c.env.DB.prepare("DELETE FROM briefings WHERE user_id = ? AND briefing_date = ?")
    .bind(user.userId, today)
    .run();

  const deleted = (result.meta?.changes ?? 0) > 0;
  return c.json({ ok: true, deleted });
});

briefingLifecycleRoutes.post("/briefing/generate", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const env = c.env;
  const today = todayFor(user);

  const existing = await db
    .prepare("SELECT id, status, updated_at, metadata FROM briefings WHERE user_id = ? AND briefing_date = ?")
    .bind(user.userId, today)
    .first<{ id: string; status: string; updated_at: string; metadata: string | null }>();

  if (existing?.status === "generating" && !isZombie(existing.status, existing.updated_at, existing.metadata)) {
    return c.json({ status: "generating", pollUrl: "/api/briefing/status" }, 202);
  }

  // Refresh policy: PRESERVE the existing briefing and its teaching
  // pieces. The earlier behavior was to delete the row + cascade-delete
  // every piece, then regenerate from scratch — fine when generation
  // was stable, but harmful once the focus statement actually steers
  // selection. A user who edits their focus and refreshes shouldn't
  // lose the pieces shaped by their prior focus; those are still
  // valid teaching, just shaped by an earlier direction. The generator
  // detects an in-place existing briefing and runs in additive mode,
  // appending up to BRIEFING_RULES.MAX_REFRESH_ADDITIONS new pieces
  // that don't duplicate existing concepts.
  //
  // Two cases still need cleanup before reuse:
  //   - Zombie: a stuck "generating" row whose generator is dead. We
  //     reset its status to "generated" (no pieces are at risk; the
  //     real ones survive) so the additive path picks up safely.
  //   - Failed: a previous attempt errored before writing any pieces.
  //     Same story — clear status to allow retry without rebuild.
  //
  // The `POST /briefing/reset` endpoint remains the explicit
  // "wipe-and-start-over" escape hatch for users who genuinely want
  // to throw away their existing briefing.
  const { genId } = await import("../../db/queries.js");
  let briefingId: string;
  if (existing) {
    briefingId = existing.id;
    // Reset metadata + status so the streamer doesn't read a stale
    // "step: failed" payload from the prior run. Pieces stay intact;
    // the generator detects additive mode by querying for them.
    await db
      .prepare(
        `UPDATE briefings SET status = 'generating', cancel_requested = 0,
                              metadata = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(JSON.stringify({ step: "starting", stepLabel: "Refreshing briefing..." }), briefingId)
      .run();
  } else {
    briefingId = genId("briefing");
    await db
      .prepare(
        `INSERT INTO briefings (id, user_id, briefing_date, generated_at, status, metadata, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), 'generating', ?, datetime('now'), datetime('now'))`,
      )
      .bind(briefingId, user.userId, today, JSON.stringify({ step: "starting", stepLabel: "Starting generation..." }))
      .run();
  }

  // Stale briefing_generation notifications from a previous run get
  // dismissed here so a fresh kick-off owns its own notification row.
  // Without this, two consecutive refreshes would leave two
  // in_progress rows in the bell with no owner — the second one would
  // be the truth, but the first would still claim "in flight" until
  // the maintenance sweep eventually reaped it. Targeted UPDATE
  // keyed by kind + user, so we don't touch unrelated kinds.
  await db
    .prepare(
      `UPDATE notifications SET status = 'dismissed', updated_at = datetime('now')
       WHERE user_id = ? AND kind = ? AND status = 'in_progress'`,
    )
    .bind(user.userId, BRIEFING_NOTIFICATION_KIND)
    .run();

  // Fire-and-forget notification at the start of generation. The bell
  // will pick it up on its next poll (4s when anything's in_progress)
  // so the user sees "Generating today's briefing" land in their
  // tray right away.
  //
  // Failure to create the notification is non-fatal — generation
  // proceeds either way, the user just doesn't get the bell ping. We
  // don't want a transient D1 hiccup on this row to abort the whole
  // refresh.
  let notificationId: string | null = null;
  try {
    const n = await createNotification(db, user.userId, {
      kind: BRIEFING_NOTIFICATION_KIND,
      title: "Generating today's briefing",
      body: "We'll let you know when it's ready.",
      actionUrl: "/",
      status: "in_progress",
      payload: { briefingId, briefingDate: today },
    });
    notificationId = n.id;
  } catch (err) {
    console.warn("[generate] Failed to create notification:", err);
  }

  // Load the user's saved settings so the generator applies their configured
  // filters (Linear scope, Slack channels, time windows, models) — without
  // this, the generator falls back to broad defaults and ignores the settings
  // the preview panel shows.
  const settingsRow = await db
    .prepare("SELECT source_config, budget_cap_monthly, relevance_threshold FROM user_settings WHERE user_id = ?")
    .bind(user.userId)
    .first<{
      source_config: string | null;
      budget_cap_monthly: number | null;
      relevance_threshold: number | null;
    }>();

  const userSettings = settingsRow
    ? {
        signalSurfaceMap: settingsRow.source_config ? JSON.parse(settingsRow.source_config) : {},
        budgetCapMonthly: settingsRow.budget_cap_monthly ?? undefined,
        relevanceThreshold: settingsRow.relevance_threshold ?? undefined,
      }
    : undefined;

  // Run generation while keeping the response stream alive.
  //
  // Why streaming instead of awaiting inline: Cloudflare's edge will
  // 524 a request that doesn't return its first byte within ~100s.
  // A briefing with multiple teaching pieces (each a Sonnet call) plus
  // the continuation classifier (Haiku per draft, plus a full rewrite
  // on ADDITIVE outcomes) routinely exceeds that budget. Awaiting
  // inline returns the full JSON only after generation finishes — far
  // past 100s on busy days, so the user sees a Cloudflare HTML error
  // page instead of progress.
  //
  // The fix: write a single space byte immediately (resets the
  // edge's first-byte timer), then a space every 25s as a heartbeat
  // (well below any idle-connection limit), and finally write the
  // result JSON when generation finishes. Heartbeats are pure
  // whitespace, so the concatenated body remains valid JSON — the
  // frontend's `apiPost` (which calls `res.json()`) tolerates leading
  // whitespace, so no client change needed.
  //
  // We ALSO pin the generation promise to `c.executionCtx.waitUntil`
  // so the work survives the user navigating away mid-generation.
  // Without this, the response stream closes when the client
  // disconnects and the worker exits before generation finishes —
  // leaving the briefing row stuck at `status='generating'` and the
  // bell at "in progress" until the maintenance sweep reaps it.
  // With waitUntil, generation continues server-side, the
  // notification transitions to `ready` (or `failed`) on completion,
  // and the bell flips green. The client's response stream is just
  // for the foreground UX while the page is open; the source of
  // truth for "is it done" is the notification + the briefing row's
  // own status.
  const { generateDailyBriefing } = await import("../../services/briefing-generator.js");
  const generationPromise = generateDailyBriefing(db, user.userId, env, briefingId, userSettings);

  // Notification side-effect chain. Wraps the generation promise
  // with success / failure handlers that transition the bell row.
  // Both consumers (the response stream below AND the waitUntil
  // hold) await the same source promise — promises support multiple
  // consumers, so this isn't a fork.
  //
  // Cancellation: if the user clicks Cancel mid-flight, the
  // generator's own checkpoint logic marks the briefing row as
  // status='failed' with reason='cancelled'. That throws here, hits
  // the failure arm, and the notification body reflects the cancel
  // verbiage so "Generation cancelled" reads correctly in the bell
  // (instead of "Generation failed: cancelled" which sounds like an
  // error).
  const generationWithNotification = generationPromise.then(
    async () => {
      if (!notificationId) return;
      try {
        // Read the briefing's final status to decide the
        // notification's success message — `partial` happens when
        // some pieces failed but enough landed to be useful, and we
        // want the bell to reflect that nuance.
        const finalRow = await db
          .prepare("SELECT status FROM briefings WHERE id = ? AND user_id = ?")
          .bind(briefingId, user.userId)
          .first<{ status: string }>();
        const status = finalRow?.status ?? "generated";
        if (status === "generated") {
          await transitionNotification(db, user.userId, notificationId, {
            status: "ready",
            title: "Today's briefing is ready",
            body: "Click to read it.",
            actionUrl: "/",
          });
        } else if (status === "partial") {
          await transitionNotification(db, user.userId, notificationId, {
            status: "ready",
            title: "Today's briefing is ready (partial)",
            body: "Some sections couldn't be generated — click to see what landed.",
            actionUrl: "/",
          });
        } else {
          // status === 'failed' — generator marked the row but
          // didn't throw. Treat the notification accordingly so the
          // bell reflects reality.
          await transitionNotification(db, user.userId, notificationId, {
            status: "failed",
            title: "Briefing generation failed",
            body: "Click to retry.",
            actionUrl: "/",
          });
        }
      } catch (err) {
        console.warn("[generate] Failed to transition notification:", err);
      }
    },
    async (err) => {
      if (!notificationId) return;
      const msg = err instanceof Error ? err.message : String(err);
      const cancelled = /cancel/i.test(msg);
      try {
        await transitionNotification(db, user.userId, notificationId, {
          status: "failed",
          title: cancelled ? "Briefing generation cancelled" : "Briefing generation failed",
          body: msg.slice(0, 200),
          actionUrl: "/",
        });
      } catch (transitionErr) {
        console.warn("[generate] Failed to transition notification on failure:", transitionErr);
      }
    },
  );

  // Pin generation to the worker via waitUntil so a client
  // disconnect (the user navigating away — the whole point of this
  // flow) doesn't kill the work mid-flight. The notification row
  // becomes the source of truth for "is generation done"; the bell
  // catches up at its 4s in-progress poll cadence.
  c.executionCtx.waitUntil(generationWithNotification);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const safeEnqueue = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true;
        }
      };

      // First byte goes out immediately so the edge timer is reset
      // before generation has even begun reading work signals.
      safeEnqueue(" ");

      const heartbeat = setInterval(() => safeEnqueue(" "), 25_000);

      try {
        await generationPromise;
        safeEnqueue(JSON.stringify({ status: "generated", briefingId }));
      } catch (err) {
        console.error("[generate] Generation failed:", err);
        try {
          await db
            .prepare(`UPDATE briefings SET status = 'failed', metadata = ?, updated_at = datetime('now') WHERE id = ?`)
            .bind(
              JSON.stringify({
                step: "failed",
                stepLabel: "Generation failed",
                error: String(err),
              }),
              briefingId,
            )
            .run();
        } catch (dbErr) {
          console.error("[generate] Failed to mark briefing failed:", dbErr);
        }
        safeEnqueue(JSON.stringify({ status: "failed", error: String(err) }));
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Disable any intermediate buffering so each heartbeat reaches
      // the edge immediately. Cloudflare honours this on Workers
      // responses.
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
