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
import { useSearchParams } from "react-router-dom";
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
  Square,
  ShieldAlert,
  ArrowDown,
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

/* ── Tool-approval choice labels (Runs API) ───────────────── */

const APPROVAL_LABELS: Record<string, string> = {
  once: "允许一次",
  session: "本会话允许",
  always: "始终允许",
  deny: "拒绝",
};

/* ── Welcome message cache (P1-17) ────────────────────────── */

/**
 * sessionStorage key prefix for the generated welcome text.  The username is
 * appended in {@link fetchWelcome} so two accounts sharing a tab never see each
 * other's greeting.
 */
const WELCOME_CACHE_PREFIX = "liumai:welcome:";

/** Fallback greeting when the LLM is unavailable. */
const DEFAULT_WELCOME =
  "你好！我是六脉智能运维助手。我可以帮你实时监控、追踪故障根因、分析历史数据、协调应急响应。随时向我提问，一起保障系统稳定运行。";

/* ── Scroll-follow behaviour (P1-6) ───────────────────────── */

/** Auto-follow only while the viewport is within this distance of the bottom. */
const BOTTOM_FOLLOW_THRESHOLD_PX = 120;

/* ═══════════════════════════════════════════════════════════ */

export const ChatPanel: FC = () => {
  const {
    messages,
    isStreaming,
    error,
    sessionId,
    activeRunId,
    pendingApproval,
    runCapabilities,
    sendMessage,
    stopStreaming,
    steerMessage,
    respondApproval,
    configureRunCapabilities,
    clearMessages,
    loadSession,
  } = useChat();

  const [input, setInput] = useState("");
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [welcomeText, setWelcomeText] = useState("");       // start empty — no flash
  const [welcomeLoading, setWelcomeLoading] = useState(true); // shimmer while waiting
  const [welcomeTyping, setWelcomeTyping] = useState(false);
  const welcomeIndexRef = useRef(0);
  const welcomeTargetRef = useRef(DEFAULT_WELCOME);
  /** Guards the one-and-only welcome generation request per mount. */
  const welcomeRequestedRef = useRef(false);

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
    if (!text) return;
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
  const [searchParams] = useSearchParams();
  const initialModeFromUrl = searchParams.get("mode");
  const [modes, setModes] = useState<ChatModeOut[]>([]);
  const [activeMode, setActiveMode] = useState<string | null>(
    initialModeFromUrl ? `system:${initialModeFromUrl}` : "system:general"
  );
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

  /* ── Scroll follow / 回到底部 (P1-6) ─────────────────── */
  const messagesRootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const prevMessageCountRef = useRef(0);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [hasUnread, setHasUnread] = useState(false);

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await chatHistory.list());
    } catch { /* backend may not be up yet */ }
  }, []);

  useEffect(() => { reloadSessions(); }, [reloadSessions]);

  // Personalised welcome text.  Generated **once per browser session per user**
  // on first mount and cached in sessionStorage; 新对话 must never hit the LLM
  // again (P1-17).  The username is part of the key so switching accounts in
  // the same tab never shows another user's greeting.
  const fetchWelcome = useCallback(() => {
    if (welcomeRequestedRef.current) return; // React StrictMode double-invoke
    welcomeRequestedRef.current = true;

    const username = localStorage.getItem("liumai_user") || "用户";
    const cacheKey = `${WELCOME_CACHE_PREFIX}${username}`;

    let cached: string | null = null;
    try {
      cached = sessionStorage.getItem(cacheKey);
    } catch {
      /* storage unavailable (private mode) — fall through to the API */
    }
    if (cached) {
      // Already generated earlier this browser session: show it instantly.
      welcomeTargetRef.current = cached;
      setWelcomeText(cached);
      setWelcomeLoading(false);
      return;
    }

    setWelcomeLoading(true);
    setWelcomeText("");
    authApi.generateWelcome(username)
      .then((r) => {
        const text = r.text?.trim();
        if (!text) throw new Error("欢迎语为空");
        try {
          sessionStorage.setItem(cacheKey, text);
        } catch {
          /* non-fatal — the greeting still renders */
        }
        startTypewriter(text);
      })
      .catch(() => {
        // AI unavailable — use the (richer) default text directly, no typewriter
        setWelcomeText(DEFAULT_WELCOME);
      })
      .finally(() => setWelcomeLoading(false));
  }, [startTypewriter]);

  useEffect(() => { fetchWelcome(); }, [fetchWelcome]);

  // Load modes
  useEffect(() => {
    chatModes.list().then(setModes).catch(() => {});
  }, []);

  // Probe Hermes capabilities once: the Runs path needs to know whether a stop
  // really interrupts the agent server-side, and whether steer/approval exist.
  // On failure the optimistic defaults stay — the Runs path degrades on its own.
  useEffect(() => {
    chatModes.hermesInfo()
      .then((info) => {
        const features = info.features || {};
        configureRunCapabilities({
          runs: features.run_submission !== false,
          stop: features.run_stop === true,
          steer: features.run_steer === true,
          approval: features.run_approval_response === true,
        });
      })
      .catch(() => { /* older backend / offline — keep defaults */ });
  }, [configureRunCapabilities]);

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

  // Load available LLM models (P1-14).
  //
  // `GET /api/chat/llm-models` is readable by every signed-in user, unlike the
  // admin-only `/auth/llm-config` the panel used to call — a normal user's 403
  // was swallowed and the picker rendered blank.  The endpoint only echoes the
  // configured default when model discovery fails, so an unambiguous single
  // model is auto-selected; with several models we keep "" ("默认模型") and the
  // backend continues to apply its configured default.
  useEffect(() => {
    let cancelled = false;
    hermesDiscovery.listLlmModels()
      .then((models) => {
        if (cancelled) return;
        const list = models ?? [];
        setAvailableModels(list);
        // Keep a still-valid manual choice, otherwise fall back to the default.
        setSelectedModel((prev) => {
          if (prev && list.some((m) => m.id === prev)) return prev;
          return list.length === 1 ? list[0].id : "";
        });
      })
      .catch(() => {
        // Offline / empty — hide the picker rather than render a blank select.
        if (!cancelled) {
          setAvailableModels([]);
          setSelectedModel("");
        }
      });
    return () => { cancelled = true; };
  }, []);

  /* ── Auto-follow only while the user is near the bottom (P1-6) ────── */

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Coalesce bursts into one scroll per frame; the callback reads the
    // freshest scrollHeight, so it always lands on the true bottom.
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  const handleViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const near = distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD_PX;
    nearBottomRef.current = near;
    setIsNearBottom(near);
    if (near) setHasUnread(false);
  }, []);

  // Our ScrollArea wrapper does not forward a viewport ref, so find the Base UI
  // scroll viewport inside the message area and observe real user scrolling.
  useEffect(() => {
    const viewport = messagesRootRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="scroll-area-viewport"]',
    ) ?? null;
    viewportRef.current = viewport;
    if (!viewport) return;
    viewport.addEventListener("scroll", handleViewportScroll, { passive: true });
    handleViewportScroll();
    return () => {
      viewport.removeEventListener("scroll", handleViewportScroll);
      viewportRef.current = null;
    };
  }, [handleViewportScroll]);

  // Cancel a pending scroll frame on unmount.
  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  const handleScrollToBottom = useCallback(() => {
    nearBottomRef.current = true;
    setIsNearBottom(true);
    setHasUnread(false);
    scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Cleared transcript (new conversation / deleted session): reset follow state.
    if (messages.length === 0) {
      prevMessageCountRef.current = 0;
      nearBottomRef.current = true;
      setIsNearBottom(true);
      setHasUnread(false);
      return;
    }

    const previousCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    const lastMessage = messages[messages.length - 1];
    // A freshly sent turn or a restored transcript always lands at bottom.
    const forceBottom =
      (previousCount === 0 && messages.length > 0) ||
      (messages.length > previousCount && lastMessage?.role === "user");

    if (nearBottomRef.current || forceBottom) {
      nearBottomRef.current = true;
      setIsNearBottom(true);
      setHasUnread(false);
      scrollToBottom();
    } else {
      // Content arrived while the user is reading history: never yank the
      // viewport back — show the 回到底部 pill instead.
      setHasUnread(true);
    }
  }, [messages, scrollToBottom]);

  // Refresh session list after streaming finishes
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      reloadSessions().catch(() => {});
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming, reloadSessions]);

  // While an agent run is active and Hermes supports steer, the input box
  // becomes a "supplementary instruction" box instead of being disabled.
  const canSteer = isStreaming && Boolean(activeRunId) && runCapabilities.steer;

  const handleSteer = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSteer) return;
    setInput("");
    const accepted = await steerMessage(text);
    if (!accepted) toast.error("补充指令未被接受（运行可能已结束）");
  }, [input, canSteer, steerMessage]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    if (isStreaming) {
      // Mid-run input is a steer instruction, not a new turn.
      if (canSteer) await handleSteer();
      return;
    }
    let text = input;
    setInput("");
    const isGeneralMode = activeMode === "system:general" || activeMode?.startsWith("user:");
    const isRcaMode = activeMode === "system:rca";
    // General mode: inline attached document content
    if (isGeneralMode && attachedContent) {
      const fileName = attachedFile?.name ?? "文档";
      text = `[上传文档: ${fileName}]\n\n${attachedContent}\n\n[用户问题]\n${text}`;
      clearAttachment();
    }
    const twStart = isRcaMode ? (rcaTimeStart || new Date(Date.now() - 15 * 60000).toISOString()) : undefined;
    const twEnd = isRcaMode ? (rcaTimeEnd || new Date().toISOString()) : undefined;
    // The mode's config picks the engine: direct-LLM modes stay on
    // /chat/stream, agent modes (default/hermes) go through the Runs API.
    const activeModeMeta = modes.find((m) => m.slug === activeMode);
    const provider = activeModeMeta
      ? ((activeModeMeta.config?.provider as string | undefined) ??
        (activeMode?.startsWith("system:") ? "hermes" : "llm"))
      : "hermes";
    await sendMessage(text, {
      mode: activeMode ?? undefined,
      provider,
      timeWindowStart: twStart,
      timeWindowEnd: twEnd,
      model: isGeneralMode ? (selectedModel || undefined) : undefined,
    });
  }, [input, isStreaming, canSteer, handleSteer, sendMessage, activeMode, modes, rcaTimeStart, rcaTimeEnd, attachedContent, attachedFile, clearAttachment, selectedModel]);

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
      // IME composition (pinyin etc.): Enter confirms the candidate, it must
      // never send the message.
      if (e.nativeEvent.isComposing) return;
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
    // The welcome text is already loaded for this mount (and cached in
    // sessionStorage for later mounts) — never request it again (P1-17).
    nearBottomRef.current = true;
    setIsNearBottom(true);
    setHasUnread(false);
  }, [clearMessages]);

  const handleLoadSession = useCallback(
    async (id: number) => {
      try {
        await loadSession(id);
        // Restored transcripts should open at the newest message.
        nearBottomRef.current = true;
        setIsNearBottom(true);
        setHasUnread(false);
        scrollToBottom();
      } catch { /* 404 */ }
    },
    [loadSession, scrollToBottom],
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
        <div
          ref={messagesRootRef}
          className={cn(
            "relative",
            messages.length === 0 ? "shrink-0" : "flex-1 min-h-0",
          )}
        >
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
            </div>
          </ScrollArea>

          {/* 回到底部 — appears only after the user scrolled up and missed content */}
          {messages.length > 0 && hasUnread && !isNearBottom && (
            <button
              type="button"
              onClick={handleScrollToBottom}
              className="absolute bottom-3 right-5 z-10 flex items-center gap-1 rounded-full bg-white/95 px-3 py-1.5 text-[11px] font-medium text-text-secondary shadow-lg ring-1 ring-black/[0.06] backdrop-blur transition-all duration-150 hover:text-text-primary hover:shadow-xl"
              aria-label="回到底部"
              title="回到底部"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              回到底部
            </button>
          )}
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

            {/* ── Tool approval prompt (Runs API) ── */}
            {pendingApproval && (
              <div className="rounded-xl border border-amber-300/60 bg-amber-50/90 px-3 py-2 shadow-sm space-y-2">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-amber-900">
                      工具调用需要审批{pendingApproval.description ? `：${pendingApproval.description}` : ""}
                    </p>
                    {pendingApproval.command && (
                      <pre className="mt-1 max-h-28 overflow-auto rounded bg-white/70 px-2 py-1 text-[11px] leading-snug text-text-secondary whitespace-pre-wrap break-all">
                        {pendingApproval.command}
                      </pre>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {pendingApproval.choices.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      onClick={() => { void respondApproval(choice); }}
                      className={cn(
                        "px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors",
                        choice === "deny"
                          ? "bg-status-active/10 text-status-active hover:bg-status-active/20"
                          : "bg-interactive-primary/10 text-interactive-primary hover:bg-interactive-primary/20",
                      )}
                    >
                      {APPROVAL_LABELS[choice] || choice}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Input card ── */}
            <div className="rounded-2xl bg-white shadow-lg ring-1 ring-black/[0.04] overflow-hidden transition-all duration-200 focus-within:shadow-xl">
              {/* Tab bar — underline style.  Narrow viewports scroll
                  horizontally instead of wrapping labels into a vertical stack. */}
              {modes.length > 0 && (
                <div className="flex items-center gap-0 px-3 pt-2.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                      <div key={slug} className="relative group flex items-center shrink-0">
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => { if (!disabled) setActiveMode(isActive ? null : slug); }}
                          title={disabled ? "Hermes 服务不可用" : undefined}
                          className={cn(
                            "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-[12px] font-medium transition-colors duration-200",
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
                    isStreaming
                      ? canSteer
                        ? "运行中… 可输入补充指令（Enter 发送），点 ■ 停止运行"
                        : "等待回复中…"
                    : activeMode === "system:general" ? "通用模型智能问答，支持多格式文档上传… Enter 发送，Shift+Enter 换行"
                    : activeMode === "system:default" ? "智能运维助理，具备工具调用与自主执行能力… Enter 发送，Shift+Enter 换行"
                    : activeMode === "system:knowledge" ? "遵循 LLM-WIKI V2 协议，从知识库进行知识检索与问答… Enter 发送，Shift+Enter 换行"
                    : activeMode === "system:rca" ? "故障根因分析，输入服务名称和时间窗口… Enter 发送，Shift+Enter 换行"
                    : activeMode?.startsWith("user:") ? `与 ${cmName || "自定义助理"} 对话… Enter 发送，Shift+Enter 换行`
                    : "输入消息，Enter 发送，Shift+Enter 换行"
                  }
                  disabled={isStreaming && !canSteer}
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
                        title="选择模型（默认跟随后台配置）"
                        className="h-7 rounded-lg border-0 bg-transparent px-1.5 text-[11px] text-muted-foreground/60 focus:outline-none cursor-pointer max-w-[130px] truncate hover:text-text-secondary">
                        {/* Never render a blank <select>: "" means the backend's
                            configured default model is used (P1-14). */}
                        <option value="">默认模型</option>
                        {availableModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {isStreaming ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      {canSteer && (
                        <button
                          onClick={handleSteer}
                          disabled={!input.trim()}
                          className={cn(
                            "flex items-center justify-center h-8 w-8 rounded-full transition-all duration-200",
                            input.trim()
                              ? "bg-interactive-primary text-white shadow-md shadow-black/10 hover:bg-interactive-primary/90"
                              : "bg-black/[0.04] text-muted-foreground/30 cursor-not-allowed",
                          )}
                          aria-label="发送补充指令"
                          title="发送补充指令（Steer）"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={stopStreaming}
                        className="flex items-center justify-center h-8 w-8 rounded-full transition-all duration-200 shrink-0 bg-text-primary text-white shadow-md shadow-black/10 hover:bg-text-primary/90 hover:shadow-lg"
                        aria-label="停止生成"
                        title="停止生成"
                      >
                        <Square className="h-3 w-3 fill-current" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleSend}
                      disabled={!input.trim()}
                      className={cn(
                        "flex items-center justify-center h-8 w-8 rounded-full transition-all duration-200 shrink-0",
                        input.trim()
                          ? "bg-text-primary text-white shadow-md shadow-black/10 hover:bg-text-primary/90 hover:shadow-lg hover:scale-[1.04]"
                          : "bg-black/[0.04] text-muted-foreground/30 cursor-not-allowed",
                      )}
                      aria-label="发送"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  )}
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
