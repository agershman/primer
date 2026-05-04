import type { QuizAssessmentData } from "../types";
import { DepthIndicator } from "./DepthIndicator";
import { ResourceList } from "./ResourceList";

interface QuizAssessmentProps {
  assessment: QuizAssessmentData;
}

export function QuizAssessment({ assessment }: QuizAssessmentProps) {
  const delta = assessment.assessedDepth - assessment.previousDepth;
  const deltaSign = delta >= 0 ? "+" : "";

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-surface p-4">
        <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-3">Depth change</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <DepthIndicator depth={assessment.previousDepth} />
            <span className="font-mono text-sm text-text-dim">{assessment.previousDepth.toFixed(1)}</span>
          </div>
          <span className="text-text-faint">→</span>
          <div className="flex items-center gap-2">
            <DepthIndicator depth={assessment.assessedDepth} />
            <span className="font-mono text-sm text-text-primary">{assessment.assessedDepth.toFixed(1)}</span>
          </div>
          <span className={`font-mono text-xs ${delta >= 0 ? "text-positive" : "text-negative"}`}>
            {deltaSign}
            {delta.toFixed(1)}
          </span>
        </div>
        {assessment.reasoning && <p className="font-ui text-xs text-text-dim mt-2">{assessment.reasoning}</p>}
      </div>

      {assessment.gaps.specifics.length > 0 && (
        <div className="rounded-lg border border-negative-dim bg-surface p-4">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-negative mb-3">
            Where to sharpen
          </p>
          {assessment.gaps.summary && (
            <p className="font-ui text-sm text-text-secondary mb-2">{assessment.gaps.summary}</p>
          )}
          <ul className="space-y-1">
            {assessment.gaps.specifics.map((gap, i) => (
              <li key={i} className="font-ui text-xs text-text-dim flex items-start gap-2">
                <span className="text-negative mt-0.5 shrink-0">•</span>
                <span>{gap}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {assessment.learningPath.length > 0 && (
        <div className="rounded-lg border border-positive-dim bg-surface p-4">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-positive mb-3">
            Suggested learning path
          </p>
          <ol className="space-y-2">
            {assessment.learningPath.map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="font-mono text-xs text-positive mt-0.5 shrink-0 w-4 text-right">{i + 1}.</span>
                <div>
                  <p className="font-ui text-sm text-text-secondary">{step.action}</p>
                  {step.resource && (
                    <div className="mt-1">
                      <ResourceList resources={[step.resource]} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
