import { useCallback, useEffect, useRef } from "react";

interface UseInfiniteScrollOptions {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  threshold?: number;
  debounceMs?: number;
}

export function useInfiniteScroll({
  hasMore,
  loading,
  onLoadMore,
  threshold = 300,
  debounceMs = 200,
}: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const debouncedLoadMore = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!loadingRef.current && hasMore) {
        onLoadMore();
      }
    }, debounceMs);
  }, [hasMore, onLoadMore, debounceMs]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current) {
          debouncedLoadMore();
        }
      },
      { rootMargin: `${threshold}px` },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [hasMore, threshold, debouncedLoadMore]);

  return { sentinelRef };
}
