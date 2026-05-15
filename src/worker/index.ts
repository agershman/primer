import { Hono } from "hono";
import { cors } from "hono/cors";
import { userContext } from "./middleware/user-context.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { briefingRoutes } from "./routes/briefing.js";
import { chatRoutes } from "./routes/chat.js";
import { conceptRoutes } from "./routes/concepts.js";
import { githubRoutes } from "./routes/github.js";
import { modelsRoutes } from "./routes/models.js";
import { notificationRoutes } from "./routes/notifications.js";
import { pieceRoutes } from "./routes/pieces.js";
import { previewRoutes } from "./routes/preview.js";
import { quizRoutes } from "./routes/quiz.js";
import { settingsRoutes } from "./routes/settings.js";
import { sourceInstanceRoutes } from "./routes/source-instances.js";
import { sourcesRoutes } from "./routes/sources.js";
import { systemRoutes } from "./routes/system.js";
import { userRoutes } from "./routes/users.js";
import { generateDailyBriefing } from "./services/briefing-generator.js";
import { runMaintenanceJob } from "./services/maintenance.js";
import type { Env, UserContext } from "./types.js";
import { loadUserSettingsFromDb } from "./util/load-user-settings.js";

type AppEnv = { Bindings: Env; Variables: { user: UserContext } };

const app = new Hono<AppEnv>();

app.use("/api/*", cors());
app.use("/api/*", userContext);

app.route("/api", systemRoutes);
app.route("/api", briefingRoutes);
app.route("/api", pieceRoutes);
app.route("/api", conceptRoutes);
app.route("/api", quizRoutes);
app.route("/api", chatRoutes);
app.route("/api", settingsRoutes);
app.route("/api", previewRoutes);
app.route("/api", modelsRoutes);
app.route("/api", analyticsRoutes);
app.route("/api", bookmarkRoutes);
app.route("/api", githubRoutes);
app.route("/api", sourceInstanceRoutes);
app.route("/api", notificationRoutes);
app.route("/api", sourcesRoutes);
app.route("/api", userRoutes);

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;

    if (cron === "0 5 * * *") {
      // Pull each user's persisted timezone alongside the row so the
      // generator stamps `briefing_date` in their local calendar.
      // Without the TZ, cron would always stamp UTC's date — meaning
      // a UTC-4 user wakes up Monday to a "Tuesday" briefing because
      // 5 AM UTC has already rolled past midnight in UTC+0.
      const users = await env.DB.prepare("SELECT id, timezone FROM users").all<{
        id: string;
        timezone: string | null;
      }>();
      // Run users CONCURRENTLY with a concurrency limit. Pre-fix
      // this loop was strictly serial, which meant cron's wallclock
      // was the SUM of every user's briefing generation time —
      // typically 30 s–2 min per user. With more than ~5 users the
      // serial path approaches Cloudflare's worker-invocation
      // budget. With a small concurrency cap we get most of the
      // parallelism win without hammering D1 / Anthropic /
      // OpenSearch (each LLM provider also has its own per-key
      // concurrency limits we don't want to saturate).
      //
      // Cap: 3 users at a time. Conservative on purpose — if we
      // see headroom in production logs we can bump this. The
      // upgrade path is a Queues fan-out (one message per user,
      // consumer does the per-user pipeline) but that's more
      // infrastructure than a single-deployment instance needs.
      const userList = users.results;
      await runWithConcurrencyCap(userList, 3, async (user) => {
        console.log(`[cron] Generating daily briefing for user ${user.id}`);
        try {
          // Load the FULL settings row, not just `source_config`. The
          // earlier shape silently dropped `enabled_source_ids`, which
          // the briefing-generator passes into `scanAdjacentSources`
          // — and the adjacent gate treats a missing list as "filter
          // every feed out", not "no gate". The result was a cron
          // path that always finalized as `no_candidates` once the
          // empty-state UI started surfacing the row instead of
          // hiding it. The shared loader keeps this in lockstep with
          // the user-context middleware so both call sites parse the
          // JSON columns the same way.
          const userSettings = (await loadUserSettingsFromDb(env.DB, user.id)) ?? undefined;

          const result = await generateDailyBriefing(
            env.DB,
            user.id,
            env,
            undefined,
            userSettings,
            user.timezone ?? "UTC",
          );
          console.log(
            `[cron] Briefing ${result.briefingId} for ${user.id}: ${result.status} (${result.pieceCount} pieces)`,
          );
          if (result.errors.length > 0) {
            console.warn(`[cron] Briefing errors: ${result.errors.join(", ")}`);
          }
        } catch (err) {
          console.error(`[cron] Fatal error generating briefing for ${user.id}:`, err);
        }
      });
    }

    // Cloudflare passes the literal cron string from wrangler.toml,
    // which uses "SUN" (not "0"). Earlier the handler checked
    // "0 3 * * 0" so the Sunday maintenance branch never matched.
    if (cron === "0 3 * * SUN") {
      console.log("[cron] Running Sunday maintenance job");
      const allUsers = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();

      // Maintenance is mostly D1 reads + small UPDATEs — much
      // lighter than briefing generation — so we can parallelize
      // a bit more aggressively. Cap at 5 to keep D1 batch
      // contention manageable.
      await runWithConcurrencyCap(allUsers.results, 5, async (user) => {
        try {
          const settings = await env.DB.prepare("SELECT retention_days FROM user_settings WHERE user_id = ?")
            .bind(user.id)
            .first<{ retention_days: number }>();

          const retentionDays = settings?.retention_days ?? parseInt(env.RETENTION_DAYS || "365", 10);
          const nearMissRetentionDays = parseInt(env.NEAR_MISS_RETENTION_DAYS || "30", 10);

          await runMaintenanceJob(env.DB, user.id, retentionDays, nearMissRetentionDays, env);
          console.log(`[cron] Maintenance complete for user ${user.id}`);
        } catch (err) {
          console.error(`[cron] Maintenance failed for user ${user.id}:`, err);
        }
      });
    }
  },
};

/**
 * Runs `task` for each item in `items`, with at most `cap`
 * tasks in flight at any one time.
 *
 * Implementation: a tiny pool that pulls from the items array as
 * workers free up. No external dependency — small enough that
 * importing `p-limit` would cost more in module weight than the
 * code we'd save.
 *
 * Errors are swallowed at the task level (callers wrap their own
 * try/catch — see the cron handlers above), so a single failed
 * user doesn't sink the whole cron run. The caller's per-task
 * try/catch is the right granularity for "log + continue"
 * semantics; a global Promise.all would short-circuit on the
 * first rejection.
 */
async function runWithConcurrencyCap<T>(items: T[], cap: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const workers: Array<Promise<void>> = [];
  const next = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await task(item);
    }
  };
  for (let i = 0; i < Math.min(cap, items.length); i++) {
    workers.push(next());
  }
  await Promise.all(workers);
}
