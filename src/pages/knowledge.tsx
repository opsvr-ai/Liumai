/** Knowledge Center — document ingestion into llm-wiki v2 knowledge base. */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BookOpen,
  Upload,
  RefreshCw,
  Trash2,
  Search,
  Zap,
  Brain,
  Check,
  X,
  Loader2,
  Plus,
  ExternalLink,
  Copy,
  FileText,
  Webhook,
  Target,
  ThumbsUp,
  ThumbsDown,
  Link,
  Settings,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { knowledgeApi, type KnowledgeDoc, type KnowledgeStats, type KnowledgeTestResult } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* ── Helpers ────────────────────────────────────────────── */

const STATUS_META: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:    { label: "待入库",   variant: "secondary" },
  processing: { label: "入库中…", variant: "outline" },
  stored:     { label: "已存储",   variant: "default" },
  failed:     { label: "失败",     variant: "destructive" },
};

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
  toast.success("已复制到剪贴板");
}

function ExpandableText({ text, previewLen }: { text: string; previewLen: number }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= previewLen) return <>{text}</>;
  return (
    <>
      {expanded ? text : text.slice(0, previewLen) + "…"}
      <button type="button" onClick={() => setExpanded((v) => !v)}
        className="ml-1 text-interactive-primary hover:underline text-[11px] font-medium">
        {expanded ? "收起" : `展开全部 (${text.length} 字)`}
      </button>
    </>
  );
}

/* ── Component ──────────────────────────────────────────── */

export default function KnowledgePage() {
  const { isAdmin } = useAuth();
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [stats, setStats] = useState<KnowledgeStats | null>(null);

  /* Upload dialog */
  const [showUpload, setShowUpload] = useState(false);
  const [upFiles, setUpFiles] = useState<File[]>([]);
  const [upContent, setUpContent] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });

  /* Test panel */
  const [testOpen, setTestOpen] = useState(false);
  const [testQuestion, setTestQuestion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<KnowledgeTestResult | null>(null);
  const [feedback, setFeedback] = useState<"hit" | "miss" | null>(null);

  /* Detail panel */
  const [detail, setDetail] = useState<KnowledgeDoc | null>(null);

  /* Webhook config */
  const [webhooks, setWebhooks] = useState<Array<{ source: string; doc_count: number }>>([]);
  const [showWebhookConfig, setShowWebhookConfig] = useState(false);
  const [newWebhookName, setNewWebhookName] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    const params: Record<string, string | undefined> = {};
    if (search) params.search = search;
    if (statusFilter !== "all") params.status = statusFilter;
    knowledgeApi.list(params).then(setDocs).catch(() => toast.error("加载失败")).finally(() => setLoading(false));
    knowledgeApi.stats().then(setStats).catch(() => {});
    knowledgeApi.webhooks().then(setWebhooks).catch(() => {});
  }, [search, statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  /* ── Handlers ─────────────────────────────────────────── */

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (upFiles.length === 0 && !upContent.trim()) { toast.error("请选择文件或输入内容"); return; }
    setUploading(true);
    setUploadProgress({ current: 0, total: upFiles.length || 1 });
    try {
      if (upFiles.length > 0) {
        for (let i = 0; i < upFiles.length; i++) {
          setUploadProgress({ current: i + 1, total: upFiles.length });
          await knowledgeApi.uploadFile(upFiles[i]);
        }
      } else {
        await knowledgeApi.uploadText("手动输入", upContent);
      }
      toast.success(upFiles.length > 0 ? `${upFiles.length} 个文档已上传` : "文档已上传");
      setShowUpload(false);
      setUpFiles([]); setUpContent("");
      refresh();
    } catch (err: any) { toast.error(err.message || "上传失败"); }
    finally { setUploading(false); setUploadProgress({ current: 0, total: 0 }); }
  };

  const handleIngest = async (id: number) => {
    // Immediately show processing state
    if (detail?.id === id) setDetail({ ...detail, status: "processing", error_message: null });
    try {
      const r = await knowledgeApi.ingest(id);
      toast[r.ok ? "success" : "error"](r.message);
      refresh();
      if (detail?.id === id) setDetail(await knowledgeApi.get(id));
    } catch (err: any) { toast.error(err.message || "入库失败"); }
  };

  const handleTest = async () => {
    if (!testQuestion.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await knowledgeApi.test(testQuestion);
      setTestResult(r);
    } catch (err: any) { toast.error(err.message || "测试失败"); }
    finally { setTesting(false); }
  };

  /* Filtered docs */
  const filtered = useMemo(() => docs, [docs]);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">知识中心</h2>
          <p className="text-sm text-muted-foreground mt-0.5">管理 llm-wiki v2 知识库文档</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { setTestQuestion(""); setTestResult(null); setFeedback(null); setTestOpen(true); }}>
            <Target className="h-4 w-4 mr-1" />命中测试
          </Button>
          {isAdmin && (
            <Button size="sm" onClick={() => setShowUpload(true)}>
              <Plus className="h-4 w-4 mr-1" />上传文档
            </Button>
          )}
        </div>
      </div>

      {/* ── Stats ────────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "文档总数", value: stats.total_docs, icon: FileText, color: "text-interactive-primary", bg: "bg-interactive-primary/10" },
            { label: "已存储", value: stats.stored_count, icon: Check, color: "text-status-resolved", bg: "bg-status-resolved/10" },
            { label: "失败", value: stats.failed_count, icon: X, color: "text-status-active", bg: "bg-status-active/10" },
            { label: "累计命中", value: stats.total_hits, icon: Target, color: "text-blue-600", bg: "bg-blue-50" },
            { label: "Webhook", value: stats.webhook_sources.length, icon: Webhook, color: "text-indigo-600", bg: "bg-indigo-50" },
          ].map((s) => (
            <Card key={s.label}><CardContent className="p-3 flex items-center gap-3">
              <div className={`shrink-0 h-9 w-9 rounded-lg ${s.bg} flex items-center justify-center`}>
                <s.icon className={`h-4 w-4 ${s.color}`} />
              </div>
              <div><p className="text-lg font-bold">{s.value}</p><p className="text-[11px] text-muted-foreground">{s.label}</p></div>
            </CardContent></Card>
          ))}
        </div>
      )}

      {/* ── Filters ──────────────────────────────────────── */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-7" placeholder="搜索文档…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="pending">待入库</SelectItem>
            <SelectItem value="stored">已存储</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {/* ── Document list + detail ────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* List */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-10 text-center">暂无文档</p>
            ) : (
              <div className="divide-y divide-border/50 max-h-[60vh] overflow-y-auto">
                {filtered.map((d) => {
                  const meta = STATUS_META[d.status] ?? STATUS_META.pending;
                  return (
                    <div
                      key={d.id}
                      className={cn("px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors", detail?.id === d.id && "bg-muted/30")}
                      onClick={() => setDetail(d)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium truncate">{d.title}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {d.source_type === "webhook" ? `Webhook · ${d.source_name}` : "上传"} · 命中 {d.hit_count} 次
                          </p>
                        </div>
                        <Badge variant={meta.variant} className="text-[10px] shrink-0">{meta.label}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Detail */}
        <Card>
          <CardContent className="p-4">
            {!detail ? (
              <p className="text-sm text-muted-foreground py-10 text-center">选择文档查看详情</p>
            ) : (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-sm">{detail.title}</h3>
                    <p className="text-[11px] text-muted-foreground">
                      {detail.source_type === "webhook" ? `Webhook · ${detail.source_name}` : "上传"} · 命中 {detail.hit_count} 次
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {isAdmin && detail.status !== "stored" && (
                      <Button size="sm" variant="outline" onClick={() => handleIngest(detail.id)}><Brain className="h-3.5 w-3.5 mr-1" />入库</Button>
                    )}
                    {isAdmin && (
                      <Button size="sm" variant="ghost" onClick={() => { knowledgeApi.delete(detail.id).then(() => { setDetail(null); refresh(); }).catch(() => toast.error("删除失败")); }}>
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                </div>
                {/* Status with spinner for processing */}
                <div className="flex items-center gap-2">
                  <Badge variant={STATUS_META[detail.status]?.variant ?? "secondary"} className="text-[10px]">
                    {STATUS_META[detail.status]?.label ?? detail.status}
                  </Badge>
                  {detail.status === "processing" && <Loader2 className="h-3 w-3 animate-spin text-interactive-primary" />}
                </div>
                {detail.error_message && (
                  <p className="text-[12px] text-status-active bg-status-active/5 rounded-lg p-2">{detail.error_message}</p>
                )}
                {detail.processed_content && (
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground mb-1">Hermes 处理结果</p>
                    <p className="text-[12px] text-text-secondary whitespace-pre-wrap bg-surface-secondary rounded-lg p-2 max-h-60 overflow-y-auto">{detail.processed_content}</p>
                  </div>
                )}
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1">原始内容 ({detail.content.length} 字)</p>
                  <div className="text-[12px] text-text-secondary whitespace-pre-wrap bg-surface-secondary rounded-lg p-2 max-h-60 overflow-y-auto">
                    {detail.content.length > 8000
                      ? <ExpandableText text={detail.content} previewLen={3000} />
                      : detail.content}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Webhook configuration ─────────────────────────── */}
      {isAdmin && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Webhook className="h-4 w-4 text-indigo-500" />Webhook 配置
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => setShowWebhookConfig(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />新增
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {webhooks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">暂无 Webhook 来源，点击"新增"创建</p>
            ) : (
              <div className="space-y-2">
                {webhooks.map((w) => {
                  const webhookUrl = `${window.location.origin}/api/knowledge/webhook/${w.source}`;
                  return (
                    <div key={w.source} className="flex items-center justify-between bg-surface-secondary rounded-lg px-3 py-2">
                      <div>
                        <p className="text-[13px] font-medium">{w.source}</p>
                        <p className="text-[11px] text-muted-foreground">{w.doc_count} 条记录</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <code className="text-[10px] text-muted-foreground bg-surface-primary rounded px-1.5 py-0.5 max-w-[200px] truncate hidden sm:inline">{webhookUrl}</code>
                        <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(webhookUrl); toast.success("Webhook URL 已复制"); }}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { knowledgeApi.deleteWebhook(w.source).then(() => refresh()).catch(() => toast.error("删除失败")); }}>
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── New webhook dialog ─────────────────────────────── */}
      {showWebhookConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowWebhookConfig(false)}>
          <div className="bg-surface-primary rounded-2xl shadow-xl p-6 w-full max-w-md mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Webhook className="h-5 w-5 text-indigo-500" />
              <h3 className="text-lg font-semibold">新增 Webhook</h3>
            </div>
            <p className="text-sm text-muted-foreground">创建一个 Webhook 端点，外部系统可通过 POST 请求自动推送数据到知识库。</p>
            <div className="space-y-1.5">
              <label className="text-[13px] font-medium text-text-secondary">来源名称</label>
              <Input value={newWebhookName} onChange={(e) => setNewWebhookName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                placeholder="例如: zabbix_alert, prometheus_webhook" />
            </div>
            {newWebhookName && (
              <div className="rounded-lg bg-surface-secondary p-3 space-y-2">
                <p className="text-[11px] font-medium text-muted-foreground">Webhook URL</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-[11px] text-text-primary break-all bg-surface-primary rounded px-2 py-1">
                    {window.location.origin}/api/knowledge/webhook/{newWebhookName}
                  </code>
                  <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/api/knowledge/webhook/${newWebhookName}`); toast.success("已复制"); }}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  外部系统向此 URL 发送 POST 请求，body 为 JSON，数据将被自动提炼并存入 llm-wiki v2 知识库。
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowWebhookConfig(false); setNewWebhookName(""); }}>关闭</Button>
              <Button disabled={!newWebhookName} onClick={() => { setShowWebhookConfig(false); setNewWebhookName(""); toast.success(`Webhook "${newWebhookName}" 已创建，可使用复制按钮获取 URL`); }}>
                创建
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload dialog ─────────────────────────────────── */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowUpload(false)}>
          <div className="bg-surface-primary rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">上传文档</h3>
            <form onSubmit={handleUpload} className="space-y-3">
              {upFiles.length === 0 && (
                <textarea value={upContent} onChange={(e) => setUpContent(e.target.value)} placeholder="粘贴文档内容，或选择文件上传" rows={6}
                  className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-interactive-primary/25" />
              )}
              {/* File list */}
              {upFiles.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {upFiles.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px] text-text-secondary bg-surface-secondary rounded-lg px-3 py-1.5">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 truncate">{f.name}</span>
                      <button type="button" onClick={() => setUpFiles((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-status-active shrink-0"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                </div>
              )}
              {/* File picker */}
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[13px] text-text-secondary hover:bg-surface-secondary transition-colors">
                <Upload className="h-3.5 w-3.5" />
                选择文件
                <input type="file" className="hidden" multiple accept=".pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.csv,.json,.html,.py,.js,.ts,.yaml,.yml,.log,.sql" onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) setUpFiles((prev) => [...prev, ...files]);
                  e.target.value = "";
                }} />
              </label>
              <span className="text-[11px] text-muted-foreground ml-1">支持批量选择，单文件最大 10MB</span>
              {/* Progress */}
              {uploading && uploadProgress.total > 1 && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
                    <div className="h-full bg-interactive-primary rounded-full transition-all" style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }} />
                  </div>
                  <span className="text-[11px] text-muted-foreground">{uploadProgress.current}/{uploadProgress.total}</span>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" type="button" onClick={() => setShowUpload(false)}>取消</Button>
                <Button type="submit" disabled={uploading}>{uploading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}{uploading ? "上传中" : "上传"}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Hit test dialog ───────────────────────────────── */}
      {testOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setTestOpen(false)}>
          <div className="bg-surface-primary rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-interactive-primary" />
              <h3 className="text-lg font-semibold">知识命中测试</h3>
            </div>
            <p className="text-sm text-muted-foreground">输入问题，测试 llm-wiki v2 知识库是否能检索到相关知识</p>
            <div className="flex gap-2">
              <Input value={testQuestion} onChange={(e) => setTestQuestion(e.target.value)} placeholder="输入测试问题…" onKeyDown={(e) => e.key === "Enter" && handleTest()} />
              <Button onClick={handleTest} disabled={testing}>{testing ? <Loader2 className="h-4 w-4 animate-spin" /> : "测试"}</Button>
            </div>
            {testResult && (
              <div className={cn("rounded-xl p-4 border", testResult.hit ? "border-status-resolved/20 bg-status-resolved/5" : "border-status-active/20 bg-status-active/5")}>
                <div className="flex items-center gap-2 mb-2">
                  {testResult.hit ? <Check className="h-5 w-5 text-status-resolved" /> : <X className="h-5 w-5 text-status-active" />}
                  <span className={cn("font-semibold", testResult.hit ? "text-status-resolved" : "text-status-active")}>
                    {testResult.hit ? `命中 (置信度: ${(testResult.confidence * 100).toFixed(0)}%)` : "未命中"}
                  </span>
                </div>
                <p className="text-sm text-text-secondary whitespace-pre-wrap">{testResult.answer}</p>
                {testResult.sources.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] font-medium text-muted-foreground mb-1">引用来源:</p>
                    {testResult.sources.map((s, i) => <p key={i} className="text-[11px] text-interactive-primary">• {s}</p>)}
                  </div>
                )}
                {/* Feedback buttons */}
                {feedback === null && (
                  <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">这个结果准确吗？</span>
                    <button type="button" onClick={() => setFeedback("hit")}
                      className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-status-resolved/30 text-status-resolved hover:bg-status-resolved/10 transition-colors">
                      <ThumbsUp className="h-3 w-3" />命中
                    </button>
                    <button type="button" onClick={() => setFeedback("miss")}
                      className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border border-status-active/30 text-status-active hover:bg-status-active/10 transition-colors">
                      <ThumbsDown className="h-3 w-3" />未命中
                    </button>
                  </div>
                )}
                {feedback && (
                  <p className="mt-3 pt-3 border-t border-border/50 text-[11px] text-muted-foreground">
                    {feedback === "hit" ? "✅ 已反馈：命中 — 感谢你的确认" : "⚠️ 已反馈：未命中 — 我们会优化知识库覆盖"}
                  </p>
                )}
              </div>
            )}
            <Button variant="outline" className="w-full" onClick={() => { setTestOpen(false); setTestResult(null); setFeedback(null); }}>关闭</Button>
          </div>
        </div>
      )}
    </div>
  );
}
