/**
 * Timezone-aware date helpers shared across the worker.
 *
 * Why this lives in a single util module: every place that asks
 * "what's today for this user?" must agree on the answer. If one
 * route uses UTC and another uses the user's local TZ, you get the
 * exact category of bug we shipped (briefing stamped in UTC, query
 * looking up local — mismatch, surprise briefings appear/disappear).
 * One helper, one definition of truth.
 */

/** A small allowlist of edge-case TZ inputs we tolerate at the
 *  boundary. The browser API `Intl.DateTimeFormat().resolvedOptions().timeZone`
 *  returns a real IANA name on every modern engine, but we still
 *  accept "UTC" / "Etc/UTC" defensively because:
 *   - Server-side calls (cron, tests) may pass plain "UTC".
 *   - Some environments report "Etc/UTC" instead of "UTC".
 *   - The DB default is the literal string 'UTC'.
 */
const KNOWN_UTC_ALIASES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT"]);

/**
 * Returns true when the candidate string is a usable IANA timezone.
 *
 * This is the same check we apply on the request boundary (header)
 * and at persistence time. Anything that round-trips through
 * `Intl.DateTimeFormat({ timeZone })` without throwing counts.
 *
 * The runtime check matters because the X-Client-Timezone header is
 * untrusted user input — a malicious or buggy client could send
 * "America/Pluto" and crash every formatter call downstream. We
 * validate once at the gate and let everything else assume the value
 * is good.
 */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  if (KNOWN_UTC_ALIASES.has(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns YYYY-MM-DD for "now" rendered in the given IANA timezone.
 *
 * Why `en-CA`: of all the locales `Intl.DateTimeFormat` supports, the
 * Canadian-English locale formats `2026-04-27` natively for the
 * year/month/day fields — exactly the shape we store in
 * `briefing_date`. Other locales (including `en-US`) use slash- or
 * dot-separated forms that we'd have to reassemble. Less code, fewer
 * bugs.
 *
 * Falls back to UTC when the timezone is unknown so that callers
 * always get a usable string. The middleware should already have
 * normalised the input, but defense-in-depth is cheap here.
 */
export function userToday(timezone: string | null | undefined, now: Date = new Date()): string {
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  // `formatToParts` is more reliable than `format` when we only want
  // the date components — it gives us labelled parts we can pluck
  // even if the locale returned them in a different order.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Shift a YYYY-MM-DD calendar-day string by N days.
 *
 * Used by surfaces that compute "earliest retained date" or "this
 * week" relative to the user's local today. We anchor the date at
 * 12:00 UTC before doing the math so DST transitions in the
 * underlying timezone can't push the result onto a different
 * calendar day. The output is still a YYYY-MM-DD string in the
 * user's local frame (i.e. the same frame as the input).
 */
export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a timezone for the request: prefer the X-Client-Timezone
 * header (so a traveler's browser is the source of truth this
 * session), falling back to the persisted column. Both are validated;
 * unrecognised values fall through to UTC so an attacker can't crash
 * the date formatter by sending garbage.
 *
 * Returns the resolved TZ and a flag indicating whether the header
 * value differs from what's persisted — the middleware uses that to
 * decide whether to write back.
 */
export function resolveRequestTimezone(
  headerValue: string | null | undefined,
  persisted: string | null | undefined,
): { timezone: string; shouldPersist: boolean } {
  const header = isValidTimezone(headerValue) ? headerValue : null;
  const stored = isValidTimezone(persisted) ? persisted : null;
  if (header) {
    return {
      timezone: header,
      shouldPersist: header !== stored,
    };
  }
  return {
    timezone: stored ?? "UTC",
    shouldPersist: false,
  };
}
