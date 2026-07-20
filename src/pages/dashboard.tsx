import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Shield, Clock, CheckCircle2, XCircle, ArrowRight,
  MessageCircle, Activity, Wrench, Database, AlertTriangle, Zap,
  BarChart3, PlayCircle, RefreshCw, Server,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { LiumaiLogo } from "@/components/liumai-logo";
import { rca, historyApi, ruleApi, type QueueStatus, type RcaSessionSummary, hermesDiscovery } from "@/lib/api";

const statusVariant = (s: string) =>
  s === "completed" ? "success" : s === "failed" ? "destructive" : s === "running" ? "info" : "secondary";

export default function DashboardPage() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [recent, setRecent] = useState<RcaSessionSummary[]>([]);
  const [ruleCount, setRuleCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [hermesOk, setHermesOk] = useState<boolean | null>(null);
  const [hermesLatency, setHermesLatency] = useState<number>(0);

  const loadData = () => {
    setLoading(true);
    Promise.all([
      rca.queue(), historyApi.rcaList(1, 6), ruleApi.list(1, 50),
      hermesDiscovery.health().catch(() => ({ ok: false, latency_ms: 0 })),
    ])
      .then(([q, h, rules, health]) => {
        setQueue(q); setRecent(h.items); setRuleCount(rules.total || rules.items?.length || 0);
        setHermesOk(health.ok); setHermesLatency(health.latency_ms);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);
  // Poll health every 30s
  useEffect(() => {
    const t = setInterval(() => {
      hermesDiscovery.health().then((h) => { setHermesOk(h.ok); setHermesLatency(h.latency_ms); }).catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => ({
    active: queue?.active_count ?? 0,
    queued: queue?.queued_count ?? 0,
    completed: recent.filter(r => r.status === "completed").length,
    failed: recent.filter(r => r.status === "failed").length,
  }), [queue, recent]);

  const shortcuts = [
    { label: "智能对话", icon: MessageCircle, color: "text-indigo-600", bg: "bg-indigo-50", path: "/chat", desc: "与 AI 助手对话" },
    { label: "RCA 分析", icon: Activity, color: "text-interactive-primary", bg: "bg-interactive-primary/10", path: "/rca", desc: "查看故障根因" },
    { label: "技能中心", icon: Wrench, color: "text-amber-600", bg: "bg-amber-50", path: "/skills", desc: "浏览 Agent 能力" },
    { label: "数据源", icon: Database, color: "text-emerald-600", bg: "bg-emerald-50", path: "/datasources", desc: "管理监控连接" },
  ];

  return (
    <div className="p-4 md:p-6 space-y-8 max-w-6xl mx-auto">
      {/* ── Hero ──────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
        <div className="shrink-0">
          <LiumaiLogo size={64} className="text-interactive-primary" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">六脉智能运维数智平台</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-lg">
            基于 AI 的故障根因分析平台，实时监控 · 智能诊断 · 自动处置
          </p>
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            {loading ? <Skeleton className="h-5 w-24" /> : (
              <>
                {queue && (
                  <Badge variant={queue.active_count > 0 ? "info" : "outline"} className="gap-1">
                    {queue.active_count > 0 ? <PlayCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                    {queue.active_count > 0 ? `${queue.active_count} 个分析运行中` : "系统就绪"}
                  </Badge>
                )}
                {hermesOk !== null && (
                  <Badge variant={hermesOk ? "success" : "destructive"} className="gap-1">
                    <Server className="h-3 w-3" />
                    Hermes {hermesOk ? `正常 · ${hermesLatency}ms` : "不可达"}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  告警规则 {ruleCount} 条 · 并发上限 {queue?.max_concurrency ?? "—"}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── RCA Status Cards ────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">RCA 队列状态</h3>
          <Button variant="ghostMuted" size="sm" onClick={loadData}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />刷新
          </Button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "活跃会话", value: stats.active, icon: PlayCircle, color: "text-interactive-primary", bg: "bg-interactive-primary/10", sub: `最多 ${queue?.max_concurrency ?? "—"} 并发` },
            { label: "排队等待", value: stats.queued, icon: Clock, color: "text-amber-600", bg: "bg-amber-50", sub: "等待资源调度" },
            { label: "已完成", value: stats.completed, icon: CheckCircle2, color: "text-status-resolved", bg: "bg-status-resolved/10", sub: `最近 ${recent.length} 条` },
            { label: "分析失败", value: stats.failed, icon: XCircle, color: "text-status-active", bg: "bg-status-active/10", sub: "需要关注" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={`shrink-0 h-10 w-10 rounded-xl ${s.bg} flex items-center justify-center`}>
                  <s.icon className={`h-5 w-5 ${s.color}`} />
                </div>
                <div>
                  <p className="text-2xl font-bold text-text-primary">{loading ? "—" : s.value}</p>
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                  <p className="text-[10px] text-muted-foreground/60">{s.sub}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* ── Quick Shortcuts ─────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-text-primary mb-3">快速入口</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {shortcuts.map((s) => (
            <button
              key={s.path}
              type="button"
              onClick={() => navigate(s.path)}
              className="group flex flex-col items-start gap-2 p-4 rounded-xl border border-border bg-surface-secondary/30 hover:bg-surface-secondary hover:border-interactive-primary/20 hover:shadow-sm transition-all duration-200 text-left"
            >
              <div className={`shrink-0 h-10 w-10 rounded-xl ${s.bg} flex items-center justify-center group-hover:scale-110 transition-transform duration-200`}>
                <s.icon className={`h-5 w-5 ${s.color}`} />
              </div>
              <div>
                <p className="text-sm font-medium text-text-primary group-hover:text-interactive-primary transition-colors">{s.label}</p>
                <p className="text-[11px] text-muted-foreground">{s.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Recent Sessions ──────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text-primary">最近分析会话</h3>
          <button type="button" onClick={() => navigate("/history")} className="text-xs text-interactive-primary hover:underline flex items-center gap-1">
            查看全部 <ArrowRight className="h-3 w-3" />
          </button>
        </div>
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : recent.length === 0 ? (
              <div className="py-12 text-center">
                <BarChart3 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">暂无分析记录</p>
                <p className="text-xs text-muted-foreground/60 mt-1">触发一次 RCA 分析后，结果将显示在这里</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left px-4 py-2.5 font-medium">ID</th>
                    <th className="text-left px-4 py-2.5 font-medium">类型</th>
                    <th className="text-left px-4 py-2.5 font-medium">状态</th>
                    <th className="text-left px-4 py-2.5 font-medium">根因摘要</th>
                    <th className="text-left px-4 py-2.5 font-medium">时间</th>
                    <th className="text-right px-4 py-2.5 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {recent.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-secondary/30 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">#{r.id}</td>
                      <td className="px-4 py-2.5 text-xs">{r.trigger_type === "manual" ? "手动" : "被动"}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={statusVariant(r.status)} className="text-[11px]">
                          {r.status === "completed" ? "完成" : r.status === "failed" ? "失败" : r.status === "running" ? "运行中" : r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text-secondary max-w-[280px] truncate">
                        {r.root_cause_summary || r.rule_name || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {r.created_at ? new Date(r.created_at).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button variant="ghostMuted" size="icon-sm" onClick={() => navigate(`/rca?s=${r.id}`)} title="查看详情">
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Platform Summary ─────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className={hermesOk ? "bg-gradient-to-br from-status-resolved/5 to-transparent" : "bg-gradient-to-br from-status-active/5 to-transparent"}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Server className={`h-4 w-4 ${hermesOk ? "text-status-resolved" : "text-status-active"}`} />
              <p className="text-sm font-medium text-text-primary">AI 引擎</p>
              {hermesOk !== null && <span className={`ml-auto h-2 w-2 rounded-full ${hermesOk ? "bg-status-resolved" : "bg-status-active"} animate-pulse`} />}
            </div>
            <p className="text-xs text-muted-foreground">
              {hermesOk === null ? "检测中…" : hermesOk ? `Hermes 连接正常，延迟 ${hermesLatency}ms` : "Hermes 服务不可达，请检查系统设置中的配置"}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-status-resolved/5 to-transparent">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-status-resolved" />
              <p className="text-sm font-medium text-text-primary">告警规则</p>
            </div>
            <p className="text-xs text-muted-foreground">
              当前 {ruleCount} 条规则，覆盖 Prometheus、Zabbix、ClickHouse、Kafka 等多种数据源，实时匹配自动触发 RCA。
            </p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-amber-50 to-transparent">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Wrench className="h-4 w-4 text-amber-600" />
              <p className="text-sm font-medium text-text-primary">技能中心</p>
            </div>
            <p className="text-xs text-muted-foreground">
              缓存自动刷新，确保技能列表始终最新。可在系统设置中调整刷新周期。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
