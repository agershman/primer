import type { WeeklyStats as WeeklyStatsData } from "../types";

interface WeeklyStatsProps {
  stats: WeeklyStatsData;
}

export function WeeklyStats({ stats }: WeeklyStatsProps) {
  const items = [
    { label: "Briefings read", value: stats.briefingsRead },
    { label: "Quizzes completed", value: stats.quizzesCompleted },
    {
      label: "Avg depth Δ",
      value: `${(stats.avgDepthChange ?? 0) >= 0 ? "+" : ""}${(stats.avgDepthChange ?? 0).toFixed(1)}`,
    },
    { label: "New concepts", value: stats.newConcepts },
  ];

  return (
    <div className="rounded-lg border border-accent bg-accent-dim px-4 py-4 mb-6">
      <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-accent mb-3">Weekly velocity</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {items.map((item) => (
          <div key={item.label}>
            <p className="font-mono text-lg font-medium text-text-primary">{item.value}</p>
            <p className="font-ui text-[10px] text-text-dim">{item.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
