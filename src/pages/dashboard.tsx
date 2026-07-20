import { useEffect, useState } from "react";
import { Shield, AlertTriangle, CheckCircle2, Clock, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { rca, historyApi, type QueueStatus, type RcaSessionSummary } from "@/lib/api";

const statusVariant = (s: string) =>
  s === "completed" ? "success" : s === "failed" ? "destructive" : s === "running" ? "info" : "secondary";

export default function DashboardPage() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [recent, setRecent] = useState<RcaSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([rca.queue(), historyApi.rcaList(1, 5)])
      .then(([q, h]) => { setQueue(q); setRecent(h.items); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h2 className="text-lg font-semibold">概览</h2>
        <p className="text-sm text-muted-foreground mt-0.5">RCA 队列状态与最近分析</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">活跃会话</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{queue?.active_count ?? "—"}</div>}
            <p className="text-xs text-muted-foreground mt-1">最多 {queue?.max_concurrency ?? "—"} 并发</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">排队中</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{queue?.queued_count ?? "—"}</div>}
            <p className="text-xs text-muted-foreground mt-1">等待资源调度</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">已完成</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{recent.filter(r => r.status === "completed").length}</div>}
            <p className="text-xs text-muted-foreground mt-1">最近 5 条</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">告警规则</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="text-2xl font-bold">—</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">最近分析会话</CardTitle>
          <button type="button" onClick={() => navigate("/history")} className="text-xs text-interactive-primary hover:underline flex items-center gap-1">
            查看全部 <ArrowRight className="h-3 w-3" />
          </button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无分析记录。触发一次 RCA 开始。</p>
          ) : (
            <div className="space-y-1">
              {recent.map((r) => (
                <button
                  key={r.id} type="button"
                  onClick={() => navigate(`/rca?s=${r.id}`)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted transition-colors text-left"
                >
                  <Badge variant={statusVariant(r.status)} className="shrink-0 text-[11px]">
                    {r.status === "completed" ? "完成" : r.status === "failed" ? "失败" : r.status === "running" ? "运行中" : r.status}
                  </Badge>
                  <span className="text-sm truncate flex-1">{r.root_cause_summary || `RCA #${r.id}`}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{r.created_at ? new Date(r.created_at).toLocaleDateString() : ""}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
