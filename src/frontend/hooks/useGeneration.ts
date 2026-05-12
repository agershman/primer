import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../utils/api";

export interface GenerationStatus {
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

export type GenerationOutcome =
  | { kind: "added"; addedPieces: number }
  | { kind: "no_new_content"; reason: string }
  | { kind: "failed"; reason: string };

export interface UseGenerationResult {
  generating: boolean;
  cancelling: boolean;
  status: GenerationStatus;
  generate: () => Promise<void>;
  cancel: () => Promise<void>;
  forceReset: () => Promise<void>;
  /**
   * Outcome of the most recent completed run. Consumers should clear
   * this with `clearOutcome()` once they've surfaced it (toast, etc.)
   * so the same outcome doesn't fire twice.
   */
  lastOutcome: GenerationOutcome | null;
  clearOutcome: () => void;
  /**
   * Bumps each time a run completes (success or failure). Consumers
   * (e.g. the feed) watch this to refetch their data after generation.
   */
  completionTick: number;
}

interface TodayBriefingResponse {
  briefing: { noContentReason: string | null; status: string } | null;
  pieces: unknown[];
}

interface StatusResponse {
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
}

/**
 * Generation lifecycle hook, decoupled from any specific briefing
 * date. Owns "kick off a run / poll its status / surface its outcome".
 *
 * Why this is separate from `useBriefing(date)`: generation always
 * acts on the user's *today*, regardless of which briefing the user
 * happens to be looking at. Tying generation to a date hook lets you
 * view May 10 and accidentally regenerate May 12 — which was the
 * "refresh wiped my content" bug.
 */
export function useGeneration(): UseGenerationResult {
  const [generating, setGenerating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [status, setStatus] = useState<GenerationStatus>(INITIAL_STATUS);
  const [lastOutcome, setLastOutcome] = useState<GenerationOutcome | null>(null);
  const [completionTick, setCompletionTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Piece count for today *before* the run kicked off. Comparing
  // against the post-run count is how we distinguish "run produced
  // new pieces" from "run produced nothing new" — additive generation
  // preserves prior pieces, so a non-zero post-run count alone tells
  // us nothing.
  const beforeCountRef = useRef<number | null>(null);
  // Track whether we've observed a "generating" status during this
  // run. The first poll can race with the POST handler's DB write
  // and see status="idle"; without this guard, we'd prematurely
  // flip `generating` off and miss the actual generation entirely.
  const observedGeneratingRef = useRef(false);

  const resolveOutcome = useCallback(async () => {
    try {
      const data = await apiGet<TodayBriefingResponse>("/api/briefing/today");
      const before = beforeCountRef.current ?? 0;
      const after = data.pieces.length;
      if (data.briefing && data.briefing.status === "failed") {
        setLastOutcome({ kind: "failed", reason: data.briefing.noContentReason ?? "unknown" });
      } else if (after > before) {
        setLastOutcome({ kind: "added", addedPieces: after - before });
      } else {
        setLastOutcome({
          kind: "no_new_content",
          reason: data.briefing?.noContentReason ?? "no_candidates",
        });
      }
    } catch {
      // The outcome is best-effort UX; if the fetch fails the bell
      // notification still tells the truth.
    } finally {
      beforeCountRef.current = null;
      observedGeneratingRef.current = false;
    }
  }, []);

  const pollStatus = useCallback(async () => {
    try {
      const s = await apiGet<StatusResponse>("/api/briefing/status");

      setStatus({
        step: s.step,
        stepLabel: s.stepLabel,
        details: s.details ?? [],
        waitingOnAi: s.waitingOnAi ?? false,
        stepStartedAt: s.stepStartedAt ?? null,
        startedAt: s.startedAt ?? null,
        updatedAt: s.updatedAt ?? null,
        averageDurationSeconds: s.averageDurationSeconds ?? null,
        cancelRequested: s.cancelRequested ?? false,
        stuck: s.stuck ?? false,
      });

      if (s.status === "generating") {
        observedGeneratingRef.current = true;
        return;
      }

      // Only treat a non-generating status as completion if we've
      // actually seen the run be "generating" at least once. Otherwise
      // it's most likely a pre-kickoff stale read and we let the next
      // tick catch up.
      if (!observedGeneratingRef.current) return;

      setGenerating(false);
      setCancelling(false);
      setStatus(INITIAL_STATUS);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      await resolveOutcome();
      setCompletionTick((t) => t + 1);
    } catch {
      // Status poll is non-critical; keep trying.
    }
  }, [resolveOutcome]);

  useEffect(() => {
    if (generating && !pollRef.current) {
      pollRef.current = setInterval(pollStatus, 2000);
      // Kick a poll immediately so the progress panel reflects state
      // without a 2s blank gap after the user clicks Generate.
      pollStatus();
    }
    return () => {
      if (!generating && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [generating, pollStatus]);

  // On mount, detect a generation already in flight (e.g. kicked off
  // in another tab) so the UI surfaces it rather than ignoring it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await apiGet<{ status: string }>("/api/briefing/status");
        if (cancelled) return;
        if (s.status === "generating") {
          observedGeneratingRef.current = true;
          setGenerating(true);
        }
      } catch {
        // Non-critical.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = useCallback(async () => {
    // Capture today's piece count *before* the run so completion can
    // tell new pieces apart from preserved pieces.
    try {
      const before = await apiGet<TodayBriefingResponse>("/api/briefing/today");
      beforeCountRef.current = before.pieces.length;
    } catch {
      beforeCountRef.current = 0;
    }
    setGenerating(true);
    try {
      // The streaming response resolves when generation finishes (the
      // worker holds it open with heartbeats). We await it as the
      // primary completion signal; the poll loop is the fallback for
      // torn-down streams (mobile backgrounding, network blips).
      await apiPost("/api/briefing/generate");
      // Force an immediate status poll so completion lands in the
      // hook state before any caller-driven refetch.
      await pollStatus();
    } catch {
      // Stream torn down — poll loop will still detect completion.
    }
  }, [pollStatus]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    setStatus((prev) => ({ ...prev, cancelRequested: true }));
    try {
      await apiPost("/api/briefing/cancel");
    } catch {
      setCancelling(false);
      setStatus((prev) => ({ ...prev, cancelRequested: false }));
    }
  }, []);

  const forceReset = useCallback(async () => {
    setCancelling(true);
    try {
      await apiPost("/api/briefing/reset");
      setGenerating(false);
      setCancelling(false);
      setStatus(INITIAL_STATUS);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      // A forced reset wipes today's row — treat it like a no-op
      // completion so consumers don't show stale outcome toasts.
      beforeCountRef.current = null;
      observedGeneratingRef.current = false;
      setLastOutcome(null);
    } catch {
      setCancelling(false);
    }
  }, []);

  const clearOutcome = useCallback(() => setLastOutcome(null), []);

  return {
    generating,
    cancelling,
    status,
    generate,
    cancel,
    forceReset,
    lastOutcome,
    clearOutcome,
    completionTick,
  };
}
