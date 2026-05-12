/**
 * Deep-dive endpoint — `GET /piece/:id/deep-dive`.
 *
 * Triggers (and serves cached results of) the longer-form deep dive
 * for a teaching piece. The handler is the canonical example of the
 * "streaming response + foreground generation" pattern (see
 * [ADR 0005](../../../../dev-docs/adrs/0005-streaming-plus-waituntil.md))
 * — the worker stays alive while the response stream is open and
 * heartbeat whitespace is emitted every 25 s, so generation that
 * exceeds the 30-second `waitUntil` cap still completes.
 *
 * @see ../pieces.ts — assembly entry point
 */

import { Hono } from "hono";
import { createNotification, transitionNotification } from "../../db/notifications-queries.js";
import type { Env, UserContext } from "../../types.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

export const pieceDeepDiveRoutes = new Hono<AppEnv>();

pieceDeepDiveRoutes.get("/piece/:id/deep-dive", async (c) => {
  const user = c.get("user");
  const pieceId = c.req.param("id");
  const db = c.env.DB;

  const piece = await db
    .prepare(
      `SELECT tp.deep_dive_content, tp.deep_dive_read_time, tp.has_deep_dive, tp.created_at,
              tp.title, tp.briefing_id, b.briefing_date
       FROM teaching_pieces tp
       JOIN briefings b ON b.id = tp.briefing_id
       WHERE tp.id = ? AND tp.user_id = ?`,
    )
    .bind(pieceId, user.userId)
    .first<{
      deep_dive_content: string | null;
      deep_dive_read_time: number | null;
      has_deep_dive: number;
      created_at: string;
      title: string;
      briefing_id: string;
      briefing_date: string;
    }>();

  if (!piece) {
    return c.json({ error: "Piece not found" }, 404);
  }

  if (piece.deep_dive_content) {
    const resources = await db
      .prepare("SELECT * FROM piece_resources WHERE teaching_piece_id = ? ORDER BY position")
      .bind(pieceId)
      .all();

    // Self-heal a stale in_progress notification: if the deep-dive
    // content is sitting in D1 but the notification row is still
    // showing `in_progress`, the `transitionNotification` call from
    // the original `runGeneration()` was lost (worker terminated
    // post-write but pre-transition, transient D1 hiccup, etc.).
    // The user is on this page right now — the activity indicator
    // should NOT keep spinning when the work is plainly done. Same
    // pattern `quiz.ts` uses for baseline calibration; without it
    // the bell waits for the maintenance cron's 5-minute sweep,
    // which is forever in user-time.
    const openNotif = await db
      .prepare(
        `SELECT id FROM notifications
         WHERE user_id = ? AND kind = 'deep_dive' AND status = 'in_progress'
           AND json_extract(payload, '$.pieceId') = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(user.userId, pieceId)
      .first<{ id: string }>();
    if (openNotif?.id) {
      await transitionNotification(db, user.userId, openNotif.id, {
        status: "ready",
        title: `Deep dive ready: ${piece.title}`,
        body: `${piece.deep_dive_read_time ?? 5} min read · click to open`,
      }).catch((err) => console.warn(`[deep-dive] self-heal transition failed for ${pieceId}:`, err));
    }

    return c.json({
      content: JSON.parse(piece.deep_dive_content),
      readTime: piece.deep_dive_read_time,
      resources: resources.results,
      status: "ready",
    });
  }

  // Check if generation is already in flight (has_deep_dive = -1 means generating).
  // The "is it stuck" check uses the open `deep_dive` notification's
  // created_at as the generation start timestamp — much more accurate
  // than the piece's own created_at (which can be days old). The
  // notification row also doubles as the source of `startedAt` we
  // hand back to the client so its loading-state stage indicator
  // anchors on real elapsed time, not "time since this poll".
  if (piece.has_deep_dive === -1) {
    const openNotif = await db
      .prepare(
        `SELECT id, created_at FROM notifications
         WHERE user_id = ? AND kind = 'deep_dive' AND status = 'in_progress'
           AND json_extract(payload, '$.pieceId') = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(user.userId, pieceId)
      .first<{ id: string; created_at: string }>();
    const startedAt = openNotif?.created_at ?? piece.created_at ?? new Date().toISOString();
    const startedMs = new Date(startedAt).getTime();
    const ageMs = Date.now() - startedMs;
    // 90 s stuck threshold. Typical deep-dive generation completes
    // in 30–60 s; 90 s gives ~50 % headroom over the worst-case
    // expected duration. False positives (work that actually
    // completes at 95 s) are recoverable — the user clicks Go
    // deeper again, the route re-claims the slot, generation
    // restarts. Lowering from the previous 2 min cuts the
    // spinner-stuck window in half when the original streaming
    // request was killed (e.g. user navigated away mid-generation,
    // connection closed before the worker's foreground await
    // finished writing the result row).
    if (ageMs < 90_000) {
      return c.json({ status: "generating", startedAt }, 202);
    }
    console.warn(`[deep-dive] Generation stuck for ${Math.round(ageMs / 1000)}s on ${pieceId}, resetting`);
    await db
      .prepare("UPDATE teaching_pieces SET has_deep_dive = 0 WHERE id = ? AND user_id = ?")
      .bind(pieceId, user.userId)
      .run();
    // Mark the abandoned notification as failed so the bell shows the
    // user something happened. The next click will spawn a fresh one.
    if (openNotif?.id) {
      await transitionNotification(db, user.userId, openNotif.id, {
        status: "failed",
        title: `Deep dive timed out: ${piece.title}`,
        body: `Generation stuck for ${Math.round(ageMs / 1000)}s — click Go deeper again to retry.`,
      }).catch((err) => console.warn("[deep-dive] Could not fail-out stuck notification:", err));
    }
  }

  // Atomic claim: flip 0 → -1 only if no other request has already
  // claimed this piece. The earlier SELECT + unconditional UPDATE was
  // a TOCTOU race — two concurrent requests (e.g. React StrictMode's
  // dev-mode double-invoke of the fetch effect) could both see
  // has_deep_dive=0, both UPDATE to -1, and both create a deep-dive
  // notification, leaving the user with duplicate bells. The
  // conditional WHERE makes it a compare-and-swap: only the request
  // that actually flipped the bit wins; everyone else falls back to
  // the in-progress branch above and returns {status:"generating"}.
  const claim = await db
    .prepare("UPDATE teaching_pieces SET has_deep_dive = -1 WHERE id = ? AND user_id = ? AND has_deep_dive = 0")
    .bind(pieceId, user.userId)
    .run();
  const claimed = (claim.meta?.changes ?? 0) > 0;
  if (!claimed) {
    // Another request grabbed the slot between our SELECT and our
    // UPDATE. It's already creating a notification + kicking off
    // generation; surface "generating" so the client polls for the
    // ready content rather than triggering its own duplicate run.
    return c.json({ status: "generating" }, 202);
  }

  const fullPiece = await db
    .prepare(
      `SELECT tp.title, tp.content, tp.concepts, tp.source_type, tp.model_used,
              tp.source_context,
              COALESCE(cd.depth_score, 0) as depth_score
       FROM teaching_pieces tp
       LEFT JOIN concept_depth cd ON cd.concept_id = (
         SELECT json_extract(tp.concepts, '$[0]')
       )
       WHERE tp.id = ? AND tp.user_id = ?`,
    )
    .bind(pieceId, user.userId)
    .first<{
      title: string;
      content: string;
      concepts: string;
      source_type: string;
      model_used: string | null;
      depth_score: number;
      source_context: string | null;
    }>();

  if (!fullPiece) {
    await db
      .prepare("UPDATE teaching_pieces SET has_deep_dive = 0 WHERE id = ? AND user_id = ?")
      .bind(pieceId, user.userId)
      .run();
    return c.json({ error: "Piece data not found" }, 404);
  }

  // Spin up a notification so the bell can show this work in flight.
  // The created_at on this row is also the canonical "generation
  // started at" timestamp — we hand it back to the client below so
  // the loading-state stage indicator anchors on real elapsed time,
  // not "time since this poll arrived". We tolerate failures here
  // (best-effort) — if the row doesn't get created we still want
  // the deep dive to generate.
  let notificationId: string | null = null;
  let startedAt = new Date().toISOString();
  try {
    const n = await createNotification(db, user.userId, {
      kind: "deep_dive",
      title: `Generating deep dive: ${piece.title}`,
      body: "We'll let you know when it's ready.",
      actionUrl: `/briefing/${piece.briefing_date}/${pieceId}`,
      status: "in_progress",
      payload: {
        pieceId,
        briefingDate: piece.briefing_date,
        pieceTitle: piece.title,
      },
    });
    notificationId = n.id;
    // The notification row's created_at is now the source of truth
    // for "when did this start". Pull it back so subsequent polls
    // (which read from notifications.created_at) and this initial
    // response agree on the same timestamp to the millisecond.
    const fresh = await db
      .prepare("SELECT created_at FROM notifications WHERE id = ?")
      .bind(n.id)
      .first<{ created_at: string }>();
    if (fresh?.created_at) startedAt = fresh.created_at;
  } catch (err) {
    console.warn("[deep-dive] Failed to create notification:", err);
  }

  /**
   * Run generation IN FOREGROUND while keeping the response stream
   * open with whitespace heartbeats (same pattern as
   * `routes/briefing.ts`'s `POST /briefing/generate`).
   *
   * Why this shape: `c.executionCtx.waitUntil(...)` has a hard
   * **30-second wall-clock cap** after the response is sent that
   * `cpu_ms` does NOT extend (it's a separate cap, documented at
   * https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).
   * Deep-dive LLM calls routinely take 30–60 s — so the previous
   * `waitUntil(generationPromise); return 202` pattern would have
   * the work cancelled mid-LLM call, with the notification stuck
   * in `in_progress` and the piece stuck at `has_deep_dive=-1`.
   * Verified by instrumentation: 30,021 ms between IIFE entry and
   * the `waitUntil() tasks did not complete` warning — exactly the
   * documented cap. See ADR 0005 for the full investigation +
   * outcome.
   *
   * Streaming approach: the worker stays alive while the response
   * stream is open (no waitUntil cap applies), generation runs in
   * foreground, heartbeats reset Cloudflare's edge first-byte
   * timer (~100 s), and the final JSON arrives when generation
   * completes. The client's existing polling loop still works
   * because `apiPost`'s `JSON.parse` tolerates leading whitespace.
   *
   * IIFE -> async function: the work still lives in its own
   * function scope so the catch arm can guarantee cleanup
   * (notification fail-transition + has_deep_dive reset) even if
   * the streaming controller closes early on client disconnect.
   */
  const runGeneration = async (): Promise<{
    status: "ready" | "failed";
    readTime?: number;
    content?: import("../../types.js").ContentBlock[];
    resources?: Array<{ label: string; url: string; resource_type: string }>;
    error?: string;
  }> => {
    try {
      const { llmClient } = await import("../../integrations/llm/dispatcher.js");
      const { generateDeepDive } = await import("../../services/deep-dive-generator.js");
      const { resolveModel } = await import("../../config/models.js");
      const { genId } = await import("../../db/queries.js");

      const llm = llmClient(c.env);
      const surfaceMap = user.settings?.signalSurfaceMap as Record<string, unknown> | null | undefined;
      const spec = resolveModel(surfaceMap, "deepDive");
      const auditSpec = resolveModel(surfaceMap, "audit");
      const auditPatchSpec = resolveModel(surfaceMap, "auditPatch");

      const existingContent: import("../../types.js").ContentBlock[] = JSON.parse(fullPiece.content || "[]");
      // Parse the parent piece's source bundle once — threaded into
      // both the writer (for inline [[ref:...]] tags) and the auditor
      // (for verification against the same sources the parent claimed
      // to derive from).
      const parentSources: Array<{ type: string; id?: string; url?: string; title?: string; summary?: string }> =
        JSON.parse(fullPiece.source_context ?? "[]");

      console.log(`[deep-dive] starting generation for ${pieceId} (provider=${spec.provider}, model=${spec.model})`);
      const result = await generateDeepDive(
        db,
        user.userId,
        llm,
        fullPiece.title,
        fullPiece.depth_score,
        existingContent,
        { modelSpec: spec, aboutStatement: user.aboutStatement, sources: parentSources },
      );

      // Audit the deep dive against the parent's source bundle + the
      // web-search backstop. Fail-open: the auditor swallows its own
      // exceptions and returns the original content with status='failed'.
      const { auditDeepDive } = await import("../../services/piece-auditor.js");
      const audited = await auditDeepDive({
        db,
        userId: user.userId,
        llm,
        targetId: pieceId,
        content: result.content,
        sources: parentSources,
        auditSpec,
        patchSpec: auditPatchSpec,
      });

      await db
        .prepare(
          `UPDATE teaching_pieces
             SET deep_dive_content = ?, deep_dive_read_time = ?, has_deep_dive = 1
           WHERE id = ? AND user_id = ?`,
        )
        .bind(JSON.stringify(audited.content), result.readTimeMinutes, pieceId, user.userId)
        .run();

      for (let i = 0; i < result.resources.length; i++) {
        const res = result.resources[i];
        const resId = genId("pieceResource");
        await db
          .prepare(
            `INSERT INTO piece_resources
               (id, user_id, teaching_piece_id, label, url, resource_type, position, is_deep_dive_only, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
          )
          .bind(resId, user.userId, pieceId, res.label, res.url, res.type, 100 + i)
          .run();
      }

      if (notificationId) {
        await transitionNotification(db, user.userId, notificationId, {
          status: "ready",
          title: `Deep dive ready: ${piece.title}`,
          body: `${result.readTimeMinutes} min read · click to open`,
        }).catch((err) => console.warn(`[deep-dive] notification ready-transition failed for ${pieceId}:`, err));
      }
      console.log(`[deep-dive] completed generation for ${pieceId}`);
      // Read back the resources we just wrote so the stream
      // response can hand the client a fully-renderable payload
      // (matching the cached-content branch's shape exactly). This
      // is what fixes the "I see only the title until I refresh"
      // bug: the frontend's DeepDiveView renders only when
      // `deepDive?.content && deepDive.status === "ready"`, so
      // dropping `content` from the streaming response left it
      // gated until the user manually re-fetched.
      const insertedResources = await db
        .prepare("SELECT label, url, resource_type FROM piece_resources WHERE teaching_piece_id = ? ORDER BY position")
        .bind(pieceId)
        .all<{ label: string; url: string; resource_type: string }>();
      return {
        status: "ready",
        readTime: result.readTimeMinutes,
        content: audited.content,
        resources: insertedResources.results ?? [],
      };
    } catch (err) {
      console.error(`[deep-dive] generation failed for ${pieceId}:`, err);
      // Best-effort cleanup: reset the slot so a retry click can
      // re-claim, and flip the notification to `failed` so the bell
      // shows the user something went wrong. Both calls swallow
      // their own errors — we never want this catch to itself
      // throw and stop one cleanup from running because another
      // crashed.
      await db
        .prepare("UPDATE teaching_pieces SET has_deep_dive = 0 WHERE id = ? AND user_id = ?")
        .bind(pieceId, user.userId)
        .run()
        .catch((e) => console.warn(`[deep-dive] reset has_deep_dive failed for ${pieceId}:`, e));
      if (notificationId) {
        await transitionNotification(db, user.userId, notificationId, {
          status: "failed",
          title: `Deep dive failed: ${piece.title}`,
          body: String(err).slice(0, 200),
        }).catch((e) => console.warn(`[deep-dive] notification fail-transition failed for ${pieceId}:`, e));
      }
      return { status: "failed", error: String(err).slice(0, 200) };
    }
  };

  // Streaming response: keep the worker alive in foreground while
  // generation runs. Heartbeat whitespace every 25 s so the edge
  // doesn't 524 us. When `runGeneration` resolves, write the final
  // JSON body and close.
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
      // First byte goes out immediately — resets the edge's
      // first-byte timer before we even touch the LLM.
      safeEnqueue(" ");
      const heartbeat = setInterval(() => safeEnqueue(" "), 25_000);
      try {
        const outcome = await runGeneration();
        if (outcome.status === "ready") {
          // Match the cached-content branch's response shape exactly
          // — the frontend's DeepDiveView renders content via
          // `deepDive?.content && deepDive.status === "ready"`, so
          // we MUST include `content` and `resources` here. The
          // first version of the streaming refactor returned only
          // `{status, readTime, startedAt}` and the user reported
          // "I only saw the title until I refreshed" — refresh
          // worked because it hit the cached-content branch above
          // (which always returned a fully-renderable payload).
          safeEnqueue(
            JSON.stringify({
              status: "ready",
              content: outcome.content ?? [],
              resources: outcome.resources ?? [],
              readTime: outcome.readTime,
              startedAt,
            }),
          );
        } else {
          safeEnqueue(JSON.stringify({ status: "failed", error: outcome.error, startedAt }));
        }
      } catch (err) {
        // runGeneration is supposed to never throw (it has its own
        // try/catch returning {status:"failed"}). This branch is
        // belt-and-suspenders for genuinely unexpected errors.
        safeEnqueue(JSON.stringify({ status: "failed", error: String(err).slice(0, 200) }));
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    status: 202,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    },
  });
});
