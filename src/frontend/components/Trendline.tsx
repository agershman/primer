interface TrendlineProps {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
}

/**
 * Filled-area sparkline used by the Analytics page. Distinct from
 * components/Sparkline (which renders a stroked polyline with a tip dot for
 * concept depth history) — keeping them separate so each can have a focused
 * API and visual identity.
 */
export function Trendline({
  values,
  width = 120,
  height = 32,
  stroke = "var(--primer-accent)",
  fill = "var(--primer-accent-dim)",
  className,
}: TrendlineProps) {
  if (values.length < 2) {
    return <div className={className} style={{ width, height }} aria-hidden />;
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return [x, y] as const;
  });

  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width={width}
      height={height}
      className={className}
      aria-hidden
    >
      <path d={areaPath} fill={fill} stroke="none" />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface BarsProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function Bars({ values, width = 120, height = 32, className }: BarsProps) {
  if (values.length === 0) {
    return <div className={className} style={{ width, height }} aria-hidden />;
  }
  const max = Math.max(...values, 1);
  const gap = 1;
  const barWidth = Math.max(1, (width - gap * (values.length - 1)) / values.length);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width={width}
      height={height}
      className={className}
      aria-hidden
    >
      {values.map((v, i) => {
        const h = (v / max) * height;
        const x = i * (barWidth + gap);
        const y = height - h;
        return <rect key={i} x={x} y={y} width={barWidth} height={h} fill="var(--primer-accent)" opacity={0.85} />;
      })}
    </svg>
  );
}
