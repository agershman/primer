import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * The audit schema lives in migration 0007 and is the foundation of
 * the whole feature. If a future migration alters / drops the tables
 * (or someone re-orders the file numbering), the auditor's INSERTs
 * blow up at runtime instead of failing fast in CI. A source-text
 * contract test on the migration file is the cheapest catch.
 *
 * Also pins the `show_audit_marks` ALTER on user_settings — the
 * per-user toggle column the AuditIndicator dropdown writes to.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");

describe("migration 0007 declares the audit tables + show_audit_marks column", () => {
  it("creates the audits table with target_kind / pass / status columns", async () => {
    const src = await read("migrations/0007_content_audits.sql");
    expect(src).toMatch(/CREATE TABLE audits/);
    expect(src).toMatch(/target_kind TEXT NOT NULL CHECK \(target_kind IN \('piece', 'deep_dive', 'quiz'\)\)/);
    expect(src).toMatch(/pass INTEGER NOT NULL CHECK \(pass IN \(1, 2\)\)/);
    expect(src).toMatch(/status TEXT NOT NULL CHECK \(status IN \('clean', 'patched', 'dropped', 'failed'\)\)/);
  });

  it("creates the audit_claims table with block-relative offsets", async () => {
    const src = await read("migrations/0007_content_audits.sql");
    expect(src).toMatch(/CREATE TABLE audit_claims/);
    expect(src).toMatch(/block_index INTEGER NOT NULL/);
    expect(src).toMatch(/span_start INTEGER NOT NULL/);
    expect(src).toMatch(/span_end INTEGER NOT NULL/);
    expect(src).toMatch(
      /verdict TEXT NOT NULL CHECK \(verdict IN \('grounded', 'grounded-web', 'unsupported', 'hallucinated'\)\)/,
    );
  });

  it("indexes audits by target + by user/created", async () => {
    const src = await read("migrations/0007_content_audits.sql");
    expect(src).toMatch(/CREATE INDEX idx_audits_target/);
    expect(src).toMatch(/CREATE INDEX idx_audits_user_created/);
    expect(src).toMatch(/CREATE INDEX idx_audit_claims_audit/);
  });

  it("adds show_audit_marks to user_settings (default 1)", async () => {
    const src = await read("migrations/0007_content_audits.sql");
    expect(src).toMatch(/ALTER TABLE user_settings\s+ADD COLUMN show_audit_marks INTEGER NOT NULL DEFAULT 1/);
  });
});
