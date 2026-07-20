import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Activity, Eye, RefreshCw, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { rca, type RcaSessionDetail, type RcaSessionSummary, type QueueStatus } from "@/lib/api";
import { toast } from "sonner";

const statusLabel: Record<string, string> = { completed: "完成", failed: "失败", running: "运行中", queued: "排队中" };

export default function RcaPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<RcaSessionSummary[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<RcaSessionDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([rca.list(1, 20), rca.queue()])
      .then(([s, q]) => { setSessions(s.items); setQueue(q); })
      .catch(() => toast.error("加载 RCA 数据失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const sid = searchParams.get("s");
    if (sid) rca.detail(Number(sid)).then((d) => { setDetail(d); setDetailOpen(true); }).catch(() => {});
  }, [searchParams]);

  async function openDetail(sid: number) {
    setSearchParams({ s: String(sid) });
    try { const d = await rca.detail(sid); setDetail(d); setDetailOpen(true); }
    catch { toast.error("加载详情失败"); }
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">RCA 分析</h2>
          <p className="text-sm text-muted-foreground mt-0.5">自动触发记录 · 活跃 {queue?.active_count ?? "—"} · 排队 {queue?.queued_count ?? "—"}</p>
        </div>
        <Button variant="ghostMuted" size="icon-sm" onClick={refresh} aria-label="刷新"><RefreshCw className="h-4 w-4" /></Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Activity className="h-4 w-4" /> 自动触发记录</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">暂无 RCA 会话</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs">
                <th className="text-left px-4 py-2 font-medium">ID</th><th className="text-left px-4 py-2 font-medium">规则</th><th className="text-left px-4 py-2 font-medium">状态</th><th className="text-left px-4 py-2 font-medium">根因</th><th className="text-left px-4 py-2 font-medium">时间</th><th className="text-right px-4 py-2 font-medium">操作</th>
              </tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="px-4 py-2.5 font-mono text-xs">#{s.id}</td>
                    <td className="px-4 py-2.5">{s.rule_name || "—"}</td>
                    <td className="px-4 py-2.5"><Badge variant={s.status === "completed" ? "success" : s.status === "failed" ? "destructive" : s.status === "running" ? "info" : "secondary"} className="text-[11px]">{statusLabel[s.status] || s.status}</Badge></td>
                    <td className="px-4 py-2.5 max-w-xs truncate">{s.root_cause_summary || "—"}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{s.created_at ? new Date(s.created_at).toLocaleString() : ""}</td>
                    <td className="px-4 py-2.5 text-right"><Button variant="ghostMuted" size="icon-sm" onClick={() => openDetail(s.id)}><Eye className="h-3.5 w-3.5" /></Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Sheet open={detailOpen} onOpenChange={(o) => { if (!o) { setDetailOpen(false); setSearchParams({}); } }}>
        <SheetContent side="right" className="w-[420px] sm:max-w-[420px] p-0">
          {detail ? (
            <>
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold">RCA #{detail.id}</h3>
                <button onClick={() => { setDetailOpen(false); setSearchParams({}); }} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
              </div>
              <div className="p-4 space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-1"><span className="text-muted-foreground">状态</span><Badge variant={detail.status === "completed" ? "success" : detail.status === "failed" ? "destructive" : "secondary"}>{statusLabel[detail.status] || detail.status}</Badge></div>
                <div><span className="text-muted-foreground">根因</span><p className="mt-0.5">{detail.root_cause_summary || "—"}</p></div>
                {detail.timeline.length > 0 && (
                  <div><h4 className="font-medium mb-2">时间线</h4>
                    <div className="space-y-1.5">{detail.timeline.map((t, i) => (
                      <div key={i} className="flex gap-2 text-xs"><span className="text-muted-foreground w-14 shrink-0">{new Date(t.timestamp).toLocaleTimeString()}</span><span>{t.event}</span></div>
                    ))}</div>
                  </div>
                )}
              </div>
            </>
          ) : <div className="p-4"><Skeleton className="h-40 w-full" /></div>}
        </SheetContent>
      </Sheet>
    </div>
  );
}
