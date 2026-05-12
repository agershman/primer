import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * The `ModelsPanel.tsx` renders one row per entry in `MODEL_OPERATIONS`,
 * not by introspecting the `ModelOperation` union. If a future refactor
 * removes the `audit` / `auditPatch` entries from that array, admins
 * lose the picker even though the underlying override system still
 * resolves the operation against the catalog. Pinning the entries here
 * catches the "someone reordered the panel and dropped an entry"
 * regression.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("ModelsPanel lists audit + auditPatch in MODEL_OPERATIONS", () => {
  it("MODEL_OPERATIONS includes audit", async () => {
    const src = await read("src/frontend/components/settings/panels/ModelsPanel.tsx");
    expect(src).toMatch(/key:\s*"audit"/);
    expect(src).toMatch(/label:\s*"Audit"/);
  });

  it("MODEL_OPERATIONS includes auditPatch", async () => {
    const src = await read("src/frontend/components/settings/panels/ModelsPanel.tsx");
    expect(src).toMatch(/key:\s*"auditPatch"/);
    expect(src).toMatch(/label:\s*"Audit patch"/);
  });
});
