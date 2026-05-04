/**
 * Source-text contract test: pin that no frontend file outside the
 * api utility / known SSE callers makes raw `fetch("/api/...")`
 * calls.
 *
 * Why this matters
 * ----------------
 * The shared `apiGet` / `apiPost` / `apiPatch` / `apiDelete`
 * helpers in `src/frontend/utils/api.ts` automatically attach the
 * `X-Client-Timezone` header (read by the worker's user-context
 * middleware) and apply uniform 503 retry behaviour. Pre-fix,
 * several pages and panels bypassed these helpers and called
 * `fetch("/api/...")` directly, silently dropping the timezone
 * header on those routes — not a user-visible bug today, but a
 * footgun for any future request-context middleware that depends
 * on a header being uniformly present.
 *
 * This test makes that contract explicit: bypassing the helpers
 * is a CI failure. The two legitimate exceptions are listed in
 * `ALLOWED_FILES`:
 *   - `src/frontend/utils/api.ts` itself (where the helpers
 *     necessarily call native `fetch`).
 *   - `src/frontend/hooks/useChat.ts` (SSE streaming path —
 *     `apiGet` / `apiPost` JSON-parse the response, which is
 *     wrong for an event-stream).
 *
 * If you legitimately need to bypass the helpers from a NEW file,
 * extend `ALLOWED_FILES` here AND document why in the consuming
 * file's top-level comment so future readers (and AI agents)
 * understand the carve-out.
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Recursive directory walk yielding all `.ts` / `.tsx` files under
 * the given root, returning paths relative to `REPO_ROOT` with
 * forward slashes (cross-platform stable). Implemented inline
 * rather than depending on `glob` / `bun:Glob` to keep the test
 * suite portable across Node and Bun runners.
 */
async function listTsFiles(rootRel: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (relDir: string) => {
    const absDir = resolve(REPO_ROOT, relDir);
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        out.push(relPath);
      }
    }
  };
  await walk(rootRel);
  return out;
}

/**
 * Files that legitimately call `fetch("/api/...")` directly. Every
 * other frontend file must route through the helpers in
 * `src/frontend/utils/api.ts`.
 */
const ALLOWED_FILES = new Set<string>([
  "src/frontend/utils/api.ts",
  "src/frontend/hooks/useChat.ts",
]);

describe("frontend uses apiGet/apiPost helpers (not raw fetch)", () => {
  it("no frontend file calls fetch(\"/api/...\") outside the api helpers + useChat SSE path", async () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const files = await listTsFiles("src/frontend");
    for (const relPath of files) {
      // Normalize path separator for cross-platform stability.
      const normalized = relPath.replace(/\\/g, "/");
      if (ALLOWED_FILES.has(normalized)) continue;
      const src = await readFile(resolve(REPO_ROOT, normalized), "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comment-only mentions of `fetch(`. We allow
        // documentation references to the pattern (e.g. a comment
        // explaining "we used to call fetch('/api/...')") because
        // those are useful breadcrumbs for future readers.
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

        // Detect `fetch("/api/...")` and `fetch(\`/api/...\`)`.
        // The single-line check is sufficient — multi-line
        // fetch calls always have the URL on the same line as
        // the `fetch(` call.
        if (/\bfetch\(\s*["'`]\/api\b/.test(line)) {
          offenders.push({
            file: normalized,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      offenders,
      // Custom message so a regression points the offender at the
      // exact fix path. This is the kind of error message that
      // saves a future engineer (or AI agent) a ten-minute hunt
      // through the codebase.
      `Found ${offenders.length} raw fetch("/api/...") call(s). ` +
        `Route these through apiGet / apiPost / apiPatch / apiDelete in ` +
        `src/frontend/utils/api.ts so they pick up the X-Client-Timezone ` +
        `header automatically:\n${offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });
});
