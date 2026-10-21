import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  Ban,
  BookOpen,
  CheckCircle,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Loader2,
  PlayCircle,
  RefreshCw,
  Search,
  ThumbsDown,
  ThumbsUp,
  X,
  XCircle,
} from "lucide-react";
import { PermissionGate } from "@/components/auth/permission-gate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  rca,
  reportApi,
  rootCauseApi,
  type QueueStatus,
  type RcaReport,
  type RcaSessionDetail,
  type RcaSessionSummary,
  type RootCauseItem,
} from "@/lib/api";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";

const statusLabel: Record<string, string> = {
  COMPLETED: "完成", FAILED: "失败", RUNNING: "运行中", QUEUED: "排队中",
  completed: "完成", failed: "失败", running: "运行中", queued: "排队中",
};
const labelText: Record<string, string> = { pending: "待确认", confirmed: "已确认", false_positive: "误报" };
const labelVariant: Record<string, "secondary" | "success" | "destructive"> = {
  pending: "secondary",
  confirmed: "success",
  false_positive: "destructive",
};

/** Readable one-liner for report JSON values (never dump a raw JSON blob). */
function reportValueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "summary",
      "title",
      "content",
      "description",
      "detail",
      "message",
      "root_cause",
      "text",
      "name",
      "value",
    ]) {
      const hit = record[key];
      if (typeof hit === "string" && hit.trim()) return hit.trim();
    }
    const pairs = Object.entries(record)
      .filter(([, item]) => item !== null && item !== undefined && typeof item !== "object")
      .slice(0, 3)
      .map(([key, item]) => `${key}: ${String(item)}`);
    if (pairs.length > 0) return pairs.join(" · ");
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

type TabKey = "sessions" | "reports" | "knowledge";

export default function RcaPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { has } = usePermissions();
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    return requested === "reports" || requested === "knowledge" ? requested : "sessions";
  });
  const [sessions, setSessions] = useState<RcaSessionSummary[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<RcaSessionDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [report, setReport] = useState<RcaReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [downloading, setDownloading] = useState<"md" | "html" | null>(null);
  const [libraryDownloading, setLibraryDownloading] = useState<string | null>(null);

  // `/rca?status=running` 的初始筛选（仅接受后端枚举值；非法值按“全部”处理）。
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const raw = (searchParams.get("status") || "").trim().toUpperCase();
    return ["QUEUED", "RUNNING", "COMPLETED", "FAILED"].includes(raw) ? raw : "";
  });
  const [cancelTarget, setCancelTarget] = useState<RcaSessionSummary | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // 终止/重新分析按 `rca_terminate` 权限位显隐（权限接口不可用时权限集为空，按钮隐藏）。
  const canTerminate = has("rca_terminate");

  const [reports, setReports] = useState<RcaReport[]>([]);
  const [reportSearch, setReportSearch] = useState("");
  const [reportsLoading, setReportsLoading] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState<"md" | "html" | null>(null);

  const [cases, setCases] = useState<RootCauseItem[]>([]);
  const [caseSearch, setCaseSearch] = useState("");
  const [casesLoading, setCasesLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([rca.list(1, 50, statusFilter || undefined), rca.queue()])
      .then(([s, q]) => { setSessions(s.items); setQueue(q); })
      .catch(() => toast.error("加载 RCA 数据失败"))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const sid = searchParams.get("s");
    if (sid) void openDetail(Number(sid), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // QUEUED/RUNNING 会话每 5s 轮询详情（仅页面可见时）。进入终态后停止并刷新列表。
  useEffect(() => {
    if (!detailOpen || !detail) return;
    const sid = detail.id;
    const status = detail.status?.toUpperCase();
    if (status !== "QUEUED" && status !== "RUNNING") return;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await rca.detail(sid);
        if (cancelled) return;
        setDetail(next);
        const nextStatus = next.status?.toUpperCase();
        if (nextStatus !== "QUEUED" && nextStatus !== "RUNNING") {
          if (timer) window.clearInterval(timer);
          refresh();
          if (nextStatus === "COMPLETED") {
            setReportLoading(true);
            rca.report(sid)
              .then((r) => { if (!cancelled) setReport(r); })
              .catch(() => { if (!cancelled) setReport(null); })
              .finally(() => { if (!cancelled) setReportLoading(false); });
          }
        }
      } catch {
        // 网络抖动不应终止轮询；下一拍会重试。
      }
    };

    timer = window.setInterval(() => void tick(), 5000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailOpen, detail?.id, detail?.status, refresh]);

  // 详情抽屉未打开但列表里仍有 QUEUED/RUNNING 会话时，同样每 5s 刷新列表。
  useEffect(() => {
    if (detailOpen) return;
    const hasActive = sessions.some((s) => {
      const st = s.status?.toUpperCase();
      return st === "QUEUED" || st === "RUNNING";
    });
    if (!hasActive) return;

    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const [next, q] = await Promise.all([
          rca.list(1, 50, statusFilter || undefined),
          rca.queue(),
        ]);
        if (cancelled) return;
        setSessions(next.items);
        setQueue(q);
      } catch {
        // 网络抖动不应终止轮询。
      }
    };

    timer = window.setInterval(() => void tick(), 5000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailOpen, sessions, statusFilter]);

  useEffect(() => {
    if (tab === "reports") void loadReports();
    if (tab === "knowledge") void loadCases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function loadReports() {
    setReportsLoading(true);
    try {
      const res = await rca.reports({ page: 1, page_size: 50, search: reportSearch || undefined });
      setReports(res.items);
      setSelectedSessions(new Set());
    } catch {
      toast.error("加载报告库失败");
    } finally {
      setReportsLoading(false);
    }
  }

  async function loadCases() {
    setCasesLoading(true);
    try {
      const res = await rootCauseApi.list({ page: 1, page_size: 50, search: caseSearch || undefined });
      setCases(res.items);
    } catch {
      toast.error("加载根因知识库失败");
    } finally {
      setCasesLoading(false);
    }
  }

  async function openDetail(sid: number, syncUrl = true) {
    if (syncUrl) {
      // 保留当前 status 筛选，避免打开详情后把入口条件丢掉。
      const next: Record<string, string> = { s: String(sid) };
      if (statusFilter) next.status = statusFilter.toLowerCase();
      setSearchParams(next);
    }
    setReport(null);
    try {
      const d = await rca.detail(sid);
      setDetail(d);
      setDetailOpen(true);
      if (d.service_name) {
        rootCauseApi.list({ page: 1, page_size: 50, service: d.service_name })
          .then((r) => setCases(r.items))
          .catch(() => {});
      }
      if (d.status?.toUpperCase() === "COMPLETED") {
        setReportLoading(true);
        rca.report(sid).then(setReport).catch(() => setReport(null)).finally(() => setReportLoading(false));
      }
    } catch {
      toast.error("加载详情失败");
    }
  }

  function updateStatusFilter(next: string) {
    setStatusFilter(next);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next) params.set("status", next.toLowerCase());
      else params.delete("status");
      return params;
    }, { replace: true });
  }

  function changeTab(next: TabKey) {
    setTab(next);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete("s");
      if (next === "sessions") params.delete("tab");
      else params.set("tab", next);
      return params;
    }, { replace: true });
  }

  function closeDetail() {
    setDetailOpen(false);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete("s");
      return params;
    }, { replace: true });
  }

  async function confirmCancel() {
    const target = cancelTarget;
    if (!target) return;
    setCancelling(true);
    try {
      const res = await rca.cancel(target.id);
      toast.success(
        res.hermes_stopped
          ? "已终止分析，并请求 Hermes 停止上游任务"
          : "已终止分析",
      );
      setCancelTarget(null);
      if (detail?.id === target.id) {
        // 抽屉保持打开，刷新为终态并展示「手动终止」时间线事件。
        try {
          setDetail(await rca.detail(target.id));
        } catch {
          setDetail((prev) => (prev ? { ...prev, status: "FAILED" } : prev));
        }
      }
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "终止失败");
      // 409（会话已结束）等情况下列表可能已过期，顺手刷新一次。
      refresh();
    } finally {
      setCancelling(false);
    }
  }

  async function rerun(sid: number) {
    try {
      await rca.rerun(sid);
      toast.success("已重新加入分析队列");
      setDetail((prev) => (prev ? { ...prev, status: "QUEUED" } : prev));
      setTimeout(refresh, 800);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新分析失败");
    }
  }

  // Blob + object URL keeps the bearer token out of the URL (an <a href>
  // cannot attach an Authorization header).
  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadReport(sid: number, format: "md" | "html") {
    setDownloading(format);
    try {
      const { blob, filename } = await reportApi.download(sid, format);
      saveBlob(blob, filename);
      toast.success(format === "md" ? "Markdown 报告开始下载" : "HTML 报告开始下载");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下载报告失败");
    } finally {
      setDownloading(null);
    }
  }

  // Report-library rows download directly from the list; keep the busy key
  // per-row so only the active file shows a spinner.
  async function downloadLibraryReport(sid: number, format: "md" | "html") {
    const key = `${sid}:${format}`;
    setLibraryDownloading(key);
    try {
      const { blob, filename } = await reportApi.download(sid, format);
      saveBlob(blob, filename);
      toast.success(format === "md" ? "Markdown 报告开始下载" : "HTML 报告开始下载");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下载报告失败");
    } finally {
      setLibraryDownloading(null);
    }
  }

  function toggleReport(sessionId: number) {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleAllReports() {
    setSelectedSessions((prev) =>
      prev.size === reports.length ? new Set() : new Set(reports.map((r) => r.session_id)),
    );
  }

  async function exportReports(format: "md" | "html") {
    const ids = reports
      .filter((r) => selectedSessions.has(r.session_id))
      .map((r) => r.session_id);
    if (ids.length === 0) return;

    setExporting(format);
    try {
      const { blob, filename, skipped } = await reportApi.exportZip(ids, format);
      saveBlob(blob, filename);
      const label = format === "md" ? "Markdown" : "HTML";
      const exported = ids.length - skipped;
      if (exported > 0) toast.success(`已导出 ${exported} 份 ${label} 报告`);
      if (skipped > 0) toast.warning(`${skipped} 份报告被跳过，详见压缩包内 README.txt`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批量导出失败");
    } finally {
      setExporting(null);
    }
  }

  async function annotate(item: RootCauseItem, label: "confirmed" | "false_positive") {
    try {
      await rootCauseApi.label(item.id, label);
      toast.success(label === "confirmed" ? "已标记为确认根因" : "已标记为误报");
      await loadCases();
    } catch {
      toast.error("标注失败");
    }
  }

  const isCompleted = (status?: string | null) => status?.toUpperCase() === "COMPLETED";
  const isFailed = (status?: string | null) => status?.toUpperCase() === "FAILED";
  const isActive = (status?: string | null) => {
    const normalized = status?.toUpperCase();
    return normalized === "QUEUED" || normalized === "RUNNING";
  };
  const detailReportCase = report ? cases.find((c) => c.session_id === report.session_id) : undefined;
  const allReportsSelected = reports.length > 0 && selectedSessions.size === reports.length;
  const someReportsSelected = selectedSessions.size > 0 && !allReportsSelected;

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">RCA 分析</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            告警自动触发记录 · 活跃 {queue?.active_count ?? "—"} · 排队 {queue?.queued_count ?? "—"}
          </p>
        </div>
        <Button variant="ghostMuted" size="icon-sm" onClick={refresh} aria-label="刷新"><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {!loading && (queue || sessions.length > 0) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "活跃中", value: queue?.active_count ?? 0, icon: PlayCircle, color: "text-interactive-primary", bg: "bg-interactive-primary/10" },
            { label: "排队中", value: queue?.queued_count ?? 0, icon: Clock, color: "text-amber-600", bg: "bg-amber-50" },
            { label: "已完成", value: sessions.filter((s) => isCompleted(s.status)).length, icon: CheckCircle, color: "text-status-resolved", bg: "bg-status-resolved/10" },
            { label: "失败", value: sessions.filter((s) => isFailed(s.status)).length, icon: XCircle, color: "text-status-active", bg: "bg-status-active/10" },
          ].map((s) => (
            <Card key={s.label}><CardContent className="p-3 flex items-center gap-3">
              <div className={`shrink-0 h-9 w-9 rounded-lg ${s.bg} flex items-center justify-center`}><s.icon className={`h-4 w-4 ${s.color}`} /></div>
              <div><p className="text-lg font-bold text-text-primary">{s.value}</p><p className="text-[11px] text-muted-foreground">{s.label}</p></div>
            </CardContent></Card>
          ))}
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => changeTab(String(v) as TabKey)}>
        <TabsList>
          <TabsTrigger value="sessions">分析会话</TabsTrigger>
          <TabsTrigger value="reports">报告库</TabsTrigger>
          <TabsTrigger value="knowledge">根因知识库</TabsTrigger>
        </TabsList>

        {/* ── Sessions ────────────────────────────────────────── */}
        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2"><Activity className="h-4 w-4" /> 分析会话（含告警自动触发）</CardTitle>
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="按状态筛选会话">
                  {[
                    { value: "", label: "全部" },
                    { value: "RUNNING", label: "运行中" },
                    { value: "QUEUED", label: "排队中" },
                    { value: "COMPLETED", label: "已完成" },
                    { value: "FAILED", label: "失败" },
                  ].map((option) => (
                    <Button
                      key={option.value || "all"}
                      variant={statusFilter === option.value ? "secondary" : "ghostMuted"}
                      size="xs"
                      aria-pressed={statusFilter === option.value}
                      onClick={() => updateStatusFilter(option.value)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  {statusFilter
                    ? "当前筛选下暂无 RCA 会话，可切换「全部」查看。"
                    : "暂无 RCA 会话。告警命中触发策略后会自动进入这里。"}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left px-4 py-2 font-medium">ID</th>
                    <th className="text-left px-4 py-2 font-medium">服务</th>
                    <th className="text-left px-4 py-2 font-medium">触发</th>
                    <th className="text-left px-4 py-2 font-medium">状态</th>
                    <th className="text-left px-4 py-2 font-medium">根因</th>
                    <th className="text-left px-4 py-2 font-medium">时间</th>
                    <th className="text-right px-4 py-2 font-medium">操作</th>
                  </tr></thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id} className="border-b border-border/50 hover:bg-muted/50">
                        <td className="px-4 py-2.5 font-mono text-xs">#{s.id}</td>
                        <td className="px-4 py-2.5 text-xs">{s.service_name || "—"}</td>
                        <td className="px-4 py-2.5 text-xs">
                          <Badge variant="secondary" className="text-[10px]">{s.trigger_type === "PASSIVE" ? "告警" : "人工"}</Badge>
                          {s.alert_count ? <span className="ml-1.5 text-muted-foreground">{s.alert_count} 条</span> : null}
                        </td>
                        <td className="px-4 py-2.5"><Badge variant={isCompleted(s.status) ? "success" : isFailed(s.status) ? "destructive" : s.status?.toUpperCase() === "RUNNING" ? "info" : "secondary"} className="text-[11px]">{statusLabel[s.status] || s.status}</Badge></td>
                        <td className="px-4 py-2.5 max-w-xs truncate">{s.root_cause_summary || "—"}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{s.created_at ? new Date(s.created_at).toLocaleString() : ""}</td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <Button variant="ghostMuted" size="icon-sm" onClick={() => void openDetail(s.id)} aria-label={`查看会话 #${s.id} 详情`}><Eye className="h-3.5 w-3.5" /></Button>
                          {canTerminate && isActive(s.status) && (
                            <Button
                              variant="ghostMuted"
                              size="sm"
                              className="text-status-active"
                              title="终止分析"
                              aria-label={`终止会话 #${s.id}`}
                              onClick={() => setCancelTarget(s)}
                            >
                              <Ban className="h-3.5 w-3.5" /> 终止
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Reports ─────────────────────────────────────────── */}
        <TabsContent value="reports">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2"><BookOpen className="h-4 w-4" /> RCA 报告库</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">已选 {selectedSessions.size} 项</span>
                  <PermissionGate perm="report_export">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={selectedSessions.size === 0 || exporting !== null}
                      onClick={() => void exportReports("md")}
                    >
                      <Download className="h-3.5 w-3.5 mr-1" /> {exporting === "md" ? "导出中…" : "导出 Markdown"}
                    </Button>
                  </PermissionGate>
                  <PermissionGate perm="report_export">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={selectedSessions.size === 0 || exporting !== null}
                      onClick={() => void exportReports("html")}
                    >
                      <Download className="h-3.5 w-3.5 mr-1" /> {exporting === "html" ? "导出中…" : "导出 HTML"}
                    </Button>
                  </PermissionGate>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={reportSearch}
                      onChange={(e) => setReportSearch(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void loadReports(); }}
                      placeholder="搜索根因 / 服务"
                      className="h-8 w-48 pl-7 text-xs"
                    />
                  </div>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void loadReports()}>搜索</Button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                点击「查看」进入独立报告页在线阅读根因、证据、处置建议与时间线；下载保留用于归档或分享。
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {reportsLoading ? (
                <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : reports.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">暂无报告（需 Hermes 配置完成并成功分析一次）</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                  <thead><tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="w-10 px-4 py-2 font-medium">
                      <input
                        type="checkbox"
                        aria-label="全选报告"
                        className="h-3.5 w-3.5 accent-interactive-primary align-middle"
                        checked={allReportsSelected}
                        ref={(el) => { if (el) el.indeterminate = someReportsSelected; }}
                        onChange={toggleAllReports}
                        disabled={reports.length === 0}
                      />
                    </th>
                    <th className="text-left px-4 py-2 font-medium">时间</th>
                    <th className="text-left px-4 py-2 font-medium">服务</th>
                    <th className="text-left px-4 py-2 font-medium">分类</th>
                    <th className="text-left px-4 py-2 font-medium">根因</th>
                    <th className="text-left px-4 py-2 font-medium">置信度</th>
                    <th className="text-right px-4 py-2 font-medium">操作</th>
                  </tr></thead>
                  <tbody>
                    {reports.map((r) => (
                      <tr key={r.id} className={`border-b border-border/50 hover:bg-muted/50 ${selectedSessions.has(r.session_id) ? "bg-muted/40" : ""}`}>
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            aria-label={`选择报告 #${r.session_id}`}
                            className="h-3.5 w-3.5 accent-interactive-primary align-middle"
                            checked={selectedSessions.has(r.session_id)}
                            onChange={() => toggleReport(r.session_id)}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-xs">{r.service_name || "—"}</td>
                        <td className="px-4 py-2.5 text-xs">{r.category || "—"}</td>
                        <td className="px-4 py-2.5 max-w-xs">
                          <div className="truncate">{r.root_cause || "—"}</div>
                          {r.top3 && r.top3.length > 0 && (
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={r.top3.join("\n")}>
                              Top3 · {r.top3[0]}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs">{r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "—"}</td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              onClick={() => navigate(`/rca/report/${r.session_id}`)}
                              aria-label={`查看报告 #${r.session_id}`}
                              title={`查看报告 #${r.session_id}`}
                            >
                              <Eye className="h-3.5 w-3.5" /> 查看
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={libraryDownloading !== null}
                              onClick={() => void downloadLibraryReport(r.session_id, "md")}
                              aria-label={`下载报告 #${r.session_id} 的 Markdown`}
                              title="下载 Markdown"
                            >
                              {libraryDownloading === `${r.session_id}:md` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Download className="h-3 w-3" />
                              )}
                              MD
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={libraryDownloading !== null}
                              onClick={() => void downloadLibraryReport(r.session_id, "html")}
                              aria-label={`下载报告 #${r.session_id} 的 HTML`}
                              title="下载 HTML"
                            >
                              {libraryDownloading === `${r.session_id}:html` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Download className="h-3 w-3" />
                              )}
                              HTML
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Knowledge ───────────────────────────────────────── */}
        <TabsContent value="knowledge">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2"><BookOpen className="h-4 w-4" /> 根因知识库（L1 检索增强）</CardTitle>
                <div className="flex items-center gap-2">
                  <Input
                    value={caseSearch}
                    onChange={(e) => setCaseSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void loadCases(); }}
                    placeholder="搜索服务 / 根因"
                    className="h-8 w-48 text-xs"
                  />
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void loadCases()}>搜索</Button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">RCA 完成后自动沉淀为待确认候选；确认/误报结果会在下次分析时作为参考案例注入提示词。</p>
            </CardHeader>
            <CardContent className="p-0">
              {casesLoading ? (
                <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : cases.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">暂无根因条目</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left px-4 py-2 font-medium">服务</th>
                    <th className="text-left px-4 py-2 font-medium">类型</th>
                    <th className="text-left px-4 py-2 font-medium">根因</th>
                    <th className="text-left px-4 py-2 font-medium">标注</th>
                    <th className="text-right px-4 py-2 font-medium">操作</th>
                  </tr></thead>
                  <tbody>
                    {cases.map((c) => (
                      <tr key={c.id} className="border-b border-border/50 hover:bg-muted/50">
                        <td className="px-4 py-2.5 text-xs">{c.service_name || "—"}</td>
                        <td className="px-4 py-2.5 text-xs">{c.alert_type || "—"}</td>
                        <td className="px-4 py-2.5 max-w-md line-clamp-2 text-xs">{c.root_cause || "—"}</td>
                        <td className="px-4 py-2.5"><Badge variant={labelVariant[c.label] || "secondary"} className="text-[10px]">{labelText[c.label] || c.label}</Badge></td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <PermissionGate perm="kb_annotate">
                            <Button variant="ghostMuted" size="icon-sm" title="确认根因" onClick={() => void annotate(c, "confirmed")}><ThumbsUp className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghostMuted" size="icon-sm" title="标记误报" onClick={() => void annotate(c, "false_positive")}><ThumbsDown className="h-3.5 w-3.5" /></Button>
                          </PermissionGate>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Detail drawer ─────────────────────────────────────── */}
      <Sheet open={detailOpen} onOpenChange={(o) => { if (!o) closeDetail(); }}>
        <SheetContent side="right" className="w-[560px] sm:max-w-[560px] p-0 overflow-y-auto">
          {detail ? (
            <>
              <SheetHeader className="border-b border-border">
                <SheetTitle className="flex items-center justify-between">
                  <span>RCA #{detail.id} · {detail.service_name || "—"}</span>
                  <Badge variant={isCompleted(detail.status) ? "success" : isFailed(detail.status) ? "destructive" : "secondary"}>
                    {statusLabel[detail.status] || detail.status}
                  </Badge>
                </SheetTitle>
              </SheetHeader>
              <div className="p-4 space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-muted-foreground">触发方式：</span>{detail.trigger_type === "PASSIVE" ? "告警触发" : "人工触发"}</div>
                  <div><span className="text-muted-foreground">告警数：</span>{detail.alert_count ?? 1}</div>
                  <div className="col-span-2"><span className="text-muted-foreground">触发原因：</span>{detail.trigger_reason || "—"}</div>
                  <div className="col-span-2"><span className="text-muted-foreground">分析窗口：</span>
                    {detail.time_window_start ? new Date(detail.time_window_start).toLocaleString() : "—"} ~ {detail.time_window_end ? new Date(detail.time_window_end).toLocaleString() : "—"}
                  </div>
                </div>

                {reportLoading && <Skeleton className="h-32 w-full" />}

                {report && (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-border p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-muted-foreground">根因结论</p>
                        <span className="text-[11px] text-muted-foreground">
                          置信度 {report.confidence != null ? `${Math.round(report.confidence * 100)}%` : "—"}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed">{report.root_cause || "—"}</p>
                      {report.impacted_services.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {report.impacted_services.map((s, i) => <Badge key={i} variant="outline" className="text-[10px]">{String(s)}</Badge>)}
                        </div>
                      )}
                    </div>

                    {report.top3 && report.top3.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">Top3 根因</p>
                        <ol className="space-y-1 text-xs list-decimal pl-4">
                          {report.top3.map((t, i) => <li key={i}>{t}</li>)}
                        </ol>
                      </div>
                    )}

                    {report.evidence.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">证据链</p>
                        <ul className="space-y-1 text-xs">
                          {report.evidence.map((e, i) => <li key={i} className="rounded bg-muted/50 px-2 py-1.5">{reportValueText(e)}</li>)}
                        </ul>
                      </div>
                    )}

                    {report.recommended_actions.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">处置建议</p>
                        <ul className="space-y-1 text-xs list-disc pl-4">
                          {report.recommended_actions.map((a, i) => <li key={i}>{reportValueText(a)}</li>)}
                        </ul>
                      </div>
                    )}

                    {report.alerts && report.alerts.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1.5">关联告警（{report.alerts.length}）</p>
                        <ul className="space-y-1 text-xs">
                          {report.alerts.map((a) => (
                            <li key={a.id} className="rounded border border-border/60 px-2 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[10px] text-muted-foreground">{a.alert_uid}</span>
                                <Badge variant="outline" className="text-[10px]">{a.ci_application || a.ci_name || "—"}</Badge>
                              </div>
                              <p className="mt-1 line-clamp-2">{a.content}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex flex-wrap justify-end gap-2 pt-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => navigate(`/rca/report/${detail.id}`)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> 查看完整报告
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={downloading !== null}
                        onClick={() => void downloadReport(detail.id, "md")}
                      >
                        <Download className="h-3.5 w-3.5" /> 下载 Markdown
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={downloading !== null}
                        onClick={() => void downloadReport(detail.id, "html")}
                      >
                        <Download className="h-3.5 w-3.5" /> 下载 HTML
                      </Button>
                      {detailReportCase && detailReportCase.label === "pending" && (
                        <PermissionGate perm="kb_annotate">
                          <Button variant="outline" size="sm" onClick={() => void annotate(detailReportCase, "false_positive")}>
                            <ThumbsDown className="h-3.5 w-3.5" /> 标记误报
                          </Button>
                          <Button size="sm" onClick={() => void annotate(detailReportCase, "confirmed")}>
                            <ThumbsUp className="h-3.5 w-3.5" /> 确认根因
                          </Button>
                        </PermissionGate>
                      )}
                      <PermissionGate perm="rca_terminate">
                        <Button variant="outline" size="sm" onClick={() => void rerun(detail.id)}>
                          <RefreshCw className="h-3.5 w-3.5" /> 重新分析
                        </Button>
                      </PermissionGate>
                    </div>
                  </div>
                )}

                {detail.timeline.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">分析时间线</p>
                    <div className="space-y-1.5">
                      {detail.timeline.map((t, i) => (
                        <div key={i} className="flex gap-2 text-xs">
                          <span className="text-muted-foreground w-16 shrink-0">
                            {new Date(t.created_at || t.timestamp || Date.now()).toLocaleTimeString()}
                          </span>
                          <span>{t.content || t.event || t.detail || t.event_type}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {canTerminate && isActive(detail.status) && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-xs text-muted-foreground">
                      终止后会话立即结束；若已提交 Hermes，会尽力停止上游任务。
                    </p>
                    <Button variant="destructive" size="sm" onClick={() => setCancelTarget(detail)}>
                      <Ban className="h-3.5 w-3.5" /> 终止分析
                    </Button>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button variant="ghostMuted" size="sm" onClick={closeDetail}>
                    <X className="h-3.5 w-3.5" /> 关闭
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="p-4"><Skeleton className="h-40 w-full" /></div>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => { if (!open && !cancelling) setCancelTarget(null); }}
        title="终止 RCA 分析"
        description={cancelTarget
          ? `确定要终止会话 #${cancelTarget.id}（${cancelTarget.service_name || "未知服务"}）吗？终止后状态将变为「失败」，且不可恢复。`
          : ""}
        confirmLabel="终止"
        variant="destructive"
        isLoading={cancelling}
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelTarget(null)}
      />
    </div>
  );
}
