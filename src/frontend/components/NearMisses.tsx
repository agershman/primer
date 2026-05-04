import { useCallback, useEffect, useState } from "react";
import type { NearMissItem } from "../types";
import { apiGet } from "../utils/api";

interface NearMissesProps {
  briefingId: string;
}

export function NearMisses({ briefingId }: NearMissesProps) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<NearMissItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (loaded) return;
    try {
      const data = await apiGet<{ items: NearMissItem[] }>(`/api/briefing/${briefingId}/near-misses`);
      setItems(data.items);
    } catch {
      // silent fail — near misses are non-critical
    }
    setLoaded(true);
  }, [briefingId, loaded]);

  useEffect(() => {
    if (expanded && !loaded) {
      load();
    }
  }, [expanded, loaded, load]);

  return (
    <div className="mt-8 pt-6 border-t border-border-subtle">
      <button
        onClick={() => setExpanded(!expanded)}
        className="font-ui text-xs text-text-faint hover:text-text-dim transition-colors min-h-[44px] flex items-center"
      >
        {expanded ? "▾" : "▸"} More from feeds
      </button>
      {expanded && (
        <div className="mt-3 space-y-3">
          {items.length === 0 && loaded && (
            <p className="font-ui text-xs text-text-faint">No near-miss items for this briefing.</p>
          )}
          {items.map((item, i) => (
            <div key={i} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
              <div className="flex-1 min-w-0">
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-ui text-sm text-link hover:text-link-hover transition-colors"
                  >
                    {item.title}
                  </a>
                ) : (
                  <span className="font-ui text-sm text-text-secondary">{item.title}</span>
                )}
                <span className="font-ui text-[10px] text-text-faint ml-2">{item.source_label}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[10px] text-text-dim">
                  {((item.relevance_score ?? 0) * 100).toFixed(0)}%
                </span>
                <span className="font-ui text-[10px] text-text-faint truncate max-w-[180px]">
                  {item.exclusion_reason}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
