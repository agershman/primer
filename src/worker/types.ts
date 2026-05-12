import type { SourceId } from "../shared/sources.js";

export interface Env {
  DB: D1Database;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  LINEAR_API_KEY: string;
  SLACK_TOKEN: string;
  INCIDENT_IO_API_KEY: string;
  GITHUB_TOKEN?: string;
  GITHUB_ORG?: string;
  /** Optional — enables OpenAI TTS voices in the Voice picker. */
  OPENAI_API_KEY?: string;
  /** Optional — enables ElevenLabs TTS voices (PR 3). */
  ELEVENLABS_API_KEY?: string;
  BUDGET_CAP_MONTHLY: string;
  RETENTION_DAYS: string;
  NEAR_MISS_RETENTION_DAYS: string;
  RELEVANCE_THRESHOLD: string;
  NEAR_MISS_FLOOR: string;

  // Auth provider extension point — see ADR 0006 and
  // src/worker/middleware/auth/. `PRIMER_AUTH_MODE` selects the
  // implementation; defaults to "cloudflare-access" when unset.
  // The CF_ACCESS_* vars are required when in cloudflare-access
  // mode; the factory throws at first request if they're missing.
  PRIMER_AUTH_MODE?: "cloudflare-access" | "dev-header";
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  /** Comma-separated explicit emails permitted to use this deployment. */
  ALLOWED_EMAILS?: string;
  /** Comma-separated bare domains permitted to use this deployment. */
  ALLOWED_EMAIL_DOMAINS?: string;
  /** Override the dev-header provider's header name (default `X-Primer-Dev-User`). */
  PRIMER_DEV_HEADER_NAME?: string;
  /** Local-dev fallback email when `dev-header` mode is active and no header is set. */
  PRIMER_DEV_USER?: string;
}

export interface IdentityClaims {
  email: string;
  sub?: string | null;
  iat?: number | null;
  exp?: number | null;
  country?: string | null;
  type?: string | null;
  iss?: string | null;
}

export interface AuthContext {
  email: string;
  identity: IdentityClaims;
  isDev: boolean;
}

export interface UserSettings {
  budgetCapMonthly?: number;
  briefingCron?: string;
  relevanceThreshold?: number;
  nearMissFloor?: number;
  retentionDays?: number;
  signalSurfaceMap?: Record<string, unknown>;
  filterPrompt?: string | null;
  sourceFilterOverrides?: Record<string, string>;
  /**
   * Per-user opt-in list of source IDs (matches `SourceProvider.id`).
   * Brand-new users land empty (everything off) and pick during
   * onboarding; existing users get backfilled with the full set in
   * migration 0004. The briefing pipeline filters singleton providers
   * and `source_instances` against this list before fetching.
   *
   * Typed as `SourceId[]` (literal union from `shared/sources.ts`)
   * rather than `string[]` so a typo'd id is a compile error rather
   * than a silent runtime no-op — see migration 0005 for the kind
   * of bug that costs us.
   */
  enabledSourceIds?: SourceId[];
  /**
   * Per-user toggle for the inline wavy-underline audit marks on
   * teaching pieces, deep dives, and quizzes. Defaults to true (the
   * audit signal is the headline trust feature; users opt out for
   * distraction-free reading). The `AuditIndicator` pill stays
   * visible regardless — only the inline marks are gated.
   */
  showAuditMarks?: boolean;
}

export function resolveFilterPrompt(settings: UserSettings, sourceId?: string): string | null {
  if (sourceId) {
    const override = settings.sourceFilterOverrides?.[sourceId];
    if (override) return override;
  }
  return settings.filterPrompt ?? null;
}

/**
 * Map a `WorkContextItem.type` (e.g. `linear_issue`, `slack_thread`,
 * `incident`, `github_pr`) to its singleton provider id (e.g.
 * `linear`, `slack`, `incident_io`, `github`). The provider id is
 * what the per-source override map keys against for singletons.
 *
 * Returns `null` when there's no mapping (in which case the caller
 * should fall back to the global filter for that item).
 */
export function singletonSourceKey(workContextType: string): string | null {
  if (workContextType === "linear_issue") return "linear";
  if (workContextType === "slack_thread") return "slack";
  if (workContextType === "incident") return "incident_io";
  if (workContextType === "github_pr" || workContextType === "github_issue") {
    return "github";
  }
  return null;
}

export interface UserContext {
  userId: string;
  email: string;
  displayName: string | null;
  /** Active focus statement text. Null when the user has not yet set one. */
  focusStatement: string | null;
  /** Foreign key into focus_statement_versions for the active version. Null when no statement. */
  focusVersionId: string | null;
  /** Active "about me" / persona statement text. Null when the user has not yet set one. */
  aboutStatement: string | null;
  /** Foreign key into about_statement_versions for the active version. */
  aboutVersionId: string | null;
  /**
   * Resolved IANA timezone for THIS request. Sourced from the
   * `X-Client-Timezone` header when present and valid, falling back
   * to the persisted `users.timezone` column. Always a usable
   * timezone (defaults to "UTC" when nothing else is available), so
   * downstream code can pass it straight to `Intl.DateTimeFormat`
   * without revalidating.
   *
   * Per-request rather than per-user because travelers should see
   * Tokyo's "today" while in Tokyo, even if their persisted TZ still
   * says New York — the middleware updates the stored value
   * eventually so the next cron run agrees.
   */
  timezone: string;
  settings: UserSettings;
  identity: IdentityClaims;
  isDev: boolean;
  /**
   * Whether this user is the deployment's admin. Admins can configure
   * sources, AI model picks, voice defaults, budget caps, and other
   * deployment-wide settings; regular users can only adjust their own
   * personalization (About, Focus, relevance filter prompt + per-source
   * overrides). The first user to provision a fresh deployment is
   * automatically the admin — see `worker/middleware/user-context.ts`
   * and migration `0002_user_admin.sql` for the bootstrap rules.
   */
  isAdmin: boolean;
  /**
   * Timestamp at which the user dismissed the bootstrap-admin
   * welcome dialog. NULL means they haven't seen it yet — the
   * frontend uses `needsBootstrapWelcome` (computed in `/api/me` as
   * `isAdmin && welcomedAsAdminAt === null`) to decide whether to
   * pop the modal. See migration `0003_user_admin_welcome.sql`.
   */
  welcomedAsAdminAt: string | null;
}

// `ContentBlock` and `Resource` are part of the API wire contract
// (worker → frontend) and live in `src/shared/types.ts`. Re-exported
// here so existing worker-side imports (`from "./types"` /
// `from "../types"`) keep working without a tree-wide rewrite, and
// so adding a new resource type in one place actually changes both
// sides at type-check time.
// Audit shapes — same rationale as ContentBlock / Resource above. Live
// in the shared module because they cross the wire on
// `GET /api/.../audit` and (as inline summaries) on every briefing
// read response.
export type {
  AuditClaim,
  AuditResolution,
  AuditSummary,
  AuditTargetKind,
  AuditTrail,
  AuditVerdict,
  ContentBlock,
  Resource,
  WebEvidence,
} from "../shared/types";
