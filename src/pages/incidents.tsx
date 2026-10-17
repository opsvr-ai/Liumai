import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  Ban,
  BellRing,
  Download,
  FileText,
  RefreshCw,
  Search,
} from "lucide-react";
import { useAuth } from "@/components/auth/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authApi, rca, reportApi } from "@/lib/api";
import { toast } from "sonner";

/* ==========================================================================
 *  事件中心 — 收件箱 / 进行中 / 报告库 统一视图
 *
 *  数据来自只读聚合接口 GET /api/incidents（不新增 api.ts 方法，页面内
 *  fetch + Authorization 头）。行内动作只做「跳转」和「下载报告」，写操作
 *  仍走既有接口（rca.cancel），页面级权限由 authApi.permissions() 决定。
 *  tab / page / search 三个状态全部同步到 URL query，可直接分享当前视图。
 * ========================================================================== */

type TabKey = "inbox" | "active" | "reports";
type IncidentKind = "alert" | "rca" | "report";

interface IncidentItem {
  /** 复合 id：alert-12 / rca-34 / report-56（三张表主键会重叠）。 */
  id: string;
  kind: IncidentKind;
  title: string;
  service: string | null;
  severity: string | null;
  status: string;
  created_at: string;
  rca_session_id: number | null;
  /** 后端建议的动作键：trigger/dismiss/open_rca/open_alerts/cancel/download_* */
  actions: string[];
}

interface IncidentCounts {
  inbox: number;
  active: number;
  reports: number;
}

interface IncidentResponse {
  items: IncidentItem[];
  total: number;
  counts: IncidentCounts;
}

type BadgeVariant =
  | "destructive"
  | "active"
  | "investigating"
  | "secondary"
  | "outline"
  | "info"
  | "success";

const PAGE_SIZE = 20;
const TOKEN_KEY = "liumai_token";

const TAB_ORDER: TabKey[] = ["inbox", "active", "reports"];

const TAB_META: Record<TabKey, { label: string; hint: string; icon: typeof BellRing }> = {
  inbox: {
    label: "收件箱",
    hint: "待处理 / 已触发 / 已合并的告警",
    icon: BellRing,
  },
  active: {
    label: "进行中",
    hint: "排队中或运行中的 RCA 会话",
    icon: Activity,
  },
  reports: {
    label: "报告库",
    hint: "已完成会话的结构化报告",
    icon: FileText,
  },
};

const KIND_LABEL: Record<IncidentKind, string> = {
  alert: "告警",
  rca: "分析中",
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

const EMPTY_HINT: Record<TabKey, string> = {
  inbox: "暂无收件箱事件。监控告警经 /api/alerts/webhook 接入后会出现在这里。",
  active: "当前没有排队中或运行中的 RCA 会话。",
  reports: "暂无已完成报告。RCA 分析完成后报告会归档到这里。",
};

function statusVariant(status: string): BadgeVariant {
  return STATUS_VARIANT[status] ?? (status ? "outline" : "secondary");
}

function severityVariant(severity: string): BadgeVariant {
  return SEVERITY_VARIANT[severity] ?? "secondary";
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/** 从复合 id（alert-12 / rca-34 / report-56）取出作战室路由需要的数字主键。 */
function incidentNumericId(item: IncidentItem): number | null {
  const match = /^(alert|rca|report)-(\d+)$/.exec(item.id);
  if (!match) return null;
  const parsed = Number.parseInt(match[2], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Page-local fetch: no api.ts change, bearer token stays in a header. */
async function fetchIncidents(
  tab: TabKey,
  page: number,
  search: string,
): Promise<IncidentResponse> {
  const qs = new URLSearchParams({
    tab,
    page: String(page),
    page_size: String(PAGE_SIZE),
  });
  if (search) qs.set("search", search);

  const headers: Record<string, string> = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api/incidents?${qs.toString()}`, { headers });

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
      const parsed = JSON.parse(raw) as {
        detail?: unknown;
        error?: { message?: unknown };
      };
      if (typeof parsed.detail === "string") message = parsed.detail;
      else if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // Non-JSON body — fall back to the status line below.
    }
    throw new Error(message || `加载事件失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as IncidentResponse;
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

export default function IncidentsPage() {
  const navigate = useNavigate();
  const { role } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── URL → state（tab / page / search 均以 query 为唯一来源）────────────
  const rawTab = searchParams.get("tab");
  const tab: TabKey = rawTab === "active" || rawTab === "reports" ? rawTab : "inbox";
  const rawPage = Number.parseInt(searchParams.get("page") ?? "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const search = (searchParams.get("search") ?? "").trim();

  const [searchInput, setSearchInput] = useState(search);
  const [data, setData] = useState<IncidentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canTerminate, setCanTerminate] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<IncidentItem | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const requestSeq = useRef(0);

  // 外部（浏览器前进/后退、直接改 URL）变更 search 时同步输入框。
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  // 输入防抖 350ms → URL；切搜索时回到第 1 页。
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === search) return;
    const timer = window.setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (trimmed) next.set("search", trimmed);
        else next.delete("search");
        next.set("page", "1");
        return next;
      }, { replace: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput, search, setSearchParams]);

  // 切 tab 时先清空旧数据，避免短暂把上一 tab 的行显示在新 tab 下。
  useEffect(() => {
    setData(null);
  }, [tab]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchIncidents(tab, page, search);
      if (seq === requestSeq.current) setData(res);
    } catch (err) {
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : "加载事件失败");
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [tab, page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // `rca_terminate` 决定「终止」按钮是否出现；权限接口失败时退回角色判断。
  useEffect(() => {
    let cancelled = false;
    authApi.permissions()
      .then((p) => {
        if (!cancelled) setCanTerminate(p.permissions.includes("rca_terminate"));
      })
      .catch(() => {
        if (cancelled) return;
        const normalized = (role || "").toUpperCase();
        setCanTerminate(normalized === "ADMIN" || normalized === "OPERATOR");
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  function changeTab(next: TabKey) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("tab", next);
      params.set("page", "1");
      return params;
    }, { replace: true });
  }

  function changePage(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set("page", String(next));
      return params;
    }, { replace: true });
  }

  function openRca(item: IncidentItem) {
    if (!item.rca_session_id) return;
    navigate(`/rca?s=${item.rca_session_id}`);
  }

  async function downloadReport(item: IncidentItem, format: "md" | "html") {
    const sessionId = item.rca_session_id;
    if (!sessionId) return;
    const key = `${item.id}:${format}`;
    setDownloading(key);
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

  async function confirmCancel() {
    const target = cancelTarget;
    if (!target?.rca_session_id) return;
    setCancelling(true);
    try {
      const res = await rca.cancel(target.rca_session_id);
      toast.success(
        res.hermes_stopped
          ? "已终止分析，并请求 Hermes 停止上游任务"
          : "已终止分析",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "终止失败");
    } finally {
      setCancelling(false);
      setCancelTarget(null);
      await load();
    }
  }

  const meta = TAB_META[tab];
  const TabIcon = meta.icon;
  const counts = data?.counts;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = data?.items ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">事件中心</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            收件箱 / 进行中 / 报告库 统一视图 · 聚合告警、RCA 会话与报告（只读）
          </p>
        </div>
        <Button
          variant="ghostMuted"
          size="icon-sm"
          onClick={() => void load()}
          aria-label="刷新事件"
          title="刷新"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ── Tabs ───────────────────────────────────────────── */}
      <Tabs value={tab} onValueChange={(value) => changeTab(value as TabKey)}>
        <TabsList>
          {TAB_ORDER.map((key) => {
            const Icon = TAB_META[key].icon;
            const count = counts?.[key] ?? 0;
            return (
              <TabsTrigger key={key} value={key}>
                <Icon className="h-3.5 w-3.5" />
                {TAB_META[key].label}
                <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* ── Unified list ───────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <TabIcon className="h-4 w-4" /> {meta.label}
              <span className="text-xs font-normal text-muted-foreground">{meta.hint}</span>
            </CardTitle>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="搜索标题 / 服务 / ID"
                aria-label="搜索事件"
                className="h-8 w-56 pl-7 text-xs"
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {error ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-status-active">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                重试
              </Button>
            </div>
          ) : loading && !data ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {search ? `没有匹配「${search}」的事件` : EMPTY_HINT[tab]}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="px-4 py-2 text-left font-medium">类型</th>
                      <th className="px-4 py-2 text-left font-medium">事件</th>
                      <th className="px-4 py-2 text-left font-medium">服务</th>
                      <th className="px-4 py-2 text-left font-medium">级别</th>
                      <th className="px-4 py-2 text-left font-medium">状态</th>
                      <th className="px-4 py-2 text-left font-medium">时间</th>
                      <th className="px-4 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className="border-b border-border/50 transition-colors hover:bg-muted/50"
                      >
                        <td className="px-4 py-2.5">
                          <Badge variant={KIND_VARIANT[item.kind]} className="text-[11px]">
                            {KIND_LABEL[item.kind]}
                          </Badge>
                        </td>
                        <td className="max-w-[360px] px-4 py-2.5">
                          <button
                            type="button"
                            className="line-clamp-2 text-left text-xs text-text-primary hover:text-interactive-primary"
                            title={item.title}
                            onClick={() => {
                              if (item.rca_session_id) openRca(item);
                              else navigate("/alerts");
                            }}
                          >
                            {item.title || "—"}
                          </button>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-text-secondary">
                          {item.service || "—"}
                        </td>
                        <td className="px-4 py-2.5">
                          {item.severity ? (
                            <Badge variant={severityVariant(item.severity)} className="text-[11px]">
                              {item.severity}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge variant={statusVariant(item.status)} className="text-[11px]">
                            {STATUS_LABEL[item.status] || item.status}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                          {fmtTime(item.created_at)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            {(() => {
                              const numericId = incidentNumericId(item);
                              return (
                                <Button
                                  variant="ghostMuted"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={numericId === null}
                                  onClick={() => {
                                    if (numericId === null) return;
                                    navigate(`/incidents/${item.kind}/${numericId}`);
                                  }}
                                  title="打开事件作战室"
                                >
                                  <ArrowUpRight className="h-3.5 w-3.5" /> 作战室
                                </Button>
                              );
                            })()}
                            {item.rca_session_id !== null && (
                              <Button
                                variant="ghostMuted"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => openRca(item)}
                                title="打开 RCA 会话"
                              >
                                查看 RCA <ArrowUpRight className="h-3 w-3" />
                              </Button>
                            )}
                            {item.kind === "alert" && (
                              <Button
                                variant="ghostMuted"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => navigate("/alerts")}
                                title="前往告警中心处理"
                              >
                                <BellRing className="h-3.5 w-3.5" /> 告警中心
                              </Button>
                            )}
                            {item.kind === "report" && (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={downloading === `${item.id}:md`}
                                  onClick={() => void downloadReport(item, "md")}
                                  title="下载 Markdown 报告"
                                >
                                  <Download className="h-3.5 w-3.5" /> MD
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={downloading === `${item.id}:html`}
                                  onClick={() => void downloadReport(item, "html")}
                                  title="下载 HTML 报告"
                                >
                                  <Download className="h-3.5 w-3.5" /> HTML
                                </Button>
                              </>
                            )}
                            {item.kind === "rca" &&
                              canTerminate &&
                              item.actions.includes("cancel") && (
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() => setCancelTarget(item)}
                                  title="终止分析"
                                >
                                  <Ban className="h-3.5 w-3.5" /> 终止
                                </Button>
                              )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                <span>
                  共 {total} 条 · 第 {Math.min(page, totalPages)}/{totalPages} 页
                </span>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={page <= 1 || loading}
                    onClick={() => changePage(page - 1)}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={page >= totalPages || loading}
                    onClick={() => changePage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
        title="终止 RCA 分析"
        description={`确认终止会话 #${cancelTarget?.rca_session_id ?? ""}？终止后状态记为失败，已写入的时间线会保留。`}
        confirmLabel="终止"
        variant="destructive"
        isLoading={cancelling}
        onConfirm={() => void confirmCancel()}
      />
    </div>
  );
}
