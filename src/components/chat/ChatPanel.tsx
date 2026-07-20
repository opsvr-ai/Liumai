/** Intelligent chat panel — left sidebar conversational interface.

Connects to the Hermes agent via SSE streaming and renders a
ChatGPT-style message list with real-time text deltas, tool-call
cards, and error handling.
*/

import { useCallback, useEffect, useRef, useState, type FC, type KeyboardEvent } from "react";
import { Send, Trash2, Loader2 } from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";

export const ChatPanel: FC = () => {
  const { messages, isStreaming, error, sendMessage, clearMessages } = useChat();
  const [input, setInput] = useState("");

  const viewportRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = viewportRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input);
    setInput("");
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

  return (
    <div className="flex flex-col h-full bg-surface-primary">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-status-active" aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Hermes 在线</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={clearMessages}
          disabled={messages.length === 0}
          aria-label="清空对话"
          title="清空对话"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* ── Message list ────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div ref={viewportRef} className="flex flex-col gap-3 px-3 py-3">
            {/* Empty state */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
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

            {/* Messages */}
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}

            {/* Error banner */}
            {error && (
              <div className="text-xs text-status-active bg-status-active/5 rounded-lg px-3 py-2 border border-status-active/10">
                {error}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* ── Input area ──────────────────────────────────────────── */}
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
  );
};
