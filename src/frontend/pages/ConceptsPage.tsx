import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ConceptDetail } from "../components/ConceptDetail";
import { ConceptList } from "../components/ConceptList";
import { StartCalibrationButton } from "../components/StartCalibrationButton";
import { TrailHeader } from "../components/TrailHeader";
import { useConcepts } from "../hooks/useConcepts";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import type { ConceptData } from "../types";

type ViewMode = "trails" | "all";

export function ConceptsPage() {
  const { id } = useParams();
  const {
    concepts,
    loading,
    loadingMore,
    error,
    sort,
    setSort,
    includeSuppressed,
    setIncludeSuppressed,
    hasMore,
    loadMore,
    total,
    loadAll,
    refresh,
  } = useConcepts();
  const { sentinelRef } = useInfiniteScroll({ hasMore, loading: loadingMore, onLoadMore: loadMore });
  const [viewMode, setViewMode] = useState<ViewMode>("trails");
  const allLoadedRef = useRef(false);

  useEffect(() => {
    if (viewMode === "trails" && !allLoadedRef.current && total > concepts.length) {
      allLoadedRef.current = true;
      loadAll();
    }
  }, [viewMode, total, concepts.length, loadAll]);

  // When the user toggles include_suppressed we reset the cached "all loaded"
  // flag so the next trails switch re-fetches with the new filter.
  useEffect(() => {
    allLoadedRef.current = false;
  }, [includeSuppressed]);

  const [collapsedTrails, setCollapsedTrails] = useState<Set<string>>(new Set());

  if (id) {
    return <ConceptDetail />;
  }

  const totalConcepts = total;
  const deepCount = concepts.filter((c) => (c.depth ?? 0) >= 3).length;
  const staleCount = concepts.filter((c) => c.decayWarning).length;
  const lowDepthCount = concepts.filter((c) => (c.depth ?? 0) < 2).length;
  const showCalibrationPrompt = lowDepthCount >= 3 && viewMode === "all";

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
        <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary">
          {viewMode === "trails" ? "Learning Trails" : "Concept Graph"}
        </h1>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-text-dim hover:text-text-primary transition-colors">
            <input
              type="checkbox"
              checked={includeSuppressed}
              onChange={(e) => setIncludeSuppressed(e.target.checked)}
              className="h-3 w-3"
              style={{ accentColor: "var(--primer-accent)" }}
            />
            <span className="font-ui text-xs">Show suppressed</span>
          </label>

          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <button
              onClick={() => setViewMode("trails")}
              className={`px-3 py-1 font-ui text-xs transition-colors ${
                viewMode === "trails" ? "bg-surface-active text-text-primary" : "text-text-dim hover:text-text-primary"
              }`}
            >
              Trails
            </button>
            <button
              onClick={() => setViewMode("all")}
              className={`px-3 py-1 font-ui text-xs transition-colors ${
                viewMode === "all" ? "bg-surface-active text-text-primary" : "text-text-dim hover:text-text-primary"
              }`}
            >
              All
            </button>
          </div>
        </div>
      </div>

      {totalConcepts > 0 && (
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <span className="font-ui text-sm text-text-dim">
            <span className="font-mono text-text-primary">{totalConcepts}</span> concepts
          </span>
          <span className="font-ui text-sm text-text-dim">
            <span className="font-mono text-positive">{deepCount}</span> depth &ge; 3
          </span>
          {staleCount > 0 && (
            <span className="font-ui text-sm text-text-dim">
              <span className="font-mono text-warning">{staleCount}</span> stale
            </span>
          )}
        </div>
      )}

      {showCalibrationPrompt && (
        <div className="rounded-lg border border-accent-dim bg-accent-dim/30 px-4 py-3 mb-6">
          <p className="font-ui text-sm text-text-secondary mb-2">
            You have {lowDepthCount} concepts below depth 2. A quick calibration can help set accurate baselines.
          </p>
          <StartCalibrationButton />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 p-4 mb-4">
          <p className="font-ui text-sm text-negative">{error}</p>
        </div>
      )}

      {loading && concepts.length === 0 && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 rounded bg-surface-active animate-pulse" />
          ))}
        </div>
      )}

      {!loading && concepts.length === 0 && (
        <div className="border border-border-subtle rounded-lg p-6 text-center">
          <p className="font-ui text-sm text-text-dim">
            No concepts tracked yet. Generate a briefing to start building your concept graph.
          </p>
        </div>
      )}

      {concepts.length > 0 && viewMode === "trails" && (
        <TrailsView
          concepts={concepts}
          sort={sort}
          onSortChange={setSort}
          collapsedTrails={collapsedTrails}
          onToggleTrail={(cat) => {
            setCollapsedTrails((prev) => {
              const next = new Set(prev);
              if (next.has(cat)) next.delete(cat);
              else next.add(cat);
              return next;
            });
          }}
          onSuppressionChange={() => refresh()}
        />
      )}

      {concepts.length > 0 && viewMode === "all" && (
        <>
          <ConceptList concepts={concepts} sort={sort} onSortChange={setSort} onSuppressionChange={() => refresh()} />
          {loadingMore && (
            <div className="py-4 text-center">
              <div className="inline-block h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
          )}
          <div ref={sentinelRef} className="h-1" />
        </>
      )}

      {viewMode === "trails" && (
        <>
          {loadingMore && (
            <div className="py-4 text-center">
              <div className="inline-block h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            </div>
          )}
          <div ref={sentinelRef} className="h-1" />
        </>
      )}
    </div>
  );
}

function TrailsView({
  concepts,
  sort,
  onSortChange,
  collapsedTrails,
  onToggleTrail,
  onSuppressionChange,
}: {
  concepts: ConceptData[];
  sort: "depth" | "name" | "exposure";
  onSortChange: (s: "depth" | "name" | "exposure") => void;
  collapsedTrails: Set<string>;
  onToggleTrail: (category: string) => void;
  onSuppressionChange?: (id: string, suppressed: boolean) => void;
}) {
  const trails = useMemo(() => {
    const grouped = new Map<string, ConceptData[]>();
    for (const c of concepts) {
      const cat = c.category || "uncategorized";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(c);
    }

    return Array.from(grouped.entries())
      .map(([category, items]) => {
        const mostRecent = items.reduce(
          (latest, c) => {
            if (!c.lastExposed) return latest;
            return !latest || c.lastExposed > latest ? c.lastExposed : latest;
          },
          null as string | null,
        );

        const sorted = [...items].sort((a, b) => {
          if (sort === "name") return a.name.localeCompare(b.name);
          if (sort === "exposure") return (b.exposureCount ?? 0) - (a.exposureCount ?? 0);
          return (a.depth ?? 0) - (b.depth ?? 0);
        });

        return { category, concepts: sorted, mostRecent };
      })
      .sort((a, b) => {
        if (!a.mostRecent && !b.mostRecent) return a.category.localeCompare(b.category);
        if (!a.mostRecent) return 1;
        if (!b.mostRecent) return -1;
        return b.mostRecent.localeCompare(a.mostRecent);
      });
  }, [concepts, sort]);

  const lowTrailCount = trails.filter((t) => t.concepts.filter((c) => (c.depth ?? 0) < 2).length >= 3).length;

  return (
    <div className="space-y-3">
      {lowTrailCount > 0 && (
        <div className="rounded-lg border border-accent-dim bg-accent-dim/30 px-4 py-3 mb-2">
          <p className="font-ui text-sm text-text-secondary mb-1">
            {lowTrailCount} {lowTrailCount === 1 ? "trail has" : "trails have"} concepts that need calibration.
          </p>
          <StartCalibrationButton />
        </div>
      )}

      {trails.map((trail) => {
        const expanded = !collapsedTrails.has(trail.category);
        // Number of concepts in THIS trail that are still below the
        // depth-2 verified threshold. Drives the per-trail
        // "Calibrate trail (N) →" CTA in the trail header — the CTA
        // only renders when there's something to do at this scope.
        const unverifiedInTrail = trail.concepts.filter((c) => (c.depth ?? 0) < 2).length;
        return (
          <div key={trail.category}>
            <TrailHeader
              category={trail.category}
              concepts={trail.concepts}
              expanded={expanded}
              onToggle={() => onToggleTrail(trail.category)}
              rightSlot={
                unverifiedInTrail > 0 ? (
                  <StartCalibrationButton
                    category={trail.category}
                    unverifiedAvailable={unverifiedInTrail}
                    label={`Calibrate trail (${unverifiedInTrail}) →`}
                  />
                ) : null
              }
            />
            {expanded && (
              <div className="mt-1 ml-4 border-l-2 border-border-subtle pl-3">
                <ConceptList
                  concepts={trail.concepts}
                  sort={sort}
                  onSortChange={onSortChange}
                  hideCategory
                  hideSortControls
                  onSuppressionChange={onSuppressionChange}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
