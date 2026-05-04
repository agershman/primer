import { useCallback, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiDelete, apiGet, apiPost } from "../utils/api";

export interface ChatThread {
  id: string;
  title: string | null;
  summary: string | null;
  compactedAt: string | null;
  pageContext: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  isStreaming?: boolean;
}

interface ThreadsResponse {
  threads: ChatThread[];
}

interface ThreadResponse {
  thread: ChatThread;
}

interface MessagesResponse {
  messages: ChatMessage[];
}

export interface UseChatResult {
  threads: ChatThread[];
  currentThread: ChatThread | null;
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  toolActive: string | null;
  loadThreads: () => Promise<void>;
  createThread: (pageContext?: string) => Promise<ChatThread>;
  switchThread: (id: string) => Promise<void>;
  sendMessage: (content: string, pageContext?: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  newThread: () => Promise<void>;
}

function parseSSEEvents(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event && data) events.push({ event, data });
  }
  return events;
}

export function useChat(): UseChatResult {
  const location = useLocation();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [currentThread, setCurrentThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [toolActive, setToolActive] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const loadThreads = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<ThreadsResponse>("/api/chat/threads");
      setThreads(data.threads);
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  const createThread = useCallback(
    async (pageContext?: string): Promise<ChatThread> => {
      const ctx = pageContext ?? location.pathname;
      const data = await apiPost<ThreadResponse>("/api/chat/threads", { pageContext: ctx });
      setThreads((prev) => [data.thread, ...prev]);
      setCurrentThread(data.thread);
      setMessages([]);
      return data.thread;
    },
    [location.pathname],
  );

  const switchThread = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const data = await apiGet<MessagesResponse>(`/api/chat/threads/${id}/messages`);
        setMessages(data.messages);
        setCurrentThread((prev) => {
          const found = threads.find((t) => t.id === id);
          return found ?? prev;
        });
      } catch {
        setMessages([]);
      } finally {
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [threads],
  );

  const sendMessage = useCallback(
    async (content: string, pageContext?: string) => {
      let thread = currentThread;
      if (!thread) {
        thread = await createThread(pageContext);
      }

      const optimisticUser: ChatMessage = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      const streamingPlaceholder: ChatMessage = {
        id: `streaming-${Date.now()}`,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, optimisticUser, streamingPlaceholder]);
      setSending(true);
      setToolActive(null);

      const streamingId = streamingPlaceholder.id;

      try {
        const res = await fetch(`/api/chat/threads/${thread.id}/messages/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, pageContext: pageContext ?? location.pathname }),
        });

        if (!res.ok) {
          throw new Error(`API ${res.status}: ${await res.text()}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lastDoubleNewline = buffer.lastIndexOf("\n\n");
          if (lastDoubleNewline === -1) continue;

          const complete = buffer.slice(0, lastDoubleNewline + 2);
          buffer = buffer.slice(lastDoubleNewline + 2);

          const events = parseSSEEvents(complete);
          for (const sse of events) {
            const payload = JSON.parse(sse.data);

            if (sse.event === "delta") {
              setMessages((prev) =>
                prev.map((m) => (m.id === streamingId ? { ...m, content: m.content + payload.text } : m)),
              );
            } else if (sse.event === "tool_start") {
              setToolActive(payload.tool);
            } else if (sse.event === "tool_end") {
              setToolActive(null);
            } else if (sse.event === "done") {
              const { userMessage, assistantMessage } = payload;
              setMessages((prev) =>
                prev
                  .filter((m) => m.id !== optimisticUser.id && m.id !== streamingId)
                  .concat([
                    { ...userMessage, isStreaming: false },
                    { ...assistantMessage, isStreaming: false },
                  ]),
              );
              setCurrentThread((prev) => (prev ? { ...prev, messageCount: prev.messageCount + 2 } : prev));
              setThreads((prev) =>
                prev.map((t) =>
                  t.id === thread!.id
                    ? { ...t, messageCount: t.messageCount + 2, updatedAt: new Date().toISOString() }
                    : t,
                ),
              );
            } else if (sse.event === "title") {
              // LLM-generated topical title arrives a moment after
              // `done` on the very first exchange of a thread (modeled
              // on Cursor / ChatGPT / Claude). Patch both the active
              // thread header and the sidebar list entry so the user
              // sees the rename live without a manual refresh.
              const newTitle = (payload.title as string) ?? null;
              if (newTitle) {
                setCurrentThread((prev) => (prev ? { ...prev, title: newTitle } : prev));
                setThreads((prev) => prev.map((t) => (t.id === thread!.id ? { ...t, title: newTitle } : t)));
              }
            } else if (sse.event === "error") {
              throw new Error(payload.message);
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const is503 = errMsg.includes("503");
        const userFacingMsg = is503
          ? "The server restarted while processing your message. This can happen during local development when files change. Please try sending your message again."
          : `Sorry, something went wrong. ${errMsg}`;
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== optimisticUser.id && m.id !== streamingId)
            .concat([
              {
                id: `error-${Date.now()}`,
                role: "assistant" as const,
                content: userFacingMsg,
                createdAt: new Date().toISOString(),
              },
            ]),
        );
      } finally {
        setSending(false);
        setToolActive(null);
      }
    },
    [currentThread, createThread, location.pathname],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      await apiDelete(`/api/chat/threads/${id}`);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (currentThread?.id === id) {
        setCurrentThread(null);
        setMessages([]);
      }
    },
    [currentThread],
  );

  const newThread = useCallback(async () => {
    await createThread();
  }, [createThread]);

  if (!loadedRef.current) {
    loadedRef.current = true;
    loadThreads();
  }

  return {
    threads,
    currentThread,
    messages,
    loading,
    sending,
    toolActive,
    loadThreads,
    createThread,
    switchThread,
    sendMessage,
    deleteThread,
    newThread,
  };
}
