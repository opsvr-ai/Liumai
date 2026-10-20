import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Ban,
  BellRing,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  FileText,
  Loader2,
  MessageCircle,
  RefreshCw,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { rca, reportApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { toast } from "sonner";

/* ==========================================================================
 *  事件作战室 — /incidents/:kind/:id
 *
 *  单次事件（告警 / RCA 会话 / 报告）的只读聚合视图：一页看全上下文并直接
 *  行动。数据来自 GET /api/incidents/{kind}/{id}；详情请求在页面内 fetch
 *  （Authorization 头），写操作复用现有 rca.rerun / rca.cancel / 报告下载，
 *  不新增 api.ts 方法。运行中的会话每 5 秒静默刷新时间线。
 * ========================================================================== */

type IncidentKind = "alert" | "rca" | "report";

type BadgeVariant =
  | "destructive"
  | "active"
  | "investigating"
  | "secondary"
  | "outline"
  | "info"
  | "success";

interface DetailAlert {
  id: number;
  uid: string | null;
  severity: string | null;
  content: string | null;
  time: string | null;
}

interface RcaSummary {
  session_id: number;
  status: string;
  trigger_reason: string | null;
  root_cause: string | null;
  confidence: number | null;
  top3: string[];
  evidence: unknown[];
  recommended_actions: unknown[];
}

interface TimelineEntry {
  at: string;
  type: string;
  content: string | null;
}

interface IncidentAction {
  key: string;
  label: string;
  enabled: boolean;
  reason?: string | null;
}

interface RelatedItem {
  /** 复合 id：alert-12 / rca-34 / report-56（与事件中心一致）。 */
  id: string;
  title: string;
  status: string;
  created_at: string;
}

interface IncidentDetail {
  kind: IncidentKind;
  id: number;
  title: string;
  service: string | null;
  severity: string | null;
  status: string;
  created_at: string;
  time_window: { start: string | null; end: string | null } | null;
  alerts: DetailAlert[];
  rca: RcaSummary | null;
  timeline: TimelineEntry[];
  report: { available: boolean; download: { md: string | null; html: string | null } };
  actions: IncidentAction[];
  related: RelatedItem[];
}

const TOKEN_KEY = "liumai_token";
const FOLLOW_PREFIX = "liumai_incident_follow";
const POLL_MS = 5000;

const KIND_LABEL: Record<IncidentKind, string> = {
  alert: "告警",
  rca: "RCA 会话",
  report: "报告",
};

const KIND_VARIANT: Record<IncidentKind, BadgeVariant> = {
  alert: "secondary",
  rca: "info",
  report: "success",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  triggered: "已触发",
  coalesced: "已合并",
  filtered: "已过滤",
  dismissed: "已忽略",
  QUEUED: "排队中",
  RUNNING: "运行中",
  COMPLETED: "已完成",
  FAILED: "失败",
};

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: "investigating",
  triggered: "success",
  coalesced: "info",
  filtered: "outline",
  dismissed: "outline",
  QUEUED: "investigating",
  RUNNING: "info",
  COMPLETED: "success",
  FAILED: "destructive",
};

const SEVERITY_VARIANT: Record<string, BadgeVariant> = {
  严重: "destructive",
  重要: "active",
  一般: "investigating",
  告警: "secondary",
  提示: "outline",
};

const EVENT_TYPE_LABEL: Record<string, string> = {
  GROUP_CREATED: "协作群创建",
  MEMBER_JOINED: "成员加入",
  AGENT_PROGRESS: "分析进展",
  MANUAL_FINDING: "人工发现",
  BOT_MENTIONED: "机器人提及",
  RCA_COMPLETED: "分析完成",
};

function statusVariant(status: string): BadgeVariant {
  return STATUS_VARIANT[status] ?? (status ? "outline" : "secondary");
}

function severityVariant(severity: string): BadgeVariant {
  return SEVERITY_VARIANT[severity] ?? "secondary";
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function fmtWindow(
  window: { start: string | null; end: string | null } | null,
): string {
  if (!window || (!window.start && !window.end)) return "—";
  return `${fmtTime(window.start)} ~ ${fmtTime(window.end)}`;
}

function parseKind(value: string | undefined): IncidentKind | null {
  return value === "alert" || value === "rca" || value === "report" ? value : null;
}

/** 把任意 JSON 字段渲染成一行文本（证据 / 处置建议可能是对象）。 */
function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

function confidencePercent(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function relatedPath(compositeId: string): string {
  const match = /^(alert|rca|report)-(\d+)$/.exec(compositeId);
  return match ? `/incidents/${match[1]}/${match[2]}` : "/incidents";
}

function relatedKind(compositeId: string): IncidentKind | null {
  const match = /^(alert|rca|report)-(\d+)$/.exec(compositeId);
  return match ? (match[1] as IncidentKind) : null;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Page-local fetch: no api.ts change, bearer token stays in a header. */
async function fetchIncidentDetail(
  kind: IncidentKind,
  id: number,
): Promise<IncidentDetail> {
  const headers: Record<string, string> = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api/incidents/${kind}/${id}`, { headers });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("liumai_user");
    localStorage.removeItem("liumai_role");
    localStorage.removeItem("liumai_auth_type");
    if (window.location.pathname !== "/login") window.location.href = "/login";
    throw new Error("登录已过期，请重新登录");
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let message = "";
    try {
      const parsed = JSON.parse(raw) as { detail?: unknown };
      if (typeof parsed.detail === "string") message = parsed.detail;
    } catch {
      // Non-JSON body — fall back to the status line below.
    }
    if (res.status === 404) message = message || "事件不存在或无权访问";
    throw new Error(message || `加载事件失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as IncidentDetail;
}

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

function EmptyHint({ children }: { children: string }) {
  return <p className="py-4 text-center text-xs text-muted-foreground">{children}</p>;
}

export default function IncidentWorkspacePage() {
  const navigate = useNavigate();
  const { kind: rawKind, id: rawId } = useParams<{ kind: string; id: string }>();

  const kind = parseKind(rawKind);
  const incidentId = Number.parseInt(rawId ?? "", 10);
  const valid = kind !== null && Number.isFinite(incidentId) && incidentId > 0;

  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [downloading, setDownloading] = useState<"md" | "html" | null>(null);
  const [confirmAction, setConfirmAction] = useState<"rerun" | "cancel" | null>(null);
  const [acting, setActing] = useState(false);
  const [followed, setFollowed] = useState(false);
  const requestSeq = useRef(0);

  const followKey = valid ? `${FOLLOW_PREFIX}:${kind}:${incidentId}` : "";

  const load = useCallback(
    async (silent = false) => {
      if (!valid || kind === null) return;
      const seq = ++requestSeq.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetchIncidentDetail(kind, incidentId);
        if (seq !== requestSeq.current) return;
        setDetail(res);
        setError(null);
        setLastUpdated(new Date());
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : "加载事件失败");
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [incidentId, kind, valid],
  );

  // 路由参数变化时先回到加载态，避免闪现上一个事件的内容。
  useEffect(() => {
    setDetail(null);
    setError(null);
    setLastUpdated(null);
  }, [kind, incidentId]);

  useEffect(() => {
    if (!valid) {
      setLoading(false);
      return;
    }
    void load();
  }, [valid, load]);

  // 「已关注」只落 localStorage（不写后端），随事件切换重新读取。
  useEffect(() => {
    if (!followKey) {
      setFollowed(false);
      return;
    }
    try {
      setFollowed(localStorage.getItem(followKey) === "1");
    } catch {
      setFollowed(false);
    }
  }, [followKey]);

  // 运行中的会话每 5 秒静默刷新；终态 / 告警不轮询。
  const isRunning =
    detail?.status === "RUNNING" || detail?.rca?.status === "RUNNING";

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      void load(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, load]);

  async function downloadReport(format: "md" | "html") {
    const sessionId = detail?.rca?.session_id;
    if (!sessionId) return;
    setDownloading(format);
    try {
      const { blob, filename } = await reportApi.download(sessionId, format);
      saveBlob(blob, filename);
      toast.success(format === "md" ? "Markdown 报告开始下载" : "HTML 报告开始下载");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下载报告失败");
    } finally {
      setDownloading(null);
    }
  }

  async function performConfirmed() {
    const sessionId = detail?.rca?.session_id;
    if (!sessionId || !confirmAction) return;
    setActing(true);
    try {
      if (confirmAction === "rerun") {
        await rca.rerun(sessionId);
        toast.success("已提交重新分析");
      } else {
        const res = await rca.cancel(sessionId);
        toast.success(
          res.hermes_stopped
            ? "已终止分析，并请求 Hermes 停止上游任务"
            : "已终止分析",
        );
      }
      setConfirmAction(null);
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setActing(false);
    }
  }

  async function copySummary() {
    if (!detail) return;
    const info = detail.rca;
    const lines = [
      `事件：${detail.title}`,
      `类型：${KIND_LABEL[detail.kind]}｜服务：${detail.service || "—"}｜级别：${
        detail.severity || "—"
      }｜状态：${statusLabel(detail.status)}`,
      `时间窗：${fmtWindow(detail.time_window)}`,
      info?.root_cause ? `根因：${info.root_cause}` : "",
      info?.top3.length ? `Top3：${info.top3.join("；")}` : "",
      info?.recommended_actions.length
        ? `处置建议：${info.recommended_actions.map(toText).filter(Boolean).join("；")}`
        : "",
    ].filter(Boolean);
    const ok = await copyText(lines.join("\n"));
    if (ok) toast.success("事件摘要已复制");
    else toast.error("复制失败，请手动选择文本");
  }

  function openChat() {
    if (!detail) return;
    if (!detail.service) {
      navigate("/chat");
      return;
    }
    const prompt = `请分析服务「${detail.service}」的事件「${detail.title}」，结合告警与 RCA 结论给出根因与处置建议。`;
    navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  }

  function toggleFollow() {
    const next = !followed;
    setFollowed(next);
    try {
      if (next) localStorage.setItem(followKey, "1");
      else localStorage.removeItem(followKey);
    } catch {
      // localStorage 不可用时只保留本次会话状态。
    }
    toast.success(next ? "已标记关注（仅保存在本机）" : "已取消关注");
  }

  function renderAction(action: IncidentAction) {
    const disabled =
      !action.enabled ||
      acting ||
      (downloading !== null && action.key.startsWith("download_"));

    let icon: ReactNode = null;
    let variant: "default" | "outline" | "destructive" = "outline";
    switch (action.key) {
      case "rerun":
        icon = <RefreshCw className="h-3.5 w-3.5" />;
        variant = "default";
        break;
      case "cancel":
        icon = <Ban className="h-3.5 w-3.5" />;
        variant = "destructive";
        break;
      case "download_md":
      case "download_html":
        icon =
          downloading === (action.key === "download_md" ? "md" : "html") ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          );
        break;
      case "open_rca":
        icon = <ArrowUpRight className="h-3.5 w-3.5" />;
        break;
      case "open_alerts":
        icon = <BellRing className="h-3.5 w-3.5" />;
        break;
      default:
        icon = <ArrowUpRight className="h-3.5 w-3.5" />;
    }

    function handle() {
      if (!action.enabled || !detail) return;
      switch (action.key) {
        case "open_rca":
          if (detail.rca) navigate(`/rca?s=${detail.rca.session_id}`);
          break;
        case "open_alerts":
          navigate("/alerts");
          break;
        case "download_md":
          void downloadReport("md");
          break;
        case "download_html":
          void downloadReport("html");
          break;
        case "rerun":
        case "cancel":
          setConfirmAction(action.key);
          break;
        default:
          break;
      }
    }

    return (
      <span key={action.key} title={action.reason || undefined}>
        <Button
          variant={variant}
          size="sm"
          disabled={disabled}
          onClick={handle}
          aria-label={action.label}
        >
          {icon}
          {action.label}
        </Button>
      </span>
    );
  }

  if (!valid) {
    return (
      <div className="mx-auto max-w-3xl p-4 md:p-6">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle className="h-8 w-8 text-status-active" />
            <p className="text-sm text-status-active">无效的事件地址</p>
            <p className="text-xs text-muted-foreground">
              地址应为 /incidents/alert|rca|report/&lt;id&gt;
            </p>
            <Button variant="outline" onClick={() => navigate("/incidents")}>
              返回事件中心
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
      {/* ── Toolbar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghostMuted"
          size="sm"
          onClick={() => navigate("/incidents")}
        >
          <ArrowLeft className="h-4 w-4" /> 事件中心
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {refreshing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {lastUpdated && <span>更新于 {lastUpdated.toLocaleTimeString()}</span>}
          <Button
            variant="ghostMuted"
            size="icon-sm"
            onClick={() => void load(true)}
            aria-label="刷新事件"
            title="刷新"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {loading && !detail ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-72 w-full rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : !detail ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertTriangle className="h-8 w-8 text-status-active" />
            <p className="text-sm text-status-active">
              {error || "事件不存在或无权访问"}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate("/incidents")}>
                返回事件中心
              </Button>
              <Button onClick={() => void load()}>重试</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Header ─────────────────────────────────────── */}
          <Card>
            <CardContent className="space-y-3 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={KIND_VARIANT[detail.kind]}>
                      {KIND_LABEL[detail.kind]}
                    </Badge>
                    <span>#{detail.id}</span>
                    {detail.severity && (
                      <Badge variant={severityVariant(detail.severity)}>
                        {detail.severity}
                      </Badge>
                    )}
                    <Badge variant={statusVariant(detail.status)}>
                      {statusLabel(detail.status)}
                    </Badge>
                  </div>
                  <h1 className="break-words text-xl font-semibold text-text-primary">
                    {detail.title || "—"}
                  </h1>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
                    <span className="inline-flex items-center gap-1">
                      <Activity className="h-3.5 w-3.5" />
                      {detail.service || "未知服务"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      时间窗 {fmtWindow(detail.time_window)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      创建于 {fmtTime(detail.created_at)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {detail.actions.map(renderAction)}
                </div>
              </div>
            </CardContent>
          </Card>

          {error && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-status-active/30 bg-status-active/5 px-3 py-2 text-xs text-status-active">
              <span>刷新失败：{error}</span>
              <Button variant="ghostMuted" size="xs" onClick={() => void load(true)}>
                重试
              </Button>
            </div>
          )}

          {/* ── Three columns: context / timeline / root cause ── */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
            {/* 左：上下文 */}
            <Card className="flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <BellRing className="h-4 w-4" /> 上下文
                  <span className="text-xs font-normal text-muted-foreground">
                    {detail.alerts.length} 条告警
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <section>
                  <h3 className="mb-2 text-xs font-medium text-text-secondary">
                    告警
                  </h3>
                  {detail.alerts.length === 0 ? (
                    <EmptyHint>暂无关联告警</EmptyHint>
                  ) : (
                    <ul className="space-y-2">
                      {detail.alerts.map((alert) => (
                        <li
                          key={alert.id}
                          className="rounded-lg border border-border/60 p-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="line-clamp-3 break-words text-xs text-text-primary">
                              {alert.content || `告警 #${alert.id}`}
                            </p>
                            {alert.severity && (
                              <Badge
                                variant={severityVariant(alert.severity)}
                                className="text-[10px]"
                              >
                                {alert.severity}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {alert.uid ? `${alert.uid} · ` : ""}
                            {fmtTime(alert.time)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-2 text-xs font-medium text-text-secondary">
                    关联事件
                  </h3>
                  {detail.related.length === 0 ? (
                    <EmptyHint>暂无同时段关联事件</EmptyHint>
                  ) : (
                    <ul className="space-y-1">
                      {detail.related.map((item) => {
                        const itemKind = relatedKind(item.id);
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => navigate(relatedPath(item.id))}
                              className="flex w-full items-start justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted"
                            >
                              <span className="line-clamp-2 text-xs text-text-primary">
                                {itemKind ? `${KIND_LABEL[itemKind]} · ` : ""}
                                {item.title || "—"}
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {statusLabel(item.status)} · {fmtTime(item.created_at)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </CardContent>
            </Card>

            {/* 中：时间线 */}
            <Card className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Clock className="h-4 w-4" /> 时间线
                  </CardTitle>
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    {isRunning ? (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-status-resolved" />
                        运行中 · 每 5 秒自动刷新
                      </>
                    ) : (
                      "已停止自动刷新"
                    )}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                {detail.timeline.length === 0 ? (
                  <EmptyHint>
                    {detail.rca
                      ? "暂无时间线事件。分析产生协作事件后会显示在这里。"
                      : "该事件尚未关联 RCA 会话，因此没有分析时间线。"}
                  </EmptyHint>
                ) : (
                  <ol className="relative space-y-3 border-l border-border/70 pl-4">
                    {detail.timeline.map((entry, index) => (
                      <li key={`${entry.at}-${index}`} className="relative">
                        <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-interactive-primary" />
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">{fmtTime(entry.at)}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {EVENT_TYPE_LABEL[entry.type] ?? entry.type}
                          </Badge>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-text-primary">
                          {entry.content || "—"}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>

            {/* 右：根因与建议 */}
            <Card className="flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Activity className="h-4 w-4" /> 根因与建议
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!detail.rca ? (
                  <EmptyHint>该事件尚未关联 RCA 会话。</EmptyHint>
                ) : (
                  <>
                    <section>
                      <h3 className="mb-1.5 text-xs font-medium text-text-secondary">
                        根因结论
                      </h3>
                      <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2.5 text-xs text-text-primary">
                        {detail.rca.root_cause || "分析尚未得出根因结论。"}
                      </p>
                    </section>

                    <section>
                      <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="font-medium text-text-secondary">置信度</span>
                        <span className="tabular-nums text-text-primary">
                          {confidencePercent(detail.rca.confidence) === null
                            ? "—"
                            : `${confidencePercent(detail.rca.confidence)}%`}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-interactive-primary transition-all"
                          style={{
                            width: `${confidencePercent(detail.rca.confidence) ?? 0}%`,
                          }}
                        />
                      </div>
                    </section>

                    <section>
                      <h3 className="mb-1.5 text-xs font-medium text-text-secondary">
                        Top3 根因
                      </h3>
                      {detail.rca.top3.length === 0 ? (
                        <EmptyHint>暂无 Top3 结论</EmptyHint>
                      ) : (
                        <ol className="list-decimal space-y-1 pl-4 text-xs text-text-primary">
                          {detail.rca.top3.map((item, index) => (
                            <li key={index} className="break-words">
                              {item}
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>

                    <section>
                      <h3 className="mb-1.5 text-xs font-medium text-text-secondary">
                        证据
                      </h3>
                      {detail.rca.evidence.length === 0 ? (
                        <EmptyHint>暂无证据记录</EmptyHint>
                      ) : (
                        <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
                          {detail.rca.evidence.map((item, index) => (
                            <li
                              key={index}
                              className="flex items-start gap-1.5 text-xs text-text-primary"
                            >
                              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-status-resolved" />
                              <span className="break-words">{toText(item)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <section>
                      <h3 className="mb-1.5 text-xs font-medium text-text-secondary">
                        处置建议
                      </h3>
                      {detail.rca.recommended_actions.length === 0 ? (
                        <EmptyHint>暂无处置建议</EmptyHint>
                      ) : (
                        <ol className="list-decimal space-y-1 pl-4 text-xs text-text-primary">
                          {detail.rca.recommended_actions.map((item, index) => (
                            <li key={index} className="break-words">
                              {toText(item)}
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Quick actions ───────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <FileText className="h-4 w-4" /> 快速行动
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void copySummary()}>
                <Copy className="h-3.5 w-3.5" /> 复制摘要
              </Button>
              <Button variant="outline" size="sm" onClick={openChat}>
                <MessageCircle className="h-3.5 w-3.5" /> 智能对话
              </Button>
              <Button
                variant={followed ? "default" : "outline"}
                size="sm"
                onClick={toggleFollow}
              >
                <Star className={`h-3.5 w-3.5 ${followed ? "fill-current" : ""}`} />
                {followed ? "已关注" : "标记已关注"}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                关注状态仅保存在本机浏览器；对话为跳转，不会自动执行处置。
              </span>
            </CardContent>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        title={confirmAction === "cancel" ? "终止 RCA 分析" : "重新分析"}
        description={
          confirmAction === "cancel"
            ? `确认终止会话 #${detail?.rca?.session_id ?? ""}？终止后状态记为失败，已写入的时间线会保留。`
            : `确认对会话 #${detail?.rca?.session_id ?? ""} 重新分析？当前报告（如有）会被重新生成。`
        }
        confirmLabel={confirmAction === "cancel" ? "终止" : "重新分析"}
        variant={confirmAction === "cancel" ? "destructive" : "default"}
        isLoading={acting}
        onConfirm={() => void performConfirmed()}
      />
    </div>
  );
}
