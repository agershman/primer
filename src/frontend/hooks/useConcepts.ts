import { useCallback, useEffect, useRef, useState } from "react";
import type { ConceptData } from "../types";
import { apiGet } from "../utils/api";

type SortField = "depth" | "name" | "exposure";

const PAGE_SIZE = 20;
const ALL_SIZE = 500;

/**
 * De-duplicate a concept list by id. Used as the LAST step in every
 * setConcepts callback because the page can race two fetch flows
 * against each other and merge them into the same array:
 *
 *   1. The IntersectionObserver sentinel firing `loadMore()` (which
 *      APPENDS the next page) at the same instant the trails view's
 *      `useEffect` fires `loadAll()` (which REPLACES with all
 *      concepts at once).
 *   2. A `setSort` / `setIncludeSuppressed` triggering a re-fetch
 *      while a `loadMore` is in flight.
 *
 * The fetch-token guard below cancels the late-arriving fetch's
 * setState in the common case, but dedupeById is a cheap belt-and-
 * suspenders that protects the rendering even if the token check
 * misses (e.g. fetch token bumped after the fetch started but
 * before its setConcepts ran).
 *
 * Concept IDs are server-generated (`cpt_*`) and globally unique
 * for a user, so id-keyed dedup is the right shape — we don't want
 * to dedupe on canonical_name because two different concepts might
 * legitimately share a normalized prefix in the future.
 */
function dedupeById(items: ConceptData[]): ConceptData[] {
  const seen = new Set<string>();
  const out: ConceptData[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

interface UseConceptsResult {
  concepts: ConceptData[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  sort: SortField;
  setSort: (field: SortField) => void;
  includeSuppressed: boolean;
  setIncludeSuppressed: (v: boolean) => void;
  hasMore: boolean;
  loadMore: () => void;
  total: number;
  refresh: () => Promise<void>;
  loadAll: () => Promise<void>;
}

export function useConcepts(): UseConceptsResult {
  const [concepts, setConcepts] = useState<ConceptData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSortState] = useState<SortField>("depth");
  const [includeSuppressed, setIncludeSuppressed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const offsetRef = useRef(0);

  // Monotonically-increasing token bumped on every "fresh" load
  // (full reset, sort change, includeSuppressed change, or
  // `loadAll`). A fetch reads this at start and re-checks it before
  // touching state — if the token has moved on, the fetch's result
  // is stale and gets dropped silently. Closes the loadMore-vs-
  // loadAll race that produced the duplicate row the user saw.
  const fetchTokenRef = useRef(0);

  const buildQuery = (limit: number, offset: number) => {
    const params = new URLSearchParams({
      sort,
      order: "desc",
      limit: String(limit),
      offset: String(offset),
    });
    if (includeSuppressed) params.set("include_suppressed", "true");
    return params.toString();
  };

  const fetchConcepts = useCallback(
    async (reset = true) => {
      if (reset) {
        setLoading(true);
        offsetRef.current = 0;
        fetchTokenRef.current += 1;
      } else {
        setLoadingMore(true);
      }
      const myToken = fetchTokenRef.current;

      try {
        const offset = reset ? 0 : offsetRef.current;
        const data = await apiGet<{ concepts: ConceptData[]; total: number; hasMore: boolean }>(
          `/api/concepts?${buildQuery(PAGE_SIZE, offset)}`,
        );

        // A `loadAll()` (or another reset) fired in parallel — drop
        // this stale response so we don't append page-N items onto a
        // list the parallel fetch has already replaced.
        if (myToken !== fetchTokenRef.current) return;

        if (reset) {
          setConcepts(dedupeById(data.concepts));
        } else {
          setConcepts((prev) => dedupeById([...prev, ...data.concepts]));
        }
        setHasMore(data.hasMore);
        setTotal(data.total);
        offsetRef.current = offset + data.concepts.length;
        setError(null);
      } catch (err) {
        if (myToken !== fetchTokenRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to fetch concepts");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [sort, includeSuppressed],
  );

  useEffect(() => {
    fetchConcepts(true);
  }, [fetchConcepts]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchConcepts(false);
    }
  }, [fetchConcepts, loadingMore, hasMore]);

  const setSort = useCallback((field: SortField) => {
    setSortState(field);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    // Bump the fetch token so any in-flight `loadMore()` from the
    // initial paginated mount drops its response on the floor — that
    // race was the original cause of duplicate concepts in the
    // trails view, where the loadMore-appended page-N landed on top
    // of the already-replaced full list.
    fetchTokenRef.current += 1;
    const myToken = fetchTokenRef.current;
    try {
      const data = await apiGet<{ concepts: ConceptData[]; total: number; hasMore: boolean }>(
        `/api/concepts?${buildQuery(ALL_SIZE, 0)}`,
      );
      if (myToken !== fetchTokenRef.current) return;
      setConcepts(dedupeById(data.concepts));
      setHasMore(false);
      setTotal(data.total);
      offsetRef.current = data.concepts.length;
      setError(null);
    } catch (err) {
      if (myToken !== fetchTokenRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to fetch concepts");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, includeSuppressed]);

  return {
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
    refresh: () => fetchConcepts(true),
    loadAll,
  };
}
