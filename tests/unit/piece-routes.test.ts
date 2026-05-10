import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const readRepoFile = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
// Use `readSrc` for any source file whose handlers may have moved
// into a sibling sub-directory (e.g. `routes/quiz.ts` → folder).
const readSrc = readSplitSource;

describe("piece routes — source code contracts", () => {
  describe("POST /piece/:id/regenerate", () => {
    it("route exists and validates the model parameter", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      expect(src).toContain('"/piece/:id/regenerate"');
      expect(src).toContain("isValidModel(body.model)");
    });

    it("calls generateTeachingPiece with the requested model", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      // Tolerate either router name — `pieceRoutes` (legacy assembly
      // file) or `pieceRegenerateRoutes` (post-split sub-file).
      const regenRoute = src.match(
        /(?:pieceRoutes|pieceRegenerateRoutes)\.post\("\/piece\/:id\/regenerate"[\s\S]*?\}\);[\s]*$/m,
      );
      expect(regenRoute).not.toBeNull();
      expect(regenRoute?.[0]).toContain("generateTeachingPiece");
      expect(regenRoute?.[0]).toContain("body.model");
    });

    it("clears cached deep dive when regenerating", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      expect(src).toMatch(/deep_dive_content = NULL.*has_deep_dive = 0/);
    });

    it("does NOT reference updated_at on teaching_pieces (column doesn't exist)", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      const updates = src.match(/UPDATE teaching_pieces[\s\S]*?WHERE/g) ?? [];
      for (const stmt of updates) {
        expect(stmt).not.toContain("updated_at");
      }
    });
  });

  describe("GET /piece/:id/deep-dive", () => {
    it("calls generateDeepDive when no cached content exists", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      expect(src).toContain("generateDeepDive");
    });

    it("returns cached content without re-generating", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      expect(src).toMatch(/if \(piece\.deep_dive_content\)/);
      expect(src).toMatch(/status: "ready"/);
    });

    it("stores generated content in the database", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      expect(src).toMatch(/SET deep_dive_content = \?.*deep_dive_read_time = \?.*has_deep_dive = 1/);
    });

    it("handles failures gracefully by resetting has_deep_dive flag", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      expect(src).toContain("[deep-dive] generation failed for");
      expect(src).toContain("has_deep_dive = 0");
    });

    it("uses an atomic compare-and-swap to claim the generation slot", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      // The flip from 0 -> -1 must include `AND has_deep_dive = 0`
      // in the WHERE clause so two concurrent requests can't both
      // claim the slot. Without this, React StrictMode's dev-mode
      // double-fire of the deep-dive fetch effect causes duplicate
      // notifications.
      expect(src).toMatch(
        /UPDATE teaching_pieces SET has_deep_dive = -1 WHERE id = \? AND user_id = \? AND has_deep_dive = 0/,
      );
      // The route must inspect the rows-affected count and bail out
      // when zero — that's the request that lost the race.
      expect(src).toMatch(/claim\.meta\?\.changes/);
      // Notification creation lives behind the claim, so only the
      // request that won the race spawns a bell row.
      const claimIdx = src.indexOf("claim.meta?.changes");
      const notificationIdx = src.indexOf('kind: "deep_dive"');
      expect(claimIdx).toBeGreaterThan(0);
      expect(notificationIdx).toBeGreaterThan(claimIdx);
    });

    it("uses the streaming-foreground pattern (not waitUntil) for generation", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      // Earlier shape was `c.executionCtx.waitUntil(generationPromise);
      // return c.json(..., 202)`. That hit Cloudflare's 30-second
      // post-response cap on waitUntil and got cancelled mid-LLM-call,
      // leaving the notification stuck in_progress and the piece at
      // has_deep_dive=-1 forever. See ADR 0005 for the runtime evidence
      // (30,021 ms between IIFE entry and the cancellation warning,
      // exactly matching the documented cap).
      //
      // The fix is the streaming-response pattern: response stream
      // stays open while generation runs in foreground, heartbeats
      // reset the edge first-byte timer. Same shape as
      // briefing-generator's POST /briefing/generate.
      expect(src).toMatch(/new ReadableStream<Uint8Array>/);
      expect(src).toMatch(/await runGeneration\(\)/);
      // Heartbeat every 25 s (well under any idle-connection limit).
      expect(src).toMatch(/setInterval\(\(\)\s*=>\s*safeEnqueue\("\s*"\),\s*25_?000\)/);
      // The early-return in-flight branch (has_deep_dive=-1, fresh
      // notification) still uses the cheap c.json shape — only the
      // post-claim originating request needs the stream.
      expect(src).toMatch(/c\.json\(\{ status: "generating", startedAt \}, 202\)/);
      // The route MUST NOT pin generation to waitUntil anymore — that
      // was the broken pattern this fix removed.
      expect(src).not.toMatch(/c\.executionCtx\.waitUntil\(generationPromise\)/);
      expect(src).not.toMatch(/c\.executionCtx\.waitUntil\(\s*\(async/);
    });

    it("startedAt is sourced from the in-progress notification's created_at", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      // For in-progress responses, look up the open notification and
      // use its created_at — the earlier `piece.created_at` proxy was
      // wrong (the piece could be days old; the deep-dive generation
      // started seconds ago).
      expect(src).toMatch(
        /SELECT id, created_at FROM notifications[\s\S]{0,200}kind = 'deep_dive'[\s\S]{0,200}status = 'in_progress'/,
      );
      // For the post-claim response, startedAt is sourced from the
      // freshly-inserted notification row so its value matches what
      // future polls will compute (no millisecond drift between the
      // initial response and the poll responses).
      expect(src).toMatch(
        /SELECT created_at FROM notifications WHERE id = \?[\s\S]{0,200}fresh\?\.created_at/,
      );
    });

    it("runGeneration always resolves the notification — no partial-failure leaks", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      // The whole runGeneration body must be inside a try/catch so
      // even setup-time crashes (e.g. JSON.parse on malformed
      // fullPiece.content) flip the notification to `failed`. The
      // earlier shape only wrapped the inner generateDeepDive call,
      // leaving import failures / parse failures invisible to the
      // user.
      expect(src).toMatch(/const runGeneration = async[\s\S]{0,400}try \{/);
      // Failure path must transition the notification AND reset
      // has_deep_dive — both with their own .catch so one cleanup
      // failing doesn't stop the other.
      expect(src).toMatch(/transitionNotification[\s\S]{0,400}status:\s*"failed"[\s\S]{0,200}\.catch\(/);
      expect(src).toMatch(/UPDATE teaching_pieces SET has_deep_dive = 0[\s\S]{0,400}\.catch\(/);
      // The catch block must return a {status:"failed"} sentinel
      // rather than re-throwing — the streaming consumer relies on
      // runGeneration always resolving so it can stream a final JSON
      // body to the client.
      expect(src).toMatch(/return \{ status: "failed", error:/);
    });

    it("zombie-notification cleanup: stuck in-progress rows flip to failed when the slot is reset", async () => {
      const src = await readSrc("src/worker/routes/pieces.ts");
      // When the route resets a stuck slot (>2 minutes since the
      // notification fired), it must also fail-out the abandoned
      // notification so the bell shows the user something happened
      // — otherwise they'd see a perpetually-spinning row until the
      // 5-minute maintenance sweep reaped it.
      expect(src).toContain("Generation stuck for");
      expect(src).toContain("Deep dive timed out");
      // The "stuck" log + the "Deep dive timed out" notification
      // title should both appear in the zombie-cleanup branch (the
      // log comes first as a console.warn; the notification title
      // is on the transitionNotification call right after).
      const stuckLogIdx = src.indexOf("[deep-dive] Generation stuck");
      const timedOutIdx = src.indexOf("Deep dive timed out");
      expect(stuckLogIdx).toBeGreaterThan(0);
      expect(timedOutIdx).toBeGreaterThan(stuckLogIdx);
      // The abandoned notification gets transitioned to status:"failed"
      // — verify both pieces appear together in the cleanup block.
      const cleanupBlock = src.slice(stuckLogIdx, timedOutIdx + 200);
      expect(cleanupBlock).toMatch(/status:\s*"failed"/);
    });
  });

  describe("DeepDiveView (frontend)", () => {
    it("renders the loading state while status is 'generating' (not just during the initial fetch)", async () => {
      const src = await readRepoFile("src/frontend/pages/DeepDiveView.tsx");
      // The render condition must include the polling phase. The
      // earlier shape was `{loading && <DeepDiveLoadingState />}`,
      // which vanished the moment the first response landed even if
      // generation was still in flight server-side.
      expect(src).toMatch(
        /loading\s*\|\|\s*deepDive\?\.status === "generating"[\s\S]{0,200}<DeepDiveLoadingState/,
      );
      // Content only renders once status flips to ready — generating
      // responses don't carry content yet, so this guard prevents
      // the page from rendering an empty body during polling.
      expect(src).toMatch(/deepDive\?\.content && deepDive\.status === "ready"/);
    });

    it("DeepDiveLoadingState anchors elapsed seconds on server-supplied startedAt", async () => {
      const src = await readRepoFile("src/frontend/pages/DeepDiveView.tsx");
      // Component takes startedAt as a prop and seeds elapsed from
      // (now - startedAt) so re-mounting mid-generation jumps to the
      // correct stage. Without this, navigating back to the page
      // would always start at "Analyzing the teaching piece…".
      expect(src).toMatch(/function DeepDiveLoadingState\(\{ startedAt[^}]*\}/);
      expect(src).toMatch(
        /Date\.now\(\) - new Date\(startedAt\)\.getTime\(\)/,
      );
      // The interval recomputes from `startedAt` on every tick when
      // available, so background-tab throttling can't drift the
      // displayed elapsed away from real wall-clock time.
      expect(src).toMatch(/if \(startedAt\)\s*\{[\s\S]{0,200}setElapsed\(/);
    });

    it("polls every 3s and clears the timer on unmount", async () => {
      const src = await readRepoFile("src/frontend/pages/DeepDiveView.tsx");
      expect(src).toMatch(/setTimeout\(fetchDeepDive,\s*3000\)/);
      // The cleanup must clearTimeout the pending poll so navigating
      // away while a poll is queued doesn't leak fetches into a
      // component that no longer renders.
      expect(src).toMatch(/cancelled = true;[\s\S]{0,200}clearTimeout\(pollHandle\)/);
    });
  });

  describe("source provenance", () => {
    it("generator persists source_context JSON per teaching piece", async () => {
      const src = await readRepoFile("src/worker/services/briefing-generator.ts");
      expect(src).toContain("source_context");
      expect(src).toContain("JSON.stringify(target.sourceContext");
    });

    it("briefing routes parse and return source_context", async () => {
      const src = await readSrc("src/worker/routes/briefing.ts");
      expect(src).toContain('source_context:');
      expect(src).toContain('piece.source_context');
    });

    it("consolidated schema has source_context column", async () => {
      const sql = await readRepoFile("migrations/0001_initial.sql");
      expect(sql).toContain("source_context TEXT");
    });

    it("TeachingPiece component renders SourceProvenance", async () => {
      const src = await readRepoFile("src/frontend/components/TeachingPiece.tsx");
      expect(src).toContain("SourceProvenance");
      expect(src).toContain("SOURCE_TYPE_BADGES");
      expect(src).toContain("From your work");
      expect(src).toContain("From feeds");
    });
  });
});

describe("baseline quiz generation", () => {
  it("generates baseline questions on demand when none exist", async () => {
    // The inline generation was extracted into a shared helper so
    // the GET fallback and the async prep endpoint use the same
    // code path. The helper still references generateQuiz, the
    // baseline quiz_type tag, and the low-depth-concepts query.
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toContain("generateBaselineQuestions");
    expect(src).toContain("generateQuiz");
    expect(src).toContain("quiz_type = 'baseline'");
    expect(src).toContain("depth_score, 0) < 2");

    // The GET endpoint calls the shared helper as its fallback when
    // no pending rows exist (and there's no in-flight prep job).
    // Either the legacy single-router (`quizRoutes`) or the post-split
    // per-surface router (`quizBaselineRoutes`).
    const baselineRoute = src.match(
      /(?:quizRoutes|quizBaselineRoutes)\.get\("\/quiz\/baseline"[\s\S]*?\n\}\);/,
    );
    expect(baselineRoute).not.toBeNull();
    expect(baselineRoute?.[0]).toContain("generateBaselineQuestions");
  });
});

describe("user settings passed to generator", () => {
  it("manual generate route reuses the middleware-loaded user.settings (no partial column re-load)", async () => {
    // Inline-loading just `source_config + budget_cap_monthly +
    // relevance_threshold` was silently dropping `enabled_source_ids`
    // (and `filter_prompt`, `source_filter_overrides`). The dropped
    // gate then collapsed to `?? []` in the briefing-generator and
    // filtered every adjacent feed out — the failure mode that put
    // the user in a perpetual "No new content today" loop. The
    // user-context middleware already loads the full row; the
    // lifecycle handler now reuses that snapshot.
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toMatch(/const\s+userSettings\s*=\s*user\.settings\b/);
    // Multi-line tolerant: the call may be split across lines by the
    // formatter when wrapped inside a streaming-keepalive block.
    expect(src).toMatch(/generateDailyBriefing\([\s\S]*?userSettings,?\s*\)/);
    // Negative: the partial load must not come back. Pinning each
    // dropped column individually so a future refactor can't re-add
    // a half-load and silently lose the gate again.
    const partialLoadRe = /SELECT\s+source_config,\s*budget_cap_monthly,\s*relevance_threshold\s+FROM user_settings/;
    expect(src).not.toMatch(partialLoadRe);
  });

  it("cron scheduled handler loads and passes user settings + timezone", async () => {
    const src = await readRepoFile("src/worker/index.ts");
    // Settings now come from the shared `loadUserSettingsFromDb`
    // helper so the cron path parses every JSON column the
    // user-context middleware does (notably `enabled_source_ids` —
    // see the briefing-no-candidates regression in the lifecycle
    // route's history).
    expect(src).toContain("loadUserSettingsFromDb");
    // Cron still SELECTs the user's timezone so it can stamp
    // briefing_date in the user's local calendar — without this,
    // 5 AM UTC stamping rolls UTC-4 users onto "tomorrow" already.
    expect(src).toContain("SELECT id, timezone FROM users");
    // Multi-line tolerant: format/Biome may wrap the bind args across
    // multiple lines. We only require that userSettings + the user's
    // timezone fall through to the generator.
    expect(src).toMatch(
      /generateDailyBriefing\([\s\S]*?env\.DB[\s\S]*?userSettings[\s\S]*?user\.timezone/,
    );
    // Negative: the cron must not fall back to the previous
    // single-column load that omitted `enabled_source_ids`.
    expect(src).not.toMatch(/SELECT\s+source_config\s+FROM user_settings/);
  });

  it("manual generate route streams a heartbeat keepalive so CF edge doesn't 524", async () => {
    // Cloudflare's edge will 524 a request whose first byte takes more
    // than ~100s. Briefings now routinely exceed that (continuation
    // classifier + ADDITIVE rewrite per piece). The route must:
    // 1. Kick off generation as a fire-and-forget promise.
    // 2. Return a ReadableStream that writes a leading byte ASAP and
    //    a heartbeat byte well below the 100s edge timeout.
    // 3. Write the final JSON when generation resolves (or fails).
    // Heartbeats are pure whitespace so the concatenated body is
    // still valid JSON for the client's `apiPost`-style consumer.
    const src = await readSrc("src/worker/routes/briefing.ts");
    expect(src).toContain("new ReadableStream");
    // Heartbeat cadence: 25_000 ms is the recommended interval — well
    // under 100s but coarse enough to be cheap.
    expect(src).toMatch(/setInterval\([^,]+,\s*25_000\)/);
    // First byte sent before the heartbeat cadence kicks in (resets
    // the edge's first-byte timer immediately).
    expect(src).toMatch(/First byte goes out immediately|safeEnqueue\(" "\)/);
    // Failure path marks the briefing failed so the client's status
    // poll picks up the failure even if the stream itself was severed.
    expect(src).toMatch(/UPDATE briefings SET status = 'failed'/);
    // Frontend's `apiPost` calls res.json(); leading whitespace is
    // valid JSON, so heartbeats don't break parsing.
    expect(src).toContain("application/json");
  });
});
