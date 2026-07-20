/** Intelligent chat panel with sidebar session history.

Follows the mainstream pattern (ChatGPT, Claude): a fixed left sidebar
listing past conversations, with the main chat area on the right.
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
  MessageSquare,
  PanelLeft,
} from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { chatHistory, type ChatSessionSummary } from "@/lib/api";
import { cn } from "@/lib/utils";

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

  return (
    <div className="flex flex-row h-full bg-surface-primary">
      {/* ═══════════════════════════════════════════════════════════
          Sidebar — session history
          ═══════════════════════════════════════════════════════════ */}
      <div
        className={cn(
          "shrink-0 border-r border-border bg-surface-secondary flex flex-col transition-all duration-200",
          sidebarOpen ? "w-60" : "w-0 overflow-hidden border-r-0",
        )}
      >
        {/* Sidebar header */}
        <div className="shrink-0 px-3 py-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-[13px]"
            onClick={handleNewSession}
          >
            <Plus className="h-4 w-4" />
            新对话
          </Button>
        </div>

        {/* Divider */}
        <div className="border-t border-border mx-3" />

        {/* Session list */}
        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="px-2 py-2">
              {sessions.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center px-2">
                  暂无对话历史
                </p>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer transition-colors",
                      sessionId === s.id
                        ? "bg-white shadow-sm"
                        : "hover:bg-white/60",
                    )}
                    onClick={() => handleLoadSession(s.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLoadSession(s.id);
                    }}
                  >
                    <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 text-[13px] text-text-secondary truncate">
                      {s.title}
                    </span>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-status-active/10 text-muted-foreground hover:text-status-active transition-all shrink-0"
                      onClick={(e) => handleDeleteSession(s.id, e)}
                      aria-label={`删除 ${s.title}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          Main content — header + messages + input
          ═══════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
            >
              <PanelLeft className={cn("h-4 w-4 transition-transform", !sidebarOpen && "rotate-180")} />
            </Button>
            <div className="h-2 w-2 rounded-full bg-status-active" aria-hidden="true" />
            <span className="text-xs text-muted-foreground">Hermes 在线</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={clearMessages}
              disabled={messages.length === 0}
              aria-label="清空对话"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Message list */}
        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div
              className={cn(
                "flex flex-col gap-3 px-3 py-3",
                messages.length === 0 && "min-h-full justify-center",
              )}
            >
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center text-center px-4">
                  <div className="h-12 w-12 rounded-full bg-interactive-primary/10 flex items-center justify-center mb-4">
                    <svg
                      className="h-6 w-6 text-interactive-primary"
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
                  <p className="text-sm font-medium text-text-secondary mb-1">
                    运维智能助手
                  </p>
                  <p className="text-xs text-muted-foreground">
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

        {/* Input */}
        <div className="shrink-0 border-t border-border p-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? "等待回复中…" : "输入消息，Enter 发送"}
              disabled={isStreaming}
              className="flex-1 h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm text-text-primary placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-interactive-primary/25 focus:border-interactive-primary disabled:opacity-50"
              aria-label="聊天输入"
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
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
