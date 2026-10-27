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
  applyToolCallDeltas,
  chatHistory,
  chatRuns,
  chatRunEvents,
  chatRunUsage,
  chatStream,
  collapseDuplicateReasoning,
  ReasoningDeduper,
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

/**
 * How long Hermes keeps a run's SSE backlog.  Re-subscribing with the last
 * event id is only worthwhile inside this window; after it the replay would be
 * truncated, so the recovery path falls back to polling ``run-state``.
 */
const RUN_EVENT_REPLAY_TTL_MS = 5 * 60 * 1000;

/**
 * Poll cadence for ``GET /sessions/{id}/run-state`` after a page return.  Kept
 * short so the answer visibly keeps growing when the SSE resume is unavailable
 * (Hermes' replay window expired, or the run finished while we were away).
 */
const RUN_STATE_POLL_MS = 1500;

/** Stop polling an unreachable run after ~2 minutes (40 × 3s). */
const RUN_STATE_MAX_UNKNOWN_POLLS = 40;

/** Persist the in-flight assistant text at most this often (ms). */
const PARTIAL_SAVE_INTERVAL_MS = 5000;

/** localStorage keys for the run resume cursor and last visited session. */
const RUN_SEQ_KEY_PREFIX = "liumai:run-seq:";
const RUN_SEQ_AT_KEY_PREFIX = "liumai:run-seq-at:";
const LAST_SESSION_KEY = "liumai:last-session";

/** Read the last SSE sequence number persisted for a run (``null`` if none). */
function _readRunSeq(runId: string): { seq: number; at: number } | null {
  try {
    const rawSeq = localStorage.getItem(`${RUN_SEQ_KEY_PREFIX}${runId}`);
    if (rawSeq === null) return null;
    const seq = Number(rawSeq);
    if (!Number.isFinite(seq) || seq < 0) return null;
    const rawAt = Number(localStorage.getItem(`${RUN_SEQ_AT_KEY_PREFIX}${runId}`) ?? 0);
    return { seq, at: Number.isFinite(rawAt) ? rawAt : 0 };
  } catch {
    return null;
  }
}

/** Remember the newest SSE sequence number seen for a run. */
function _writeRunSeq(runId: string, seq: number): void {
  try {
    localStorage.setItem(`${RUN_SEQ_KEY_PREFIX}${runId}`, String(seq));
    localStorage.setItem(`${RUN_SEQ_AT_KEY_PREFIX}${runId}`, String(Date.now()));
  } catch {
    /* storage unavailable (private mode) — recovery falls back to polling */
  }
}

/** Drop the resume cursor once a run is final. */
function _clearRunSeq(runId: string): void {
  try {
    localStorage.removeItem(`${RUN_SEQ_KEY_PREFIX}${runId}`);
    localStorage.removeItem(`${RUN_SEQ_AT_KEY_PREFIX}${runId}`);
  } catch {
    /* ignore */
  }
}

/** Highest ``hermes_seq`` in a tool message (falls back to its position). */
function _toolSeq(message: DisplayMessage): number | null {
  const seq = message.toolCalls?.[0]?.hermes_seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

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
  /**
   * True while the transcript was restored from the backend and we are
   * reattaching to a run that kept executing server-side (page switch /
   * reload).  Drives the "正在继续执行…" status bar.
   */
  const [recoveringRun, setRecoveringRun] = useState(false);
  /** Pending tool-approval prompt for the active run. */
  const [pendingApproval, setPendingApproval] = useState<ChatApprovalRequest | null>(null);
  /** Probed server capabilities (see {@link ChatRunCapabilities}). */
  const [runCapabilities, setRunCapabilities] = useState<ChatRunCapabilities>(
    DEFAULT_RUN_CAPABILITIES,
  );

  const abortRef = useRef<AbortController | null>(null);
  /**
   * Synchronous reasoning accumulator for this turn.  It is a deduper (not
   * plain React state) because two events can arrive in the same tick: both
   * must see the text accepted so far, or the first sentence is appended
   * twice.  It also buffers replays that arrive split across chunks.
   */
  const reasoningDeduperRef = useRef<ReasoningDeduper | null>(null);
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
  /** Latest Hermes linkage / run id for the partial-save bridge. */
  const hermesSessionIdRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const isStreamingRef = useRef(false);
  /** Highest tool sequence number handed out this turn (first-seen order). */
  const toolSeqRef = useRef(0);
  /**
   * Arrival counter for tool calls the wire does not identify.  It is consumed
   * only when neither ``tool_call_id`` nor a frame sequence exists, so each
   * such call gets its own stable key instead of collapsing under its name.
   */
  const toolArrivalRef = useRef(0);
  /** Timer holding the 5s partial-save cadence for the current turn. */
  const partialSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Newest run event sequence applied to React state.  It is written to
   * localStorage only *after* the matching transcript snapshot is persisted,
   * so a resume cursor can never be ahead of the saved partial answer.
   */
  const pendingSeqRef = useRef<number | null>(null);
  /**
   * True when the current turn was detached by a route change / unmount
   * (the Hermes run keeps executing).  The turn's ``finally`` must then keep
   * the active_run_id link instead of clearing it as a finished run.
   */
  const detachedRef = useRef(false);
  /**
   * Assistant bubble a restored run keeps appending into.  The saved partial
   * turn may end with tool rows, so "last message" is not the right target.
   */
  const resumeAssistantIdRef = useRef<string | null>(null);
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
  /**
   * Replay guard for a reattached run whose event stream is resubscribed from
   * the beginning (no saved seq cursor).  ``baseline`` is the text the restored
   * bubble already shows and ``acc`` accumulates the replayed chunks until they
   * catch up — without it the replay appended the whole answer a second time.
   * Kept in a ref and updated *outside* ``setMessages``: StrictMode
   * double-invokes state updaters in development, which would double ``acc``.
   */
  const replayRef = useRef<{
    baseline: string;
    acc: string;
    startedAt: number;
  } | null>(null);

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

  /**
   * Reset the per-turn reasoning accumulator.
   *
   * Called when a turn starts, is stopped, or the transcript is switched /
   * cleared: a stale accumulator would make the next turn's first reasoning
   * block look like a replay (or let a late event append to the new turn).
   */
  const resetReasoningAccumulator = useCallback(() => {
    reasoningDeduperRef.current?.reset();
  }, []);

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
   * Append a text chunk to the current assistant bubble (or create one).
   *
   * ``snapshot`` marks a whole-block payload (Hermes ``message.interim``) that
   * repeats text already streamed as ``message.delta``; merging rules live in
   * {@link _mergeAssistantChunk}, so the same sentence is never rendered twice.
   */
  const appendToAssistant = useCallback((content: string, snapshot = false) => {
    if (!content) return;

    // Replay guard for a run resubscribed from seq 0: the replayed chunks
    // repeat what the restored bubble already shows, so hold them until they
    // catch up and then continue with plain appends.  Computed outside the
    // state updater because the accumulator is mutable (StrictMode).
    let replayed: string | null = null;
    const replay = replayRef.current;
    if (replay) {
      replay.acc += content;
      const caughtUp = replay.acc.length > replay.baseline.length;
      if (!caughtUp) {
        // Still inside the replayed prefix.  Give up when the replay is clearly
        // truncated (Hermes only keeps ~5 min): guessing would duplicate text,
        // so the terminal reconciliation applies the server output instead.
        if (Date.now() - replay.startedAt <= REPLAY_CATCHUP_MAX_MS) return;
        replayRef.current = null;
        return;
      }
      replayRef.current = null;
      replayed = replay.acc.startsWith(replay.baseline)
        ? replay.acc
        : replay.baseline +
          replay.acc.slice(_commonPrefixLength(replay.acc, replay.baseline));
    }

    setMessages((prev) => {
      // A restored run must keep writing into the bubble it was streaming
      // into, even when the saved partial turn ends with tool rows.
      let index = -1;
      const resumeId = resumeAssistantIdRef.current;
      if (resumeId) {
        index = prev.findIndex((m) => m.id === resumeId);
        if (index < 0) resumeAssistantIdRef.current = null;
      }
      if (index < 0) {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          index = prev.length - 1;
        }
      }
      if (index < 0) {
        const created: DisplayMessage = {
          id: uid(),
          role: "assistant",
          content: replayed ?? content,
          isStreaming: true,
        };
        return [...prev, created];
      }
      const target = prev[index];
      const nextContent =
        replayed ?? _mergeAssistantChunk(target.content ?? "", content, snapshot);
      if (nextContent === null) return prev;
      const next = [...prev];
      next[index] = { ...target, content: nextContent, isStreaming: true };
      return next;
    });
  }, []);

  /**
   * Start replay mode for a reattached run's stream: remember what the restored
   * bubble already shows so the replayed deltas can be absorbed instead of
   * appended (see ``replayRef``).
   */
  const beginReplayFromStart = useCallback(() => {
    const resumeId = resumeAssistantIdRef.current;
    const target = resumeId
      ? messagesRef.current.find((m) => m.id === resumeId)
      : undefined;
    replayRef.current = {
      baseline: target?.content ?? "",
      acc: "",
      startedAt: Date.now(),
    };
  }, []);

  /**
   * Collapse a doubled tail before a turn is settled.
   *
   * Two sources can stream the same text (``message.delta`` + ``message.interim``
   * , or a replay that slipped past the guards), and the runs were long enough
   * that per-chunk comparison cannot catch them.  Only an exact duplicated
   * tail block is removed, so genuine repetition in the answer survives.
   */
  const collapseDoubledTail = useCallback(() => {
    setMessages((prev) => {
      for (let index = prev.length - 1; index >= 0; index -= 1) {
        if (prev[index].role !== "assistant") continue;
        const text = prev[index].content ?? "";
        const collapsed = _collapseDoubledTail(text);
        if (collapsed === text) return prev;
        const next = [...prev];
        next[index] = { ...next[index], content: collapsed };
        return next;
      }
      return prev;
    });
  }, []);

  /**
   * Append a reasoning chunk to the current assistant turn.
   *
   * Reasoning arrives before the answer; it is kept on the message so the UI
   * can show a collapsible "思考过程" section instead of blending it into the
   * final text.
   *
   * ``replace`` marks a whole-block snapshot (Hermes ``reasoning.available``)
   * rather than an incremental delta.  Both forms go through the same
   * content-level guard: a snapshot that repeats / extends what we already
   * have contributes only its unseen suffix, so repeated snapshots cannot
   * duplicate every sentence, while earlier reasoning rounds are never
   * overwritten (``replace`` used to discard them).
   */
  const appendReasoning = useCallback((content: string, replace = false) => {
    if (!content) return;
    // One deduper per turn, held in a ref: React state updates are batched, so
    // two events delivered in the same tick (e.g. a delta + its snapshot) used
    // to read the same stale value and both append the first sentence.
    const deduper =
      reasoningDeduperRef.current ??
      (reasoningDeduperRef.current = new ReasoningDeduper());
    const fresh = deduper.feed(content);
    if (!fresh) return;
    // Adjacent duplicates can arrive *inside* one block (two sources, a replay
    // split across chunks).  Compact before writing state so the visible text
    // and the saved transcript never carry them; the deduper baseline is
    // compacted too, keeping later replay detection accurate.
    deduper.compact();
    const next = deduper.text;
    setMessages((prev) => {
      const resumeId = resumeAssistantIdRef.current;
      if (resumeId) {
        const resumeIndex = prev.findIndex((m) => m.id === resumeId);
        if (resumeIndex >= 0) {
          const updated = [...prev];
          updated[resumeIndex] = {
            ...updated[resumeIndex],
            reasoning: next,
            isStreaming: true,
          };
          return updated;
        }
        resumeAssistantIdRef.current = null;
      }
      const last = prev[prev.length - 1];
      const streaming =
        last && last.role === "assistant" && last.isStreaming ? last : null;
      const target =
        streaming ??
        (replace && last && last.role === "assistant" ? last : null);
      if (target) {
        const index = prev.lastIndexOf(target);
        return [...prev.slice(0, index), { ...target, reasoning: next }];
      }
      return [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: "",
          reasoning: next,
          isStreaming: true,
        },
      ];
    });
  }, []);

  /** Insert or update tool-call messages as separate, visible cards.
   *
   * Every execution owns exactly ONE message for its whole lifecycle, keyed by
   * its wire ``tool_call_id``.  When Hermes omits that id the aggregator falls
   * back to the frame ``seq`` or a per-turn arrival ordinal — never to the tool
   * name, which would merge repeated ``terminal`` / ``execute_code`` calls into
   * a single card.  The matching / merge / ordering rules live in
   * {@link applyToolCallDeltas} so they are unit-testable without React.
   */
  const updateToolCalls = useCallback((toolCalls: ToolCallDelta[]) => {
    if (toolCalls.length === 0) return;
    setMessages((prev) =>
      applyToolCallDeltas(prev, toolCalls, {
        nextSeq: () => ++toolSeqRef.current,
        nextArrival: () => ++toolArrivalRef.current,
        createRow: (row) => row as DisplayMessage,
      }),
    );
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

  /**
   * Point the restored run's stream at the assistant bubble it was writing
   * into.  A saved partial turn often ends with tool rows, so events must keep
   * appending to that bubble instead of creating a second answer after them.
   */
  const markRestoredAssistantStreaming = useCallback(() => {
    setMessages((prev) => {
      // Only an assistant bubble belonging to the CURRENT (latest) user turn
      // may receive the recovered deltas.  Falling back to the previous turn's
      // answer merged a new run's output into an unrelated old bubble.
      let lastUser = -1;
      for (let index = prev.length - 1; index >= 0; index -= 1) {
        if (prev[index].role === "user") {
          lastUser = index;
          break;
        }
      }
      let index = -1;
      for (let cursor = prev.length - 1; cursor > lastUser; cursor -= 1) {
        if (prev[cursor].role === "assistant") {
          index = cursor;
          break;
        }
      }
      if (index >= 0) {
        const updated = [...prev];
        updated[index] = { ...updated[index], isStreaming: true };
        resumeAssistantIdRef.current = updated[index].id;
        messagesRef.current = updated;
        return updated;
      }
      const created: DisplayMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        isStreaming: true,
      };
      resumeAssistantIdRef.current = created.id;
      const updated = [...prev, created];
      messagesRef.current = updated;
      return updated;
    });
  }, []);

  /** Dispatch one normalised run event onto React state (live + recovery). */
  const dispatchRunEvent = useCallback(
    (event: ChatRunEvent, turnToken: number) => {
      // User pressed 停止, or a session switch superseded this turn — drop late
      // events instead of polluting the newly restored transcript.
      if (stoppedRef.current || turnTokenRef.current !== turnToken) return;
      switch (event.type) {
        case "delta":
          // ``snapshot`` payloads (``message.interim``) restate text that has
          // already been streamed — merge instead of appending verbatim.
          appendToAssistant(event.content, event.snapshot === true);
          break;
        case "reasoning":
          appendReasoning(event.content, event.replace === true);
          break;
        case "session":
          setHermesSessionId(event.session_id);
          hermesSessionIdRef.current = event.session_id;
          persistSessionLinks({ hermes_session_id: event.session_id });
          break;
        case "tool_call":
          updateToolCalls(event.tool_calls);
          break;
        case "approval":
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
          // Last line of defence against a doubled answer before it is shown
          // as final (and saved).
          collapseDoubledTail();
          finishAssistant();
          break;
        case "error":
          setError(event.error);
          collapseDoubledTail();
          finishAssistant();
          break;
      }
    },
    [
      appendReasoning,
      appendToAssistant,
      attachUsage,
      collapseDoubledTail,
      finishAssistant,
      persistSessionLinks,
      updateToolCalls,
    ],
  );

  /** Persist the in-flight transcript now (5s cadence + page visibility). */
  const saveStreamingSnapshot = useCallback(
    (force = false) => {
      if (!force && !isStreamingRef.current && !activeRunIdRef.current) return;
      const target = sessionIdRef.current;
      if (!target) return;
      const saveable = _saveableMessages(messagesRef.current);
      if (saveable.length === 0) return;
      const title = _titleForMessages(messagesRef.current);
      const links = {
        hermes_session_id: hermesSessionIdRef.current,
        active_run_id: activeRunIdRef.current,
      };
      const seq = pendingSeqRef.current;
      const runId = activeRunIdRef.current;
      void enqueueSessionWrite(async () => {
        await chatHistory.saveMessages(target, saveable, title, links);
        // Advance the resume cursor only after the transcript carrying those
        // events is stored, so a reattach cannot skip un-persisted content.
        if (runId && seq !== null) _writeRunSeq(runId, seq);
      });
    },
    [enqueueSessionWrite],
  );

  /** Tear down a recovered run, merging its final output and clearing the link. */
  const settleRecoveredRun = useCallback(
    (runId: string | null, opts?: { output?: string; error?: string }) => {
      cancelReattach();
      abortRef.current?.abort();
      abortRef.current = null;
      runIdRef.current = null;
      activeRunIdRef.current = null;
      resumeAssistantIdRef.current = null;
      pendingSeqRef.current = null;
      replayRef.current = null;
      setActiveRunId(null);
      setIsStreaming(false);
      setRecoveringRun(false);
      setPendingApproval(null);
      if (opts?.error) setError(opts.error);
      const output = opts?.output?.trim() ?? "";
      if (output) appendReattachedOutput(output);
      finishAssistant();
      if (runId) _clearRunSeq(runId);
      // Write the completed transcript and drop the stale run link in one
      // write, so a further reload does not reattach to a finished run.
      persistSessionLinks({ active_run_id: null });
    },
    [appendReattachedOutput, cancelReattach, finishAssistant, persistSessionLinks],
  );

  /**
   * Show a polled run's progress text inside the assistant bubble.
   *
   * Replace-only: the Runs API ``output`` is the complete text produced so far,
   * so it can only ever *replace* the bubble (never append).  Without this the
   * UI stayed frozen after a page switch until the run finished.
   */
  const applyProgressOutput = useCallback((output: string) => {
    const text = output.trim();
    if (!text) return;
    const result = _mergeAuthoritativeRunOutput(messagesRef.current, text);
    if (result.messages === messagesRef.current) return;
    messagesRef.current = result.messages;
    setMessages(result.messages);
  }, []);

  /** Poll ``run-state`` every 3s until a recovered run reaches a final state. */
  const pollRunState = useCallback(
    (runId: string) => {
      cancelReattach();
      resetReasoningAccumulator();
      const token = reattachTokenRef.current;
      runIdRef.current = runId;
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      setIsStreaming(true);
      setRecoveringRun(true);
      stoppedRef.current = false;
      let unknownPolls = 0;

      const tick = async () => {
        if (reattachTokenRef.current !== token) return;
        const session = sessionIdRef.current;
        if (!session) {
          settleRecoveredRun(runId, { error: "无法恢复执行状态：会话不存在" });
          return;
        }

        let state: Awaited<ReturnType<typeof chatHistory.runState>>;
        try {
          state = await chatHistory.runState(session);
        } catch {
          unknownPolls += 1;
          if (unknownPolls > RUN_STATE_MAX_UNKNOWN_POLLS) {
            settleRecoveredRun(runId, {
              error: "Hermes 无响应，已停止同步执行状态",
            });
            return;
          }
          reattachTimerRef.current = setTimeout(() => void tick(), RUN_STATE_POLL_MS);
          return;
        }
        if (reattachTokenRef.current !== token) return;

        if (state.hermes_session_id && !hermesSessionIdRef.current) {
          hermesSessionIdRef.current = state.hermes_session_id;
          setHermesSessionId(state.hermes_session_id);
        }

        const status = (state.status || "").toUpperCase();
        // Keep the visible answer growing while the run is still working: the
        // run-state ``output`` is the complete text so far, so it replaces the
        // bubble instead of appending (idempotent on every poll).
        if (status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED") {
          if (state.output) applyProgressOutput(state.output);
        }
        if (status === "COMPLETED") {
          settleRecoveredRun(runId, { output: state.output });
          return;
        }
        if (status === "FAILED") {
          settleRecoveredRun(runId, {
            output: state.output,
            error: "任务执行失败",
          });
          return;
        }
        if (status === "CANCELLED") {
          settleRecoveredRun(runId, { output: state.output });
          return;
        }
        if (!state.active_run_id) {
          // The link was cleared elsewhere: merge whatever output exists.
          settleRecoveredRun(runId, { output: state.output });
          return;
        }
        if (status === "UNKNOWN") {
          unknownPolls += 1;
          if (unknownPolls > RUN_STATE_MAX_UNKNOWN_POLLS) {
            settleRecoveredRun(runId, {
              error: "Hermes 无响应，已停止同步执行状态",
            });
            return;
          }
        } else {
          unknownPolls = 0;
        }
        reattachTimerRef.current = setTimeout(() => void tick(), RUN_STATE_POLL_MS);
      };

      void tick();
    },
    [applyProgressOutput, cancelReattach, resetReasoningAccumulator, settleRecoveredRun],
  );

  /**
   * Prefer an SSE re-subscription (with ``Last-Event-ID``) within Hermes'
   * replay TTL; otherwise — or when the subscription fails — poll run-state.
   */
  const resumeRunEvents = useCallback(
    async (
      runId: string,
      lastSeq: number | null,
      token: number,
      replayFromStart = false,
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const turnToken = turnTokenRef.current;
      let terminal = false;
      pendingSeqRef.current = lastSeq;
      // Resubscribed without a cursor: Hermes replays the whole run, so absorb
      // the replayed deltas against the text the restored bubble already shows
      // instead of appending them twice.
      if (replayFromStart) beginReplayFromStart();
      // Persist the replayed transcript on the same 5s cadence as a live turn
      // so a second page switch keeps making progress instead of replaying.
      const saveTimer = setInterval(() => {
        saveStreamingSnapshot(true);
      }, PARTIAL_SAVE_INTERVAL_MS);
      try {
        for await (const event of chatRunEvents(runId, {
          signal: controller.signal,
          lastEventId: lastSeq,
        })) {
          if (reattachTokenRef.current !== token) return;
          if (typeof event.seq === "number") pendingSeqRef.current = event.seq;
          dispatchRunEvent(event, turnToken);
          if (event.type === "done" || event.type === "error") terminal = true;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("[useChat] Runs 事件恢复失败，改用轮询", err);
      } finally {
        clearInterval(saveTimer);
        if (abortRef.current === controller) abortRef.current = null;
      }
      if (reattachTokenRef.current !== token) return;
      if (terminal) {
        settleRecoveredRun(runId);
      } else {
        // Subscription closed without a terminal event (TTL / truncation):
        // fall back to the pollable run-state endpoint.
        pollRunState(runId);
      }
    },
    [beginReplayFromStart, dispatchRunEvent, pollRunState, saveStreamingSnapshot, settleRecoveredRun],
  );

  /** Reattach to a run recorded on a restored chat session. */
  const reattachRun = useCallback(
    (runId: string) => {
      cancelReattach();
      resetReasoningAccumulator();
      stoppedRef.current = false;
      markRestoredAssistantStreaming();
      runIdRef.current = runId;
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      setIsStreaming(true);
      setRecoveringRun(true);

      const token = reattachTokenRef.current;
      const saved = _readRunSeq(runId);
      const withinTtl =
        saved !== null && Date.now() - saved.at <= RUN_EVENT_REPLAY_TTL_MS;
      if (saved === null || withinTtl) {
        // SSE is the only path that keeps the answer growing in real time after
        // a page switch.  A cursor-less resume replays from the beginning and
        // is absorbed against the restored text (``replayRef``); a run Hermes
        // has already expired in turn 404s and falls back to polling below.
        void resumeRunEvents(runId, saved?.seq ?? null, token, saved === null);
      } else {
        void pollRunState(runId);
      }
    },
    [
      cancelReattach,
      markRestoredAssistantStreaming,
      pollRunState,
      resetReasoningAccumulator,
      resumeRunEvents,
    ],
  );

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
      setRecoveringRun(false);
      runIdRef.current = null;
      activeRunIdRef.current = null;
      isStreamingRef.current = true;
      resumeAssistantIdRef.current = null;
      pendingSeqRef.current = null;
      replayRef.current = null;
      detachedRef.current = false;
      toolSeqRef.current = 0;
      toolArrivalRef.current = 0;
      // New turn: reset the synchronous reasoning accumulator so a replayed
      // first chunk from a second source cannot be appended twice.
      resetReasoningAccumulator();
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
          try {
            localStorage.setItem(LAST_SESSION_KEY, String(created.id));
          } catch {
            /* private mode */
          }
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
      // Persist the in-flight transcript on a 5s cadence: a reload / page
      // switch must not lose everything Hermes already produced.  The final
      // autosave still runs when streaming finishes.
      if (partialSaveTimerRef.current !== null) {
        clearInterval(partialSaveTimerRef.current);
      }
      partialSaveTimerRef.current = setInterval(() => {
        saveStreamingSnapshot(true);
      }, PARTIAL_SAVE_INTERVAL_MS);

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
        if (stoppedRef.current || turnTokenRef.current !== turnToken) return;
        switch (event.type) {
          case "delta":
          case "reasoning":
          case "tool_call":
            produced = true;
            break;
          case "session":
            setHermesSessionMode(opts?.mode ?? null);
            break;
          case "approval":
            // The agent is paused mid-turn: falling back now would start a
            // second run, so count this as output and surface errors instead.
            produced = true;
            break;
        }
        // Remember how far the run stream got.  The cursor is persisted after
        // the next transcript snapshot (see ``saveStreamingSnapshot``), so a
        // page switch resumes SSE without skipping un-saved deltas.
        if (typeof event.seq === "number" && runIdRef.current) {
          pendingSeqRef.current = event.seq;
        }
        dispatchRunEvent(event, turnToken);
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

      /**
       * Authoritative terminal reconciliation for a Runs-API turn.
       *
       * The SSE stream is a best-effort *view*: Hermes may deliver fewer
       * ``message.delta`` frames than its final answer (observed with long
       * agent turns), and a dropped subscription can truncate the tail while
       * the run itself completed.  Once the stream reaches a terminal event —
       * or simply closes — ask ``GET /runs/{id}`` for the server's own
       * ``status`` / ``output`` / ``usage`` and treat that as the truth:
       *
       * - output longer than the rendered assistant text (or rendered text
       *   still empty) replaces that body in place, keeping reasoning separate;
       * - a failed / cancelled / interrupted run surfaces an error even when
       *   the stream closed without one;
       * - the reconciled transcript is persisted immediately.
       *
       * On failure the current transcript is left untouched (the stream path
       * never depended on this call).
       */
      const reconcileRun = async (runId: string, fallbackOutput = "") => {
        if (stoppedRef.current || turnTokenRef.current !== turnToken) return;

        let state: Awaited<ReturnType<typeof chatRuns.status>> | null = null;
        try {
          state = await chatRuns.status(runId);
        } catch (err) {
          // Keep whatever the stream produced; the done frame's output (when
          // present) is still applied as a fallback below.
          console.warn("[useChat] 终态对账失败，保留流式内容", err);
        }
        if (stoppedRef.current || turnTokenRef.current !== turnToken) return;
        if (runIdRef.current && runIdRef.current !== runId) return;

        const statusText = state
          ? String(state.status || "").toUpperCase()
          : "UNAVAILABLE";
        const serverOutput =
          typeof state?.output === "string" ? state.output : "";
        const output = serverOutput || fallbackOutput;
        const usage = chatRunUsage(state?.usage);
        // A COMPLETED run's ``output`` is the authoritative answer: take it even
        // when it is *shorter* than what the stream rendered, which is how a
        // doubled / replayed body gets corrected instead of kept.
        const result = _mergeAuthoritativeRunOutput(
          messagesRef.current,
          output,
          usage,
          statusText === "COMPLETED",
        );

        console.info("[chat] reconciled", {
          runId,
          status: statusText,
          outLen: output.trim().length,
          curLen: result.currentLength,
        });

        if (result.messages !== messagesRef.current) {
          messagesRef.current = result.messages;
          setMessages(result.messages);
          if (result.replaced) {
            // The final answer arrived after the transcript was already drawn:
            // follow it down so the complete answer is visible without a
            // manual scroll.
            window.dispatchEvent(new CustomEvent("chat:scroll-bottom"));
          }
          // Persist the authoritative body now instead of waiting for the
          // post-turn autosave (which may race with this update).
          saveStreamingSnapshot(true);
        }

        if (statusText === "FAILED") {
          setError(state?.error || "任务执行失败");
        } else if (statusText === "CANCELLED") {
          setError("任务已取消");
        } else if (statusText === "INTERRUPTED") {
          setError("任务已中断");
        }
      };

      /** Runs path: create → subscribe → resume on drop → reconcile. */
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
        activeRunIdRef.current = created.run_id;
        setActiveRunId(created.run_id);
        // Record the running run on the chat session (when one exists): a
        // reload can then reattach instead of silently abandoning it.
        persistSessionLinks({ active_run_id: created.run_id });
        if (platformSessionId) {
          try {
            localStorage.setItem(LAST_SESSION_KEY, String(platformSessionId));
          } catch {
            /* private mode */
          }
        }
        if (created.session_id) {
          setHermesSessionId(created.session_id);
          hermesSessionIdRef.current = created.session_id;
          setHermesSessionMode(opts?.mode ?? null);
          persistSessionLinks({ hermes_session_id: created.session_id });
        }

        let lastSeq: number | null = null;
        let attempt = 0;
        /** Authoritative answer carried by a terminal frame (GET fallback). */
        let terminalOutput = "";
        while (true) {
          try {
            for await (const event of chatRunEvents(created.run_id, {
              signal: controller.signal,
              lastEventId: lastSeq,
            })) {
              if (typeof event.seq === "number") lastSeq = event.seq;
              if (event.type === "done" || event.type === "error") {
                if (event.output) terminalOutput = event.output;
              }
              applyEvent(event);
            }
            // Stream closed (terminal run event received, or the subscription
            // ended).  Fall through to the authoritative reconciliation.
            break;
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

        // The stream is only a preview: the run's own terminal state decides
        // what the transcript shows and what gets saved.
        await reconcileRun(created.run_id, terminalOutput);
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
          if (partialSaveTimerRef.current !== null) {
            clearInterval(partialSaveTimerRef.current);
            partialSaveTimerRef.current = null;
          }
          const finishedRunId = runIdRef.current;
          setIsStreaming(false);
          setRecoveringRun(false);
          isStreamingRef.current = false;
          setActiveRunId(null);
          activeRunIdRef.current = null;
          setPendingApproval(null);
          runIdRef.current = null;
          resumeAssistantIdRef.current = null;
          pendingSeqRef.current = null;
          replayRef.current = null;
          if (finishedRunId) {
            // A naturally finished run must not remain reattachable.  A turn
            // detached by a route change (``detachedRef``) keeps its link: the
            // agent is still executing and the next visit resumes it.
            if (!detachedRef.current) {
              _clearRunSeq(finishedRunId);
              persistSessionLinks({ active_run_id: null });
            }
          }
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
          if (partialSaveTimerRef.current !== null) {
            clearInterval(partialSaveTimerRef.current);
            partialSaveTimerRef.current = null;
          }
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setMessages((prev) => [
            ...prev,
            { id: uid(), role: "error", content: msg },
          ]);
          setIsStreaming(false);
          isStreamingRef.current = false;
          setRecoveringRun(false);
          setActiveRunId(null);
          activeRunIdRef.current = null;
          setPendingApproval(null);
          runIdRef.current = null;
          resumeAssistantIdRef.current = null;
          pendingSeqRef.current = null;
          replayRef.current = null;
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
      dispatchRunEvent,
      saveStreamingSnapshot,
      persistSessionLinks,
      resetReasoningAccumulator,
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
    activeRunIdRef.current = null;
    isStreamingRef.current = false;
    resumeAssistantIdRef.current = null;
    pendingSeqRef.current = null;
    replayRef.current = null;
    if (partialSaveTimerRef.current !== null) {
      clearInterval(partialSaveTimerRef.current);
      partialSaveTimerRef.current = null;
    }
    if (runId) _clearRunSeq(runId);
    resetReasoningAccumulator();
    setIsStreaming(false);
    setRecoveringRun(false);
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
  }, [finishAssistant, persistSessionLinks, resetReasoningAccumulator]);

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
    const endedRunId = runIdRef.current;
    runIdRef.current = null;
    activeRunIdRef.current = null;
    isStreamingRef.current = false;
    resumeAssistantIdRef.current = null;
    pendingSeqRef.current = null;
    replayRef.current = null;
    if (partialSaveTimerRef.current !== null) {
      clearInterval(partialSaveTimerRef.current);
      partialSaveTimerRef.current = null;
    }
    if (endedRunId) _clearRunSeq(endedRunId);
    resetReasoningAccumulator();
    setIsStreaming(false);
    setRecoveringRun(false);
    setActiveRunId(null);
    setPendingApproval(null);
    answeredApprovalIdsRef.current.clear();
    finishAssistant();
    persistSessionLinks({ active_run_id: null });
  }, [cancelReattach, finishAssistant, persistSessionLinks, resetReasoningAccumulator]);

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
    abortRef.current = null;
    cancelReattach();
    stoppedRef.current = true;
    runIdRef.current = null;
    activeRunIdRef.current = null;
    isStreamingRef.current = false;
    resumeAssistantIdRef.current = null;
    pendingSeqRef.current = null;
    replayRef.current = null;
    if (partialSaveTimerRef.current !== null) {
      clearInterval(partialSaveTimerRef.current);
      partialSaveTimerRef.current = null;
    }
    resetReasoningAccumulator();
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    setIsStreaming(false);
    setRecoveringRun(false);
    setSessionId(null);
    sessionIdRef.current = null;
    setHermesSessionId(null);
    hermesSessionIdRef.current = null;
    setHermesSessionMode(null);
    setActiveRunId(null);
    setPendingApproval(null);
    answeredApprovalIdsRef.current.clear();
    try {
      localStorage.removeItem(LAST_SESSION_KEY);
    } catch {
      /* private mode */
    }
  }, [cancelReattach, resetReasoningAccumulator]);

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
      activeRunIdRef.current = null;
      isStreamingRef.current = false;
      resumeAssistantIdRef.current = null;
      pendingSeqRef.current = null;
      replayRef.current = null;
      if (partialSaveTimerRef.current !== null) {
        clearInterval(partialSaveTimerRef.current);
        partialSaveTimerRef.current = null;
      }
      setActiveRunId(null);
      setRecoveringRun(false);
      setPendingApproval(null);
      answeredApprovalIdsRef.current.clear();
      setError(null);
      setIsStreaming(false);
      resetReasoningAccumulator();

      const detail = await chatHistory.get(id);
      const linkedRun = detail.active_run_id ?? null;

      // Restore first-seen tool order: older saved turns predate
      // ``hermes_seq``, so assign one from their stored array order.  Without
      // a linked run nothing will ever finish these tools — settle stale
      // "running" rows so the group does not animate forever.
      //
      // Older transcripts may also carry a name-based tool id (the previous
      // fallback) or the same id twice.  Re-key those rows here: a resumed run
      // must never bind two historical cards to one live call.
      let toolSeq = 0;
      const seenCallIds = new Set<string>();
      const restored: DisplayMessage[] = detail.messages.map((m) => {
        const calls = (m.tool_calls as ToolCallDelta[] | undefined) ?? undefined;
        const withSeq = calls?.map((call) => {
          const seq =
            typeof call.hermes_seq === "number" ? call.hermes_seq : toolSeq + 1;
          toolSeq = Math.max(toolSeq, seq);
          const status = (call.hermes_status || "").toLowerCase();
          const staleRunning =
            !linkedRun &&
            (status === "running" ||
              status === "started" ||
              status === "in_progress");
          const rawId = (call.id || "").trim();
          const needsKey =
            !rawId ||
            seenCallIds.has(rawId) ||
            rawId === (call.function?.name || "").trim();
          const callId = needsKey
            ? `tc:restored:${m.id}:${seq}`
            : rawId;
          seenCallIds.add(callId);
          return {
            ...call,
            id: callId,
            hermes_seq: seq,
            ...(staleRunning ? { hermes_status: "completed" } : {}),
          };
        });
        return {
          id: String(m.id),
          role: m.role as DisplayMessage["role"],
          content: m.content,
          // Defensive: if a backend ever persists reasoning, compact it again
          // on the render path (older rows may predate save-time compression).
          ...(typeof m.reasoning === "string" && m.reasoning.trim()
            ? { reasoning: collapseDuplicateReasoning(m.reasoning) }
            : {}),
          toolCalls: withSeq,
          isStreaming: false,
        };
      });
      toolSeqRef.current = toolSeq;
      toolArrivalRef.current = 0;
      messagesRef.current = restored;
      setMessages(restored);
      setSessionId(id);
      sessionIdRef.current = id;
      try {
        localStorage.setItem(LAST_SESSION_KEY, String(id));
      } catch {
        /* private mode */
      }

      // Adopt the recorded Hermes session instead of clearing it: the next turn
      // continues that agent session (no full-history replay).  A ``null`` mode
      // means "unknown after reload" and the matching logic treats it as
      // reusable; a chat with no recorded session falls back to full history.
      setHermesSessionId(detail.hermes_session_id ?? null);
      hermesSessionIdRef.current = detail.hermes_session_id ?? null;
      setHermesSessionMode(null);

      if (linkedRun) {
        // The run outlived the page: show the saved partial content at once,
        // then resume its SSE stream (TTL) or poll run-state every 3s.
        reattachRun(linkedRun);
      } else {
        // No run to follow: the turn is over, so clear any streaming flag the
        // restored assistant bubble may have carried (defensive for old rows).
        finishAssistant();
      }
    },
    [cancelReattach, finishAssistant, reattachRun, resetReasoningAccumulator],
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

  /**
   * Restore the most relevant session on a fresh page visit.
   *
   * When the URL carries no ``session`` parameter we prefer a session that
   * still has a recorded active run (its agent may be executing right now),
   * then the session recorded in localStorage, then the newest non-empty one.
   */
  const restoreLastSession = useCallback(async (): Promise<number | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;

    let sessions: Awaited<ReturnType<typeof chatHistory.list>>;
    try {
      sessions = await chatHistory.list();
    } catch {
      return null;
    }
    if (sessions.length === 0) return null;

    let savedId: number | null = null;
    try {
      const raw = Number(localStorage.getItem(LAST_SESSION_KEY));
      if (Number.isFinite(raw) && raw > 0) savedId = raw;
    } catch {
      /* private mode */
    }

    const candidates = sessions.filter((s) => s.message_count > 0).slice(0, 5);
    let target: number | null = null;
    for (const candidate of candidates) {
      try {
        const state = await chatHistory.runState(candidate.id);
        const status = (state.status || "").toUpperCase();
        if (
          state.active_run_id &&
          (status === "RUNNING" || status === "QUEUED")
        ) {
          target = candidate.id;
          break;
        }
      } catch {
        /* keep looking */
      }
    }
    if (target === null) {
      target =
        savedId !== null && sessions.some((s) => s.id === savedId)
          ? savedId
          : (candidates[0]?.id ?? sessions[0]?.id ?? null);
    }
    if (target === null) return null;
    await loadSession(target);
    return target;
  }, [loadSession]);

  // Keep the async save bridges pointed at the latest committed state.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    hermesSessionIdRef.current = hermesSessionId;
  }, [hermesSessionId]);
  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Persist once when the page is hidden or unloaded: the 5s cadence may not
  // have fired yet, and a reload must see the latest assistant text.
  useEffect(() => {
    const flush = () => saveStreamingSnapshot(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [saveStreamingSnapshot]);

  // Leaving the page: flush the partial transcript + resume cursor, then drop
  // only our local subscription.  The Hermes run keeps executing server-side
  // (no /stop); the active_run_id stored on the session lets the next visit
  // reattach via SSE or run-state polling.
  useEffect(
    () => () => {
      if (partialSaveTimerRef.current !== null) {
        clearInterval(partialSaveTimerRef.current);
        partialSaveTimerRef.current = null;
      }
      // The run survives; only this tab's subscription goes away.  Mark the
      // turn detached so its finally does not clear the reattach link.
      if (isStreamingRef.current && runIdRef.current) {
        detachedRef.current = true;
      }
      saveStreamingSnapshot(true);
      abortRef.current?.abort();
      abortRef.current = null;
      cancelReattach();
    },
    [cancelReattach, saveStreamingSnapshot],
  );

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
    /** True while reattaching to a run after a page switch / reload. */
    recoveringRun,
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
    restoreLastSession,
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

/** Persistable messages (``error`` bubbles are UI-only). */
function _saveableMessages(
  messages: DisplayMessage[],
): Array<{
  role: string;
  content: string;
  /** Compressed before saving (adjacent duplicate blocks removed). */
  reasoning?: string;
  tool_calls?: ToolCallDelta[];
}> {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
    .map((m) => ({
      role: m.role,
      content: m.content,
      // Compaction happens *before* the transcript leaves the browser: a
      // backend that persists reasoning must never store adjacent duplicates.
      // (The current schema ignores this field, which is also why a reloaded
      // transcript cannot replay duplicated thinking — reasoning is rendered
      // live only, and both render paths run the same compaction.)
      ...(m.reasoning
        ? { reasoning: collapseDuplicateReasoning(m.reasoning) }
        : {}),
      tool_calls: m.toolCalls ?? undefined,
    }));
}

/**
 * Shortest chunk that may still be a whole-sentence replay of the tail.  Token
 * deltas are far shorter, so a short chunk is always appended.
 */
const ASSISTANT_REPLAY_MIN_CHARS = 10;

/**
 * How long a cursor-less reattach keeps absorbing replayed deltas before it
 * gives up and lets the terminal reconciliation settle the answer.
 */
const REPLAY_CATCHUP_MAX_MS = 15000;

/** Shortest block that is treated as a duplicated tail when settling a turn. */
const ASSISTANT_DOUBLED_MIN_CHARS = 20;

/** Length of the common opening of two strings. */
function _commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Merge one incoming delta into the assistant body.
 *
 * Two delivery shapes exist on the wire and they overlap:
 *
 * - incremental chunks (``message.delta``) that must be appended;
 * - whole-block snapshots (``message.interim``) that restate text which was
 *   already streamed — appending them rendered every mid-turn sentence twice,
 *   which is exactly the "输出重复两次" symptom.
 *
 * A snapshot therefore replaces the body when it extends it, is dropped when it
 * is already contained, and only appends its unseen part otherwise.  Plain
 * chunks are appended, except for a long exact repetition of the tail (a
 * replayed frame), which is dropped.
 *
 * @returns the new body, or ``null`` when the chunk carries nothing new.
 */
function _mergeAssistantChunk(
  current: string,
  chunk: string,
  snapshot: boolean,
): string | null {
  if (!chunk) return null;
  if (!current) return chunk;
  if (chunk === current) return null;
  // Whole-block snapshot that is longer than what we show: it is the same text
  // plus more (Hermes re-sends the accumulated interim message).
  if (snapshot && chunk.startsWith(current)) return chunk;
  // Already shown at the tail — either a snapshot or a replayed long chunk.
  if (current.endsWith(chunk) && (snapshot || chunk.length >= ASSISTANT_REPLAY_MIN_CHARS)) {
    return null;
  }
  // Snapshot restating an earlier paragraph of this turn.
  if (snapshot && current.includes(chunk)) return null;
  return current + chunk;
}

/**
 * Drop an exactly duplicated tail block from a finished answer.
 *
 * When the same text arrived through both channels for a long stretch, the
 * per-chunk guards cannot see it (`current.endsWith(chunk)` never matches a
 * one-token chunk).  Only an *exact* repetition of a whole block (≥ 20 chars)
 * is removed, so genuinely repeated phrases in an answer survive.
 */
function _collapseDoubledTail(text: string): string {
  const length = text.length;
  const maxBlock = Math.floor(length / 2);
  for (let block = maxBlock; block >= ASSISTANT_DOUBLED_MIN_CHARS; block -= 1) {
    if (text.slice(length - block) === text.slice(length - 2 * block, length - block)) {
      return text.slice(0, length - block);
    }
  }
  return text;
}

/** Session title derived from the first user message. */
function _titleForMessages(messages: DisplayMessage[]): string {  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "新对话";
  const { content } = firstUser;
  return content.slice(0, 40) + (content.length > 40 ? "…" : "");
}

/**
 * Apply the server's authoritative run result to the live transcript.
 *
 * The Runs API is the source of truth: its ``output`` is the complete final
 * answer even when the SSE preview delivered fewer ``message.delta`` frames.
 * The last assistant bubble of the current turn is replaced in place when the
 * server output is longer (or when nothing was rendered yet); reasoning and
 * tool rows are preserved, and server usage is attached to the same bubble.
 *
 * Returns the original array when nothing changed so callers can skip a
 * re-render / save.
 */
function _mergeAuthoritativeRunOutput(
  messages: DisplayMessage[],
  output: string,
  usage?: { prompt_tokens: number; completion_tokens: number },
  authoritative = false,
): {
  messages: DisplayMessage[];
  replaced: boolean;
  /** Length of the assistant body before reconciliation (for diagnostics). */
  currentLength: number;
} {
  const text = output.trim();
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      index = i;
      break;
    }
  }

  if (index === -1) {
    if (!text && !usage) {
      return { messages, replaced: false, currentLength: 0 };
    }
    return {
      messages: [
        ...messages,
        {
          id: uid(),
          role: "assistant",
          content: text,
          ...(usage ? { usage } : {}),
          isStreaming: false,
        },
      ],
      replaced: Boolean(text),
      currentLength: 0,
    };
  }

  const target = messages[index];
  const current = target.content ?? "";
  // "More complete" is deliberately mechanical: empty → always take the
  // server text; otherwise only a strictly longer output wins.  Equal content
  // is already complete and a shorter server snapshot must not truncate it.
  //
  // ``authoritative`` (a COMPLETED run) overrides that: the server output is
  // the answer, so it also replaces a *longer* local body — that body is a
  // stream artefact (doubled deltas / a replayed interim), not real content.
  const replace = authoritative
    ? text.length > 0
    : text.length > 0 && (current.length === 0 || text.length > current.length);
  if (!replace && !usage) {
    return { messages, replaced: false, currentLength: current.length };
  }

  const next = [...messages];
  next[index] = {
    ...target,
    ...(replace ? { content: text } : {}),
    ...(usage ? { usage } : {}),
    isStreaming: false,
  };
  return { messages: next, replaced: replace, currentLength: current.length };
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
  // The saved body already carries this output (a doubled / replayed turn):
  // replace it in place — appending would show the answer one more time.
  if (last.content.includes(output)) {
    const next = [...messages];
    next[lastAssistant] = { ...last, content: output, isStreaming: false };
    return next;
  }
  return [
    ...messages,
    { id: uid(), role: "assistant", content: output },
  ];
}
