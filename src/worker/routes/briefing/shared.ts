/**
 * Shared building blocks for the briefing routes.
 *
 * Centralised here because the read endpoints in
 * [`./read.ts`](./read.ts), the lifecycle endpoints in
 * [`./lifecycle.ts`](./lifecycle.ts), and the per-briefing extras
 * in [`./extra.ts`](./extra.ts) all need them.
 *
 * @see ../briefing.ts — assembly entry point
 */

import { BRIEFING_STUCK_TIMEOUT_MS } from "../../config/constants.js";
import type { UserContext } from "../../types.js";
import { userToday } from "../../util/time.js";

/**
 * Notification kind fired when the user triggers a briefing
 * regeneration via `/briefing/generate`. The bell flips to
 * `in_progress` for the duration of generation, then to `ready`
 * (success) or `failed` (error / cancelled) when the worker
 * finishes.
 *
 * The notification is what makes "trigger refresh, navigate away,
 * come back later" work — the generation runs under
 * `ctx.waitUntil` so it survives the client disconnect, and the
 * notification row is the user-visible signal that picks up
 * regardless of which tab / page they're on.
 */
export const BRIEFING_NOTIFICATION_KIND = "briefing_generation";

// A briefing is "zombie" when it's marked generating but hasn't written a
// metadata update in a while. The generator calls updateProgress on every
// pipeline transition, so a long silence means the worker died mid-run or a
// hung fetch is blocking cancellation. We let callers recover from this
// state without waiting for the generator to come back.
export function isZombie(status: string, updatedAt: string | null, metadata?: string | null): boolean {
  if (status !== "generating") return false;
  if (!updatedAt) return false;
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return false;
  const elapsed = Date.now() - updated;

  // If the generator never progressed past the initial "starting" step,
  // use a shorter timeout — this catches runtime cancellations (e.g.,
  // Cloudflare waitUntil killed on free tier after 30s).
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed.step === "starting" && elapsed > 45_000) return true;
    } catch {
      /* ignore */
    }
  }

  return elapsed > BRIEFING_STUCK_TIMEOUT_MS;
}

// "Today" is always the user's local calendar day, computed from
// `user.timezone` (resolved per-request from the X-Client-Timezone
// header in user-context middleware). The legacy `?date=` query
// parameter is no longer accepted — letting clients claim any date as
// "today" is exactly what produced the "Monday April 27 in the header
// while my wall clock says Sunday" bug.
export function todayFor(user: UserContext): string {
  return userToday(user.timezone);
}

/**
 * Decode the `briefings.redundant_drafts` JSON column into a typed
 * array. Returns an empty array for NULL ("classifier never ran") and
 * for malformed JSON ("never crash the briefing render path because of
 * a bad blob"). The shape mirrors what `briefing-generator.ts` writes.
 */
export interface RedundantDraftEntry {
  predecessor_id: string;
  predecessor_title: string;
  predecessor_series_id: string | null;
  predecessor_part_number: number | null;
  reason: string;
}

export function parseRedundantDrafts(raw: string | null): RedundantDraftEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as RedundantDraftEntry[];
  } catch {
    return [];
  }
}
