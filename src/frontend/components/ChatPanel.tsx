import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatThread, UseChatResult } from "../hooks/useChat";
import { AdminOnly } from "../hooks/useCurrentUser";
import type { AvailableModel } from "../hooks/useSettings";
import { onPrimerEvent } from "../lib/events";
import { apiGet } from "../utils/api";
import { estimateTtsDurationSeconds } from "../utils/audioEstimate";
import { AudioPlayer } from "./AudioPlayer";
import { DictationButton } from "./DictationButton";
import { VoiceSwitcher } from "./VoiceSwitcher";

interface ChatPanelProps {
  chat: UseChatResult;
  onClose: () => void;
}

interface ModelsResponse {
  models: AvailableModel[];
  defaults: Record<string, string>;
}

// Provider order for the chat model picker. Matches the order used by
// the Settings → AI models picker so users see a consistent grouping
// across both surfaces. Empty groups (no models for that provider —
// usually because the API key isn't set, so /api/models filtered them
// out) are skipped at render time so absent providers don't leave
// orphan headers in the popover.
const CHAT_PROVIDER_ORDER = ["anthropic", "openai", "google", "workers-ai", "openrouter"] as const;

const CHAT_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "workers-ai": "Cloudflare Workers AI",
  openrouter: "OpenRouter",
};

// ── Inline markdown parser (standard **bold**, *italic*, `code`, [text](url)) ──

function parseMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
    const codeMatch = remaining.match(/`([^`]+)`/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);

    const candidates: Array<{ index: number; length: number; node: ReactNode }> = [];

    if (boldMatch?.index !== undefined) {
      candidates.push({
        index: boldMatch.index,
        length: boldMatch[0].length,
        node: (
          <strong key={key++} className="font-semibold">
            {boldMatch[1]}
          </strong>
        ),
      });
    }
    if (italicMatch?.index !== undefined) {
      candidates.push({
        index: italicMatch.index,
        length: italicMatch[0].length,
        node: <em key={key++}>{italicMatch[1]}</em>,
      });
    }
    if (codeMatch?.index !== undefined) {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        node: (
          <code key={key++} className="font-mono text-accent bg-accent-dim rounded px-1 py-0.5 text-[0.85em]">
            {codeMatch[1]}
          </code>
        ),
      });
    }
    if (linkMatch?.index !== undefined) {
      candidates.push({
        index: linkMatch.index,
        length: linkMatch[0].length,
        node: (
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:text-link-hover underline"
          >
            {linkMatch[1]}
          </a>
        ),
      });
    }

    if (candidates.length === 0) {
      parts.push(remaining);
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const winner = candidates[0];

    if (winner.index > 0) {
      parts.push(remaining.slice(0, winner.index));
    }
    parts.push(winner.node);
    remaining = remaining.slice(winner.index + winner.length);
  }

  return parts;
}

interface ParsedSegment {
  type: "text" | "code";
  content: string;
  language?: string;
}

function extractFencedBlocks(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const fenceRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", content: match[2].trim(), language: match[1] || undefined });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

function MarkdownText({ content }: { content: string }) {
  const segments = extractFencedBlocks(content);

  return (
    <>
      {segments.map((seg, si) => {
        if (seg.type === "code") {
          const isMermaid = seg.language === "mermaid";
          return (
            <div key={si} className="my-2 rounded-lg border border-border-subtle bg-surface overflow-hidden">
              {seg.language && (
                <div className="px-3 py-1 border-b border-border-subtle bg-bg-warm">
                  <span className="font-mono text-[10px] text-text-dim">{isMermaid ? "diagram" : seg.language}</span>
                </div>
              )}
              <pre className="px-3 py-2 overflow-x-auto">
                <code className="font-mono text-xs text-text-primary leading-relaxed">{seg.content}</code>
              </pre>
            </div>
          );
        }

        const paragraphs = seg.content.split(/\n{2,}/);
        return paragraphs.map((p, pi) => {
          if (!p.trim()) return null;
          const lines = p.split("\n");
          return (
            <p key={`${si}-${pi}`} className="mb-1.5 last:mb-0">
              {lines.map((line, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {parseMarkdown(line)}
                </span>
              ))}
            </p>
          );
        });
      })}
    </>
  );
}

// ── Typing / streaming indicators ──

function TypingDots() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-text-dim animate-bounce"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}

function ToolIndicator({ tool }: { tool: string }) {
  const label = tool === "search_web" ? "Searching…" : tool === "lookup_primer_data" ? "Looking up data…" : "Thinking…";
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-text-dim">
      <span className="relative inline-flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
      {label}
    </div>
  );
}

function StreamingCursor() {
  return <span className="inline-block w-[2px] h-[1em] bg-text-primary animate-pulse ml-0.5 align-text-bottom" />;
}

// ── Thread picker ──

function ThreadPicker({
  threads,
  currentId,
  onSelect,
  onNew,
  onDelete,
}: {
  threads: ChatThread[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="border-b border-border-subtle bg-surface/50 max-h-48 overflow-y-auto">
      <button
        onClick={onNew}
        className="flex w-full items-center gap-2 px-4 py-2.5 font-ui text-xs text-accent hover:bg-surface-hover transition-colors min-h-[44px]"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New conversation
      </button>
      {threads.map((thread) => (
        <div
          key={thread.id}
          className={`group flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors min-h-[44px] ${
            thread.id === currentId ? "bg-surface" : "hover:bg-surface-hover"
          }`}
        >
          <button
            onClick={() => onSelect(thread.id)}
            className="flex-1 text-left truncate font-ui text-xs text-text-secondary"
          >
            {thread.title || "Untitled"}
            {thread.compactedAt && (
              <span className="ml-1.5 text-[10px] text-text-faint bg-surface-hover rounded px-1 py-0.5">
                summarized
              </span>
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(thread.id);
            }}
            className="hidden group-hover:flex h-6 w-6 items-center justify-center rounded text-text-faint hover:text-negative hover:bg-negative-dim transition-colors"
            aria-label={`Delete thread: ${thread.title || "Untitled"}`}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Message bubble ──

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  // Per-message audio state. We don't mount the AudioPlayer until the user
  // explicitly taps "Listen" — otherwise every assistant message would kick
  // off a TTS request, which is expensive (esp. on OpenAI) and would
  // auto-play audio the user didn't ask for.
  const [showAudio, setShowAudio] = useState(false);
  // Voice override for this message's playback. `null` means "use the
  // server-resolved user-level default" (the worker resolves this from the
  // user's signalSurfaceMap.models.ttsModel setting).
  const [voiceId, setVoiceId] = useState<string | null>(null);

  // Stay in sync with voice changes triggered elsewhere (e.g. another
  // message's switcher, or the Settings panel). This way the user's "current
  // voice" is consistent across every speak control on the page.
  useEffect(
    () =>
      onPrimerEvent("tts-voice-changed", (detail) => {
        if (!detail.voiceId) return;
        // Filter to chat-scoped picks (or unscoped global picks) so a deep-dive or
        // teaching-piece voice change doesn't reload chat audio at the wrong voice.
        if (detail.surface && detail.surface !== "chat") return;
        setVoiceId(detail.voiceId);
      }),
    [],
  );

  // Only show speak controls on assistant messages that have finished
  // streaming and persisted to D1 — we need the message ID to be stable
  // and present in the DB so the audio endpoint can look it up. The
  // optimistic streaming placeholder uses a temp ID prefix; the real ID
  // comes back in the SSE 'done' event.
  const canSpeak = !isUser && !message.isStreaming && message.content.trim().length > 0;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 font-body text-sm leading-relaxed ${
          isUser ? "bg-accent-dim text-text-primary" : "bg-surface text-text-secondary"
        }`}
      >
        {isUser ? (
          message.content
        ) : (
          <>
            <MarkdownText content={message.content} />
            {message.isStreaming && <StreamingCursor />}
            {canSpeak && (
              // The audio area lives INSIDE the bubble's padding, not
              // bled across it — the earlier `-mx-1` saved 4px of width
              // but pushed the player past the bubble's right edge in
              // narrow chat-panel layouts. `min-w-0` on the wrap
              // container is what lets the AudioPlayer's
              // `min-w-0 max-w-full` actually take effect (a flex
              // child can only shrink below its content min-width
              // when its parent is also `min-w-0`).
              <div className="mt-2 min-w-0">
                {!showAudio ? (
                  <button
                    type="button"
                    onClick={() => setShowAudio(true)}
                    className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 font-ui text-[11px] text-text-faint hover:text-accent transition-colors"
                    title="Listen to this reply"
                    aria-label="Listen to this reply"
                  >
                    <SpeakerIcon />
                    Listen
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                    <AudioPlayer
                      src={`/api/chat/messages/${message.id}/audio`}
                      voiceId={voiceId}
                      // Seed the duration estimate from the
                      // assistant message length. The worker
                      // strips markdown via `chatMarkdownToSpeech`
                      // before TTS, so the raw `message.content`
                      // includes some non-spoken characters
                      // (markdown markers, link URLs). The
                      // chars-per-second constant has enough
                      // headroom (~10%) to absorb that and still
                      // err on the slight-overestimate side, so
                      // the bar never clamps at 100% before the
                      // audio actually ends.
                      estimatedDurationSeconds={estimateTtsDurationSeconds(message.content)}
                    />
                    <AdminOnly>
                      <VoiceSwitcher currentVoiceId={voiceId} onChange={setVoiceId} surface="chat" />
                    </AdminOnly>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SpeakerIcon() {
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
    >
      <path d="M3 5v6l4 3V2L3 5z" />
      <path d="M10 5.5a3 3 0 010 5" />
      <path d="M12 3.5a6 6 0 010 9" />
    </svg>
  );
}

// ── Compacted thread info ──

function CompactedNotice({ thread }: { thread: ChatThread }) {
  return (
    <div className="mx-4 my-4 rounded-lg border border-border-subtle bg-surface p-4">
      <div className="flex items-center gap-2 mb-2">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="text-text-dim"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span className="font-ui text-xs font-medium text-text-dim">Conversation summarized</span>
      </div>
      <p className="font-body text-sm text-text-secondary leading-relaxed">
        {thread.summary || "This conversation was automatically summarized."}
      </p>
    </div>
  );
}

// ── Main panel ──

export function ChatPanel({ chat, onClose }: ChatPanelProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [input, setInput] = useState("");
  // Live transcript while dictating, plus a "currently listening" flag.
  // Same pattern the calibration quizzes use (BaselineQuiz / CalibrationQuiz)
  // so the mic behaves the same way everywhere — tap to start, talk
  // freely, tap again or wait 5 s of silence to stop, see your words
  // appear live in the textarea.
  const [interim, setInterim] = useState("");
  const [dictating, setDictating] = useState(false);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [chatModelDefault, setChatModelDefault] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelsLoadedRef = useRef(false);

  useEffect(() => {
    if (modelsLoadedRef.current) return;
    modelsLoadedRef.current = true;
    apiGet<ModelsResponse>("/api/models")
      .then((data) => {
        setModels(data.models);
        setChatModelDefault(data.defaults.chat ?? "");
      })
      .catch(() => {});
  }, []);

  const activeModel = selectedModel || chatModelDefault;
  const activeModelLabel = models.find((m) => m.id === activeModel)?.label ?? "Claude";

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [chat.messages, chat.sending, scrollToBottom]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [chat.currentThread]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pickerOpen || modelPickerOpen) {
        setPickerOpen(false);
        setModelPickerOpen(false);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose, pickerOpen, modelPickerOpen]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || chat.sending) return;
    setInput("");
    setInterim("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    await chat.sendMessage(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  };

  const handleThreadSelect = async (id: string) => {
    setPickerOpen(false);
    await chat.switchThread(id);
  };

  const handleNewThread = async () => {
    setPickerOpen(false);
    await chat.newThread();
  };

  const isCompacted = chat.currentThread?.compactedAt != null;

  return (
    <>
      {/* Mobile backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      {/*
       * Chat panel sizing.
       *
       * Mobile (< md): full width — chat is the only thing on screen
       * once it's open, so let it breathe.
       *
       * Desktop (md+): 480px. Bumped up from the original 400px after
       * field testing — code blocks and longer assistant replies were
       * wrapping aggressively, and the bubble's 85%-of-panel cap was
       * leaving messages feeling cramped. 480px keeps the panel
       * narrow enough that a 1024px laptop still has ~540px for the
       * underlying article (the chat is a `fixed` overlay, not a
       * flex sibling, so it intentionally occludes content rather
       * than reflowing the page).
       */}
      <div className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-bg md:w-[480px] animate-slide-in-right">
        {/* Header bar */}
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => {
                setPickerOpen(!pickerOpen);
                setModelPickerOpen(false);
              }}
              className="flex items-center gap-1.5 min-w-0 rounded-md px-2 py-1.5 hover:bg-surface-hover transition-colors min-h-[44px]"
              aria-label="Toggle thread picker"
            >
              <span className="truncate font-ui text-sm font-medium text-text-primary">
                {chat.currentThread?.title || "New conversation"}
              </span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className={`text-text-dim shrink-0 transition-transform ${pickerOpen ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-dim hover:text-text-primary hover:bg-surface-hover transition-colors min-h-[44px] min-w-[44px]"
            aria-label="Close chat"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Model picker — rendered as a popover anchored above the input bar */}

        {/* Thread picker dropdown */}
        {pickerOpen && (
          <ThreadPicker
            threads={chat.threads}
            currentId={chat.currentThread?.id ?? null}
            onSelect={handleThreadSelect}
            onNew={handleNewThread}
            onDelete={chat.deleteThread}
          />
        )}

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {chat.loading ? (
            <div className="flex items-center justify-center py-12">
              <TypingDots />
            </div>
          ) : isCompacted && chat.currentThread ? (
            <CompactedNotice thread={chat.currentThread} />
          ) : chat.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="text-text-faint mb-3"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <p className="font-body text-sm text-text-dim max-w-[240px]">
                Ask about your concepts, briefings, or learning progress.
              </p>
            </div>
          ) : (
            <>
              {chat.messages.map((msg) => {
                if (msg.isStreaming && !msg.content) return null;
                return <MessageBubble key={msg.id} message={msg} />;
              })}
              {chat.sending && !chat.messages.some((m) => m.isStreaming && m.content) && (
                <div className="flex justify-start mb-3">
                  <div className="rounded-lg bg-surface px-3 py-2">
                    <TypingDots />
                  </div>
                </div>
              )}
              {chat.toolActive && (
                <div className="flex justify-start mb-3">
                  <div className="rounded-lg bg-surface px-3 py-1">
                    <ToolIndicator tool={chat.toolActive} />
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Model picker popover — grouped by provider, mirroring the
            Settings → AI models picker. The popover uses custom
            buttons (not a native <select>) so we can't reuse
            ProviderGroupedSelect verbatim; instead we group inline
            with small uppercase header rows between provider
            sections. Providers with no models in the response are
            skipped silently so absent provider keys don't leave
            orphan headers. */}
        {modelPickerOpen && (
          <div className="relative px-4">
            <div className="absolute bottom-0 left-4 right-4 z-10 rounded-lg border border-border bg-bg shadow-xl overflow-hidden animate-fade-in">
              <div className="py-1">
                {CHAT_PROVIDER_ORDER.map((provider, providerIdx) => {
                  const group = models.filter((m) => m.provider === provider);
                  if (group.length === 0) return null;
                  return (
                    <div key={provider}>
                      <div
                        className={`px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-text-faint ${
                          // Tighter top padding on the first group
                          // so the popover's top edge isn't double-
                          // padded against the first header.
                          providerIdx === 0 ? "" : "mt-0.5 border-t border-border-subtle"
                        }`}
                      >
                        {CHAT_PROVIDER_LABELS[provider] ?? provider}
                      </div>
                      {group.map((m) => {
                        const isActive = m.id === activeModel;
                        const tierLabel = m.tier === "fast" ? "Fast" : m.tier === "balanced" ? "Balanced" : "Quality";
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setSelectedModel(m.id);
                              setModelPickerOpen(false);
                            }}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                              isActive ? "bg-surface" : "hover:bg-surface-hover"
                            }`}
                          >
                            <span
                              className={`text-xs font-mono ${
                                isActive ? "font-semibold text-text-primary" : "text-text-secondary"
                              }`}
                            >
                              {m.label}
                            </span>
                            <span className="text-[10px] font-mono text-text-faint">{tierLabel}</span>
                            <span className="flex-1" />
                            {isActive && (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="text-accent shrink-0"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Input bar */}
        <div className="border-t border-border-subtle bg-bg px-4 py-3">
          <div
            className={`rounded-lg border bg-surface transition-colors ${
              dictating ? "border-accent ring-2 ring-accent/20" : "border-border focus-within:border-accent"
            }`}
          >
            <textarea
              ref={textareaRef}
              value={dictating && interim ? `${input}${input ? " " : ""}${interim}` : input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={dictating ? "Listening — speak freely…" : "Ask a question…"}
              rows={1}
              disabled={isCompacted}
              readOnly={dictating}
              className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1.5 font-body text-sm text-text-primary placeholder:text-text-faint focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed min-h-[36px]"
              data-allow-typing=""
            />
            {dictating && (
              <p className="-mt-1 px-3 pb-1 font-ui text-[10px] text-accent">
                ● Listening — pause for 5 s or tap the mic to send.
              </p>
            )}
            <div className="flex items-center justify-between px-2 pb-2">
              <button
                type="button"
                onClick={() => {
                  setModelPickerOpen(!modelPickerOpen);
                  setPickerOpen(false);
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-text-faint hover:text-text-secondary hover:bg-surface-hover transition-colors text-[10px] font-mono"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 2v3M4.5 5l2 2M11.5 5l-2 2" />
                  <circle cx="8" cy="8" r="2" />
                  <path d="M8 14v-3M4.5 11l2-2M11.5 11l-2-2" />
                </svg>
                {activeModelLabel}
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <div className="flex items-center gap-1">
                <DictationButton
                  onTranscript={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))}
                  onInterim={setInterim}
                  onListeningChange={setDictating}
                  continuous
                  className="h-7 w-7"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim() || chat.sending || isCompacted}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-white transition-opacity disabled:opacity-30"
                  aria-label="Send message"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
