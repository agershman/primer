interface FeedbackButtonsProps {
  pieceId: string;
  feedback: "positive" | "negative" | null;
  onFeedback: (pieceId: string, feedback: "positive" | "negative") => void;
}

export function FeedbackButtons({ pieceId, feedback, onFeedback }: FeedbackButtonsProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onFeedback(pieceId, "positive")}
        className={`min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 rounded-md border px-3 py-2 font-ui text-xs font-medium transition-colors ${
          feedback === "positive"
            ? "bg-positive-dim border-positive text-positive"
            : "border-border-subtle text-text-dim hover:border-border hover:text-text-secondary"
        }`}
      >
        <span>↑</span>
        <span>Useful</span>
      </button>
      <button
        onClick={() => onFeedback(pieceId, "negative")}
        className={`min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 rounded-md border px-3 py-2 font-ui text-xs font-medium transition-colors ${
          feedback === "negative"
            ? "bg-negative-dim border-negative text-negative"
            : "border-border-subtle text-text-dim hover:border-border hover:text-text-secondary"
        }`}
      >
        <span>↓</span>
        <span>Not helpful</span>
      </button>
    </div>
  );
}
