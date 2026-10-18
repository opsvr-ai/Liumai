import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  CheckCircle2,
  XCircle,
  MessageCircle,
  PlayCircle,
  RefreshCw,
  Server,
  Wrench,
  Database,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { LiumaiLogo } from "@/components/liumai-logo";
import { rca, historyApi, ruleApi, type QueueStatus, type RcaSessionSummary, hermesDiscovery } from "@/lib/api";

/** Dashboard keeps only the latest 3 sessions — full list/actions live on /rca. */
const RECENT_LIMIT = 3;

function statusMeta(status?: string) {
  const normalized = status?.toUpperCase() ?? "";
  if (normalized === "COMPLETED") return { label: "完成", variant: "success" as const };
  if (normalized === "FAILED") return { label: "失败", variant: "destructive" as const };
  if (normalized === "RUNNING") return { label: "运行中", variant: "info" as const };
  if (normalized === "QUEUED") return { label: "排队中", variant: "secondary" as const };
  return { label: status ?? "—", variant: "secondary" as const };
}

function formatTime(value?: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
      rca.queue(),
      historyApi.rcaList(1, RECENT_LIMIT),
      ruleApi.list(1, 50),
      hermesDiscovery.health().catch(() => ({ ok: false, latency_ms: 0 })),
    ])
      .then(([q, h, rules, health]) => {
        setQueue(q);
        setRecent(h.items.slice(0, RECENT_LIMIT));
        setRuleCount(rules.total || rules.items?.length || 0);
        setHermesOk(health.ok);
        setHermesLatency(health.latency_ms);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

  // Poll health every 30s
  useEffect(() => {
    const timer = setInterval(() => {
      hermesDiscovery
        .health()
        .then((h) => {
          setHermesOk(h.ok);
          setHermesLatency(h.latency_ms);
        })
        .catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  const stats = useMemo(
    () => ({
      active: queue?.active_count ?? 0,
      queued: queue?.queued_count ?? 0,
      completed: recent.filter((r) => r.status?.toUpperCase() === "COMPLETED").length,
      failed: recent.filter((r) => r.status?.toUpperCase() === "FAILED").length,
    }),
    [queue, recent],
  );

  const shortcuts = [
    {
      label: "智能对话",
      icon: MessageCircle,
      color: "text-interactive-primary",
      bg: "bg-interactive-primary/10",
      path: "/chat",
      desc: "与 AI 助手对话",
    },
    {
      label: "RCA 分析",
      icon: Activity,
      color: "text-status-active",
      bg: "bg-status-active/10",
      path: "/rca",
      desc: "查看故障根因",
    },
    {
      label: "技能中心",
      icon: Wrench,
      color: "text-status-investigating",
      bg: "bg-status-investigating/10",
      path: "/skills",
      desc: "浏览 Agent 能力",
    },
    {
      label: "数据源",
      icon: Database,
      color: "text-status-resolved",
      bg: "bg-status-resolved/10",
      path: "/datasources",
      desc: "管理监控连接",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-4 md:p-6">
      {/* ── Hero ──────────────────────────────────────────── */}
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="shrink-0">
          <LiumaiLogo size={64} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">六脉智能运维数智平台</h1>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">
            基于 AI 的故障根因分析平台，实时监控 · 智能诊断 · 自动处置
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {loading ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <>
                {queue && (
                  <Badge variant={queue.active_count > 0 ? "info" : "outline"} className="gap-1">
                    {queue.active_count > 0 ? (
                      <PlayCircle className="h-3 w-3" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" />
                    )}
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
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">RCA 队列状态</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/rca?status=running")}
              title="查看运行中的 RCA 会话"
            >
              <Activity className="mr-1 h-3.5 w-3.5" />
              进行中事件 {stats.active}
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
            <Button variant="ghostMuted" size="sm" onClick={loadData}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              刷新
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            {
              label: "活跃会话",
              value: stats.active,
              icon: PlayCircle,
              color: "text-interactive-primary",
              bg: "bg-interactive-primary/10",
              sub: `最多 ${queue?.max_concurrency ?? "—"} 并发`,
            },
            {
              label: "排队等待",
              value: stats.queued,
              icon: Clock,
              color: "text-status-investigating",
              bg: "bg-status-investigating/10",
              sub: "等待资源调度",
            },
            {
              label: "已完成",
              value: stats.completed,
              icon: CheckCircle2,
              color: "text-status-resolved",
              bg: "bg-status-resolved/10",
              sub: `最近 ${recent.length} 条`,
            },
            {
              label: "分析失败",
              value: stats.failed,
              icon: XCircle,
              color: "text-status-active",
              bg: "bg-status-active/10",
              sub: "需要关注",
            },
          ].map((item) => (
            <Card key={item.label}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${item.bg}`}>
                  <item.icon className={`h-5 w-5 ${item.color}`} />
                </div>
                <div>
                  <p className="text-2xl font-bold text-text-primary">{loading ? "—" : item.value}</p>
                  <p className="text-[11px] text-muted-foreground">{item.label}</p>
                  <p className="text-[10px] text-muted-foreground/60">{item.sub}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ── Quick Shortcuts ─────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-text-primary">快速入口</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {shortcuts.map((shortcut) => (
            <button
              key={shortcut.path}
              type="button"
              onClick={() => navigate(shortcut.path)}
              className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-surface-secondary/30 p-4 text-left transition-all duration-200 hover:border-interactive-primary/20 hover:bg-surface-secondary hover:shadow-sm"
            >
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${shortcut.bg} transition-transform duration-200 group-hover:scale-110`}
              >
                <shortcut.icon className={`h-5 w-5 ${shortcut.color}`} />
              </div>
              <div>
                <p className="text-sm font-medium text-text-primary transition-colors group-hover:text-interactive-primary">
                  {shortcut.label}
                </p>
                <p className="text-[11px] text-muted-foreground">{shortcut.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ── Recent Sessions (summary only, max 3) ────────────── */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">最近分析会话</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">仅摘要 · 完整列表与操作请前往 RCA 分析</p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/rca")}
            className="flex items-center gap-1 text-xs text-interactive-primary hover:underline"
          >
            全部会话 <ArrowRight className="h-3 w-3" />
          </button>
        </div>
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: RECENT_LIMIT }).map((_, index) => (
                  <Skeleton key={index} className="h-10 w-full" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <div className="py-12 text-center">
                <BarChart3 className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">暂无分析记录</p>
                <p className="mt-1 text-xs text-muted-foreground/60">触发一次 RCA 分析后，结果将显示在这里</p>
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {recent.slice(0, RECENT_LIMIT).map((session) => {
                  const meta = statusMeta(session.status);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => navigate(`/rca?s=${session.id}`)}
                      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
                      aria-label={`查看会话 #${session.id} 详情`}
                    >
                      <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">
                        #{session.id}
                      </span>
                      <Badge variant={meta.variant} className="text-[11px]">
                        {meta.label}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                        {session.root_cause_summary || session.rule_name || "—"}
                      </span>
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
                        {formatTime(session.created_at)}
                      </span>
                      <ArrowUpRight
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-[11px] text-muted-foreground">
                最多显示最近 {RECENT_LIMIT} 条摘要
              </span>
              <button
                type="button"
                onClick={() => navigate("/history")}
                className="flex items-center gap-1 text-[11px] text-interactive-primary hover:underline"
              >
                浏览历史归档 <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Platform Summary ─────────────────────────────────── */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card
          className={
            hermesOk
              ? "bg-gradient-to-br from-status-resolved/5 to-transparent"
              : "bg-gradient-to-br from-status-active/5 to-transparent"
          }
        >
          <CardContent className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Server className={`h-4 w-4 ${hermesOk ? "text-status-resolved" : "text-status-active"}`} />
              <p className="text-sm font-medium text-text-primary">AI 引擎</p>
              {hermesOk !== null && (
                <span
                  className={`ml-auto h-2 w-2 animate-pulse rounded-full ${
                    hermesOk ? "bg-status-resolved" : "bg-status-active"
                  }`}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {hermesOk === null
                ? "检测中…"
                : hermesOk
                  ? `Hermes 连接正常，延迟 ${hermesLatency}ms`
                  : "Hermes 服务不可达，请检查系统设置中的配置"}
            </p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-status-resolved/5 to-transparent">
          <CardContent className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-status-resolved" />
              <p className="text-sm font-medium text-text-primary">告警规则</p>
            </div>
            <p className="text-xs text-muted-foreground">
              当前 {ruleCount} 条规则，覆盖 Prometheus、Zabbix、ClickHouse、Kafka 等多种数据源，实时匹配自动触发 RCA。
            </p>
          </CardContent>
        </Card>
        <Card className="bg-gradient-to-br from-status-investigating/5 to-transparent">
          <CardContent className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Wrench className="h-4 w-4 text-status-investigating" />
              <p className="text-sm font-medium text-text-primary">技能中心</p>
            </div>
            <p className="text-xs text-muted-foreground">
              缓存自动刷新，确保技能列表始终最新。可在系统设置中调整刷新周期。
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
