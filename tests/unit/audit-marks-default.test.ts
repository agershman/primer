import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * Round-1 of the audit feature shipped with `showAuditMarks` defaulting
 * to TRUE on the backend (user-context.ts), the frontend
 * (useSettings.ts DEFAULT_SETTINGS), and hardcoded TRUE in
 * `TeachingPiece.tsx`. The user feedback was that inline wavy
 * underlines are too noisy by default — the indicator pill already
 * surfaces "Audited · N dropped" prominently, and the per-piece
 * dropdown lets users opt-in to marks when they want to inspect.
 *
 * Round-2 flipped the default to FALSE across all three layers. This
 * test pins those three flips so a future refactor that re-introduces
 * a `true` default in any one layer fails CI rather than silently
 * regressing the UX.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("showAuditMarks default is off", () => {
  it("backend user-context.ts defaults the setting to false when the column is null", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    // The whole expression must end in `: false`. If someone flips
    // it back to `: true`, the assertion fails and the comment block
    // above explains why.
    expect(src).toMatch(/show_audit_marks\s*==\s*null\s*\?\s*false\s*:/);
  });

  it("settings route GET response defaults to false when the column is null", async () => {
    const src = await read("src/worker/routes/settings.ts");
    expect(src).toMatch(/show_audit_marks\s*\?\?\s*0\)\s*===\s*1/);
  });

  it("frontend DEFAULT_SETTINGS.showAuditMarks is false", async () => {
    const src = await read("src/frontend/hooks/useSettings.ts");
    expect(src).toMatch(/showAuditMarks:\s*false/);
  });

  it("TeachingPiece initial marksVisible state reads from settings, not hardcoded true", async () => {
    const src = await read("src/frontend/components/TeachingPiece.tsx");
    // The hardcoded `useState(true)` from round-1 must be gone.
    expect(src).not.toMatch(/useState\(true\)[\s\S]{0,200}marksVisible/);
    // And the new initialiser must read from the settings context.
    expect(src).toMatch(/currentUser\?\.settings\?\.showAuditMarks\s*\?\?\s*false/);
  });
});
