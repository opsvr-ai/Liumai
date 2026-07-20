/** Individual chat message bubble.

Renders four distinct message types:
- **user** — blue bubble, right-aligned
- **assistant** — gray bubble with streaming cursor
- **tool** — amber-bordered card with spinner→check status
- **error** — red-bordered alert
*/

import { useMemo, type FC } from "react";
import { Bot, User, Wrench, AlertCircle, Loader2, Check } from "lucide-react";
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
 * Message bubble
 * ========================================================================== */

export const ChatMessage: FC<{ message: DisplayMessage }> = ({ message }) => {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isError = message.role === "error";

  /* ── Tool-call message ───────────────────────────────────────────── */
  if (isTool) {
    const tc = message.toolCalls?.[0];
    const toolStatus = tc?.hermes_status;
    const isRunning = toolStatus === "running" || (message.isStreaming && !toolStatus);
    const emoji = tc?.hermes_emoji;
    const label = tc?.hermes_label;

    return (
      <div className="flex gap-3 justify-start" role="article" aria-label="tool call">
        {/* Status icon */}
        <div
          className={cn(
            "shrink-0 h-7 w-7 rounded-full flex items-center justify-center mt-0.5 transition-colors",
            isRunning
              ? "bg-status-investigating/10 text-status-investigating"
              : "bg-status-resolved/10 text-status-resolved",
          )}
          aria-hidden="true"
        >
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </div>

        <div className="max-w-[85%] min-w-0 rounded-2xl rounded-bl-md border border-status-investigating/20 bg-status-investigating/[0.03] px-4 py-2.5">
          {/* Header row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {emoji && <span className="text-sm leading-none" aria-hidden="true">{emoji}</span>}
            <span className="text-sm font-medium text-status-investigating">
              调用工具
            </span>
            <span className="font-mono text-xs text-text-secondary bg-surface-secondary rounded px-1.5 py-0.5">
              {tc?.function?.name || message.content}
            </span>
            {isRunning && (
              <span className="text-xs text-muted-foreground animate-pulse">
                执行中…
              </span>
            )}
          </div>

          {/* Label / description */}
          {label && (
            <p className="mt-1.5 text-xs text-text-secondary break-all leading-relaxed">
              {label}
            </p>
          )}

          {/* Legacy: JSON arguments (for non-Hermes tool calls) */}
          {!label && message.toolCalls?.map((t, i) => (
            <ToolArgs
              key={t.id || i}
              tool={t}
              isStreaming={isRunning}
            />
          ))}
        </div>
      </div>
    );
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
          {isError ? <AlertCircle className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
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
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
            {message.content}
            {message.isStreaming && (
              <span
                className="inline-block w-1.5 h-4 ml-0.5 bg-current align-text-bottom animate-pulse rounded-sm"
                aria-hidden="true"
              />
            )}
          </p>
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
