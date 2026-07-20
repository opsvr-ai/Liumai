/** Individual chat message bubble.

Renders four distinct message types:
- **user** — blue bubble, right-aligned
- **assistant** — gray bubble with streaming cursor
- **tool** — amber-bordered card with spinner→check status
- **error** — red-bordered alert
*/

import { useMemo, useState, type FC } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { User, AlertCircle, Loader2, Check, ChevronDown, ChevronRight } from "lucide-react";
import { LiumaiLogo } from "@/components/liumai-logo";
import type { DisplayMessage } from "@/hooks/useChat";
import type { ToolCallDelta } from "@/lib/api";
import { cn } from "@/lib/utils";

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
    <div className="mt-2 rounded-md bg-surface-secondary/50 px-2.5 py-2 text-xs font-mono text-text-secondary whitespace-pre-wrap break-all leading-relaxed border border-border/50">
      {parsedArgs
        ? JSON.stringify(parsedArgs, null, 2)
        : (
          <span className="text-muted-foreground italic">
            {tool.function.arguments || "等待参数…"}
          </span>
        )}
    </div>
  );
};

/* ==========================================================================
 * Tool-call message (collapsible)
 * ========================================================================== */

const ToolMessage: FC<{ message: DisplayMessage }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);

  const tc = message.toolCalls?.[0];
  const toolStatus = tc?.hermes_status;
  const isRunning =
    toolStatus === "running" || (message.isStreaming && !toolStatus);
  const emoji = tc?.hermes_emoji;
  const label = tc?.hermes_label;
  const toolName = tc?.function?.name || message.content;
  const hasDetail = !!label || (!!tc?.function?.arguments && !tc?.hermes_emoji);

  return (
    <div className="flex gap-3 justify-start" role="article" aria-label="tool call">
      {/* Avatar — prefer Hermes emoji, fall back to spinner/check */}
      <div
        className={cn(
          "shrink-0 h-7 w-7 rounded-full flex items-center justify-center mt-0.5 transition-colors text-base leading-none",
          isRunning
            ? "bg-status-investigating/10"
            : "bg-status-resolved/10",
        )}
        aria-hidden="true"
      >
        {emoji ? (
          <span className="leading-none">{emoji}</span>
        ) : isRunning ? (
          <Loader2 className="h-3.5 w-3.5 text-status-investigating animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5 text-status-resolved" />
        )}
      </div>

      <div className="max-w-[85%] min-w-0">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((v) => !v)}
          className={cn(
            "w-full text-left rounded-2xl rounded-bl-md border px-4 py-2.5 transition-colors",
            "border-status-investigating/20 bg-status-investigating/[0.03]",
            hasDetail && "hover:bg-status-investigating/[0.06] cursor-pointer",
          )}
        >
          {/* ── Header row (always visible) ────────────────────────────── */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Hermes emoji as icon */}
            {emoji ? (
              <span className="text-base leading-none" aria-hidden="true">
                {emoji}
              </span>
            ) : (
              <span className="text-sm leading-none" aria-hidden="true">🔧</span>
            )}

            <span className="text-sm font-medium text-status-investigating">
              调用工具
            </span>

            <span className="font-mono text-xs text-text-secondary bg-surface-secondary rounded px-1.5 py-0.5">
              {toolName}
            </span>

            {isRunning ? (
              <span className="text-xs text-muted-foreground animate-pulse">
                执行中…
              </span>
            ) : (
              <span className="text-xs text-status-resolved">完成</span>
            )}

            {/* Expand/collapse chevron */}
            {hasDetail && (
              <span className="ml-auto text-muted-foreground">
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </span>
            )}
          </div>

          {/* ── Detail section (expandable) ─────────────────────────────── */}
          {expanded && hasDetail && (
            <div className="mt-2 pt-2 border-t border-border/50">
              {label && (
                <div className="mb-2">
                  <p className="text-[11px] text-muted-foreground mb-1">
                    描述
                  </p>
                  <p className="text-xs text-text-secondary break-all leading-relaxed">
                    {label}
                  </p>
                </div>
              )}
              {!label &&
                message.toolCalls?.map((t, i) => (
                  <ToolArgs key={t.id || i} tool={t} isStreaming={isRunning} />
                ))}
            </div>
          )}
        </button>
      </div>
    </div>
  );
};

/* ==========================================================================
 * Message bubble
 * ========================================================================== */

export const ChatMessage: FC<{ message: DisplayMessage }> = ({ message }) => {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isError = message.role === "error";

  /* ── Tool-call message ───────────────────────────────────────────── */
  if (isTool) {
    return <ToolMessage message={message} />;
  }

  /* ── Regular messages ────────────────────────────────────────────── */
  return (
    <div
      className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
      role="article"
      aria-label={`${message.role} message`}
    >
      {!isUser && (
        <div
          className={`shrink-0 h-7 w-7 rounded-full flex items-center justify-center mt-0.5 ${
            isError
              ? "bg-status-active/10 text-status-active"
              : "bg-interactive-primary/10 text-interactive-primary"
          }`}
          aria-hidden="true"
        >
          {isError ? <AlertCircle className="h-3.5 w-3.5" /> : <LiumaiLogo size={14} className="text-current" />}
        </div>
      )}

      <div
        className={`max-w-[85%] min-w-0 ${
          isUser
            ? "bg-interactive-primary text-text-inverse rounded-2xl rounded-br-md px-4 py-2.5"
            : isError
              ? "bg-status-active/5 text-status-active border border-status-active/20 rounded-2xl rounded-bl-md px-4 py-2.5"
              : "bg-surface-secondary text-text-primary rounded-2xl rounded-bl-md px-4 py-2.5"
        }`}
      >
        {message.content && (
          <div className="text-sm leading-relaxed markdown-body">
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
              {message.content}
            </ReactMarkdown>
            {message.isStreaming && (
              <span
                className="inline-block w-1.5 h-4 ml-0.5 bg-current align-text-bottom animate-pulse rounded-sm"
                aria-hidden="true"
              />
            )}
          </div>
        )}

        {!message.content && !message.toolCalls?.length && message.isStreaming && (
          <div className="flex items-center gap-1.5 py-1" aria-label="思考中…">
            <span className="h-2 w-2 rounded-full bg-interactive-primary animate-bounce [animation-delay:0ms]" />
            <span className="h-2 w-2 rounded-full bg-interactive-primary animate-bounce [animation-delay:150ms]" />
            <span className="h-2 w-2 rounded-full bg-interactive-primary animate-bounce [animation-delay:300ms]" />
          </div>
        )}
      </div>

      {isUser && (
        <div
          className="shrink-0 h-7 w-7 rounded-full bg-interactive-primary flex items-center justify-center mt-0.5"
          aria-hidden="true"
        >
          <User className="h-3.5 w-3.5 text-white" />
        </div>
      )}
    </div>
  );
};
