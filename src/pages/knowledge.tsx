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
import { knowledgeApi, type KnowledgeDoc, type KnowledgeDocStatus, type KnowledgeSearchExplainResult, type KnowledgeStats, type DistilledKnowledgeOut } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-context";
import { PermissionGate } from "@/components/auth/permission-gate";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";

/* ════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════ */

const STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:    { label: "待入库",   variant: "secondary" },
  ingesting:  { label: "入库中…", variant: "outline" },
  processing: { label: "入库中…", variant: "outline" },
  stored:     { label: "已存储",   variant: "default" },
  failed:     { label: "失败",     variant: "destructive" },
};

const PAGE_SIZE = 20;
const POLL_MS = 3000;
const INGESTING_STATUSES = new Set(["ingesting", "processing"]);
const TERMINAL_STATUSES = new Set(["stored", "failed"]);

const SOURCE_META: Record<string, string> = {
  upload: "上传",
  webhook: "Webhook",
  distillation: "蒸馏",
};

function sourceLabel(doc: Pick<KnowledgeDoc, "source_type" | "source_name">): string {
  if (doc.source_type === "webhook") return `Webhook·${doc.source_name ?? "-"}`;
  return SOURCE_META[doc.source_type] ?? doc.source_type;
}

/** 列表状态与轮询心跳可能短暂不一致：终态优先，其次任一方的“入库中”。 */
function resolveDocStatus(listStatus: string, live?: KnowledgeDocStatus): string {
  if (!live) return listStatus;
  if (TERMINAL_STATUSES.has(live.status)) return live.status;
  if (TERMINAL_STATUSES.has(listStatus)) return listStatus;
  if (INGESTING_STATUSES.has(live.status) || INGESTING_STATUSES.has(listStatus)) return "ingesting";
  return listStatus;
}

function IngestProgress({ status }: { status?: KnowledgeDocStatus }) {
  const progress = status?.progress ?? {
    stage: "queued",
    step: 0,
    total: 0,
    message: "正在入库…",
  };
  const pct = progress.total > 0
    ? Math.min(100, Math.round((progress.step / progress.total) * 100))
    : null;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded-full bg-border overflow-hidden">
          {pct === null ? (
            <div className="h-full w-1/3 rounded-full bg-interactive-primary animate-pulse" />
          ) : (
            <div className="h-full rounded-full bg-interactive-primary transition-all" style={{ width: `${Math.max(4, pct)}%` }} />
          )}
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {pct === null ? "处理中" : `${progress.step}/${progress.total}`}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground truncate">{progress.message}</p>
    </div>
  );
}

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

function KnowledgeTab({ isAdmin }: { isAdmin: boolean; onRefresh: () => void }) {
  const { has } = usePermissions();
  // 批量删除 / 重新入库 / 勾选维护需要 kb_edit；上传仍沿用管理员权限。
  const canEdit = has("kb_edit");
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [detail, setDetail] = useState<KnowledgeDoc | null>(null);
  const [statusMap, setStatusMap] = useState<Record<number, KnowledgeDocStatus>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

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
    const p: { search?: string; status?: string; source_type?: string; page?: number; page_size?: number } = {
      page,
      page_size: PAGE_SIZE,
    };
    if (search) p.search = search;
    if (statusFilter !== "all") p.status = statusFilter;
    if (sourceFilter !== "all") p.source_type = sourceFilter;
    knowledgeApi.list(p)
      .then(rows => {
        setDocs(rows);
        setDetail(prev => (prev ? rows.find(r => r.id === prev.id) ?? prev : null));
      })
      .catch(() => toast.error("加载失败"))
      .finally(() => setLoading(false));
    knowledgeApi.stats().then(setStats).catch(() => {});
    fetch("/api/knowledge/blindspots", { headers: { Authorization: `Bearer ${localStorage.getItem("liumai_token")}` } })
      .then(r => r.json()).then(setBlindspots).catch(() => {});
  }, [search, statusFilter, sourceFilter, page]);

  useEffect(() => { load(); }, [load]);

  /* 筛选 / 翻页后清空选择，避免误删其它页的文档 */
  useEffect(() => {
    setSelected([]);
    setBatchConfirm(false);
  }, [search, statusFilter, sourceFilter, page]);

  /* 只看“入库中”的文档：页面可见时每 3s 轮询一次，全部到达终态即停止 */
  const activeIds = useMemo(
    () => docs.filter(d => INGESTING_STATUSES.has(resolveDocStatus(d.status, statusMap[d.id]))).map(d => d.id),
    [docs, statusMap],
  );
  const activeKey = activeIds.join(",");
  useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split(",").map(Number);
    let cancelled = false;
    let timer: number | undefined;

    function schedule() {
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    }
    async function tick() {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        schedule();
        return;
      }
      const rows = await Promise.all(ids.map(id => knowledgeApi.status(id).catch(() => null)));
      if (cancelled) return;
      const next: Record<number, KnowledgeDocStatus> = {};
      let finished = false;
      rows.forEach((row, i) => {
        if (!row) return;
        next[ids[i]] = row;
        if (!INGESTING_STATUSES.has(row.status)) finished = true;
      });
      if (Object.keys(next).length > 0) setStatusMap(prev => ({ ...prev, ...next }));
      if (finished) load();
      schedule();
    }
    schedule();

    function onVisible() {
      if (document.visibilityState !== "visible") return;
      if (timer) window.clearTimeout(timer);
      void tick();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeKey, load]);

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (upFiles.length === 0 && !upContent.trim()) { toast.error("请选择文件或输入内容"); return; }
    setUploading(true); setUploadProgress({ current: 0, total: upFiles.length || 1 });
    try {
      if (upFiles.length > 0) {
        for (let i = 0; i < upFiles.length; i++) { setUploadProgress({ current: i + 1, total: upFiles.length }); await knowledgeApi.uploadFile(upFiles[i]); }
      } else { await knowledgeApi.uploadText("手动输入", upContent); }
      toast.success(upFiles.length > 0 ? `${upFiles.length} 个文档已上传` : "已上传");
      setShowUpload(false); setUpFiles([]); setUpContent("");
      setPage(1);
      load();
    } catch (err: any) { toast.error(err.message || "上传失败"); }
    finally { setUploading(false); setUploadProgress({ current: 0, total: 0 }); }
  };

  const handleIngest = async (id: number) => {
    /* 乐观更新：POST 只负责入队，真实进度由轮询接管 */
    setDocs(prev => prev.map(d => (d.id === id ? { ...d, status: "ingesting", error_message: null } : d)));
    setStatusMap(prev => ({
      ...prev,
      [id]: {
        status: "ingesting",
        progress: { stage: "queued", step: 0, total: 0, message: "已进入入库队列" },
        error: null,
        updated_at: new Date().toISOString(),
      } as KnowledgeDocStatus,
    }));
    if (detail?.id === id) setDetail({ ...detail, status: "ingesting", error_message: null });
    try {
      const r = await knowledgeApi.ingest(id);
      toast[r.ok ? "success" : "error"](r.message);
      load();
    } catch (err: any) {
      toast.error(err.message || "入库失败");
      load();
    }
  };

  const handleDeleteOne = async (id: number) => {
    try {
      await knowledgeApi.delete(id);
      setSelected(prev => prev.filter(x => x !== id));
      if (detail?.id === id) setDetail(null);
      load();
    } catch (err: any) {
      toast.error(err.message || "删除失败");
    }
  };

  const handleBatchDelete = async () => {
    if (selected.length === 0 || batchDeleting) return;
    setBatchDeleting(true);
    try {
      const r = await knowledgeApi.batchDelete(selected);
      toast.success(`已删除 ${r.deleted} 个文档${r.missing.length > 0 ? `（${r.missing.length} 个已不存在）` : ""}`);
      if (detail && selected.includes(detail.id)) setDetail(null);
      setSelected([]);
      setBatchConfirm(false);
      load();
    } catch (err: any) {
      toast.error(err.message || "批量删除失败");
    } finally {
      setBatchDeleting(false);
    }
  };

  const allSelected = docs.length > 0 && selected.length === docs.length;
  const toggleAll = () => setSelected(allSelected ? [] : docs.map(d => d.id));
  const toggleOne = (id: number) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const detailLive = detail ? statusMap[detail.id] : undefined;
  const detailStatus = detail ? resolveDocStatus(detail.status, detailLive) : "";
  const detailRunning = INGESTING_STATUSES.has(detailStatus);
  const detailMeta = STATUS_META[detailStatus] ?? STATUS_META.pending;

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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs"><Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="pl-7" placeholder="搜索…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} /></div>
        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v ?? "all"); setPage(1); }}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部</SelectItem><SelectItem value="pending">待入库</SelectItem><SelectItem value="ingesting">入库中</SelectItem><SelectItem value="stored">已存储</SelectItem><SelectItem value="failed">失败</SelectItem></SelectContent></Select>
        <Select value={sourceFilter} onValueChange={v => { setSourceFilter(v ?? "all"); setPage(1); }}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部来源</SelectItem><SelectItem value="upload">上传</SelectItem><SelectItem value="webhook">Webhook</SelectItem><SelectItem value="distillation">蒸馏</SelectItem></SelectContent></Select>
        {isAdmin && <Button size="sm" onClick={() => setShowUpload(v => !v)}><Plus className="h-3.5 w-3.5 mr-1" />上传</Button>}
      </div>

      {/* Batch action bar */}
      {canEdit && selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-status-active/20 bg-status-active/5 px-3 py-2">
          <span className="text-[12px] text-text-secondary">已选 {selected.length} 个文档</span>
          {batchConfirm ? (
            <>
              <span className="text-[11px] text-status-active">确认删除？此操作不可恢复</span>
              <Button size="sm" variant="outline" className="ml-auto text-status-active" disabled={batchDeleting} onClick={handleBatchDelete}>
                {batchDeleting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}确认删除
              </Button>
              <Button size="sm" variant="ghost" disabled={batchDeleting} onClick={() => setBatchConfirm(false)}>取消</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="ml-auto text-status-active" onClick={() => setBatchConfirm(true)}><Trash2 className="h-3.5 w-3.5 mr-1" />批量删除</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>取消选择</Button>
            </>
          )}
        </div>
      )}

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
          {canEdit && docs.length > 0 && !loading && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-surface-secondary/40">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-3.5 w-3.5 rounded accent-interactive-primary" />全选本页
              </label>
              <span className="text-[10px] text-muted-foreground ml-auto">共 {docs.length} 条</span>
            </div>
          )}
          {loading ? <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            : docs.length === 0 ? <p className="text-sm text-muted-foreground py-10 text-center">暂无文档</p>
              : <div className="divide-y max-h-[55vh] overflow-y-auto">{docs.map(d => {
                const live = statusMap[d.id];
                const effective = resolveDocStatus(d.status, live);
                const m = STATUS_META[effective] ?? STATUS_META.pending;
                const running = INGESTING_STATUSES.has(effective);
                return <div key={d.id} className={cn("px-3 py-2.5 cursor-pointer hover:bg-muted/50", detail?.id === d.id && "bg-muted/30")} onClick={() => setDetail(d)}>
                  <div className="flex items-start gap-2">
                    {canEdit && (
                      <input
                        type="checkbox"
                        checked={selected.includes(d.id)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleOne(d.id)}
                        className="mt-1 h-3.5 w-3.5 rounded accent-interactive-primary shrink-0"
                        aria-label={`选择 ${d.title}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0"><p className="text-[13px] font-medium truncate">{d.title}</p><p className="text-[11px] text-muted-foreground">{sourceLabel(d)} · 命中{d.hit_count}次</p></div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant={m.variant} className="text-[10px]">{m.label}</Badge>
                          {running && <Loader2 className="h-3 w-3 animate-spin text-interactive-primary" />}
                        </div>
                      </div>
                      {running && <IngestProgress status={live} />}
                      {effective === "failed" && (
                        <div className="mt-1 flex items-center gap-2">
                          <p className="text-[10px] text-status-active truncate flex-1">{d.error_message || live?.error || "入库失败"}</p>
                          {canEdit && <button type="button" onClick={e => { e.stopPropagation(); void handleIngest(d.id); }} className="text-[10px] font-medium text-interactive-primary hover:underline shrink-0">重试</button>}
                        </div>
                      )}
                    </div>
                  </div>
                </div>;
              })}</div>
          }
          {!loading && (
            <div className="flex items-center justify-between px-3 py-2 border-t">
              <span className="text-[11px] text-muted-foreground">第 {page} 页</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</Button>
                <Button size="sm" variant="ghost" disabled={docs.length < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>下一页</Button>
              </div>
            </div>
          )}
        </CardContent></Card>

        <Card><CardContent className="p-4">
          {!detail ? <p className="text-sm text-muted-foreground py-10 text-center">选择文档查看详情</p> : <div className="space-y-3 max-h-[55vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><h3 className="font-semibold text-sm truncate">{detail.title}</h3><p className="text-[11px] text-muted-foreground">{sourceLabel(detail)} · 命中{detail.hit_count}次</p></div>
              <div className="flex gap-1 shrink-0">
                <PermissionGate perm="kb_edit">
                  <Button size="sm" variant="outline" disabled={detailRunning} onClick={() => handleIngest(detail.id)}>
                    <Brain className="h-3.5 w-3.5 mr-1" />
                    {detailRunning ? "入库中…" : detailStatus === "stored" ? "重新入库" : detailStatus === "failed" ? "重试" : "入库"}
                  </Button>
                </PermissionGate>
                {canEdit && <Button size="sm" variant="ghost" onClick={() => handleDeleteOne(detail.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></Button>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={detailMeta.variant} className="text-[10px]">{detailMeta.label}</Badge>
              {detailRunning && <Loader2 className="h-3 w-3 animate-spin text-interactive-primary" />}
              {detail.updated_at && <span className="text-[10px] text-muted-foreground ml-auto">更新于 {new Date(detail.updated_at).toLocaleString()}</span>}
            </div>
            {detailRunning && <IngestProgress status={detailLive} />}
            {detail.error_message && <p className="text-[12px] text-status-active bg-status-active/5 rounded-lg p-2">{detail.error_message}</p>}
            {!detail.error_message && detailLive?.error && <p className="text-[12px] text-status-active bg-status-active/5 rounded-lg p-2">{detailLive.error}</p>}
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
                  <Button size="sm" variant="ghost" onClick={() => { void copyText(url).then((ok) => ok ? toast.success("已复制") : toast.error("复制失败")); }}><Copy className="h-3.5 w-3.5" /></Button>
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
  const [errorMsg, setErrorMsg] = useState("");
  const [result, setResult] = useState<KnowledgeSearchExplainResult | null>(null);
  const [feedback, setFeedback] = useState<"hit" | "miss" | null>(null);
  const [history, setHistory] = useState<Array<{ q: string; hit: boolean; time: string }>>([]);

  const handleTest = async () => {
    const q = question.trim();
    if (!q || testing) return;
    setTesting(true); setResult(null); setFeedback(null); setErrorMsg("");
    try {
      /* 单次 Hermes 调用：回答 + 来源 + 置信度 + 耗时（来源按标题关联本地文档） */
      const r = await knowledgeApi.searchExplain(q);
      setResult(r);
      setHistory(p => [{ q, hit: r.hit, time: new Date().toLocaleTimeString() }, ...p].slice(0, 20));
    } catch (err: any) {
      const msg = err?.message || "测试失败";
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Test input */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-sm text-muted-foreground">输入问题，调用 Hermes 检索知识库并返回可解释来源（单次调用）</p>
          <div className="flex gap-2">
            <Input value={question} onChange={e => setQuestion(e.target.value)} placeholder="输入测试问题…" onKeyDown={e => e.key === "Enter" && handleTest()} />
            <Button onClick={handleTest} disabled={testing}>{testing ? <Loader2 className="h-4 w-4 animate-spin" /> : "测试"}</Button>
          </div>

          {testing && (
            <div className="flex items-center gap-2 rounded-xl border border-interactive-primary/20 bg-interactive-primary/5 px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-interactive-primary" />
              <span className="text-[13px] font-medium text-interactive-primary">检索中…</span>
              <span className="text-[11px] text-muted-foreground ml-auto">通常需要几秒到几十秒</span>
            </div>
          )}

          {errorMsg && !testing && <p className="text-[12px] text-status-active bg-status-active/5 rounded-lg p-2">{errorMsg}</p>}

          {result && !testing && (
            <div className={cn("rounded-xl p-4 border", result.hit ? "border-status-resolved/20 bg-status-resolved/5" : "border-status-active/20 bg-status-active/5")}>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {result.hit ? <Check className="h-5 w-5 text-status-resolved" /> : <X className="h-5 w-5 text-status-active" />}
                <span className={cn("font-semibold", result.hit ? "text-status-resolved" : "text-status-active")}>{result.hit ? "命中" : "未命中"}</span>
                <Badge variant={result.hit ? "default" : "secondary"} className="text-[10px]">置信度 {(result.confidence * 100).toFixed(0)}%</Badge>
                <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">耗时 {result.latency_ms} ms</span>
              </div>

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
                  {result.answer || "（无回答内容）"}
                </ReactMarkdown>
              </div>

              {result.hit ? (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-[11px] font-medium text-muted-foreground">引用来源 ({result.sources.length})</p>
                    <span className="text-[10px] text-muted-foreground">标题匹配 · 非向量检索</span>
                  </div>
                  {result.sources.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">模型未提供具体来源标题，无法关联本地文档。</p>
                  ) : (
                    <div className="space-y-1">
                      {result.sources.map((s, i) => (
                        <div key={`${s.title}-${i}`} className="flex items-center gap-2 rounded-lg bg-surface-secondary/60 px-2.5 py-1.5">
                          <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-[12px] truncate flex-1">{s.title}</span>
                          {s.doc_id != null
                            ? <Badge variant="outline" className="text-[9px] shrink-0">文档 #{s.doc_id}</Badge>
                            : <span className="text-[10px] text-muted-foreground shrink-0">未匹配本地文档</span>}
                          {s.score != null && <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{(s.score * 100).toFixed(0)}%</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[10px] text-muted-foreground">来源匹配基于标题（归一化精确/包含），非向量检索；「文档 #ID」为匹配到的本地已入库文档。</p>
                </div>
              ) : (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <div className="rounded-lg border border-dashed border-status-active/30 bg-surface-primary/60 p-3">
                    <div className="flex items-center gap-2">
                      <Search className="h-4 w-4 text-status-active" />
                      <span className="text-[13px] font-medium">知识库中没有找到相关答案</span>
                    </div>
                    <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground list-disc pl-5">
                      <li>换一种问法，加入系统名、指标名或具体报错关键词</li>
                      <li>在「知识库」上传相关文档并点击「入库」，等待状态变为已存储</li>
                      <li>确认相关 Webhook 数据源仍在持续推送</li>
                      <li>查看下方「知识盲区」，优先补齐高频未命中问题</li>
                    </ul>
                  </div>
                </div>
              )}

              {feedback === null && (
                <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">这个结果准确吗？</span>
                  <button onClick={() => setFeedback("hit")} className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-status-resolved/30 text-status-resolved hover:bg-status-resolved/10"><ThumbsUp className="h-3 w-3" />命中</button>
                  <button onClick={() => setFeedback("miss")} className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-status-active/30 text-status-active hover:bg-status-active/10"><ThumbsDown className="h-3 w-3" />未命中</button>
                </div>
              )}
              {feedback && <p className="mt-3 pt-3 border-t border-border/50 text-[11px] text-muted-foreground">{feedback === "hit" ? "✅ 已反馈" : "⚠️ 已反馈 — 会优化覆盖"}</p>}
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
  const { has } = usePermissions();
  // 候选知识的批准 / 拒绝属于知识标注，使用 kb_annotate 权限位。
  const canAnnotate = has("kb_annotate");
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
                  {dk.status === "candidate" && canAnnotate && <div className="flex gap-1"><button onClick={async () => { await knowledgeApi.reviewDistilled(dk.id, "approve"); toast.success("已批准"); load(); }} className="text-[10px] px-1.5 py-0.5 rounded bg-status-resolved/10 text-status-resolved hover:bg-status-resolved/20">批准</button><button onClick={async () => { await knowledgeApi.reviewDistilled(dk.id, "reject"); toast.success("已拒绝"); load(); }} className="text-[10px] px-1.5 py-0.5 rounded bg-status-active/10 text-status-active hover:bg-status-active/20">拒绝</button></div>}
                  {dk.status !== "candidate" && <Badge variant={dk.status === "approved" || dk.status === "stored" ? "default" : "secondary"} className="text-[10px]">{dk.status === "approved" ? "已批准" : dk.status === "stored" ? "已入库" : "已拒绝"}</Badge>}
                </div>
              </div>
            </div>)}</div>
        }</CardContent></Card>
    </div>
  );
}
