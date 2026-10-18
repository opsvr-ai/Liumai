/* ==========================================================================
 *  Chat header — editable session title, mode/model badges, actions
 * ========================================================================== */

import {
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { Download, Pencil, PanelLeft, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatHeaderProps {
  title: string;
  /** Name of the mode currently selected in the composer (fallback "通用"). */
  modeLabel: string;
  /** Icon node for the selected mode. */
  modeIcon: ReactNode;
  /**
   * Tooltip for the mode badge.  It also carries the model/engine label so the
   * model stays discoverable when the badge is collapsed below ``md``.
   */
  modeHint: string;
  /** Model or engine currently handling the turn (``null`` → hidden). */
  modelLabel: string | null;
  /** Explains how the model/engine was chosen (default → server decides). */
  modelHint: string | null;
  isStreaming: boolean;
  hasMessages: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onRename: (title: string) => void;
  onClear: () => void;
  onExport: () => void;
}

const HeaderButton: FC<{
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}> = ({ label, disabled, onClick, children, className }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150",
      "hover:bg-surface-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-35",
      className,
    )}
    aria-label={label}
    title={label}
  >
    {children}
  </button>
);

export const ChatHeader: FC<ChatHeaderProps> = ({
  title,
  modeLabel,
  modeIcon,
  modeHint,
  modelLabel,
  modelHint,
  isStreaming,
  hasMessages,
  sidebarOpen,
  onToggleSidebar,
  onRename,
  onClear,
  onExport,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const committedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editing]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next !== title) onRename(next);
  };

  const beginEdit = () => {
    committedRef.current = false;
    setDraft(title);
    setEditing(true);
  };

  return (
    <header className="flex h-[58px] shrink-0 items-center gap-3 border-b border-border/60 bg-surface-primary/85 px-3 backdrop-blur sm:px-4">
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                committedRef.current = true;
                setDraft(title);
                setEditing(false);
              }
            }}
            onBlur={commit}
            maxLength={80}
            className="h-7 w-full max-w-[320px] rounded-md border border-interactive-primary/35 bg-surface-primary px-2 text-[13.5px] font-medium text-text-primary outline-none ring-2 ring-interactive-primary/15"
            aria-label="会话标题"
          />
        ) : (
          <button
            type="button"
            onClick={beginEdit}
            className="group/title flex max-w-full items-center gap-1.5 rounded-md text-left"
            title="点击编辑会话标题"
          >
            <span className="truncate text-[13.5px] font-medium leading-5 text-text-primary">
              {title}
            </span>
            <Pencil
              className="h-3 w-3 shrink-0 text-muted-foreground/50 opacity-100 transition-opacity duration-150 lg:opacity-0 lg:group-hover/title:opacity-100"
              aria-hidden="true"
            />
          </button>
        )}

        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span
            className="inline-flex max-w-[190px] items-center gap-1 truncate rounded-full bg-surface-secondary px-1.5 py-[1px] text-text-secondary"
            title={modeHint}
          >
            <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
              {modeIcon}
            </span>
            <span className="truncate">{modeLabel}</span>
          </span>
          {modelLabel && (
            <span
              className="hidden max-w-[180px] truncate rounded-full border border-border/60 px-1.5 py-[1px] text-muted-foreground/75 md:inline-block"
              title={modelHint ?? `模型：${modelLabel}`}
            >
              {modelLabel}
            </span>
          )}
          {isStreaming && (
            <span className="inline-flex items-center gap-1 text-interactive-primary">
              <span className="lm-breathe h-1.5 w-1.5 rounded-full bg-interactive-primary" aria-hidden="true" />
              生成中
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderButton label="导出 Markdown" onClick={onExport} disabled={!hasMessages}>
          <Download className="h-3.5 w-3.5" />
        </HeaderButton>
        <HeaderButton label="清空对话" onClick={onClear} disabled={!hasMessages}>
          <Trash2 className="h-3.5 w-3.5" />
        </HeaderButton>
        <span className="mx-1 h-4 w-px bg-border/70" aria-hidden="true" />
        <HeaderButton
          label={sidebarOpen ? "收起会话列表" : "展开会话列表"}
          onClick={onToggleSidebar}
        >
          <PanelLeft
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200",
              !sidebarOpen && "rotate-180",
            )}
          />
        </HeaderButton>
      </div>
    </header>
  );
};
