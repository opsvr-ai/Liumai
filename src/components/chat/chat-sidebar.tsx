/* ==========================================================================
 *  Session sidebar
 *
 *  Desktop: an in-flow column, 248px wide, collapsible to zero width.
 *  <1024px: an overlay drawer that slides in from the left.
 * ========================================================================== */

import type { FC, KeyboardEvent, MouseEvent } from "react";
import { Clock, MessageCircle, Plus, Trash2, X } from "lucide-react";
import type { ChatSessionSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { relativeTime } from "./chat-utils";

export interface ChatSidebarProps {
  sessions: ChatSessionSummary[];
  sessionId: number | null;
  open: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onLoadSession: (id: number) => void;
  onDeleteSession: (id: number, event: MouseEvent) => void;
}

export const ChatSidebar: FC<ChatSidebarProps> = ({
  sessions,
  sessionId,
  open,
  onToggle,
  onNewSession,
  onLoadSession,
  onDeleteSession,
}) => {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onLoadSession(id);
    }
  };

  const content = (
    <>
      {/* Header — new conversation */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-2.5">
        <button
          type="button"
          onClick={onNewSession}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/70 bg-surface-primary px-2.5 py-1.5 text-[12.5px] font-medium text-text-primary shadow-sm transition-colors duration-150 hover:bg-surface-secondary"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">新对话</span>
        </button>
        <button
          type="button"
          onClick={onToggle}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-tertiary/60 hover:text-text-primary lg:hidden"
          aria-label="关闭会话列表"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Session list */}
      <div className="chat-thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <p className="px-1.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
          最近对话
        </p>
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-tertiary/60 text-muted-foreground/50">
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground/70">
              暂无对话历史
              <br />
              发送第一条消息后会保存在这里
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((session) => {
              const active = sessionId === session.id;
              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onLoadSession(session.id)}
                  onKeyDown={(event) => handleKeyDown(event, session.id)}
                  className={cn(
                    "group/item cursor-pointer rounded-lg px-2.5 py-2 transition-colors duration-150 outline-none",
                    active
                      ? "bg-surface-primary shadow-sm ring-1 ring-border/70"
                      : "hover:bg-surface-tertiary/45 focus-visible:bg-surface-tertiary/45",
                  )}
                >
                  <div className="flex items-start gap-1.5">
                    <p
                      className={cn(
                        "line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-snug",
                        active
                          ? "font-medium text-text-primary"
                          : "text-text-secondary",
                      )}
                    >
                      {session.title || "新对话"}
                    </p>
                    {active && (
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-interactive-primary"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-1">
                    <span className="text-[10.5px] text-muted-foreground/55">
                      {relativeTime(session.updated_at)}
                    </span>
                    <button
                      type="button"
                      onClick={(event) => onDeleteSession(session.id, event)}
                      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/40 opacity-100 transition-all duration-150 hover:bg-status-active/10 hover:text-status-active focus-visible:opacity-100 lg:opacity-0 lg:group-hover/item:opacity-100"
                      aria-label={`删除会话 ${session.title || ""}`}
                      title="删除会话"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground/45">
        <Clock className="h-2.5 w-2.5" aria-hidden="true" />
        历史会话自动保存
      </div>
    </>
  );

  return (
    <>
      {/* Desktop column */}
      <aside
        aria-hidden={!open}
        className={cn(
          "hidden shrink-0 overflow-hidden border-r border-border/60 bg-surface-secondary/25 transition-[width] duration-200 ease-out lg:flex lg:flex-col",
          open ? "w-[248px]" : "pointer-events-none w-0 border-r-0",
        )}
      >
        <div className="flex h-full w-[248px] flex-col">{content}</div>
      </aside>

      {/* Mobile / tablet drawer */}
      <div
        className={cn(
          "absolute inset-0 z-40 bg-overlay transition-opacity duration-200 lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onToggle}
        aria-hidden="true"
      />
      <aside
        aria-hidden={!open}
        className={cn(
          "absolute inset-y-0 left-0 z-50 flex w-[276px] flex-col border-r border-border bg-surface-primary shadow-xl transition-transform duration-200 ease-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {content}
      </aside>
    </>
  );
};
