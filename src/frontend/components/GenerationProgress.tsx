import { useEffect, useMemo, useState } from "react";

const GENERATION_STEPS = [
  { key: "starting", label: "Starting generation" },
  { key: "work_context", label: "Fetching sources" },
  { key: "slack_filter", label: "Filtering source data" },
  { key: "concepts", label: "Extracting concepts" },
  { key: "adjacent", label: "Scanning feeds" },
  { key: "selecting", label: "Selecting teaching targets" },
  { key: "generating_pieces", label: "Writing teaching pieces" },
  { key: "quiz", label: "Generating calibration quiz" },
  { key: "finishing", label: "Finishing up" },
];

interface GenerationProgressProps {
  step: string | null;
  stepLabel: string | null;
  details: string[];
  waitingOnAi: boolean;
  stepStartedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  averageDurationSeconds: number | null;
  cancelling: boolean;
  stuck: boolean;
  onCancel: () => void;
  onForceReset: () => void;
}

/**
 * The "we're working on it" panel surfaced while a briefing run is in
 * flight. Renders the staged checklist, cancel / force-stop affordances,
 * and an adaptive ETA built from the user's recent runs.
 */
export function GenerationProgress({
  step,
  stepLabel,
  details,
  waitingOnAi,
  stepStartedAt,
  startedAt,
  updatedAt,
  averageDurationSeconds,
  cancelling,
  stuck,
  onCancel,
  onForceReset,
}: GenerationProgressProps) {
  const activeIndex = GENERATION_STEPS.findIndex((s) => s.key === step);

  // Surface the escape hatch when cooperative cancel has been pending too
  // long, or when the server tells us the generator has gone silent.
  const [cancelPendingMs, setCancelPendingMs] = useState(0);
  useEffect(() => {
    if (!cancelling) {
      setCancelPendingMs(0);
      return;
    }
    const start = Date.now();
    const tick = () => setCancelPendingMs(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cancelling]);

  const showForceStop = stuck || (cancelling && cancelPendingMs > 15_000);

  const stuckSeconds = useMemo(() => {
    if (!updatedAt) return null;
    const t = new Date(updatedAt).getTime();
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 1000);
  }, [updatedAt]);

  const headline = stuck
    ? "Briefing generation is stuck"
    : cancelling
      ? "Cancelling briefing…"
      : "Generating your briefing";

  return (
    <div className="border border-border-subtle rounded-lg p-6 sm:p-8">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          {stuck ? (
            <span className="h-5 w-5 rounded-full border-2 border-warning bg-warning-dim shrink-0 flex items-center justify-center text-warning">
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="5" y1="1" x2="5" y2="6" />
                <circle cx="5" cy="9" r="0.5" fill="currentColor" />
              </svg>
            </span>
          ) : (
            <div className="h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
          )}
          <p className="font-display text-lg text-text-primary">{headline}</p>
        </div>
        <div className="flex items-center gap-2">
          {!showForceStop && (
            <button
              onClick={onCancel}
              disabled={cancelling}
              className="shrink-0 px-2.5 py-1 rounded-md border border-border font-ui text-xs text-text-dim hover:text-negative hover:border-negative transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-dim disabled:hover:border-border"
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {showForceStop && (
            <button
              onClick={onForceReset}
              className="shrink-0 px-2.5 py-1 rounded-md border border-negative bg-negative-dim font-ui text-xs text-negative hover:bg-negative hover:text-white transition-colors"
            >
              Force stop
            </button>
          )}
        </div>
      </div>

      {stuck && (
        <div className="mb-5 rounded-md bg-warning-dim border border-warning/20 px-3 py-2 font-ui text-xs text-text-primary">
          No progress for {stuckSeconds != null ? `${stuckSeconds}s` : "a while"} — the generator is likely hung on an
          external API call. Click <span className="font-semibold">Force stop</span> to clear this briefing and start
          fresh.
        </div>
      )}

      {!stuck && cancelling && cancelPendingMs > 15_000 && (
        <div className="mb-5 rounded-md bg-bg-warm border border-border-subtle px-3 py-2 font-ui text-xs text-text-dim">
          Cancel is taking longer than expected. The generator may be blocked on an in-flight API call. You can{" "}
          <span className="font-semibold text-negative">Force stop</span> to clear this briefing immediately.
        </div>
      )}

      <div className="space-y-1">
        {GENERATION_STEPS.map((s, i) => {
          const isCompleted = activeIndex > i;
          const isActive = activeIndex === i;
          const isPending = activeIndex < i;

          return (
            <div key={s.key} className="flex items-start gap-3 py-1.5">
              <div className="w-5 flex justify-center shrink-0 mt-[7px]">
                {isCompleted && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M3 8.5l3.5 3.5L13 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-positive"
                    />
                  </svg>
                )}
                {isActive && (
                  <div className="relative flex items-center justify-center">
                    <span className="absolute h-4 w-4 rounded-full bg-accent/30 animate-ping" />
                    <span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
                  </div>
                )}
                {isPending && <div className="h-2 w-2 rounded-full bg-surface-active" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center">
                  <span
                    className={`font-ui text-sm transition-colors ${
                      isCompleted ? "text-text-dim" : isActive ? "text-text-primary font-medium" : "text-text-faint"
                    }`}
                  >
                    {isActive && stepLabel ? stepLabel : s.label}
                  </span>
                  {isActive && stepStartedAt && <ElapsedTime since={stepStartedAt} />}
                  {isActive && waitingOnAi && (
                    <span className="ml-2 font-ui text-[10px] text-accent bg-accent-dim px-1.5 py-0.5 rounded">AI</span>
                  )}
                </div>
                {isActive && details.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {details.map((d, di) => (
                      <div key={di} className="font-ui text-xs text-text-dim truncate">
                        {d}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="font-ui text-xs text-text-faint mt-5 pl-8">
        {cancelling ? (
          <>Waiting for the current step to finish before stopping…</>
        ) : (
          <EtaMessage startedAt={startedAt} averageSeconds={averageDurationSeconds} />
        )}
      </p>
    </div>
  );
}

function ElapsedTime({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(since).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  if (elapsed < 2) return null;
  return <span className="font-mono text-xs text-text-faint ml-2">{elapsed}s</span>;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `about ${Math.round(seconds)} seconds`;
  const mins = seconds / 60;
  if (mins < 2) return `about a minute`;
  return `about ${Math.round(mins)} minutes`;
}

function EtaMessage({ startedAt, averageSeconds }: { startedAt: string | null; averageSeconds: number | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (averageSeconds && averageSeconds > 5) {
    if (startedAt && elapsed > 0) {
      const remaining = Math.max(0, Math.round(averageSeconds - elapsed));
      if (remaining > 0) {
        return <>Based on your recent briefings, about {formatDuration(remaining)} remaining.</>;
      }
      return <>Taking a bit longer than usual — almost there.</>;
    }
    return <>Based on your recent briefings, this usually takes {formatDuration(averageSeconds)}.</>;
  }
  return <>This usually takes 1–2 minutes.</>;
}
