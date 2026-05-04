import { useCallback, useState } from "react";
import type { BaselineQuestion, QuizAssessmentData, QuizData } from "../types";
import { apiGet, apiPost } from "../utils/api";

interface UseQuizResult {
  quiz: QuizData | null;
  assessment: QuizAssessmentData | null;
  loading: boolean;
  submitting: boolean;
  fetchNext: () => Promise<void>;
  submitAnswer: (quizId: string, answer: string) => Promise<QuizAssessmentData>;
  skipQuiz: (quizId: string) => Promise<void>;
  clearAssessment: () => void;
}

export function useQuiz(initialQuiz?: QuizData | null): UseQuizResult {
  const [quiz, setQuiz] = useState<QuizData | null>(initialQuiz ?? null);
  const [assessment, setAssessment] = useState<QuizAssessmentData | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setAssessment(null);
    try {
      const data = await apiGet<{ quiz: QuizData | null }>("/api/quiz/next");
      setQuiz(data.quiz);
    } catch {
      setQuiz(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const submitAnswer = useCallback(async (quizId: string, answer: string) => {
    setSubmitting(true);
    try {
      const initial = await apiPost<QuizAssessmentData & { pending?: boolean }>(`/api/quiz/${quizId}/answer`, {
        answer,
      });
      if (initial.pending) {
        setAssessment({ ...initial, reasoning: "Assessing your answer…" });
        const poll = async () => {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const result = await apiGet<QuizAssessmentData & { pending?: boolean }>(`/api/quiz/${quizId}/assessment`);
              if (!result.pending) {
                setAssessment({ ...result, previousDepth: initial.previousDepth, conceptUpdated: true });
                return result;
              }
            } catch {
              break;
            }
          }
        };
        poll();
        return initial;
      }
      setAssessment(initial);
      return initial;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const skipQuiz = useCallback(
    async (quizId: string) => {
      await apiPost(`/api/quiz/${quizId}/skip`);
      await fetchNext();
    },
    [fetchNext],
  );

  const clearAssessment = useCallback(() => {
    setAssessment(null);
    setQuiz(null);
  }, []);

  return { quiz, assessment, loading, submitting, fetchNext, submitAnswer, skipQuiz, clearAssessment };
}

/**
 * Per-question assessment artifacts attached to baseline rows once
 * the LLM finishes scoring them. Used to render the "Why this
 * score?" expansion next to each depth indicator on the post-submit
 * overview.
 */
export interface BaselineAssessmentDetail {
  assessedDepth: number;
  previousDepth: number;
  reasoning?: string | null;
  gaps?: { summary?: string; specifics: string[] };
  learningPath?: Array<{ action: string; resource?: { title: string; url: string } }>;
}

interface UseBaselineResult {
  questions: BaselineQuestion[];
  currentIndex: number;
  answers: Map<string, string>;
  assessments: Map<string, BaselineAssessmentDetail>;
  /** True while ANY mount-time fetch is in flight (network only). */
  loading: boolean;
  /**
   * True ONLY while the server is still preparing questions
   * (`/api/quiz/baseline` returned `generating: true` and the hook is
   * polling). Distinct from `loading` because a typical fast-path
   * fetch — e.g. arriving from a "calibration ready" bell click —
   * also flips `loading` for ~200ms even though nothing is being
   * generated. Conflating the two would make every navigation flash
   * the misleading "Generating questions / 10–20 seconds" copy.
   */
  generating: boolean;
  submitting: boolean;
  done: boolean;
  /**
   * True when the user is RESUMING a recently-submitted batch
   * (navigated away during assessment and came back, or just landed
   * on /calibrate after the bell flipped to "complete"). The page
   * uses this to skip directly to the post-submit overview without
   * re-entering the question flow.
   */
  resumed: boolean;
  fetchBaseline: () => Promise<void>;
  submitBaselineAnswer: (quizId: string, answer: string) => Promise<void>;
  next: () => void;
  prev: () => void;
}

interface BaselineStatusResponse {
  status: "idle" | "generating" | "ready" | "assessing" | "complete";
  conceptCount?: number;
  recent?: {
    questions: Array<{
      id: string;
      conceptId: string;
      concept: string;
      assessedDepth: number | null;
      previousDepth: number;
      reasoning?: string | null;
      gaps?: { summary: string; specifics: string[] };
      learningPath?: Array<{ action: string; resource?: { title: string; url: string } }>;
    }>;
    pendingCount: number;
    submittedAt?: string | null;
  };
}

export function useBaseline(): UseBaselineResult {
  const [questions, setQuestions] = useState<BaselineQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map());
  const [assessments, setAssessments] = useState<Map<string, BaselineAssessmentDetail>>(new Map());
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [resumed, setResumed] = useState(false);

  const fetchBaseline = useCallback(async () => {
    setLoading(true);
    // Reset `generating` on every fetch so a previous polling loop
    // doesn't leak into a fresh call (e.g. user clicked Refresh
    // while a stale generation was lingering). It only flips back
    // to true if the server actually reports `generating: true`.
    setGenerating(false);
    try {
      // Mount-time reconciliation: ask the server what state we're
      // actually in before deciding which UI to render. This makes
      // /calibrate a "resumable" surface — a user who submitted
      // answers, navigated away while assessment was running, and
      // came back lands on the same overview view (rather than
      // restarting the questions or seeing an empty state). The
      // assessment itself runs server-side via `waitUntil` and
      // doesn't need the user's tab open to finish.
      const status = await apiGet<BaselineStatusResponse>("/api/quiz/baseline/status");

      if ((status.status === "assessing" || status.status === "complete") && status.recent) {
        // Resume an in-flight or completed batch.
        const recentQs: BaselineQuestion[] = status.recent.questions.map((q) => ({
          id: q.id,
          concept: q.concept,
          conceptId: q.conceptId,
          currentDepth: q.previousDepth,
          question: "",
        }));
        const newAssessments = new Map<string, BaselineAssessmentDetail>();
        for (const q of status.recent.questions) {
          newAssessments.set(q.id, {
            // -1 sentinel = "still being assessed". The page renders
            // a spinner row when it sees this; once polling resolves
            // a real depth, the spinner flips to the depth indicator.
            assessedDepth: q.assessedDepth ?? -1,
            previousDepth: q.previousDepth,
            reasoning: q.reasoning ?? null,
            gaps: q.gaps ?? { summary: "", specifics: [] },
            learningPath: q.learningPath ?? [],
          });
        }
        setQuestions(recentQs);
        setAssessments(newAssessments);
        setAnswers(new Map());
        setCurrentIndex(0);
        setDone(true);
        setResumed(true);
        return;
      }

      // Server returns `generating: true` when the async prep flow
      // (the "Start calibration" button on Concepts) is still running.
      // In that case we keep polling rather than firing a duplicate
      // inline generation — the prep job is the source of truth.
      let data = await apiGet<{ questions: BaselineQuestion[]; generating?: boolean }>("/api/quiz/baseline");
      if (data.generating) {
        // Mark this load as ACTUALLY generating (not just fetching) so
        // the UI can render the loud "10–20 seconds" copy instead of
        // the quiet generic spinner. This is the one true case for
        // that copy — a brief network-fetch flash is NOT.
        setGenerating(true);
        // Poll every 3 s for up to ~2 min. The server-side prep
        // typically finishes in 10–30 s; the long ceiling is just
        // a backstop against a wedged worker. The bell will also
        // surface a "failed" notification if the prep dies, so the
        // user has another path back to a sensible state.
        for (let i = 0; i < 40 && data.generating; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            data = await apiGet<{ questions: BaselineQuestion[]; generating?: boolean }>("/api/quiz/baseline");
          } catch {
            // Transient network error — keep polling.
          }
        }
        setGenerating(false);
      }
      setQuestions(data.questions);
      setCurrentIndex(0);
      setDone(false);
      setResumed(false);
    } catch {
      setQuestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const submitBaselineAnswer = useCallback(async (quizId: string, answer: string) => {
    setSubmitting(true);
    try {
      await apiPost<QuizAssessmentData>(`/api/quiz/${quizId}/answer`, { answer });
      setAnswers((prev) => new Map(prev).set(quizId, answer));
      setAssessments((prev) =>
        new Map(prev).set(quizId, {
          // -1 sentinel = pending. Polling fills in real values.
          assessedDepth: -1,
          previousDepth: 0,
          reasoning: null,
          gaps: { summary: "", specifics: [] },
          learningPath: [],
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }, []);

  const next = useCallback(() => {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      setDone(true);
    }
  }, [currentIndex, questions.length]);

  const prev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
    }
  }, [currentIndex]);

  return {
    questions,
    currentIndex,
    answers,
    assessments,
    loading,
    generating,
    submitting,
    done,
    resumed,
    fetchBaseline,
    submitBaselineAnswer,
    next,
    prev,
  };
}
