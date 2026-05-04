import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AudioPlayer } from "../components/AudioPlayer";
import { ConfidenceBadge } from "../components/ConfidenceBadge";
import { DepthIndicator } from "../components/DepthIndicator";
import { ResourceList } from "../components/ResourceList";
import { RichText } from "../components/RichText";
import { VoiceSwitcher } from "../components/VoiceSwitcher";
import { useBookmarks } from "../hooks/useBookmarks";
import { AdminOnly } from "../hooks/useCurrentUser";
import { onPrimerEvent } from "../lib/events";
import type { ContentBlock, Resource, TeachingPieceData } from "../types";
import { apiGet } from "../utils/api";
import { contentBlocksToSpokenText, estimateTtsDurationSeconds } from "../utils/audioEstimate";

interface DeepDiveData {
  content?: ContentBlock[];
  readTime?: number | null;
  resources?: Resource[];
  status: "ready" | "generating" | "error";
  error?: string;
  /** ISO timestamp the server stamped when generation started — comes
   *  from the in-progress notification's `created_at`. Used by the
   *  loading-state stage indicator to anchor its elapsed-time counter
   *  on real wall-clock progress, so navigating away and back
   *  mid-generation jumps to the correct stage instead of restarting
   *  at "Analyzing the teaching piece…". */
  startedAt?: string;
}

interface DeepDiveViewProps {
  piece: TeachingPieceData;
  briefingDate: string;
}

export function DeepDiveView({ piece, briefingDate }: DeepDiveViewProps) {
  const [deepDive, setDeepDive] = useState<DeepDiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const { saveBookmark, getBookmark } = useBookmarks();
  const [bookmarkedBlock, setBookmarkedBlock] = useState<number | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  useEffect(
    () =>
      onPrimerEvent("tts-voice-changed", (detail) => {
        if (!detail.voiceId) return;
        // Ignore picks scoped to a different surface (chat, teaching piece) so the
        // deep-dive player doesn't reload audio when the user changes the chat voice.
        if (detail.surface && detail.surface !== "deepDive") return;
        setVoiceId(detail.voiceId);
      }),
    [],
  );

  useEffect(() => {
    getBookmark(piece.id).then((b) => {
      if (b && b.scrollPosition > 0) {
        setBookmarkedBlock(Math.round(b.scrollPosition));
      }
    });
  }, [piece.id, getBookmark]);

  const handleBookmarkBlock = useCallback(
    (blockIndex: number) => {
      if (bookmarkedBlock === blockIndex) {
        setBookmarkedBlock(null);
        saveBookmark(piece.id, { type: "reading", scrollPosition: 0 });
      } else {
        setBookmarkedBlock(blockIndex);
        saveBookmark(piece.id, { type: "saved", scrollPosition: blockIndex });
      }
    },
    [bookmarkedBlock, piece.id, saveBookmark],
  );

  useEffect(() => {
    let cancelled = false;
    let pollHandle: ReturnType<typeof setTimeout> | null = null;
    const fetchDeepDive = async () => {
      try {
        const data = await apiGet<DeepDiveData>(`/api/piece/${piece.id}/deep-dive`);
        if (cancelled) return;
        setDeepDive(data);
        // The first response tells us where we are; only flip
        // `loading` off so the render branch can switch from
        // "initial fetch" to "generating" / "ready" / "error".
        // The actual loading indicator is keyed off
        // `data.status === "generating"` so it stays visible
        // through every poll until generation finishes.
        setLoading(false);
        if (data.status === "generating") {
          pollHandle = setTimeout(fetchDeepDive, 3000);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    fetchDeepDive();
    return () => {
      cancelled = true;
      if (pollHandle) clearTimeout(pollHandle);
    };
  }, [piece.id]);

  return (
    <div className="animate-fade-in">
      <Link
        to={`/briefing/${briefingDate}`}
        className="inline-flex items-center font-ui text-xs text-text-faint hover:text-text-dim transition-colors no-underline mb-6 min-h-[44px]"
      >
        ← Back to briefing
      </Link>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-2">
        {piece.source_ref && (
          <>
            <span className="font-ui text-[10px] text-text-dim">{piece.source_ref}</span>
            <span className="text-text-faint">·</span>
          </>
        )}
        <span className="font-ui text-[10px] text-text-faint">
          {deepDive?.readTime ?? piece.read_time_minutes} min read
        </span>
      </div>

      <h1 className="font-display text-2xl sm:text-3xl font-medium text-text-primary mb-4 leading-snug">
        {piece.title}
      </h1>

      {deepDive?.content && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <AudioPlayer
            src={`/api/piece/${piece.id}/deep-dive/audio`}
            voiceId={voiceId}
            compact
            // Once the deep-dive content is loaded, estimate the
            // duration from the spoken-text length so the bar
            // fills proportionally to real elapsed time. The
            // worker also adds a title prefix and a sign-off
            // outro server-side; the chars-per-second constant
            // has enough headroom to absorb the difference.
            estimatedDurationSeconds={
              deepDive?.content
                ? estimateTtsDurationSeconds(`${piece.title}\n\n${contentBlocksToSpokenText(deepDive.content)}`)
                : undefined
            }
          />
          <AdminOnly>
            <VoiceSwitcher currentVoiceId={voiceId} onChange={setVoiceId} surface="deepDive" />
          </AdminOnly>
        </div>
      )}

      {piece.resources.length > 0 && (
        <div className="mb-6">
          <ResourceList resources={piece.resources} />
        </div>
      )}

      {/* Loading indicator covers two phases: the initial fetch (when
          we don't know yet whether it's ready, generating, or error)
          AND the polling phase while generation runs server-side.
          Anchored on `deepDive.startedAt` so re-mounting (e.g. after
          navigating away and back) jumps to the correct stage rather
          than re-starting at "Analyzing…". */}
      {(loading || deepDive?.status === "generating") && <DeepDiveLoadingState startedAt={deepDive?.startedAt} />}

      {deepDive?.status === "error" && (
        <div className="rounded-lg border border-negative-dim bg-negative-dim/30 px-4 py-3 mb-6">
          <p className="font-ui text-sm text-text-primary mb-1">Deep dive generation failed</p>
          <p className="font-ui text-xs text-text-dim">{deepDive.error ?? "Please try again."}</p>
        </div>
      )}

      {deepDive?.content && deepDive.status === "ready" && (
        <div className="mb-8">
          <RichText blocks={deepDive.content} bookmarkedBlock={bookmarkedBlock} onBookmarkBlock={handleBookmarkBlock} />
        </div>
      )}

      {piece.concepts.length > 0 && (
        <div className="mb-6">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-3">Concepts</p>
          <div className="flex flex-wrap gap-3">
            {piece.concepts.map((concept, i) => (
              // Defensive key — older pieces can carry empty / duplicate
              // concept ids when the briefing pipeline lost a graph
              // match (adjacent-source candidates with no graph hit
              // fall through with conceptId=""). Index suffix tiebreaks
              // so React doesn't warn about duplicate keys. Same shape
              // as TeachingPiece — keep them in sync.
              <div key={`${concept.id || "concept"}-${i}`} className="flex items-center gap-2">
                <span className="font-ui text-xs text-text-secondary">{concept.name}</span>
                <DepthIndicator depth={concept.depth} />
                <ConfidenceBadge confidence={concept.confidence} />
              </div>
            ))}
          </div>
        </div>
      )}

      {deepDive?.resources && deepDive.resources.length > 0 && (
        <div className="pt-6 border-t border-border-subtle">
          <p className="font-ui text-[10px] font-semibold uppercase tracking-wider text-text-dim mb-3">Resources</p>
          <ResourceList resources={deepDive.resources} />
        </div>
      )}
    </div>
  );
}

/**
 * Progress indicator shown while a deep dive is generating server-side.
 *
 * The stage indicator is *time-anchored*: each stage has an `at`
 * (seconds since generation started) and the active stage is the
 * latest one whose threshold has been crossed. When the parent
 * passes a `startedAt` ISO timestamp (handed back by the server
 * from the in-progress notification's created_at), the elapsed
 * counter starts from `now - startedAt` instead of zero — so a user
 * who navigates back to the page mid-generation jumps straight to
 * the correct stage instead of restarting at "Analyzing…".
 *
 * If `startedAt` is missing (initial click on a fresh page, server
 * round-trip race), elapsed starts at 0 and the stages cycle as
 * normal. The visible counter then reflects local elapsed seconds.
 */
function DeepDiveLoadingState({ startedAt }: { startedAt?: string }) {
  const initialElapsed = startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
  const [elapsed, setElapsed] = useState(initialElapsed);
  useEffect(() => {
    const id = setInterval(() => {
      // Recompute from `startedAt` on every tick when we have it,
      // so the displayed elapsed is robust to background-tab
      // throttling (Chrome can starve setInterval to 1Hz when the
      // tab is hidden, drifting from real time).
      if (startedAt) {
        setElapsed(Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)));
      } else {
        setElapsed((e) => e + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const stages = [
    { at: 0, label: "Analyzing the teaching piece and your concept depth…" },
    { at: 3, label: "Researching extended examples and real-world case studies…" },
    { at: 8, label: "Writing the deep dive (800–1,500 words)…" },
    { at: 18, label: "Generating resource links and visual aide suggestions…" },
    { at: 30, label: "Finalizing — almost done…" },
  ];

  const current = [...stages].reverse().find((s) => elapsed >= s.at) ?? stages[0];

  return (
    <div className="rounded-lg border border-border-subtle p-6 my-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-5 w-5 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
        <p className="font-display text-base text-text-primary">Generating deep dive</p>
        {elapsed > 1 && <span className="font-mono text-xs text-text-faint tabular-nums">{elapsed}s</span>}
      </div>
      <p className="font-ui text-sm text-text-dim mb-4">{current.label}</p>
      <div className="flex gap-1">
        {stages.map((s, i) => {
          const done = elapsed >= (stages[i + 1]?.at ?? 999);
          const active = elapsed >= s.at && !done;
          return (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                done ? "bg-positive" : active ? "bg-accent animate-pulse" : "bg-surface-active"
              }`}
            />
          );
        })}
      </div>
    </div>
  );
}
