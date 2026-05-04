import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ConceptArtifact, ConceptData, ConceptRelation, DepthHistoryEntry } from "../types";
import { apiGet, apiPost } from "../utils/api";
import { ConceptStat, ConfidenceGuide, DepthGuide, ExposuresGuide } from "./ConceptStatGuide";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { DepthIndicator } from "./DepthIndicator";
import { Sparkline } from "./Sparkline";
import { Tooltip } from "./Tooltip";

type SortField = "depth" | "name" | "exposure";

interface ConceptListProps {
  concepts: ConceptData[];
  sort: SortField;
  onSortChange: (sort: SortField) => void;
  hideCategory?: boolean;
  hideSortControls?: boolean;
  /**
   * Called after a concept's suppression state changes (suppress or unsuppress).
   * Parent should refetch or update its in-memory list. If omitted, the row
   * is removed from view optimistically without notifying the parent.
   */
  onSuppressionChange?: (conceptId: string, suppressed: boolean) => void;
}

interface ExpandedData {
  relations: ConceptRelation[];
  reverseRelations: ConceptRelation[];
  articles: ConceptArtifact[];
  history: DepthHistoryEntry[];
}

const SORT_TOOLTIPS: Record<SortField, string> = {
  depth: "Sort by current depth score (highest first)",
  name: "Sort alphabetically by concept name",
  exposure: "Sort by number of exposures (most first)",
};

export function ConceptList({
  concepts,
  sort,
  onSortChange,
  hideCategory = false,
  hideSortControls = false,
  onSuppressionChange,
}: ConceptListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedData, setExpandedData] = useState<ExpandedData | null>(null);
  const [expandLoading, setExpandLoading] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const handleSuppress = async (conceptId: string, currentlySuppressed: boolean) => {
    setPendingId(conceptId);
    try {
      const path = currentlySuppressed ? `/api/concept/${conceptId}/unsuppress` : `/api/concept/${conceptId}/suppress`;
      await apiPost(path);
      onSuppressionChange?.(conceptId, !currentlySuppressed);
    } catch {
      // ignore — caller should retry
    } finally {
      setPendingId(null);
    }
  };

  const loadExpanded = useCallback(async (id: string) => {
    setExpandLoading(true);
    try {
      const [detail, articlesData, historyData] = await Promise.all([
        apiGet<{
          concept: ConceptData;
          relations: ConceptRelation[];
          reverseRelations: ConceptRelation[];
        }>(`/api/concept/${id}`),
        apiGet<{ articles: ConceptArtifact[] }>(`/api/concept/${id}/articles`),
        apiGet<{ history: DepthHistoryEntry[] }>(`/api/concept/${id}/history`),
      ]);
      setExpandedData({
        relations: detail.relations,
        reverseRelations: detail.reverseRelations,
        articles: articlesData.articles,
        history: historyData.history,
      });
    } catch {
      setExpandedData(null);
    } finally {
      setExpandLoading(false);
    }
  }, []);

  useEffect(() => {
    if (expandedId) {
      loadExpanded(expandedId);
    } else {
      setExpandedData(null);
    }
  }, [expandedId, loadExpanded]);

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div>
      {!hideSortControls && (
        <div className="flex items-center gap-2 mb-4">
          <span className="font-ui text-[10px] text-text-faint uppercase tracking-wider">Sort:</span>
          {(["depth", "name", "exposure"] as SortField[]).map((field) => (
            <Tooltip key={field} content={SORT_TOOLTIPS[field]}>
              <button
                onClick={() => onSortChange(field)}
                className={`min-h-[44px] rounded-md px-3 py-1.5 font-ui text-xs transition-colors ${
                  sort === field ? "bg-surface text-text-primary font-medium" : "text-text-dim hover:text-text-primary"
                }`}
              >
                {field.charAt(0).toUpperCase() + field.slice(1)}
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      <div className="divide-y divide-border-subtle">
        {concepts.map((concept) => {
          const isExpanded = expandedId === concept.id;
          const stale = concept.decayWarning;
          const suppressed = !!concept.suppressedAt;
          const isPending = pendingId === concept.id;

          return (
            <div key={concept.id} className="group">
              <div className="flex items-center -mx-2 px-2 rounded-md hover:bg-surface-hover transition-colors">
                <button onClick={() => toggle(concept.id)} className="flex-1 text-left py-3 min-h-[44px]">
                  <div className={`flex items-center gap-3 ${suppressed ? "opacity-50" : ""}`}>
                    <DepthIndicator depth={concept.depth} />
                    <span
                      className={`font-ui text-sm text-text-primary flex-1 min-w-0 truncate ${suppressed ? "line-through" : ""}`}
                    >
                      {concept.name}
                    </span>
                    {suppressed && (
                      <span className="font-mono text-[9px] uppercase tracking-widest text-text-faint">suppressed</span>
                    )}
                    {stale && !suppressed && (
                      <span className="font-mono text-[9px] uppercase tracking-widest text-warning">stale</span>
                    )}
                    <ConfidenceBadge confidence={concept.confidence} />
                    {/* Real depth-history sparkline. We only render it
                        when there are at least 2 data points to plot —
                        a single point or no history would either be
                        invisible (a dot) or misleading (a flat line
                        implying "no movement" when really there's "no
                        data yet"). When there isn't enough history,
                        we render a SparklinePlaceholder (a faint
                        dashed line in the same 80×20 box) instead of
                        a bare em-dash — the dashed-line shape clearly
                        communicates "this column is a trend chart;
                        nothing to plot yet" rather than reading as
                        random punctuation noise. */}
                    <span className="hidden sm:inline-flex w-[80px] h-[20px] justify-center items-center">
                      {concept.depthHistory && concept.depthHistory.length >= 2 ? (
                        <Sparkline data={concept.depthHistory} />
                      ) : (
                        <SparklinePlaceholder />
                      )}
                    </span>
                    {!hideCategory && (
                      <span className="hidden md:inline font-ui text-[10px] text-text-faint capitalize truncate max-w-[80px]">
                        {concept.category}
                      </span>
                    )}
                    {/* Last-exposed column. When the user hasn't been
                        exposed to the concept yet, show "never" with
                        a tooltip rather than another bare em-dash —
                        the word disambiguates the column at a glance
                        ("ah, this is when I last saw the concept").
                        Italicized + dim so it visually recedes
                        compared to real values like "today" / "3d
                        ago", which should be the eye-catchers in this
                        column. */}
                    <span
                      className="hidden md:inline font-mono text-[10px] text-text-faint"
                      title={
                        concept.lastExposed
                          ? `Last seen in a briefing ${formatRelative(concept.lastExposed)}`
                          : "Not yet seen in a briefing piece"
                      }
                    >
                      {concept.lastExposed ? (
                        formatRelative(concept.lastExposed)
                      ) : (
                        <span className="italic">never</span>
                      )}
                    </span>
                  </div>
                </button>
                {/*
                 * Suppress button sits at the far-right edge of each
                 * row, so a center-aligned tooltip would be squeezed
                 * against the viewport edge and rendered as a
                 * vertical one-word-per-line column. `align="end"`
                 * right-anchors the tooltip so it grows leftward
                 * (toward the row), and `noWrap` keeps the short
                 * action label on a single line.
                 */}
                <Tooltip
                  align="end"
                  noWrap
                  content={
                    suppressed
                      ? "Unsuppress — re-include in trails and briefings"
                      : "Not interested — hide this concept and stop re-extracting it"
                  }
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSuppress(concept.id, suppressed);
                    }}
                    disabled={isPending}
                    className={`shrink-0 ml-2 p-1.5 rounded-md transition-colors disabled:opacity-50 ${
                      suppressed
                        ? "text-accent hover:bg-accent-dim"
                        : "text-text-faint hover:text-negative hover:bg-negative-dim opacity-0 group-hover:opacity-100 focus:opacity-100"
                    }`}
                    aria-label={suppressed ? "Unsuppress concept" : "Suppress concept"}
                  >
                    {suppressed ? (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2 8l4 4 8-8" />
                      </svg>
                    ) : (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <line x1="3" y1="3" x2="13" y2="13" />
                        <line x1="13" y1="3" x2="3" y2="13" />
                      </svg>
                    )}
                  </button>
                </Tooltip>
              </div>

              {isExpanded && (
                <div className="pb-4 pl-2 sm:pl-8">
                  {expandLoading ? (
                    <div className="space-y-2 py-2">
                      <div className="h-3 w-3/4 rounded bg-surface-active animate-pulse" />
                      <div className="h-3 w-1/2 rounded bg-surface-active animate-pulse" />
                    </div>
                  ) : (
                    <ExpandedContent concept={concept} data={expandedData} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExpandedContent({ concept, data }: { concept: ConceptData; data: ExpandedData | null }) {
  // Find the most recent quiz_assessment row in history (if any)
  // and tease the reasoning out of `change_detail`. The history
  // route returns rows in ASC order, so we scan from the end.
  const latestAssessment = data?.history
    ? [...data.history].reverse().find((h) => h.source === "quiz_assessment")
    : undefined;
  const latestReasoning = latestAssessment?.detail ? latestAssessment.detail.replace(/^Quiz [^:]+:\s*/, "") : null;

  return (
    <div className="space-y-4">
      {concept.description && (
        <p className="font-body text-sm text-text-secondary leading-relaxed">{concept.description}</p>
      )}

      <div className="flex flex-wrap gap-4">
        <ConceptStat
          label="Depth"
          value={(concept.depth ?? 0).toFixed(1)}
          tooltip={<DepthGuide value={concept.depth ?? 0} />}
          tooltipWidth="w-72"
        />
        <ConceptStat
          label="Confidence"
          value={`${((concept.confidence ?? 0) * 100).toFixed(0)}%`}
          tooltip={<ConfidenceGuide />}
          tooltipWidth="w-64"
        />
        <ConceptStat
          label="Exposures"
          value={String(concept.exposureCount)}
          tooltip={<ExposuresGuide />}
          tooltipWidth="w-64"
        />
      </div>

      {/*
       * Latest assessment reasoning, surfaced as a prominent inline
       * block (not behind another expand). The user explicitly asked
       * to see "where I was good, where I was lacking" without
       * having to click around — answering quiz questions and then
       * not knowing why you scored what you did is the friction
       * point this fixes. The Quiz history below still keeps the
       * full per-row drilldown via <ScoringReasoning> for older
       * assessments.
       */}
      {latestReasoning ? (
        <div className="rounded-md border border-border-subtle bg-bg-warm p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim">
              Why this score
            </span>
            {latestAssessment ? (
              <span className="font-mono text-[10px] text-text-faint">
                {new Date(latestAssessment.date).toLocaleDateString()}
              </span>
            ) : null}
          </div>
          <p className="font-ui text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{latestReasoning}</p>
          <Link
            to={`/concepts/${concept.id}`}
            className="inline-flex items-center font-mono text-[10px] text-accent hover:text-accent/80 no-underline"
          >
            View quiz history →
          </Link>
        </div>
      ) : null}

      {data && (
        <>
          {(data.relations.length > 0 || data.reverseRelations.length > 0) && (
            <div className="space-y-2">
              {data.reverseRelations.filter((r) => r.relation_type === "prerequisite").length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-ui text-[10px] text-text-faint">Prereqs:</span>
                  {data.reverseRelations
                    .filter((r) => r.relation_type === "prerequisite")
                    .map((r) => (
                      <Link
                        key={r.id}
                        to={`/concepts/${r.source_concept_id}`}
                        className="font-ui text-xs text-link hover:text-link-hover no-underline"
                      >
                        {r.source_name}
                      </Link>
                    ))}
                </div>
              )}
              {data.relations.filter((r) => r.relation_type === "leads_to").length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-ui text-[10px] text-text-faint">Leads to:</span>
                  {data.relations
                    .filter((r) => r.relation_type === "leads_to")
                    .map((r) => (
                      <Link
                        key={r.id}
                        to={`/concepts/${r.target_concept_id}`}
                        className="font-ui text-xs text-accent hover:text-accent/80 no-underline"
                      >
                        {r.target_name}
                      </Link>
                    ))}
                </div>
              )}
            </div>
          )}

          {data.articles.length > 0 && (
            <div>
              <span className="font-ui text-[10px] text-text-faint block mb-1">Related articles</span>
              <div className="space-y-1">
                {data.articles.slice(0, 5).map((article) => (
                  <Link
                    key={article.id}
                    to={`/briefing/${article.date?.split("T")[0] ?? ""}/${article.id}`}
                    className="block font-ui text-xs text-text-secondary hover:text-text-primary no-underline"
                  >
                    {article.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Render a faint dashed-line placeholder in the same 80×20 box the
 * real Sparkline occupies. Communicates "this column is a trend chart
 * and there's nothing to plot yet" without resorting to a bare
 * em-dash, which read as ambiguous noise next to other em-dashes in
 * adjacent columns. The dashed pattern + flat baseline reads as
 * "empty chart" — the same visual vocabulary as a placeholder graph.
 */
function SparklinePlaceholder() {
  return (
    <svg
      width="80"
      height="20"
      viewBox="0 0 80 20"
      className="text-text-faint opacity-50"
      role="img"
      aria-label="No depth-history data yet"
    >
      <title>Not enough history yet — answer a quiz or give feedback to start the trajectory</title>
      <line
        x1="6"
        y1="10"
        x2="74"
        y2="10"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeDasharray="2 3"
      />
    </svg>
  );
}

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "1d ago";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}
