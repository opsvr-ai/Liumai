/** Knowledge Center — 知识库 | Webhook | 命中测试 | 知识蒸馏 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BookOpen, Upload, RefreshCw, Trash2, Search, Brain, Check, X, Loader2, Plus,
  Copy, FileText, Webhook, Target, ThumbsUp, ThumbsDown, Sparkles,
  ChevronRight, Clock, Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { knowledgeApi, type KnowledgeDoc, type KnowledgeStats, type KnowledgeTestResult, type DistilledKnowledgeOut } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-context";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "@/lib/utils";

/* ════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════ */

const STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:    { label: "待入库",   variant: "secondary" },
  processing: { label: "入库中…", variant: "outline" },
  stored:     { label: "已存储",   variant: "default" },
  failed:     { label: "失败",     variant: "destructive" },
};

function ExpandableText({ text, previewLen }: { text: string; previewLen: number }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= previewLen) return <>{text}</>;
  return <>{expanded ? text : text.slice(0, previewLen) + "…"}<button type="button" onClick={() => setExpanded(v => !v)} className="ml-1 text-interactive-primary hover:underline text-[11px] font-medium">{expanded ? "收起" : `展开 (${text.length}字)`}</button></>;
}

const TABS = [
  { key: "manage", label: "知识库", icon: BookOpen },
  { key: "webhook", label: "Webhook", icon: Webhook },
  { key: "test", label: "命中测试", icon: Target },
  { key: "distill", label: "知识蒸馏", icon: Brain },
] as const;
type TabKey = (typeof TABS)[number]["key"];

interface WebhookInfo {
  source: string; registered: boolean; doc_count: number; total_requests: number; last_request: string | null;
}

/* ════════════════════════════════════════════════════════
   Page
   ════════════════════════════════════════════════════════ */

export default function KnowledgePage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<TabKey>("manage");

  /* ── Shared ────────────────────────────────────── */
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      {/* Header + Tab bar */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold">知识中心</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {tab === "manage" && "管理知识库文档，上传、入库、检索"}
            {tab === "webhook" && "配置 Webhook 端点，自动接收外部知识"}
            {tab === "test" && "测试 llm-wiki v2 知识库命中率"}
            {tab === "distill" && "从对话记录中提炼运维知识"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1 bg-surface-secondary rounded-lg p-0.5 w-fit">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={cn("flex items-center gap-1.5 px-4 py-1.5 rounded-md text-[13px] font-medium transition-all",
                tab === t.key ? "bg-white text-text-primary shadow-sm" : "text-muted-foreground hover:text-text-secondary")}>
              <Icon className="h-3.5 w-3.5" />{t.label}
            </button>
          );
        })}
      </div>

      {tab === "manage" && <KnowledgeTab key={refreshKey} isAdmin={isAdmin} onRefresh={refresh} />}
      {tab === "webhook" && <WebhookTab key={refreshKey} isAdmin={isAdmin} onRefresh={refresh} />}
      {tab === "test" && <TestTab />}
      {tab === "distill" && <DistillTab key={refreshKey} isAdmin={isAdmin} onRefresh={refresh} />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════
   Tab 1 — 知识库
   ════════════════════════════════════════════════════════ */

function KnowledgeTab({ isAdmin, onRefresh }: { isAdmin: boolean; onRefresh: () => void }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [detail, setDetail] = useState<KnowledgeDoc | null>(null);

  /* Upload inline */
  const [showUpload, setShowUpload] = useState(false);
  const [upFiles, setUpFiles] = useState<File[]>([]);
  const [upContent, setUpContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  /* Blind spots */
  const [blindspots, setBlindspots] = useState<Array<{ question: string; count: number }>>([]);

  const load = useCallback(() => {
    setLoading(true);
    const p: Record<string, string | undefined> = {};
    if (search) p.search = search;
    if (statusFilter !== "all") p.status = statusFilter;
    knowledgeApi.list(p).then(setDocs).catch(() => toast.error("加载失败")).finally(() => setLoading(false));
    knowledgeApi.stats().then(setStats).catch(() => {});
    fetch("/api/knowledge/blindspots", { headers: { Authorization: `Bearer ${localStorage.getItem("liumai_token")}` } })
      .then(r => r.json()).then(setBlindspots).catch(() => {});
  }, [search, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (upFiles.length === 0 && !upContent.trim()) { toast.error("请选择文件或输入内容"); return; }
    setUploading(true); setUploadProgress({ current: 0, total: upFiles.length || 1 });
    try {
      if (upFiles.length > 0) {
        for (let i = 0; i < upFiles.length; i++) { setUploadProgress({ current: i + 1, total: upFiles.length }); await knowledgeApi.uploadFile(upFiles[i]); }
      } else { await knowledgeApi.uploadText("手动输入", upContent); }
      toast.success(upFiles.length > 0 ? `${upFiles.length} 个文档已上传` : "已上传");
      setShowUpload(false); setUpFiles([]); setUpContent(""); onRefresh();
    } catch (err: any) { toast.error(err.message || "上传失败"); }
    finally { setUploading(false); setUploadProgress({ current: 0, total: 0 }); }
  };

  const handleIngest = async (id: number) => {
    if (detail?.id === id) setDetail({ ...detail, status: "processing", error_message: null });
    try { const r = await knowledgeApi.ingest(id); toast[r.ok ? "success" : "error"](r.message); onRefresh(); if (detail?.id === id) setDetail(await knowledgeApi.get(id)); }
    catch (err: any) { toast.error(err.message || "入库失败"); }
  };

  return (
    <div className="space-y-5">
      {/* Stats */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          {[{ l: "文档总数", v: stats.total_docs, c: "text-interactive-primary", b: "bg-interactive-primary/10" },
            { l: "已存储", v: stats.stored_count, c: "text-status-resolved", b: "bg-status-resolved/10" },
            { l: "失败", v: stats.failed_count, c: "text-status-active", b: "bg-status-active/10" },
            { l: "累计命中", v: stats.total_hits, c: "text-blue-600", b: "bg-blue-50" },
          ].map(s => (
            <div key={s.l} className={`${s.b} rounded-xl px-4 py-2.5 flex items-center gap-3`}>
              <span className={`text-xl font-bold ${s.c}`}>{s.v}</span><span className="text-[11px] text-muted-foreground">{s.l}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs"><Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="pl-7" placeholder="搜索…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部</SelectItem><SelectItem value="pending">待入库</SelectItem><SelectItem value="stored">已存储</SelectItem><SelectItem value="failed">失败</SelectItem></SelectContent></Select>
        {isAdmin && <Button size="sm" onClick={() => setShowUpload(v => !v)}><Plus className="h-3.5 w-3.5 mr-1" />上传</Button>}
      </div>

      {/* Upload area (inline) */}
      {showUpload && (
        <form onSubmit={handleUpload} className="bg-surface-secondary rounded-xl p-4 space-y-3 border border-border/50">
          <div className="flex items-center justify-between"><p className="text-[13px] font-medium">上传文档</p><button type="button" onClick={() => setShowUpload(false)} className="text-muted-foreground hover:text-text-primary"><X className="h-4 w-4" /></button></div>
          {upFiles.length === 0 && <textarea value={upContent} onChange={e => setUpContent(e.target.value)} placeholder="粘贴文档内容，或选择文件上传" rows={5} className="w-full rounded-lg border border-border bg-surface-primary px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-interactive-primary/25" />}
          {upFiles.length > 0 && <div className="space-y-1 max-h-32 overflow-y-auto">{upFiles.map((f, i) => <div key={i} className="flex items-center gap-2 text-[12px] bg-surface-primary rounded px-2 py-1"><FileText className="h-3 w-3 text-muted-foreground shrink-0" /><span className="flex-1 truncate">{f.name}</span><button type="button" onClick={() => setUpFiles(p => p.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button></div>)}</div>}
          <div className="flex items-center gap-2">
            <label className="cursor-pointer inline-flex items-center gap-1 px-3 py-1 rounded-lg border text-[12px] hover:bg-surface-primary"><Upload className="h-3 w-3" />选择文件<input type="file" className="hidden" multiple accept=".pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.csv,.json,.html,.py,.js,.ts,.yaml,.yml,.log,.sql" onChange={e => { const fs = Array.from(e.target.files || []); if (fs.length > 0) setUpFiles(p => [...p, ...fs]); e.target.value = ""; }} /></label>
            {uploading && uploadProgress.total > 1 && <span className="text-[11px] text-muted-foreground">{uploadProgress.current}/{uploadProgress.total}</span>}
            <Button type="submit" size="sm" disabled={uploading} className="ml-auto">{uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}上传</Button>
          </div>
        </form>
      )}

      {/* Doc list + detail */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card><CardContent className="p-0">
          {loading ? <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            : docs.length === 0 ? <p className="text-sm text-muted-foreground py-10 text-center">暂无文档</p>
              : <div className="divide-y max-h-[55vh] overflow-y-auto">{docs.map(d => {
                const m = STATUS_META[d.status] ?? STATUS_META.pending;
                return <div key={d.id} className={cn("px-3 py-2.5 cursor-pointer hover:bg-muted/50", detail?.id === d.id && "bg-muted/30")} onClick={() => setDetail(d)}>
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[13px] font-medium truncate">{d.title}</p><p className="text-[11px] text-muted-foreground">{d.source_type === "webhook" ? `Webhook·${d.source_name}` : "上传"} · 命中{d.hit_count}次</p></div><Badge variant={m.variant} className="text-[10px] shrink-0">{m.label}</Badge></div>
                </div>;
              })}</div>
        }</CardContent></Card>

        <Card><CardContent className="p-4">
          {!detail ? <p className="text-sm text-muted-foreground py-10 text-center">选择文档查看详情</p> : <div className="space-y-3 max-h-[55vh] overflow-y-auto">
            <div className="flex items-start justify-between"><div><h3 className="font-semibold text-sm">{detail.title}</h3><p className="text-[11px] text-muted-foreground">{detail.source_type === "webhook" ? `Webhook·${detail.source_name}` : "上传"} · 命中{detail.hit_count}次</p></div><div className="flex gap-1">{isAdmin && detail.status !== "stored" && <Button size="sm" variant="outline" onClick={() => handleIngest(detail.id)}><Brain className="h-3.5 w-3.5 mr-1" />入库</Button>}{isAdmin && <Button size="sm" variant="ghost" onClick={() => { knowledgeApi.delete(detail.id).then(() => { setDetail(null); onRefresh(); }).catch(() => toast.error("删除失败")); }}><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></Button>}</div></div>
            <div className="flex items-center gap-2"><Badge variant={(STATUS_META[detail.status]?.variant ?? "secondary") as any} className="text-[10px]">{STATUS_META[detail.status]?.label ?? detail.status}</Badge>{detail.status === "processing" && <Loader2 className="h-3 w-3 animate-spin text-interactive-primary" />}</div>
            {detail.error_message && <p className="text-[12px] text-status-active bg-status-active/5 rounded-lg p-2">{detail.error_message}</p>}
            {detail.processed_content && <div><p className="text-[11px] font-medium text-muted-foreground mb-1">Hermes处理结果</p><p className="text-[12px] whitespace-pre-wrap bg-surface-secondary rounded-lg p-2 max-h-48 overflow-y-auto">{detail.processed_content}</p></div>}
            <div><p className="text-[11px] font-medium text-muted-foreground mb-1">原始内容({detail.content.length}字)</p><div className="text-[12px] whitespace-pre-wrap bg-surface-secondary rounded-lg p-2 max-h-48 overflow-y-auto"><ExpandableText text={detail.content} previewLen={3000} /></div></div>
          </div>}
        </CardContent></Card>
      </div>

      {/* Knowledge blind spots */}
      {blindspots.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">知识盲区 (高频未命中)</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="divide-y max-h-40 overflow-y-auto">
              {blindspots.map((b: any, i: number) => (
                <div key={i} className="px-4 py-2 flex items-center justify-between">
                  <p className="text-[12px] truncate flex-1">{b.question}</p>
                  <Badge variant="secondary" className="text-[10px] shrink-0 ml-2">{b.count}次</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════
   Tab 2 — Webhook
   ════════════════════════════════════════════════════════ */

function WebhookTab({ isAdmin, onRefresh }: { isAdmin: boolean; onRefresh: () => void }) {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  const totalReqs = useMemo(() => webhooks.reduce((s, w) => s + w.total_requests, 0), [webhooks]);
  const totalDocs = useMemo(() => webhooks.reduce((s, w) => s + w.doc_count, 0), [webhooks]);

  const load = useCallback(() => {
    setLoading(true);
    knowledgeApi.webhooks().then(setWebhooks).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try { await knowledgeApi.registerWebhook(newName.trim().toLowerCase().replace(/\s+/g, "_")); toast.success(`Webhook "${newName}" 已创建`); setNewName(""); load(); }
    catch (err: any) { toast.error(err.message || "创建失败"); }
  };

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="flex flex-wrap gap-3">
        {[{ l: "Webhook", v: webhooks.length, c: "text-indigo-600", b: "bg-indigo-50" },
          { l: "总请求", v: totalReqs, c: "text-interactive-primary", b: "bg-interactive-primary/10" },
          { l: "知识条数", v: totalDocs, c: "text-status-resolved", b: "bg-status-resolved/10" },
        ].map(s => <div key={s.l} className={`${s.b} rounded-xl px-4 py-2.5 flex items-center gap-3`}><span className={`text-xl font-bold ${s.c}`}>{s.v}</span><span className="text-[11px] text-muted-foreground">{s.l}</span></div>)}
      </div>

      {/* Create bar */}
      {isAdmin && (
        <div className="flex items-center gap-2">
          <Input className="max-w-xs" value={newName} onChange={e => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} placeholder="新 Webhook 名称" onKeyDown={e => e.key === "Enter" && handleCreate()} />
          <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>创建</Button>
        </div>
      )}

      {/* List */}
      <Card><CardContent className="p-0">
        {loading ? <div className="p-3 space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          : webhooks.length === 0 ? <p className="text-sm text-muted-foreground py-10 text-center">暂无 Webhook</p>
            : <div className="divide-y">{webhooks.map(w => {
              const url = `${window.location.origin}/api/knowledge/webhook/${w.source}`;
              return <div key={w.source} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{w.source}</p>
                  <p className="text-[11px] text-muted-foreground">{w.total_requests > 0 ? `${w.total_requests}次请求·${w.doc_count}条知识·最近:${w.last_request ? new Date(w.last_request).toLocaleString() : "-"}` : "暂无请求"}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <code className="text-[10px] text-muted-foreground bg-surface-primary rounded px-1.5 py-0.5 max-w-[180px] truncate hidden sm:inline">{url}</code>
                  <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(url); toast.success("已复制"); }}><Copy className="h-3.5 w-3.5" /></Button>
                  {isAdmin && <Button size="sm" variant="ghost" onClick={() => { knowledgeApi.deleteWebhook(w.source).then(() => load()).catch(() => toast.error("删除失败")); }}><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></Button>}
                </div>
              </div>;
            })}</div>
        }</CardContent></Card>

      {/* Help */}
      <button type="button" onClick={() => setShowHelp(v => !v)} className="text-[12px] text-muted-foreground hover:text-text-secondary flex items-center gap-1">
        <ChevronRight className={cn("h-3 w-3 transition-transform", showHelp && "rotate-90")} />使用说明
      </button>
      {showHelp && (
        <div className="bg-surface-secondary rounded-xl p-4 space-y-2 text-[11px] text-muted-foreground">
          <p className="font-medium text-text-secondary text-[12px]">如何调用 Webhook</p>
          {webhooks.length > 0 && (<code className="block bg-surface-primary rounded px-3 py-2 text-[10px] whitespace-pre-wrap break-all">curl -X POST {window.location.origin}/api/knowledge/webhook/{webhooks[0].source} \<br/>  -H "Content-Type: application/json" \<br/>  -d '{`{"event":"alert","message":"CPU>90%","host":"db-01"}`}'</code>)}
          <p>外部系统（Zabbix/Prometheus/脚本）向 Webhook URL 发送 JSON POST，平台自动提炼知识并存入 llm-wiki v2 知识库。</p>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════
   Tab 3 — 命中测试
   ════════════════════════════════════════════════════════ */

function TestTab() {
  const [question, setQuestion] = useState("");
  const [testing, setTesting] = useState(false);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [toolCalls, setToolCalls] = useState<Array<{ name: string; args: string; status?: string }>>([]);
  const [result, setResult] = useState<KnowledgeTestResult | null>(null);
  const [feedback, setFeedback] = useState<"hit" | "miss" | null>(null);
  const [history, setHistory] = useState<Array<{ q: string; hit: boolean; time: string }>>([]);

  const handleTest = async () => {
    if (!question.trim()) return;
    setTesting(true); setResult(null); setStreamingAnswer(""); setToolCalls([]); setFeedback(null);
    try {
      const tok = localStorage.getItem("liumai_token");
      const res = await fetch("/api/knowledge/test-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) throw new Error(await res.text());

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let fullAnswer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split by newlines, keep incomplete line in buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "delta" && evt.content) {
              fullAnswer += evt.content;
              setStreamingAnswer(fullAnswer);
            } else if (evt.type === "tool_call") {
              const tcs = evt.tool_calls || [];
              for (const tc of tcs) {
                setToolCalls(p => {
                  const idx = p.findIndex(t => t.name === (tc.function?.name || ""));
                  if (idx >= 0) {
                    const next = [...p];
                    next[idx] = { ...next[idx], args: (next[idx].args + (tc.function?.arguments || "")).slice(0, 200), status: tc.hermes_status || next[idx].status };
                    return next;
                  }
                  return [...p, { name: tc.function?.name || "工具", args: tc.function?.arguments || "", status: tc.hermes_status }];
                });
              }
            } else if (evt.type === "done") {
              finalizeResult(fullAnswer, question);
              return; // done — exit early
            } else if (evt.type === "error") {
              setResult({ hit: false, question, answer: evt.error || "测试失败", sources: [], confidence: 0 });
              setHistory(p => [{ q: question, hit: false, time: new Date().toLocaleTimeString() }, ...p].slice(0, 20));
              return;
            }
          } catch { /* skip unparseable */ }
        }
      }
      // Stream ended without explicit "done" event — treat as complete
      finalizeResult(fullAnswer, question);
    } catch (err: any) { toast.error(err.message || "测试失败"); }
    finally { setTesting(false); }
  };

  function finalizeResult(answer: string, q: string) {
    const hasHit = !answer.includes("未命中") && !answer.includes("没有找到");
    setResult({ hit: hasHit, question: q, answer, sources: [], confidence: hasHit ? 0.7 : 0.1 });
    setHistory(p => [{ q, hit: hasHit, time: new Date().toLocaleTimeString() }, ...p].slice(0, 20));
    setTesting(false);
  }

  return (
    <div className="space-y-5">
      {/* Test input */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-sm text-muted-foreground">输入问题，测试 llm-wiki v2 知识库是否能检索到相关知识</p>
          <div className="flex gap-2">
            <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder="输入测试问题…" onKeyDown={e => e.key === "Enter" && handleTest()} />
            <Button onClick={handleTest} disabled={testing}>{testing ? <Loader2 className="h-4 w-4 animate-spin" /> : "测试"}</Button>
          </div>

          {/* Streaming / Result */}
          {(streamingAnswer || result) && (
            <div className={cn("rounded-xl p-4 border", result ? (result.hit ? "border-status-resolved/20 bg-status-resolved/5" : "border-status-active/20 bg-status-active/5") : "border-interactive-primary/20 bg-interactive-primary/5")}>
              {result && (
                <div className="flex items-center gap-2 mb-2">{result.hit ? <Check className="h-5 w-5 text-status-resolved" /> : <X className="h-5 w-5 text-status-active" />}<span className={cn("font-semibold", result.hit ? "text-status-resolved" : "text-status-active")}>{result.hit ? `命中 (${(result.confidence * 100).toFixed(0)}%)` : "未命中"}</span></div>
              )}
              {testing && !result && <div className="flex items-center gap-2 mb-2"><Loader2 className="h-4 w-4 animate-spin text-interactive-primary" /><span className="text-[13px] font-medium text-interactive-primary">检索中…</span></div>}

              {/* Tool calls */}
              {toolCalls.length > 0 && (
                <div className="space-y-1 mb-3">
                  {toolCalls.map((tc, i) => (
                    <details key={i} className="bg-surface-secondary/50 rounded-lg border border-border/30">
                      <summary className="px-3 py-1.5 text-[11px] font-medium text-text-secondary cursor-pointer flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full", tc.status === "completed" ? "bg-status-resolved" : tc.status === "running" ? "bg-interactive-primary animate-pulse" : "bg-muted-foreground")} />
                        {tc.name}
                        {tc.status && <span className="text-[10px] text-muted-foreground ml-auto">{tc.status}</span>}
                      </summary>
                      {tc.args && <p className="px-3 pb-2 text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-all">{tc.args}</p>}
                    </details>
                  ))}
                </div>
              )}

              <div className="text-sm markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw, rehypeSanitize]}
                  components={{
                    pre: ({ children }) => <pre className="bg-surface-secondary/60 border border-border/50 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono whitespace-pre-wrap break-all">{children}</pre>,
                    code: ({ className: cls, children, ...rest }: any) => {
                      const isInline = !cls?.includes("language-");
                      if (isInline) return <code className="bg-surface-secondary/80 text-xs font-mono rounded px-1 py-0.5" {...rest}>{children}</code>;
                      return <code className="text-xs" {...rest}>{children}</code>;
                    },
                    table: ({ children }) => <div className="overflow-x-auto my-2"><table className="min-w-full border-collapse border border-border/50 text-xs">{children}</table></div>,
                    th: ({ children }) => <th className="border border-border/50 bg-surface-secondary/80 px-3 py-1.5 text-left font-medium">{children}</th>,
                    td: ({ children }) => <td className="border border-border/50 px-3 py-1.5">{children}</td>,
                    blockquote: ({ children }) => <blockquote className="border-l-3 border-interactive-primary/40 pl-3 my-2 italic">{children}</blockquote>,
                    ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
                    h1: ({ children }) => <h1 className="text-lg font-semibold mt-3 mb-1">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-base font-semibold mt-2.5 mb-1">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5">{children}</h3>,
                    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-interactive-primary underline underline-offset-2 hover:opacity-80">{children}</a>,
                    hr: () => <hr className="my-3 border-border/50" />,
                    p: ({ children }) => <p className="my-1">{children}</p>,
                  }}
                >
                  {streamingAnswer || result?.answer || ""}
                </ReactMarkdown>
                {testing && <span className="inline-block w-1.5 h-4 bg-interactive-primary ml-0.5 align-text-bottom animate-pulse rounded-sm" />}
              </div>
              {result?.sources && result.sources.length > 0 && <div className="mt-2"><p className="text-[11px] font-medium text-muted-foreground mb-1">引用来源:</p>{result.sources.map((s, i) => <p key={i} className="text-[11px] text-interactive-primary">• {s}</p>)}</div>}
              {result && feedback === null && (
                <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">这个结果准确吗？</span>
                  <button onClick={() => setFeedback("hit")} className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-status-resolved/30 text-status-resolved hover:bg-status-resolved/10"><ThumbsUp className="h-3 w-3" />命中</button>
                  <button onClick={() => setFeedback("miss")} className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-status-active/30 text-status-active hover:bg-status-active/10"><ThumbsDown className="h-3 w-3" />未命中</button>
                </div>
              )}
              {result && feedback && <p className="mt-3 pt-3 border-t border-border/50 text-[11px] text-muted-foreground">{feedback === "hit" ? "✅ 已反馈" : "⚠️ 已反馈 — 会优化覆盖"}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* History */}
      {history.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">测试历史</CardTitle></CardHeader>
          <CardContent className="p-0"><div className="divide-y max-h-48 overflow-y-auto">
            {history.map((h, i) => <div key={i} className="px-4 py-2 flex items-center justify-between"><p className="text-[12px] truncate flex-1">{h.q}</p><Badge variant={h.hit ? "default" : "secondary"} className="text-[10px] shrink-0 ml-2">{h.hit ? "命中" : "未命中"}</Badge><span className="text-[10px] text-muted-foreground ml-2">{h.time}</span></div>)}
          </div></CardContent>
        </Card>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════
   Tab 4 — 知识蒸馏
   ════════════════════════════════════════════════════════ */

function DistillTab({ isAdmin, onRefresh }: { isAdmin: boolean; onRefresh: () => void }) {
  const [candidates, setCandidates] = useState<DistilledKnowledgeOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<{ total_candidates: number; approved_count: number; rejected_count: number; avg_score: number } | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [autoDistill, setAutoDistill] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    knowledgeApi.listDistilled({}).then(setCandidates).catch(() => {}).finally(() => setLoading(false));
    knowledgeApi.distillStats().then(setStats).catch(() => {});
    knowledgeApi.distillQueue().then(q => setQueueCount(q.queue_count)).catch(() => {});
    knowledgeApi.distillConfig().then(c => setAutoDistill(c.auto_enabled)).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDistill = async () => {
    setRunning(true);
    try { const r = await knowledgeApi.triggerDistill({ limit: 20 }); toast.success(`扫描${r.sessions_scanned}会话，提取${r.knowledge_extracted}条`); load(); }
    catch (err: any) { toast.error(err.message || "蒸馏失败"); }
    finally { setRunning(false); }
  };

  return (
    <div className="space-y-5">
      {/* Stats */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          {[{ l: "候选知识", v: stats.total_candidates, c: "text-interactive-primary", b: "bg-interactive-primary/10" },
            { l: "已批准", v: stats.approved_count, c: "text-status-resolved", b: "bg-status-resolved/10" },
            { l: "已拒绝", v: stats.rejected_count, c: "text-status-active", b: "bg-status-active/10" },
            { l: "平均评分", v: stats.avg_score, c: "text-amber-600", b: "bg-amber-50" },
            { l: "待蒸馏", v: queueCount, c: "text-blue-600", b: "bg-blue-50" },
          ].map(s => <div key={s.l} className={`${s.b} rounded-xl px-4 py-2.5 flex items-center gap-3`}><span className={`text-xl font-bold ${s.c}`}>{s.v}</span><span className="text-[11px] text-muted-foreground">{s.l}</span></div>)}
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center gap-3">
        {isAdmin && <Button size="sm" onClick={handleDistill} disabled={running}>{running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Brain className="h-4 w-4 mr-1" />}{running ? "蒸馏中…" : "开始蒸馏"}</Button>}
        {queueCount > 0 && <span className="text-[11px] text-muted-foreground">待处理: <b className="text-text-primary">{queueCount}</b></span>}
        {isAdmin && (
          <label className="flex items-center gap-1.5 cursor-pointer select-none ml-auto">
            <input type="checkbox" checked={autoDistill} onChange={async e => { const v = e.target.checked; setAutoDistill(v); try { await knowledgeApi.setDistillConfig({ auto_enabled: v, interval_secs: 3600 }); toast.success(v ? "自动蒸馏已开启" : "已关闭"); } catch { toast.error("失败"); } }} className="w-3.5 h-3.5 rounded accent-interactive-primary" />
            <span className="text-[11px] text-muted-foreground">自动</span>
          </label>
        )}
        <Button variant="ghostMuted" size="icon-sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {/* Candidates */}
      <Card><CardContent className="p-0">
        {loading ? <div className="p-3 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          : candidates.length === 0 ? <p className="text-sm text-muted-foreground py-10 text-center">暂无候选知识</p>
            : <div className="divide-y max-h-[50vh] overflow-y-auto">{candidates.map(dk => <div key={dk.id} className="px-4 py-3 hover:bg-muted/30">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{dk.title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{dk.content.slice(0, 100)}</p>
                <div className="flex items-center gap-2 mt-1.5"><Badge variant="outline" className="text-[10px]">{dk.category}</Badge>{dk.tags?.map((t: string) => <span key={t} className="text-[10px] text-muted-foreground">#{t}</span>)}<span className="text-[10px] text-muted-foreground ml-auto">{dk.source_type}</span></div>
              </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5"><div className="w-16 h-1.5 rounded-full bg-border overflow-hidden"><div className={`h-full rounded-full ${dk.score >= 70 ? "bg-status-resolved" : dk.score >= 40 ? "bg-amber-500" : "bg-status-active"}`} style={{ width: `${dk.score}%` }} /></div><span className={cn("text-[11px] font-bold", dk.score >= 70 ? "text-status-resolved" : dk.score >= 40 ? "text-amber-600" : "text-status-active")}>{dk.score}</span></div>
                  {dk.status === "candidate" && isAdmin && <div className="flex gap-1"><button onClick={async () => { await knowledgeApi.reviewDistilled(dk.id, "approve"); toast.success("已批准"); load(); }} className="text-[10px] px-1.5 py-0.5 rounded bg-status-resolved/10 text-status-resolved hover:bg-status-resolved/20">批准</button><button onClick={async () => { await knowledgeApi.reviewDistilled(dk.id, "reject"); toast.success("已拒绝"); load(); }} className="text-[10px] px-1.5 py-0.5 rounded bg-status-active/10 text-status-active hover:bg-status-active/20">拒绝</button></div>}
                  {dk.status !== "candidate" && <Badge variant={dk.status === "approved" || dk.status === "stored" ? "default" : "secondary"} className="text-[10px]">{dk.status === "approved" ? "已批准" : dk.status === "stored" ? "已入库" : "已拒绝"}</Badge>}
                </div>
              </div>
            </div>)}</div>
        }</CardContent></Card>
    </div>
  );
}
