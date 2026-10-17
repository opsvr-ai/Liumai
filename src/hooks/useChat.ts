/** Reactive chat state manager with SSE streaming support.

Agent modes stream through the Hermes **Runs API** (``/api/chat/runs``) so the
turn can be stopped server-side, steered mid-run and approved, and reattached by
``run_id`` after a dropped connection.  Direct-LLM modes (``provider: "llm"``,
e.g. ``system:general``) keep using the legacy ``/api/chat/stream`` endpoint.

The Runs path is best-effort: if creating a run fails before anything has been
rendered, the turn transparently falls back to ``/api/chat/stream`` so no
capability is ever lost.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import {
  chatHistory,
  chatRuns,
  chatRunEvents,
  chatStream,
  type ChatApprovalRequest,
  type ChatMessage,
  type ChatRunEvent,
  type ToolCallDelta,
} from "@/lib/api";

/* ==========================================================================
 * Types
 * ========================================================================== */

/** A display-ready message rendered in the chat panel. */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  /** Model reasoning / thinking stream (Hermes reasoning_content). */
  reasoning?: string;
  /** Tool calls made during this assistant turn. */
  toolCalls?: ToolCallDelta[];
  /** Token usage reported by Hermes for this turn. */
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Whether this message is still being streamed. */
  isStreaming?: boolean;
}

/**
 * Server-side capabilities the UI may use, probed from
 * ``GET /api/chat/hermes-info`` → ``features``.  Everything defaults to
 * enabled so an older/slower backend still works (the Runs path degrades to
 * ``/chat/stream`` automatically when the endpoints are missing).
 */
export interface ChatRunCapabilities {
  /** ``features.run_submission`` — agent runs usable at all. */
  runs: boolean;
  /** ``features.run_stop`` — a stop actually interrupts Hermes. */
  stop: boolean;
  /** ``features.run_steer`` — mid-run supplementary instructions. */
  steer: boolean;
  /** ``features.run_approval_response`` — tool approval prompts. */
  approval: boolean;
}

const DEFAULT_RUN_CAPABILITIES: ChatRunCapabilities = {
  runs: true,
  stop: true,
  steer: true,
  approval: true,
};

/** Extra SSE re-subscriptions after a dropped run stream (resumed by seq). */
const RUN_RECONNECT_ATTEMPTS = 2;

/* ==========================================================================
 * Hook
 * ========================================================================== */

export function useChat() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  /**
   * Hermes-side agent session (``X-Hermes-Session-Id``).  Once we have one,
   * only the newest user message is sent upstream — Hermes already holds the
   * conversation, which keeps prompts small instead of resending the entire
   * history on every turn.
   */
  const [hermesSessionId, setHermesSessionId] = useState<string | null>(null);
  /** Mode the Hermes session was created in — a session is only reused by the
   * same mode, otherwise switching modes would keep sending just the last
   * message (breaking context for LLM-direct modes). */
  const [hermesSessionMode, setHermesSessionMode] = useState<string | null>(null);
  /** Active Hermes run id while a Runs-API turn is in flight (``null`` otherwise). */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  /** Pending tool-approval prompt for the active run. */
  const [pendingApproval, setPendingApproval] = useState<ChatApprovalRequest | null>(null);
  /** Probed server capabilities (see {@link ChatRunCapabilities}). */
  const [runCapabilities, setRunCapabilities] = useState<ChatRunCapabilities>(
    DEFAULT_RUN_CAPABILITIES,
  );

  const abortRef = useRef<AbortController | null>(null);
  /** Run id for control calls; a ref so stop/steer never read stale state. */
  const runIdRef = useRef<string | null>(null);
  /** Set by 停止 so late events from the outgoing run are ignored. */
  const stoppedRef = useRef(false);
  /** Capability snapshot for callbacks that must not re-create on every probe. */
  const capabilitiesRef = useRef<ChatRunCapabilities>(DEFAULT_RUN_CAPABILITIES);

  /** Merge newly probed capabilities (called by the chat panel on mount). */
  const configureRunCapabilities = useCallback(
    (next: Partial<ChatRunCapabilities>) => {
      const merged = { ...capabilitiesRef.current, ...next };
      capabilitiesRef.current = merged;
      setRunCapabilities(merged);
    },
    [],
  );

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
   * Append a reasoning chunk to the current assistant turn.
   *
   * Reasoning arrives before the answer; it is kept on the message so the UI
   * can show a collapsible "思考过程" section instead of blending it into the
   * final text.
   */
  const appendReasoning = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        return [
          ...prev.slice(0, -1),
          { ...last, reasoning: (last.reasoning ?? "") + content },
        ];
      }
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          reasoning: content,
          isStreaming: true,
        },
      ];
    });
  }, []);

  /** Insert or update tool-call messages as separate, visible bubbles.
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
          // Update in place — preserve hermes_emoji/label/status from earlier
          // progress events so regular delta chunks don't overwrite them
          const prevTc = next[existingIdx].toolCalls?.[0];
          const mergedTc: ToolCallDelta = {
            ...tc,
            hermes_emoji: tc.hermes_emoji || prevTc?.hermes_emoji,
            hermes_label: tc.hermes_label || prevTc?.hermes_label,
            hermes_status: tc.hermes_status || prevTc?.hermes_status,
          };
          const status = mergedTc.hermes_status;
          next[existingIdx] = {
            ...next[existingIdx],
            toolCalls: [mergedTc],
            isStreaming: status === "completed"
              ? false
              : status === "running"
                ? true
                : tc.function?.arguments
                  ? !_looksComplete(tc.function.arguments)
                  : true,
          };
        } else {
          // Insert new tool message at the end of the list, but BEFORE
          // a currently-streaming assistant bubble if one exists.
          // This keeps tools scoped to the CURRENT round, not previous ones.
          let insertAt = next.length;
          const lastMsg = next[next.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && lastMsg.isStreaming) {
            insertAt = next.length - 1;
          }
          const toolMsg: DisplayMessage = {
            id: `tool-${tcId}`,
            role: "tool",
            content: tc.function?.name || "调用工具",
            toolCalls: [tc],
            isStreaming: true,
          };
          next.splice(insertAt, 0, toolMsg);
        }
      }

      return next;
    });
  }, []);

  /** Attach token usage to the assistant message that just finished. */
  const attachUsage = useCallback(
    (usage: { prompt_tokens: number; completion_tokens: number }) => {
      setMessages((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === "assistant") {
            const next = [...prev];
            next[i] = { ...next[i], usage };
            return next;
          }
        }
        return prev;
      });
    },
    [],
  );

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
    async (
      content: string,
      opts?: {
        mode?: string;
        model?: string;
        timeWindowStart?: string;
        timeWindowEnd?: string;
        /** Mode engine — ``"llm"`` keeps the legacy /chat/stream path. */
        provider?: string;
      },
    ) => {
      if (!content.trim() || isStreaming) return;

      abortRef.current?.abort();

      const userMsg: DisplayMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: content.trim(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setError(null);
      setPendingApproval(null);
      setActiveRunId(null);
      setIsStreaming(true);
      runIdRef.current = null;
      stoppedRef.current = false;

      // Build API message list from display messages.  A Hermes session is
      // reused only in the mode that created it; the server then holds the
      // history, so only the newest turn is sent (smaller prompts, no
      // duplicated context).  Any other mode replays the full history.
      const sessionMatches = Boolean(hermesSessionId) && hermesSessionMode === (opts?.mode ?? null);
      const apiMessages: ChatMessage[] = sessionMatches
        ? [{ role: "user", content: userMsg.content }]
        : messages
            .concat(userMsg)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }));

      const controller = new AbortController();
      abortRef.current = controller;

      // Agent modes go through the Runs API; direct-LLM modes and backends
      // without run support stay on /chat/stream.
      const wantRuns =
        opts?.provider !== "llm" && capabilitiesRef.current.runs;

      // Did this turn already render anything, and did a Hermes run get created?
      // A fallback after either would duplicate the turn (or execute it twice),
      // so in those cases we surface the error instead.
      let produced = false;
      let runCreated = false;

      /** Dispatch one normalised stream event onto React state. */
      const applyEvent = (event: ChatRunEvent) => {
        if (stoppedRef.current) return; // user pressed 停止 — drop late events
        switch (event.type) {
          case "delta":
            produced = true;
            appendToAssistant(event.content);
            break;
          case "reasoning":
            produced = true;
            appendReasoning(event.content);
            break;
          case "session":
            setHermesSessionId(event.session_id);
            setHermesSessionMode(opts?.mode ?? null);
            break;
          case "tool_call":
            produced = true;
            updateToolCalls(event.tool_calls);
            break;
          case "approval":
            // The agent is paused mid-turn: falling back now would start a
            // second run, so count this as output and surface errors instead.
            produced = true;
            setPendingApproval(event.approval);
            break;
          case "done":
            // Abnormal finishes (context overflow, provider error…) arrive with
            // an `error` alongside the finish reason.
            if (event.error) setError(event.error);
            if (event.usage) attachUsage(event.usage);
            finishAssistant();
            break;
          case "error":
            setError(event.error);
            finishAssistant();
            break;
        }
      };

      /** Legacy path: POST /api/chat/stream. */
      const streamViaChat = async () => {
        for await (const event of chatStream(apiMessages, {
          signal: controller.signal,
          mode: opts?.mode,
          model: opts?.model,
          timeWindowStart: opts?.timeWindowStart,
          timeWindowEnd: opts?.timeWindowEnd,
          hermesSessionId: sessionMatches ? hermesSessionId : null,
        })) {
          applyEvent(event);
        }
      };

      /** Runs path: create → subscribe → (resume on drop). */
      const streamViaRuns = async () => {
        // Without a reusable Hermes session the agent has no context, so replay
        // the prior turns (the newest message travels as ``input``).
        const history = sessionMatches ? null : apiMessages.slice(0, -1);
        const created = await chatRuns.create({
          input: userMsg.content,
          session_id: sessionMatches ? hermesSessionId : null,
          conversation_history: history && history.length > 0 ? history : null,
          model: opts?.model ?? null,
          mode: opts?.mode ?? null,
        });
        runCreated = true;

        runIdRef.current = created.run_id;
        setActiveRunId(created.run_id);
        if (created.session_id) {
          setHermesSessionId(created.session_id);
          setHermesSessionMode(opts?.mode ?? null);
        }

        let lastSeq: number | null = null;
        let attempt = 0;
        while (true) {
          try {
            for await (const event of chatRunEvents(created.run_id, {
              signal: controller.signal,
              lastEventId: lastSeq,
            })) {
              if (typeof event.seq === "number") lastSeq = event.seq;
              applyEvent(event);
            }
            return; // stream closed (terminal run event received)
          } catch (err) {
            if (controller.signal.aborted || stoppedRef.current) throw err;
            attempt += 1;
            if (attempt > RUN_RECONNECT_ATTEMPTS) throw err;
            // Connection dropped mid-run: reattach by run_id after a short
            // backoff, resuming from the last sequence number so Hermes
            // replays only what we missed.
            await new Promise<void>((resolve) =>
              setTimeout(resolve, 800 * attempt),
            );
          }
        }
      };

      try {
        if (wantRuns) {
          try {
            await streamViaRuns();
            return;
          } catch (err) {
            if (controller.signal.aborted) return;
            // Only fall back when the turn never started: retrying through
            // /chat/stream after a run was admitted would execute it twice.
            if (produced || runCreated) throw err;
            console.warn(
              "[useChat] Runs API 不可用，回退到 /chat/stream",
              err,
            );
            runIdRef.current = null;
            setActiveRunId(null);
            setPendingApproval(null);
          }
        }
        await streamViaChat();
      } catch (err: unknown) {
        if (
          (err instanceof DOMException && err.name === "AbortError") ||
          stoppedRef.current
        ) {
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
        setActiveRunId(null);
        setPendingApproval(null);
        runIdRef.current = null;
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [
      messages,
      isStreaming,
      hermesSessionId,
      hermesSessionMode,
      appendToAssistant,
      appendReasoning,
      updateToolCalls,
      attachUsage,
      finishAssistant,
    ],
  );

  /**
   * Stop the in-flight turn (user pressed 停止).
   *
   * For a Runs-API turn this first asks Hermes to actually interrupt the agent
   * (``POST /runs/{id}/stop``) and then drops the local subscription.  Without
   * ``features.run_stop`` (or for a legacy ``/chat/stream`` turn) it only
   * disconnects the local stream, which is all the old path can do.
   */
  const stopStreaming = useCallback(() => {
    const runId = runIdRef.current;
    const controller = abortRef.current;
    const stopSupported = capabilitiesRef.current.stop;

    stoppedRef.current = true;
    abortRef.current = null;
    runIdRef.current = null;
    setIsStreaming(false);
    setActiveRunId(null);
    setPendingApproval(null);
    finishAssistant();

    if (runId && stopSupported) {
      // Request the interrupt first, then drop our subscription.  The stop POST
      // is an independent request, so aborting the SSE fetch does not cancel
      // it — but Hermes starts interrupting the agent immediately either way.
      void chatRuns.stop(runId).catch(() => {
        // Already finished / expired — the abort below still cleans up.
      });
    }
    controller?.abort();
  }, [finishAssistant]);

  /**
   * Inject a supplementary instruction into the running agent
   * (``POST /runs/{id}/steer``).  Returns ``true`` when Hermes accepted it.
   */
  const steerMessage = useCallback(async (content: string): Promise<boolean> => {
    const runId = runIdRef.current;
    if (!runId || !content.trim() || !capabilitiesRef.current.steer) return false;
    try {
      const result = await chatRuns.steer(runId, content.trim());
      return result.accepted !== false;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  /**
   * Answer the pending tool-approval prompt.
   *
   * @param decision once / session / always / deny.
   */
  const respondApproval = useCallback(
    async (decision: string) => {
      const runId = runIdRef.current;
      const pending = pendingApproval;
      if (!runId || !pending) return;
      setPendingApproval(null);
      try {
        await chatRuns.approval(runId, pending.approvalId, decision);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [pendingApproval],
  );

  /** Clear all messages and cancel any in-flight stream. */
  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    stoppedRef.current = true;
    runIdRef.current = null;
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    setSessionId(null);
    setHermesSessionId(null);
    setHermesSessionMode(null);
    setActiveRunId(null);
    setPendingApproval(null);
  }, []);

  /** Load a saved session from the backend. */
  const loadSession = useCallback(async (id: number) => {
    abortRef.current?.abort();
    stoppedRef.current = true;
    runIdRef.current = null;
    setActiveRunId(null);
    setPendingApproval(null);
    // A restored transcript has no matching Hermes session — the next turn
    // replays the history and adopts a fresh session id.
    setHermesSessionId(null);
    setHermesSessionMode(null);
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

  // Abort any in-flight stream when the chat page unmounts — otherwise the
  // Hermes run keeps going (and billing) after the user navigates away.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // Auto-save when streaming finishes — avoids stale-closure issues
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    const justFinished = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    if (justFinished && messages.length > 0) {
      saveCurrentSession().catch(() => {
        // Save failed — the user may not be logged in, or the server
        // may be unreachable.  Silently ignore; messages remain in
        // React state for the current session.
      });
    }
  }, [isStreaming, messages.length, saveCurrentSession]);

  return {
    messages,
    isStreaming,
    error,
    sessionId,
    hermesSessionId,
    /** Run id of the in-flight Runs-API turn (``null`` for legacy turns). */
    activeRunId,
    /** Pending tool-approval prompt, if the agent is waiting on one. */
    pendingApproval,
    /** Probed server capabilities (stop / steer / approval / runs). */
    runCapabilities,
    sendMessage,
    stopStreaming,
    steerMessage,
    respondApproval,
    configureRunCapabilities,
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
