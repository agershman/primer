/**
 * Source-text contract test: pin that frontend components use the
 * Primer design-token classes (`bg-bg`, `text-text-primary`,
 * `bg-positive`, `text-negative`, etc.) instead of raw Tailwind
 * palette classes (`bg-zinc-*`, `text-emerald-*`, `bg-blue-*`,
 * `text-red-*`, …).
 *
 * Why this matters
 * ----------------
 * Pre-fix, `AdminSourcesPage` was the only file using raw palette
 * classes (`bg-zinc-900/50`, `text-emerald-400`, `bg-blue-900/30`).
 * That page broke in light mode (zinc-900 is dark regardless of
 * theme) and looked subtly different from every other page even
 * in dark mode (different greys, different reds). The token
 * system in `tokens.css` exists precisely so the whole app
 * theme-switches uniformly.
 *
 * Allowed exceptions
 * ------------------
 *   - `tokens.css` itself (where the raw palette is the *target*
 *     of the mapping, not a consumer).
 *   - `RichText.tsx` — uses `bg-zinc-*` for the per-block code
 *     theme syntax-highlighter overrides, which intentionally
 *     diverge from the site theme (the user can opt into a
 *     dark-on-light code block on a light-mode site).
 *   - HelpArticlePage / Mintlify-imported MD components rendering
 *     prose styles — they use the typography plugin's own
 *     `prose-zinc` etc., which is a token-aliased name in that
 *     plugin.
 *
 * Adding a new exception requires editing `ALLOWED_FILES` here
 * AND documenting why in the consuming file.
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Files that are allowed to reference the raw Tailwind palette.
 * Every other frontend file should consume design tokens.
 */
const ALLOWED_FILES = new Set<string>([
  "src/frontend/styles/tokens.css",
  // RichText's per-block code-theme override deliberately uses
  // the prism palette (which maps to zinc/slate/etc.) so the
  // dark/light decision is per-block, not site-wide.
  "src/frontend/components/RichText.tsx",
]);

/**
 * Forbidden raw-palette class prefixes. The list is conservative —
 * we only flag the colour scales that have a direct token
 * equivalent (zinc → bg / surface, emerald → positive, blue →
 * accent / link, red → negative). amber / yellow are flagged via
 * the warning token. Slate / gray / neutral aren't blocked
 * because the codebase uses `text-text-*` for those today and
 * adding them here would over-fit.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\b(bg|text|border|ring|from|via|to)-(zinc|emerald|blue|red|amber|yellow|orange|green|cyan|teal|indigo|violet|purple|fuchsia|pink|rose|sky|stone)-\d/,
];

async function listTsxFiles(rootRel: string): Promise<string[]> {
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

describe("frontend uses design tokens (not raw Tailwind palette)", () => {
  it("no frontend file uses bg-zinc-/text-emerald-/bg-blue-/etc. outside the allowlist", async () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const files = await listTsxFiles("src/frontend");
    for (const relPath of files) {
      const normalized = relPath.replace(/\\/g, "/");
      if (ALLOWED_FILES.has(normalized)) continue;
      const src = await readFile(resolve(REPO_ROOT, normalized), "utf-8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip lines that are entirely comments — useful for
        // documenting the OLD raw-palette class without tripping
        // the regex (e.g. "// pre-fix this used bg-zinc-900").
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push({ file: normalized, line: i + 1, text: line.trim() });
            break;
          }
        }
      }
    }

    expect(
      offenders,
      `Found ${offenders.length} raw-palette use(s). Replace with design tokens ` +
        `(see src/frontend/styles/tokens.css). Common mappings:\n` +
        `  bg-zinc-900     → bg-bg-warm    or  bg-surface\n` +
        `  text-zinc-500   → text-text-dim\n` +
        `  text-emerald-*  → text-positive\n` +
        `  bg-emerald-*    → bg-positive   or  bg-positive-dim\n` +
        `  text-red-*      → text-negative\n` +
        `  bg-blue-*       → bg-accent     or  bg-accent-dim\n` +
        `  text-blue-*     → text-accent   or  text-link\n\n` +
        `Offenders:\n${offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });
});
