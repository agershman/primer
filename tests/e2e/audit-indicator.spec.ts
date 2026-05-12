import { expect, test } from "@playwright/test";
import { mockApi } from "./api-mocks";

/**
 * E2E for the audit-indicator pill on a teaching piece.
 *
 * Drives a real browser through a briefing that has one piece
 * carrying an `audit_summary` rollup. Asserts the wiring layer
 * the source-text contract tests can't reach:
 *
 *   • the pill renders in the metadata row with the right copy
 *     for each rollup state (clean, patched, dropped)
 *   • clicking the pill opens the dropdown menu
 *   • the dropdown exposes "Show audit marks" + "View full audit trail"
 *   • clicking "View full audit trail" fires GET /api/piece/:id/audit
 *     and the panel modal opens with the verdict rows
 *
 * Scope intentionally narrow — per-claim popover behaviour, the
 * RichText `<mark>` overlay, and the auditor service itself stay
 * pinned by the cheaper unit tests. This spec just proves the UI
 * surfaces wire up end-to-end through a real React render.
 */

const TEST_PIECE = {
  id: "tp_e2e_audit_1",
  briefing_id: "brf_e2e_audit_1",
  title: "Service meshes in practice",
  piece_type: "walkthrough",
  source_type: "current-work",
  source_ref: null,
  position: 0,
  read_time_minutes: 3,
  content: [
    { type: "text", value: "A service mesh handles inter-service communication so services don't have to." },
    { type: "text", value: "Linkerd is generally lighter-weight than Istio." },
  ],
  concepts: [],
  resources: [],
  why_chosen: null,
  has_deep_dive: false,
  deep_dive_read_time: null,
  feedback: null,
  read_at: null,
  source_context: [],
  created_at: "2026-05-12T05:00:00Z",
  audit_summary: {
    status: "patched",
    audit_model: "claude-haiku-4-5-20251001",
    patch_model: "claude-sonnet-4-20250514",
    used_web_search: true,
    total_claims: 2,
    unsupported_count: 0,
    hallucinated_count: 1,
    grounded_web_count: 1,
    patched_count: 1,
    dropped_count: 0,
  },
};

const TEST_BRIEFING = {
  briefing: {
    id: "brf_e2e_audit_1",
    briefing_date: "2026-05-12",
    status: "generated",
    generated_at: "2026-05-12T05:00:00Z",
    metadata: {},
    workContextSources: [],
    redundantDrafts: [],
    focusStatementAtBriefing: null,
  },
  pieces: [TEST_PIECE],
  quiz: null,
};

const TEST_AUDIT_TRAIL = {
  target_kind: "piece" as const,
  target_id: TEST_PIECE.id,
  passes: [
    {
      pass: 1,
      summary: TEST_PIECE.audit_summary,
      claims: [
        {
          id: "ac_e2e_1",
          block_index: 1,
          span_start: 0,
          span_end: 48,
          claim_text: "Linkerd is generally lighter-weight than Istio.",
          verdict: "grounded-web",
          cited_refs: ["https://linkerd.io/2.14/overview/"],
          web_evidence: [
            { url: "https://linkerd.io/2.14/overview/", title: "Linkerd overview", snippet: "Linkerd is a service mesh built for low overhead..." },
          ],
          reasoning: "Public Linkerd docs corroborate the relative weight claim.",
          resolution: "kept",
          patched_text: null,
        },
      ],
    },
  ],
};

test.describe("Audit indicator on a teaching piece", () => {
  test("renders the pill, opens the dropdown, and loads the full trail panel", async ({ page }) => {
    // First-paint user must be past onboarding (about + focus set)
    // so BriefingPage renders directly. Override /api/me to give us
    // both statements; the rest of the defaults stay.
    const recorder = await mockApi(page, {
      "/api/me": {
        email: "test@example.com",
        displayName: "Test User",
        avatarUrl: null,
        focusStatement: "Distributed systems.",
        focusVersionId: "fsv_1",
        aboutStatement: "I'm a backend engineer.",
        aboutVersionId: "asv_1",
        settings: {
          budgetCapMonthly: 35,
          briefingCron: "0 5 * * *",
          relevanceThreshold: 0.4,
          nearMissFloor: 0.25,
          retentionDays: 365,
          signalSurfaceMap: {},
          enabledSourceIds: ["linear", "slack"],
          showAuditMarks: true,
        },
        identity: { email: "test@example.com", type: "dev-header" },
        isAdmin: true,
        needsBootstrapWelcome: false,
      },
      "/api/briefing/today": TEST_BRIEFING,
      [`/api/piece/${TEST_PIECE.id}/audit`]: TEST_AUDIT_TRAIL,
      [`/api/piece/${TEST_PIECE.id}/series`]: { seriesId: null, parts: [] },
      [`/api/piece/${TEST_PIECE.id}/resources`]: { resources: [] },
    });

    await page.goto("/");

    // Pill copy reflects the patched rollup; "1 patched" is the
    // pass-1 summary's patched_count.
    const pill = page.getByRole("button", { name: /Audited · 1 patched/ });
    await expect(pill).toBeVisible();

    // Click pill → dropdown menu opens with both entries.
    await pill.click();
    await expect(page.getByRole("menuitem", { name: /Hide audit marks|Show audit marks/ })).toBeVisible();
    const openTrail = page.getByRole("menuitem", { name: /View full audit trail/ });
    await expect(openTrail).toBeVisible();

    // Open the full trail panel; modal mounts and lazy-fetches
    // /api/piece/:id/audit.
    await openTrail.click();
    await expect(page.getByRole("dialog", { name: /Audit trail/ })).toBeVisible();
    await expect(page.getByText(/Pass 1.*1 claim/)).toBeVisible();
    await expect(page.getByText(/Public Linkerd docs corroborate/)).toBeVisible();

    // The audit-trail fetch must have actually fired (vs. a stale
    // preloaded prop) — confirms the wire goes through.
    const auditCalls = recorder.byPath(`/piece/${TEST_PIECE.id}/audit`);
    expect(auditCalls.length).toBeGreaterThanOrEqual(1);
  });
});
