/* ==========================================================================
 *  Chat presentation helpers
 *
 *  Pure formatting / clipboard helpers shared by the chat components.  Nothing
 *  here touches the chat data flow — the hook remains the single source of
 *  truth for messages, runs and capabilities.
 * ========================================================================== */

import type { DisplayMessage } from "@/hooks/useChat";

/** Copy text to the clipboard with a legacy fallback for insecure contexts. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/** Relative timestamp for the session sidebar. */
export function relativeTime(iso: string): string {
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

/** ``HH:mm`` clock label for a message hover action. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Session title derived from the first user message (40 chars max). */
export function titleFromMessages(messages: DisplayMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "新对话";
  const content = firstUser.content.trim();
  if (!content) return "新对话";
  return content.slice(0, 40) + (content.length > 40 ? "…" : "");
}

/** One-line label for an absolute timestamp (tooltip). */
export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Human duration for a tool group header ("1.2s", "12s", "1m 4s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** Extract plain text from a React node tree (for code-block copy). */
export function nodeToText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props;
    return nodeToText(props?.children);
  }
  return "";
}

/** Whether a display message's turn is still being produced. */
export function isMessageLive(message: DisplayMessage): boolean {
  return Boolean(message.isStreaming);
}

/** Tool status, normalised across Hermes' spellings. */
export type ToolState = "running" | "done" | "error";

export function toolState(message: DisplayMessage): ToolState {
  const status = message.toolCalls?.[0]?.hermes_status?.toLowerCase();
  if (status === "error" || status === "failed" || status === "failure") return "error";
  if (status === "running" || status === "started" || status === "in_progress") return "running";
  if (status === "completed" || status === "complete" || status === "done" || status === "success") {
    return "done";
  }
  return message.isStreaming ? "running" : "done";
}

/** Tool name (Hermes falls back to the message content). */
export function toolName(message: DisplayMessage): string {
  return (
    message.toolCalls?.[0]?.function?.name ||
    message.content ||
    "tool"
  );
}
