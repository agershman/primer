// `ContentBlock` and `Resource` are part of the API wire contract
// (worker → frontend), so they live in `src/shared/types.ts`. The
// re-export below preserves the existing import shape — components
// continue to import from `../types` — without forcing a tree-wide
// rewrite.
//
// We ALSO `import type { ContentBlock, Resource }` for in-file use
// (the `TeachingPieceData.content` and `QuizAssessmentData.learningPath`
// fields reference them as types) — re-exports alone don't bring a
// name into local scope, only into the consumers' module scope.
import type { ContentBlock, Resource } from "../shared/types";

export type { ContentBlock, Resource } from "../shared/types";

export interface PieceConcept {
  id: string;
  name: string;
  depth: number;
  confidence: number;
}

export interface SourceDescriptor {
  type: string;
  id?: string;
  title?: string;
  url?: string;
  channel?: string;
  summary?: string;
  source?: string;
  /** Optional ISO timestamp; copied from the upstream WorkContextItem
   *  (e.g. Linear `dueDate`). When set, the piece's `due_at` is the
   *  soonest such date across all sources. */
  dueAt?: string | null;
  /** Human-readable rationale for the deadline, used as the tooltip
   *  on the "Due in 3 days" badge. */
  dueReason?: string | null;
}

export interface TeachingPieceData {
  id: string;
  title: string;
  piece_type: string;
  source_type: string;
  source_ref: string | null;
  read_time_minutes: number;
  content: ContentBlock[];
  concepts: PieceConcept[];
  resources: Resource[];
  why_chosen: string | null;
  has_deep_dive: boolean;
  deep_dive_read_time: number | null;
  feedback: "positive" | "negative" | null;
  read_at: string | null;
  position: number;
  model_used?: string;
  source_context?: SourceDescriptor[];
  created_at?: string;
  /**
   * ISO timestamp for any deadline associated with the piece (soonest
   * across all source deadlines). When set, the piece is sorted to
   * the top of the briefing and gets a "Due in 3 days" badge. NULL
   * means "no time pressure" — the common case.
   */
  due_at?: string | null;
  /** Human-readable rationale for `due_at` — used as the badge
   *  tooltip so the user can verify *why* the system thinks this is
   *  time-sensitive. */
  due_reason?: string | null;
  /**
   * Series identity. Pieces in a multi-part series share a
   * `series_id` and have monotonically increasing `part_number`
   * values starting at 1. NULL on both means the piece is
   * standalone (the common case) — no series chrome rendered.
   *
   * The first piece in a series only gets `part_number = 1`
   * retroactively, when a Part 2 lands and the continuation
   * classifier picks it as the predecessor. So a piece can stay
   * NULL forever, then transition to `series_id = ser_..., part_number = 1`
   * once a follow-up is published.
   */
  series_id?: string | null;
  part_number?: number | null;
}

/**
 * Entry in `BriefingData.redundantDrafts`. One per topic that the
 * continuation classifier filtered as REDUNDANT during this briefing's
 * generation. The frontend renders a subtle header chip ("2 topics had
 * no new movement today: X (Part 1) — Y (Part 1)") and links each
 * topic back to the predecessor piece via its briefing date.
 */
export interface RedundantDraftEntry {
  predecessor_id: string;
  predecessor_title: string;
  /** Briefing date the predecessor was published on. Used to build
   *  the deep-link in the redundant-drafts chip without a second
   *  round trip. Snapshotted at classification time. */
  predecessor_briefing_date: string;
  predecessor_series_id: string | null;
  predecessor_part_number: number | null;
  reason: string;
}

/**
 * Response shape for `GET /api/piece/:id/series`. Lazy-fetched by
 * `TeachingPiece` when it needs to render the series-navigation strip
 * (previous/next links). For standalone pieces (no series), the
 * worker returns `seriesId: null` and `parts: []` — the frontend
 * uses this as the signal to render nothing.
 */
export interface PieceSeriesPart {
  id: string;
  title: string;
  part_number: number;
  created_at: string;
  briefing_date: string;
}
export interface PieceSeriesResponse {
  seriesId: string | null;
  parts: PieceSeriesPart[];
}

export interface WorkContextSourceItem {
  id: string;
  title: string;
  url?: string;
}

export interface WorkContextSource {
  type: string;
  label: string;
  count?: number;
  items?: WorkContextSourceItem[];
}

export interface BriefingData {
  id: string;
  briefing_date: string;
  status: "generating" | "ready" | "partial" | "failed";
  /** Legacy AI-generated morning greeting. The field is still
   *  present on the worker response (the briefing-detail SELECT
   *  uses `b.*`, and old rows still carry their original value),
   *  but it is no longer rendered anywhere in the UI — the date
   *  heading + piece titles are the row's identity. New briefings
   *  persist this column as NULL. */
  greeting?: string | null;
  generated_at: string;
  created_at: string;
  workContextSources: WorkContextSource[];
  metadata: {
    piecesGenerated?: number;
    weeklyStats?: WeeklyStats;
  };
  /** Focus version that was active when this briefing ran, if tracked. */
  focus_version_id?: string | null;
  /**
   * Focus statement text that was active when this briefing was generated,
   * resolved server-side via JOIN against `focus_statement_versions`.
   * `null` for briefings older than the focus-versioning feature
   * (migration 0009). Drives the historical-context badge on the focus
   * pill: when this differs from the user's current focus, the briefing
   * was written under a different lens than the one driving the next
   * briefing.
   */
  focusStatementAtBriefing?: string | null;
  /**
   * Drafts the continuation classifier filtered as REDUNDANT during
   * this briefing's generation. Empty array when nothing was filtered
   * (the common case). When non-empty, the BriefingPage renders a
   * subtle "no new movement on these topics" header chip with each
   * entry deep-linking back to the predecessor piece.
   */
  redundantDrafts?: RedundantDraftEntry[];
  /**
   * Set on a finalized briefing that has zero teaching pieces, so the
   * UI can render an explicit "no content today" state instead of an
   * empty shell. Possible values:
   *   - "no_candidates":         nothing in the user's signal surfaces
   *                              warranted a piece today
   *   - "all_pieces_failed":     candidates existed but every LLM call
   *                              errored — try regenerating
   *   - "monthly_budget_exceeded": LLM spend hit the monthly cap
   *   - "cancelled" / "unknown": catch-alls
   * `null` when pieces > 0 or when the briefing is still generating.
   */
  noContentReason?: string | null;
}

export interface WeeklyStats {
  briefingsRead: number;
  quizzesCompleted: number;
  avgDepthChange: number;
  newConcepts: number;
}

export interface NearMissItem {
  title: string;
  source_type: string;
  source_label: string;
  relevance_score: number;
  exclusion_reason: string;
  url: string | null;
}

export interface QuizData {
  id: string;
  concept: string;
  conceptId: string;
  conceptDepth: number;
  question: string;
  context: string | null;
  type: string;
}

export interface QuizAssessmentData {
  assessedDepth: number;
  previousDepth: number;
  reasoning: string;
  gaps: { summary: string; specifics: string[] };
  learningPath: Array<{ action: string; resource?: Resource }>;
  conceptUpdated: boolean;
}

export interface BaselineQuestion {
  id: string;
  concept: string;
  conceptId: string;
  currentDepth: number;
  question: string;
}

export interface ConceptData {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  description: string | null;
  depth: number;
  confidence: number;
  lastExposed: string | null;
  lastCalibrated: string | null;
  exposureCount: number;
  decayWarning: boolean;
  /** Timestamp when the user marked this concept as not interesting; null when active. */
  suppressedAt?: string | null;
  /** Focus statement version that was active when this concept was extracted. */
  focusVersionId?: string | null;
  /**
   * Recent depth history (chronological, oldest → newest, capped at 24
   * points) sourced from `concept_depth_history`. Drives the inline
   * sparkline on the concepts list view. Empty array when the concept
   * has no history yet (just-extracted, never calibrated).
   */
  depthHistory?: number[];
}

export interface ConceptRelation {
  id: string;
  source_concept_id: string;
  target_concept_id: string;
  relation_type: "prerequisite" | "leads_to" | "related";
  target_name?: string;
  source_name?: string;
}

export interface ConceptArtifact {
  id: string;
  title: string;
  type: string;
  date: string;
  briefingId: string;
}

export interface DepthHistoryEntry {
  depth: number;
  confidence: number;
  source: string;
  detail: string;
  date: string;
}

export interface BriefingListItem {
  id: string;
  briefing_date: string;
  status: string;
  generated_at: string;
  created_at: string;
  /** Number of teaching pieces in this briefing. 0 for briefings that
   *  failed before the generating-pieces step. */
  pieceCount?: number;
  /** Titles of the first ~5 teaching pieces, in reading order. The
   *  Archive page renders these as a compact preview line so the user
   *  can see *what* the briefing covered without opening it. */
  pieceTitles?: string[];
  /** Top concepts mentioned across the briefing's pieces, sorted by
   *  within-briefing frequency. Capped at 5 to keep the list row
   *  scannable. */
  topConcepts?: string[];
}

export interface FeedbackDelta {
  conceptName: string;
  previousDepth: number;
  newDepth: number;
  delta: number;
}
