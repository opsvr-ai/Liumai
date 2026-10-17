import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  MessageSquarePlus,
  Moon,
  RefreshCw,
  Search,
  Sun,
} from "lucide-react";
import { useAuth } from "@/components/auth/auth-context";
import { cn } from "@/lib/utils";
import { buildCommandPages, type NavIcon } from "./nav-config";

/* ==========================================================================
 *  CommandPalette — lightweight ⌘K palette (no extra dependencies)
 *
 *  Keyboard:
 *    Ctrl/Cmd + K   toggle
 *    ↑ / ↓          move selection
 *    Enter          run selected command
 *    Esc            close
 * ========================================================================== */

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: NavIcon;
  keywords?: string[];
  run: () => void;
}

type Row =
  | { type: "group"; key: string; label: string }
  | { type: "item"; key: string; command: Command; index: number };

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { role } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const commands = useMemo<Command[]>(() => {
    const pageCommands: Command[] = buildCommandPages(role).map((page) => ({
      id: `page-${page.id}`,
      label: page.label,
      hint: page.description ?? page.path,
      group: page.groupLabel,
      icon: page.icon,
      keywords: [page.path, ...(page.keywords ?? [])],
      run: () => navigate(page.path),
    }));

    const actionCommands: Command[] = [
      {
        id: "action-new-chat",
        label: "新对话",
        hint: "打开智能对话",
        group: "快捷动作",
        icon: MessageSquarePlus,
        keywords: ["new chat", "ai", "duihua"],
        run: () => navigate("/chat"),
      },
      {
        id: "action-refresh",
        label: "刷新当前页",
        hint: "重新加载页面数据",
        group: "快捷动作",
        icon: RefreshCw,
        keywords: ["refresh", "reload", "shuaxin"],
        run: () => window.setTimeout(() => window.location.reload(), 60),
      },
      {
        id: "action-theme",
        label: resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题",
        hint: "主题外观切换",
        group: "快捷动作",
        icon: resolvedTheme === "dark" ? Sun : Moon,
        keywords: ["theme", "dark", "light", "zhuti"],
        run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      },
    ];

    return [...pageCommands, ...actionCommands];
  }, [navigate, resolvedTheme, role, setTheme]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      [command.label, command.group, command.hint ?? "", ...(command.keywords ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  const rows = useMemo<Row[]>(() => {
    const next: Row[] = [];
    let lastGroup = "";
    let index = 0;
    for (const command of filtered) {
      if (command.group !== lastGroup) {
        next.push({ type: "group", key: `group-${command.group}`, label: command.group });
        lastGroup = command.group;
      }
      next.push({ type: "item", key: command.id, command, index });
      index += 1;
    }
    return next;
  }, [filtered]);

  // Reset search each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  // Focus the search field after the dialog mounts.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Keep the selection inside the current result set.
  useEffect(() => {
    if (selected > filtered.length - 1) {
      setSelected(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selected]);

  // Keep the selected row visible.
  useEffect(() => {
    itemRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  // Global Ctrl/Cmd+K shortcut.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpenChange, open]);

  const execute = (command: Command) => {
    onOpenChange(false);
    command.run();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Chinese IME: Enter confirms the composition, it must not run a command.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        setSelected((index) => (index + 1) % filtered.length);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        setSelected((index) => (index - 1 + filtered.length) % filtered.length);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[selected];
      if (command) execute(command);
    }
  };

  const activeId = filtered[selected] ? `lm-command-${filtered[selected].id}` : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="lm-command-backdrop fixed inset-0 z-50 bg-overlay supports-backdrop-filter:backdrop-blur-[2px]" />
        <DialogPrimitive.Popup
          className="lm-command-panel fixed top-[14%] left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none"
          aria-label="命令面板"
        >
          <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>

          {/* Search field */}
          <div className="flex items-center gap-2.5 border-b border-border px-3.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder="搜索页面、快捷操作…"
              aria-label="搜索页面与快捷操作"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded
              aria-controls="lm-command-list"
              aria-activedescendant={activeId}
              className="h-12 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-muted-foreground"
            />
            <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
              Esc
            </kbd>
          </div>

          {/* Results */}
          <div
            id="lm-command-list"
            role="listbox"
            aria-label="命令结果"
            className="max-h-[min(58vh,26rem)] overflow-y-auto p-1.5"
          >
            {rows.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <p className="text-sm text-text-secondary">没有找到匹配页面或操作</p>
                <p className="mt-1 text-xs text-muted-foreground">试试「RCA」「对话」「刷新」等关键词</p>
              </div>
            ) : (
              rows.map((row) =>
                row.type === "group" ? (
                  <div
                    key={row.key}
                    role="presentation"
                    className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground"
                  >
                    {row.label}
                  </div>
                ) : (
                  <button
                    key={row.key}
                    id={`lm-command-${row.command.id}`}
                    ref={(element) => {
                      itemRefs.current[row.index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={row.index === selected}
                    onMouseMove={() => setSelected(row.index)}
                    onClick={() => execute(row.command)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                      row.index === selected
                        ? "bg-interactive-primary/10 text-text-primary"
                        : "text-text-secondary hover:bg-muted/70 hover:text-text-primary",
                    )}
                  >
                    <row.command.icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        row.index === selected ? "text-interactive-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="flex-1 truncate">{row.command.label}</span>
                    {row.command.hint && (
                      <span className="hidden max-w-[45%] truncate text-[11px] text-muted-foreground sm:block">
                        {row.command.hint}
                      </span>
                    )}
                    {row.index === selected && (
                      <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                  </button>
                ),
              )
            )}
          </div>

          {/* Keyboard hints */}
          <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="h-3 w-3" aria-hidden="true" />
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
              选择
            </span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
              打开
            </span>
            <span className="ml-auto hidden sm:inline">Esc 关闭</span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
