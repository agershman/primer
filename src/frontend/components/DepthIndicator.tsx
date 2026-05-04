interface DepthIndicatorProps {
  depth: number;
  size?: number;
}

export function DepthIndicator({ depth, size = 6 }: DepthIndicatorProps) {
  const dots = [];
  const clamped = Math.max(0, Math.min(5, depth));

  for (let i = 0; i < 5; i++) {
    const fill = Math.min(1, Math.max(0, clamped - i));
    let colorClass: string;

    if (fill >= 1) {
      colorClass = "bg-accent";
    } else if (fill > 0) {
      colorClass = "bg-accent-muted";
    } else {
      colorClass = "bg-surface-active";
    }

    dots.push(
      <span key={i} className={`inline-block rounded-full ${colorClass}`} style={{ width: size, height: size }} />,
    );
  }

  return (
    <span className="inline-flex items-center gap-1" title={`Depth: ${(depth ?? 0).toFixed(1)} / 5`}>
      {dots}
    </span>
  );
}
