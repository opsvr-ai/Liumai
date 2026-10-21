import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Info,
  Layers,
  Lightbulb,
  ListChecks,
  Loader2,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { PermissionGate } from "@/components/auth/permission-gate";
import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  rca,
  reportApi,
  type RcaReport,
  type RcaReportAlert,
  type RcaSessionDetail,
  type RcaTimelineEntry,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* ==========================================================================
 *  Standalone RCA report page — /rca/report/:sessionId
 *
 *  Replaces the old "report only lives inside a drawer" flow with a full
 *  reading surface:
 *    · structure view  → summary / evidence / impact / actions / timeline / alerts
 *    · markdown view   → the same report rendered through the sanitised
 *                        Markdown component (rehype-sanitize)
 *
 *  HTML exports are deliberately download-only: embedding a downloaded HTML
 *  document would execute third-party markup inside the platform origin.
 * ========================================================================== */

type ViewMode = "structure" | "markdown";
type IconComponent = ComponentType<{ className?: string }>;

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: "完成",
  FAILED: "失败",
  RUNNING: "运行中",
  QUEUED: "排队中",
};

const ALERT_STATUS_LABEL: Record<string, string> = {
  triggered: "触发中",
  firing: "触发中",
  resolved: "已恢复",
  acknowledged: "已确认",
  ignored: "已忽略",
  pending: "待处理",
};

function statusLabel(status?: string | null): string {
  if (!status) return "—";
  return STATUS_LABEL[status.toUpperCase()] ?? status;
}

function statusVariant(status?: string | null): "success" | "destructive" | "info" | "secondary" {
  switch (status?.toUpperCase()) {
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "destructive";
    case "RUNNING":
      return "info";
    default:
      return "secondary";
  }
}

function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateValue(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Clamp long free-form report text; never dump an unbounded JSON blob. */
function clampText(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const TEXT_KEYS = [
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
  "service_name",
];

/** Human-readable text for JSON report values without dumping raw JSON. */
function humanText(value: unknown, max = 1200): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return clampText(value, max).trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const perItem = Math.max(80, Math.floor(max / Math.max(1, value.length)));
    return clampText(
      value
        .map((item) => humanText(item, perItem))
        .filter(Boolean)
        .join("；"),
      max,
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of TEXT_KEYS) {
      const hit = record[key];
      if (typeof hit === "string" && hit.trim()) {
        return clampText(hit.trim(), max);
      }
    }
    const pairs = Object.entries(record)
      .filter(([, item]) => item !== null && item !== undefined && typeof item !== "object")
      .slice(0, 4)
      .map(([key, item]) => `${key}: ${String(item)}`);
    if (pairs.length > 0) return clampText(pairs.join(" · "), max);
    try {
      return clampText(JSON.stringify(value), max);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function metadataOf(entry: RcaTimelineEntry): Record<string, unknown> {
  const raw = entry.metadata;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function isHeartbeat(entry: RcaTimelineEntry): boolean {
  return metadataOf(entry).kind === "rca_heartbeat";
}

function toolNameOf(entry: RcaTimelineEntry): string | null {
  const meta = metadataOf(entry);
  if (meta.kind === "tool_call" || typeof meta.tool === "string") {
    const name = typeof meta.tool === "string" ? meta.tool.trim() : "";
    return name || "工具调用";
  }
  return null;
}

function timelineText(entry: RcaTimelineEntry): string {
  return (
    humanText(entry.content, 4000) ||
    humanText(entry.event, 4000) ||
    humanText(entry.detail, 4000) ||
    entry.event_type ||
    "—"
  );
}

function alertSeverity(alert: RcaReportAlert): {
  level: number | null;
  text: string;
  variant: "destructive" | "investigating" | "secondary";
} {
  const parsed = Number(alert.severity_level ?? alert.severity);
  const level = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  if (level === null) {
    return { level, text: alert.severity || "—", variant: "secondary" };
  }
  return {
    level,
    text: `P${level}`,
    variant: level <= 2 ? "destructive" : level <= 3 ? "investigating" : "secondary",
  };
}

/* ── Small building blocks ─────────────────────────────────────────────── */

function EmptyLine({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border/70 bg-surface-secondary/20 px-4 py-6 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function ReportBreadcrumb({ id }: { id?: number }) {
  return (
    <nav
      aria-label="面包屑"
      className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Link to="/rca" className="transition-colors hover:text-text-primary">
        RCA 分析
      </Link>
      <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      <Link to="/rca?tab=reports" className="transition-colors hover:text-text-primary">
        报告库
      </Link>
      <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span aria-current="page" className="font-mono font-medium text-text-secondary">
        {id ? `#${id}` : "报告"}
      </span>
    </nav>
  );
}

function SectionCard({
  icon: Icon,
  title,
  meta,
  hint,
  action,
  children,
  className,
}: {
  icon: IconComponent;
  title: string;
  meta?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("border border-border/70 shadow-sm", className)}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-interactive-primary/10">
              <Icon className="h-4 w-4 text-interactive-primary" />
            </span>
            <span className="truncate">{title}</span>
            {meta ? (
              <span className="text-xs font-normal whitespace-nowrap text-muted-foreground">
                {meta}
              </span>
            ) : null}
          </CardTitle>
          {action}
        </div>
        {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return <Badge variant="secondary">置信度 —</Badge>;
  }
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const variant = pct >= 80 ? "success" : pct >= 60 ? "info" : "secondary";
  return <Badge variant={variant}>置信度 {pct}%</Badge>;
}

function TimelineCard({ entries }: { entries: RcaTimelineEntry[] }) {
  const toolCount = entries.filter((entry) => toolNameOf(entry)).length;
  return (
    <SectionCard
      icon={Activity}
      title="时间线与执行过程"
      meta={`${entries.length} 条事件`}
      hint={
        toolCount > 0
          ? `按时间排序 · ${toolCount} 次工具调用已折叠，点击展开查看调用详情。`
          : "按时间排序，展示分析过程中的关键事件。"
      }
    >
      {entries.length === 0 ? (
        <EmptyLine>暂无时间线记录</EmptyLine>
      ) : (
        <ol className="space-y-0">
          {entries.map((entry, index) => (
            <TimelineRow
              key={entry.id ?? `${entry.created_at ?? entry.timestamp ?? "event"}-${index}`}
              entry={entry}
              last={index === entries.length - 1}
            />
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

function TimelineRow({ entry, last }: { entry: RcaTimelineEntry; last: boolean }) {
  const tool = toolNameOf(entry);
  const meta = metadataOf(entry);
  const content = timelineText(entry);
  const timestamp = entry.created_at ?? entry.timestamp;
  const extraMeta = Object.entries(meta).filter(
    ([key, value]) =>
      !["kind", "tool", "service", "source"].includes(key) &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
  );

  return (
    <li className="relative flex gap-3">
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
            tool
              ? "border-status-investigating/30 bg-status-investigating/10 text-status-investigating"
              : "border-border bg-surface-secondary text-text-secondary",
          )}
        >
          {tool ? (
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Activity className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </span>
        {!last ? <span aria-hidden="true" className="my-1 w-px flex-1 bg-border" /> : null}
      </div>

      <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-4")}>
        <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11px] text-muted-foreground">
          <time dateTime={timestamp ?? undefined} className="tabular-nums">
            {fmtDateTime(timestamp)}
          </time>
          {tool ? (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              工具调用
            </Badge>
          ) : null}
        </div>

        {tool ? (
          <details className="group mt-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border/60 bg-surface-secondary/30 px-3 py-2 text-xs transition-colors hover:bg-surface-secondary/70 [&::-webkit-details-marker]:hidden">
              <Wrench className="h-3.5 w-3.5 shrink-0 text-interactive-primary" aria-hidden="true" />
              <span className="shrink-0 font-mono text-[11px] font-medium text-text-primary">
                {tool}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {content}
              </span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="rounded-b-lg border border-t-0 border-border/60 bg-surface-primary px-3 py-2.5">
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary">
                {content}
              </p>
              {(meta.service || meta.source || extraMeta.length > 0) && (
                <dl className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                  {typeof meta.service === "string" && meta.service ? (
                    <div className="flex gap-1">
                      <dt>服务：</dt>
                      <dd className="text-text-secondary">{meta.service}</dd>
                    </div>
                  ) : null}
                  {typeof meta.source === "string" && meta.source ? (
                    <div className="flex gap-1">
                      <dt>来源：</dt>
                      <dd className="text-text-secondary">{meta.source}</dd>
                    </div>
                  ) : null}
                  {extraMeta.slice(0, 4).map(([key, value]) => (
                    <div key={key} className="flex gap-1">
                      <dt>{key}：</dt>
                      <dd className="truncate text-text-secondary">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </details>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary md:text-[13px]">
            {content}
          </p>
        )}
      </div>
    </li>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function RcaReportPage() {
  const { sessionId: rawSessionId } = useParams<{ sessionId: string }>();
  const sessionId = Number(rawSessionId);
  const valid = Number.isInteger(sessionId) && sessionId > 0;
  const navigate = useNavigate();

  const [session, setSession] = useState<RcaSessionDetail | null>(null);
  const [report, setReport] = useState<RcaReport | null>(null);
  const [alerts, setAlerts] = useState<RcaReportAlert[]>([]);
  const [markdown, setMarkdown] = useState("");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [markdownError, setMarkdownError] = useState<string | null>(null);
  const [markdownLoading, setMarkdownLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [noReport, setNoReport] = useState(false);
  const [error, setError] = useState<{ status?: number; message: string } | null>(null);

  const [view, setView] = useState<ViewMode>("structure");
  const [downloading, setDownloading] = useState<"md" | "html" | null>(null);
  const [copying, setCopying] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!valid) {
        setLoading(false);
        setError({ status: 404, message: "无效的报告地址" });
        return;
      }
      if (!options?.silent) setLoading(true);
      setError(null);

      try {
        const detail = await rca.detail(sessionId);
        setSession(detail);

        let markdownIssue: string | null = null;
        const markdownPromise = rca.reportMarkdown(sessionId).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) return null;
          markdownIssue = err instanceof Error ? err.message : "Markdown 原文加载失败";
          return null;
        });

        try {
          const [nextReport, nextMarkdown, nextAlerts] = await Promise.all([
            rca.report(sessionId),
            markdownPromise,
            rca.sessionAlerts(sessionId).catch(() => [] as RcaReportAlert[]),
          ]);

          setReport(nextReport);
          setNoReport(false);
          setAlerts(nextAlerts.length > 0 ? nextAlerts : nextReport.alerts ?? []);

          if (nextMarkdown) {
            setMarkdown(nextMarkdown.markdown);
            setGeneratedAt(nextMarkdown.generated_at);
            setMarkdownError(null);
          } else {
            setMarkdown("");
            setMarkdownError(markdownIssue ?? "Markdown 原文暂时不可用，可下载报告或稍后重试。");
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            setReport(null);
            setAlerts([]);
            setMarkdown("");
            setNoReport(true);
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setError({ status: 404, message: "报告不存在或无权访问" });
        } else {
          setError({ message: err instanceof Error ? err.message : "加载报告失败" });
        }
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [sessionId, valid],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // QUEUED / RUNNING sessions have no report yet: poll the detail endpoint so
  // the timeline grows and the report appears as soon as the runner finishes.
  useEffect(() => {
    const status = session?.status?.toUpperCase();
    if (!session || report || (status !== "QUEUED" && status !== "RUNNING")) return;

    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await rca.detail(sessionId);
        if (cancelled) return;
        setSession(next);
        if (next.status?.toUpperCase() === "COMPLETED") {
          void load({ silent: true });
        }
      } catch {
        // Transient network errors keep the current view; the next tick retries.
      }
    };

    const timer = window.setInterval(() => void tick(), 5000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session, report, sessionId, load]);

  const timeline = useMemo(() => {
    const entries = (session?.timeline ?? []).filter((entry) => !isHeartbeat(entry));
    return [...entries].sort(
      (a, b) =>
        dateValue(a.created_at ?? a.timestamp) - dateValue(b.created_at ?? b.timestamp),
    );
  }, [session?.timeline]);

  const confidence =
    report && report.confidence !== null && report.confidence !== undefined
      ? Math.round(Math.max(0, Math.min(1, report.confidence)) * 100)
      : null;
  const confidenceVariant: "success" | "info" | "secondary" =
    confidence === null ? "secondary" : confidence >= 80 ? "success" : confidence >= 60 ? "info" : "secondary";
  const confidenceBar =
    confidence === null
      ? "bg-muted-foreground/40"
      : confidence >= 80
        ? "bg-status-resolved"
        : confidence >= 60
          ? "bg-interactive-primary"
          : confidence >= 40
            ? "bg-status-investigating"
            : "bg-status-active";
  const confidenceHint =
    confidence === null
      ? "未提供置信度"
      : confidence >= 80
        ? "高置信 · 结论与证据链一致性较好"
        : confidence >= 60
          ? "中等置信 · 建议结合现场复核"
          : "偏低置信 · 建议补充证据后再处置";

  const alertsForDisplay = alerts.length > 0 ? alerts : report?.alerts ?? [];
  const status = session?.status;

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

  async function downloadReport(format: "md" | "html") {
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

  async function reloadMarkdown() {
    setMarkdownLoading(true);
    setMarkdownError(null);
    try {
      const result = await rca.reportMarkdown(sessionId);
      setMarkdown(result.markdown);
      setGeneratedAt(result.generated_at);
    } catch (err) {
      setMarkdownError(err instanceof Error ? err.message : "Markdown 原文加载失败");
    } finally {
      setMarkdownLoading(false);
    }
  }

  async function copyMarkdown() {
    if (!markdown) {
      toast.error("Markdown 内容尚未就绪");
      return;
    }
    setCopying(true);
    const ok = await copyText(markdown);
    setCopying(false);
    if (ok) toast.success("Markdown 已复制到剪贴板");
    else toast.error("复制失败，请手动选择文本");
  }

  async function rerun() {
    setRerunning(true);
    try {
      await rca.rerun(sessionId);
      setConfirmRerun(false);
      toast.success("已重新加入分析队列");
      navigate(`/rca?s=${sessionId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重新分析失败");
    } finally {
      setRerunning(false);
    }
  }

  /* ── Loading ─────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6" aria-busy="true">
        <ReportBreadcrumb id={valid ? sessionId : undefined} />
        <Skeleton className="h-44 w-full rounded-xl" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-8 w-28" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }

  /* ── HTTP / invalid id ───────────────────────────────────────────────── */

  if (error) {
    return (
      <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
        <ReportBreadcrumb id={valid ? sessionId : undefined} />
        <Card className="border border-border/70 shadow-sm">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-active/10">
              <AlertTriangle className="h-6 w-6 text-status-active" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-text-primary">{error.message}</p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {error.status === 404
                ? "会话可能不存在、属于其他团队，或已被删除。跨团队访问按「不存在」处理。"
                : "请求未能完成，请检查网络或稍后重试。"}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Link
                to="/rca?tab=reports"
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                <ArrowLeft className="h-3.5 w-3.5" /> 返回报告库
              </Link>
              <Button size="sm" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" /> 重试
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!session) return null;

  const active = status?.toUpperCase() === "QUEUED" || status?.toUpperCase() === "RUNNING";
  const serviceName = session.service_name || "未知服务";
  const reportService = report?.service_name || serviceName;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      <ReportBreadcrumb id={session.id} />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <Card className="border border-border/70 bg-interactive-primary/[0.025] shadow-sm">
        <CardContent className="space-y-4 p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-[10px]">
                  RCA #{session.id}
                </Badge>
                <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
                {report ? <ConfidenceBadge value={report.confidence} /> : null}
                {noReport ? <Badge variant="secondary">暂无报告</Badge> : null}
              </div>

              <h1 className="break-words text-xl font-semibold leading-tight text-text-primary md:text-2xl">
                {reportService}
                <span className="ml-2 text-base font-normal text-muted-foreground md:text-lg">
                  根因分析报告
                </span>
              </h1>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  创建于 {fmtDateTime(session.created_at)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                  分析窗口 {fmtDateTime(session.time_window_start)} ~ {fmtDateTime(session.time_window_end)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                  {session.trigger_type === "PASSIVE" ? "告警触发" : "人工触发"}
                </span>
                {session.completed_at ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    完成于 {fmtDateTime(session.completed_at)}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={downloading !== null || noReport}
                onClick={() => void downloadReport("md")}
              >
                {downloading === "md" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                下载 Markdown
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={downloading !== null || noReport}
                onClick={() => void downloadReport("html")}
              >
                {downloading === "html" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                下载 HTML
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!markdown || copying}
                onClick={() => void copyMarkdown()}
              >
                {copying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                复制 Markdown
              </Button>
              <PermissionGate perm="rca_terminate">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rerunning || active}
                  title={active ? "分析进行中，暂不能重新分析" : "重新分析并重新生成报告"}
                  onClick={() => setConfirmRerun(true)}
                >
                  {rerunning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  重新分析
                </Button>
              </PermissionGate>
              <Link
                to="/rca?tab=reports"
                className={cn(buttonVariants({ variant: "ghostMuted", size: "sm" }))}
              >
                <ArrowLeft className="h-3.5 w-3.5" /> 返回列表
              </Link>
            </div>
          </div>

          {report ? (
            <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-surface-secondary/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                在线查看使用结构视图与受信任的 Markdown 渲染；HTML 报告仅提供下载，不在页面内嵌执行，避免外部脚本风险。
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── No report yet ────────────────────────────────────────────── */}
      {!report ? (
        <>
          <Card className="border border-border/70 shadow-sm">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <div
                className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-full",
                  active ? "bg-interactive-primary/10" : "bg-status-investigating/10",
                )}
              >
                {active ? (
                  <Loader2 className="h-6 w-6 animate-spin text-interactive-primary" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-6 w-6 text-status-investigating" aria-hidden="true" />
                )}
              </div>
              <h2 className="text-sm font-medium text-text-primary">
                {active ? "分析进行中，报告尚未生成" : "该会话尚无 RCA 报告"}
              </h2>
              <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
                {active
                  ? "报告会在分析完成后自动生成，本页每 5 秒刷新一次进度。你可以在时间线中查看当前执行过程。"
                  : status?.toUpperCase() === "FAILED"
                    ? "分析未完成或失败，可能没有产出结构化结论。可在会话详情中查看失败原因，或重新发起分析。"
                    : "报告可能仍在生成，或本次分析没有产出结构化结果。可在会话详情中查看时间线，或重新发起分析。"}
              </p>
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                <Link
                  to="/rca?tab=reports"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> 返回报告库
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/rca?s=${session.id}`)}
                >
                  <ExternalLink className="h-3.5 w-3.5" /> 查看会话详情
                </Button>
                <PermissionGate perm="rca_terminate">
                  <Button size="sm" onClick={() => setConfirmRerun(true)} disabled={active || rerunning}>
                    <RefreshCw className="h-3.5 w-3.5" /> 重新分析
                  </Button>
                </PermissionGate>
              </div>
            </CardContent>
          </Card>

          {timeline.length > 0 ? <TimelineCard entries={timeline} /> : null}
        </>
      ) : (
        <Tabs value={view} onValueChange={(next) => setView(String(next) as ViewMode)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="structure">
                <Layers className="h-3.5 w-3.5" /> 结构视图
              </TabsTrigger>
              <TabsTrigger value="markdown">
                <FileText className="h-3.5 w-3.5" /> Markdown 原文
              </TabsTrigger>
            </TabsList>
            <p className="text-[11px] text-muted-foreground">
              {generatedAt ? `报告生成于 ${fmtDateTime(generatedAt)}` : "在线查看为只读内容"}
            </p>
          </div>

          {/* ── Structure view ──────────────────────────────────────── */}
          <TabsContent value="structure" className="mt-4">
            <div className="space-y-4">
              {/* ① Root cause + confidence + Top3 */}
              <SectionCard
                icon={ShieldCheck}
                title="根因摘要"
                meta={report.category ? `分类 · ${report.category}` : undefined}
              >
                <div className="space-y-4">
                  <p className="whitespace-pre-wrap break-words text-[15px] font-medium leading-relaxed text-text-primary md:text-base">
                    {humanText(report.root_cause, 4000) || "—"}
                  </p>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-border/60 bg-surface-secondary/30 p-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-medium tracking-wide text-muted-foreground">
                          置信度
                        </p>
                        <Badge variant={confidenceVariant}>
                          {confidenceHint.split(" · ")[0]}
                        </Badge>
                      </div>
                      <div className="mt-1.5 flex items-end gap-2">
                        <span className="text-3xl font-bold leading-none tabular-nums text-text-primary">
                          {confidence ?? "—"}
                          {confidence !== null ? <span className="text-base font-semibold">%</span> : null}
                        </span>
                        <span className="mb-0.5 text-[11px] text-muted-foreground">
                          {confidenceHint}
                        </span>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-tertiary">
                        <div
                          className={cn("h-full rounded-full transition-[width] duration-300", confidenceBar)}
                          style={{ width: `${confidence ?? 0}%` }}
                        />
                      </div>
                    </div>

                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl border border-border/60 bg-surface-secondary/30 p-3.5 text-xs">
                      <div>
                        <dt className="text-[11px] text-muted-foreground">分类</dt>
                        <dd className="mt-0.5 truncate font-medium text-text-primary">
                          {report.category || "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-muted-foreground">触发告警</dt>
                        <dd className="mt-0.5 font-medium tabular-nums text-text-primary">
                          {alertsForDisplay.length} 条
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-muted-foreground">影响服务</dt>
                        <dd className="mt-0.5 font-medium tabular-nums text-text-primary">
                          {report.impacted_services.length} 个
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-muted-foreground">证据条目</dt>
                        <dd className="mt-0.5 font-medium tabular-nums text-text-primary">
                          {report.evidence.length} 条
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-interactive-primary" aria-hidden="true" />
                      <p className="text-xs font-medium text-text-primary">Top3 根因</p>
                      <span className="text-[11px] text-muted-foreground">按可能性排序</span>
                    </div>
                    {report.top3 && report.top3.length > 0 ? (
                      <div className="grid gap-3 md:grid-cols-3">
                        {report.top3.slice(0, 3).map((item, index) => (
                          <div
                            key={`${index}-${humanText(item, 40)}`}
                            className={cn(
                              "rounded-xl border p-3.5",
                              index === 0
                                ? "border-interactive-primary/25 bg-interactive-primary/[0.045]"
                                : "border-border/60 bg-surface-secondary/30",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                                  index === 0
                                    ? "bg-interactive-primary text-text-on-solid"
                                    : "bg-surface-tertiary text-text-secondary",
                                )}
                              >
                                {index + 1}
                              </span>
                              <span className="text-[11px] font-medium text-muted-foreground">
                                候选 {index + 1}
                              </span>
                            </div>
                            <p
                              className="mt-2 line-clamp-4 break-words text-xs leading-relaxed text-text-primary"
                              title={humanText(item, 1000)}
                            >
                              {humanText(item, 1000) || "—"}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyLine>暂无 Top3 根因结论</EmptyLine>
                    )}
                  </div>
                </div>
              </SectionCard>

              {/* ② Evidence */}
              <SectionCard
                icon={ListChecks}
                title="证据链"
                meta={`${report.evidence.length} 条`}
                hint="支撑根因判断的关键事实与观测结果。"
              >
                {report.evidence.length === 0 ? (
                  <EmptyLine>暂无证据记录</EmptyLine>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {report.evidence.map((item, index) => (
                      <li key={index} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-tertiary text-[10px] font-semibold tabular-nums text-text-secondary">
                          {index + 1}
                        </span>
                        <p className="min-w-0 break-words text-xs leading-relaxed text-text-primary md:text-[13px]">
                          {humanText(item, 2000) || "—"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              {/* ③ Impact */}
              <SectionCard
                icon={Server}
                title="影响面"
                meta={`${report.impacted_services.length} 个服务`}
                hint="本次故障可能波及的服务与依赖。"
              >
                {report.impacted_services.length === 0 ? (
                  <EmptyLine>未识别受影响服务</EmptyLine>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {report.impacted_services.map((item, index) => (
                      <Badge
                        key={index}
                        variant="outline"
                        className="h-7 gap-1.5 px-2.5 text-xs font-medium"
                      >
                        <Server className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                        {humanText(item, 120) || "—"}
                      </Badge>
                    ))}
                  </div>
                )}
              </SectionCard>

              {/* ④ Recommendations */}
              <SectionCard
                icon={Lightbulb}
                title="处置建议"
                meta={`${report.recommended_actions.length} 条`}
                hint="建议按顺序执行；生产变更前请先评估影响。"
              >
                {report.recommended_actions.length === 0 ? (
                  <EmptyLine>暂无处置建议</EmptyLine>
                ) : (
                  <ol className="space-y-2.5">
                    {report.recommended_actions.map((item, index) => (
                      <li
                        key={index}
                        className="flex gap-3 rounded-lg border border-border/50 bg-surface-secondary/25 p-3"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-interactive-primary/10 text-[11px] font-bold text-interactive-primary">
                          {index + 1}
                        </span>
                        <p className="min-w-0 break-words text-xs leading-relaxed text-text-primary md:text-[13px]">
                          {humanText(item, 2000) || "—"}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </SectionCard>

              {/* ⑤ Timeline & tool calls */}
              <TimelineCard entries={timeline} />

              {/* ⑥ Triggered alerts */}
              <SectionCard
                icon={ClipboardList}
                title="触发告警"
                meta={`${alertsForDisplay.length} 条`}
                hint="触发或合并到本次 RCA 会话的告警。"
              >
                {alertsForDisplay.length === 0 ? (
                  <EmptyLine>未关联触发告警</EmptyLine>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border/60">
                    <table className="w-full min-w-[760px] text-xs">
                      <thead>
                        <tr className="border-b border-border/60 bg-surface-secondary/50 text-left text-[11px] text-muted-foreground">
                          <th scope="col" className="px-3 py-2 font-medium">时间</th>
                          <th scope="col" className="px-3 py-2 font-medium">告警</th>
                          <th scope="col" className="px-3 py-2 font-medium">来源</th>
                          <th scope="col" className="px-3 py-2 font-medium">应用 / CI</th>
                          <th scope="col" className="px-3 py-2 font-medium">级别</th>
                          <th scope="col" className="px-3 py-2 font-medium">内容</th>
                          <th scope="col" className="px-3 py-2 font-medium">状态</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {alertsForDisplay.map((alert) => {
                          const severity = alertSeverity(alert);
                          return (
                            <tr key={alert.id} className="align-top hover:bg-surface-secondary/30">
                              <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground tabular-nums">
                                {fmtDateTime(alert.alert_time)}
                              </td>
                              <td className="px-3 py-2.5 font-mono text-[10px] text-text-secondary">
                                {alert.alert_uid || `#${alert.id}`}
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-text-secondary">
                                {alert.source || "—"}
                              </td>
                              <td className="px-3 py-2.5 whitespace-nowrap text-text-secondary">
                                {alert.ci_application || alert.ci_name || "—"}
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge variant={severity.variant} className="text-[10px]">
                                  {severity.text}
                                </Badge>
                              </td>
                              <td className="max-w-[300px] px-3 py-2.5">
                                <p className="line-clamp-2 break-words text-text-primary" title={alert.content ?? ""}>
                                  {alert.content || "—"}
                                </p>
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge variant="secondary" className="text-[10px]">
                                  {ALERT_STATUS_LABEL[alert.status] ?? alert.status}
                                </Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            </div>
          </TabsContent>

          {/* ── Markdown view ───────────────────────────────────────── */}
          <TabsContent value="markdown" className="mt-4">
            <Card className="border border-border/70 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-interactive-primary/10">
                      <FileText className="h-4 w-4 text-interactive-primary" />
                    </span>
                    Markdown 报告
                    <span className="text-xs font-normal text-muted-foreground">
                      rehype-sanitize 安全渲染
                    </span>
                  </CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    {generatedAt ? (
                      <span className="text-[11px] text-muted-foreground">
                        生成于 {fmtDateTime(generatedAt)}
                      </span>
                    ) : null}
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!markdown || copying}
                      onClick={() => void copyMarkdown()}
                    >
                      <Copy className="h-3 w-3" /> 复制
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  与下载的 Markdown 文件内容一致；HTML 报告仅提供下载，避免在平台内执行外部脚本。
                </p>
              </CardHeader>
              <CardContent>
                {markdownLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-2/3" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                    <Skeleton className="h-32 w-full" />
                  </div>
                ) : markdownError ? (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/70 bg-surface-secondary/20 px-4 py-10 text-center">
                    <AlertCircle className="h-6 w-6 text-status-investigating" aria-hidden="true" />
                    <p className="text-xs text-text-primary">Markdown 原文加载失败</p>
                    <p className="max-w-lg text-[11px] text-muted-foreground">{markdownError}</p>
                    <Button variant="outline" size="sm" onClick={() => void reloadMarkdown()}>
                      <RefreshCw className="h-3.5 w-3.5" /> 重试
                    </Button>
                  </div>
                ) : markdown ? (
                  <div className="rounded-xl border border-border/60 bg-surface-primary p-4 md:p-6">
                    <Markdown content={markdown} />
                  </div>
                ) : (
                  <EmptyLine>暂无可渲染的 Markdown 内容</EmptyLine>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      <ConfirmDialog
        open={confirmRerun}
        onOpenChange={(open) => {
          if (!open && !rerunning) setConfirmRerun(false);
        }}
        title="重新分析该会话"
        description={
          report
            ? `将重新分析会话 #${session.id}（${serviceName}），现有报告会被重新生成覆盖。分析期间可返回列表查看进度。`
            : `确认重新分析会话 #${session.id}（${serviceName}）？`
        }
        confirmLabel="重新分析"
        variant="destructive"
        isLoading={rerunning}
        onConfirm={() => void rerun()}
        onCancel={() => setConfirmRerun(false)}
      />
    </div>
  );
}
