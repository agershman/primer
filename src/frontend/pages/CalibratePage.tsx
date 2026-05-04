import { BaselineQuiz } from "../components/BaselineQuiz";

export function CalibratePage() {
  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-xl sm:text-2xl font-medium text-text-primary mb-2">Baseline Calibration</h1>
      <p className="font-ui text-sm text-text-dim mb-7">
        Answer a few questions so Primer can gauge your current depth on key concepts.
      </p>
      <BaselineQuiz />
    </div>
  );
}
