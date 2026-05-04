import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "../utils/api";

/**
 * Async-prep button for baseline calibration.
 *
 * Mirrors the deep-dive UX: clicking kicks off LLM-backed question
 * generation via `POST /api/quiz/baseline/prepare`, the user can
 * navigate away, the notification bell flips to "ready" when work
 * completes, and *coming back to this button still shows the
 * progress* if it's still running.
 *
 * The previous implementation tracked the queued state in local
 * React state, which got reset every time the user navigated away
 * and back — that's the bug this rewrite fixes. Now the button
 * mounts against `GET /api/quiz/baseline/status` (server-side
 * source of truth) and polls every 3s while generation is in
 * flight. Rendered states:
 *
 *   - `loading`    — first paint while the status fetch is in
 *                    flight; renders nothing so the button doesn't
 *                    flash "Start" before snapping to "Generating".
 *   - `idle`       — no pending rows, no in-flight job. Render the
 *                    regular "Start calibration →" CTA.
 *   - `generating` — background prep job alive. Render an inline
 *                    "we'll ping the bell when it's ready" message.
 *                    Polls every 3s; auto-flips to `ready` when
 *                    generation completes (and the `/status` GET
 *                    self-heals any stuck notification on the way).
 *   - `ready`      — pending baseline rows exist. Render a
 *                    "Calibration ready ($n) →" CTA that jumps
 *                    straight to /calibrate.
 *   - `error`      — the prepare POST returned `no_concepts` or
 *                    threw. Surface the server-supplied error.
 */
type Status = "loading" | "idle" | "generating" | "ready" | "error";

interface StatusResponse {
  status: "idle" | "generating" | "ready" | "assessing" | "complete";
  conceptCount?: number;
  startedAt?: string;
  coverage?: {
    unverifiedTotal: number;
    byTrail: Record<string, number>;
    batchLimit: number;
  };
}

interface PrepareResponse {
  status: "ready" | "in_progress" | "no_concepts";
  conceptCount?: number;
  error?: string;
}

interface StartCalibrationButtonProps {
  /** Render the button as a primary CTA (filled accent) or a subtle
   *  inline link (the original styling on the Concepts trail
   *  banner). Defaults to "link" since both existing call sites used
   *  the lightweight inline styling. */
  variant?: "link" | "primary";
  /** Optional className to merge with the base styling. */
  className?: string;
  /** Override the button label. Defaults to "Start calibration →". */
  label?: string;
  /**
   * Optional trail / category scope. When set, the prepare POST
   * carries `{ category }` so the batch is filled from concepts in
   * THIS trail instead of the lowest-depth concepts globally. The
   * 6-question cap still applies per session — a trail with 20
   * unverified concepts takes ~4 sessions.
   *
   * If a session is already pending or generating (regardless of
   * scope), the button reflects that shared state — we don't run
   * concurrent batches across scopes because the `/calibrate` UI
   * is built around a single batch at a time.
   */
  category?: string;
  /**
   * Number of unverified concepts available in this scope. Used to
   * tailor copy ("Calibrate (12) →") and to disable the button
   * when there's nothing to do at this scope. When undefined, the
   * button uses coverage data from the `/status` endpoint instead.
   */
  unverifiedAvailable?: number;
}

const POLL_INTERVAL_MS = 3000;

export function StartCalibrationButton({
  variant = "link",
  className,
  label = "Start calibration →",
  category,
  unverifiedAvailable,
}: StartCalibrationButtonProps) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("loading");
  const [conceptCount, setConceptCount] = useState(0);
  const [coverage, setCoverage] = useState<StatusResponse["coverage"] | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (): Promise<Status> => {
    try {
      const resp = await apiGet<StatusResponse>("/api/quiz/baseline/status");
      setConceptCount(resp.conceptCount ?? 0);
      setCoverage(resp.coverage);
      // The /status endpoint can return `assessing` and `complete`
      // states — those are valid "session in progress" or "session
      // just finished" signals on the /calibrate page, but from the
      // button's perspective they mean "no new batch to start"
      // (idle for our purposes; the user can click to spin up
      // another batch if they want).
      const buttonStatus: Status =
        resp.status === "ready" ? "ready" : resp.status === "generating" ? "generating" : "idle";
      setStatus(buttonStatus);
      return buttonStatus;
    } catch {
      // Don't escalate to error state — keep the last-known UI and
      // try again on the next poll tick. A failed status fetch
      // shouldn't visually break the page.
      return status;
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: we want a stable closure even though `status` is read inside the catch
  }, []);

  // Initial fetch on mount. Runs once; the polling effect below
  // takes over while we're in `generating`.
  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Poll while generating. Cleanup on unmount or status change so we
  // don't leak intervals across navigations or hammer the API after
  // the work is done.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (status !== "generating") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => {
      void fetchStatus();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status, fetchStatus]);

  const handleStart = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Body carries `category` only when this button is scoped to
      // a trail (per-trail "Calibrate" CTA on the trail header).
      // Empty body → cross-trail batch from the lowest-depth pool.
      const body: { category?: string } = category ? { category } : {};
      const resp = await apiPost<PrepareResponse>("/api/quiz/baseline/prepare", body);
      if (resp.status === "ready") {
        // Already-generated questions waiting (race: prepare beat us
        // to it, or a prior session left rows around). Go straight
        // to the quiz.
        navigate("/calibrate");
      } else if (resp.status === "in_progress") {
        // Background prep just kicked off (or was already running).
        // Stay here; polling will flip us to `ready` when done.
        setStatus("generating");
      } else if (resp.status === "no_concepts") {
        setStatus("error");
        setError(resp.error ?? "No low-depth concepts to calibrate against.");
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Couldn't start calibration.");
    } finally {
      setBusy(false);
    }
  };

  const handleGoToQuiz = () => {
    navigate("/calibrate");
  };

  const baseClass =
    variant === "primary"
      ? "min-h-[44px] inline-flex items-center rounded-md bg-accent px-4 py-2 font-ui text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
      : "min-h-[44px] inline-flex items-center font-ui text-sm font-medium text-accent hover:text-accent/80 disabled:opacity-50 disabled:cursor-not-allowed";

  // First-paint while the status GET is in flight: render nothing so
  // the user doesn't see "Start calibration" flash before snapping to
  // "Generating…" when they land mid-job. Brief blank space is less
  // jarring than a wrong-state CTA.
  if (status === "loading") {
    return <div className={className} aria-hidden="true" />;
  }

  if (status === "generating") {
    return (
      <p className={`font-ui text-sm text-text-secondary ${className ?? ""}`.trim()}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse mr-1.5 align-middle" />
        Calibration is being prepared in the background — we'll ping the bell when it's ready.
      </p>
    );
  }

  if (status === "ready") {
    return (
      <div className={className}>
        <button type="button" onClick={handleGoToQuiz} className={baseClass}>
          Calibration ready{conceptCount > 0 ? ` (${conceptCount} question${conceptCount === 1 ? "" : "s"})` : ""} →
        </button>
      </div>
    );
  }

  // Coverage-aware copy for the idle CTA.
  //
  // - When this button is scoped to a trail, lean on the
  //   `unverifiedAvailable` count the parent passed in (computed
  //   from the in-memory concepts list) so we don't have to
  //   round-trip the byTrail breakdown for one number.
  // - For the cross-trail case, prefer `coverage.unverifiedTotal`
  //   from the status endpoint — but fall through to the
  //   caller-supplied label if coverage hasn't loaded yet.
  // - The 6-question cap is communicated explicitly: a user with 30
  //   concepts shouldn't be confused why "Start calibration" only
  //   gives them 6.
  const batchLimit = coverage?.batchLimit ?? 6;
  const scopedAvailable = unverifiedAvailable !== undefined ? unverifiedAvailable : (coverage?.unverifiedTotal ?? null);
  const willGenerate = scopedAvailable !== null ? Math.min(scopedAvailable, batchLimit) : null;

  // If we know the scope has no unverified concepts, render an
  // inert "All caught up" line rather than a button that 400s.
  if (status === "idle" && scopedAvailable === 0) {
    return (
      <div className={`font-ui text-xs text-text-faint ${className ?? ""}`.trim()}>
        ✓ All concepts in this {category ? "trail" : "graph"} are calibrated.
      </div>
    );
  }

  // `idle` and `error` share the same idle-styled CTA; `error` just
  // appends a helper line.
  const idleLabel = (() => {
    if (busy) return "Starting…";
    // Trail-scoped CTA: "Calibrate trail (12) →". The "X of N" hint
    // is appended inline only when the scope exceeds the per-session
    // cap, so the user gets the "this is one of multiple sessions"
    // signal exactly when it matters.
    if (category && willGenerate !== null) {
      return `Calibrate trail (${willGenerate}${
        scopedAvailable && scopedAvailable > willGenerate ? ` of ${scopedAvailable}` : ""
      }) →`;
    }
    // Cross-trail CTA: same shape — keep the original phrasing when
    // coverage hasn't loaded, otherwise show the count inline.
    if (!category && willGenerate !== null && scopedAvailable !== null) {
      return scopedAvailable > willGenerate
        ? `Start calibration (${willGenerate} of ${scopedAvailable}) →`
        : `Start calibration (${willGenerate}) →`;
    }
    return label;
  })();

  // Tooltip with the per-session cap explanation, replacing the
  // previously-inline `<p>` helper line. Two reasons for moving it
  // out of the visible flow:
  //   1. **Alignment** — the helper line forced trail-header rightSlots
  //      with overflow into a 2-row column, throwing off the
  //      vertical centering of every other trail header on the page.
  //      With the helper gone, every header is a single row and the
  //      "Calibrate trail" CTAs line up uniformly.
  //   2. **Repetition** — the same sentence repeated on every trail
  //      that exceeds the cap was visual noise. Surfacing the cap
  //      once on hover is enough; the inline "(X of N)" already
  //      communicates the multi-session nature without the prose.
  const tooltip =
    willGenerate !== null && scopedAvailable !== null && scopedAvailable > willGenerate
      ? `Calibrates up to ${batchLimit} concepts per session — run another batch for the rest.`
      : willGenerate !== null
        ? `Calibrates ${willGenerate} concept${willGenerate === 1 ? "" : "s"}.`
        : undefined;

  return (
    <div className={className}>
      <button type="button" onClick={handleStart} disabled={busy} className={baseClass} title={tooltip}>
        {idleLabel}
      </button>
      {status === "error" && error && <p className="mt-1 font-ui text-xs text-negative">{error}</p>}
    </div>
  );
}
