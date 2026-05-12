/**
 * Display helpers shared by the analytics page (`UsageBreakdown`) and
 * the budget usage card in the settings limits panel. Lifted here so
 * that adding a new pipeline operation only needs one label-map edit.
 */

export const OPERATION_LABELS: Record<string, string> = {
  // LLM operations.
  concept_extraction: "Extract concepts",
  teaching_generation: "Write teaching pieces",
  deep_dive: "Generate deep dives",
  quiz_generation: "Generate quiz questions",
  quiz_assessment: "Assess quiz answers",
  source_suggestion: "Suggest sources",
  slack_filter: "Filter Slack messages",
  continuation: "Continuation classifier",
  chat: "Chat reply",
  chat_title: "Chat thread title",
  // Audit operations — see src/worker/services/piece-auditor.ts.
  // Listed as a family so the analytics page can roll them into
  // the "Audit overhead" card.
  piece_audit: "Audit — teaching piece",
  deep_dive_audit: "Audit — deep dive",
  quiz_audit: "Audit — quiz question",
  piece_audit_patch: "Audit patch",
  piece_audit_websearch: "Audit — web search",
  // TTS operations.
  audio_teaching_piece: "Listen — teaching piece",
  audio_deep_dive: "Listen — deep dive",
  audio_chat_reply: "Listen — chat reply",
};

/**
 * Operation tags that count toward the "Audit overhead" rollup on
 * the analytics page. Kept here so the worker (`recordTokenUsage`
 * call sites) and the frontend (the rollup query) agree on what
 * counts as audit spend.
 */
export const AUDIT_OPERATIONS: readonly string[] = [
  "piece_audit",
  "deep_dive_audit",
  "quiz_audit",
  "piece_audit_patch",
  "piece_audit_websearch",
] as const;

export function isAuditOperation(op: string): boolean {
  return AUDIT_OPERATIONS.includes(op);
}

export function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? op;
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
