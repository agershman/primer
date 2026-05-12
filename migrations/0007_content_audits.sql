-- 0007_content_audits.sql
-- Persists results of the two-pass content audit that runs after every
-- generator (teaching pieces, deep dives, calibration quizzes).
--
-- Why this exists: pre-audit, every factual claim in a piece was
-- effectively unchecked — the writer cited the source bundle when it
-- felt like it and freelanced the rest. The auditor classifies each
-- claim, opportunistically backstops un-cited claims with a web search,
-- patches/drops the indefensible ones, and re-audits the patches. The
-- per-claim trail surfaces to the reader as wavy underlines + a
-- popover; the per-target rollup powers a status pill + the analytics
-- "Audit overhead" card.
--
-- Schema choice: ONE polymorphic table keyed on (target_kind,
-- target_id) rather than three near-identical tables. Pieces, deep
-- dives, and quizzes share the same rollup math, the same UI rendering,
-- and the same analytics aggregation; splitting them would force every
-- query to UNION ALL three sources. The CHECK on `target_kind` plus the
-- per-kind FK enforcement at the application layer (auditor service)
-- gives us referential integrity without a per-kind FK column.
--
-- Idempotency: this is a forward-only schema add. No backfill is
-- attempted — pre-audit content silently has NULL audit rows and the
-- read endpoints fall back to "no audit summary available" for those.
-- That's intentional: backfilling would re-run an LLM for every
-- historical piece, which is wasteful and noisy.

CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Polymorphic target. 'piece' and 'deep_dive' both reference
  -- teaching_pieces.id (a single row backs both the piece body and
  -- its optional deep-dive body — see teaching_pieces.deep_dive_content
  -- in 0001_initial.sql); 'quiz' references calibration_quizzes.id.
  target_kind TEXT NOT NULL CHECK (target_kind IN ('piece', 'deep_dive', 'quiz')),
  target_id TEXT NOT NULL,
  -- Pass 1 is the initial classify+patch; pass 2 only runs when pass 1
  -- patched at least one span (re-checks the patched text). Pass 2 is
  -- absent when pass 1 was already clean.
  pass INTEGER NOT NULL CHECK (pass IN (1, 2)),
  -- 'clean' = no spans flagged. 'patched' / 'dropped' = at least one
  -- span was rewritten / removed. 'failed' = the auditor threw and
  -- we fell back to publishing the original content unchanged (the
  -- pipeline must not lose a piece because the audit had a bad day).
  status TEXT NOT NULL CHECK (status IN ('clean', 'patched', 'dropped', 'failed')),
  audit_model TEXT NOT NULL,
  patch_model TEXT,
  -- Boolean: did we invoke the hosted web_search server tool during
  -- this pass? Drives the per-call cost story in the analytics card.
  used_web_search INTEGER NOT NULL DEFAULT 0,
  total_claims INTEGER NOT NULL DEFAULT 0,
  unsupported_count INTEGER NOT NULL DEFAULT 0,
  hallucinated_count INTEGER NOT NULL DEFAULT 0,
  -- Claims that pass-1 flagged but the web-search backstop verified
  -- against a trustworthy public source. Kept distinct from 'grounded'
  -- so the UI can render "web-verified" with a small badge.
  grounded_web_count INTEGER NOT NULL DEFAULT 0,
  patched_count INTEGER NOT NULL DEFAULT 0,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_claims (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  -- Span addressing into the target ContentBlock[] — see
  -- src/worker/types.ts. Only 'text' and 'heading' blocks contribute
  -- claims (code/diagram blocks are literal source material). The
  -- offsets are positions within the block's `value` string.
  block_index INTEGER NOT NULL,
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  claim_text TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('grounded', 'grounded-web', 'unsupported', 'hallucinated')),
  -- JSON array. For 'grounded': enrichment IDs from the writer's
  -- [[ref:...]] tags (e.g. ["linear_issue:CIN-1234"]). For
  -- 'grounded-web': the URLs the auditor's web search returned.
  cited_refs TEXT NOT NULL DEFAULT '[]',
  -- JSON: [{url, title, snippet}]. Populated only when
  -- verdict='grounded-web' — the popover renders these as evidence
  -- cards. NULL for other verdicts.
  web_evidence TEXT,
  reasoning TEXT,
  -- 'kept' = passed through unchanged. 'patched' / 'dropped' = the
  -- patch step rewrote / removed the span. NULL on pass-2 rows where
  -- the span was re-classified but not re-resolved (pass 2 only emits
  -- new claim rows for spans that came in as patches).
  resolution TEXT CHECK (resolution IN ('kept', 'patched', 'dropped', NULL)),
  patched_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audits_target ON audits(target_kind, target_id, pass);
CREATE INDEX idx_audits_user_created ON audits(user_id, created_at DESC);
CREATE INDEX idx_audit_claims_audit ON audit_claims(audit_id);

-- Per-user toggle for the inline wavy-underline marks on flagged
-- spans. Default ON — the audit is the headline trust feature; users
-- who want to read distraction-free flip it off in
-- Settings → Intelligence. The pill summary stays visible either way.
ALTER TABLE user_settings
  ADD COLUMN show_audit_marks INTEGER NOT NULL DEFAULT 1;
