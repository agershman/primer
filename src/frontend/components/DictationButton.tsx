import { useCallback, useEffect, useRef, useState } from "react";

interface DictationButtonProps {
  /** Called for each finalized utterance — append to your text state. */
  onTranscript: (text: string) => void;
  /**
   * When true, listening behaves like the voice mode in AI mobile apps:
   * the user taps to start, talks freely (with pauses), and taps again to
   * stop. Under the hood we work around the fact that mobile / Chromium
   * `webkitSpeechRecognition` aggressively auto-ends after a short silence
   * by transparently restarting the recognizer so the perceived session
   * stays open until the user explicitly stops it (or until the optional
   * `idleTimeoutMs` of pure silence elapses). Defaults to `false` (one-shot
   * recognition, the Web Speech API default).
   */
  continuous?: boolean;
  /**
   * Optional live-preview callback — fired with the partial (not-yet-final)
   * transcript while the user is still speaking. Use this to render an
   * inline "you're saying…" hint in your textarea so the user can see what
   * the recognizer is hearing in real time. Empty string means "no current
   * interim text" (fired when the previous interim has been finalized or
   * when the recognizer just restarted between utterances).
   * Implies `interimResults: true` on the underlying recognizer.
   */
  onInterim?: (text: string) => void;
  /**
   * Optional callback fired when listening starts/stops. Lets parent
   * components show different UI (e.g. mark a textarea as read-only while
   * dictation is in progress, since user typing would conflict with the
   * live transcript).
   */
  onListeningChange?: (listening: boolean) => void;
  /**
   * In `continuous` mode, how many milliseconds of *no actual speech*
   * (no `onresult` callbacks coming back from the recognizer) we will
   * keep the session open before auto-stopping. The default of 5s is
   * tuned for "the user has finished their thought and stopped
   * talking" — long enough to think briefly between sentences, short
   * enough to feel responsive. Set to `0` to disable the timeout
   * (only the user's tap will stop listening).
   *
   * The timer is bumped *only* on `onresult` (real speech detected),
   * never on lifecycle events like `onstart` / `onaudiostart`. Without
   * that constraint the watchdog never fires in continuous mode,
   * because the browser silence-detector aggressively auto-ends the
   * recognizer every 1–2 seconds during quiet stretches and we
   * transparently restart it — each restart re-fires the lifecycle
   * events and would reset the timer indefinitely.
   */
  idleTimeoutMs?: number;
  append?: boolean;
  className?: string;
}

// Web Speech API types aren't in the default DOM lib (still
// experimental in lib.dom.d.ts as of TS 5.x), so we declare the
// minimal surface we actually use rather than reaching for `any`.
// Documenting only what this component touches is a deliberate
// scope-limit — adding fields later is cheap, and keeping the
// shape narrow prevents accidental coupling to browser-specific
// quirks.
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}

interface SpeechRecognitionResult extends ArrayLike<SpeechRecognitionAlternative> {
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

// `webkitSpeechRecognition` is the Safari / Chrome legacy path; the
// unprefixed `SpeechRecognition` is the standard. Feature-detect at
// module load so the surrounding `if (!SpeechRecognitionImpl)` early
// return keeps the rest of the component pure.
const SpeechRecognitionImpl: SpeechRecognitionConstructor | undefined =
  typeof window !== "undefined"
    ? ((
        window as unknown as {
          SpeechRecognition?: SpeechRecognitionConstructor;
          webkitSpeechRecognition?: SpeechRecognitionConstructor;
        }
      ).SpeechRecognition ??
      (
        window as unknown as {
          webkitSpeechRecognition?: SpeechRecognitionConstructor;
        }
      ).webkitSpeechRecognition)
    : undefined;

// Errors that mean "the recognizer ran out of audio for a moment" rather
// than "something is broken". For these we want to silently restart in
// continuous mode rather than tear the session down.
const TRANSIENT_ERRORS = new Set(["no-speech", "aborted", "audio-capture"]);

/**
 * Return the portion of `newTranscript` that hasn't already been emitted
 * to the parent in this dictation session, given the accumulated text
 * we've emitted so far (`sessionText`, space-joined the same way the
 * parent appends to its textarea).
 *
 * Designed to defang Android Chrome's cumulative-final bug where the
 * same utterance gets emitted N times with growing transcripts. Three
 * cases:
 *
 *  1. Exact-tail duplicate — sessionText ends with newTranscript (the
 *     same final replayed): return "" (nothing to emit).
 *  2. Prefix-extension — newTranscript starts with sessionText (the
 *     utterance grew): return only the trailing remainder.
 *  3. Word-boundary overlap — sessionText's suffix matches
 *     newTranscript's prefix on a word boundary (e.g. "...of single"
 *     followed by "single tenancy"): return the non-overlapping
 *     remainder.
 *  4. Otherwise: return the whole transcript as-is (new content, no
 *     overlap to strip).
 *
 * Word-boundary alignment in case 3 is important: matching on raw
 * character substrings can produce false positives on short common
 * suffixes ("a", "the", "in"). Requiring the overlap to start at a
 * word boundary keeps real speech from being chewed.
 *
 * Exported for testing.
 */
export function dedupeAgainstSession(sessionText: string, newTranscript: string): string {
  const next = newTranscript.trim();
  if (!next) return "";
  const prev = sessionText.trim();
  if (!prev) return next;

  // Case 1: exact-tail duplicate.
  if (prev === next || prev.endsWith(` ${next}`)) return "";

  // Case 2: prefix-extension at a word boundary. Require `prev` to be at
  // least 3 chars and the prefix match to end on whitespace in `next`, so
  // we don't strip "Cind" out of "Cinders" or "I" out of "I really like".
  if (prev.length >= 3 && next.startsWith(`${prev} `)) {
    return next.slice(prev.length + 1).trimStart();
  }

  // Case 3: word-boundary overlap. Walk possible overlap lengths from
  // the longest plausible down, and accept only if the overlap starts
  // at a word boundary in prev (i.e. preceded by whitespace or at the
  // string start) AND ends at a word boundary in next (i.e. followed
  // by whitespace or at the string end).
  const maxOverlap = Math.min(prev.length, next.length);
  for (let len = maxOverlap; len > 0; len--) {
    const tail = prev.slice(-len);
    if (tail !== next.slice(0, len)) continue;
    const boundaryBefore = prev.length === len || /\s/.test(prev[prev.length - len - 1] ?? "");
    const boundaryAfter = next.length === len || /\s/.test(next[len] ?? "");
    if (boundaryBefore && boundaryAfter) {
      const remainder = next.slice(len).trimStart();
      // Avoid stripping single-character or single-letter overlaps that
      // are more likely coincidence than the cumulative-final bug.
      if (len >= 3) return remainder;
    }
  }

  return next;
}

export function DictationButton({
  onTranscript,
  continuous = false,
  onInterim,
  onListeningChange,
  idleTimeoutMs = 5_000,
  className,
}: DictationButtonProps) {
  // ───── Hooks first — must be unconditional to satisfy rules of hooks ─────
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // True once the user has explicitly tapped stop. We use this in the
  // recognizer's onend callback to decide whether to silently restart the
  // session (continuous mode, browser auto-ended on silence) or actually
  // tear it down (user-initiated stop).
  const userStoppedRef = useRef(false);
  // Backoff for restart retries — guards against tight loops if the browser
  // refuses to (re)start immediately after stopping.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Idle watchdog — bumped every time the recognizer hands us new audio.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Concatenation of every final transcript we've actually emitted to the
  // parent during this dictation session. Mirrors how the parent joins
  // emissions (space-separated). Used to dedupe cumulative-final emissions
  // from mobile Chrome — see the long comment in `onresult`. Survives
  // auto-restarts within a session; reset to "" each time the user taps
  // mic to begin a fresh session.
  const sessionEmittedTextRef = useRef("");

  // Notify parent when listening state changes so it can update UI (e.g.
  // make a textarea read-only). Wrapped so the closure in `toggle` doesn't
  // need it as a dependency.
  const onListeningChangeRef = useRef(onListeningChange);
  onListeningChangeRef.current = onListeningChange;
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;

  const setListeningWithCallback = useCallback((next: boolean) => {
    setListening(next);
    onListeningChangeRef.current?.(next);
    if (!next) onInterimRef.current?.("");
  }, []);

  const clearTimers = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const stopRecognition = useCallback(() => {
    userStoppedRef.current = true;
    clearTimers();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped — ignore.
      }
    }
    setListeningWithCallback(false);
  }, [clearTimers, setListeningWithCallback]);

  // Start (or restart) a recognition session. Each restart uses a fresh
  // SpeechRecognition instance because some browsers won't let you reuse
  // an instance after `onend` fires.
  const startRecognition = useCallback(() => {
    if (!SpeechRecognitionImpl) return;
    if (userStoppedRef.current) return;

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = continuous;
    recognition.interimResults = !!onInterimRef.current;
    recognition.lang = "en-US";

    const bumpIdleTimer = () => {
      if (!continuous || idleTimeoutMs <= 0) return;
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        // N seconds of zero speech detected. Treat it as "the user has
        // finished their thought" and stop cleanly so they can submit
        // (quiz) or send (chat) without a second tap on the mic.
        stopRecognition();
      }, idleTimeoutMs);
    };

    // Note: we deliberately do NOT bump on `onstart` / `onaudiostart`.
    // Those fire on every silence-driven auto-restart in continuous
    // mode, and bumping there would prevent the watchdog from ever
    // firing during long stretches of silence (the original bug).
    // We only bump on actual speech events (`onresult`).

    // Two layers of dedup defend against Android Chrome's
    // `continuous: true` + `interimResults: true` misbehaviour, which
    // produces the textarea-fills-with-duplicates bug:
    //   "Cinders Cinders Cinders implementation Cinders implementation
    //    of single single tenancy"
    //
    // What the buggy browser does:
    //  (a) Re-emits already-finalized results in subsequent `onresult`
    //      events without advancing `event.resultIndex` — trusting
    //      `resultIndex` alone replays old results.
    //  (b) Emits each chunk of the same utterance as a new final whose
    //      `transcript` contains everything said so far — so the second
    //      final is "Cinders implementation", the third is "Cinders
    //      implementation of single", etc. The result indices keep
    //      growing, so index-based dedup doesn't catch this; only
    //      content-based dedup does.
    //
    // Layer 1 (per-recognizer index dedup) handles (a): walk all
    // results and only emit indices we haven't seen finalised in this
    // recognizer instance.
    // Layer 2 (session-level text-overlap dedup) handles (b): track
    // every final transcript we've actually emitted across the whole
    // dictation session (including auto-restarts), and when a new
    // final shares a suffix-of-emitted / prefix-of-new overlap, emit
    // only the non-overlapping remainder. The session ref is reset by
    // `toggle()` at the start of each fresh mic tap, so previous
    // dictations don't leak across sessions.
    let lastEmittedFinalIndex = -1;

    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      bumpIdleTimer();
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (!transcript) continue;
        if (result.isFinal) {
          if (i <= lastEmittedFinalIndex) continue;
          lastEmittedFinalIndex = i;
          const remainder = dedupeAgainstSession(sessionEmittedTextRef.current, transcript);
          if (!remainder) continue;
          onTranscriptRef.current?.(remainder);
          sessionEmittedTextRef.current = sessionEmittedTextRef.current
            ? `${sessionEmittedTextRef.current} ${remainder}`
            : remainder;
        } else {
          interim += (interim ? " " : "") + transcript;
        }
      }
      onInterimRef.current?.(interim);
    };

    recognition.onerror = (event: { error: string; message?: string }) => {
      const errorCode = event?.error;
      // Transient: don't tear down — let onend trigger a restart.
      if (continuous && TRANSIENT_ERRORS.has(errorCode)) return;
      // Hard error (network, not-allowed, service-not-allowed, etc.):
      // give up cleanly.
      stopRecognition();
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      // If the user hasn't tapped stop, the browser auto-ended due to a
      // silence pause. In continuous mode we silently restart to give the
      // user the AI-voice-mode experience of one sustained session.
      if (continuous && !userStoppedRef.current) {
        // Tiny delay so the browser fully releases the microphone before
        // we ask for it again. Without this, some Chromium versions throw
        // `InvalidStateError: recognition has already started`.
        if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          restartTimerRef.current = null;
          if (!userStoppedRef.current) startRecognition();
        }, 250);
        return;
      }
      clearTimers();
      setListeningWithCallback(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // If start throws (e.g. already started), schedule a retry.
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        restartTimerRef.current = null;
        if (!userStoppedRef.current) startRecognition();
      }, 250);
    }
    // The idle watchdog is armed in `toggle` (the user-initiated entry
    // point), NOT here. Calling `bumpIdleTimer` here would reset the
    // clock on every auto-restart in continuous mode, which is the
    // exact bug we're trying to avoid: silence-driven auto-restarts
    // happen every 1–2 seconds during quiet stretches, and resetting
    // the timer on each one prevents the watchdog from ever firing.
    // Once `toggle` arms it, the timer keeps running across restarts
    // (we never clear it during restart) and only resets on real
    // speech via `onresult` → `bumpIdleTimer`.
  }, [continuous, idleTimeoutMs, stopRecognition, setListeningWithCallback, clearTimers]);

  // Arm the idle watchdog from outside `startRecognition` so the
  // initial timer survives auto-restarts. Defined as a separate
  // callback (not inline in `toggle`) so it has access to the same
  // `idleTimerRef` used inside `startRecognition`.
  const armIdleTimer = useCallback(() => {
    if (!continuous || idleTimeoutMs <= 0) return;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      stopRecognition();
    }, idleTimeoutMs);
  }, [continuous, idleTimeoutMs, stopRecognition]);

  const toggle = useCallback(() => {
    if (!SpeechRecognitionImpl) return;
    if (listening) {
      stopRecognition();
      return;
    }
    userStoppedRef.current = false;
    // Fresh session — reset the cumulative-final dedup tracker so previous
    // dictations don't leak overlap matches into this one.
    sessionEmittedTextRef.current = "";
    setListeningWithCallback(true);
    startRecognition();
    // Arm the idle watchdog once at the user-initiated start. The
    // timer survives subsequent auto-restarts (we never clear it
    // during restart) and only resets when actual speech comes back
    // via `onresult` → `bumpIdleTimer`. So the full lifecycle is:
    //   tap mic → arm 5s timer
    //   user talks → onresult → reset 5s timer
    //   silence for 5s → timer fires → stopRecognition → done
    armIdleTimer();
  }, [listening, startRecognition, stopRecognition, setListeningWithCallback, armIdleTimer]);

  useEffect(() => {
    return () => {
      userStoppedRef.current = true;
      clearTimers();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // Ignore — recognizer is already in a terminal state.
        }
      }
    };
  }, [clearTimers]);

  // Escape stops the mic. Attached at `window` level so it works
  // regardless of which element has focus (the textarea, the button,
  // or anything else the user may have tabbed to).
  //
  // Capture phase + `stopImmediatePropagation` is deliberate: many
  // surrounding surfaces (settings modal, chat panel, focus editor)
  // also listen for Escape to dismiss themselves. Without this, one
  // Escape would both stop the mic AND close the panel the user was
  // dictating into, losing their context. With it, Escape stops the
  // mic *only* — a second Escape (now that we're not listening, our
  // listener is detached) closes the panel as usual. That's the
  // right "back out one level at a time" behavior.
  //
  // The listener is only attached while `listening` is true, so it
  // never interferes with other Escape handlers when dictation is
  // off.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Don't swallow Escape during IME composition — that's the
      // user dismissing the candidate window, not stopping the mic.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stopRecognition();
    };
    // `true` = useCapture: run before bubble-phase handlers so we
    // get first dibs on Escape.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, stopRecognition]);

  // ───── Render — early returns are safe past this point ─────
  // Browser doesn't support Web Speech API: render nothing.
  if (!SpeechRecognitionImpl) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      className={`shrink-0 flex items-center justify-center rounded-md transition-colors ${
        listening ? "text-negative bg-negative-dim" : "text-text-dim hover:text-accent hover:bg-accent-dim"
      } ${className ?? "h-8 w-8"}`}
      title={listening ? "Stop dictation (Esc)" : "Dictate"}
      aria-label={listening ? "Stop dictation (press Escape)" : "Start dictation"}
    >
      {listening ? (
        <span className="relative flex items-center justify-center">
          <span className="absolute h-3.5 w-3.5 rounded-full bg-negative/30 animate-ping" />
          <MicIcon filled />
        </span>
      ) : (
        <MicIcon />
      )}
    </button>
  );
}

function MicIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="1" width="6" height="9" rx="3" />
      <path d="M3 7a5 5 0 0010 0" />
      <line x1="8" y1="12" x2="8" y2="15" />
      <line x1="5" y1="15" x2="11" y2="15" />
    </svg>
  );
}
