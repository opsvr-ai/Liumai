import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/* ==========================================================================
 *  告警策略卡片 — 共享排版原语
 *
 *  只负责「标签上置 + 说明小字 + 统一控件高度」的视觉一致性，不持有任何
 *  业务状态；数据与保存逻辑仍由 alerts 页面维护。
 * ========================================================================== */

/** 策略输入控件统一高度（36px），避免同一屏出现多种输入高度。 */
export const POLICY_INPUT_CLASS = "h-9 text-sm";
export const POLICY_SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none transition-colors hover:border-primary/30 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring";
export const POLICY_TEXTAREA_CLASS =
  "w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground outline-none transition-colors hover:border-primary/30 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring";

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex h-full flex-col gap-1.5", className)}>
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-text-secondary">{label}</p>
        {hint ? <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      {/* 说明文字行数不一致时，控件仍按行底对齐 */}
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/** 开关行：整行可点击，标签 + 说明 + 右侧复选框。 */
export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border/70 px-3 py-2.5 transition-colors hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-xs font-medium text-text-secondary">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-interactive-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** 多选胶囊：用于「多信号路径」「通知渠道」等少量枚举。 */
export function CheckChip({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      title={hint}
      className={cn(
        // `relative` 是必须的：内部的 `sr-only` 勾选框是 position:absolute，
        // 缺少定位祖先时会以初始包含块（html）为包含块，其静态位置会把
        // 文档 scrollHeight 撑到内容底部之外，导致整页可再向下滚出一片空白。
        "relative inline-flex h-9 cursor-pointer select-none items-center gap-2 rounded-lg border px-3 text-xs transition-colors",
        checked
          ? "border-interactive-primary/40 bg-interactive-primary/10 text-interactive-primary"
          : "border-border text-text-secondary hover:bg-muted/60",
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border",
          checked
            ? "border-interactive-primary bg-interactive-primary text-text-on-solid"
            : "border-muted-foreground/40",
        )}
      >
        {checked ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      {label}
    </label>
  );
}

/** 分组卡：序号 + 图标 + 14px 标题 + 一句话说明 + 右上角「已修改」徽标。 */
export function GroupCard({
  index,
  icon: Icon,
  title,
  description,
  dirty,
  footer,
  children,
}: {
  index?: string;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  dirty?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {index ? (
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-interactive-primary/10 text-[11px] font-semibold tabular-nums text-interactive-primary">
                {index}
              </span>
            ) : null}
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Icon className="h-4 w-4 text-muted-foreground" />
                {title}
              </CardTitle>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            </div>
          </div>
          {dirty ? (
            <Badge variant="investigating" className="shrink-0 text-[11px]">
              已修改
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
      {footer ? <div className="border-t border-border/60 px-4 py-2.5">{footer}</div> : null}
    </Card>
  );
}

/**
 * 可折叠长文本列表：默认收起，标题行显示计数徽标，展开后 160px 固定高度滚动。
 * 内部保留编辑文本缓冲，允许输入空行；对外仍以「每行一项」的数组回传。
 */
export function CollapsibleList({
  label,
  hint,
  value,
  onChange,
  placeholder,
  className,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (lines: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => value.join("\n"));

  // 外部重置（加载 / 还原）时同步文本；用户正在输入的空行不会被吃掉。
  useEffect(() => {
    const joined = value.join("\n");
    if (joined !== splitLines(text).join("\n")) setText(joined);
    // 仅在外部数组变化时同步，text 只作为当前缓冲的对照值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const count = value.length;

  return (
    <div className={cn("rounded-lg border border-border/70", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-text-secondary">{label}</span>
          {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
        </span>
        <Badge variant={count > 0 ? "secondary" : "outline"} className="shrink-0 text-[11px] tabular-nums">
          {count} 项
        </Badge>
      </button>

      {open ? (
        <div id={id} className="space-y-1.5 border-t border-border/60 px-3 py-2.5">
          <textarea
            aria-label={label}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onChange(splitLines(e.target.value));
            }}
            placeholder={placeholder}
            spellCheck={false}
            className={cn(POLICY_TEXTAREA_CLASS, "h-40 overflow-y-auto")}
          />
          <p className="text-xs text-muted-foreground">每行一项 · 已识别 {count} 项</p>
        </div>
      ) : null}
    </div>
  );
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
