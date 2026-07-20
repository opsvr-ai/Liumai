import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, Eye, RefreshCw, FileText, CheckCircle, XCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { historyApi, type RcaSessionSummary } from "@/lib/api";
import { toast } from "sonner";

const statusLabel: Record<string, string> = { completed: "完成", failed: "失败", running: "运行中", queued: "排队中" };

export default function HistoryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<RcaSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    historyApi.rcaList(1, 50).then((r) => setItems(r.items)).catch(() => toast.error("加载历史失败")).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const stats = useMemo(() => ({
    total: items.length,
    completed: items.filter((i) => i.status === "completed").length,
    failed: items.filter((i) => i.status === "failed").length,
    running: items.filter((i) => i.status === "running" || i.status === "queued").length,
  }), [items]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div><h2 className="text-lg font-semibold">历史记录</h2><p className="text-sm text-muted-foreground mt-0.5">所有 RCA 分析会话</p></div>
        <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {!loading && items.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "总计", value: stats.total, icon: FileText, color: "text-interactive-primary", bg: "bg-interactive-primary/10" },
            { label: "完成", value: stats.completed, icon: CheckCircle, color: "text-status-resolved", bg: "bg-status-resolved/10" },
            { label: "失败", value: stats.failed, icon: XCircle, color: "text-status-active", bg: "bg-status-active/10" },
            { label: "运行中", value: stats.running, icon: PlayCircle, color: "text-amber-600", bg: "bg-amber-50" },
          ].map((s) => (
            <Card key={s.label}><CardContent className="p-3 flex items-center gap-3">
              <div className={`shrink-0 h-9 w-9 rounded-lg ${s.bg} flex items-center justify-center`}><s.icon className={`h-4 w-4 ${s.color}`} /></div>
              <div><p className="text-lg font-bold text-text-primary">{s.value}</p><p className="text-[11px] text-muted-foreground">{s.label}</p></div>
            </CardContent></Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium flex items-center gap-2"><Clock className="h-4 w-4" /> 全部会话</CardTitle></CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">暂无历史记录</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs">
                <th className="text-left px-4 py-2 font-medium">ID</th><th className="text-left px-4 py-2 font-medium">类型</th><th className="text-left px-4 py-2 font-medium">状态</th><th className="text-left px-4 py-2 font-medium">规则</th><th className="text-left px-4 py-2 font-medium">根因</th><th className="text-left px-4 py-2 font-medium">时间</th><th className="text-right px-4 py-2 font-medium">操作</th>
              </tr></thead>
              <tbody>{items.map((r) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="px-4 py-2.5 font-mono text-xs">#{r.id}</td>
                  <td className="px-4 py-2.5 text-xs">{r.trigger_type === "manual" ? "手动" : "被动"}</td>
                  <td className="px-4 py-2.5"><Badge variant={r.status === "completed" ? "success" : r.status === "failed" ? "destructive" : r.status === "running" ? "info" : "secondary"} className="text-[11px]">{statusLabel[r.status] || r.status}</Badge></td>
                  <td className="px-4 py-2.5">{r.rule_name || "—"}</td>
                  <td className="px-4 py-2.5 max-w-xs truncate">{r.root_cause_summary || "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.created_at ? new Date(r.created_at).toLocaleString() : ""}</td>
                  <td className="px-4 py-2.5 text-right"><Button variant="ghostMuted" size="icon-sm" onClick={() => navigate(`/rca?s=${r.id}`)}><Eye className="h-3.5 w-3.5" /></Button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
