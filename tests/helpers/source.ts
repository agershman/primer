/**
 * Source-text contract test helpers.
 *
 * Several of our routes split into folders (e.g. `routes/quiz.ts` is
 * a thin assembly point that combines `quiz/shared.ts`,
 * `quiz/inline.ts`, and `quiz/baseline.ts`). The existing source-text
 * contract tests assert on patterns that may live in any of those
 * sibling files. `readSplitSource(path)` concatenates the assembly
 * file and all sibling files inside the matching sub-directory so a
 * single regex match works across the family.
 *
 * For paths that don't have a sibling sub-directory the function just
 * returns the file contents — drop-in replacement for `readFile`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Read a source file plus every TS/TSX file inside a sibling
 * sub-directory of the same base name and return their combined
 * contents.
 *
 * Example: for `src/worker/routes/quiz.ts`, returns the contents of:
 *   - `src/worker/routes/quiz.ts`
 *   - `src/worker/routes/quiz/*.ts`
 *
 * Files are joined with newlines so multi-line regex anchors still
 * work; the order is the assembly file first, then sub-files in
 * alphabetical order so any pattern that depends on the assembly
 * appearing first stays stable.
 */
export async function readSplitSource(relPath: string): Promise<string> {
  const absPath = resolve(REPO_ROOT, relPath);
  const head = await readFile(absPath, "utf-8");

  const { dir, name } = parse(absPath);
  const siblingDir = resolve(dir, name);
  let exists = false;
  try {
    const s = await stat(siblingDir);
    exists = s.isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return head;

  const entries = await readdir(siblingDir, { withFileTypes: true });
  const tails: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    tails.push(await readFile(resolve(siblingDir, entry.name), "utf-8"));
  }
  return [head, ...tails].join("\n");
}

/**
 * Same as `readSplitSource` but anchored at a specific repo-relative
 * path. Useful when a test hard-codes its REPO_ROOT to a different
 * location and just wants the helper for the join behaviour.
 */
export async function readSplitSourceFrom(repoRoot: string, relPath: string): Promise<string> {
  const absPath = resolve(repoRoot, relPath);
  const head = await readFile(absPath, "utf-8");

  const { dir: _dir, name } = parse(absPath);
  const siblingDir = resolve(dirname(absPath), name);
  let exists = false;
  try {
    const s = await stat(siblingDir);
    exists = s.isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return head;

  const entries = await readdir(siblingDir, { withFileTypes: true });
  const tails: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    tails.push(await readFile(resolve(siblingDir, entry.name), "utf-8"));
  }
  return [head, ...tails].join("\n");
}
