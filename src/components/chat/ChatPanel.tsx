/** Intelligent chat panel with sidebar session history.

Follows the DeepSeek / mainstream pattern:
- Left sidebar with compact two-line session items (title + relative timestamp)
- No per-item icons — clean layout with full-width titles
- Pill-shaped input area with integrated send button
- Full-height layout (no page header — chat fills the view)
*/

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type KeyboardEvent,
} from "react";
import {
  Send,
  Trash2,
  Loader2,
  Plus,
  PanelLeft,
} from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { chatHistory, type ChatSessionSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ── Relative time formatter ─────────────────────────────── */

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

/* ═══════════════════════════════════════════════════════════ */

export const ChatPanel: FC = () => {
  const {
    messages,
    isStreaming,
    error,
    sessionId,
    sendMessage,
    clearMessages,
    loadSession,
  } = useChat();

  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const bottomRef = useRef<HTMLDivElement>(null);

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await chatHistory.list());
    } catch { /* backend may not be up yet */ }
  }, []);

  useEffect(() => { reloadSessions(); }, [reloadSessions]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages]);

  // Refresh session list after streaming finishes
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      reloadSessions().catch(() => {});
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming, reloadSessions]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    const text = input;
    setInput("");
    await sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleNewSession = useCallback(() => {
    clearMessages();
  }, [clearMessages]);

  const handleLoadSession = useCallback(
    async (id: number) => {
      try { await loadSession(id); } catch { /* 404 */ }
    },
    [loadSession],
  );

  const handleDeleteSession = useCallback(
    async (id: number, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await chatHistory.delete(id);
        if (sessionId === id) clearMessages();
        reloadSessions();
      } catch { /* ok */ }
    },
    [sessionId, clearMessages, reloadSessions],
  );

  /* ── Sidebar content ─────────────────────────────────── */
  const sidebarContent = (
    <div className={cn(
      "shrink-0 border-r border-border flex flex-col transition-all duration-200 overflow-hidden",
      sidebarOpen ? "w-[260px]" : "w-0 border-r-0",
    )}>
      {/* New session button */}
      <div className="shrink-0 px-3 py-3">
        <button
          type="button"
          onClick={handleNewSession}
          className="flex items-center gap-2.5 w-full rounded-lg px-3 py-2.5 text-[13px] text-text-secondary hover:bg-black/5 transition-colors"
        >
          <Plus className="h-4 w-4" />
          <span>新对话</span>
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="px-2 pb-2">
            {sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground py-6 text-center">
                暂无对话历史
              </p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={cn(
                    "group flex items-start rounded-lg px-3 py-2.5 cursor-pointer transition-colors",
                    sessionId === s.id
                      ? "bg-interactive-primary/8"
                      : "hover:bg-black/[0.04]",
                  )}
                  onClick={() => handleLoadSession(s.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLoadSession(s.id);
                  }}
                >
                  {/* Text area */}
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        "text-[13px] leading-snug truncate",
                        sessionId === s.id
                          ? "text-text-primary font-medium"
                          : "text-text-secondary",
                      )}
                    >
                      {s.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                      {relativeTime(s.updated_at)}
                    </p>
                  </div>
                  {/* Delete button */}
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-status-active/10 text-muted-foreground hover:text-status-active transition-all shrink-0 ml-1 mt-0.5"
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    aria-label={`删除 ${s.title}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );

  /* ── Main content ────────────────────────────────────── */
  return (
    <div className="flex flex-row h-full bg-surface-primary">
      {sidebarContent}

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0 max-w-[48rem] mx-auto w-full">
        {/* Top bar */}
        <div className="shrink-0 flex items-center justify-between px-3 py-2.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          >
            <PanelLeft className={cn("h-4 w-4 transition-transform", !sidebarOpen && "rotate-180")} />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div
              className={cn(
                "flex flex-col gap-4 px-4 py-2",
                messages.length === 0 && "min-h-full justify-center",
              )}
            >
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center text-center px-4">
                  <div className="h-14 w-14 rounded-2xl bg-interactive-primary/10 flex items-center justify-center mb-5">
                    <svg
                      className="h-7 w-7 text-interactive-primary"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
                      />
                    </svg>
                  </div>
                  <h2 className="text-lg font-semibold text-text-primary mb-1.5">
                    运维智能助手
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-sm">
                    可以问我关于系统状态、故障排查、指标分析等问题
                  </p>
                </div>
              )}
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
              {error && (
                <div className="text-xs text-status-active bg-status-active/5 rounded-lg px-3 py-2 border border-status-active/10">
                  {error}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </div>

        {/* Input — pill-shaped */}
        <div className="shrink-0 px-4 pb-4 pt-2">
          <div className="relative flex items-center max-w-[48rem] mx-auto">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? "等待回复中…" : "输入消息，Enter 发送"}
              disabled={isStreaming}
              className="w-full h-12 rounded-2xl border border-border bg-surface-secondary pl-5 pr-12 text-sm text-text-primary placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-interactive-primary/20 focus:border-interactive-primary disabled:opacity-50 transition-shadow"
              aria-label="聊天输入"
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
              className="absolute right-2 rounded-xl h-8 w-8"
              aria-label={isStreaming ? "发送中…" : "发送"}
            >
              {isStreaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
