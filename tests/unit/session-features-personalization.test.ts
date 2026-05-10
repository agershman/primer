/**
 * Personalization-layer source-text contracts: concept extraction
 * overhaul (focus statement + suppression + prompt shape),
 * buildSystemPrompt behavioural assertions, the About statement
 * (versioned persona) + AI refinement endpoint, About wired into
 * all user-facing AI surfaces, and the About + Refine UI.
 *
 * Extracted from `session-features.test.ts` — see the cleanup-roadmap
 * note in `dev-docs/cleanup-roadmap.md` (item 10) for the broader
 * test-file split plan.
 *
 * @see ./session-features.test.ts — remaining session-feature tests
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readSplitSource } from "../helpers/source";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFile(resolve(REPO_ROOT, rel), "utf-8");
const readSrc = readSplitSource;

describe("concept extraction overhaul — focus statement, suppression, prompt", () => {
  it("consolidated schema has focus_statement_versions table and attribution + suppression columns", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("CREATE TABLE focus_statement_versions");
    expect(sql).toContain("current_focus_version_id TEXT REFERENCES focus_statement_versions(id)");
    expect(sql).toContain("focus_version_id TEXT REFERENCES focus_statement_versions(id)");
    expect(sql).toContain("suppressed_at TEXT");
    expect(sql).toContain("CREATE INDEX idx_focus_versions_user_recent");
    expect(sql).toContain("CREATE INDEX idx_concepts_suppressed");
  });

  it("consolidated schema includes focus_statement_versions", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("focus_statement_versions");
  });

  it("user-context middleware joins focus_statement_versions and exposes focusStatement + focusVersionId", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    expect(src).toContain("LEFT JOIN focus_statement_versions fv ON fv.id = u.current_focus_version_id");
    expect(src).toContain("focusStatement: userRow.focus_statement");
    expect(src).toContain("focusVersionId: userRow.current_focus_version_id");
  });

  it("UserContext type includes focusStatement and focusVersionId", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toContain("focusStatement: string | null");
    expect(src).toContain("focusVersionId: string | null");
  });

  it("/api/me returns focusStatement and focusVersionId", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/focusStatement: user\.focusStatement/);
    expect(src).toMatch(/focusVersionId: user\.focusVersionId/);
  });

  it("POST /api/me/focus is idempotent — same statement returns existing version, no new row", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemFocusRoutes)\.post\("\/me\/focus"/);
    expect(src).toContain("isNew: false");
    expect(src).toContain("isNew: true");
  });

  it("POST /me/focus validates statement length and required-ness", async () => {
    // The required-ness check stays inline (post-trim), but the
    // length cap moved to the shared zod schema. Pin both:
    // the route still rejects empty statements with the user-
    // facing message, and the schema declares the 4000-char cap.
    const routeSrc = await readSrc("src/worker/routes/system.ts");
    expect(routeSrc).toContain("statement is required");
    expect(routeSrc).toContain("StatementVersionRequest");
    const schemaSrc = await read("src/shared/schemas.ts");
    expect(schemaSrc).toContain("statement too long (max 4000 chars)");
  });

  it("GET /me/focus/history returns versions newest-first with isCurrent flag", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemFocusRoutes)\.get\("\/me\/focus\/history"/);
    expect(src).toContain("ORDER BY created_at DESC");
    expect(src).toContain("isCurrent: r.id === user.focusVersionId");
  });

  it("POST /me/focus/:id/restore creates a new version (not pointer flip) with restored-from note", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemFocusRoutes)\.post\("\/me\/focus\/:versionId\/restore"/);
    expect(src).toContain("restored from ${source.id}");
  });

  it("DELETE /me/focus/:id refuses to delete the current version and nulls attributions", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemFocusRoutes)\.delete\("\/me\/focus\/:versionId"/);
    expect(src).toContain("cannot delete the current version");
    expect(src).toContain("UPDATE concepts SET focus_version_id = NULL");
    expect(src).toContain("UPDATE briefings SET focus_version_id = NULL");
  });

  it("GET /me/focus/:id/analytics aggregates concepts/briefings/pieces and computes suppression rate", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemFocusRoutes)\.get\("\/me\/focus\/:versionId\/analytics"/);
    expect(src).toContain("conceptsCreated");
    expect(src).toContain("conceptsSuppressed");
    expect(src).toContain("suppressionRate");
    expect(src).toContain("briefingsGenerated");
    expect(src).toContain("teachingPiecesGenerated");
    expect(src).toContain("categoryDistribution");
  });

  it("buildSystemPrompt is exported and accepts existingNames, suppressedNames, focusStatement", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("export function buildSystemPrompt(");
    expect(src).toContain("existingNames: string[]");
    expect(src).toContain("suppressedNames: string[]");
    expect(src).toContain("focusStatement: string | null");
  });

  it("extractor prompt drops 'process' category in favor of 'methodology'", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    // The category enum line should not mention "process" anymore
    const enumMatch = src.match(/category:\s*"infrastructure"[^\n]*/);
    expect(enumMatch).toBeTruthy();
    expect(enumMatch![0]).toContain('"methodology"');
    expect(enumMatch![0]).not.toContain('"process"');
  });

  it("extractor prompt has explicit anti-examples for ritual/cadence/role nouns", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("DO NOT EXTRACT");
    expect(src).toContain("standup");
    expect(src).toContain("retro");
    expect(src).toContain("OKR");
    expect(src).toContain("on-call rotation");
  });

  it("extractor prompt has the substance bar and umbrella rule with example", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("SUBSTANCE BAR");
    expect(src).toContain("teachable as standalone subject matter");
    expect(src).toContain("UMBRELLA RULE");
    expect(src).toContain("schema migration");
    expect(src).toContain("aliases");
  });

  it("extractor prompt injects USER FOCUS block when focusStatement is provided", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("USER FOCUS");
    expect(src).toContain("focusStatement.trim()");
    expect(src).toContain("Strongly bias extraction toward concepts that intersect this focus");
  });

  it("extractor prompt injects DO NOT EXTRACT block for suppressed names", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("explicitly marked these as not interesting (suppressed)");
    expect(src).toContain("suppressedNames.join");
  });

  it("extractConcepts splits existing vs suppressed concepts before prompting", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("filter((c) => !c.suppressed_at).map");
    expect(src).toContain("filter((c) => c.suppressed_at).map");
  });

  it("createConcept accepts focusVersionId and stores it on the row", async () => {
    const src = await read("src/worker/db/queries.ts");
    expect(src).toContain("focusVersionId?: string | null");
    expect(src).toContain("focus_version_id");
  });

  it("getActiveConcepts excludes suppressed concepts from briefing pipeline", async () => {
    const src = await read("src/worker/db/queries.ts");
    expect(src).toContain("AND c.suppressed_at IS NULL");
  });

  it("briefing-generator resolves user focus and stamps briefing + concepts with focus_version_id", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("u.current_focus_version_id");
    expect(src).toContain("LEFT JOIN focus_statement_versions");
    expect(src).toContain("focus_version_id");
    expect(src).toContain("focusStatement,");
    expect(src).toContain("focusVersionId,");
  });

  it("GET /api/concepts honors include_suppressed and focus_version_id query params", async () => {
    const src = await read("src/worker/routes/concepts.ts");
    expect(src).toContain('c.req.query("include_suppressed")');
    expect(src).toContain('c.req.query("focus_version_id")');
    expect(src).toContain("suppressed_at IS NULL");
  });

  it("POST /concept/:id/suppress and /unsuppress flip suppressed_at", async () => {
    const src = await read("src/worker/routes/concepts.ts");
    expect(src).toContain('conceptRoutes.post("/concept/:id/suppress"');
    expect(src).toContain('conceptRoutes.post("/concept/:id/unsuppress"');
    expect(src).toContain("SET suppressed_at = datetime('now')");
    expect(src).toContain("SET suppressed_at = NULL");
  });

  it("POST /concepts/reset deletes concepts/depth/history/relations/artifacts", async () => {
    const src = await read("src/worker/routes/concepts.ts");
    expect(src).toContain('conceptRoutes.post("/concepts/reset"');
    expect(src).toContain("DELETE FROM concept_artifacts");
    expect(src).toContain("DELETE FROM concept_depth_history");
    expect(src).toContain("DELETE FROM concept_relations");
    expect(src).toContain("DELETE FROM concept_depth");
    expect(src).toContain("DELETE FROM concepts");
  });

  it("SettingsPanel renders Focus and Concepts sections with versioned save + reset button", async () => {
    // After the SettingsPanel split, statement editing lives in
    // settings/panels/StatementPanel.tsx and the reset button lives in
    // settings/panels/AccountPanel.tsx.
    const stmt = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    expect(stmt).toContain("Save as new version");
    expect(stmt).toContain("View history");
    expect(stmt).toContain("StatementHistoryModal");
    // StatementPanel posts to /api/me/{kind} via copy.endpoint, set
    // from a per-kind COPY table that includes both about and focus.
    expect(stmt).toContain('endpoint: "/api/me/about"');
    expect(stmt).toContain('endpoint: "/api/me/focus"');
    expect(stmt).toMatch(/apiPost\(copy\.endpoint/);

    const account = await read("src/frontend/components/settings/panels/AccountPanel.tsx");
    expect(account).toContain("Reset concepts");
    expect(account).toContain("ResetConceptsConfirm");
  });

  it("StatementHistoryModal (focus kind) fetches history + per-version analytics and supports restore/delete", async () => {
    const src = await read("src/frontend/components/settings/modals/StatementHistoryModal.tsx");
    expect(src).toContain("/api/me/${kind}/history");
    expect(src).toContain("/api/me/${kind}/${v.id}/analytics");
    expect(src).toContain("/api/me/${kind}/${v.id}/restore");
    expect(src).toContain("FocusDiff");
  });

  it("FocusHistoryModal flags high suppression rate as a focus mismatch warning", async () => {
    const src = await read("src/frontend/components/settings/modals/StatementHistoryModal.tsx");
    expect(src).toContain("High suppression rate");
    expect(src).toContain("a.suppressionRate > 0.25");
  });

  it("ConceptList exposes onSuppressionChange and renders the suppress button", async () => {
    const src = await read("src/frontend/components/ConceptList.tsx");
    expect(src).toContain("onSuppressionChange");
    expect(src).toContain("/suppress");
    expect(src).toContain("/unsuppress");
    expect(src).toContain("line-through");
  });

  it("ConceptsPage has Show suppressed toggle and refreshes on suppression change", async () => {
    const src = await read("src/frontend/pages/ConceptsPage.tsx");
    expect(src).toContain("Show suppressed");
    expect(src).toContain("setIncludeSuppressed");
    expect(src).toContain("onSuppressionChange={() => refresh()}");
  });

  it("useConcepts honors includeSuppressed in the API query string", async () => {
    const src = await read("src/frontend/hooks/useConcepts.ts");
    expect(src).toContain("includeSuppressed");
    expect(src).toContain('"include_suppressed", "true"');
  });

  it("ConceptData type includes suppressedAt and focusVersionId", async () => {
    const src = await read("src/frontend/types.ts");
    expect(src).toContain("suppressedAt?: string | null");
    expect(src).toContain("focusVersionId?: string | null");
  });

  it("CurrentUser type and /api/me wiring expose focusStatement + focusVersionId", async () => {
    const src = await read("src/frontend/hooks/useCurrentUser.tsx");
    expect(src).toContain("focusStatement: string | null");
    expect(src).toContain("focusVersionId: string | null");
    expect(src).toContain("export function useCurrentUser");
    expect(src).toContain("refresh");
  });
});

describe("buildSystemPrompt — behavioral", () => {
  it("produces a focus-injected prompt when focus statement is non-null", async () => {
    const { buildSystemPrompt } = await import("../../src/worker/services/concept-extractor.ts");
    const prompt = buildSystemPrompt(
      ["kubernetes", "terraform"],
      [],
      "Platform/infra engineer focused on Cloudflare Workers and Kubernetes.",
    );
    expect(prompt).toContain("USER FOCUS");
    expect(prompt).toContain("Cloudflare Workers");
    expect(prompt).toContain("kubernetes, terraform");
    expect(prompt).toContain("SUBSTANCE BAR");
    expect(prompt).toContain("UMBRELLA RULE");
    expect(prompt).not.toContain('"process"');
    expect(prompt).toContain('"methodology"');
  });

  it("omits the focus block when focusStatement is null", async () => {
    const { buildSystemPrompt } = await import("../../src/worker/services/concept-extractor.ts");
    const prompt = buildSystemPrompt(["kubernetes"], [], null);
    expect(prompt).not.toContain("USER FOCUS");
    expect(prompt).toContain("SUBSTANCE BAR");
  });

  it("injects suppression block only when there are suppressed names", async () => {
    const { buildSystemPrompt } = await import("../../src/worker/services/concept-extractor.ts");
    const withSuppressed = buildSystemPrompt([], ["platform standup", "retro lead"], null);
    expect(withSuppressed).toContain("explicitly marked these as not interesting");
    expect(withSuppressed).toContain("platform standup, retro lead");

    const without = buildSystemPrompt([], [], null);
    expect(without).not.toContain("explicitly marked these as not interesting");
  });

  it("includes anti-examples for ritual / cadence / role nouns", async () => {
    const { buildSystemPrompt } = await import("../../src/worker/services/concept-extractor.ts");
    const prompt = buildSystemPrompt([], [], null);
    expect(prompt).toContain("standup");
    expect(prompt).toContain("retro");
    expect(prompt).toContain("OKR");
    expect(prompt).toContain("on-call rotation");
  });
});

describe("about statement (versioned persona) + AI refinement", () => {
  it("consolidated schema has about_statement_versions table and pointer column", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("CREATE TABLE about_statement_versions");
    expect(sql).toContain("current_about_version_id TEXT REFERENCES about_statement_versions(id)");
    expect(sql).toContain("CREATE INDEX idx_about_versions_user_recent");
  });

  it("consolidated schema includes about_statement_versions", async () => {
    const sql = await read("migrations/0001_initial.sql");
    expect(sql).toContain("about_statement_versions");
  });

  it("wrangler.api.example.toml configures migrations_dir for the d1 runner", async () => {
    const toml = await read("wrangler.api.example.toml");
    expect(toml).toContain('migrations_dir = "migrations"');
  });

  it("package.json db scripts use wrangler d1 migrations apply (idempotent runner)", async () => {
    const pkg = await read("package.json");
    expect(pkg).toContain('"db:migrate": "wrangler d1 migrations apply primer-db --local');
    expect(pkg).toContain('"db:migrate:remote": "wrangler d1 migrations apply primer-db --remote');
    expect(pkg).toContain('"db:status"');
    expect(pkg).toContain('"db:bootstrap:remote"');
  });

  it("bootstrap script exists and seeds d1_migrations for existing migrations", async () => {
    const sh = await read("scripts/bootstrap-remote-migrations.sh");
    expect(sh).toContain("CREATE TABLE IF NOT EXISTS d1_migrations");
    expect(sh).toContain("INSERT OR IGNORE INTO d1_migrations");
    // All 10 pre-CI migrations should be in the seed list
    for (const name of [
      "0001_initial.sql",
      "0002_chat.sql",
      "0003_model_tracking.sql",
      "0004_cancel_tracking.sql",
      "0005_analytics.sql",
      "0006_source_provenance.sql",
      "0007_bookmarks.sql",
      "0008_github.sql",
      "0009_user_focus_and_concept_suppression.sql",
      "0010_user_about_statement.sql",
    ]) {
      expect(sh).toContain(name);
    }
  });

  it("UserContext type has aboutStatement and aboutVersionId", async () => {
    const src = await read("src/worker/types.ts");
    expect(src).toContain("aboutStatement: string | null");
    expect(src).toContain("aboutVersionId: string | null");
  });

  it("user-context middleware joins about_statement_versions and exposes both", async () => {
    const src = await read("src/worker/middleware/user-context.ts");
    expect(src).toContain("LEFT JOIN about_statement_versions av ON av.id = u.current_about_version_id");
    expect(src).toContain("aboutStatement: userRow.about_statement");
    expect(src).toContain("aboutVersionId: userRow.current_about_version_id");
  });

  it("/api/me returns aboutStatement and aboutVersionId", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/aboutStatement: user\.aboutStatement/);
    expect(src).toMatch(/aboutVersionId: user\.aboutVersionId/);
  });

  it("CurrentUser type on the frontend includes aboutStatement + aboutVersionId", async () => {
    const src = await read("src/frontend/hooks/useCurrentUser.tsx");
    expect(src).toContain("aboutStatement: string | null");
    expect(src).toContain("aboutVersionId: string | null");
  });

  it("POST /me/about is idempotent and validates length", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemAboutRoutes)\.post\("\/me\/about"/);
    expect(src).toContain("statement is required");
    // Length cap now lives in src/shared/schemas.ts (single source of
    // truth, shared with frontend's inferred type).
    expect(src).toContain("StatementVersionRequest");
    const schemaSrc = await read("src/shared/schemas.ts");
    expect(schemaSrc).toContain("statement too long (max 4000 chars)");
    expect(src).toContain("isNew: false");
    expect(src).toContain("isNew: true");
  });

  it("GET /me/about/history, restore, delete, analytics endpoints exist", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemAboutRoutes)\.get\("\/me\/about\/history"/);
    expect(src).toMatch(/(systemRoutes|systemAboutRoutes)\.post\("\/me\/about\/:versionId\/restore"/);
    expect(src).toMatch(/(systemRoutes|systemAboutRoutes)\.delete\("\/me\/about\/:versionId"/);
    expect(src).toMatch(/(systemRoutes|systemAboutRoutes)\.get\("\/me\/about\/:versionId\/analytics"/);
  });

  it("DELETE /me/about/:id refuses to delete the current version", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    // Find the About delete handler block (tolerate either router name).
    const aboutDeleteIdx = Math.max(
      src.indexOf('systemRoutes.delete("/me/about/:versionId"'),
      src.indexOf('systemAboutRoutes.delete("/me/about/:versionId"'),
    );
    expect(aboutDeleteIdx).toBeGreaterThan(-1);
    const block = src.slice(aboutDeleteIdx, aboutDeleteIdx + 1500);
    expect(block).toContain("cannot delete the current version");
  });

  it("About analytics is time-window-based (not focus-version attribution)", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    const aboutAnalyticsIdx = Math.max(
      src.indexOf('systemRoutes.get("/me/about/:versionId/analytics"'),
      src.indexOf('systemAboutRoutes.get("/me/about/:versionId/analytics"'),
    );
    expect(aboutAnalyticsIdx).toBeGreaterThan(-1);
    const block = src.slice(aboutAnalyticsIdx, aboutAnalyticsIdx + 3000);
    expect(block).toContain("WHERE user_id = ? AND created_at >= ? AND created_at < ?");
    expect(block).not.toContain("about_version_id");
  });

  it("POST /me/refine-prompt validates kind and draft, calls Sonnet, records token usage", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    expect(src).toMatch(/(systemRoutes|systemRefineRoutes)\.post\("\/me\/refine-prompt"/);
    // Validation moved to a shared zod schema — the route now
    // imports `RefinePromptRequest` from src/shared/schemas.ts and
    // funnels the body through `parseBody`, which produces the
    // standard "Invalid request body" envelope on validation
    // failure. We pin both the schema name AND the validation
    // entry-point so a regression that drops zod is loud.
    expect(src).toContain("RefinePromptRequest");
    expect(src).toContain("parseBody(c.req.raw, RefinePromptRequest)");
    expect(src).toContain('"claude-sonnet-4-20250514"');
    expect(src).toContain('"prompt_refinement"');
    expect(src).toContain("refined");
    expect(src).toContain("rationale");
  });

  it("Refine meta-prompt instructs the model not to invent facts about the user", async () => {
    const src = await readSrc("src/worker/routes/system.ts");
    const refineIdx = Math.max(
      src.indexOf('systemRoutes.post("/me/refine-prompt"'),
      src.indexOf('systemRefineRoutes.post("/me/refine-prompt"'),
    );
    expect(refineIdx).toBeGreaterThan(-1);
    const block = src.slice(refineIdx);
    expect(block).toContain("Do NOT invent facts about them");
    expect(block).toContain("first-person");
  });
});

describe("About wired into all user-facing AI surfaces", () => {
  it("buildSystemPrompt (extractor) accepts aboutStatement and adds ABOUT THE READER block", async () => {
    const src = await read("src/worker/services/concept-extractor.ts");
    expect(src).toContain("aboutStatement: string | null = null");
    expect(src).toContain("ABOUT THE READER");
    expect(src).toContain("NEVER overrides the FOCUS filter");
  });

  it("extractor behavioral test: ABOUT block appears when aboutStatement is provided", async () => {
    const { buildSystemPrompt } = await import("../../src/worker/services/concept-extractor.ts");
    const prompt = buildSystemPrompt([], [], null, "Senior platform engineer, 12 years experience.");
    expect(prompt).toContain("ABOUT THE READER");
    expect(prompt).toContain("Senior platform engineer");

    const without = buildSystemPrompt([], [], null);
    expect(without).not.toContain("ABOUT THE READER");
  });

  it("teaching-generator accepts aboutStatement and emits ABOUT THE READER calibration block", async () => {
    const src = await read("src/worker/services/teaching-generator.ts");
    expect(src).toContain("aboutStatement?: string | null");
    expect(src).toContain("ABOUT THE READER");
    expect(src).toContain("never mention it explicitly");
  });

  it("deep-dive-generator accepts aboutStatement and uses it for voice calibration", async () => {
    const src = await read("src/worker/services/deep-dive-generator.ts");
    expect(src).toContain("aboutStatement?: string | null");
    expect(src).toContain("ABOUT THE READER");
  });

  it("chat-responder buildSystemPrompt accepts options with aboutStatement and focusStatement", async () => {
    const src = await read("src/worker/services/chat-responder.ts");
    expect(src).toContain("ChatPersona");
    expect(src).toContain("aboutStatement?: string | null");
    expect(src).toContain("focusStatement?: string | null");
    expect(src).toContain("ABOUT THE USER");
    expect(src).toContain("USER'S CURRENT FOCUS");
  });

  // The previous test pinned the briefing-greeting prompt's ABOUT
  // tone-calibration block. Both the prompt and the LLM step were
  // removed when the greeting was retired (see "AI-generated
  // briefing greeting (removed)" describe further down). Tone
  // calibration via the ABOUT statement still runs through every
  // other user-facing surface (teaching pieces, deep dives, chat,
  // quizzes) — those calibration tests live alongside their
  // respective service tests.

  it("briefing-generator resolves both focus + about and threads them into all callsites", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("u.current_about_version_id");
    expect(src).toContain("LEFT JOIN about_statement_versions");
    expect(src).toContain("aboutStatement,");
    // Threaded into extractor, teaching, quiz, adjacent
    expect(src).toMatch(/extractConcepts[\s\S]{0,400}aboutStatement/);
    expect(src).toMatch(/generateTeachingPiece[\s\S]{0,200}aboutStatement/);
    expect(src).toMatch(/generateQuiz[\s\S]{0,200}aboutStatement/);
    expect(src).toMatch(/scanAdjacentSources[\s\S]{0,400}aboutStatement/);
    // Focus is now also threaded into teaching + quiz so it can
    // shape prose / question framing, not just selection.
    expect(src).toMatch(/generateTeachingPiece[\s\S]{0,200}focusStatement/);
    expect(src).toMatch(/generateQuiz[\s\S]{0,200}focusStatement/);
  });

  it("teaching-generator accepts focusStatement and emits a CURRENT FOCUS steering block", async () => {
    const src = await read("src/worker/services/teaching-generator.ts");
    expect(src).toContain("focusStatement?: string | null");
    expect(src).toContain("CURRENT FOCUS");
    // Frame focus as direction, not voice — and never let the LLM
    // quote it back at the reader.
    expect(src).toContain("Never quote it back");
  });

  it("quiz-assessor generateQuiz accepts aboutStatement and includes calibration block", async () => {
    const src = await read("src/worker/services/quiz-assessor.ts");
    expect(src).toContain("QuizGenerationOptions");
    expect(src).toContain("aboutStatement?: string | null");
    expect(src).toContain("ABOUT THE READER");
  });

  it("quiz-assessor generateQuiz accepts focusStatement and emits a CURRENT FOCUS framing block", async () => {
    const src = await read("src/worker/services/quiz-assessor.ts");
    expect(src).toContain("focusStatement?: string | null");
    expect(src).toContain("CURRENT FOCUS");
  });

  it("focus-scorer service exists with the expected shape — single LLM call, fail-open", async () => {
    const src = await read("src/worker/services/focus-scorer.ts");
    expect(src).toContain("scoreCandidatesAgainstFocus");
    expect(src).toContain("FocusScorerCandidate");
    // Records token usage under a distinct step key so the analytics
    // waterfall can attribute the call.
    expect(src).toContain('"focus_scoring"');
    // Fails open — an LLM/parse error returns an empty Map and logs,
    // never throws. The caller's downstream sort still works.
    expect(src).toMatch(/return new Map\(\)/);
  });

  it("focusScoring is registered in the model catalog with a default", async () => {
    const src = await read("src/worker/config/models.ts");
    expect(src).toContain('"focusScoring"');
    expect(src).toContain("focusScoring:");
  });

  it("briefing-generator integrates the focus scorer into teaching-target ranking", async () => {
    const src = await read("src/worker/services/briefing-generator.ts");
    expect(src).toContain("scoreCandidatesAgainstFocus");
    expect(src).toContain("focusScoringSpec");
    // The new sort uses focus relevance as a secondary key after
    // priority, then depth ascending. We pin the structural
    // signature so future changes to the comparator are intentional.
    expect(src).toMatch(/if \(a\.c\.priority !== b\.c\.priority\)/);
    expect(src).toMatch(/focusScoreFor/);
  });


  it("adjacent-scanner accepts aboutStatement and focusStatement and uses them for scoring nuance", async () => {
    const src = await read("src/worker/services/adjacent-scanner.ts");
    expect(src).toContain("AdjacentScanOptions");
    expect(src).toContain("aboutStatement?: string | null");
    expect(src).toContain("focusStatement?: string | null");
    expect(src).toContain("ABOUT THE READER");
    expect(src).toContain("USER'S CURRENT FOCUS");
  });

  it("chat routes pass user.aboutStatement and user.focusStatement to respondToChat and createChatStream", async () => {
    const src = await read("src/worker/routes/chat.ts");
    expect(src).toMatch(/respondToChat[\s\S]{0,400}aboutStatement: user\.aboutStatement/);
    expect(src).toMatch(/createChatStream[\s\S]{0,400}aboutStatement: user\.aboutStatement/);
  });

  it("pieces route regenerate passes user.aboutStatement to teaching/deep-dive generators", async () => {
    const src = await readSrc("src/worker/routes/pieces.ts");
    expect(src).toMatch(/generateTeachingPiece[\s\S]{0,300}aboutStatement: user\.aboutStatement/);
    expect(src).toMatch(/generateDeepDive[\s\S]{0,300}aboutStatement: user\.aboutStatement/);
  });

  it("quiz route baseline generation passes user.aboutStatement through to generateQuiz", async () => {
    // The inline `generateQuiz` call was lifted into a shared
    // helper `generateBaselineQuestions` (so the GET fallback and
    // the async prep endpoint both use it). The call site now
    // passes `user.aboutStatement` to the helper, and the helper
    // forwards it to `generateQuiz` via `{ aboutStatement }`.
    const src = await readSrc("src/worker/routes/quiz.ts");
    expect(src).toMatch(
      /generateBaselineQuestions\([\s\S]{0,200}user\.aboutStatement/,
    );
    // Helper itself still passes aboutStatement to generateQuiz.
    expect(src).toMatch(
      /generateQuiz\([\s\S]{0,300}aboutStatement\b/,
    );
  });
});

describe("About + Refine UI", () => {
  it("StatementHistoryModal handles both kinds via /api/me/${kind}/* routes", async () => {
    const src = await read("src/frontend/components/settings/modals/StatementHistoryModal.tsx");
    expect(src).toContain("StatementHistoryModal");
    expect(src).toContain("kind: StatementKind");
    expect(src).toContain("/api/me/${kind}/history");
    expect(src).toContain("/api/me/${kind}/${v.id}/analytics");
    expect(src).toContain("/api/me/${kind}/${v.id}/restore");
  });

  it("SettingsPanel registers About and Focus as nav entries (About listed before Focus)", async () => {
    const shell = await read("src/frontend/components/settings/SettingsModal.tsx");
    // Both panels are registered in the shell's NAV table, in About-
    // before-Focus order so users see the more stable surface first.
    expect(shell).toContain('id: "about"');
    expect(shell).toContain('id: "focus"');
    const aboutIdx = shell.indexOf('id: "about"');
    const focusIdx = shell.indexOf('id: "focus"');
    expect(aboutIdx).toBeGreaterThan(0);
    expect(focusIdx).toBeGreaterThan(aboutIdx);
    // Each panel is wired to the appropriate /api/me/{kind} endpoint
    // — the shared StatementPanel reads the kind from props.
    const stmt = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    expect(stmt).toContain('endpoint: "/api/me/about"');
    expect(stmt).toContain('endpoint: "/api/me/focus"');
    expect(stmt).toContain("Refine with AI");
  });

  it("RefineDialog is extracted to its own module (re-used by StatementPanel + onboarding + FocusEditor)", async () => {
    // The shared StatementPanel imports the dialog so the same UX
    // appears for both About and Focus editing inside settings.
    const stmt = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    expect(stmt).toContain('import { RefineDialog } from "../../RefineDialog"');
    expect(stmt).toContain("RefineDialog");

    // The dialog itself owns the network call + the draft/refined/rationale layout.
    const dialogSrc = await read("src/frontend/components/RefineDialog.tsx");
    expect(dialogSrc).toMatch(/export function RefineDialog/);
    expect(dialogSrc).toContain('"/api/me/refine-prompt"');
    expect(dialogSrc).toContain("Use refined");
    expect(dialogSrc).toContain("Keep mine");
    expect(dialogSrc).toContain("rationale");
  });

  it("Save button on the StatementPanel opens RefineDialog with the active kind", async () => {
    const stmt = await read("src/frontend/components/settings/panels/StatementPanel.tsx");
    // Single shared component opens the refine dialog with whichever
    // kind it was instantiated for — replaces the two parallel
    // setRefineState calls that lived in the old single-file panel.
    // The state was renamed from `refineOpen: boolean` to
    // `refineMode: "tighten" | "instruction" | null` once the
    // instruction-driven refinement entry point was added — both
    // entry points share the same dialog, distinguished by `mode`.
    expect(stmt).toMatch(/setRefineMode\(("tighten"|"instruction")\)/);
    expect(stmt).toMatch(/<RefineDialog[\s\S]{0,200}kind=\{kind\}/);
  });
});
