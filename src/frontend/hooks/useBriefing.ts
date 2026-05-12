import { useCallback, useEffect, useState } from "react";
import type { BriefingData, FeedbackDelta, QuizData, TeachingPieceData } from "../types";
import { apiGet, apiPost } from "../utils/api";

interface BriefingResponse {
  briefing: BriefingData | null;
  pieces: TeachingPieceData[];
  quiz?: QuizData | null;
}

interface UseBriefingResult {
  briefing: BriefingData | null;
  pieces: TeachingPieceData[];
  quiz: QuizData | null;
  loading: boolean;
  error: string | null;
  submitFeedback: (pieceId: string, feedback: "positive" | "negative") => Promise<FeedbackDelta[]>;
}

/**
 * Date-scoped read-only briefing hook. Loads `/api/briefing/today`
 * when no date is given, or `/api/briefing/:date` for a specific one,
 * and exposes a feedback-submission helper.
 *
 * Generation lifecycle (kick off, status polling, cancellation) lives
 * in `useGeneration` — generation acts on today regardless of which
 * date the user is viewing, so coupling it to a date-scoped hook
 * caused the "refresh from May 10 wiped today's content" footgun.
 */
export function useBriefing(date?: string): UseBriefingResult {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [pieces, setPieces] = useState<TeachingPieceData[]>([]);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async () => {
    try {
      const endpoint = date ? `/api/briefing/${date}` : "/api/briefing/today";
      const data = await apiGet<BriefingResponse>(endpoint);
      setBriefing(data.briefing);
      setPieces(data.pieces);
      setQuiz(data.quiz ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch briefing");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  // Mobile browsers tear down in-flight fetches when the page is
  // backgrounded — visibility + online listeners refetch on resume so
  // the page doesn't get stuck on a stale error banner.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const refresh = () => {
      setError((prev) => (prev ? null : prev));
      fetchBriefing();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", refresh);
    };
  }, [fetchBriefing]);

  const submitFeedback = useCallback(
    async (pieceId: string, feedback: "positive" | "negative"): Promise<FeedbackDelta[]> => {
      const data = await apiPost<{ conceptDeltas: FeedbackDelta[] }>(`/api/piece/${pieceId}/feedback`, { feedback });
      setPieces((prev) => prev.map((p) => (p.id === pieceId ? { ...p, feedback } : p)));
      return data.conceptDeltas;
    },
    [],
  );

  return {
    briefing,
    pieces,
    quiz,
    loading,
    error,
    submitFeedback,
  };
}
