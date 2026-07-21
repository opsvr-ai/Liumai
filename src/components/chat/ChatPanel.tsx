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
  Clock,
  Upload,
  FileText,
  X,
  MessageCircle,
  Activity,
  BookOpen,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import { useChat } from "@/hooks/useChat";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { LiumaiLogo } from "@/components/liumai-logo";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { chatHistory, chatModes, authApi, hermesDiscovery, type ChatModeOut, type ChatSessionSummary } from "@/lib/api";
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
  const defaultWelcome = "你好！我是六脉智能运维助手。我可以帮你实时监控、追踪故障根因、分析历史数据、协调应急响应。随时向我提问，一起保障系统稳定运行。";
  const [welcomeText, setWelcomeText] = useState("");       // start empty — no flash
  const [welcomeLoading, setWelcomeLoading] = useState(true); // shimmer while waiting
  const [welcomeTyping, setWelcomeTyping] = useState(false);
  const welcomeIndexRef = useRef(0);
  const welcomeTargetRef = useRef(defaultWelcome);

  const typewriterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up typewriter interval on unmount
  useEffect(() => {
    return () => {
      if (typewriterTimerRef.current) {
        clearInterval(typewriterTimerRef.current);
        typewriterTimerRef.current = null;
      }
    };
  }, []);

  // Typewriter — exposed as a stable callback
  const startTypewriter = useCallback((text: string) => {
    if (!text || text === welcomeTargetRef.current) return;
    welcomeTargetRef.current = text;
    welcomeIndexRef.current = 0;
    setWelcomeText("");
    setWelcomeTyping(true);
    const chars = [...text];
    // Clear any running timer before starting a new one
    if (typewriterTimerRef.current) {
      clearInterval(typewriterTimerRef.current);
    }
    typewriterTimerRef.current = setInterval(() => {
      welcomeIndexRef.current++;
      if (welcomeIndexRef.current <= chars.length) {
        setWelcomeText(chars.slice(0, welcomeIndexRef.current).join(""));
      } else {
        if (typewriterTimerRef.current) {
          clearInterval(typewriterTimerRef.current);
          typewriterTimerRef.current = null;
        }
        setWelcomeTyping(false);
      }
    }, 40);
  }, []);

  /* ── Mode icon map ────────────────────────────────── */
  const modeIcons: Record<string, typeof MessageCircle> = {
    default: MessageCircle,
    general: Sparkles,
    rca: Activity,
    knowledge: BookOpen,
  };

  /* ── Mode state ───────────────────────────────────── */
  const [modes, setModes] = useState<ChatModeOut[]>([]);
  const [activeMode, setActiveMode] = useState<string | null>("general");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [rcaTimeStart, setRcaTimeStart] = useState("");
  const [rcaTimeEnd, setRcaTimeEnd] = useState("");
  const [rcaPreset, setRcaPreset] = useState("none");

  /* ── File attachment (knowledge QA mode) ──────────── */
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachedContent, setAttachedContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [converting, setConverting] = useState(false);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setAttachedFile(file);
      setAttachedContent("");
      setConverting(true);
      try {
        const token = localStorage.getItem("liumai_token");
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/chat/convert-file", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: "转换失败" }));
          throw new Error(err.detail || "转换失败");
        }
        const data = await res.json();
        setAttachedContent(data.content);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "转换失败";
        setAttachedContent(`[${msg}: ${file.name}]`);
      } finally {
        setConverting(false);
      }
    },
    [],
  );

  const clearAttachment = useCallback(() => {
    setAttachedFile(null);
    setAttachedContent("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const bottomRef = useRef<HTMLDivElement>(null);

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await chatHistory.list());
    } catch { /* backend may not be up yet */ }
  }, []);

  useEffect(() => { reloadSessions(); }, [reloadSessions]);

  // Fetch personalised welcome text (re-fetch on new session)
  const fetchWelcome = useCallback(() => {
    setWelcomeLoading(true);
    setWelcomeText("");
    const username = localStorage.getItem("liumai_user") || "用户";
    authApi.generateWelcome(username)
      .then((r) => { startTypewriter(r.text); })
      .catch(() => {
        // AI unavailable — use the (richer) default text directly, no typewriter
        setWelcomeText(defaultWelcome);
      })
      .finally(() => setWelcomeLoading(false));
  }, [startTypewriter, defaultWelcome]);

  useEffect(() => { fetchWelcome(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load modes
  useEffect(() => {
    chatModes.list().then(setModes).catch(() => {});
  }, []);

  // Load available LLM models + default model
  useEffect(() => {
    hermesDiscovery.listLlmModels().then((models) => {
      setAvailableModels(models);
    }).catch(() => {});
    authApi.getLlmConfig().then((cfg) => {
      if (cfg.model) setSelectedModel(cfg.model);
    }).catch(() => {});
  }, []);

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
    let text = input;
    setInput("");
    // General mode: inline attached document content
    if (activeMode === "general" && attachedContent) {
      const fileName = attachedFile?.name ?? "文档";
      text = `[上传文档: ${fileName}]\n\n${attachedContent}\n\n[用户问题]\n${text}`;
      clearAttachment();
    }
    const twStart = activeMode === "rca" ? (rcaTimeStart || new Date(Date.now() - 15 * 60000).toISOString()) : undefined;
    const twEnd = activeMode === "rca" ? (rcaTimeEnd || new Date().toISOString()) : undefined;
    await sendMessage(text, {
      mode: activeMode ?? undefined,
      timeWindowStart: twStart,
      timeWindowEnd: twEnd,
      model: activeMode === "general" ? (selectedModel || undefined) : undefined,
    });
  }, [input, isStreaming, sendMessage, activeMode, rcaTimeStart, rcaTimeEnd, attachedContent, attachedFile, clearAttachment]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea: 3–5 lines, then scroll
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 24; // matches leading-relaxed text-sm
    const minH = lineHeight * 3 + 16; // 3 lines + padding
    const maxH = lineHeight * 5 + 16; // 5 lines + padding
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minH), maxH)}px`;
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Run auto-resize whenever input changes
  useEffect(() => { autoResize(); }, [input, autoResize]);

  const applyRcaPreset = useCallback((preset: string) => {
    setRcaPreset(preset);
    if (preset === "none") return;
    const minutes = { "15m": 15, "1h": 60, "4h": 240, "24h": 1440 }[preset];
    if (minutes) {
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60000);
      setRcaTimeStart(start.toISOString().slice(0, 16));
      setRcaTimeEnd(end.toISOString().slice(0, 16));
    }
  }, []);

  const handleNewSession = useCallback(() => {
    clearMessages();
    setActiveMode(null);
    fetchWelcome();
  }, [clearMessages, fetchWelcome]);

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
      sidebarOpen ? "w-[260px]" : "w-[52px]",
    )}>
      {/* Sidebar header — toggle + new session */}
      <div className="shrink-0 px-3 py-2.5 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
        >
          <PanelLeft className={cn("h-4 w-4 transition-transform", !sidebarOpen && "rotate-180")} />
        </Button>
        {sidebarOpen && (
          <button
            type="button"
            onClick={handleNewSession}
            className="flex items-center gap-2.5 flex-1 rounded-lg px-2.5 py-2 text-[13px] text-text-secondary hover:bg-black/5 transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>新对话</span>
          </button>
        )}
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
        {/* Top bar — minimal spacer */}
        <div className="shrink-0 h-2" />

        {/* Messages — flex-1 when chatting, auto-height when empty */}
        <div className={cn(messages.length === 0 ? "shrink-0" : "flex-1 min-h-0")}>
          <ScrollArea className="h-full">
            <div
              className="flex flex-col gap-4 px-4 py-2"
            >
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

        {/* ── Unified input area — centered when empty, bottom when chatting ── */}
        <div
          className={cn(
            "px-4 pb-4 pt-2 transition-all duration-500 ease-out",
            messages.length === 0
              ? "flex-1 flex flex-col justify-center items-center pb-16"
              : "shrink-0",
          )}
        >
          <div className="w-full max-w-[48rem] mx-auto space-y-4">
            {/* Welcome — logo + tagline centered above input */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center text-center pb-1">
                {/* Logo with pulsing glow ring */}
                <div className="relative mb-5">
                  <div className="absolute inset-0 rounded-full bg-interactive-primary/20 blur-2xl scale-150 animate-pulse" />
                  <div className="absolute -inset-2 rounded-full border border-interactive-primary/20 animate-ping [animation-duration:3s]" />
                  <LiumaiLogo size={48} className="text-interactive-primary relative" />
                </div>

                {/* Gradient title */}
                <h2 className="text-[22px] font-bold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent mb-2">
                  运维智能助手
                </h2>

                {/* Welcome text area */}
                <div className="min-h-[60px] max-w-[420px] mb-3">
                  {welcomeLoading ? (
                    /* ── Shimmer loading ──────────────────── */
                    <div className="space-y-2">
                      <div className="h-3.5 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/20 to-muted-foreground/10 rounded-full w-64 mx-auto animate-pulse bg-[length:200%_100%]" />
                      <div className="h-3.5 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/20 to-muted-foreground/10 rounded-full w-48 mx-auto animate-pulse bg-[length:200%_100%]" />
                      <p className="text-[11px] text-muted-foreground/50 mt-1">
                        <span className="inline-block animate-bounce [animation-delay:0ms]">●</span>
                        <span className="inline-block animate-bounce [animation-delay:150ms] ml-1">●</span>
                        <span className="inline-block animate-bounce [animation-delay:300ms] ml-1">●</span>
                      </p>
                    </div>
                  ) : (
                    /* ── Welcome text (typewriter or fallback) ── */
                    <p className="text-[13px] leading-relaxed text-muted-foreground">
                      {welcomeText}
                      {welcomeTyping && (
                        <span className="inline-block w-0.5 h-4 bg-interactive-primary ml-0.5 align-middle animate-pulse" />
                      )}
                    </p>
                  )}
                </div>

                {/* Quick suggestion hints */}
                {!welcomeLoading && (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {["系统健康检查", "最近告警分析", "帮我排查故障"].map((hint) => (
                      <button key={hint} type="button"
                        onClick={() => { setInput(hint); }}
                        className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 text-muted-foreground hover:text-text-primary hover:border-interactive-primary/30 hover:bg-interactive-primary/5 transition-all duration-200">
                        {hint}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Input card: tab bar + extensions + textarea ── */}
            <div className="rounded-2xl border border-border bg-surface-secondary shadow-sm overflow-hidden transition-shadow focus-within:ring-2 focus-within:ring-interactive-primary/20 focus-within:border-interactive-primary">
              {/* Tab bar — pill-style with icons */}
              {modes.length > 0 && (
                <div className="flex items-center gap-1 px-2.5 py-2">
                  {modes.map((m) => {
                    const Icon = modeIcons[m.slug] || MessageCircle;
                    const isActive = activeMode === m.slug || (!activeMode && m.slug === "general");
                    return (
                      <button
                        key={m.slug}
                        type="button"
                        onClick={() => setActiveMode(isActive ? null : m.slug)}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-200",
                          isActive
                            ? "bg-interactive-primary/8 text-interactive-primary shadow-sm"
                            : "text-muted-foreground hover:text-text-secondary hover:bg-surface-primary/40",
                        )}
                      >
                        <Icon className="h-3 w-3" />
                        {m.name}
                        {isActive && (
                          <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-interactive-primary animate-pulse" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

{activeMode === "rca" && (
                <div className="px-4 py-2 flex flex-wrap items-center gap-2 border-t border-border/30">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  {[["none","自定义"],["15m","15分钟"],["1h","1小时"],["4h","4小时"],["24h","24小时"]].map(([val, label]) => (
                    <button key={val} type="button" onClick={() => applyRcaPreset(val)} className={cn("px-2 py-0.5 rounded text-[11px] transition-colors border", rcaPreset === val ? "bg-interactive-primary/10 text-interactive-primary border-interactive-primary/30" : "text-muted-foreground border-transparent hover:border-border")}>{label}</button>
                  ))}
                  {rcaPreset === "none" && (<><input type="datetime-local" value={rcaTimeStart} onChange={(e) => setRcaTimeStart(e.target.value)} className="h-7 rounded border border-border bg-surface-primary px-2 text-[11px] text-text-primary" /><span className="text-[11px] text-muted-foreground">→</span><input type="datetime-local" value={rcaTimeEnd} onChange={(e) => setRcaTimeEnd(e.target.value)} className="h-7 rounded border border-border bg-surface-primary px-2 text-[11px] text-text-primary" /></>)}
                </div>
              )}

              {/* Textarea with bottom bar */}
              <div className={cn("relative flex flex-col", (activeMode === "knowledge" || activeMode === "rca") && "border-t border-border/30")}>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isStreaming ? "等待回复中…"
                    : activeMode === "general" ? "通用模型智能问答，支持多格式文档上传… Enter 发送，Shift+Enter 换行"
                    : activeMode === "default" ? "智能运维助理，具备工具调用与自主执行能力… Enter 发送，Shift+Enter 换行"
                    : activeMode === "knowledge" ? "遵循 LLM-WIKI V2 协议，从知识库进行知识检索与问答… Enter 发送，Shift+Enter 换行"
                    : activeMode === "rca" ? "故障根因分析，输入服务名称和时间窗口… Enter 发送，Shift+Enter 换行"
                    : "输入消息，Enter 发送，Shift+Enter 换行"
                  }
                  disabled={isStreaming}
                  rows={1}
                  className="w-full bg-transparent pl-5 pr-12 py-3 text-sm text-text-primary placeholder:text-muted-foreground/50 disabled:opacity-50 resize-none leading-relaxed outline-none"
                  style={{ minHeight: "48px" }}
                  aria-label="聊天输入"
                />

                {/* Bottom bar: file upload (left) + attached file name + model dropdown (right) + send */}
                <div className="flex items-center justify-between px-3 pb-2.5 gap-2">
                  {/* Left: file upload (general mode only) */}
                  <div className="flex items-center gap-1.5">
                    {activeMode === "general" && (
                      <>
                        <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden"
                          accept=".pdf,.docx,.pptx,.xlsx,.xls,.epub,.html,.csv,.json,.xml,.ipynb,.jpg,.jpeg,.png,.gif,.bmp,.tiff,.zip,.txt,.md,.py,.js,.ts,.log,.sql,.yaml,.yml,.ini,.cfg,.css,.rss" />
                        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={converting}
                          className="flex items-center justify-center h-7 w-7 rounded-lg border border-border/60 text-muted-foreground hover:text-text-primary hover:border-interactive-primary/30 hover:bg-interactive-primary/5 transition-all disabled:opacity-50"
                          title="上传文档">
                          {converting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
                        </button>
                        {attachedFile && !converting && (
                          <span className="text-[11px] text-muted-foreground truncate max-w-[140px] flex items-center gap-1">
                            <FileText className="h-3 w-3 shrink-0" />
                            {attachedFile.name}
                            <button type="button" onClick={clearAttachment} className="text-muted-foreground hover:text-status-active"><X className="h-3 w-3" /></button>
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Right: model dropdown + send */}
                  <div className="flex items-center gap-1.5">
                    {activeMode === "general" && availableModels.length > 0 && (
                      <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}
                        className="h-7 rounded-lg border border-border/60 bg-surface-primary/60 px-2 text-[11px] text-text-secondary focus:outline-none focus:ring-2 focus:ring-interactive-primary/25 cursor-pointer max-w-[140px] truncate">
                        {availableModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                    )}
                    <Button size="icon" onClick={handleSend}
                      disabled={!input.trim() || isStreaming}
                      className="rounded-xl h-8 w-8 shrink-0"
                      aria-label={isStreaming ? "发送中…" : "发送"}
                    >
                      {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
