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
import { toast } from "sonner";
import { uid } from "@/lib/uid";
import {
  ApiError,
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
 * ``GET /api/chat/hermes-capabilities`` (non-admin, capability bits only).
 * Everything defaults to enabled so an older/slower backend still works (the
 * Runs path degrades to ``/chat/stream`` automatically when the endpoints are
 * missing); a failed probe switches every bit off instead of guessing.
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

/** Safe state after a failed probe: legacy stream only, no dead controls. */
const DISABLED_RUN_CAPABILITIES: ChatRunCapabilities = {
  runs: false,
  stop: false,
  steer: false,
  approval: false,
};

/** Decisions ``POST /runs/{id}/approval`` accepts. */
export type ChatApprovalDecision = "once" | "session" | "always" | "deny";

/** Outcome of {@link useChat.steerMessage}. */
export type ChatSteerResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * ``ended`` — the run already finished (HTTP 409 /
       * ``run_not_accepting_steer``); the caller should resend as a normal
       * turn.  ``unavailable`` — steer is not supported / no active run.
       */
      reason: "ended" | "unavailable" | "error";
      message?: string;
    };

/** Extra SSE re-subscriptions after a dropped run stream (resumed by seq). */
const RUN_RECONNECT_ATTEMPTS = 2;

/** Hermes run states that may still produce events (anything else is final). */
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "created",
  "running",
  "waiting_for_approval",
  "stopping",
]);

/** Poll cadence while reattached to a run that outlived the browser session. */
const REATTACH_POLL_MS = 2500;

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
  /**
   * Approval request ids already submitted.  The banner is cleared as soon as
   * a decision is sent, but a double click can fire twice before React
   * re-renders — this set keeps the second click from resolving the same
   * ``request_id`` twice.
   */
  const answeredApprovalIdsRef = useRef<Set<string>>(new Set());
  /** Set by 停止 so late events from the outgoing run are ignored. */
  const stoppedRef = useRef(false);
  /** Capability snapshot for callbacks that must not re-create on every probe. */
  const capabilitiesRef = useRef<ChatRunCapabilities>(DEFAULT_RUN_CAPABILITIES);
  /** Current session id for async callbacks fired mid-stream (no stale state). */
  const sessionIdRef = useRef<number | null>(null);
  /**
   * Latest transcript for persistence bridges, which fire while React state
   * updates are still in flight.
   */
  const messagesRef = useRef<DisplayMessage[]>([]);
  /**
   * Serialises session writes.  ``POST /sessions/{id}/messages`` replaces the
   * message rows, so overlapping auto-save + link updates could interleave the
   * delete/insert and duplicate messages — one queue prevents that.
   */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Token guarding the reattach poll against session switches/unmounts. */
  const reattachTokenRef = useRef(0);
  const reattachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Token identifying the current turn; stale turns must not settle state. */
  const turnTokenRef = useRef(0);

  /** Merge newly probed capabilities (called by the chat panel on mount). */
  const configureRunCapabilities = useCallback(
    (next: Partial<ChatRunCapabilities>) => {
      const merged = { ...capabilitiesRef.current, ...next };
      capabilitiesRef.current = merged;
      setRunCapabilities(merged);
    },
    [],
  );

  /**
   * Probe the non-admin capability endpoint once per mount.
   *
   * ``/api/chat/hermes-info`` is admin-only, so ordinary users used to eat a
   * 403 here and run on optimistic defaults.  ``/api/chat/hermes-capabilities``
   * exposes only the flags the UI can act on.  On failure every capability is
   * switched off: the Runs path degrades to ``/chat/stream`` and stop / steer /
   * approval controls stay hidden instead of failing at click time.
   */
  useEffect(() => {
    const controller = new AbortController();
    void probeRunCapabilities(controller.signal)
      .then((caps) => {
        if (controller.signal.aborted) return;
        configureRunCapabilities(caps ?? DISABLED_RUN_CAPABILITIES);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          configureRunCapabilities(DISABLED_RUN_CAPABILITIES);
        }
      });
    return () => controller.abort();
  }, [configureRunCapabilities]);

  /** Serialise a session write behind every previous one. */
  const enqueueSessionWrite = useCallback(
    <T,>(task: () => Promise<T>): Promise<T | undefined> => {
      const run = saveChainRef.current.catch(() => {}).then(task);
      saveChainRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      // Persistence is best-effort: being offline / logged out must not
      // surface as a chat error — the transcript stays in React state.
      return run.catch(() => undefined);
    },
    [],
  );

  /**
   * Persist the Hermes linkage (agent session / run id) onto the current chat
   * session immediately, without waiting for the turn to finish.
   *
   * A brand-new chat has no session row yet, so this is a no-op there — its
   * auto-save after the turn writes the same fields.
   */
  const persistSessionLinks = useCallback(
    (links: {
      hermes_session_id?: string | null;
      active_run_id?: string | null;
    }) => {
      const target = sessionIdRef.current;
      if (!target) return;
      const saveable = _saveableMessages(messagesRef.current);
      if (saveable.length === 0) return;
      const title = _titleForMessages(messagesRef.current);
      void enqueueSessionWrite(async () => {
        await chatHistory.saveMessages(target, saveable, title, links);
      });
    },
    [enqueueSessionWrite],
  );

  /** Cancel any in-flight reattach poll (session switch / clear / unmount). */
  const cancelReattach = useCallback(() => {
    reattachTokenRef.current += 1;
    if (reattachTimerRef.current !== null) {
      clearTimeout(reattachTimerRef.current);
      reattachTimerRef.current = null;
    }
  }, []);

  /** Append / refresh the final output of a run we reattached to. */
  const appendReattachedOutput = useCallback((output: string) => {
    const next = _withRunOutput(messagesRef.current, output);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /**
   * Reattach to the Hermes run recorded on a chat session.
   *
   * The run keeps executing server-side while the page is away, so we poll
   * ``GET /api/chat/runs/{id}`` (the Runs status API) instead of aborting it:
   * the transcript restored from the backend stays authoritative, and the
   * run's final output is merged in when it finishes.  Polling (rather than a
   * fresh SSE subscription) avoids replaying deltas the saved transcript
   * already contains.
   */
  const runReattachPoll = useCallback(
    (runId: string) => {
      cancelReattach();
      const token = reattachTokenRef.current;
      runIdRef.current = runId;
      setActiveRunId(runId);
      setIsStreaming(true);
      stoppedRef.current = false;

      const tick = async () => {
        if (reattachTokenRef.current !== token) return;
        let status: Awaited<ReturnType<typeof chatRuns.status>>;
        try {
          status = await chatRuns.status(runId);
        } catch {
          // Run expired (404) or Hermes unreachable: drop the stale link but
          // keep the restored transcript intact.
          if (reattachTokenRef.current !== token) return;
          runIdRef.current = null;
          setActiveRunId(null);
          setIsStreaming(false);
          persistSessionLinks({ active_run_id: null });
          return;
        }
        if (reattachTokenRef.current !== token) return;

        if (ACTIVE_RUN_STATUSES.has(status.status)) {
          reattachTimerRef.current = setTimeout(() => {
            void tick();
          }, REATTACH_POLL_MS);
          return;
        }

        runIdRef.current = null;
        setActiveRunId(null);
        setIsStreaming(false);
        if (status.status === "failed" && status.error) {
          setError(status.error);
        }
        const output = typeof status.output === "string" ? status.output : "";
        if (status.status === "completed" && output.trim()) {
          appendReattachedOutput(output);
        }
        persistSessionLinks({ active_run_id: null });
      };

      void tick();
    },
    [appendReattachedOutput, cancelReattach, persistSessionLinks],
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
          id: uid(),
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
          id: uid(),
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
      const text = content.trim();
      if (!text) return;

      // A live turn owns the composer: the send button is disabled while
      // streaming.  If ``isStreaming`` is set without an abort controller or
      // active run, a previous turn failed before its finally block — settle it
      // instead of silently swallowing this send.
      if (isStreaming) {
        if (abortRef.current || runIdRef.current) return;
        setIsStreaming(false);
      }

      abortRef.current?.abort();
      const turnToken = ++turnTokenRef.current;

      const userMsg: DisplayMessage = {
        id: uid(),
        role: "user",
        content: text,
      };

      setMessages((prev) => [...prev, userMsg]);
      messagesRef.current = [...messages, userMsg];
      setError(null);
      setPendingApproval(null);
      setActiveRunId(null);
      setIsStreaming(true);
      runIdRef.current = null;
      stoppedRef.current = false;
      answeredApprovalIdsRef.current.clear();

      // Everything after this point can fail (session creation, message
      // construction, network).  The outer catch guarantees the turn is
      // surfaced and ``isStreaming`` is released — no silent failures.
      try {

      // Make sure the turn has a platform chat session before anything streams:
      // agent artifacts live in ``hermes-files/<session_id>/`` and the download
      // chip needs that id while the answer is still arriving.  If creation
      // fails the turn still runs — the backend then uses a temporary token and
      // the chip stays hidden.
      if (!sessionIdRef.current) {
        try {
          const created = await chatHistory.create();
          sessionIdRef.current = created.id;
          setSessionId(created.id);
        } catch (err) {
          console.warn("[useChat] 无法创建会话，产物暂存临时目录", err);
        }
      }
      const platformSessionId = sessionIdRef.current;

      // Build API message list from display messages.  A Hermes session is
      // reused only in the mode that created it; the server then holds the
      // history, so only the newest turn is sent (smaller prompts, no
      // duplicated context).  Any other mode replays the full history.
      // ``hermesSessionMode === null`` means "mode unknown / restored from
      // storage" and is reusable for agent turns so a reloaded chat continues
      // the recorded Hermes session.  Direct-LLM modes (provider=llm) have no
      // server-side agent context, so they still replay the full history.
      const reusableAcrossModes =
        hermesSessionMode === null && opts?.provider !== "llm";
      const sessionMatches =
        Boolean(hermesSessionId) &&
        (reusableAcrossModes || hermesSessionMode === (opts?.mode ?? null));
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
        // User pressed 停止, or a session switch superseded this turn — drop
        // late events instead of polluting the newly restored transcript.
        if (stoppedRef.current || turnTokenRef.current !== turnToken) return;
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
            // Persist the continuity token on the chat session right away so
            // a reload can continue this Hermes conversation.
            persistSessionLinks({ hermes_session_id: event.session_id });
            break;
          case "tool_call":
            produced = true;
            updateToolCalls(event.tool_calls);
            break;
          case "approval":
            // The agent is paused mid-turn: falling back now would start a
            // second run, so count this as output and surface errors instead.
            produced = true;
            // An SSE resume can replay a prompt we already answered — do not
            // resurrect it (a second resolution would be rejected upstream).
            if (
              event.approval.approvalId &&
              answeredApprovalIdsRef.current.has(event.approval.approvalId)
            ) {
              break;
            }
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
      const streamViaChat = async (
        chatMessages: ChatMessage[],
        reuseHermesSession: boolean,
      ) => {
        for await (const event of chatStream(chatMessages, {
          signal: controller.signal,
          mode: opts?.mode,
          model: opts?.model,
          timeWindowStart: opts?.timeWindowStart,
          timeWindowEnd: opts?.timeWindowEnd,
          hermesSessionId: reuseHermesSession ? hermesSessionId : null,
          chatSessionId: platformSessionId,
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
          chat_session_id: platformSessionId,
          conversation_history: history && history.length > 0 ? history : null,
          model: opts?.model ?? null,
          mode: opts?.mode ?? null,
        });
        runCreated = true;

        runIdRef.current = created.run_id;
        setActiveRunId(created.run_id);
        // Record the running run on the chat session (when one exists): a
        // reload can then reattach instead of silently abandoning it.
        persistSessionLinks({ active_run_id: created.run_id });
        if (created.session_id) {
          setHermesSessionId(created.session_id);
          setHermesSessionMode(opts?.mode ?? null);
          persistSessionLinks({ hermes_session_id: created.session_id });
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
        // Legacy/fallback inputs: when a recorded Hermes session turns out to
        // be gone, replay the transcript instead of sending only the newest
        // message (which would silently drop the context).
        let fallbackMessages = apiMessages;
        let fallbackReuseSession = sessionMatches;

        if (wantRuns) {
          try {
            await streamViaRuns();
            return;
          } catch (err) {
            if (controller.signal.aborted) return;
            // Only fall back when the turn never started: retrying through
            // /chat/stream after a run was admitted would execute it twice.
            if (produced || runCreated) throw err;
            if (sessionMatches) {
              fallbackMessages = messages
                .concat(userMsg)
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => ({
                  role: m.role as "user" | "assistant",
                  content: m.content,
                }));
              fallbackReuseSession = false;
            }
            console.warn(
              "[useChat] Runs API 不可用，回退到 /chat/stream",
              err,
            );
            runIdRef.current = null;
            setActiveRunId(null);
            setPendingApproval(null);
          }
        }
        await streamViaChat(fallbackMessages, fallbackReuseSession);
      } catch (err: unknown) {
        const stillCurrent = turnTokenRef.current === turnToken;
        if (
          (err instanceof DOMException && err.name === "AbortError") ||
          stoppedRef.current
        ) {
          // intentional cancel — no error to surface
        } else if (stillCurrent) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setMessages((prev) => [
            ...prev,
            {
              id: uid(),
              role: "error",
              content: msg,
            },
          ]);
          toast.error(`发送失败: ${msg}`);
        }
      } finally {
        // Only the newest turn may settle shared state: a session switch (or a
        // newer turn) may already own isStreaming / activeRunId.
        if (turnTokenRef.current === turnToken) {
          setIsStreaming(false);
          setActiveRunId(null);
          setPendingApproval(null);
          runIdRef.current = null;
        }
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
      } catch (err: unknown) {
        // Failure before / outside the stream loop (session bootstrap, message
        // construction, an unexpected throw inside the stream handlers).  Keep
        // the failure visible and always release the composer.
        if (turnTokenRef.current === turnToken) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "error", content: msg },
          ]);
          setIsStreaming(false);
          setActiveRunId(null);
          setPendingApproval(null);
          runIdRef.current = null;
          abortRef.current = null;
          toast.error(`发送失败: ${msg}`);
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
      persistSessionLinks,
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
    answeredApprovalIdsRef.current.clear();
    finishAssistant();
    // The run is being stopped, so it must no longer be reattachable.
    persistSessionLinks({ active_run_id: null });

    if (runId && stopSupported) {
      // Request the interrupt first, then drop our subscription.  The stop POST
      // is an independent request, so aborting the SSE fetch does not cancel
      // it — but Hermes starts interrupting the agent immediately either way.
      void chatRuns.stop(runId).catch(() => {
        // Already finished / expired — the abort below still cleans up.
      });
    }
    controller?.abort();
  }, [finishAssistant, persistSessionLinks]);

  /**
   * Tear down the local view of a run the server says is already over.
   *
   * Unlike {@link stopStreaming} this never POSTs ``/stop`` — the run finished
   * on its own (steer answered 409), so only the local subscription and the
   * reattach link need cleaning up.  Bumping the turn token stops the outgoing
   * ``sendMessage`` invocation from settling state a new turn already owns.
   */
  const settleEndedRun = useCallback(() => {
    stoppedRef.current = true;
    turnTokenRef.current += 1;
    cancelReattach();
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current = null;
    setIsStreaming(false);
    setActiveRunId(null);
    setPendingApproval(null);
    answeredApprovalIdsRef.current.clear();
    finishAssistant();
    persistSessionLinks({ active_run_id: null });
  }, [cancelReattach, finishAssistant, persistSessionLinks]);

  /**
   * Inject a supplementary instruction into the running agent
   * (``POST /runs/{id}/steer``).
   *
   * A 409 (``run_not_accepting_steer``) means the run finished between our last
   * event and this call: the local run is settled and ``reason: "ended"`` is
   * returned so the caller can resend the text as a normal turn.
   */
  const steerMessage = useCallback(
    async (content: string): Promise<ChatSteerResult> => {
      const input = content.trim();
      const runId = runIdRef.current;
      if (!input || !runId || !capabilitiesRef.current.steer) {
        return { ok: false, reason: "unavailable" };
      }
      try {
        const result = await chatRuns.steer(runId, input);
        if (result.accepted === false) {
          return { ok: false, reason: "error", message: "补充指令未被接受" };
        }
        return { ok: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof ApiError ? err.status : undefined;
        if (status === 409 || /run_not_accepting_steer/i.test(message)) {
          // The run finished between our last event and this call.  Only tear
          // down state if this run is still the active one — the user may have
          // pressed 停止 and started another turn while the request was in
          // flight, and that newer turn must not be aborted.
          const isActiveRun = runIdRef.current === runId;
          if (isActiveRun) settleEndedRun();
          // A null run id with no stop means the run ended on its own; the
          // local turn already settled, so the text can safely be resent.
          const endedNaturally = !isActiveRun && runIdRef.current === null && !stoppedRef.current;
          if (isActiveRun || endedNaturally) {
            return { ok: false, reason: "ended", message };
          }
          // Stop / session switch / a new run owns the UI: leave it alone and
          // let the user resend manually.
          return { ok: false, reason: "error", message };
        }
        setError(message);
        return { ok: false, reason: "error", message };
      }
    },
    [settleEndedRun],
  );

  /**
   * Answer the pending tool-approval prompt.
   *
   * The prompt is cleared as soon as a decision is submitted; on failure it is
   * restored so the user can retry.  Duplicate clicks for the same
   * ``request_id`` are ignored and resolve as success.
   *
   * @param decision once / session / always / deny.
   * @returns ``true`` when the backend accepted the decision.
   */
  const respondApproval = useCallback(
    async ({
      decision,
    }: {
      decision: ChatApprovalDecision;
    }): Promise<boolean> => {
      const runId = runIdRef.current;
      const pending = pendingApproval;
      if (!runId || !pending) return false;

      const requestId = pending.approvalId;
      if (requestId && answeredApprovalIdsRef.current.has(requestId)) {
        // Same request already answered — a duplicate click, not a new prompt.
        return true;
      }
      if (requestId) answeredApprovalIdsRef.current.add(requestId);

      setPendingApproval(null);
      setError(null);
      try {
        await chatRuns.approval(runId, pending.approvalId, decision);
        return true;
      } catch (err: unknown) {
        if (requestId) answeredApprovalIdsRef.current.delete(requestId);
        // Restore for a retry, unless a newer prompt already replaced it.
        setPendingApproval((current) => current ?? pending);
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [pendingApproval],
  );

  /** Clear all messages and cancel any in-flight stream. */
  const clearMessages = useCallback(() => {
    turnTokenRef.current += 1;
    abortRef.current?.abort();
    cancelReattach();
    stoppedRef.current = true;
    runIdRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    setIsStreaming(false);
    setSessionId(null);
    sessionIdRef.current = null;
    setHermesSessionId(null);
    setHermesSessionMode(null);
    setActiveRunId(null);
    setPendingApproval(null);
    answeredApprovalIdsRef.current.clear();
  }, [cancelReattach]);

  /** Load a saved session from the backend (restores its Hermes linkage). */
  const loadSession = useCallback(
    async (id: number) => {
      // Detach this tab from any running turn.  The Hermes run itself is NOT
      // stopped: it keeps executing server-side and the session keeps its
      // active_run_id, so returning to that chat can reattach to it.
      stoppedRef.current = true;
      turnTokenRef.current += 1;
      cancelReattach();
      abortRef.current?.abort();
      abortRef.current = null;
      runIdRef.current = null;
      setActiveRunId(null);
      setPendingApproval(null);
      answeredApprovalIdsRef.current.clear();
      setError(null);
      setIsStreaming(false);

      const detail = await chatHistory.get(id);

      const restored: DisplayMessage[] = detail.messages.map((m) => ({
        id: String(m.id),
        role: m.role as DisplayMessage["role"],
        content: m.content,
        toolCalls: (m.tool_calls as ToolCallDelta[] | undefined) ?? undefined,
      }));
      messagesRef.current = restored;
      setMessages(restored);
      setSessionId(id);
      sessionIdRef.current = id;

      // Adopt the recorded Hermes session instead of clearing it: the next turn
      // continues that agent session (no full-history replay).  A ``null`` mode
      // means "unknown after reload" and the matching logic treats it as
      // reusable; a chat with no recorded session falls back to full history.
      setHermesSessionId(detail.hermes_session_id ?? null);
      setHermesSessionMode(null);

      const linkedRun = detail.active_run_id ?? null;
      if (linkedRun) {
        // The run outlived the page: follow it through the Runs status API and
        // fold its result into the restored transcript.
        runReattachPoll(linkedRun);
      }
    },
    [cancelReattach, runReattachPoll],
  );

  /** Persist the current messages to the backend. */
  const saveCurrentSession = useCallback(async () => {
    const saveable = _saveableMessages(messages);
    if (saveable.length === 0) return;

    const title = _titleForMessages(messages);
    // Always send both links (``null`` clears): a finished turn must not leave
    // a stale active_run_id behind that the UI would try to reattach to.
    const links = {
      hermes_session_id: hermesSessionId,
      active_run_id: activeRunId,
    };

    if (sessionId) {
      const target = sessionId;
      await enqueueSessionWrite(async () => {
        await chatHistory.saveMessages(target, saveable, title, links);
      });
    } else {
      const createdId = await enqueueSessionWrite(async () => {
        const created = await chatHistory.create();
        await chatHistory.saveMessages(created.id, saveable, title, links);
        return created.id;
      });
      if (createdId !== undefined) {
        setSessionId(createdId);
        sessionIdRef.current = createdId;
      }
    }
  }, [messages, sessionId, hermesSessionId, activeRunId, enqueueSessionWrite]);

  // Keep the async save bridges pointed at the latest committed state.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // No abort-on-unmount: a Hermes run is a server-side resource the user
  // expects to keep running when navigating away (reload → reattach via the
  // active_run_id persisted on the chat session).  Only the reattach poll is
  // torn down here — the run stream itself is intentionally left alone.
  useEffect(() => () => cancelReattach(), [cancelReattach]);

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

/** Shape of ``GET /api/chat/hermes-capabilities`` (non-admin probe). */
interface ChatCapabilitiesResponse {
  run_submission?: boolean;
  run_stop?: boolean;
  run_steer?: boolean;
  run_approval_response?: boolean;
  tool_progress_events?: boolean;
  chat_completions_streaming?: boolean;
  session_continuity_header?: string | boolean | null;
}

/**
 * Probe the non-admin capability endpoint.
 *
 * Uses ``fetch`` directly because the shared API wrapper is generated around
 * the admin self-report; this endpoint only exposes booleans.  Returns ``null``
 * on any failure so the caller can switch every capability off.
 */
async function probeRunCapabilities(
  signal?: AbortSignal,
): Promise<ChatRunCapabilities | null> {
  const headers: Record<string, string> = {};
  try {
    const token = localStorage.getItem("liumai_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // Storage unavailable (private mode) — still try an unauthenticated probe.
  }

  const res = await fetch("/api/chat/hermes-capabilities", { headers, signal });
  if (!res.ok) return null;

  const data = (await res.json()) as ChatCapabilitiesResponse;
  return {
    runs: data.run_submission === true,
    stop: data.run_stop === true,
    steer: data.run_steer === true,
    approval: data.run_approval_response === true,
  };
}

/** Heuristic: does the JSON argument string look like a complete object? */
function _looksComplete(args: string): boolean {
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

/** Persistable messages (``error`` bubbles are UI-only). */
function _saveableMessages(
  messages: DisplayMessage[],
): Array<{ role: string; content: string; tool_calls?: ToolCallDelta[] }> {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
    .map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.toolCalls ?? undefined,
    }));
}

/** Session title derived from the first user message. */
function _titleForMessages(messages: DisplayMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "新对话";
  const { content } = firstUser;
  return content.slice(0, 40) + (content.length > 40 ? "…" : "");
}

/**
 * Merge a reattached run's final output into the transcript.
 *
 * When the saved transcript ends with a prefix of the run's output (a partial
 * turn captured mid-stream) that bubble is completed in place; when the output
 * is already present the transcript is untouched; otherwise it is appended.
 */
function _withRunOutput(
  messages: DisplayMessage[],
  output: string,
): DisplayMessage[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) {
    return [
      ...messages,
      { id: uid(), role: "assistant", content: output },
    ];
  }
  const last = messages[lastAssistant];
  if (last.content === output) return messages;
  if (last.content.length === 0 || output.startsWith(last.content)) {
    const next = [...messages];
    next[lastAssistant] = { ...last, content: output, isStreaming: false };
    return next;
  }
  return [
    ...messages,
    { id: uid(), role: "assistant", content: output },
  ];
}
