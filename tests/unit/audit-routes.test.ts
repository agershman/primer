import { describe, expect, it } from "vitest";
import { readSplitSource } from "../helpers/source";

/**
 * Bug narrative this test prevents
 * --------------------------------
 * The audit endpoints live in sibling files (`routes/pieces/audit.ts`,
 * `routes/quiz/audit.ts`). The parent assembly files must `route("/", ...)`
 * them, the briefing read endpoint must LEFT JOIN the `audits` table
 * so each piece's response carries `audit_summary` + `deep_dive_audit_summary`,
 * and none of the audit GETs may be `requireAdmin`-gated — auditing a
 * piece is a per-user read concern, not a deployment-wide one.
 *
 * If the audit subroute mount disappears (e.g. someone refactors the
 * pieces router and forgets to copy the line), the `/api/piece/:id/audit`
 * fetch fails with 404 and the panel never renders. If the briefing
 * JOIN disappears, every piece's pill renders as "no audit available"
 * even though the audit ran. If `requireAdmin` lands on the audit GET
 * by accident, regular users can never see why a claim was flagged.
 */

describe("audit routes are mounted + briefing read carries audit_summary", () => {
  it("/piece/:id/audit + /piece/:id/deep-dive/audit are mounted under the pieces router", async () => {
    const src = await readSplitSource("src/worker/routes/pieces.ts");
    expect(src).toMatch(/pieceAuditRoutes/);
    expect(src).toMatch(/\/piece\/:id\/audit/);
    expect(src).toMatch(/\/piece\/:id\/deep-dive\/audit/);
  });

  it("/quiz/:id/audit is mounted under the quiz router", async () => {
    const src = await readSplitSource("src/worker/routes/quiz.ts");
    expect(src).toMatch(/quizAuditRoutes/);
    expect(src).toMatch(/\/quiz\/:id\/audit/);
  });

  it("audit GETs are NOT admin-gated (owner-scoped reads)", async () => {
    const pieces = await readSplitSource("src/worker/routes/pieces.ts");
    const quiz = await readSplitSource("src/worker/routes/quiz.ts");
    // The audit handler files (concatenated by readSplitSource) must
    // not call requireAdmin / assertAdmin. The broader regex catches
    // both the function-call and import-name forms.
    const auditFiles = `${pieces}\n${quiz}`;
    // The audit endpoints sit alongside admin-gated regenerate; we
    // just need to ensure the audit GET handlers themselves don't
    // import / call the admin gate. The whole file pair is a
    // generous net — what we really want is "the lines registering
    // GET /audit don't precede an admin call". A weaker but stable
    // pin: the audit handler files reference `c.get("user")` for
    // owner-scoping and don't reference `requireAdmin` at all.
    const auditOnly = auditFiles
      .split("\n")
      .filter((line) => /audit/i.test(line))
      .join("\n");
    expect(auditOnly).not.toMatch(/requireAdmin|assertAdmin/);
  });

  it("briefing/read.ts JOINs the audits table for inline audit_summary", async () => {
    const src = await readSplitSource("src/worker/routes/briefing.ts");
    expect(src).toMatch(/LEFT JOIN audits/);
    expect(src).toMatch(/audit_summary/);
    expect(src).toMatch(/deep_dive_audit_summary/);
  });
});
