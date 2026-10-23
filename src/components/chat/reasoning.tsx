/* ==========================================================================
 *  Reasoning ("thinking") — a single minimal, collapsible line
 *
 *  Expanded while the model is still thinking, folded automatically once the
 *  answer starts streaming.  It sits beside the tool-process group as part of
 *  the turn's "process", never above the final answer.
 * ========================================================================== */

import { useEffect, useRef, useState, type FC } from "react";
import { ChevronDown } from "lucide-react";
import { collapseDuplicateReasoning } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface ReasoningBlockProps {
  text: string;
  /** The assistant turn is still streaming. */
  streaming?: boolean;
  /** The final answer has started (reasoning is over). */
  hasAnswer?: boolean;
}

export const ReasoningBlock: FC<ReasoningBlockProps> = ({
  text,
  streaming,
  hasAnswer,
}) => {
  const active = Boolean(streaming) && !hasAnswer;
  const [open, setOpen] = useState(active);
  const userToggled = useRef(false);

  useEffect(() => {
    if (userToggled.current) return;
    setOpen(active);
  }, [active]);

  // Adjacent duplicate lines / paragraphs (whole-block replays) are collapsed
  // before rendering, so reasoning can never show the same thought twice even
  // when the source snapshot contained it twice.  Idempotent, so applying it
  // again after the message-list merge is harmless.
  const display = collapseDuplicateReasoning(text);

  if (!display.trim()) return null;

  const chars = [...display.trim()].length;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        className={cn(
          "group/think inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-[12px] transition-colors duration-150",
          active
            ? "text-text-secondary"
            : "text-muted-foreground hover:text-text-secondary",
        )}
      >
        <span aria-hidden="true" className="text-[13px] leading-none">
          🧠
        </span>
        <span className="truncate font-medium">
          {active ? "思考中…" : `思考过程（${chars} 字）`}
        </span>
        {active && (
          <span className="inline-flex items-center gap-0.5" aria-hidden="true">
            <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:180ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:360ms]" />
          </span>
        )}
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 opacity-50 transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="relative mt-1.5">
          <div className="chat-thin-scroll max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border/70 pl-3 pr-1 text-[12.5px] leading-[1.75] text-text-secondary/85 select-text">
            {display}
            {active && <span className="lm-chat-caret ml-0.5" aria-hidden="true" />}
          </div>
          {active && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-surface-primary to-transparent"
              aria-hidden="true"
            />
          )}
        </div>
      )}
    </div>
  );
};
