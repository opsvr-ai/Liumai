/* ==========================================================================
 *  Composer — the single fixed input region
 *
 *  Contents (top → bottom):
 *    · tool-approval prompt / approval result
 *    · RCA time window (only in RCA mode)
 *    · mode switcher + attachment chip
 *    · auto-growing textarea (1–8 lines)
 *    · attachments, model picker, run state, send / steer / stop
 *    · keyboard hints
 *
 *  Everything the old input card offered is preserved; the difference is that
 *  this region is laid out as a sibling of the transcript (never an overlay).
 * ========================================================================== */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Check,
  Clock,
  FileText,
  Loader2,
  MessageCircle,
  Plus,
  Send,
  ShieldAlert,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ChatApprovalRequest, ChatModeOut } from "@/lib/api";
import type { ChatApprovalDecision } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

/* ── Constants ─────────────────────────────────────────────────────────── */

const ACCEPTED_FILES =
  ".pdf,.docx,.pptx,.xlsx,.xls,.epub,.html,.csv,.json,.xml,.ipynb,.png,.jpg,.jpeg,.webp,.gif,.zip,.txt,.md,.py,.js,.ts,.log,.sql,.yaml,.yml,.ini,.cfg,.css,.rss";

const APPROVAL_ACTIONS: ReadonlyArray<{
  decision: ChatApprovalDecision;
  label: string;
}> = [
  { decision: "once", label: "允许一次" },
  { decision: "session", label: "本会话" },
  { decision: "always", label: "始终" },
  { decision: "deny", label: "拒绝" },
];

const RCA_PRESETS: ReadonlyArray<[string, string]> = [
  ["none", "自定义"],
  ["15m", "15 分钟"],
  ["1h", "1 小时"],
  ["4h", "4 小时"],
  ["24h", "24 小时"],
];

/* ── Props ─────────────────────────────────────────────────────────────── */

export interface ComposerProps {
  input: string;
  setInput: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  canSteer: boolean;
  activeRunId: string | null;
  onSend: () => void;
  onStop: () => void;
  onSteer: () => void;

  modes: ChatModeOut[];
  activeMode: string | null;
  modeIcons: Record<string, LucideIcon>;
  hermesOnline: boolean;
  onSelectMode: (slug: string, isActive: boolean) => void;
  onCreateMode: () => void;
  onEditMode: (mode: ChatModeOut) => void;
  onDeleteMode: (mode: ChatModeOut) => void;

  availableModels: Array<{ id: string }>;
  selectedModel: string;
  onSelectModel: (id: string) => void;

  supportsAttachment: boolean;
  attachedFile: File | null;
  /** Inline image staged for the current turn (thumbnail + placeholder only). */
  attachedImage?: {
    filename: string;
    dataUrl: string;
    bytes: number;
  } | null;
  /** Text attachment was truncated server-side. */
  attachedTruncated?: boolean;
  attachedOriginalChars?: number;
  converting: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  onDropFile: (file: File) => void;
  onClearAttachment: () => void;

  isRcaMode: boolean;
  rcaPreset: string;
  rcaTimeStart: string;
  rcaTimeEnd: string;
  onRcaPreset: (preset: string) => void;
  onRcaStart: (value: string) => void;
  onRcaEnd: (value: string) => void;

  approvalsEnabled: boolean;
  pendingApproval: ChatApprovalRequest | null;
  approvalNotice: string | null;
  onApproval: (decision: ChatApprovalDecision) => void;
}

/* ── Small pieces ──────────────────────────────────────────────────────── */

const ModeIconView: FC<{
  mode: ChatModeOut;
  icons: Record<string, LucideIcon>;
}> = ({ mode, icons }) => {
  const config = mode.config ?? {};
  if (mode.slug.startsWith("user:")) {
    return (
      <span className="text-[12px] leading-none" aria-hidden="true">
        {(config as { icon?: string }).icon || "🤖"}
      </span>
    );
  }
  const systemSlug = mode.slug.startsWith("system:")
    ? mode.slug.replace("system:", "")
    : mode.slug;
  const Icon = icons[systemSlug] || MessageCircle;
  return <Icon className="h-3 w-3" aria-hidden="true" />;
};

const ComposerHint: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="text-[10.5px] text-muted-foreground/55">{children}</span>
);

/* ── Composer ──────────────────────────────────────────────────────────── */

export const Composer: FC<ComposerProps> = ({
  input,
  setInput,
  textareaRef,
  isStreaming,
  canSteer,
  activeRunId,
  onSend,
  onStop,
  onSteer,
  modes,
  activeMode,
  modeIcons,
  hermesOnline,
  onSelectMode,
  onCreateMode,
  onEditMode,
  onDeleteMode,
  availableModels,
  selectedModel,
  onSelectModel,
  supportsAttachment,
  attachedFile,
  attachedImage,
  attachedTruncated,
  attachedOriginalChars,
  converting,
  fileInputRef,
  onFileSelect,
  onDropFile,
  onClearAttachment,
  isRcaMode,
  rcaPreset,
  rcaTimeStart,
  rcaTimeEnd,
  onRcaPreset,
  onRcaStart,
  onRcaEnd,
  approvalsEnabled,
  pendingApproval,
  approvalNotice,
  onApproval,
}) => {
  const [dragOver, setDragOver] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  /* Auto-resize: 1 line minimum, 8 lines maximum, then scroll. */
  useEffect(() => {
    const editor = textareaRef.current;
    if (!editor) return;
    editor.style.height = "auto";
    const lineHeight = 24;
    const minHeight = lineHeight + 22;
    const maxHeight = lineHeight * 8 + 22;
    const next = Math.min(Math.max(editor.scrollHeight, minHeight), maxHeight);
    editor.style.height = `${next}px`;
    editor.style.overflowY = editor.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input, textareaRef]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (pinyin etc.): Enter confirms the candidate, never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!supportsAttachment) return;
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (cardRef.current?.contains(event.relatedTarget as Node)) return;
    setDragOver(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!supportsAttachment) return;
    const file = event.dataTransfer.files?.[0];
    if (file) onDropFile(file);
  };

  const activeModeMeta = modes.find((mode) => mode.slug === activeMode);
  const placeholder = isStreaming
    ? canSteer
      ? "运行中… 输入补充指令，Enter 发送；点停止结束本轮"
      : "等待回复中…"
    : activeMode === "system:general"
      ? "通用模型智能问答，支持多格式文档上传…"
      : activeMode === "system:default"
        ? "智能运维助理，具备工具调用与自主执行能力…"
        : activeMode === "system:knowledge"
          ? "遵循 LLM-WIKI V2 协议，从知识库检索与问答…"
          : activeMode === "system:rca"
            ? "故障根因分析，输入服务名称和时间窗口…"
            : activeMode?.startsWith("user:")
              ? `与 ${activeModeMeta?.name || "自定义助理"} 对话…`
              : "输入消息…";

  return (
    <div className="w-full">
      {/* Approval prompt — inside the composer column, never floating. */}
      {approvalsEnabled && pendingApproval && (
        <div
          className="mb-2 rounded-xl border border-status-investigating/35 bg-status-investigating/[0.07] px-3 py-2.5"
          role="alertdialog"
          aria-label="工具调用审批"
        >
          <div className="flex items-start gap-2">
            <ShieldAlert
              className="mt-0.5 h-4 w-4 shrink-0 text-status-investigating"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-text-primary">
                工具调用需要审批
                {pendingApproval.tool && (
                  <>
                    {" · "}
                    <span className="rounded bg-surface-primary/70 px-1 py-0.5 font-mono text-[11px] text-text-secondary">
                      {pendingApproval.tool}
                    </span>
                  </>
                )}
              </p>
              {pendingApproval.description && (
                <p className="mt-0.5 break-words text-[11.5px] leading-snug text-text-secondary">
                  {pendingApproval.description}
                </p>
              )}
              {pendingApproval.command && (
                <pre className="chat-thin-scroll mt-1 max-h-28 overflow-auto rounded-md border border-border/50 bg-surface-primary/70 px-2 py-1.5 font-mono text-[11px] leading-snug text-text-secondary">
                  {pendingApproval.command}
                </pre>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            {APPROVAL_ACTIONS.map(({ decision, label }) => (
              <button
                key={decision}
                type="button"
                onClick={() => onApproval(decision)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-150",
                  decision === "deny"
                    ? "bg-status-active/10 text-status-active hover:bg-status-active/20"
                    : "bg-interactive-primary/10 text-interactive-primary hover:bg-interactive-primary/20",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {approvalsEnabled && !pendingApproval && approvalNotice && (
        <div
          className="mb-2 flex items-center justify-end gap-1.5 px-1 text-[11px] text-status-resolved"
          role="status"
          aria-live="polite"
        >
          {approvalNotice.startsWith("正在") ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-3 w-3" aria-hidden="true" />
          )}
          {approvalNotice}
        </div>
      )}

      {/* RCA time window */}
      {isRcaMode && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-border/60 bg-surface-secondary/40 px-2 py-1.5">
          <Clock className="ml-0.5 h-3 w-3 text-muted-foreground" aria-hidden="true" />
          {RCA_PRESETS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onRcaPreset(value)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] transition-colors duration-150",
                rcaPreset === value
                  ? "bg-interactive-primary/10 font-medium text-interactive-primary"
                  : "text-muted-foreground hover:bg-surface-tertiary/60 hover:text-text-secondary",
              )}
            >
              {label}
            </button>
          ))}
          {rcaPreset === "none" && (
            <>
              <input
                type="datetime-local"
                value={rcaTimeStart}
                onChange={(event) => onRcaStart(event.target.value)}
                className="h-7 rounded-lg border border-border/60 bg-surface-primary px-2 text-[11px] text-text-secondary outline-none focus:border-interactive-primary/40"
                aria-label="开始时间"
              />
              <span className="text-[11px] text-muted-foreground" aria-hidden="true">
                →
              </span>
              <input
                type="datetime-local"
                value={rcaTimeEnd}
                onChange={(event) => onRcaEnd(event.target.value)}
                className="h-7 rounded-lg border border-border/60 bg-surface-primary px-2 text-[11px] text-text-secondary outline-none focus:border-interactive-primary/40"
                aria-label="结束时间"
              />
            </>
          )}
        </div>
      )}

      {/* Input card */}
      <div
        ref={cardRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative overflow-hidden rounded-2xl border border-border/80 bg-surface-primary transition-all duration-200",
          "shadow-[0_1px_2px_rgba(0,0,0,0.03),0_10px_32px_-18px_rgba(0,0,0,0.18)]",
          "focus-within:border-interactive-primary/35 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_14px_40px_-18px_rgba(0,0,0,0.22)]",
          dragOver && "border-interactive-primary/60 ring-2 ring-interactive-primary/15",
        )}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-interactive-primary/50 bg-surface-primary/90 text-[12.5px] font-medium text-interactive-primary">
            松开以上传文档
          </div>
        )}

        {/* Mode switcher */}
        {modes.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {modes.map((mode) => {
              const config = mode.config ?? {};
              const isUserMode = mode.slug.startsWith("user:");
              const slug = mode.slug;
              const provider =
                (config as { provider?: string }).provider ||
                (slug.startsWith("system:") ? "hermes" : "llm");
              const needsHermes =
                provider === "hermes" ||
                (!isUserMode &&
                  !(config as { provider?: string }).provider &&
                  slug !== "system:general");
              const disabled = needsHermes && !hermesOnline;
              const isActive =
                activeMode === slug || (!activeMode && slug === "system:general");

              return (
                <div key={slug} className="group/mode relative flex shrink-0 items-center">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (!disabled) onSelectMode(slug, isActive);
                    }}
                    title={disabled ? "Hermes 服务不可用" : mode.name}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] transition-colors duration-150",
                      disabled
                        ? "cursor-not-allowed text-muted-foreground/35"
                        : isActive
                          ? "bg-interactive-primary/10 font-medium text-interactive-primary"
                          : "text-muted-foreground/75 hover:bg-surface-secondary hover:text-text-primary",
                    )}
                  >
                    <ModeIconView mode={mode} icons={modeIcons} />
                    {mode.name}
                    {disabled && <span className="text-[9px] opacity-60">⚠</span>}
                  </button>

                  {isUserMode && (
                    <span className="ml-0.5 flex items-center gap-0.5 opacity-100 transition-opacity duration-150 lg:opacity-0 lg:group-hover/mode:opacity-100 lg:group-focus-within/mode:opacity-100">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditMode(mode);
                        }}
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-tertiary text-[8px] text-text-secondary hover:bg-surface-secondary"
                        aria-label={`编辑 ${mode.name}`}
                        title="编辑助理"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteMode(mode);
                        }}
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-tertiary text-[8px] text-text-secondary hover:bg-status-active/15 hover:text-status-active"
                        aria-label={`删除 ${mode.name}`}
                        title="删除助理"
                      >
                        ✕
                      </button>
                    </span>
                  )}
                </div>
              );
            })}

            <button
              type="button"
              onClick={onCreateMode}
              className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 transition-colors hover:bg-surface-secondary hover:text-text-secondary"
              aria-label="创建智能助理"
              title="创建智能助理"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1 pl-1.5 text-[10px]",
                hermesOnline ? "text-muted-foreground/35" : "text-status-active",
              )}
              title={hermesOnline ? "Hermes 在线" : "Hermes 离线"}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  hermesOnline ? "bg-status-resolved" : "lm-breathe bg-status-active",
                )}
                aria-hidden="true"
              />
              {!hermesOnline && "离线"}
            </span>
          </div>
        )}

        {/* Attachment chip */}
        {supportsAttachment && (attachedFile || attachedImage) && (
          <div className="px-3 pt-2">
            {attachedImage ? (
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/60 bg-surface-secondary/70 px-2 py-1 text-[11.5px] text-text-secondary">
                <img
                  src={attachedImage.dataUrl}
                  alt={`[图片] ${attachedImage.filename}`}
                  className="h-9 w-9 shrink-0 rounded-md border border-border/50 object-cover"
                />
                <span className="max-w-[200px] truncate">
                  [图片] {attachedImage.filename}
                </span>
                <span className="text-[10.5px] text-muted-foreground/60">
                  {(attachedImage.bytes / 1024).toFixed(0)} KB · 仅本轮发送
                </span>
                {!converting && (
                  <button
                    type="button"
                    onClick={onClearAttachment}
                    className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 hover:bg-surface-tertiary hover:text-text-primary"
                    aria-label="移除图片"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </span>
            ) : (
              attachedFile && (
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/60 bg-surface-secondary/70 px-2 py-1 text-[11.5px] text-text-secondary">
                  {converting ? (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="max-w-[220px] truncate">{attachedFile.name}</span>
                  <span
                    className={cn(
                      "text-[10.5px]",
                      attachedTruncated
                        ? "text-status-investigating"
                        : "text-muted-foreground/60",
                    )}
                    title={
                      attachedTruncated && attachedOriginalChars
                        ? `原文 ${attachedOriginalChars} 字符，已截断`
                        : undefined
                    }
                  >
                    {converting
                      ? "解析中…"
                      : attachedTruncated
                        ? `已截断 · 原文 ${(attachedOriginalChars ?? 0).toLocaleString()} 字符`
                        : "已就绪"}
                  </span>
                  {!converting && (
                    <button
                      type="button"
                      onClick={onClearAttachment}
                      className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 hover:bg-surface-tertiary hover:text-text-primary"
                      aria-label="移除附件"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </span>
              )
            )}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isStreaming && !canSteer}
          rows={1}
          className="chat-thin-scroll w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-6 text-text-primary outline-none placeholder:text-muted-foreground/40 disabled:opacity-45"
          style={{ minHeight: 46 }}
          aria-label="聊天输入"
        />

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-0.5">
            {isStreaming && (
              <span
                className="mr-0.5 hidden min-w-0 items-center gap-1 rounded-full bg-interactive-primary/8 px-2 py-0.5 text-[10px] font-medium text-interactive-primary sm:inline-flex"
                role="status"
                aria-live="polite"
                title={activeRunId ? `运行中：${activeRunId}` : "正在执行"}
              >
                <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" aria-hidden="true" />
                <span className="max-w-[150px] truncate">
                  {activeRunId ? `执行中 · ${activeRunId}` : "执行中"}
                </span>
              </span>
            )}

            {supportsAttachment && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={onFileSelect}
                  className="hidden"
                  accept={ACCEPTED_FILES}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={converting}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/55 transition-colors hover:bg-surface-secondary hover:text-text-primary disabled:opacity-45"
                  title="上传文档或图片"
                  aria-label="上传文档或图片"
                >
                  {converting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </button>
              </>
            )}

            {supportsAttachment && availableModels.length > 0 && (
              <select
                value={selectedModel}
                onChange={(event) => onSelectModel(event.target.value)}
                title="选择模型（默认跟随后台配置）"
                className="h-7 max-w-[132px] cursor-pointer truncate rounded-md border-0 bg-transparent px-1.5 text-[11px] text-muted-foreground/75 outline-none transition-colors hover:bg-surface-secondary hover:text-text-secondary"
              >
                <option value="">默认模型</option>
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {isStreaming && canSteer && input.trim() && (
              <button
                type="button"
                onClick={onSteer}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-interactive-primary text-white shadow-sm transition-all duration-200 hover:bg-interactive-hover"
                aria-label="发送补充指令"
                title="发送补充指令（Steer）"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}

            <div className="relative h-8 w-8">
              <button
                type="button"
                onClick={onSend}
                disabled={!input.trim() || isStreaming}
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded-full transition-all duration-200",
                  isStreaming
                    ? "pointer-events-none scale-90 opacity-0"
                    : "scale-100 opacity-100",
                  input.trim()
                    ? "bg-text-primary text-surface-primary shadow-sm hover:opacity-90"
                    : "cursor-not-allowed bg-surface-tertiary text-muted-foreground/40",
                )}
                aria-label="发送"
                title="发送"
                aria-hidden={isStreaming}
                tabIndex={isStreaming ? -1 : 0}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onStop}
                className={cn(
                  "absolute inset-0 flex items-center justify-center rounded-full bg-text-primary text-surface-primary shadow-sm transition-all duration-200 hover:opacity-90",
                  isStreaming
                    ? "scale-100 opacity-100"
                    : "pointer-events-none scale-90 opacity-0",
                )}
                aria-label="停止生成"
                title="停止生成"
                aria-hidden={!isStreaming}
                tabIndex={isStreaming ? 0 : -1}
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Hints */}
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
        <ComposerHint>
          {isStreaming
            ? canSteer
              ? "输入补充指令，Enter 发送 · 停止按钮结束本轮"
              : "正在生成回复…"
            : "Enter 发送 · Shift+Enter 换行"}
        </ComposerHint>
        <ComposerHint>
          {supportsAttachment ? (
            <span className="hidden sm:inline">
              支持 PDF / Word / 图片等附件 · 可拖拽上传
            </span>
          ) : (
            <span className="hidden sm:inline">内容由 AI 生成，请核实</span>
          )}
        </ComposerHint>
      </div>
    </div>
  );
};
