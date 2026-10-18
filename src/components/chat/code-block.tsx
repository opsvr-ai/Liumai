/* ==========================================================================
 *  Code block — language label, copy button, horizontal scroll
 * ========================================================================== */

import { useCallback, useState, type FC } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyText } from "./chat-utils";

export interface CodeBlockProps {
  code: string;
  /** Fence language, e.g. ``python`` / ``ts``. */
  language?: string;
  className?: string;
}

export const CodeBlock: FC<CodeBlockProps> = ({ code, language, className }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [code]);

  return (
    <div className={cn("chat-code-block my-3 overflow-hidden rounded-xl", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="flex items-center gap-1" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-status-active/55" />
          <span className="h-2 w-2 rounded-full bg-status-investigating/55" />
          <span className="h-2 w-2 rounded-full bg-status-resolved/55" />
        </span>
        <span className="ml-1 font-mono text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className={cn(
            "ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors duration-150",
            "hover:bg-black/[0.04] hover:text-text-primary dark:hover:bg-white/[0.06]",
            copied && "text-status-resolved",
          )}
          aria-label={copied ? "已复制代码" : "复制代码"}
          title={copied ? "已复制" : "复制代码"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre
        tabIndex={0}
        className="chat-code-scroll overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-text-primary"
      >
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
};
