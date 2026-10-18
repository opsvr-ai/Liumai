/* ==========================================================================
 *  Empty state — welcome greeting + four capability cards
 * ========================================================================== */

import type { FC } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  ShieldAlert,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { LiumaiLogo } from "@/components/liumai-logo";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  welcomeText: string;
  welcomeLoading: boolean;
  welcomeTyping: boolean;
  onSuggestion: (text: string) => void;
}

interface SuggestionCard {
  icon: typeof Activity;
  title: string;
  description: string;
  prompt: string;
  tone: string;
}

const SUGGESTIONS: SuggestionCard[] = [
  {
    icon: Activity,
    title: "系统健康巡检",
    description: "汇总核心服务、资源水位与近期异常",
    prompt: "帮我做一次系统健康巡检，汇总核心服务、资源水位和近期异常。",
    tone: "text-status-resolved bg-status-resolved/10",
  },
  {
    icon: Stethoscope,
    title: "故障根因定位",
    description: "结合告警与时间窗给出证据链",
    prompt: "帮我定位最近一次故障的根因，结合告警和时间窗给出证据链与处置建议。",
    tone: "text-interactive-primary bg-interactive-primary/10",
  },
  {
    icon: ShieldAlert,
    title: "活跃告警研判",
    description: "按影响面排序并给出处理优先级",
    prompt: "分析当前活跃告警，按影响面排序，并给出处理优先级。",
    tone: "text-status-investigating bg-status-investigating/10",
  },
  {
    icon: BookOpen,
    title: "知识库检索",
    description: "从运维知识库中查找处置步骤",
    prompt: "在知识库中检索：服务发布后错误率升高的排查与回滚步骤。",
    tone: "text-[#8b5cf6] bg-[#8b5cf6]/10",
  },
];

export const EmptyState: FC<EmptyStateProps> = ({
  welcomeText,
  welcomeLoading,
  welcomeTyping,
  onSuggestion,
}) => {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-1 py-10 sm:py-14">
      <div className="relative mb-5">
        <div
          className="absolute inset-0 scale-[1.9] rounded-full bg-interactive-primary/12 blur-2xl"
          aria-hidden="true"
        />
        <LiumaiLogo size={44} className="relative" />
      </div>

      <h1 className="text-center text-[22px] font-semibold tracking-tight text-text-primary sm:text-[24px]">
        今天想了解点什么？
      </h1>

      <div className="mt-2.5 min-h-[44px] max-w-[520px] text-center">
        {welcomeLoading ? (
          <div className="flex flex-col items-center gap-2 pt-1.5" aria-label="正在准备欢迎语">
            <span className="h-3 w-64 max-w-[70vw] animate-pulse rounded-full bg-surface-tertiary" />
            <span className="h-3 w-44 max-w-[55vw] animate-pulse rounded-full bg-surface-tertiary/80" />
          </div>
        ) : (
          <p className="text-[13px] leading-[1.7] text-muted-foreground">
            {welcomeText}
            {welcomeTyping && <span className="lm-chat-caret ml-0.5 align-middle" aria-hidden="true" />}
          </p>
        )}
      </div>

      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map(({ icon: Icon, title, description, prompt, tone }) => (
          <button
            key={title}
            type="button"
            onClick={() => onSuggestion(prompt)}
            className={cn(
              "group/card flex items-start gap-3 rounded-xl border border-border/70 bg-surface-primary px-3.5 py-3 text-left",
              "transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-surface-secondary/40 hover:shadow-sm",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                tone,
              )}
              aria-hidden="true"
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 text-[13px] font-medium text-text-primary">
                {title}
                <ArrowUpRight
                  className="h-3 w-3 -translate-x-0.5 opacity-0 transition-all duration-150 group-hover/card:translate-x-0 group-hover/card:opacity-60"
                  aria-hidden="true"
                />
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                {description}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[10.5px] text-muted-foreground/55">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        支持工具调用、代码执行与文档检索 · 内容由 AI 生成，请核实
      </p>
    </div>
  );
};
