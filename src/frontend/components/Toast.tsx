import { useEffect } from "react";

interface ToastProps {
  message: string;
  tone?: "neutral" | "negative";
  /** Auto-dismiss delay in ms. Pass 0 to disable. */
  durationMs?: number;
  onDismiss: () => void;
}

/**
 * Lightweight bottom-center toast. The "no new content surfaced" run
 * uses this so the user gets a quiet acknowledgement instead of a
 * full-page empty state replacing their feed.
 */
export function Toast({ message, tone = "neutral", durationMs = 4000, onDismiss }: ToastProps) {
  useEffect(() => {
    if (durationMs <= 0) return;
    const id = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(id);
  }, [onDismiss, durationMs]);

  const border = tone === "negative" ? "border-negative" : "border-accent";

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-toast-in">
      <div className={`rounded-lg border ${border} bg-surface px-4 py-3 shadow-lg max-w-sm`}>
        <p className="font-ui text-xs text-text-secondary">{message}</p>
      </div>
    </div>
  );
}
