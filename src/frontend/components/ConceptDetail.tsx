import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ConceptArtifact, ConceptData, ConceptRelation, DepthHistoryEntry } from "../types";
import { apiGet } from "../utils/api";
import { ConceptStat, ConfidenceGuide, DepthGuide, ExposuresGuide } from "./ConceptStatGuide";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { DepthIndicator } from "./DepthIndicator";
import { ScoringReasoning } from "./ScoringReasoning";
import { Sparkline } from "./Sparkline";

interface ConceptDetailData {
  concept: ConceptData;
  relations: ConceptRelation[];
  reverseRelations: ConceptRelation[];
}

export function ConceptDetail() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ConceptDetailData | null>(null);
  const [articles, setArticles] = useState<ConceptArtifact[]>([]);
  const [history, setHistory] = useState<DepthHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      apiGet<ConceptDetailData>(`/api/concept/${id}`),
      apiGet<{ articles: ConceptArtifact[] }>(`/api/concept/${id}/articles`),
      apiGet<{ history: DepthHistoryEntry[] }>(`/api/concept/${id}/history`),
    ])
      .then(([detailData, articlesData, historyData]) => {
        setDetail(detailData);
        setArticles(articlesData.articles);
        setHistory(historyData.history);
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="animate-fade-in space-y-4">
        <div className="h-3 w-20 rounded bg-surface-active animate-pulse" />
        <div className="h-6 w-48 rounded bg-surface-active animate-pulse" />
        <div className="h-4 w-full rounded bg-surface-active animate-pulse" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="animate-fade-in text-center py-12">
        <p className="font-ui text-sm text-text-dim">Concept not found.</p>
        <Link to="/concepts" className="font-ui text-sm text-accent no-underline mt-2 inline-block">
          ← Back to concepts
        </Link>
      </div>
    );
  }

  const { concept, relations, reverseRelations } = detail;
  const depthData = history.map((h) => h.depth);

  return (
    <div className="animate-fade-in">
      <Link
        to="/concepts"
        className="inline-flex items-center font-ui text-xs text-text-faint hover:text-text-dim transition-colors no-underline mb-6 min-h-[44px]"
      >
        ← Back to concepts
      </Link>

      <div className="flex items-center gap-3 mb-2">
        <h1 className="font-display text-2xl font-medium text-text-primary">{concept.name}</h1>
        {concept.decayWarning && (
          <span className="font-mono text-[9px] uppercase tracking-widest text-warning">stale</span>
        )}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <DepthIndicator depth={concept.depth} />
        <span className="font-mono text-sm text-text-primary">{(concept.depth ?? 0).toFixed(1)}</span>
        <ConfidenceBadge confidence={concept.confidence} />
        <span className="font-ui text-[10px] text-text-faint capitalize">{concept.category}</span>
      </div>

      {concept.description && (
        <p className="font-body text-base text-text-secondary leading-relaxed mb-6">{concept.description}</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <ConceptStat
          label="Depth"
          value={<span className="font-mono text-lg text-text-primary">{(concept.depth ?? 0).toFixed(1)}</span>}
          tooltip={<DepthGuide value={concept.depth ?? 0} />}
          tooltipWidth="w-72"
        />
        <ConceptStat
          label="Confidence"
          value={
            <span className="font-mono text-lg text-text-primary">{((concept.confidence ?? 0) * 100).toFixed(0)}%</span>
          }
          tooltip={<ConfidenceGuide />}
          tooltipWidth="w-64"
        />
        <ConceptStat
          label="Exposures"
          value={<span className="font-mono text-lg text-text-primary">{concept.exposureCount}</span>}
          tooltip={<ExposuresGuide />}
          tooltipWidth="w-64"
        />
        <div>
          <span className="font-ui text-[10px] text-text-faint block">Last exposed</span>
          <span className="font-mono text-sm text-text-primary">
            {concept.lastExposed ? new Date(concept.lastExposed).toLocaleDateString() : "—"}
          </span>
        </div>
      </div>

      {/*
       * Latest assessment reasoning.
       *
       * Surfaced as a prominent inline block (not behind another
       * expand) immediately under the stats grid so the user sees
       * "why I scored this way" the moment they open the page.
       * Pulled from the most recent quiz_assessment row in
       * concept_depth_history; the Quiz history below keeps the
       * full per-row drilldown via <ScoringReasoning>.
       */}
      <LatestAssessment history={history} conceptId={concept.id} />

      {depthData.length >= 2 && (
        <div className="mb-6">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-2">
            Depth timeline
          </p>
          <Sparkline data={depthData} width={300} height={40} />
        </div>
      )}

      {(relations.length > 0 || reverseRelations.length > 0) && (
        <div className="mb-6 space-y-2">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim">Relations</p>
          {reverseRelations.filter((r) => r.relation_type === "prerequisite").length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-ui text-[10px] text-text-faint">Prereqs:</span>
              {reverseRelations
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
          {relations.filter((r) => r.relation_type === "leads_to").length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-ui text-[10px] text-text-faint">Leads to:</span>
              {relations
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

      {history.length > 0 && (
        <div className="mb-6">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-2">Quiz history</p>
          {/*
           * Each row is a click-to-expand trigger driven by
           * `<ScoringReasoning>`. Quiz-assessment rows have full LLM
           * reasoning stored in `change_detail` (newer rows; older
           * rows are 200-char-truncated since the prior write code
           * sliced before persisting). Non-quiz history rows
           * (extraction, decay, manual) just have a one-liner
           * detail; for those the component degrades to a static
           * row with no chevron.
           *
           * For quiz_assessment rows we strip the leading
           * "Quiz <id>: " prefix so the reasoning reads naturally
           * inside the expansion panel.
           */}
          <div className="divide-y divide-border-subtle">
            {history.map((entry, i) => {
              const isQuiz = entry.source === "quiz_assessment";
              const reasoning = isQuiz && entry.detail ? entry.detail.replace(/^Quiz [^:]+:\s*/, "") : null;
              const previousDepth = i > 0 ? (history[i - 1].depth ?? null) : null;
              return (
                <div key={i} className="py-2">
                  <ScoringReasoning
                    trigger={
                      <>
                        <span className="font-mono text-[10px] text-text-faint shrink-0">
                          {new Date(entry.date).toLocaleDateString()}
                        </span>
                        <DepthIndicator depth={entry.depth} size={5} />
                        <span className="font-mono text-xs text-text-primary">{(entry.depth ?? 0).toFixed(1)}</span>
                        <span className="font-ui text-[10px] text-text-dim capitalize">
                          {entry.source.replace(/_/g, " ")}
                        </span>
                        {!reasoning && entry.detail ? (
                          <span className="font-ui text-[10px] text-text-faint truncate flex-1 min-w-0">
                            {entry.detail}
                          </span>
                        ) : (
                          <span className="flex-1 min-w-0" />
                        )}
                      </>
                    }
                    reasoning={reasoning}
                    previousDepth={previousDepth}
                    currentDepth={entry.depth ?? null}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {articles.length > 0 && (
        <div>
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-2">
            Related articles
          </p>
          <div className="space-y-2">
            {articles.map((article) => (
              <Link
                key={article.id}
                to={`/briefing/${article.date?.split("T")[0] ?? ""}/${article.id}`}
                className="block font-ui text-sm text-text-secondary hover:text-text-primary no-underline"
              >
                <span>{article.title}</span>
                <span className="ml-2 font-mono text-[10px] text-text-faint capitalize">{article.type}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline "Why this score" panel.
 *
 * Pulls the most recent quiz_assessment row out of the depth-history
 * timeline and renders the reasoning prominently — no collapse,
 * because the user complaint that triggered this said: "I answered
 * the questions, so why did I score the way I did. Where was I
 * good, lacking, etc." Hiding it behind another click defeats the
 * point.
 *
 * The reasoning string lives in `change_detail` prefixed with
 * "Quiz <id>: " (the prefix is what the predecessor classifier
 * uses to find which calibration row drove a depth change). We
 * strip it so the prose reads naturally.
 *
 * Renders nothing when no quiz assessments exist yet, so freshly-
 * extracted concepts that haven't been calibrated don't show an
 * empty "Why this score" block.
 */
function LatestAssessment({ history, conceptId }: { history: DepthHistoryEntry[]; conceptId: string }) {
  // History comes back in ASC order from the API — scan from the
  // newest entry backward to find the most recent quiz row.
  const latest = useMemo(() => {
    return [...history].reverse().find((h) => h.source === "quiz_assessment");
  }, [history]);

  if (!latest?.detail) return null;
  const reasoning = latest.detail.replace(/^Quiz [^:]+:\s*/, "");
  if (!reasoning.trim()) return null;

  // The history table doesn't store the quizId in a separate column;
  // we extract it from the detail string so a "View quiz" link can
  // jump to the calibration record. Optional — when a malformed
  // detail string lacks the prefix, we just don't render the link.
  const quizIdMatch = latest.detail.match(/^Quiz ([^:]+):/);
  const quizId = quizIdMatch?.[1] ?? null;

  return (
    <div className="rounded-md border border-border-subtle bg-bg-warm p-3 mb-6 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim">Why this score</span>
        <span className="font-mono text-[10px] text-text-faint">{new Date(latest.date).toLocaleDateString()}</span>
      </div>
      <p className="font-ui text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{reasoning}</p>
      {quizId ? (
        <p className="font-mono text-[10px] text-text-faint" data-concept-id={conceptId}>
          From quiz {quizId}
        </p>
      ) : null}
    </div>
  );
}
