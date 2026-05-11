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
  // TTS operations.
  audio_teaching_piece: "Listen — teaching piece",
  audio_deep_dive: "Listen — deep dive",
  audio_chat_reply: "Listen — chat reply",
};

export function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? op;
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
