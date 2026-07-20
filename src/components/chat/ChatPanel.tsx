/** Intelligent chat panel with session history.

Left sidebar with session list + main chat area.  Sessions are persisted
to the backend and can be created, loaded, and deleted.
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
  ChevronLeft,
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
  const [showHistory, setShowHistory] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await chatHistory.list());
    } catch { /* backend may not be up yet */ }
  }, []);

  useEffect(() => { reloadSessions(); }, [reloadSessions]);

  // Auto-scroll
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Refresh session list after streaming finishes
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      reloadSessions().catch(() => {});
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming, reloadSessions]);

  // Send (auto-save handled by useChat's useEffect)
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
    setShowHistory(false);
  }, [clearMessages]);

  const handleLoadSession = useCallback(
    async (id: number) => {
      try { await loadSession(id); setShowHistory(false); } catch { /* 404 */ }
    },
    [loadSession],
  );

  const handleDeleteSession = useCallback(
    async (id: number) => {
      try {
        await chatHistory.delete(id);
        if (sessionId === id) clearMessages();
        reloadSessions();
      } catch { /* ok */ }
    },
    [sessionId, clearMessages, reloadSessions],
  );

  return (
    <div className="flex flex-col h-full bg-surface-primary">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost" size="icon"
            onClick={() => setShowHistory((v) => !v)}
            aria-label={showHistory ? "关闭历史" : "对话历史"}
          >
            {showHistory ? <ChevronLeft className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
          </Button>
          <div className="h-2 w-2 rounded-full bg-status-active" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Hermes 在线</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleNewSession} aria-label="新建对话">
            <Plus className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={clearMessages}
            disabled={messages.length === 0} aria-label="清空对话">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* History panel */}
      {showHistory && (
        <div className="shrink-0 border-b border-border max-h-48 overflow-y-auto bg-surface-secondary">
          <div className="px-3 py-2">
            <p className="text-[11px] font-medium text-muted-foreground mb-2 uppercase tracking-wide">
              对话历史
            </p>
            {sessions.length === 0 && (
              <p className="text-xs text-muted-foreground py-2 text-center">暂无历史对话</p>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer transition-colors group",
                  sessionId === s.id ? "bg-white shadow-sm" : "hover:bg-white/60",
                )}
                onClick={() => handleLoadSession(s.id)}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") handleLoadSession(s.id); }}
              >
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 text-[13px] text-text-secondary truncate">{s.title}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">{s.message_count}</span>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-status-active/10 text-muted-foreground hover:text-status-active transition-all"
                  onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                  aria-label={`删除 ${s.title}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div ref={viewportRef} className="flex flex-col gap-3 px-3 py-3">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <div className="h-12 w-12 rounded-full bg-interactive-primary/10 flex items-center justify-center mb-4">
                  <svg className="h-6 w-6 text-interactive-primary" fill="none" viewBox="0 0 24 24"
                    stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round"
                      d="M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-text-secondary mb-1">运维智能助手</p>
                <p className="text-xs text-muted-foreground">
                  可以问我关于系统状态、故障排查、指标分析等问题
                </p>
              </div>
            )}
            {messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)}
            {error && (
              <div className="text-xs text-status-active bg-status-active/5 rounded-lg px-3 py-2 border border-status-active/10">
                {error}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-center gap-2">
          <input
            type="text" value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "等待回复中…" : "输入消息，Enter 发送"}
            disabled={isStreaming}
            className="flex-1 h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm text-text-primary placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-interactive-primary/25 focus:border-interactive-primary disabled:opacity-50"
            aria-label="聊天输入"
          />
          <Button size="icon" onClick={handleSend}
            disabled={!input.trim() || isStreaming}
            aria-label={isStreaming ? "发送中…" : "发送"}>
            {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
};
