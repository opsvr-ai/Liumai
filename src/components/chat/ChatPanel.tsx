/** Intelligent chat page — presentation layer.

Data flow is unchanged: conversation state, streaming, runs, approvals, steer,
attachments and history all still come from ``useChat`` / ``lib/api``.  This
component now owns layout (sidebar → reading column → composer) and the small
amount of UI state needed for editing, exporting and folding a turn's process.
*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FC,
  type MouseEvent,
} from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowDown,
  BookOpen,
  MessageCircle,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useChat, type ChatApprovalDecision } from "@/hooks/useChat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  chatFiles,
  chatHistory,
  chatModes,
  authApi,
  clearStagedChatImages,
  hermesDiscovery,
  stageChatImages,
  type ChatModeOut,
  type ChatSessionSummary,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ChatHeader } from "./chat-header";
import { ChatSidebar } from "./chat-sidebar";
import { Composer } from "./composer";
import { EmptyState } from "./empty-state";
import { MessageList } from "./message-list";
import { titleFromMessages } from "./chat-utils";

/* ==========================================================================
 *  Constants
 * ========================================================================== */

const WELCOME_CACHE_PREFIX = "liumai:welcome:";
const DEFAULT_WELCOME =
  "你好！我是六脉智能运维助手。我可以帮你实时监控、追踪故障根因、分析历史数据、协调应急响应。随时向我提问，一起保障系统稳定运行。";

const BOTTOM_FOLLOW_THRESHOLD_PX = 120;

/** Inline image limit — keep the base64 payload comfortably below 6MB. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Agent-mode text cap: Hermes silently truncates text parts above 64K chars. */
const AGENT_ATTACHMENT_MAX_CHARS = 60_000;

const APPROVAL_LABELS: Record<ChatApprovalDecision, string> = {
  once: "允许一次",
  session: "本会话",
  always: "始终",
  deny: "拒绝",
};

const MODE_ICONS: Record<string, LucideIcon> = {
  default: MessageCircle,
  general: Sparkles,
  rca: Activity,
  knowledge: BookOpen,
};

/** Display names for the engines a chat mode can route to. */
const ENGINE_LABELS: Record<string, string> = {
  hermes: "Hermes",
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  ollama: "Ollama",
};

/** Resolve the provider the same way ``submitTurn`` routes the run. */
function resolveModeProvider(
  activeMode: string | null,
  mode: ChatModeOut | undefined,
): string {
  const configured = mode?.config?.provider;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().toLowerCase();
  }
  if (!activeMode || activeMode === "system:general" || activeMode.startsWith("user:")) {
    return "llm";
  }
  return "hermes";
}

function providerLabel(provider: string): string {
  return (
    ENGINE_LABELS[provider] ??
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}

/** Rename a saved session without touching its transcript. */
async function updateSessionTitle(sessionId: number, title: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = localStorage.getItem("liumai_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* storage unavailable — still attempt the request */
  }
  const response = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(`rename → ${response.status}`);
}

function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\n\r]/g, "-").trim().slice(0, 40);
  return cleaned || "liumai-chat";
}

/* ==========================================================================
 *  Panel
 * ========================================================================== */

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

  /* ── Composer / session state ─────────────────────────────────────── */
  const [input, setInput] = useState("");
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const approvalRequestRef = useRef<string | null>(null);
  const [pendingResend, setPendingResend] = useState<string | null>(null);
  const steerInFlightRef = useRef(false);

  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1024px)").matches;
  });

  /* ── Welcome (unchanged data source, new presentation) ────────────── */
  const [welcomeText, setWelcomeText] = useState("");
  const [welcomeLoading, setWelcomeLoading] = useState(true);
  const [welcomeTyping, setWelcomeTyping] = useState(false);
  const welcomeIndexRef = useRef(0);
  const welcomeTargetRef = useRef(DEFAULT_WELCOME);
  const welcomeRequestedRef = useRef(false);
  const typewriterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Modes / models ───────────────────────────────────────────────── */
  const [searchParams] = useSearchParams();
  const initialModeFromUrl = searchParams.get("mode");
  const [modes, setModes] = useState<ChatModeOut[]>([]);
  const [activeMode, setActiveMode] = useState<string | null>(
    initialModeFromUrl ? `system:${initialModeFromUrl}` : "system:general",
  );
  const [availableModels, setAvailableModels] = useState<Array<{ id: string }>>([]);
  const [selectedModel, setSelectedModel] = useState("");

  /* ── Custom assistant dialog ──────────────────────────────────────── */
  const [showCreate, setShowCreate] = useState(false);
  const [editMode, setEditMode] = useState<ChatModeOut | null>(null);
  const [cmName, setCmName] = useState("");
  const [cmPrompt, setCmPrompt] = useState("");
  const [cmIcon, setCmIcon] = useState("🤖");
  const [cmProvider, setCmProvider] = useState("llm");

  /* ── Hermes health / RCA window ───────────────────────────────────── */
  const [hermesOnline, setHermesOnline] = useState(true);
  const [rcaTimeStart, setRcaTimeStart] = useState("");
  const [rcaTimeEnd, setRcaTimeEnd] = useState("");
  const [rcaPreset, setRcaPreset] = useState("none");

  /* ── Attachment ───────────────────────────────────────────────────── */
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachedContent, setAttachedContent] = useState("");
  /** Inline image for the current turn only (never persisted / replayed). */
  const [attachedImage, setAttachedImage] = useState<{
    filename: string;
    dataUrl: string;
    bytes: number;
  } | null>(null);
  const [attachedTruncated, setAttachedTruncated] = useState(false);
  const [attachedOriginalChars, setAttachedOriginalChars] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);

  /* ── Scroll-follow ────────────────────────────────────────────────── */
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const prevMessageCountRef = useRef(0);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [hasUnread, setHasUnread] = useState(false);

  /* ── Local presentation state ─────────────────────────────────────── */
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const persistedTitleRef = useRef<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [clearOpen, setClearOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* ====================================================================
   *  Welcome text (generated once per browser session, cached)
   * ==================================================================== */

  const startTypewriter = useCallback((text: string) => {
    if (!text) return;
    welcomeTargetRef.current = text;
    welcomeIndexRef.current = 0;
    setWelcomeText("");
    setWelcomeTyping(true);
    const chars = [...text];
    if (typewriterTimerRef.current) clearInterval(typewriterTimerRef.current);
    typewriterTimerRef.current = setInterval(() => {
      welcomeIndexRef.current += 1;
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

  const fetchWelcome = useCallback(() => {
    if (welcomeRequestedRef.current) return;
    welcomeRequestedRef.current = true;

    const username = localStorage.getItem("liumai_user") || "用户";
    const cacheKey = `${WELCOME_CACHE_PREFIX}${username}`;

    let cached: string | null = null;
    try {
      cached = sessionStorage.getItem(cacheKey);
    } catch {
      /* private mode */
    }
    if (cached) {
      welcomeTargetRef.current = cached;
      setWelcomeText(cached);
      setWelcomeLoading(false);
      return;
    }

    setWelcomeLoading(true);
    setWelcomeText("");
    authApi
      .generateWelcome(username)
      .then((result) => {
        const text = result.text?.trim();
        if (!text) throw new Error("欢迎语为空");
        try {
          sessionStorage.setItem(cacheKey, text);
        } catch {
          /* non-fatal */
        }
        startTypewriter(text);
      })
      .catch(() => setWelcomeText(DEFAULT_WELCOME))
      .finally(() => setWelcomeLoading(false));
  }, [startTypewriter]);

  useEffect(() => {
    fetchWelcome();
  }, [fetchWelcome]);

  useEffect(
    () => () => {
      if (typewriterTimerRef.current) clearInterval(typewriterTimerRef.current);
    },
    [],
  );

  /* ====================================================================
   *  Sidebar / sessions
   * ==================================================================== */

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await chatHistory.list());
    } catch {
      /* backend may not be up yet */
    }
  }, []);

  useEffect(() => {
    void reloadSessions();
  }, [reloadSessions]);

  // Close the drawer when the viewport shrinks below the desktop breakpoint.
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setSidebarOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // A fresh approval prompt supersedes the previous "已响应" note.
  useEffect(() => {
    if (pendingApproval) setApprovalNotice(null);
  }, [pendingApproval]);

  useEffect(() => {
    if (!approvalNotice || approvalNotice.startsWith("正在")) return;
    const timer = setTimeout(() => setApprovalNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [approvalNotice]);

  /* ====================================================================
   *  Modes / models / capabilities
   * ==================================================================== */

  useEffect(() => {
    chatModes.list().then(setModes).catch(() => {});
  }, []);

  useEffect(() => {
    chatModes
      .hermesCapabilities()
      .then((caps) => {
        configureRunCapabilities({
          runs: caps.run_submission !== false,
          stop: caps.run_stop === true,
          steer: caps.run_steer === true,
          approval: caps.run_approval_response === true,
        });
      })
      .catch(() => {
        configureRunCapabilities({ approval: false, steer: false });
      });
  }, [configureRunCapabilities]);

  useEffect(() => {
    const check = () => {
      hermesDiscovery
        .health()
        .then((result) => {
          const online = result.ok;
          setHermesOnline(online);
          if (
            !online &&
            activeMode &&
            activeMode !== "system:general" &&
            !activeMode.startsWith("user:")
          ) {
            setActiveMode("system:general");
          }
        })
        .catch(() => {
          setHermesOnline(false);
          if (
            activeMode &&
            activeMode !== "system:general" &&
            !activeMode.startsWith("user:")
          ) {
            setActiveMode("system:general");
          }
        });
    };
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
    // Intentionally mount-only: the health probe uses the mode at mount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    hermesDiscovery
      .listLlmModels()
      .then((models) => {
        if (cancelled) return;
        const list = models ?? [];
        setAvailableModels(list);
        setSelectedModel((previous) => {
          if (previous && list.some((model) => model.id === previous)) return previous;
          return list.length === 1 ? list[0].id : "";
        });
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableModels([]);
        setSelectedModel("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ====================================================================
   *  Scroll-follow behaviour
   * ==================================================================== */

  const scrollToBottom = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  const handleViewportScroll = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const near = distance < BOTTOM_FOLLOW_THRESHOLD_PX;
    nearBottomRef.current = near;
    setIsNearBottom(near);
    if (near) setHasUnread(false);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    const viewport = scrollRef.current;
    nearBottomRef.current = true;
    setIsNearBottom(true);
    setHasUnread(false);
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!scrollRef.current) return;

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
    const forceBottom =
      (previousCount === 0 && messages.length > 0) ||
      (messages.length > previousCount && lastMessage?.role === "user");

    if (nearBottomRef.current || forceBottom) {
      nearBottomRef.current = true;
      setIsNearBottom(true);
      setHasUnread(false);
      scrollToBottom();
    } else {
      setHasUnread(true);
    }
  }, [messages, scrollToBottom]);

  // Refresh history after streaming finishes.
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) void reloadSessions();
    prevStreaming.current = isStreaming;
  }, [isStreaming, reloadSessions]);

  /* ====================================================================
   *  Attachment
   * ==================================================================== */

  const clearAttachment = useCallback(() => {
    setAttachedFile(null);
    setAttachedContent("");
    setAttachedImage(null);
    setAttachedTruncated(false);
    setAttachedOriginalChars(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const convertFile = useCallback(
    async (file: File) => {
      const isImage = /\.(png|jpe?g|webp|gif)$/i.test(file.name);
      if (isImage && file.size > MAX_IMAGE_BYTES) {
        clearAttachment();
        toast.error("图片超过 3MB 上限，请压缩后再上传");
        return;
      }

      setAttachedFile(file);
      setAttachedContent("");
      setAttachedImage(null);
      setAttachedTruncated(false);
      setAttachedOriginalChars(0);
      setConverting(true);
      try {
        const modeMeta = modes.find(
          (mode) => mode.slug === (activeMode ?? "system:general"),
        );
        const provider = resolveModeProvider(activeMode, modeMeta);
        // Agent (Hermes) turns get a 60k-char cap: above 64K Hermes silently
        // truncates the text part. Direct-LLM modes keep the 200k default.
        const maxChars =
          provider === "llm" ? undefined : AGENT_ATTACHMENT_MAX_CHARS;
        const result = await chatFiles.convert(file, maxChars);
        if (result.kind === "image") {
          setAttachedImage({
            filename: result.filename,
            dataUrl: result.data_url,
            bytes: result.bytes,
          });
        } else {
          setAttachedContent(result.content);
          setAttachedTruncated(result.truncated);
          setAttachedOriginalChars(result.original_chars);
          if (result.truncated) {
            toast.warning(
              `附件内容超长，已截断为 ${result.max_chars ?? maxChars ?? ""} 字符（原文 ${result.original_chars} 字符）`,
            );
          }
        }
      } catch (err: unknown) {
        // Never feed an error string to the model as attachment text.
        clearAttachment();
        toast.error(err instanceof Error ? err.message : "文件转换失败");
      } finally {
        setConverting(false);
      }
    },
    [activeMode, clearAttachment, modes],
  );

  const handleFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void convertFile(file);
    },
    [convertFile],
  );

  /* ====================================================================
   *  Streaming / approval / steer handlers
   * ==================================================================== */

  const canSteer = isStreaming && Boolean(activeRunId) && runCapabilities.steer;

  const handleSteer = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSteer || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    try {
      const result = await steerMessage(text);
      if (result.ok) {
        setInput("");
        toast.success("已发送补充指令");
      } else if (result.reason === "ended" || result.reason === "unavailable") {
        setInput("");
        setPendingResend(text);
        toast.error("本轮已结束，指令未发送");
      } else {
        toast.error("补充指令发送失败，请重试");
      }
    } finally {
      steerInFlightRef.current = false;
    }
  }, [input, canSteer, steerMessage]);

  const handleApprovalResponse = useCallback(
    async (decision: ChatApprovalDecision) => {
      if (!pendingApproval) return;
      const requestId = pendingApproval.approvalId;
      if (approvalRequestRef.current !== null) return;
      approvalRequestRef.current = requestId;
      setApprovalNotice("正在提交审批…");
      try {
        const ok = await respondApproval({ decision });
        if (ok) {
          setApprovalNotice(`已响应 · ${APPROVAL_LABELS[decision]}`);
        } else {
          setApprovalNotice(null);
          toast.error("审批响应失败，请重试");
        }
      } finally {
        approvalRequestRef.current = null;
      }
    },
    [pendingApproval, respondApproval],
  );

  const submitTurn = useCallback(
    async (rawText: string) => {
      let text = rawText;
      /* ``null`` means the default (通用) mode everywhere else in the UI, so
         route it as ``system:general`` instead of letting Hermes pick it up. */
      const modeSlug = activeMode ?? "system:general";
      const isGeneralMode =
        modeSlug === "system:general" || modeSlug.startsWith("user:");
      const isRcaMode = modeSlug === "system:rca";
      const image = attachedImage;

      /* Text attachments are inline text: available in every mode (agent
         modes included). Only the current turn carries the body. */
      if (attachedContent) {
        const fileName = attachedFile?.name ?? "文档";
        text = `[上传文档: ${fileName}]\n\n${attachedContent}\n\n[用户问题]\n${text}`;
      }

      /* The image placeholder stays in the transcript; the data URL itself is
         staged for this request only and is never persisted/replayed. */
      if (image) {
        text = `[图片] ${image.filename}\n${text}`;
        stageChatImages([{ filename: image.filename, dataUrl: image.dataUrl }]);
      } else {
        clearStagedChatImages();
      }

      const twStart = isRcaMode
        ? rcaTimeStart || new Date(Date.now() - 15 * 60000).toISOString()
        : undefined;
      const twEnd = isRcaMode ? rcaTimeEnd || new Date().toISOString() : undefined;
      const activeModeMeta = modes.find((mode) => mode.slug === modeSlug);
      /* Images travel as content parts, which only ``/chat/stream`` accepts.
         Verified against the running Hermes build: POST /v1/runs rejects a
         parts array ("No user message found in input") and coerces
         conversation_history content with str(), so the agent saw base64 text
         instead of the image; /v1/chat/completions answered the same image
         correctly.  Keep image turns on the streaming path; text turns stay on
         the Runs API (stop / steer / approval). */
      const provider = image
        ? "llm"
        : resolveModeProvider(activeMode, activeModeMeta);

      clearAttachment();
      try {
        await sendMessage(text, {
          mode: modeSlug,
          provider,
          timeWindowStart: twStart,
          timeWindowEnd: twEnd,
          model: isGeneralMode ? selectedModel || undefined : undefined,
        });
      } finally {
        if (image) clearStagedChatImages();
      }
    },
    [
      activeMode,
      modes,
      rcaTimeStart,
      rcaTimeEnd,
      attachedContent,
      attachedFile,
      attachedImage,
      clearAttachment,
      selectedModel,
      sendMessage,
    ],
  );

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    if (isStreaming) {
      if (canSteer) await handleSteer();
      return;
    }
    const text = input;
    setInput("");
    try {
      await submitTurn(text);
    } catch (err: unknown) {
      // Final safety net: the hook surfaces its own failures, but a rejected
      // send must never disappear silently (nor lose the typed text).
      setInput((current) => current || text);
      toast.error(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [input, isStreaming, canSteer, handleSteer, submitTurn]);

  // A steer hit an already-finished run: resend the text as a normal turn.
  useEffect(() => {
    if (isStreaming || !pendingResend) return;
    const text = pendingResend;
    setPendingResend(null);
    void submitTurn(text).catch((err: unknown) => {
      toast.error(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [isStreaming, pendingResend, submitTurn]);

  /* ====================================================================
   *  Navigation / title / export / clear
   * ==================================================================== */

  const resetTransientUi = useCallback(() => {
    setHiddenIds(new Set());
    setTitleOverride(null);
    persistedTitleRef.current = null;
    prevMessageCountRef.current = 0;
    nearBottomRef.current = true;
    setIsNearBottom(true);
    setHasUnread(false);
  }, []);

  const handleNewSession = useCallback(() => {
    clearMessages();
    setActiveMode("system:general");
    setPendingResend(null);
    setApprovalNotice(null);
    resetTransientUi();
    if (window.innerWidth < 1024) setSidebarOpen(false);
  }, [clearMessages, resetTransientUi]);

  const handleLoadSession = useCallback(
    async (id: number) => {
      setPendingResend(null);
      setApprovalNotice(null);
      setHiddenIds(new Set());
      const summary = sessions.find((session) => session.id === id);
      const loadedTitle =
        summary && summary.message_count > 0 && summary.title.trim()
          ? summary.title
          : null;
      setTitleOverride(loadedTitle);
      // The stored title is already persisted — do not write it back on load.
      persistedTitleRef.current = loadedTitle ? `${id}:${loadedTitle}` : null;
      prevMessageCountRef.current = 0;
      try {
        await loadSession(id);
        nearBottomRef.current = true;
        setIsNearBottom(true);
        setHasUnread(false);
        scrollToBottom();
      } catch {
        /* 404 — session disappeared */
      }
      if (window.innerWidth < 1024) setSidebarOpen(false);
    },
    [loadSession, scrollToBottom, sessions],
  );

  const handleDeleteSession = useCallback(
    async (id: number, event: MouseEvent) => {
      event.stopPropagation();
      try {
        await chatHistory.delete(id);
        if (sessionId === id) {
          clearMessages();
          resetTransientUi();
        }
        void reloadSessions();
      } catch {
        /* already gone */
      }
    },
    [sessionId, clearMessages, reloadSessions, resetTransientUi],
  );

  const derivedTitle = useMemo(() => titleFromMessages(messages), [messages]);
  const displayTitle = titleOverride || derivedTitle;

  const handleRename = useCallback(
    (next: string) => {
      const value = next.trim();
      setTitleOverride(value || null);
      if (sessionId && value) {
        setSessions((previous) =>
          previous.map((session) =>
            session.id === sessionId ? { ...session, title: value } : session,
          ),
        );
      }
    },
    [sessionId],
  );

  // Persist a custom title once the turn is idle (avoids racing the transcript
  // auto-save); the request only updates the title — messages are untouched.
  useEffect(() => {
    if (!sessionId || !titleOverride || isStreaming) return;
    const key = `${sessionId}:${titleOverride}`;
    if (persistedTitleRef.current === key) return;
    persistedTitleRef.current = key;
    const timer = window.setTimeout(() => {
      void updateSessionTitle(sessionId, titleOverride).catch(() => {
        persistedTitleRef.current = null;
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [sessionId, titleOverride, isStreaming]);

  const handleConfirmClear = useCallback(() => {
    clearMessages();
    setClearOpen(false);
    setPendingResend(null);
    setApprovalNotice(null);
    resetTransientUi();
  }, [clearMessages, resetTransientUi]);

  const handleExport = useCallback(() => {
    const visible = messages.filter(
      (message) => message.role !== "error" && !hiddenIds.has(message.id),
    );
    if (visible.length === 0) return;

    const lines: string[] = [
      `# ${displayTitle}`,
      "",
      `> 导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
    ];
    for (const message of visible) {
      if (message.role === "user") {
        lines.push("## 用户", "", message.content, "");
      } else if (message.role === "assistant") {
        if (message.reasoning) {
          lines.push(
            "<details><summary>思考过程</summary>",
            "",
            message.reasoning,
            "",
            "</details>",
            "",
          );
        }
        if (message.content) lines.push("## 助手", "", message.content, "");
      } else if (message.role === "tool") {
        const tool = message.toolCalls?.[0];
        const name = tool?.function?.name || message.content || "tool";
        const args = tool?.function?.arguments?.trim();
        lines.push(`<details><summary>工具 · ${name}</summary>`, "");
        if (args) {
          const language = (() => {
            try {
              JSON.parse(args);
              return "json";
            } catch {
              return "text";
            }
          })();
          lines.push("```" + language, args, "```");
        }
        lines.push("</details>", "");
      }
    }

    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFilename(displayTitle)}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    toast.success("已导出 Markdown");
  }, [messages, hiddenIds, displayTitle]);

  /* ====================================================================
   *  Edit / regenerate / retry (UI-only branching)
   * ==================================================================== */

  const hideFromIndex = useCallback(
    (index: number) => {
      if (index < 0) return;
      setHiddenIds((previous) => {
        const next = new Set(previous);
        for (let cursor = index; cursor < messages.length; cursor += 1) {
          next.add(messages[cursor].id);
        }
        return next;
      });
    },
    [messages],
  );

  const handleEditResend = useCallback(
    (messageId: string, text: string) => {
      if (isStreaming) return;
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return;
      hideFromIndex(index);
      void submitTurn(text);
    },
    [isStreaming, messages, hideFromIndex, submitTurn],
  );

  const handleRegenerate = useCallback(
    (assistantMessageId: string) => {
      if (isStreaming) return;
      const index = messages.findIndex((message) => message.id === assistantMessageId);
      if (index < 0) return;
      let userIndex = -1;
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (messages[cursor].role === "user") {
          userIndex = cursor;
          break;
        }
      }
      if (userIndex < 0) return;
      const prompt = messages[userIndex].content;
      hideFromIndex(userIndex);
      void submitTurn(prompt);
    },
    [isStreaming, messages, hideFromIndex, submitTurn],
  );

  const handleRetry = useCallback(() => {
    if (isStreaming) return;
    let userIndex = -1;
    for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role === "user") {
        userIndex = cursor;
        break;
      }
    }
    if (userIndex < 0) return;
    const prompt = messages[userIndex].content;
    hideFromIndex(userIndex);
    void submitTurn(prompt);
  }, [isStreaming, messages, hideFromIndex, submitTurn]);

  /* ====================================================================
   *  Derived UI values
   * ==================================================================== */

  const activeModeSlug = activeMode ?? "system:general";
  /* Attachment (text inline + image parts) is available in every mode — agent
     modes included. Attachments are converted server-side per mode cap. */
  const supportsAttachment = true;
  const isRcaMode = activeModeSlug === "system:rca";

  const effectiveMode = useMemo(
    () => modes.find((mode) => mode.slug === activeModeSlug),
    [modes, activeModeSlug],
  );

  const modeLabel = effectiveMode?.name ?? "通用";
  const modeIconNode = useMemo(() => {
    if (!effectiveMode) return <MessageCircle className="h-3 w-3" />;
    if (effectiveMode.slug.startsWith("user:")) {
      const icon = (effectiveMode.config as { icon?: string } | undefined)?.icon;
      return <span className="text-[10px] leading-none">{icon || "🤖"}</span>;
    }
    const systemSlug = effectiveMode.slug.replace("system:", "");
    const Icon = MODE_ICONS[systemSlug] || MessageCircle;
    return <Icon className="h-3 w-3" />;
  }, [effectiveMode]);

  /* The badge always mirrors the live selection: engine modes (Hermes-backed
     assistants) show their engine, LLM modes show the picked model. */
  const provider = resolveModeProvider(activeMode, effectiveMode);
  const engineMode = provider !== "llm";
  const engineName = providerLabel(provider);
  const modelLabel = engineMode ? engineName : selectedModel || "默认模型";
  const modelHint = engineMode
    ? `引擎：${engineName}（由 ${modeLabel} 调用）`
    : selectedModel
      ? `模型：${selectedModel}`
      : "模型：默认模型（未指定时由服务端决定）";
  const modeHint = engineMode
    ? `模式：${modeLabel} · 引擎：${engineName}`
    : `模式：${modeLabel} · ${modelHint}`;

  const errorText =
    error ??
    [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "error" && !hiddenIds.has(message.id),
      )?.content ??
    null;
  const canRetry = !isStreaming && messages.some((message) => message.role === "user");

  const isEmpty = messages.length === 0;

  const handleSuggestion = useCallback((text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      const editor = textareaRef.current;
      if (!editor) return;
      editor.focus();
      editor.selectionStart = editor.value.length;
      editor.selectionEnd = editor.value.length;
    });
  }, []);

  const handleSelectMode = useCallback((slug: string) => {
    /* Clicking the already-active mode keeps it selected: clearing it to
       ``null`` used to fall through to Hermes while the header still said 通用. */
    setActiveMode(slug);
  }, []);

  const handleOpenCreate = useCallback(() => {
    setEditMode(null);
    setCmName("");
    setCmPrompt("");
    setCmIcon("🤖");
    setCmProvider("llm");
    setShowCreate(true);
  }, []);

  const handleEditMode = useCallback((mode: ChatModeOut) => {
    const config = (mode.config ?? {}) as { icon?: string; provider?: string };
    setEditMode(mode);
    setCmName(mode.name);
    setCmPrompt(mode.system_prompt);
    setCmIcon(config.icon || "🤖");
    setCmProvider(config.provider || "llm");
    setShowCreate(true);
  }, []);

  const handleDeleteMode = useCallback(async (mode: ChatModeOut) => {
    const id = Number.parseInt(mode.slug.split(":")[1] ?? "", 10);
    if (!Number.isFinite(id)) return;
    try {
      await chatModes.deleteUserMode(id);
      if (activeMode === mode.slug) setActiveMode("system:general");
      chatModes.list().then(setModes).catch(() => {});
      toast.success("已删除智能助理");
    } catch {
      toast.error("删除失败，请重试");
    }
  }, [activeMode]);

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

  /* ====================================================================
   *  Render
   * ==================================================================== */

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-surface-primary">
      <ChatSidebar
        sessions={sessions}
        sessionId={sessionId}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        onNewSession={handleNewSession}
        onLoadSession={handleLoadSession}
        onDeleteSession={handleDeleteSession}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={displayTitle}
          modeLabel={modeLabel}
          modeIcon={modeIconNode}
          modeHint={modeHint}
          modelLabel={modelLabel}
          modelHint={modelHint}
          isStreaming={isStreaming}
          hasMessages={messages.length > 0}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
          onRename={handleRename}
          onClear={() => setClearOpen(true)}
          onExport={handleExport}
        />

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={handleViewportScroll}
            className="chat-thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pb-7 pt-5 sm:px-6 sm:pt-7">
              {isEmpty ? (
                <EmptyState
                  welcomeText={welcomeText}
                  welcomeLoading={welcomeLoading}
                  welcomeTyping={welcomeTyping}
                  onSuggestion={handleSuggestion}
                />
              ) : (
                <MessageList
                  messages={messages}
                  hiddenIds={hiddenIds}
                  errorText={errorText}
                  isStreaming={isStreaming}
                  canRetry={canRetry}
                  sessionId={sessionId}
                  onRetry={handleRetry}
                  onRegenerate={handleRegenerate}
                  onEditResend={handleEditResend}
                />
              )}
            </div>
          </div>

          {!isNearBottom && messages.length > 0 && (
            <button
              type="button"
              onClick={handleScrollToBottom}
              className={cn(
                "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-surface-primary/95 px-3 py-1.5 text-[11px] font-medium text-text-secondary shadow-lg backdrop-blur transition-all duration-150 hover:text-text-primary",
                hasUnread && "border-interactive-primary/30 ring-2 ring-interactive-primary/10",
              )}
              aria-label="回到底部"
              title="回到底部"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
              回到底部
              {hasUnread && (
                <span
                  className="ml-0.5 h-1.5 w-1.5 rounded-full bg-interactive-primary"
                  aria-hidden="true"
                />
              )}
            </button>
          )}
        </div>

        <div className="shrink-0 border-t border-border/40 bg-surface-primary/95 px-3 pb-3 pt-2.5 backdrop-blur sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <Composer
              input={input}
              setInput={setInput}
              textareaRef={textareaRef}
              isStreaming={isStreaming}
              canSteer={canSteer}
              activeRunId={activeRunId}
              onSend={handleSend}
              onStop={stopStreaming}
              onSteer={handleSteer}
              modes={modes}
              activeMode={activeMode}
              modeIcons={MODE_ICONS}
              hermesOnline={hermesOnline}
              onSelectMode={handleSelectMode}
              onCreateMode={handleOpenCreate}
              onEditMode={handleEditMode}
              onDeleteMode={handleDeleteMode}
              availableModels={availableModels}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              supportsAttachment={supportsAttachment}
              attachedFile={attachedFile}
              attachedImage={attachedImage}
              attachedTruncated={attachedTruncated}
              attachedOriginalChars={attachedOriginalChars}
              converting={converting}
              fileInputRef={fileInputRef}
              onFileSelect={handleFileSelect}
              onDropFile={(file) => void convertFile(file)}
              onClearAttachment={clearAttachment}
              isRcaMode={isRcaMode}
              rcaPreset={rcaPreset}
              rcaTimeStart={rcaTimeStart}
              rcaTimeEnd={rcaTimeEnd}
              onRcaPreset={applyRcaPreset}
              onRcaStart={setRcaTimeStart}
              onRcaEnd={setRcaTimeEnd}
              approvalsEnabled={runCapabilities.approval}
              pendingApproval={pendingApproval}
              approvalNotice={approvalNotice}
              onApproval={handleApprovalResponse}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清空当前对话"
        description="当前页面中的消息将被清空，已保存的历史会话仍会保留。是否继续？"
        confirmLabel="清空"
        variant="destructive"
        onConfirm={handleConfirmClear}
      />

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-surface-primary p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-text-primary">
                {editMode ? "编辑智能助理" : "创建智能助理"}
              </h3>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-secondary hover:text-text-primary"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[12px] font-medium text-text-secondary">图标</label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {["🤖", "🧠", "🔧", "📊", "🛡️", "🚀", "💡", "🎯", "⚡", "🔍", "📝", "💬"].map(
                    (emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => setCmIcon(emoji)}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg text-lg transition-all",
                          cmIcon === emoji
                            ? "bg-interactive-primary/10 ring-2 ring-interactive-primary/30"
                            : "hover:bg-surface-secondary",
                        )}
                      >
                        {emoji}
                      </button>
                    ),
                  )}
                </div>
              </div>

              <div>
                <label className="text-[12px] font-medium text-text-secondary">名称</label>
                <Input
                  value={cmName}
                  onChange={(event) => setCmName(event.target.value)}
                  placeholder="我的助理"
                  className="mt-1"
                />
              </div>

              <div>
                <label className="text-[12px] font-medium text-text-secondary">引擎</label>
                <select
                  value={cmProvider}
                  onChange={(event) => setCmProvider(event.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-surface-primary px-3 text-sm text-text-primary outline-none"
                >
                  <option value="llm">LLM 直连（通用模型）</option>
                  <option value="hermes">Hermes（工具调用）</option>
                </select>
              </div>

              <div>
                <label className="text-[12px] font-medium text-text-secondary">系统提示词</label>
                <textarea
                  value={cmPrompt}
                  onChange={(event) => setCmPrompt(event.target.value)}
                  rows={6}
                  placeholder={"你是一个专业的...\n设定助理的角色、能力和回复风格"}
                  className="chat-thin-scroll mt-1 w-full resize-none rounded-lg border border-border bg-surface-primary px-3 py-2 text-sm text-text-primary outline-none focus:ring-2 focus:ring-interactive-primary/25"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>
                取消
              </Button>
              <Button
                disabled={!cmName.trim()}
                onClick={async () => {
                  const data = {
                    name: cmName,
                    system_prompt: cmPrompt,
                    icon: cmIcon,
                    provider: cmProvider,
                  };
                  try {
                    if (editMode) {
                      const id = Number.parseInt(editMode.slug.split(":")[1] ?? "", 10);
                      await chatModes.updateUserMode(id, data);
                    } else {
                      await chatModes.createUserMode(data);
                    }
                    toast.success(editMode ? "已更新" : "已创建");
                    setShowCreate(false);
                    chatModes.list().then(setModes).catch(() => {});
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "保存失败");
                  }
                }}
              >
                {editMode ? "保存" : "创建"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
