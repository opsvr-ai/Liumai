/** Intelligent chat page — conversational interface powered by Hermes.

Renders the chat panel as a full-page experience, wired into the
sidebar navigation at the same level as 概览 and RCA 分析.
*/

import { ChatPanel } from "@/components/chat/ChatPanel";

export default function ChatPage() {
  return (
    <div className="h-full flex flex-col">
      {/* Page header */}
      <div className="shrink-0 px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold text-text-primary">智能对话</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          与运维智能助手对话，进行故障排查、指标分析等
        </p>
      </div>

      {/* Chat area — fills remaining height, centered and width-constrained */}
      <div className="flex-1 min-h-0 max-w-[48rem] mx-auto w-full">
        <ChatPanel />
      </div>
    </div>
  );
}
