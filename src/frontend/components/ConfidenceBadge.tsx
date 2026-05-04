import { Tooltip } from "./Tooltip";

interface ConfidenceBadgeProps {
  confidence: number;
  explanation?: string;
}

export function ConfidenceBadge({ confidence, explanation }: ConfidenceBadgeProps) {
  let label: string;
  let colorClass: string;

  if (confidence >= 0.7) {
    label = "verified";
    colorClass = "text-positive";
  } else if (confidence >= 0.4) {
    label = "estimated";
    colorClass = "text-warning";
  } else {
    label = "unverified";
    colorClass = "text-text-faint";
  }

  const badge = <span className={`font-mono text-[9px] uppercase tracking-widest ${colorClass}`}>{label}</span>;

  if (explanation) {
    return <Tooltip content={explanation}>{badge}</Tooltip>;
  }

  return <Tooltip content={`Confidence: ${((confidence ?? 0) * 100).toFixed(0)}%`}>{badge}</Tooltip>;
}
