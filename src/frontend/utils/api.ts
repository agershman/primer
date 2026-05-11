/**
 * Frontend API helpers — the ONLY place in the frontend that calls
 * `fetch("/api/...")` directly (plus `useChat.ts` for SSE streaming,
 * which can't go through `JSON.parse`). Every other consumer uses
 * `apiGet` / `apiPost` / `apiPatch` / `apiDelete` so the
 * `X-Client-Timezone` header gets attached uniformly and the 503
 * retry semantics apply.
 *
 * Pinned by `tests/unit/api-helper-usage.test.ts` — bypass and CI
 * fails. The two allowed exceptions (this file + `useChat.ts`) are
 * listed there.
 *
 * @see tests/unit/api-helper-usage.test.ts — the contract test
 * @see .cursor/rules/frontend-conventions.mdc — auto-surfaces when editing frontend
 */

const API_BASE = "/api";

/**
 * Browser-detected IANA timezone, lazily resolved on first call. The
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` lookup is fast
 * but not free, and we'd otherwise pay it on every API call.
 *
 * The cache is intentionally invalidated when the document gains
 * focus (visibilitychange / focus listeners on the window), so a
 * traveler who flies between sessions immediately sees their new
 * local timezone reflected on the next request rather than waiting
 * for a hard reload.
 */
let cachedTimezone: string | null = null;

function detectTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.length > 0 ? tz : null;
  } catch {
    return null;
  }
}

function clientTimezone(): string | null {
  if (cachedTimezone) return cachedTimezone;
  cachedTimezone = detectTimezone();
  return cachedTimezone;
}

if (typeof window !== "undefined") {
  // Drop the cache when the user comes back to the tab so a TZ change
  // (the user travelled, or DST flipped while idle) is picked up on
  // the very next request — no need to refresh the page.
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") cachedTimezone = null;
  });
  window.addEventListener("focus", () => {
    cachedTimezone = null;
  });
}

/**
 * Build the headers object every API call uses. Centralised so we
 * never miss adding `X-Client-Timezone` on a new method (the worker's
 * user-context middleware reads it on every authenticated request to
 * resolve the user's local "today").
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const tz = clientTimezone();
  if (tz) headers["X-Client-Timezone"] = tz;
  return headers;
}

function resolvePath(path: string): string {
  return `${path.startsWith("/api") ? "" : API_BASE}${path}`;
}

export async function apiGet<T>(path: string): Promise<T> {
  // Retry network-level failures (TypeError from fetch — DNS, dropped
  // connection, mobile browser tearing down an in-flight request when
  // the page backgrounds). GET is safe to retry; the worker is the
  // source of truth, so a second attempt just re-reads. POSTs are
  // intentionally not retried here — non-idempotent side effects.
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(resolvePath(path), { headers: authHeaders() });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      if (err instanceof TypeError && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Request failed after retries");
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(resolvePath(path), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      return res.json() as Promise<T>;
    }
    // 503 during local dev often means wrangler restarted mid-request.
    // Retry after a short delay to let the worker come back up.
    if (res.status === 503 && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  throw new Error("Request failed after retries");
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(resolvePath(path), {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(resolvePath(path), {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T = void>(path: string): Promise<T> {
  const res = await fetch(resolvePath(path), {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
