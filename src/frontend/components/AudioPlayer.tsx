import { useCallback, useEffect, useRef, useState } from "react";
import { dispatchPrimerEvent, onPrimerEvent } from "../lib/events";

interface AudioPlayerProps {
  src: string;
  /**
   * Optional TTS voice id. When provided, it is appended as `?voice=<id>` to the src URL,
   * which both routes the request to the right voice on the worker and ensures each voice
   * gets its own HTTP cache entry (Cloudflare keys on full URL incl. query string).
   */
  voiceId?: string | null;
  compact?: boolean;
  initialSeek?: number;
  onPositionChange?: (seconds: number) => void;
  /**
   * Optional duration estimate (in seconds) computed from the source
   * text the worker will hand to the TTS provider. When provided,
   * the player seeds its `estimatedDuration` state with this value
   * so the progress bar fills proportionally to real elapsed time
   * from the moment playback starts — instead of relying on
   * `audio.buffered.end()` as a proxy total, which sits near 80–95%
   * of fill the entire playback when streaming is close to playback
   * rate. The buffered-end heuristic is still applied on top as a
   * floor (the larger of the two wins), so an underestimate here is
   * non-fatal — the bar just snaps to a slightly higher denominator
   * mid-playback. Once the browser learns the real `audio.duration`
   * via `durationchange` it overrides everything. See
   * `utils/audioEstimate.ts` for the chars-per-second derivation.
   */
  estimatedDurationSeconds?: number;
}

/** How many seconds the skip-back / skip-forward buttons jump by. 15s
 *  is the same default Apple Podcasts, Spotify, and Pocket Casts use,
 *  picked so a sentence-length error in audio scrubbing never costs you
 *  more than a sentence to recover from. */
const SKIP_SECONDS = 15;

/**
 * Playback rates the user can cycle through. Picked to match the rates
 * users will recognize from podcast apps (and from YouTube): half-step
 * increments around 1.0×, with the 0.75× slow-down option for non-native
 * speakers and dense technical content.
 *
 * The user's choice is persisted in localStorage so it carries across
 * sessions and across every AudioPlayer instance on the page (briefing
 * pieces, chat replies, deep dives, etc.). All players also listen for
 * a window-level `primer:audio-rate-changed` event so changing the rate
 * on one player updates all of them in real time.
 */
const PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
const RATE_STORAGE_KEY = "primer:audio-rate";

function readStoredRate(): number {
  if (typeof window === "undefined") return 1;
  try {
    const raw = window.localStorage?.getItem(RATE_STORAGE_KEY);
    if (!raw) return 1;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0.25 || parsed > 4) return 1;
    return parsed;
  } catch {
    // localStorage can throw in private-mode Safari and some embedded
    // contexts. Fall back to the default rate without surfacing it.
    return 1;
  }
}

function writeStoredRate(rate: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(RATE_STORAGE_KEY, String(rate));
  } catch {
    // See readStoredRate for why we swallow.
  }
}

function formatRate(rate: number): string {
  // Use 0.75× rather than 0.8× style — keeps trailing zeros off integer
  // rates (1×, 2×) and shows the fractional rates with their natural
  // precision (0.75×, 1.25×). The trailing × is the typographic
  // multiplication sign so it visually distinguishes from the letter x.
  return Number.isInteger(rate) ? `${rate}×` : `${rate}×`;
}

export function AudioPlayer({
  src: srcBase,
  voiceId,
  compact = false,
  initialSeek = 0,
  onPositionChange,
  estimatedDurationSeconds,
}: AudioPlayerProps) {
  const src = voiceId ? `${srcBase}${srcBase.includes("?") ? "&" : "?"}voice=${encodeURIComponent(voiceId)}` : srcBase;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const errorPopoverRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused" | "error">("idle");
  // Diagnostic message shown in the error state. Populated by the
  // helper below on `<audio>.error` — fetches the same URL via
  // fetch() and reads the `X-Audio-Error` header (which the worker
  // sets when TTS fails). Without this the user just sees "Audio
  // unavailable" with no clue whether their API key is wrong, the
  // voice id is invalid, or ElevenLabs is rate-limiting.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Whether the click-toggleable error popover is open. Inline in the
  // narrow player row a long upstream message would either truncate
  // or push other controls off-screen, so we collapse it to an info
  // icon next to "Audio unavailable" and surface the full detail in
  // a floating panel above the icon on click.
  const [errorOpen, setErrorOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  // While the real `audio.duration` is `Infinity` (streaming TTS, no
  // Content-Length), we still want a visible progress fill that grows
  // with `currentTime` instead of pinning at 0% until the stream
  // completes.
  //
  // Two-source estimate, picking the larger:
  //
  //   1. `estimatedDurationSeconds` prop (preferred). The caller
  //      derived this from the source text length — accurate from
  //      t=0 regardless of how fast the worker streams. This is the
  //      fix for the "bar fills to ~80% immediately and then crawls
  //      to 100% over the remaining playback" bug that the
  //      buffered-end-only heuristic produced when streaming speed
  //      sat close to playback speed.
  //   2. `audio.buffered.end(last)` × 1.05 (live floor). Kept as a
  //      fallback for cases where no prop is supplied AND as a
  //      safety net if the prop underestimated — buffered-end
  //      growth past the prop estimate will still raise the
  //      denominator monotonically.
  //
  // Once the real `audio.duration` arrives via `durationchange`,
  // `bestDuration` flips to that and the fill becomes deterministic
  // regardless of what either estimate said.
  const [estimatedDuration, setEstimatedDuration] = useState<number>(
    estimatedDurationSeconds && estimatedDurationSeconds > 0 ? estimatedDurationSeconds : 0,
  );
  // While the user is dragging the playhead, the track shows a *preview*
  // position that follows the cursor immediately rather than waiting for
  // the next `timeupdate` event. We only commit the new currentTime to
  // the audio element on pointer-up to keep audible scrubbing smooth on
  // slow network conditions (constantly mutating currentTime mid-drag
  // would re-trigger buffer requests).
  const [scrubPct, setScrubPct] = useState<number | null>(null);
  // Playback speed — initialized from localStorage so the user's choice
  // sticks across page loads, and synced with other AudioPlayer
  // instances on the page via a window event.
  const [playbackRate, setPlaybackRate] = useState<number>(() => readStoredRate());

  // Apply the rate to the live audio element. Keep this as its own
  // effect (rather than mutating in the rate setter) so we always
  // re-sync after the audio element gets re-created, e.g. after a
  // voice switch (the `[src]` teardown effect drops audioRef).
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Keep the duration floor in sync with the prop. If the caller
  // upgrades the estimate (e.g. text loads in after the player
  // mounted), bump the floor — but never lower it below what
  // buffered-end has already observed (the timeupdate handler also
  // uses Math.max, so the two sources combine monotonically).
  useEffect(() => {
    if (estimatedDurationSeconds && estimatedDurationSeconds > 0) {
      setEstimatedDuration((cur) => Math.max(cur, estimatedDurationSeconds));
    }
  }, [estimatedDurationSeconds]);

  // Cross-player sync: when one player changes the rate, all players on
  // the page mirror the change. Same broadcast pattern used by
  // VoiceSwitcher for the TTS voice setting.
  useEffect(
    () =>
      onPrimerEvent("audio-rate-changed", (detail) => {
        if (Number.isFinite(detail.rate) && detail.rate !== playbackRate) {
          setPlaybackRate(detail.rate);
        }
      }),
    [playbackRate],
  );

  const cycleRate = useCallback(
    (direction: 1 | -1 = 1) => {
      const idx = PLAYBACK_RATES.indexOf(playbackRate as (typeof PLAYBACK_RATES)[number]);
      // If the current rate isn't on the discrete list (shouldn't
      // happen, but defensively), snap to 1.0×.
      const startIdx = idx === -1 ? PLAYBACK_RATES.indexOf(1.0) : idx;
      const nextIdx = (startIdx + direction + PLAYBACK_RATES.length) % PLAYBACK_RATES.length;
      const next = PLAYBACK_RATES[nextIdx];
      setPlaybackRate(next);
      writeStoredRate(next);
      // Broadcast so other players match. The local setState above
      // doesn't need to listen for its own event (the early-return in
      // the handler skips it).
      dispatchPrimerEvent("audio-rate-changed", { rate: next });
    },
    [playbackRate],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) {
      const el = new Audio(src);
      audioRef.current = el;

      // Apply the user's saved playback rate immediately, before any
      // playback starts. Setting this on the element rather than
      // post-canplay avoids a brief 1.0× burst at the start.
      el.playbackRate = playbackRate;

      el.addEventListener("loadstart", () => setState("loading"));
      el.addEventListener("canplay", () => {
        // During streaming responses (no Content-Length header), duration
        // arrives as `Infinity` until the stream completes. Only treat it as
        // known when it's a finite, positive number.
        const d = el.duration;
        if (Number.isFinite(d) && d > 0) setDuration(d);
        if (initialSeek > 0 && el.currentTime < 1) {
          el.currentTime = initialSeek;
        }
        // Re-assert the rate at canplay time too — some browsers reset
        // it back to 1.0× during the load lifecycle.
        el.playbackRate = playbackRate;
        setState("playing");
        el.play();
      });
      // Fires when the duration value changes — e.g. once the streamed
      // response finishes, the browser knows the true total length and we can
      // render the progress bar fill correctly.
      el.addEventListener("durationchange", () => {
        const d = el.duration;
        if (Number.isFinite(d) && d > 0) setDuration(d);
      });
      el.addEventListener("timeupdate", () => {
        setProgress(el.currentTime);
        onPositionChange?.(el.currentTime);

        // While real duration is unknown, sample `buffered.end(last)`
        // as a live total estimate. `audio.buffered` is a TimeRanges
        // — calling `end(i)` can throw `IndexSizeError` if the index
        // is out of bounds, so we guard with `length > 0`. We only
        // update during the unknown-duration window; once the real
        // duration arrives the deterministic fill takes over.
        if (!Number.isFinite(el.duration) || el.duration <= 0) {
          try {
            if (el.buffered.length > 0) {
              const lastIdx = el.buffered.length - 1;
              const bufEnd = el.buffered.end(lastIdx);
              if (Number.isFinite(bufEnd) && bufEnd > 0) {
                // Bias the estimate slightly above buffered.end so the
                // fill never reads as 100% mid-stream (which would
                // imply "we're done" and feel wrong). 1.05× gives a
                // small headroom that smooths out as more bytes
                // arrive and buffered.end catches up to real total.
                setEstimatedDuration((cur) => Math.max(cur, bufEnd * 1.05));
              }
            }
          } catch {
            // IndexSizeError or similar — ignore, try again on the
            // next tick.
          }
        }
      });
      el.addEventListener("ended", () => {
        setState("idle");
        setProgress(0);
      });
      el.addEventListener("error", () => {
        setState("error");
        // Pull the worker's `X-Audio-Error` header (set by
        // `audioErrorResponse` in services/tts.ts) so we can show
        // the underlying upstream error inline. Best-effort — the
        // browser may have cached an audio response or refuse to
        // re-fetch. If the header isn't present, fall back to the
        // JSON `detail` from the body. Failure of the diagnostic
        // fetch itself is silent.
        void fetch(src, { credentials: "same-origin" })
          .then(async (resp) => {
            const headerMsg = resp.headers.get("X-Audio-Error");
            if (headerMsg) {
              setErrorDetail(headerMsg);
              return;
            }
            const ct = resp.headers.get("content-type") ?? "";
            if (ct.includes("application/json")) {
              try {
                const body = (await resp.json()) as { detail?: string; error?: string };
                if (body.detail) setErrorDetail(body.detail);
                else if (body.error) setErrorDetail(body.error);
              } catch {
                /* fallthrough — leave generic */
              }
            }
          })
          .catch(() => {
            /* leave generic message */
          });
      });
      el.addEventListener("pause", () => {
        if (!el.ended) setState("paused");
      });
      el.addEventListener("play", () => setState("playing"));

      el.load();
      return;
    }

    if (state === "playing") {
      audio.pause();
    } else if (state === "paused") {
      audio.play();
    } else if (state === "idle" || state === "error") {
      audio.currentTime = 0;
      audio.load();
    }
  }, [src, state, playbackRate]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Tear down the audio element when the resolved src changes (e.g. voice override switched).
  // Without this, the next play would keep using the old <audio> element bound to the old URL.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
      setState("idle");
      setProgress(0);
      setDuration(0);
      setEstimatedDuration(0);
      setScrubPct(null);
      setErrorDetail(null);
      setErrorOpen(false);
    }
  }, [src]);

  // Close the error popover on outside click + Escape. Standard
  // dismissal affordances — without these, a user who clicked the
  // info icon to peek at the upstream message has no obvious way
  // to put it back, especially on mobile where there's no Escape
  // key. We only attach when the popover is open so the listeners
  // aren't paying for themselves on every player on the page.
  useEffect(() => {
    if (!errorOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (errorPopoverRef.current && target instanceof Node && !errorPopoverRef.current.contains(target)) {
        setErrorOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setErrorOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [errorOpen]);

  // ─── Scrubbing helpers ───────────────────────────────────────────────

  // Skip ±N seconds. Used by both the skip buttons and the keyboard
  // arrow shortcuts. Clamps to [0, duration] when duration is known;
  // when streaming we still allow forward jumps but the browser may
  // pause until enough buffer arrives.
  const skipBy = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const next = (audio.currentTime ?? 0) + seconds;
      const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
      audio.currentTime = Math.max(0, Math.min(next, max));
      setProgress(audio.currentTime);
    },
    [duration],
  );

  // Convert a pointer-event clientX into a fractional position [0,1]
  // along the track. Returns null when the track ref isn't mounted.
  const pctFromClientX = useCallback((clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const hasKnownDuration = Number.isFinite(duration) && duration > 0;

  // Pointer-down on the track starts a scrub. We capture the pointer so
  // a fast drag that wanders off the bar still keeps tracking — without
  // this, the user has to keep their cursor pixel-precisely inside a
  // 6px-tall bar, which is brutal on touch.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!hasKnownDuration) return; // can't scrub a still-streaming clip
      const pct = pctFromClientX(e.clientX);
      if (pct == null) return;
      e.preventDefault();
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // Some browsers throw if the pointer isn't currently active.
        // Ignore — drag will still work, just without out-of-bounds tracking.
      }
      setScrubPct(pct);
    },
    [hasKnownDuration, pctFromClientX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (scrubPct == null) return;
      const pct = pctFromClientX(e.clientX);
      if (pct == null) return;
      setScrubPct(pct);
    },
    [scrubPct, pctFromClientX],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (scrubPct == null) return;
      const audio = audioRef.current;
      if (audio && hasKnownDuration) {
        audio.currentTime = scrubPct * duration;
        setProgress(audio.currentTime);
      }
      setScrubPct(null);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // Ignore — capture may already have been released.
      }
    },
    [scrubPct, hasKnownDuration, duration],
  );

  const handlePointerCancel = useCallback(() => {
    // Drag was cancelled (e.g. system gesture interrupted). Drop the
    // scrub preview without committing.
    setScrubPct(null);
  }, []);

  // Keyboard scrubbing — `←` / `→` for ±15s, Shift modifier for ±5s
  // (smaller "fine" jumps), Space toggles play/pause, Home/End jump
  // to the start/end of the clip. Only fires when focus is inside the
  // player container, so keyboard shortcuts elsewhere on the page
  // remain unaffected.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          skipBy(-(e.shiftKey ? 5 : SKIP_SECONDS));
          break;
        case "ArrowRight":
          e.preventDefault();
          skipBy(e.shiftKey ? 5 : SKIP_SECONDS);
          break;
        case " ":
        case "Spacebar":
          e.preventDefault();
          toggle();
          break;
        case "Home":
          if (audioRef.current) {
            e.preventDefault();
            audioRef.current.currentTime = 0;
            setProgress(0);
          }
          break;
        case "End":
          if (audioRef.current && hasKnownDuration) {
            e.preventDefault();
            audioRef.current.currentTime = Math.max(0, duration - 0.1);
            setProgress(audioRef.current.currentTime);
          }
          break;
        case "[":
          // Step playback rate down — same key YouTube uses for "slower".
          e.preventDefault();
          cycleRate(-1);
          break;
        case "]":
          // Step playback rate up — same key YouTube uses for "faster".
          e.preventDefault();
          cycleRate(1);
          break;
        default:
        // No action — let other handlers process it.
      }
    },
    [skipBy, toggle, hasKnownDuration, duration, cycleRate],
  );

  const formatTime = (s: number): string => {
    if (!Number.isFinite(s) || s < 0) return "--:--";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  // The denominator we use for the visible fill. Real `duration` if the
  // browser has it; otherwise the buffered-end estimate. Falls back to
  // 0 (which renders the empty-track + leading-dot fallback) before any
  // timeupdate has fired.
  const bestDuration = hasKnownDuration ? duration : estimatedDuration;
  const hasAnyDuration = bestDuration > 0;

  // Visible fill percentage. While dragging we follow the cursor; while
  // playing we show progress against `bestDuration`. Capped at 100% as
  // a defensive guard for the brief moment when `currentTime` can
  // overshoot a stale estimated total.
  const filledPct =
    scrubPct != null && hasKnownDuration
      ? scrubPct * 100
      : hasAnyDuration
        ? Math.min(100, (progress / bestDuration) * 100)
        : 0;
  // The currentTime we *display* (top-right). While dragging we show the
  // scrub target so the user has feedback about where they're about to
  // land before they commit.
  const displayedProgress = scrubPct != null && hasKnownDuration ? scrubPct * duration : progress;

  if (compact && state === "idle") {
    return (
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1.5 font-ui text-xs text-text-dim hover:text-accent transition-colors min-h-[44px]"
        title="Listen to this article"
      >
        <ListenIcon />
        Listen
      </button>
    );
  }

  // Controls are reachable via keyboard once the player container has
  // focus (tabIndex=0). Wrapping in a region role lets screen readers
  // announce it as a discrete control surface.
  //
  // `min-w-0 max-w-full` keeps the player from overflowing constrained
  // parents (e.g. a chat-message bubble in a narrow sidebar). Without
  // this, the sum of `shrink-0` children + the track's min-width was a
  // hard floor that pushed the rate button past the parent's right edge
  // when the bubble was narrower than ~280px.
  return (
    <div
      className="flex items-center gap-2 min-w-0 max-w-full min-h-[44px] focus:outline-none"
      tabIndex={0}
      role="region"
      aria-label="Audio player"
      onKeyDown={handleKeyDown}
    >
      {/* Skip back ─15s */}
      <button
        type="button"
        onClick={() => skipBy(-SKIP_SECONDS)}
        disabled={!audioRef.current || state === "loading"}
        className="shrink-0 flex items-center justify-center h-8 w-8 rounded-full text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title={`Back ${SKIP_SECONDS}s (←)`}
        aria-label={`Skip back ${SKIP_SECONDS} seconds`}
      >
        <SkipBackIcon seconds={SKIP_SECONDS} />
      </button>

      {/* Play / pause */}
      <button
        onClick={toggle}
        disabled={state === "loading"}
        className="shrink-0 flex items-center justify-center h-8 w-8 rounded-full border border-border hover:bg-surface-hover transition-colors disabled:opacity-50"
        title={state === "playing" ? "Pause (Space)" : "Play (Space)"}
        aria-label={state === "playing" ? "Pause" : "Play"}
      >
        {state === "loading" ? (
          <span className="h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        ) : state === "playing" ? (
          <PauseIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      {/* Skip forward +15s */}
      <button
        type="button"
        onClick={() => skipBy(SKIP_SECONDS)}
        disabled={!audioRef.current || state === "loading"}
        className="shrink-0 flex items-center justify-center h-8 w-8 rounded-full text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title={`Forward ${SKIP_SECONDS}s (→)`}
        aria-label={`Skip forward ${SKIP_SECONDS} seconds`}
      >
        <SkipForwardIcon seconds={SKIP_SECONDS} />
      </button>

      {(state !== "idle" || hasAnyDuration) && (
        <>
          {/*
            Outer wrapper holds the pointer handlers and gives the
            click/drag target a generous 26px-tall hit area
            (10 + 6 + 10 = py-2.5 padding around an h-1.5 visible bar).
            The visible track stays thin so the bar reads as a slim
            scrubber, but the user has a much easier time grabbing
            it with mouse, touchpad, or finger.

            Previously the entire interactive zone was the visible
            6px-tall track, and the visible thumb was rendered with
            `pointer-events-none` — clicking on the thumb visually
            passed through to the thin track behind, which made
            scrubbing essentially impossible (you had to aim a 6px-
            tall sliver and miss the larger thumb that looks
            grabbable). The wrapped layout keeps `pointer-events-
            none` on the thumb (no special drag-target needed for it,
            since the wrapper catches the events) but extends the
            grabbable height to ~26px without changing the
            aesthetic.

            `pctFromClientX` resolves position from the wrapper's
            bounding rect; the wrapper's width matches the visible
            track's width (both `w-full` of the same flex column),
            so the percentage math is unchanged.
          */}
          <div
            ref={trackRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            // `min-w-[40px]` lets the track compress in narrow parents
            // (e.g. chat-message bubbles in a sidebar) rather than
            // pushing the rate button + time off-screen. On wider
            // parents `flex-1` claims the available space as before.
            className={`group relative flex-1 min-w-[40px] py-2.5 select-none touch-none ${
              hasKnownDuration ? "cursor-pointer" : "cursor-default"
            }`}
            title={
              hasKnownDuration
                ? "Click or drag to seek (← / → to skip 15s, ⇧ for 5s)"
                : hasAnyDuration
                  ? "Streaming — position is real, total length is still being downloaded"
                  : "Streaming — total length is unknown until the audio finishes downloading"
            }
            role="progressbar"
            aria-valuemin={hasKnownDuration ? 0 : undefined}
            aria-valuemax={hasKnownDuration ? Math.round(duration) : undefined}
            aria-valuenow={hasKnownDuration ? Math.round(displayedProgress) : undefined}
            aria-valuetext={hasKnownDuration ? undefined : "Streaming audio, total length unknown"}
          >
            {/* Visible track — slim bar centered inside the larger
                hit zone. `relative` so the absolute-positioned
                thumb can place itself against this element rather
                than the padded wrapper, which keeps the thumb
                vertically centered on the visible bar regardless of
                the wrapper's padding. */}
            <div className="relative h-1.5 w-full rounded-full bg-surface-active overflow-visible">
              {hasAnyDuration ? (
                <>
                  {/* Fill — proportional to currentTime over
                      `bestDuration`. `bestDuration` is real
                      `duration` when the browser has it, else our
                      buffered.end-derived estimate so the bar
                      advances smoothly during streaming. */}
                  <div
                    className={`h-full rounded-full bg-accent ${
                      scrubPct == null ? "transition-[width] duration-100" : ""
                    } ${
                      // Slight visual softening while we're estimating
                      // — makes the "we don't fully know the total
                      // yet" state subtly distinct from a fully
                      // deterministic bar without being so different
                      // that it looks broken. Snaps to full opacity
                      // once duration is real.
                      hasKnownDuration ? "opacity-100" : "opacity-80"
                    }`}
                    style={{ width: `${filledPct}%` }}
                  />
                  {/* Drag handle — visible thumb at the leading
                      edge of the fill. Grows on hover (via the
                      wrapper's `group` class) and during active
                      drag, so the user has a clear interactive
                      affordance. While only estimated, renders as
                      a hollow ring (border-only) instead of a
                      solid dot so the user can tell the bar is
                      informational rather than seekable. */}
                  <div
                    style={{ left: `${filledPct}%` }}
                    className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg shadow-sm transition-all ${
                      scrubPct != null ? "h-4 w-4" : "h-3 w-3 group-hover:h-4 group-hover:w-4"
                    } ${hasKnownDuration ? "bg-accent" : "bg-bg border-2 border-accent"}`}
                  />
                </>
              ) : (
                // Pre-first-timeupdate fallback — we don't have any
                // duration estimate yet, so neither real nor
                // buffered.end is informative. Render a quiet pulsing
                // dot at the start until the first timeupdate
                // arrives (usually within ~250ms of canplay). After
                // that, `hasAnyDuration` becomes true and the
                // deterministic-against-best-estimate bar takes
                // over.
                <div className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-accent/80 ring-2 ring-bg animate-pulse" />
              )}
            </div>
          </div>
          <span className="font-mono text-[10px] text-text-faint tabular-nums shrink-0 w-[70px] text-right">
            {formatTime(displayedProgress)}
            {hasKnownDuration ? ` / ${formatTime(duration)}` : ""}
          </span>

          {/*
            Playback-rate toggle. Click to cycle through PLAYBACK_RATES,
            shift-click (or right-click) to cycle backward. The rate
            persists in localStorage and is mirrored across all audio
            players on the page via a window event, so picking 1.5× on
            one teaching piece carries to chat replies and the next
            briefing without re-toggling.
          */}
          <button
            type="button"
            onClick={(e) => cycleRate(e.shiftKey ? -1 : 1)}
            onContextMenu={(e) => {
              e.preventDefault();
              cycleRate(-1);
            }}
            className={`shrink-0 inline-flex items-center justify-center min-w-[36px] h-6 rounded-md px-1.5 font-mono text-[10px] font-semibold tabular-nums transition-colors ${
              playbackRate === 1
                ? "text-text-dim hover:text-text-primary hover:bg-surface-hover"
                : "text-accent bg-accent-dim hover:bg-accent/20"
            }`}
            title={`Playback speed: ${formatRate(playbackRate)}. Click to cycle (Shift-click for slower, ] / [ when focused).`}
            aria-label={`Playback speed, currently ${formatRate(playbackRate)}. Click to change.`}
          >
            {formatRate(playbackRate)}
          </button>
        </>
      )}

      {state === "error" && (
        <div ref={errorPopoverRef} className="relative shrink-0">
          {/*
            Trigger — "Audio unavailable" with a small info circle to
            signal the popover affordance. Inline mono-text detail
            from the previous design got truncated in narrow chat
            bubbles and was easy to miss; the icon + click pattern
            keeps the row uncluttered while making the detail
            discoverable. `aria-haspopup` + `aria-expanded` mark this
            as a popover trigger for assistive tech.
          */}
          <button
            type="button"
            onClick={() => setErrorOpen((v) => !v)}
            className="inline-flex items-center gap-1 font-ui text-[10px] text-negative hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-negative rounded"
            aria-haspopup="dialog"
            aria-expanded={errorOpen}
            title="Show error details"
          >
            <span>Audio unavailable</span>
            <InfoCircleIcon />
          </button>
          {errorOpen && (
            <div
              role="dialog"
              aria-label="Audio playback error details"
              className="absolute right-0 bottom-full mb-2 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface p-3 shadow-lg"
            >
              <div className="font-ui text-xs font-semibold text-text-primary mb-1.5">Couldn't play audio</div>
              {errorDetail ? (
                <div className="font-mono text-[10px] text-text-secondary whitespace-pre-wrap break-words leading-snug max-h-40 overflow-y-auto">
                  {errorDetail}
                </div>
              ) : (
                /*
                  Fallback when the diagnostic fetch couldn't recover
                  an upstream message. This usually means the audio
                  request errored before a worker response was built
                  (network failure, browser audio decode error on a
                  cached partial response, etc.) — common-cause
                  troubleshooting copy is the most useful thing we
                  can show.
                */
                <div className="font-ui text-[11px] text-text-secondary leading-snug space-y-1.5">
                  <p>The audio service didn't return a clear error.</p>
                  <p>Common causes:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-text-dim">
                    <li>Provider API key missing or invalid</li>
                    <li>Voice not enabled on your provider account</li>
                    <li>Provider rate limit or concurrency cap</li>
                  </ul>
                  <p className="text-text-dim">Try a different voice in Settings, or retry in a moment.</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ListenIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 5v6l4 3V2L3 5z" />
      <path d="M10 5.5a3 3 0 010 5" />
      <path d="M12 3.5a6 6 0 010 9" />
    </svg>
  );
}

function InfoCircleIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.25v3.5" />
      <circle cx="8" cy="5" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="text-text-primary ml-0.5">
      <path d="M2 1l9 5-9 5V1z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="text-text-primary">
      <rect x="2" y="1" width="3" height="10" rx="0.5" />
      <rect x="7" y="1" width="3" height="10" rx="0.5" />
    </svg>
  );
}

// "↶ 15" — a circular arrow with the seconds count tucked inside.
function SkipBackIcon({ seconds }: { seconds: number }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4v5h5" />
      <path d="M3.51 9A9 9 0 1 0 6 5.4L3 9" />
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        stroke="none"
        fill="currentColor"
      >
        {seconds}
      </text>
    </svg>
  );
}

// "15 ↷" — mirror of SkipBackIcon.
function SkipForwardIcon({ seconds }: { seconds: number }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 4v5h-5" />
      <path d="M20.49 9A9 9 0 1 1 18 5.4L21 9" />
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        stroke="none"
        fill="currentColor"
      >
        {seconds}
      </text>
    </svg>
  );
}
