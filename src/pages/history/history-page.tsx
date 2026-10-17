import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, ArrowUpRight, CheckCircle, Clock, FileText, PlayCircle, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { historyApi, type RcaSessionSummary } from "@/lib/api";
import { toast } from "sonner";

const statusLabel: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  running: "运行中",
  queued: "排队中",
  COMPLETED: "完成",
  FAILED: "失败",
  RUNNING: "运行中",
  QUEUED: "排队中",
};

/** Rows shown per page (client-side pagination). */
const PAGE_SIZE = 20;
/** Page size used when pulling rows from the API (backend max is 100). */
const FETCH_PAGE_SIZE = 100;
/** Safety cap so a huge history can never fan out into unbounded requests. */
const MAX_FETCH_PAGES = 10;

export default function HistoryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<RcaSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Load the history once and paginate entirely on the client. More than
      // one request is only needed once the backend holds >100 sessions; the
      // cap keeps the worst case bounded.
      const first = await historyApi.rcaList(1, FETCH_PAGE_SIZE);
      const loaded = [...first.items];
      const pages = Math.min(
        Math.max(1, Math.ceil(first.total / FETCH_PAGE_SIZE)),
        MAX_FETCH_PAGES,
      );
      for (let p = 2; p <= pages; p++) {
        const res = await historyApi.rcaList(p, FETCH_PAGE_SIZE);
        if (res.items.length === 0) break;
        loaded.push(...res.items);
      }
      setItems(loaded);
    } catch {
      toast.error("加载历史失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedItems = items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const stats = useMemo(
    () => ({
      total: items.length,
      completed: items.filter((i) => i.status?.toUpperCase() === "COMPLETED").length,
      failed: items.filter((i) => i.status?.toUpperCase() === "FAILED").length,
      running: items.filter((i) => ["RUNNING", "QUEUED"].includes(i.status?.toUpperCase() ?? "")).length,
    }),
    [items],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">历史记录</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            RCA 会话归档 · 只读视图，分析详情与操作由 RCA 分析页承载
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/rca"
            className="inline-flex items-center gap-1 text-xs font-medium text-interactive-primary hover:underline"
          >
            前往 RCA 分析 <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh} aria-label="刷新历史记录">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {!loading && items.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            {
              label: "总计",
              value: stats.total,
              icon: FileText,
              color: "text-interactive-primary",
              bg: "bg-interactive-primary/10",
            },
            {
              label: "完成",
              value: stats.completed,
              icon: CheckCircle,
              color: "text-status-resolved",
              bg: "bg-status-resolved/10",
            },
            {
              label: "失败",
              value: stats.failed,
              icon: XCircle,
              color: "text-status-active",
              bg: "bg-status-active/10",
            },
            {
              label: "运行中",
              value: stats.running,
              icon: PlayCircle,
              color: "text-status-investigating",
              bg: "bg-status-investigating/10",
            },
          ].map((item) => (
            <Card key={item.label}>
              <CardContent className="flex items-center gap-3 p-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${item.bg}`}>
                  <item.icon className={`h-4 w-4 ${item.color}`} />
                </div>
                <div>
                  <p className="text-lg font-bold text-text-primary">{item.value}</p>
                  <p className="text-[11px] text-muted-foreground">{item.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Archive table (read-only) ──────────────────────── */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Clock className="h-4 w-4" /> 会话归档
          </CardTitle>
          {!loading && <span className="text-[11px] text-muted-foreground">只读 · 共 {items.length} 条</span>}
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">暂无历史记录</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">ID</th>
                    <th className="px-4 py-2 text-left font-medium">类型</th>
                    <th className="px-4 py-2 text-left font-medium">状态</th>
                    <th className="px-4 py-2 text-left font-medium">规则</th>
                    <th className="px-4 py-2 text-left font-medium">根因</th>
                    <th className="px-4 py-2 text-left font-medium">时间</th>
                    <th className="px-4 py-2 text-right font-medium">RCA 详情</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedItems.map((session) => (
                    <tr key={session.id} className="border-b border-border/50 transition-colors hover:bg-muted/50">
                      <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">#{session.id}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {session.trigger_type?.toUpperCase() === "ACTIVE" ? "手动" : "告警"}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge
                          variant={
                            session.status?.toUpperCase() === "COMPLETED"
                              ? "success"
                              : session.status?.toUpperCase() === "FAILED"
                                ? "destructive"
                                : session.status?.toUpperCase() === "RUNNING"
                                  ? "info"
                                  : "secondary"
                          }
                          className="text-[11px]"
                        >
                          {statusLabel[session.status] || session.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">{session.rule_name || "—"}</td>
                      <td className="max-w-xs truncate px-4 py-2.5 text-text-secondary">
                        {session.root_cause_summary || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {session.created_at ? new Date(session.created_at).toLocaleString() : ""}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {/* Archive stays read-only: detail + any re-analysis
                            action lives on the RCA page, not here. */}
                        <button
                          type="button"
                          onClick={() => navigate(`/rca?s=${session.id}`)}
                          className="inline-flex items-center gap-1 text-xs text-interactive-primary hover:underline"
                          aria-label={`查看会话 #${session.id} 的 RCA 详情`}
                        >
                          查看 RCA 详情 <ArrowUpRight className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                <span>
                  共 {items.length} 条 · 第 {currentPage}/{totalPages} 页
                </span>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
