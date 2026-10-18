/* ==========================================================================
 *  Message list — reading-first transcript
 *
 *  Consecutive non-user messages (assistant + tools) are folded into one
 *  "turn": the process (thinking + tool group) first, then the final answer as
 *  borderless prose.  User messages stay right-aligned in a light capsule.
 * ========================================================================== */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Pencil,
  RefreshCw,
} from "lucide-react";
import type { DisplayMessage } from "@/hooks/useChat";
import { LiumaiLogo } from "@/components/liumai-logo";
import { cn } from "@/lib/utils";
import { clockTime, copyText, fullTime } from "./chat-utils";
import { Markdown } from "./markdown";
import { ReasoningBlock } from "./reasoning";
import { ToolProcessGroup } from "./tool-call-card";

/* ==========================================================================
 *  Streaming throttle — at most one Markdown re-render per 60ms
 * ========================================================================== */

const STREAM_RENDER_INTERVAL_MS = 60;

function useThrottledValue(
  value: string,
  streaming: boolean,
  intervalMs = STREAM_RENDER_INTERVAL_MS,
): string {
  const [throttled, setThrottled] = useState(value);
  const latestRef = useRef(value);
  latestRef.current = value;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushRef = useRef(0);

  useEffect(() => {
    if (!streaming) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(latestRef.current);
      return;
    }
    if (timerRef.current !== null) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastFlushRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastFlushRef.current = Date.now();
      setThrottled(latestRef.current);
    }, wait);
  }, [value, streaming, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return throttled;
}

/* ==========================================================================
 *  Small pieces
 * ========================================================================== */

const ThinkingDots: FC<{ label?: string }> = ({ label = "思考中" }) => (
  <div className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground">
    <span aria-hidden="true" className="text-[13px] leading-none">
      🧠
    </span>
    <span className="flex items-center gap-1" aria-hidden="true">
      <span className="lm-breathe h-1.5 w-1.5 rounded-full bg-interactive-primary" />
      <span className="lm-breathe h-1.5 w-1.5 rounded-full bg-interactive-primary [animation-delay:180ms]" />
      <span className="lm-breathe h-1.5 w-1.5 rounded-full bg-interactive-primary [animation-delay:360ms]" />
    </span>
    <span>{label}…</span>
  </div>
);

interface ActionButtonProps {
  label: string;
  copied?: boolean;
  onClick: () => void;
  children: ReactNode;
}

const ActionButton: FC<ActionButtonProps> = ({
  label,
  copied,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors duration-150",
      "hover:bg-surface-secondary hover:text-text-primary",
      copied && "text-status-resolved",
    )}
    aria-label={label}
    title={label}
  >
    {children}
    <span className="hidden sm:inline">{copied ? "已复制" : label}</span>
  </button>
);

/* ==========================================================================
 *  User message
 * ========================================================================== */

interface UserMessageProps {
  message: DisplayMessage;
  time: number | null;
  busy: boolean;
  onEditResend: (id: string, text: string) => void;
}

const UserMessage: FC<UserMessageProps> = ({
  message,
  time,
  busy,
  onEditResend,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.selectionStart = editor.value.length;
    editor.selectionEnd = editor.value.length;
    editor.style.height = "auto";
    editor.style.height = `${Math.min(editor.scrollHeight, 240)}px`;
  }, [editing]);

  const handleCopy = useCallback(() => {
    void copyText(message.content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [message.content]);

  const submitEdit = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setEditing(false);
    onEditResend(message.id, text);
  }, [busy, draft, message.id, onEditResend]);

  return (
    <article
      className="group/user flex justify-end"
      aria-label="user message"
    >
      <div className="flex max-w-[88%] flex-col items-end gap-1 sm:max-w-[82%]">
        {editing ? (
          <div className="w-full min-w-[260px] rounded-2xl rounded-br-md border border-interactive-primary/30 bg-surface-primary p-2 shadow-sm">
            <textarea
              ref={editorRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                const el = event.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitEdit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(message.content);
                  setEditing(false);
                }
              }}
              rows={1}
              className="chat-thin-scroll max-h-60 w-full resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-[1.65] text-text-primary outline-none"
              aria-label="编辑消息后重新发送"
            />
            <div className="mt-1 flex items-center justify-end gap-1.5 px-1 pb-0.5">
              <span className="mr-auto text-[10.5px] text-muted-foreground/70">
                Enter 重发 · Esc 取消
              </span>
              <button
                type="button"
                onClick={() => {
                  setDraft(message.content);
                  setEditing(false);
                }}
                className="rounded-md px-2 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-text-primary"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={!draft.trim() || busy}
                className="rounded-md bg-interactive-primary px-2.5 py-1 text-[11.5px] font-medium text-white transition-colors hover:bg-interactive-hover disabled:opacity-40"
              >
                重新发送
              </button>
            </div>
          </div>
        ) : (
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border/60 bg-surface-secondary px-4 py-2.5 text-[15px] leading-[1.65] text-text-primary select-text">
            {message.content}
          </div>
        )}

        {!editing && (
          <div className="flex items-center gap-0.5 pr-0.5 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover/user:opacity-100 sm:focus-within:opacity-100">
            {time !== null && (
              <time
                dateTime={new Date(time).toISOString()}
                title={fullTime(time)}
                className="px-1 text-[10.5px] tabular-nums text-muted-foreground/60"
              >
                {clockTime(time)}
              </time>
            )}
            <ActionButton label={copied ? "已复制" : "复制"} copied={copied} onClick={handleCopy}>
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </ActionButton>
            <button
              type="button"
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
              disabled={busy}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-surface-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
              aria-label="编辑并重发"
              title="编辑并重发"
            >
              <Pencil className="h-3 w-3" />
              <span className="hidden sm:inline">编辑</span>
            </button>
          </div>
        )}
      </div>
    </article>
  );
};

/* ==========================================================================
 *  Assistant turn
 * ========================================================================== */

interface AssistantTurnProps {
  messages: DisplayMessage[];
  prompt: string | null;
  time: number | null;
  busy: boolean;
  /** Global stream belongs to this (the newest) turn. */
  live: boolean;
  /** Platform session id for artifact download URLs. */
  sessionId?: number | null;
  onRegenerate: (assistantMessageId: string) => void;
}

const AssistantTurn: FC<AssistantTurnProps> = ({
  messages,
  prompt,
  time,
  busy,
  live,
  sessionId,
  onRegenerate,
}) => {
  const assistantMessages = useMemo(
    () => messages.filter((message) => message.role === "assistant"),
    [messages],
  );
  const tools = useMemo(
    () => messages.filter((message) => message.role === "tool"),
    [messages],
  );

  const streaming = live || messages.some((message) => message.isStreaming);
  const reasoning = assistantMessages
    .map((message) => message.reasoning?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  const content = assistantMessages
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  const usage = [...assistantMessages]
    .reverse()
    .find((message) => message.usage)?.usage;

  const renderContent = useThrottledValue(content, streaming);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyText(content).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  const hasProcess = Boolean(reasoning) || tools.length > 0;
  const waiting = streaming && !content && !hasProcess;
  const awaitingAnswer = streaming && !content && hasProcess;
  const generateId = assistantMessages[0]?.id ?? messages[0]?.id ?? "";

  return (
    <article
      className="group/assistant flex gap-3 sm:gap-4"
      aria-label="assistant message"
    >
      <div className="mt-1 shrink-0" aria-hidden="true">
        <LiumaiLogo size={26} animated={false} />
      </div>

      <div className="min-w-0 flex-1">
        {hasProcess && (
          <div className="mb-2.5 flex flex-col gap-2">
            {reasoning && (
              <ReasoningBlock
                text={reasoning}
                streaming={streaming}
                hasAnswer={Boolean(content)}
              />
            )}
            {tools.length > 0 && <ToolProcessGroup messages={tools} />}
          </div>
        )}

        {renderContent ? (
          <div className={cn("chat-answer", streaming && "chat-answer--streaming")}>
            <Markdown content={renderContent} sessionId={sessionId} />
          </div>
        ) : waiting ? (
          <ThinkingDots />
        ) : null}

        {awaitingAnswer && <ThinkingDots label="思考中" />}

        {!streaming && hasProcess && !content && (
          <p className="mt-1 text-[13px] text-muted-foreground">（未返回内容）</p>
        )}

        {!streaming && (
          <div className="mt-1.5 flex flex-wrap items-center gap-0.5 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover/assistant:opacity-100 sm:focus-within:opacity-100">
            <ActionButton
              label={copied ? "已复制" : "复制"}
              copied={copied}
              onClick={handleCopy}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </ActionButton>
            {prompt && (
              <button
                type="button"
                onClick={() => {
                  if (generateId) onRegenerate(generateId);
                }}
                disabled={busy}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-surface-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
                aria-label="重新生成"
                title="重新生成"
              >
                <RefreshCw className="h-3 w-3" />
                <span className="hidden sm:inline">重新生成</span>
              </button>
            )}
            {time !== null && (
              <time
                dateTime={new Date(time).toISOString()}
                title={fullTime(time)}
                className="px-1 text-[10.5px] tabular-nums text-muted-foreground/60"
              >
                {clockTime(time)}
              </time>
            )}
            {usage && (
              <span
                className="ml-auto px-1 text-[10.5px] tabular-nums text-muted-foreground/55"
                title="本轮 token 用量"
              >
                ↑ {usage.prompt_tokens.toLocaleString()} · ↓{" "}
                {usage.completion_tokens.toLocaleString()} tokens
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
};

/* ==========================================================================
 *  Turn grouping
 * ========================================================================== */

type Turn =
  | { kind: "user"; key: string; message: DisplayMessage; prompt: string | null }
  | { kind: "assistant"; key: string; messages: DisplayMessage[]; prompt: string | null };

function buildTurns(
  messages: DisplayMessage[],
  hiddenIds: Set<string>,
): Turn[] {
  const turns: Turn[] = [];
  let lastUserPrompt: string | null = null;

  for (const message of messages) {
    if (hiddenIds.has(message.id)) continue;
    if (message.role === "error") continue;

    if (message.role === "user") {
      lastUserPrompt = message.content;
      turns.push({
        kind: "user",
        key: message.id,
        message,
        prompt: lastUserPrompt,
      });
      continue;
    }

    const previous = turns[turns.length - 1];
    if (previous?.kind === "assistant") {
      previous.messages.push(message);
    } else {
      turns.push({
        kind: "assistant",
        key: message.id,
        messages: [message],
        prompt: lastUserPrompt,
      });
    }
  }

  return turns;
}

/* ==========================================================================
 *  Error notice
 * ========================================================================== */

interface ErrorNoticeProps {
  message: string;
  canRetry: boolean;
  onRetry: () => void;
}

const ErrorNotice: FC<ErrorNoticeProps> = ({ message, canRetry, onRetry }) => (
  <div
    className="flex items-start gap-3 rounded-xl border border-status-active/20 bg-status-active/[0.05] px-3.5 py-3"
    role="alert"
  >
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-active" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <p className="text-[12.5px] font-medium text-status-active">生成失败</p>
      <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-text-secondary">
        {message}
      </p>
    </div>
    {canRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="flex shrink-0 items-center gap-1 rounded-lg border border-status-active/25 bg-surface-primary px-2.5 py-1.5 text-[11.5px] font-medium text-status-active transition-colors hover:bg-status-active/10"
      >
        <RefreshCw className="h-3 w-3" />
        重试
      </button>
    )}
  </div>
);

/* ==========================================================================
 *  Message list
 * ========================================================================== */

export interface MessageListProps {
  messages: DisplayMessage[];
  hiddenIds: Set<string>;
  errorText: string | null;
  isStreaming: boolean;
  canRetry: boolean;
  /** Platform session id for artifact download URLs (optional). */
  sessionId?: number | null;
  onRetry: () => void;
  onRegenerate: (assistantMessageId: string) => void;
  onEditResend: (userMessageId: string, text: string) => void;
}

export const MessageList: FC<MessageListProps> = ({
  messages,
  hiddenIds,
  errorText,
  isStreaming,
  canRetry,
  sessionId,
  onRetry,
  onRegenerate,
  onEditResend,
}) => {
  const turns = useMemo(() => buildTurns(messages, hiddenIds), [messages, hiddenIds]);
  const pendingAssistant =
    isStreaming && (turns.length === 0 || turns[turns.length - 1].kind === "user");

  // UI-only timestamp map: restored messages use numeric DB ids and therefore
  // stay without a clock (their original time is not part of DisplayMessage).
  const seenAtRef = useRef(new Map<string, number>());
  const timeFor = useCallback((message: DisplayMessage): number | null => {
    if (/^\d+$/.test(message.id)) return null;
    let timestamp = seenAtRef.current.get(message.id);
    if (timestamp === undefined) {
      timestamp = Date.now();
      seenAtRef.current.set(message.id, timestamp);
    }
    return timestamp;
  }, []);

  return (
    <div className="flex flex-col gap-6 py-2 sm:gap-7">
      {turns.map((turn, index) =>
        turn.kind === "user" ? (
          <UserMessage
            key={turn.key}
            message={turn.message}
            time={timeFor(turn.message)}
            busy={isStreaming}
            onEditResend={onEditResend}
          />
        ) : (
          <AssistantTurn
            key={turn.key}
            messages={turn.messages}
            prompt={turn.prompt}
            time={timeFor(turn.messages[0])}
            busy={isStreaming}
            live={isStreaming && index === turns.length - 1}
            sessionId={sessionId}
            onRegenerate={onRegenerate}
          />
        ),
      )}

      {pendingAssistant && (
        <article className="group/assistant flex gap-3 sm:gap-4" aria-label="assistant thinking">
          <div className="mt-1 shrink-0" aria-hidden="true">
            <LiumaiLogo size={26} animated={false} />
          </div>
          <div className="min-w-0 flex-1">
            <ThinkingDots label="思考中" />
          </div>
        </article>
      )}

      {errorText && (
        <ErrorNotice message={errorText} canRetry={canRetry && !isStreaming} onRetry={onRetry} />
      )}
    </div>
  );
};
