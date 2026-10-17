/** Individual chat message bubble.

Renders four distinct message types:
- **user** — blue bubble, right-aligned
- **assistant** — gray bubble with streaming cursor
- **tool** — amber-bordered card with spinner→check status
- **error** — red-bordered alert
*/

import { memo, useMemo, useState, useEffect, useCallback, useRef, type FC } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { User, AlertCircle, Loader2, Check, X, ChevronDown, ChevronRight, ArrowDown, CornerDownRight, Copy, Terminal, Globe, Search, Database, Code, FileText, Wrench, Sparkles } from "lucide-react";
import { LiumaiLogo } from "@/components/liumai-logo";
import type { DisplayMessage } from "@/hooks/useChat";
import type { ToolCallDelta } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ==========================================================================
 * Tool icon mapping — overrides Hermes emoji for known tool patterns
 * ========================================================================== */

type IconComponent = FC<{ className?: string }>;

const TOOL_ICON_MAP: Record<string, IconComponent> = {
  // Terminal / shell
  terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
  execute_command: Terminal,
  run_shell: Terminal,
  cmd: Terminal,
  powershell: Terminal,
  // Browser / web
  browser_navigate: Globe,
  web_fetch: Globe,
  web_search: Globe,
  http_request: Globe,
  curl: Globe,
  fetch: Globe,
  // Search
  search: Search,
  grep: Search,
  find: Search,
  rg: Search,
  // Database
  database: Database,
  db: Database,
  sql: Database,
  query: Database,
  postgres: Database,
  mysql: Database,
  clickhouse: Database,
  prometheus: Database,
  // Code
  code: Code,
  python: Code,
  js: Code,
  node: Code,
  // File ops
  file_read: FileText,
  file_write: FileText,
  cat: FileText,
  read: FileText,
  write: FileText,
  edit: FileText,
  // Fallback
  tool: Wrench,
};

function resolveToolIcon(toolName: string): IconComponent | null {
  const key = toolName.toLowerCase().replace(/[_-]/g, "");
  // Exact match first
  if (TOOL_ICON_MAP[key]) return TOOL_ICON_MAP[key];
  // Prefix match (e.g. "bash_exec" → Terminal)
  for (const [pattern, icon] of Object.entries(TOOL_ICON_MAP)) {
    if (key.startsWith(pattern) || key.includes(pattern)) return icon;
  }
  return null;
}

/* ==========================================================================
 * Tool-argument block
 * ========================================================================== */

const ToolArgs: FC<{ tool: ToolCallDelta; isStreaming: boolean }> = ({
  tool,
  isStreaming,
}) => {
  const parsedArgs = useMemo(() => {
    try {
      return JSON.parse(tool.function.arguments);
    } catch {
      return null;
    }
  }, [tool.function.arguments]);

  if (!tool.function.arguments && !isStreaming) return null;

  return (
    <div>
      <p className="text-[10px] text-muted-foreground/70 mb-0.5">参数</p>
      <pre className="rounded-md bg-surface-tertiary/60 px-2.5 py-2 text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all leading-relaxed overflow-x-auto">
        {parsedArgs
          ? JSON.stringify(parsedArgs, null, 2)
          : (
            <span className="text-muted-foreground italic">
              {tool.function.arguments || "等待参数…"}
            </span>
          )}
      </pre>
    </div>
  );
};

/* ==========================================================================
 * Tool-call message (collapsible)
 * ========================================================================== */

const ToolMessage: FC<{ message: DisplayMessage }> = ({ message }) => {
  const tc = message.toolCalls?.[0];
  const toolStatus = tc?.hermes_status;
  const isRunning = Boolean(
    toolStatus === "running" || (message.isStreaming && !toolStatus),
  );
  const isError = toolStatus === "error";
  const isDone = !isRunning && !isError && !message.isStreaming;
  const emoji = tc?.hermes_emoji;
  const label = tc?.hermes_label;
  const toolName = tc?.function?.name || message.content;
  const hasArgs = !!tc?.function?.arguments;
  const hasDetail = !!label || hasArgs;

  // Auto-expand while running, collapse when done
  const [expanded, setExpanded] = useState(isRunning || isError);
  useEffect(() => {
    if (isDone) setExpanded(false);
  }, [isDone]);

  // ── Status-driven color tokens ──────────────────────────────────────
  const palette = isError
    ? { accent: "bg-status-active", bg: "bg-status-active/[0.04]", text: "text-status-active", icon: X as FC<{className?:string}>, label: "出错" }
    : isRunning
      ? { accent: "bg-interactive-primary", bg: "bg-interactive-primary/[0.04]", text: "text-interactive-primary", icon: Loader2 as FC<{className?:string}>, label: "执行中…" }
      : { accent: "bg-status-resolved", bg: "", text: "text-status-resolved", icon: Check as FC<{className?:string}>, label: "完成" };

  const StatusIcon = palette.icon;

  return (
    <div className="flex gap-2.5 justify-start" role="article" aria-label="tool call">
      {/* Left flow indicator: arrow down → bar → arrow return */}
      <div className="shrink-0 flex flex-col items-center self-stretch" aria-hidden="true">
        <ArrowDown className={cn("h-3 w-3 -mt-0.5", palette.text, isRunning && "animate-pulse")} />
        <div className={cn("flex-1 w-0.5 rounded-full transition-colors duration-300", palette.accent)} />
        <CornerDownRight className={cn("h-3 w-3 -mb-0.5", palette.text)} />
      </div>

      <div className="max-w-[85%] min-w-0 flex-1">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((v) => !v)}
          className={cn(
            "w-full text-left rounded-lg px-3 py-2 transition-colors duration-200",
            palette.bg,
            hasDetail && "hover:bg-surface-secondary cursor-pointer",
            !hasDetail && "cursor-default",
          )}
        >
          {/* ── Header row ──────────────────────────────────────────────── */}
          <div className="flex items-center gap-1.5 text-[13px] select-none">
            {/* Icon: mapped lucide icon → Hermes emoji → status icon */}
            {(() => {
              const ToolIcon = resolveToolIcon(toolName);
              if (ToolIcon) {
                return (
                  <ToolIcon
                    className={cn(
                      "h-3 w-3 shrink-0",
                      isRunning && "animate-spin",
                      palette.text,
                    )}
                  />
                );
              }
              if (emoji) {
                return <span className="text-sm leading-none" aria-hidden="true">{emoji}</span>;
              }
              return (
                <StatusIcon
                  className={cn(
                    "h-3 w-3 shrink-0",
                    isRunning && "animate-spin",
                    palette.text,
                  )}
                />
              );
            })()}

            <span className={cn("font-medium", palette.text)}>
              调用工具
            </span>

            <span className="font-mono text-[11px] text-text-secondary bg-surface-secondary/80 rounded px-1.5 py-px truncate max-w-[160px]">
              {toolName}
            </span>

            <span
              className={cn(
                "text-[11px] shrink-0",
                isRunning ? "text-muted-foreground animate-pulse" : palette.text,
              )}
            >
              {palette.label}
            </span>

            {hasDetail && (
              <span className="ml-auto text-muted-foreground/50 shrink-0">
                {expanded
                  ? <ChevronDown className="h-3 w-3 transition-transform duration-200" />
                  : <ChevronRight className="h-3 w-3 transition-transform duration-200" />
                }
              </span>
            )}
          </div>

          {/* ── Detail section ──────────────────────────────────────────── */}
          {expanded && hasDetail && (
            <div className="mt-2 pt-2 border-t border-border/30">
              {label && (
                <div className="mb-2">
                  <p className="text-[10px] text-muted-foreground/70 mb-0.5">描述</p>
                  <p className="text-[12px] text-text-secondary leading-relaxed">{label}</p>
                </div>
              )}
              {hasArgs && (
                <ToolArgs tool={tc!} isStreaming={isRunning} />
              )}
            </div>
          )}
        </button>
      </div>
    </div>
  );
};

/* ==========================================================================
 * Reasoning ("thinking") block
 * ========================================================================== */

/** Collapsible display of the model's reasoning stream.
 *
 * Hermes streams ``delta.reasoning_content`` before the answer.  It is shown
 * in a muted, collapsible block so the answer stays readable: open while the
 * model is still thinking, auto-collapsed once the answer starts streaming
 * (unless the user opened it manually).
 */
const ReasoningBlock: FC<{ text: string; streaming?: boolean; hasAnswer?: boolean }> = ({
  text,
  streaming,
  hasAnswer,
}) => {
  const [open, setOpen] = useState(true);
  const userToggled = useRef(false);

  useEffect(() => {
    if (!userToggled.current && hasAnswer) setOpen(false);
  }, [hasAnswer]);

  return (
    <div className="mb-1.5 rounded-lg border border-border/60 bg-white/50 overflow-hidden">
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-text-secondary transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Sparkles className="h-3 w-3" />
        思考过程
        {streaming && !hasAnswer && (
          <span className="ml-1 h-1.5 w-1.5 rounded-full bg-interactive-primary animate-pulse" />
        )}
        <span className="ml-auto font-normal text-[10px] opacity-60">{text.length} 字</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto whitespace-pre-wrap px-2.5 pb-2 text-[12px] leading-relaxed text-muted-foreground select-text">
          {text}
          {streaming && !hasAnswer && (
            <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-text-bottom" aria-hidden="true" />
          )}
        </div>
      )}
    </div>
  );
};

/* ==========================================================================
 * Streaming render throttling
 * ========================================================================== */

/** Minimum spacing between Markdown re-renders while a reply is streaming. */
const STREAM_RENDER_INTERVAL_MS = 70;

/**
 * Throttles a rapidly-growing streaming value.
 *
 * ``react-markdown`` (+ rehype-raw / rehype-sanitize) re-parses the whole
 * answer on every render, so feeding it one render per delta drops frames on
 * long replies.  While ``streaming`` is true this yields at most one update
 * per ``intervalMs`` (the freshest value is always the one flushed); the
 * moment streaming ends it flushes the final value immediately so the text is
 * never stale.
 */
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
      // Stream finished (or this is a restored message): show the final text
      // now and drop any pending partial update.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(latestRef.current);
      return;
    }
    // A flush is already queued; it will pick up the newest value.
    if (timerRef.current !== null) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastFlushRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastFlushRef.current = Date.now();
      setThrottled(latestRef.current);
    }, wait);
  }, [value, streaming, intervalMs]);

  // Never leave a timer behind when the message unmounts.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return throttled;
}

/* ==========================================================================
 * Markdown body
 * ========================================================================== */

/**
 * Markdown renderer isolated behind ``memo``.
 *
 * The streamed text only reaches it through {@link useThrottledValue}, so the
 * expensive parse runs at most once per throttle tick instead of once per
 * delta.  Earlier (finished) messages are skipped entirely by the memoised
 * {@link ChatMessage}.
 */
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        /* ── Code blocks ──────────────────────────────── */
        pre: ({ children }) => (
          <pre className="bg-surface-secondary/60 border border-border/50 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono text-text-primary whitespace-pre-wrap break-all">
            {children}
          </pre>
        ),
        code: ({ className: cls, children, ...rest }) => {
          const isInline = !cls?.includes("language-");
          if (isInline) {
            return (
              <code
                className="bg-surface-secondary/80 text-text-primary text-xs font-mono rounded px-1 py-0.5"
                {...rest}
              >
                {children}
              </code>
            );
          }
          return <code className={cn("text-xs px-0 py-0", cls)} {...rest}>{children}</code>;
        },
        /* ── Tables ────────────────────────────────────── */
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full border-collapse border border-border/50 text-xs">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-border/50 bg-surface-secondary/80 px-3 py-1.5 text-left font-medium text-text-primary">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-border/50 px-3 py-1.5 text-text-secondary">
            {children}
          </td>
        ),
        /* ── Blockquotes ────────────────────────────────── */
        blockquote: ({ children }) => (
          <blockquote className="border-l-3 border-interactive-primary/40 pl-3 my-2 text-text-secondary italic">
            {children}
          </blockquote>
        ),
        /* ── Lists ──────────────────────────────────────── */
        ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
        /* ── Headings ───────────────────────────────────── */
        h1: ({ children }) => <h1 className="text-lg font-semibold text-text-primary mt-3 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold text-text-primary mt-2.5 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-text-primary mt-2 mb-0.5">{children}</h3>,
        /* ── Inline ─────────────────────────────────────── */
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-interactive-primary underline underline-offset-2 hover:opacity-80">
            {children}
          </a>
        ),
        hr: () => <hr className="my-3 border-border/50" />,
        p: ({ children }) => <p className="my-1">{children}</p>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

/* ==========================================================================
 * Message bubble
 * ========================================================================== */

const ChatMessageImpl: FC<{ message: DisplayMessage }> = ({ message }) => {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isError = message.role === "error";
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!message.content) return;
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Fallback for insecure contexts
      const ta = document.createElement("textarea");
      ta.value = message.content;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message.content]);

  const copyBtn = message.content && !message.isStreaming ? (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "shrink-0 self-end mb-0.5 p-1 rounded-md transition-all duration-150",
        "opacity-0 group-hover:opacity-100",
        "hover:bg-surface-secondary text-muted-foreground hover:text-text-secondary",
        copied && "opacity-100 !text-status-resolved",
      )}
      aria-label={copied ? "已复制" : "复制"}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  ) : null;

  // Throttled snapshot for the Markdown body (see useThrottledValue).  Full
  // `message.content` is still used for logic / copy / usage so nothing is lost.
  const renderedContent = useThrottledValue(
    message.content,
    Boolean(message.isStreaming),
  );

  /* ── Tool-call message ───────────────────────────────────────────── */
  if (isTool) {
    return <ToolMessage message={message} />;
  }

  /* ── Regular messages ────────────────────────────────────────────── */
  return (
    <div
      className={`flex gap-1.5 group ${isUser ? "justify-end" : "justify-start"}`}
      role="article"
      aria-label={`${message.role} message`}
    >
      {!isUser && !isError && (
        <div className="shrink-0 mt-0.5" aria-hidden="true">
          <LiumaiLogo size={28} />
        </div>
      )}
      {isError && (
        <div className="shrink-0 mt-0.5 text-status-active" aria-hidden="true">
          <AlertCircle className="h-5 w-5" />
        </div>
      )}

      {/* Copy button — before bubble for user, after for assistant */}
      {isUser && copyBtn}

      <div
        className={`max-w-[85%] min-w-0 ${
          isUser
            ? "bg-[#1a1a2e] text-text-inverse rounded-2xl rounded-br-md px-4 py-2.5"
            : isError
              ? "bg-status-active/5 text-status-active border border-status-active/20 rounded-2xl rounded-bl-md px-4 py-2.5"
              : "bg-surface-secondary text-text-primary rounded-2xl rounded-bl-md px-4 py-2.5"
        }`}
      >
        {!isUser && !isError && message.reasoning && (
          <ReasoningBlock
            text={message.reasoning}
            streaming={message.isStreaming}
            hasAnswer={Boolean(message.content)}
          />
        )}

        {renderedContent && (
          <div className="text-sm leading-relaxed markdown-body">
            <MarkdownContent content={renderedContent} />
            {message.isStreaming && (
              <span
                className="inline-block w-1.5 h-4 ml-0.5 bg-current align-text-bottom animate-pulse rounded-sm"
                aria-hidden="true"
              />
            )}
          </div>
        )}

        {!message.content && !message.reasoning && !message.toolCalls?.length && message.isStreaming && (
          <div className="flex items-center gap-1.5 py-1" aria-label="思考中…">
            <span className="h-2 w-2 rounded-full bg-interactive-primary animate-bounce [animation-delay:0ms]" />
            <span className="h-2 w-2 rounded-full bg-interactive-primary animate-bounce [animation-delay:150ms]" />
            <span className="h-2 w-2 rounded-full bg-interactive-primary animate-bounce [animation-delay:300ms]" />
          </div>
        )}

        {!isUser && !isError && message.usage && !message.isStreaming && (
          <div className="mt-1 text-[10px] text-muted-foreground/60 tabular-nums" title="本轮 token 用量">
            ↑ {message.usage.prompt_tokens.toLocaleString()} · ↓ {message.usage.completion_tokens.toLocaleString()} tokens
          </div>
        )}
      </div>

      {/* Copy button for assistant/error messages */}
      {!isUser && copyBtn}

      {isUser && (
        <div className="shrink-0 mt-0.5 text-[#1a1a2e]" aria-hidden="true">
          <User className="h-5 w-5" />
        </div>
      )}
    </div>
  );
};

/**
 * Memoised bubble.
 *
 * Streaming only mutates the newest message object; without this every delta
 * re-rendered (and re-parsed the Markdown of) every earlier message in the
 * transcript.  `message` objects for finished turns keep their identity, so
 * those bubbles now skip re-rendering entirely.
 */
export const ChatMessage = memo(ChatMessageImpl);
ChatMessage.displayName = "ChatMessage";
