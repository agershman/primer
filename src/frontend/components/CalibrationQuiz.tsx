import { useState } from "react";
import { useQuiz } from "../hooks/useQuiz";
import type { QuizData } from "../types";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { DepthIndicator } from "./DepthIndicator";
import { DictationButton } from "./DictationButton";
import { QuizAssessment } from "./QuizAssessment";

interface CalibrationQuizProps {
  initialQuiz: QuizData;
}

export function CalibrationQuiz({ initialQuiz }: CalibrationQuizProps) {
  const { quiz, assessment, submitting, submitAnswer, skipQuiz, fetchNext, clearAssessment } = useQuiz(initialQuiz);
  const [answer, setAnswer] = useState("");
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);

  if (!quiz && !assessment) {
    return null;
  }

  if (assessment) {
    return (
      <div>
        <QuizAssessment assessment={assessment} />
        <div className="flex flex-col sm:flex-row gap-3 mt-4">
          <button
            onClick={async () => {
              clearAssessment();
              setAnswer("");
              setInterim("");
              await fetchNext();
            }}
            className="min-h-[44px] font-ui text-sm font-medium text-accent bg-accent-dim hover:bg-accent/20 rounded-md px-4 py-2 transition-colors"
          >
            Next question →
          </button>
        </div>
      </div>
    );
  }

  if (!quiz) return null;

  const canSubmit = answer.trim().length > 0 && !submitting;

  return (
    <div>
      <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-accent mb-4">Calibration</p>

      <div className="flex items-center gap-3 mb-3">
        <span className="font-ui text-sm font-medium text-text-primary">{quiz.concept}</span>
        <DepthIndicator depth={quiz.conceptDepth} />
        <ConfidenceBadge confidence={quiz.conceptDepth / 5} />
      </div>

      <p className="font-display text-lg text-text-primary leading-snug mb-4">{quiz.question}</p>

      {quiz.context && <p className="font-ui text-xs text-text-dim mb-4 italic">{quiz.context}</p>}

      <div className="relative">
        <textarea
          value={dictating && interim ? `${answer}${answer ? " " : ""}${interim}` : answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={dictating ? "Listening — start talking…" : "Type your answer or tap the mic to speak…"}
          rows={4}
          readOnly={dictating}
          className={`w-full rounded-lg border bg-surface px-4 py-3 pr-12 font-body text-sm text-text-primary placeholder:text-text-faint resize-y focus:outline-none focus:border-accent transition-colors ${
            dictating ? "border-accent ring-2 ring-accent/20 cursor-default" : "border-border"
          }`}
          data-allow-typing=""
        />
        <div className="absolute right-2 top-2">
          <DictationButton
            onTranscript={(text) => setAnswer((prev) => (prev ? `${prev} ${text}` : text))}
            onInterim={setInterim}
            onListeningChange={setDictating}
            continuous
            className="h-8 w-8"
          />
        </div>
        {dictating && (
          <p className="mt-1 font-ui text-[11px] text-accent">
            ● Listening — speak freely, pause to think, tap the mic again when you're done.
          </p>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mt-3">
        <button
          onClick={async () => {
            await submitAnswer(quiz.id, answer);
          }}
          disabled={!canSubmit}
          className={`min-h-[44px] rounded-md px-4 py-2 font-ui text-sm font-medium transition-colors ${
            canSubmit
              ? "bg-accent text-white hover:bg-accent/90"
              : "bg-surface-active text-text-faint cursor-not-allowed"
          }`}
        >
          {submitting ? "Assessing…" : "Submit"}
        </button>
        <button
          onClick={async () => {
            await submitAnswer(quiz.id, "I don't know");
          }}
          disabled={submitting}
          className="min-h-[44px] rounded-md px-4 py-2 font-ui text-sm text-text-dim hover:text-text-primary hover:bg-surface-hover border border-border transition-colors"
        >
          I don't know
        </button>
        <button
          onClick={() => {
            setAnswer("");
            setInterim("");
            skipQuiz(quiz.id);
          }}
          className="min-h-[44px] rounded-md border border-border-subtle px-4 py-2 font-ui text-sm text-text-faint hover:border-border hover:text-text-dim transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
