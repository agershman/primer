-- 0009_drop_audits.sql — remove the post-process audit pipeline.
--
-- The two-pass auditor introduced in 0007 classified factual claims
-- by character offsets and then spliced text via slice/concat, which
-- shipped corrupted output (mid-word seams like "percentagverse"
-- when an offset landed inside a word). Grounding is now enforced
-- inline during generation: writer prompts route company-internal
-- claims to the supplied source bundle and external claims to the
-- hosted `web_search` server tool, and the writer's prose is what
-- gets persisted — no offset-based text mutation downstream.
--
-- Pre-existing teaching pieces that the broken auditor already
-- corrupted stay corrupted. They age out naturally as new daily
-- briefings are generated; regenerating every historical row would
-- burn tokens and disrupt the user's browse history.
--
-- See:
--   - 0007_content_audits.sql — original schema this drops.
--   - 0008_audit_marks_default_off.sql — companion default flip
--     (the column it backfilled is removed below).
--   - src/worker/services/teaching-generator.ts — writer-side
--     grounding rules + web_search wiring.

DROP TABLE IF EXISTS audit_claims;
DROP TABLE IF EXISTS audits;
ALTER TABLE user_settings DROP COLUMN show_audit_marks;
