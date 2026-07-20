/** Reactive chat state manager with SSE streaming support.

Connects to the 六脉 backend ``/api/chat/stream`` endpoint and manages
the lifecycle of a streaming chat conversation: sending messages,
accumulating text deltas, tracking tool calls as separate visible
messages, and handling errors.
*/

import { useCallback, useRef, useState } from "react";
import { chatStream, chatHistory, type ChatMessage, type ToolCallDelta } from "@/lib/api";

/* ==========================================================================
 * Types
 * ========================================================================== */

/** A display-ready message rendered in the chat panel. */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  /** Tool calls made during this assistant turn. */
  toolCalls?: ToolCallDelta[];
  /** Whether this message is still being streamed. */
  isStreaming?: boolean;
}

/* ==========================================================================
 * Hook
 * ========================================================================== */

export function useChat() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  /** Append a text chunk to the last assistant bubble (or create one). */
  const appendToAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        return [
          ...prev.slice(0, -1),
          { ...last, content: last.content + content },
        ];
      }
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          isStreaming: true,
        },
      ];
    });
  }, []);

  /**
   * Insert or update tool-call messages as separate, visible bubbles.
   *
   * Each distinct tool call (keyed by its ``id``) gets its own message
   * so the user can see every tool Hermes invokes during the agent loop.
   * Incremental argument chunks update the existing message in place.
   */
  const updateToolCalls = useCallback((toolCalls: ToolCallDelta[]) => {
    setMessages((prev) => {
      const next = [...prev];

      for (const tc of toolCalls) {
        const tcId = tc.id || tc.function?.name || "unknown";

        // Find existing tool message for this call
        const existingIdx = next.findIndex(
          (m) => m.role === "tool" && m.id === `tool-${tcId}`,
        );

        if (existingIdx >= 0) {
          // Update in place — completed when Hermes signals it
          const status = tc.hermes_status;
          next[existingIdx] = {
            ...next[existingIdx],
            toolCalls: [tc],
            isStreaming: status === "completed"
              ? false
              : status === "running"
                ? true
                : tc.function?.arguments
                  ? !_looksComplete(tc.function.arguments)
                  : true,
          };
        } else {
          // Insert new tool-call message BEFORE any assistant bubble that
          // may already be accumulating text
          const insertAt = next.findIndex((m) => m.role === "assistant");
          const toolMsg: DisplayMessage = {
            id: `tool-${tcId}`,
            role: "tool",
            content: tc.function?.name || "调用工具",
            toolCalls: [tc],
            isStreaming: true,
          };
          if (insertAt >= 0) {
            next.splice(insertAt, 0, toolMsg);
          } else {
            next.push(toolMsg);
          }
        }
      }

      return next;
    });
  }, []);

  /** Mark all tool messages and the last assistant bubble as finished. */
  const finishAssistant = useCallback(() => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.role === "tool" && m.isStreaming) {
          return { ...m, isStreaming: false };
        }
        if (m.role === "assistant" && m.isStreaming) {
          return { ...m, isStreaming: false };
        }
        return m;
      }),
    );
  }, []);

  /** Send a user message and stream the assistant's reply. */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isStreaming) return;

      abortRef.current?.abort();

      const userMsg: DisplayMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: content.trim(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setError(null);
      setIsStreaming(true);

      // Build API message list from display messages
      const apiMessages: ChatMessage[] = messages
        .concat(userMsg)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const event of chatStream(apiMessages, {
          signal: controller.signal,
        })) {
          switch (event.type) {
            case "delta":
              appendToAssistant(event.content);
              break;
            case "tool_call":
              updateToolCalls(event.tool_calls);
              break;
            case "done":
              finishAssistant();
              break;
            case "error":
              setError(event.error);
              break;
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // intentional cancel — no error to surface
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "error",
              content: msg,
            },
          ]);
        }
      } finally {
        setIsStreaming(false);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [messages, isStreaming, appendToAssistant, updateToolCalls, finishAssistant],
  );

  /** Clear all messages and cancel any in-flight stream. */
  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    setSessionId(null);
  }, []);

  /** Load a saved session from the backend. */
  const loadSession = useCallback(async (id: number) => {
    abortRef.current?.abort();
    const detail = await chatHistory.get(id);
    setMessages(
      detail.messages.map((m) => ({
        id: String(m.id),
        role: m.role as DisplayMessage["role"],
        content: m.content,
        toolCalls: (m.tool_calls as ToolCallDelta[] | undefined) ?? undefined,
      })),
    );
    setSessionId(id);
    setError(null);
    setIsStreaming(false);
  }, []);

  /** Persist the current messages to the backend. */
  const saveCurrentSession = useCallback(async () => {
    const saveable = messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
    );
    if (saveable.length === 0) return;

    const firstUser = messages.find((m) => m.role === "user");
    const title = firstUser
      ? firstUser.content.slice(0, 40) + (firstUser.content.length > 40 ? "…" : "")
      : "新对话";

    if (sessionId) {
      await chatHistory.saveMessages(
        sessionId,
        saveable.map((m) => ({
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls ?? undefined,
        })),
        title,
      );
    } else {
      const created = await chatHistory.create();
      await chatHistory.saveMessages(
        created.id,
        saveable.map((m) => ({
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls ?? undefined,
        })),
        title,
      );
      setSessionId(created.id);
    }
  }, [messages, sessionId]);

  return {
    messages,
    isStreaming,
    error,
    sessionId,
    sendMessage,
    clearMessages,
    loadSession,
    saveCurrentSession,
  } as const;
}

/* ==========================================================================
 * Helpers
 * ========================================================================== */

/** Heuristic: does the JSON argument string look like a complete object? */
function _looksComplete(args: string): boolean {
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}
