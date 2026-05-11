import { useCallback, useEffect, useRef, useState } from "react";
import type { BriefingData, FeedbackDelta, QuizData, TeachingPieceData } from "../types";
import { apiGet, apiPost } from "../utils/api";

interface BriefingResponse {
  briefing: BriefingData | null;
  pieces: TeachingPieceData[];
  quiz?: QuizData | null;
}

interface GenerationStatus {
  step: string | null;
  stepLabel: string | null;
  details: string[];
  waitingOnAi: boolean;
  stepStartedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  averageDurationSeconds: number | null;
  cancelRequested: boolean;
  stuck: boolean;
}

interface UseBriefingResult {
  briefing: BriefingData | null;
  pieces: TeachingPieceData[];
  quiz: QuizData | null;
  loading: boolean;
  error: string | null;
  generating: boolean;
  cancelling: boolean;
  generationStatus: GenerationStatus;
  generate: () => Promise<void>;
  cancel: () => Promise<void>;
  forceReset: () => Promise<void>;
  submitFeedback: (pieceId: string, feedback: "positive" | "negative") => Promise<FeedbackDelta[]>;
}

const INITIAL_STATUS: GenerationStatus = {
  step: null,
  stepLabel: null,
  details: [],
  waitingOnAi: false,
  stepStartedAt: null,
  startedAt: null,
  updatedAt: null,
  averageDurationSeconds: null,
  cancelRequested: false,
  stuck: false,
};

// "Today" used to be derived client-side and sent to the worker via
// a `?date=` query param. That plumbing was removed when the worker
// became the canonical source of truth for the user's local day —
// every API call now carries `X-Client-Timezone` (set by the
// `apiGet`/`apiPost`/etc. wrappers in utils/api.ts), and the worker's
// user-context middleware resolves the user's "today" against it.
// See migration 0013 + src/worker/util/time.ts.

export function useBriefing(date?: string): UseBriefingResult {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [pieces, setPieces] = useState<TeachingPieceData[]>([]);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>(INITIAL_STATUS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBriefing = useCallback(async () => {
    try {
      const endpoint = date ? `/api/briefing/${date}` : "/api/briefing/today";
      const data = await apiGet<BriefingResponse>(endpoint);
      setBriefing(data.briefing);
      setPieces(data.pieces);
      setQuiz(data.quiz ?? null);
      setError(null);

      if (data.briefing?.status === "generating") {
        setGenerating(true);
      } else {
        setGenerating(false);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch briefing");
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchBriefing();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchBriefing]);

  // Mobile browsers (iOS Safari especially) tear down in-flight
  // fetches when the page is backgrounded. The `generate()` call is a
  // long-lived stream that resolves only when generation finishes, so
  // app-switching mid-generation causes its await to reject with a
  // network-level `TypeError: Failed to fetch` — leaving the UI stuck
  // on an error banner even though the worker is still happily
  // generating (or already finished).
  //
  // Recovery: re-fetch when the tab becomes visible again AND when
  // the network reports back online. We listen to both because the
  // visibilitychange event fires the moment the page resumes — often
  // before the mobile network stack has actually finished reconnecting
  // — so the first refetch attempt can itself fail with the same
  // TypeError. The `online` event fires once connectivity is real, and
  // `apiGet` retries TypeErrors internally as a final safety net.
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

  const pollStatus = useCallback(async () => {
    try {
      const [status, briefingData] = await Promise.all([
        apiGet<{
          status: string;
          step: string | null;
          stepLabel: string | null;
          details: string[];
          waitingOnAi: boolean;
          stepStartedAt: string | null;
          startedAt: string | null;
          updatedAt?: string | null;
          averageDurationSeconds: number | null;
          cancelRequested?: boolean;
          stuck?: boolean;
        }>("/api/briefing/status"),
        apiGet<BriefingResponse>(date ? `/api/briefing/${date}` : "/api/briefing/today").catch(() => null),
      ]);

      setGenerationStatus({
        step: status.step,
        stepLabel: status.stepLabel,
        details: status.details ?? [],
        waitingOnAi: status.waitingOnAi ?? false,
        stepStartedAt: status.stepStartedAt ?? null,
        startedAt: status.startedAt ?? null,
        updatedAt: status.updatedAt ?? null,
        averageDurationSeconds: status.averageDurationSeconds ?? null,
        cancelRequested: status.cancelRequested ?? false,
        stuck: status.stuck ?? false,
      });

      if (briefingData?.briefing) {
        setBriefing(briefingData.briefing);
        setPieces(briefingData.pieces);
        setQuiz(briefingData.quiz ?? null);
      }

      if (status.status !== "generating") {
        setGenerating(false);
        setCancelling(false);
        setGenerationStatus(INITIAL_STATUS);
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        fetchBriefing();
      }
    } catch {
      // status poll is non-critical
    }
  }, [fetchBriefing, date]);

  useEffect(() => {
    if (generating && !pollRef.current) {
      pollRef.current = setInterval(pollStatus, 2000);
    }
    return () => {
      if (!generating && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [generating, pollStatus]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      // The worker now streams a heartbeat-keepalive response that
      // resolves only after generation finishes (see briefing.ts).
      // Setting `generating: true` immediately fires the pollStatus
      // useEffect, which already polls /briefing/status every 2s,
      // refreshes pieces as they arrive, self-terminates when the
      // status flips to "generated", and calls fetchBriefing once on
      // completion.
      //
      // We deliberately do NOT start a second `setInterval` here.
      // The previous code (`pollRef.current = setInterval(fetchBriefing, 3000)`)
      // overwrote the pollStatus interval ID in pollRef without
      // clearing it, orphaning the pollStatus interval — which then
      // ran forever, hitting two endpoints every 2s and rapidly
      // re-rendering the page (the "flashing content" bug).
      //
      // One explicit fetchBriefing() after the stream resolves
      // belt-and-suspenders the post-generation refresh in case
      // pollStatus hasn't ticked between the stream close and this
      // resolution.
      await apiPost("/api/briefing/generate");
      await fetchBriefing();
    } catch (err) {
      setGenerating(false);
      setError(err instanceof Error ? err.message : "Generation failed");
    }
  }, [fetchBriefing]);

  const cancel = useCallback(async () => {
    // Optimistically show "Cancelling..." right away so the user knows
    // the click registered. The poll loop will flip cancelRequested=true
    // once the server confirms, then generating=false when the generator
    // reaches its next checkpoint.
    setCancelling(true);
    setGenerationStatus((prev) => ({ ...prev, cancelRequested: true }));
    try {
      await apiPost("/api/briefing/cancel");
    } catch (err) {
      setCancelling(false);
      setGenerationStatus((prev) => ({ ...prev, cancelRequested: false }));
      setError(err instanceof Error ? err.message : "Cancel failed");
    }
  }, []);

  // Escape hatch for zombie briefings — nukes today's row server-side so a
  // fresh generate has a clean slate. Used when cooperative cancel can't
  // reach a checkpoint (hung fetch, dead worker).
  const forceReset = useCallback(async () => {
    setCancelling(true);
    try {
      await apiPost("/api/briefing/reset");
      setGenerating(false);
      setCancelling(false);
      setGenerationStatus(INITIAL_STATUS);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      await fetchBriefing();
    } catch (err) {
      setCancelling(false);
      setError(err instanceof Error ? err.message : "Reset failed");
    }
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
    generating,
    cancelling,
    generationStatus,
    generate,
    cancel,
    forceReset,
    submitFeedback,
  };
}
