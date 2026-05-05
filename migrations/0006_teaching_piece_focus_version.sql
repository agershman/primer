-- 0006_teaching_piece_focus_version.sql
-- Stamps each teaching piece with the focus statement version that
-- shaped it.
--
-- Why this exists: refreshes are now ADDITIVE — when the user refreshes
-- an already-generated briefing after editing their focus statement,
-- existing pieces are preserved and new pieces are appended (shaped by
-- the new focus). Without this column we have no way to attribute each
-- piece back to the focus version that produced it, which the analytics
-- waterfall and an eventual "shaped by your prior focus" UI badge both
-- want.
--
-- Backfill: existing pieces get their parent briefing's focus_version_id
-- (briefings already track this). Rows whose briefing has no focus
-- version remain NULL — same null semantics as the briefings column.
ALTER TABLE teaching_pieces
  ADD COLUMN focus_version_id TEXT REFERENCES focus_statement_versions(id);

UPDATE teaching_pieces
SET focus_version_id = (
  SELECT focus_version_id FROM briefings WHERE briefings.id = teaching_pieces.briefing_id
)
WHERE focus_version_id IS NULL;
