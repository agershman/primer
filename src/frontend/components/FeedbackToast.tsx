import { useEffect } from "react";
import type { FeedbackDelta } from "../types";

interface FeedbackToastProps {
  deltas: FeedbackDelta[];
  onDismiss: () => void;
}

export function FeedbackToast({ deltas, onDismiss }: FeedbackToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (deltas.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-toast-in">
      <div className="rounded-lg border border-accent bg-surface px-4 py-3 shadow-lg max-w-sm">
        {deltas.map((d, i) => (
          <p key={i} className="font-ui text-xs text-text-secondary">
            {d.conceptName} depth <span className="font-mono text-text-dim">{d.previousDepth.toFixed(1)}</span>
            {" → "}
            <span className="font-mono text-accent">{d.newDepth.toFixed(1)}</span>
          </p>
        ))}
      </div>
    </div>
  );
}
