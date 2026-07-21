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
import { Input } from "@/components/ui/input";
import { chatHistory, chatModes, authApi, hermesDiscovery, type ChatModeOut, type ChatSessionSummary } from "@/lib/api";
import { toast } from "sonner";
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
  const [activeMode, setActiveMode] = useState<string | null>("system:general");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");

  /* Custom assistant creation dialog */
  const [showCreate, setShowCreate] = useState(false);
  const [editMode, setEditMode] = useState<ChatModeOut | null>(null);
  const [cmName, setCmName] = useState("");
  const [cmPrompt, setCmPrompt] = useState("");
  const [cmIcon, setCmIcon] = useState("🤖");
  const [cmProvider, setCmProvider] = useState("llm");

  /* Hermes health */
  const [hermesOnline, setHermesOnline] = useState(true);
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

  // Poll Hermes health every 30s; force-switch to general if offline
  useEffect(() => {
    const check = () => {
      hermesDiscovery.health().then(r => {
        const online = r.ok;
        setHermesOnline(online);
        if (!online && activeMode && activeMode !== "system:general" && !activeMode.startsWith("user:")) {
          setActiveMode("system:general");
        }
      }).catch(() => {
        setHermesOnline(false);
        if (activeMode && activeMode !== "system:general" && !activeMode.startsWith("user:")) {
          setActiveMode("system:general");
        }
      });
    };
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  }, []); // intentionally no activeMode dep — only check on mount

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
    const realMode = activeMode?.startsWith("system:") ? activeMode.replace("system:", "") : activeMode;
    await sendMessage(text, {
      mode: activeMode ?? undefined,
      timeWindowStart: twStart,
      timeWindowEnd: twEnd,
      model: (activeMode === "system:general" || activeMode?.startsWith("user:")) ? (selectedModel || undefined) : undefined,
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

      {/* Chat area — subtle gradient depth */}
      <div className="flex-1 flex flex-col min-w-0 max-w-[48rem] mx-auto w-full"
        style={{ background: "radial-gradient(ellipse at 50% 80%, rgba(59,130,246,0.04) 0%, transparent 60%)" }}>
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

            {/* Mode extensions — shown above input card */}
            {activeMode === "system:rca" && (
              <div className="flex items-center gap-1.5 bg-white/60 backdrop-blur rounded-xl px-2 py-1.5 self-center border border-border/30 shadow-sm">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {[["none","自定义"],["15m","15分钟"],["1h","1小时"],["4h","4小时"],["24h","24小时"]].map(([val, label]) => (
                  <button key={val} type="button" onClick={() => applyRcaPreset(val)} className={cn("px-2 py-0.5 rounded-full text-[11px] transition-colors", rcaPreset === val ? "bg-interactive-primary/10 text-interactive-primary font-medium" : "text-muted-foreground hover:text-text-secondary")}>{label}</button>
                ))}
                {rcaPreset === "none" && (<><input type="datetime-local" value={rcaTimeStart} onChange={(e) => setRcaTimeStart(e.target.value)} className="h-7 rounded-lg border border-border/50 bg-white px-2 text-[11px]" /><span className="text-[11px] text-muted-foreground">→</span><input type="datetime-local" value={rcaTimeEnd} onChange={(e) => setRcaTimeEnd(e.target.value)} className="h-7 rounded-lg border border-border/50 bg-white px-2 text-[11px]" /></>)}
              </div>
            )}
            {/* Attached file badge */}
            {attachedFile && !converting && (activeMode === "system:general" || activeMode?.startsWith("user:")) && (
              <div className="flex items-center gap-2 self-center bg-white/80 backdrop-blur rounded-lg px-3 py-1 border border-border/30 shadow-sm text-[12px]">
                <FileText className="h-3 w-3 text-muted-foreground" />{attachedFile.name}
                <button type="button" onClick={clearAttachment} className="text-muted-foreground hover:text-status-active"><X className="h-3 w-3" /></button>
              </div>
            )}

            {/* ── Input card ── */}
            <div className="rounded-2xl bg-white shadow-lg ring-1 ring-black/[0.04] overflow-hidden transition-all duration-200 focus-within:shadow-xl">
              {/* Tab bar — underline style */}
              {modes.length > 0 && (
                <div className="flex items-center gap-0 px-3 pt-2.5">
                  {modes.map((m) => {
                    const isUser = m.slug.startsWith("user:");
                    const slug = m.slug;
                    const systemSlug = slug.startsWith("system:") ? slug.replace("system:", "") : slug;
                    const Icon = modeIcons[systemSlug] || MessageCircle;
                    const isActive = activeMode === slug || (!activeMode && slug === "system:general");
                    const config = m.config || {};
                    const userIcon = (config as any)?.icon || "🤖";
                    const provider = (config as any)?.provider || (slug.startsWith("system:") ? "hermes" : "llm");
                    const needsHermes = provider === "hermes" || (!isUser && !(config as any)?.provider && slug !== "system:general");
                    const disabled = needsHermes && !hermesOnline;

                    return (
                      <div key={slug} className="relative group flex items-center">
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => { if (!disabled) setActiveMode(isActive ? null : slug); }}
                          title={disabled ? "Hermes 服务不可用" : undefined}
                          className={cn(
                            "relative flex items-center gap-1.5 px-2.5 py-2 text-[12px] font-medium transition-colors duration-200",
                            disabled ? "opacity-35 cursor-not-allowed" : "",
                            isActive && !disabled ? "text-text-primary" : disabled ? "text-muted-foreground/40" : "text-muted-foreground/60 hover:text-text-secondary",
                          )}
                        >
                          {isUser ? <span className="text-sm leading-none">{userIcon}</span> : <Icon className="h-3 w-3" />}
                          {m.name}
                          {disabled && <span className="text-[9px] opacity-60">⚠</span>}
                          {isActive && !disabled && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-2/3 h-[2px] rounded-full bg-text-primary/80" />}
                        </button>
                        {/* Edit/delete for user modes */}
                        {isUser && (
                          <div className="hidden group-hover:flex absolute -top-1 -right-1 gap-0.5">
                            <button type="button" onClick={(e) => { e.stopPropagation();
                              const id = parseInt(slug.split(":")[1]);
                              setEditMode(m); setCmName(m.name); setCmPrompt(m.system_prompt);
                              setCmIcon(userIcon); setCmProvider((config as any)?.provider || "llm");
                              setShowCreate(true);
                            }} className="h-4 w-4 rounded-full bg-surface-tertiary flex items-center justify-center text-[8px] hover:bg-surface-primary">✎</button>
                            <button type="button" onClick={async (e) => { e.stopPropagation();
                              const id = parseInt(slug.split(":")[1]);
                              await chatModes.deleteUserMode(id);
                              chatModes.list().then(setModes).catch(() => {});
                            }} className="h-4 w-4 rounded-full bg-surface-tertiary flex items-center justify-center text-[8px] hover:bg-surface-primary">✕</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/* + button */}
                  <button type="button" onClick={() => { setEditMode(null); setCmName(""); setCmPrompt(""); setCmIcon("🤖"); setCmProvider("llm"); setShowCreate(true); }}
                    className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/40 hover:text-text-secondary hover:bg-black/[0.03] transition-colors ml-1">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {/* Hermes health indicator */}
                  <span className={cn("ml-1.5 flex items-center gap-1 text-[10px]", hermesOnline ? "text-muted-foreground/30" : "text-status-active")} title={hermesOnline ? "Hermes 在线" : "Hermes 离线"}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", hermesOnline ? "bg-status-resolved" : "bg-status-active animate-pulse")} />
                    {hermesOnline ? "" : "离线"}
                  </span>
                </div>
              )}

              {/* Textarea with bottom bar */}
              <div className="relative flex flex-col">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isStreaming ? "等待回复中…"
                    : activeMode === "system:general" ? "通用模型智能问答，支持多格式文档上传… Enter 发送，Shift+Enter 换行"
                    : activeMode === "system:default" ? "智能运维助理，具备工具调用与自主执行能力… Enter 发送，Shift+Enter 换行"
                    : activeMode === "system:knowledge" ? "遵循 LLM-WIKI V2 协议，从知识库进行知识检索与问答… Enter 发送，Shift+Enter 换行"
                    : activeMode === "system:rca" ? "故障根因分析，输入服务名称和时间窗口… Enter 发送，Shift+Enter 换行"
                    : activeMode?.startsWith("user:") ? `与 ${cmName || "自定义助理"} 对话… Enter 发送，Shift+Enter 换行`
                    : "输入消息，Enter 发送，Shift+Enter 换行"
                  }
                  disabled={isStreaming}
                  rows={1}
                  className="w-full bg-transparent pl-5 pr-5 py-3.5 text-[14px] text-text-primary placeholder:text-muted-foreground/35 disabled:opacity-40 resize-none leading-relaxed outline-none focus-visible:outline-0"
                  style={{ minHeight: "52px" }}
                  aria-label="聊天输入"
                />

                {/* Bottom bar */}
                <div className="flex items-center justify-between px-3 pb-3 gap-2">
                  <div className="flex items-center gap-1.5">
                    {(activeMode === "system:general" || activeMode?.startsWith("user:")) && (
                      <>
                        <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="hidden"
                          accept=".pdf,.docx,.pptx,.xlsx,.xls,.epub,.html,.csv,.json,.xml,.ipynb,.jpg,.jpeg,.png,.gif,.bmp,.tiff,.zip,.txt,.md,.py,.js,.ts,.log,.sql,.yaml,.yml,.ini,.cfg,.css,.rss" />
                        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={converting}
                          className="flex items-center justify-center h-7 w-7 rounded-lg text-muted-foreground/50 hover:text-muted-foreground hover:bg-black/[0.03] transition-all disabled:opacity-50"
                          title="上传文档">
                          {converting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
                        </button>
                      </>
                    )}
                    {(activeMode === "system:general" || activeMode?.startsWith("user:")) && availableModels.length > 0 && (
                      <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}
                        className="h-7 rounded-lg border-0 bg-transparent px-1.5 text-[11px] text-muted-foreground/60 focus:outline-none cursor-pointer max-w-[130px] truncate hover:text-text-secondary">
                        {availableModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  <button
                    onClick={handleSend}
                    disabled={!input.trim() || isStreaming}
                    className={cn(
                      "flex items-center justify-center h-8 w-8 rounded-full transition-all duration-200 shrink-0",
                      input.trim() && !isStreaming
                        ? "bg-text-primary text-white shadow-md shadow-black/10 hover:bg-text-primary/90 hover:shadow-lg hover:scale-[1.04]"
                        : "bg-black/[0.04] text-muted-foreground/30 cursor-not-allowed",
                    )}
                    aria-label="发送"
                  >
                    {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Create/Edit custom assistant dialog ──────────── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{editMode ? "编辑助理" : "创建智能助理"}</h3>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-text-primary"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3">
              {/* Icon picker */}
              <div>
                <label className="text-[12px] font-medium text-text-secondary">图标</label>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {["🤖","🧠","🔧","📊","🛡️","🚀","💡","🎯","⚡","🔍","📝","💬"].map(emoji => (
                    <button key={emoji} type="button" onClick={() => setCmIcon(emoji)}
                      className={cn("h-8 w-8 rounded-lg text-lg flex items-center justify-center transition-all", cmIcon === emoji ? "bg-interactive-primary/10 ring-2 ring-interactive-primary/30" : "hover:bg-surface-secondary")}>{emoji}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[12px] font-medium text-text-secondary">名称</label>
                <Input value={cmName} onChange={e => setCmName(e.target.value)} placeholder="我的助理" className="mt-1" />
              </div>
              <div>
                <label className="text-[12px] font-medium text-text-secondary">引擎</label>
                <select value={cmProvider} onChange={e => setCmProvider(e.target.value)}
                  className="mt-1 w-full h-9 rounded-lg border border-border bg-white px-3 text-sm">
                  <option value="llm">LLM 直连 (通用模型)</option>
                  <option value="hermes">Hermes (工具调用)</option>
                </select>
              </div>
              <div>
                <label className="text-[12px] font-medium text-text-secondary">系统提示词</label>
                <textarea value={cmPrompt} onChange={e => setCmPrompt(e.target.value)} rows={6}
                  placeholder="你是一个专业的...&#10;设定助理的角色、能力和回复风格"
                  className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-interactive-primary/25" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
              <Button disabled={!cmName.trim()} onClick={async () => {
                const data = { name: cmName, system_prompt: cmPrompt, icon: cmIcon, provider: cmProvider };
                try {
                  if (editMode) {
                    const id = parseInt(editMode.slug.split(":")[1]);
                    await chatModes.updateUserMode(id, data);
                  } else {
                    await chatModes.createUserMode(data);
                  }
                  toast.success(editMode ? "已更新" : "已创建");
                  setShowCreate(false);
                  chatModes.list().then(setModes).catch(() => {});
                } catch (err: any) { toast.error(err.message || "失败"); }
              }}>{editMode ? "保存" : "创建"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
