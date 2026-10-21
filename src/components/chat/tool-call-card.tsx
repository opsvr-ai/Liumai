/* ==========================================================================
 *  Tool process group — folds every tool call of one turn into a single
 *  "执行过程" section.
 *
 *  Header:  ⚙ 已执行 N 个工具 · 耗时 Xs          (finished, collapsed)
 *           ● 正在执行 <tool>                     (running, expanded)
 *
 *  Body:    one row per tool, in FIRST-SEEN order — icon, tool name, state,
 *           parameter summary (JSON expandable), result summary and duration.
 * ========================================================================== */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
} from "react";
import {
  Calculator,
  Check,
  ChevronDown,
  Code,
  Database,
  FileText,
  Globe,
  Image as ImageIcon,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { DisplayMessage } from "@/hooks/useChat";
import type { ToolCallDelta } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDuration, toolName, toolState, type ToolState } from "./chat-utils";

type IconComponent = FC<{ className?: string }>;

const TOOL_ICONS: Record<string, IconComponent> = {
  terminal: Terminal,
  bash: Terminal,
  shell: Terminal,
  cmd: Terminal,
  powershell: Terminal,
  sh: Terminal,
  zsh: Terminal,
  execute: Terminal,
  executecommand: Terminal,
  executecode: Terminal,
  codeinterpreter: Code,
  run: Terminal,
  browser: Globe,
  browsernavigate: Globe,
  browsertool: Globe,
  websearch: Globe,
  webfetch: Globe,
  httprequest: Globe,
  curl: Globe,
  fetch: Globe,
  search: Search,
  grep: Search,
  find: Search,
  rg: Search,
  glob: Search,
  database: Database,
  db: Database,
  sql: Database,
  query: Database,
  postgres: Database,
  mysql: Database,
  clickhouse: Database,
  prometheus: Database,
  code: Code,
  python: Code,
  js: Code,
  node: Code,
  calculator: Calculator,
  calc: Calculator,
  math: Calculator,
  fileread: FileText,
  filewrite: FileText,
  cat: FileText,
  read: FileText,
  write: FileText,
  edit: FileText,
  ls: FileText,
  list: FileText,
  image: ImageIcon,
  screenshot: ImageIcon,
  memory: Sparkles,
  notes: Sparkles,
  tool: Wrench,
  tools: Wrench,
};

function resolveToolIcon(name: string): IconComponent {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (TOOL_ICONS[key]) return TOOL_ICONS[key];
  for (const [pattern, icon] of Object.entries(TOOL_ICONS)) {
    if (key.startsWith(pattern) || key.includes(pattern)) return icon;
  }
  return Wrench;
}

/** First-seen sequence of a tool (older saved turns have none — keep order). */
function toolSeq(message: DisplayMessage): number | null {
  const seq = message.toolCalls?.[0]?.hermes_seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

/** Stable first-seen ordering (falls back to the array order). */
function orderTools(messages: DisplayMessage[]): DisplayMessage[] {
  const indexed = messages.map((message, index) => ({
    message,
    index,
    seq: toolSeq(message),
  }));
  if (indexed.every((entry) => entry.seq !== null)) {
    indexed.sort((a, b) => (a.seq as number) - (b.seq as number) || a.index - b.index);
  }
  return indexed.map((entry) => entry.message);
}

/** Wall-clock duration reported by Hermes for a tool run (ms). */
function toolDurationMs(tool: ToolCallDelta | undefined): number | null {
  if (!tool) return null;
  const value = tool.hermes_duration_ms;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Compact one-line parameter preview when the raw args are JSON. */
function compactJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** One tool inside the expanded group. */
const ToolRow: FC<{ message: DisplayMessage; isLast: boolean }> = ({
  message,
  isLast,
}) => {
  const state = toolState(message);
  const name = toolName(message);
  const tool = message.toolCalls?.[0];
  const label = tool?.hermes_label?.trim() ?? "";
  const args = tool?.function?.arguments?.trim() ?? "";
  const result = tool?.hermes_result?.trim() ?? "";
  const error = tool?.hermes_error?.trim() ?? "";

  const parsedArgs = useMemo(() => {
    if (!args) return null;
    try {
      return JSON.parse(args) as unknown;
    } catch {
      return null;
    }
  }, [args]);

  const [showArgs, setShowArgs] = useState(false);

  // Hermes progress events carry a human label; real tool-call deltas carry
  // the JSON argument payload.  Both are useful: the label is the one-line
  // summary, the raw payload stays available behind the "参数" toggle.
  const summary = label || (parsedArgs ? compactJson(parsedArgs) : args);
  const canShowArgs = Boolean(args);
  const argsText = parsedArgs ? JSON.stringify(parsedArgs, null, 2) : args;
  const ToolIcon = resolveToolIcon(name);
  const duration = toolDurationMs(tool);

  const stateLabel: Record<ToolState, string> = {
    running: "运行中",
    done: "完成",
    error: "失败",
  };
  const stateClass =
    state === "running"
      ? "text-interactive-primary"
      : state === "error"
        ? "text-status-active"
        : "text-status-resolved";
  const resultText = error || result;
  const resultLabel = state === "error" ? "失败" : "结果";

  return (
    <div
      className="relative"
      data-testid="tool-row"
      data-tool-name={name}
      data-tool-status={state}
      data-tool-seq={tool?.hermes_seq ?? ""}
    >
      {!isLast && (
        <span
          className="absolute bottom-0 left-[9px] top-7 w-px bg-border/70"
          aria-hidden="true"
        />
      )}
      <div className="flex gap-2.5">
        <span
          className={cn(
            "relative z-10 mt-0.5 flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border bg-surface-primary",
            state === "error"
              ? "border-status-active/30 text-status-active"
              : state === "done"
                ? "border-status-resolved/30 text-status-resolved"
                : "border-interactive-primary/30 text-interactive-primary",
          )}
          aria-hidden="true"
        >
          {state === "running" ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-interactive-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-interactive-primary" />
            </span>
          ) : state === "error" ? (
            <X className="h-2.5 w-2.5" strokeWidth={2.5} />
          ) : (
            <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
          )}
        </span>

        <div className="min-w-0 flex-1 pb-3 last:pb-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="break-all font-mono text-[12.5px] font-medium text-text-primary">
                {name}
              </span>
            </span>
            <span className={cn("text-[11px] font-medium", stateClass)}>
              {stateLabel[state]}
            </span>
            {duration !== null && (
              <span className="text-[11px] tabular-nums text-muted-foreground/75">
                · 耗时 {formatDuration(duration)}
              </span>
            )}
          </div>

          {summary && (
            <p className="mt-0.5 line-clamp-2 break-all text-[12px] leading-snug text-muted-foreground">
              <span className="mr-1 text-muted-foreground/70">参数</span>
              {summary}
            </p>
          )}

          {canShowArgs && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowArgs((value) => !value)}
                aria-expanded={showArgs}
                className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground/80 transition-colors hover:text-text-secondary"
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform duration-150",
                    showArgs && "rotate-180",
                  )}
                  aria-hidden="true"
                />
                {parsedArgs ? "参数 JSON" : "参数详情"}
              </button>
              {showArgs && (
                <pre className="chat-thin-scroll mt-1 max-h-56 overflow-auto rounded-md border border-border/50 bg-surface-secondary/70 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-text-secondary">
                  {argsText || "等待参数…"}
                </pre>
              )}
            </div>
          )}

          {resultText && (
            <p
              className={cn(
                "mt-1 whitespace-pre-wrap break-all text-[12px] leading-snug",
                state === "error" ? "text-status-active/90" : "text-text-secondary/85",
              )}
            >
              <span className="mr-1 text-muted-foreground/70">{resultLabel}</span>
              {resultText}
            </p>
          )}

          {state === "running" && !summary && !canShowArgs && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">等待参数…</p>
          )}
        </div>
      </div>
    </div>
  );
};

export interface ToolProcessGroupProps {
  /** Tool messages of one assistant turn (any array order; sorted by seq). */
  messages: DisplayMessage[];
}

export const ToolProcessGroup: FC<ToolProcessGroupProps> = ({ messages }) => {
  // Always render in first-seen order, even if a persisted turn was restored
  // in a different array order.
  const ordered = useMemo(() => orderTools(messages), [messages]);
  const states = ordered.map(toolState);
  const running = states.includes("running");
  const errorCount = states.filter((state) => state === "error").length;
  const doneCount = ordered.length - states.filter((s) => s === "running").length;

  // "Current tool" = the newest tool still running.
  const currentTool = useMemo(() => {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if (toolState(ordered[index]) === "running") return toolName(ordered[index]);
    }
    return ordered.length > 0 ? toolName(ordered[ordered.length - 1]) : "";
  }, [ordered]);

  const [expanded, setExpanded] = useState(running);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // Wall-clock span we actually observed, so a live tool group can report
  // "耗时 Xs" without inventing timestamps for restored messages.
  useEffect(() => {
    if (running) {
      if (startedAtRef.current === null) startedAtRef.current = performance.now();
      setDurationMs(null);
      setExpanded(true);
      return;
    }
    if (startedAtRef.current !== null) {
      setDurationMs(performance.now() - startedAtRef.current);
      startedAtRef.current = null;
      setExpanded(false);
    }
  }, [running]);

  // Restored groups have no live window: fall back to the sum of the
  // per-tool durations Hermes reported.
  const reportedDuration = useMemo(() => {
    let total = 0;
    for (const message of ordered) {
      const value = message.toolCalls?.[0]?.hermes_duration_ms;
      if (typeof value === "number" && value > 0) total += value;
    }
    return total > 0 ? total : null;
  }, [ordered]);
  // Prefer the durations Hermes reported for the tools themselves; the
  // wall-clock observation window is only a fallback for live/legacy groups.
  const shownDuration = reportedDuration ?? durationMs;

  const toggle = useCallback(() => setExpanded((value) => !value), []);

  if (ordered.length === 0) return null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border transition-colors duration-200",
        running
          ? "border-interactive-primary/20 bg-interactive-primary/[0.035]"
          : "border-border/60 bg-surface-secondary/35",
      )}
      data-testid="tool-process-group"
      data-tool-count={ordered.length}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] text-text-secondary transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <span aria-hidden="true" className="text-[13px] leading-none">
          ⚙
        </span>
        {running ? (
          <>
            <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
              <span className="lm-breathe absolute inline-flex h-full w-full rounded-full bg-interactive-primary" />
            </span>
            <span className="font-medium text-text-secondary">正在执行</span>
            <span className="truncate font-mono text-[11.5px] text-interactive-primary">
              {currentTool}
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              {doneCount}/{ordered.length}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-text-secondary">
              已执行 {ordered.length} 个工具
            </span>
            {errorCount > 0 && (
              <span className="text-status-active">· {errorCount} 个失败</span>
            )}
            {shownDuration !== null && shownDuration > 0 && (
              <span className="text-[11px] text-muted-foreground/80">
                · 耗时 {formatDuration(shownDuration)}
              </span>
            )}
          </>
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div className="chat-thin-scroll max-h-[420px] overflow-y-auto border-t border-border/50 px-3 py-2.5">
          {ordered.map((message, index) => (
            <ToolRow
              key={message.id}
              message={message}
              isLast={index === ordered.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};
