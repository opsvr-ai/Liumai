import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BellRing,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  PlayCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/components/auth/auth-context";
import { PermissionGate } from "@/components/auth/permission-gate";
import { usePermissions } from "@/hooks/usePermissions";
import {
  CheckChip,
  CollapsibleList,
  Field,
  GroupCard,
  POLICY_INPUT_CLASS,
  POLICY_SELECT_CLASS,
  POLICY_TEXTAREA_CLASS,
  ToggleRow,
} from "@/components/alerts/policy-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  alertsApi,
  rca,
  type AlertOut,
  type AlertPolicy,
  type AlertStats,
  type QueueStatus,
  type WebhookInfo,
  type WebhookTokenCreated,
  type WebhookTokenItem,
  type WebhookTokenList,
} from "@/lib/api";
import { toast } from "sonner";

type TabKey = "inbox" | "trash" | "policy";

/* ── 通知通道（多通道通知）────────────────────────────────────────
 *
 * `AlertPolicy.notify` 只有 enabled / wecom_chat_id：后端 save_policy 会把
 * notify 对象剥离后只持久化这两个字段。为了让 webhook / 邮件选项也能保存，
 * 这里把它们同时写入根级 `notify_ext`（会被策略 JSON 的通用深合并保留），
 * 后端 notify.py 读取时优先 policy.notify.*、其次 policy.notify_ext.*。
 * 不新增 api.ts 方法，仍复用 getPolicy / savePolicy。
 */
type NotifyChannel = "wecom" | "webhook" | "email";

interface NotifyExtras {
  channels?: NotifyChannel[];
  webhook_url?: string;
  email_to?: string[] | string;
}

type NotifyDraft = AlertPolicy["notify"] & {
  channels: NotifyChannel[];
  webhook_url: string;
  /** 逗号 / 换行分隔，保存时转为数组 */
  email_to: string;
};

type AlertPolicyExt = Omit<AlertPolicy, "notify"> & {
  notify: NotifyDraft;
  notify_ext?: NotifyExtras;
};

const NOTIFY_CHANNEL_OPTIONS: Array<{
  key: NotifyChannel;
  label: string;
  hint: string;
}> = [
  { key: "wecom", label: "企业微信", hint: "复用企业微信自建应用群消息（需 chat_id 与 WECOM 凭据）" },
  { key: "webhook", label: "Webhook", hint: "POST {title, markdown, links, session_id, ts}，5 秒超时" },
  { key: "email", label: "邮件", hint: "SMTP 通过环境变量配置，未配置时静默跳过" },
];

const MULTI_PATH_OPTIONS: Array<{ key: "A" | "B" | "C"; label: string; hint: string }> = [
  { key: "A", label: "关键组件", hint: "告警对象命中关键组件清单，且级别达标" },
  { key: "B", label: "高危签名", hint: "告警内容命中高危故障签名" },
  { key: "C", label: "交易量波动", hint: "交易量异常波动信号" },
];

const SEVERITY_LABEL = ["严重", "重要", "一般", "告警", "提示"];

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  triggered: "已触发",
  coalesced: "已合并",
  filtered: "已过滤",
  dismissed: "已忽略",
};

const STATUS_VARIANT: Record<string, "active" | "investigating" | "success" | "secondary" | "outline" | "info"> = {
  pending: "investigating",
  triggered: "success",
  coalesced: "info",
  filtered: "secondary",
  dismissed: "outline",
};

const SEVERITY_VARIANT: Record<number, "destructive" | "active" | "investigating" | "secondary" | "outline"> = {
  1: "destructive",
  2: "active",
  3: "investigating",
  4: "secondary",
  5: "outline",
};

const TYPE_LABEL: Record<string, string> = {
  performance_degradation: "性能劣化",
  error_spike: "错误激增",
  service_hang: "服务挂起",
  connectivity_loss: "连接异常",
  unknown: "未分类",
};

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function PageSkeleton() {
  return (
    <div className="p-4 space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export default function AlertsPage() {
  const { isAdmin } = useAuth();
  const { has } = usePermissions();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("inbox");

  const [stats, setStats] = useState<AlertStats | null>(null);
  const [rcaQueue, setRcaQueue] = useState<QueueStatus | null>(null);
  const [policy, setPolicy] = useState<AlertPolicy | null>(null);
  const [draft, setDraft] = useState<AlertPolicyExt | null>(null);
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null);

  const [tokens, setTokens] = useState<WebhookTokenList | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [tokenTeam, setTokenTeam] = useState<number>(1);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [createdToken, setCreatedToken] = useState<WebhookTokenCreated | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);

  const [inbox, setInbox] = useState<AlertOut[]>([]);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [trash, setTrash] = useState<AlertOut[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [trashPage, setTrashPage] = useState(1);
  const [search, setSearch] = useState("");
  const [trashSearch, setTrashSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [detail, setDetail] = useState<AlertOut | null>(null);
  const [showToken, setShowToken] = useState(false);
  const pageSize = 20;

  const refreshInbox = useCallback(async () => {
    const res = await alertsApi.inbox({ page, page_size: pageSize, search: search || undefined });
    setInbox(res.items);
    setInboxTotal(res.total);
    setSelected((prev) => prev.filter((id) => res.items.some((a) => a.id === id)));
  }, [page, search]);

  const refreshTrash = useCallback(async () => {
    const res = await alertsApi.trash({ page: trashPage, page_size: pageSize, search: trashSearch || undefined });
    setTrash(res.items);
    setTrashTotal(res.total);
  }, [trashPage, trashSearch]);

  const loadCore = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, w, q] = await Promise.all([
        alertsApi.stats(7),
        alertsApi.policy(),
        alertsApi.webhookInfo(),
        rca.queue().catch(() => null),
      ]);
      setStats(s);
      setPolicy(p);
      setDraft((prev) => prev ?? normalizePolicy(p));
      setWebhook(w);
      setRcaQueue(q);
    } catch {
      toast.error("加载告警中心数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await loadCore();
    await refreshInbox();
  }, [loadCore, refreshInbox]);

  const loadTokens = useCallback(async () => {
    if (!isAdmin) {
      setTokens(null);
      return;
    }
    try {
      setTokens(await alertsApi.webhookTokens());
    } catch {
      // 令牌管理是附加能力：加载失败不影响告警主流程
      setTokens(null);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  useEffect(() => {
    if (!tokens) return;
    setTokenTeam((prev) => (
      tokens.teams.some((t) => t.id === prev) ? prev : (tokens.teams[0]?.id ?? 1)
    ));
  }, [tokens]);

  useEffect(() => {
    void loadCore();
  }, [loadCore]);

  useEffect(() => {
    void refreshInbox().catch(() => {});
  }, [refreshInbox]);

  useEffect(() => {
    if (tab === "trash") void refreshTrash().catch(() => {});
  }, [tab, refreshTrash]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (tab === "inbox") {
        void refreshInbox().catch(() => {});
        void alertsApi.stats(7).then(setStats).catch(() => {});
      }
    }, 20000);
    return () => window.clearInterval(timer);
  }, [tab, refreshInbox]);

  const inboxPages = Math.max(1, Math.ceil(inboxTotal / pageSize));
  const trashPages = Math.max(1, Math.ceil(trashTotal / pageSize));

  /* ── 草稿脏检查：按分组统计，驱动卡片角标与底部保存栏 ── */
  const policyDirty = useMemo(() => {
    if (!draft || !policy) return false;
    try {
      return JSON.stringify(toPolicyPayload(draft))
        !== JSON.stringify(toPolicyPayload(normalizePolicy(policy)));
    } catch {
      return false;
    }
  }, [draft, policy]);

  const dirtyGroups = useMemo(() => {
    const empty = { trigger: false, timing: false, retention: false };
    if (!draft || !policy) return empty;
    const baseline = normalizePolicy(policy);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    return {
      trigger: !same(
        { trigger: draft.trigger, multi: draft.multi },
        { trigger: baseline.trigger, multi: baseline.multi },
      ),
      timing: !same(
        { dedup: draft.dedup, rca: draft.rca },
        { dedup: baseline.dedup, rca: baseline.rca },
      ),
      retention: !same(
        { retention: draft.retention, notify: draft.notify },
        { retention: baseline.retention, notify: baseline.notify },
      ),
    };
  }, [draft, policy]);

  const setMode = useCallback(async (mode: "auto" | "manual") => {
    if (!draft) return;
    setBusy(true);
    try {
      const next: AlertPolicyExt = { ...structuredClone(draft), mode };
      const updated = await alertsApi.savePolicy(toPolicyPayload(next));
      setPolicy(updated);
      setDraft(normalizePolicy(updated));
      toast.success(mode === "auto" ? "已切换为自动触发" : "已切换为人工触发");
    } catch {
      toast.error("切换触发模式失败");
    } finally {
      setBusy(false);
    }
  }, [draft]);

  async function triggerSelected() {
    if (selected.length === 0) return;
    setBusy(true);
    let ok = 0;
    for (const id of selected) {
      try {
        await alertsApi.trigger(id);
        ok += 1;
      } catch {
        /* keep going */
      }
    }
    setBusy(false);
    setSelected([]);
    toast.success(`已触发 ${ok} 条告警的 RCA`);
    await refreshInbox();
    await alertsApi.stats(7).then(setStats).catch(() => {});
  }

  async function dismissSelected() {
    if (selected.length === 0) return;
    setBusy(true);
    await Promise.all(selected.map((id) => alertsApi.dismiss(id).catch(() => null)));
    setBusy(false);
    setSelected([]);
    toast.success(`已忽略 ${selected.length} 条告警`);
    await refreshInbox();
  }

  async function triggerOne(alert: AlertOut) {
    try {
      const res = await alertsApi.trigger(alert.id);
      toast.success(`已触发 RCA #${res.rca_session_id}，分析结果见 RCA 分析页`);
      await refreshInbox();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "触发失败");
    }
  }

  async function dismissOne(alert: AlertOut) {
    try {
      await alertsApi.dismiss(alert.id);
      toast.success("告警已移入垃圾箱");
      await refreshInbox();
    } catch {
      toast.error("操作失败");
    }
  }

  async function clearTrash() {
    if (!window.confirm("确认清空垃圾箱？该操作不可恢复。")) return;
    try {
      const res = await alertsApi.clearTrash();
      toast.success(`已删除 ${res.deleted} 条告警`);
      await refreshTrash();
      await alertsApi.stats(7).then(setStats).catch(() => {});
    } catch {
      toast.error("清空失败（需要管理员权限）");
    }
  }

  async function saveDraft() {
    if (!draft) return;
    setBusy(true);
    try {
      const updated = await alertsApi.savePolicy(toPolicyPayload(draft));
      setPolicy(updated);
      setDraft(normalizePolicy(updated));
      toast.success("触发策略已保存并即时生效");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败（需要管理员权限）");
    } finally {
      setBusy(false);
    }
  }

  async function rotateToken() {
    try {
      const res = await alertsApi.rotateToken();
      toast.success("Webhook 令牌已重新生成");
      const info = await alertsApi.webhookInfo();
      setWebhook({ ...info, token: res.token });
    } catch {
      toast.error("生成令牌失败");
    }
  }

  async function createToken() {
    if (tokenBusy) return;
    setTokenBusy(true);
    try {
      const res = await alertsApi.createWebhookToken({
        name: tokenName.trim() || undefined,
        team_id: tokenTeam,
      });
      setCreatedToken(res);
      setTokenName("");
      setTokens(await alertsApi.webhookTokens());
      toast.success("令牌已创建，请立即复制（仅完整展示一次）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建令牌失败（需要管理员权限）");
    } finally {
      setTokenBusy(false);
    }
  }

  async function deleteToken(item: WebhookTokenItem) {
    if (!window.confirm(
      `确认删除令牌「${item.name}」？删除后使用该令牌的推送会立即返回 401。`,
    )) return;
    setTokenBusy(true);
    try {
      await alertsApi.deleteWebhookToken({ id: item.id });
      setTokens(await alertsApi.webhookTokens());
      if (createdToken?.item.id === item.id) setCreatedToken(null);
      toast.success("令牌已删除");
    } catch {
      toast.error("删除令牌失败");
    } finally {
      setTokenBusy(false);
    }
  }

  async function purgeNow() {
    if (!window.confirm(
      "确认按当前保留期立即清理本团队的收件箱/垃圾箱过期告警？该操作不可恢复。",
    )) return;
    setPurgeBusy(true);
    try {
      const res = await alertsApi.purgeAlerts(false);
      toast.success(
        res.deleted_total > 0
          ? `已清理 ${res.deleted_total} 条（收件箱 ${res.deleted_inbox} / 垃圾箱 ${res.deleted_trash}）`
          : res.message || "没有超过保留期的告警",
      );
      await refreshInbox();
      if (tab === "trash") await refreshTrash();
      await alertsApi.stats(7).then(setStats).catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清理失败（需要管理员权限）");
    } finally {
      setPurgeBusy(false);
    }
  }

  function copyText(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label}已复制`),
      () => toast.error("复制失败"),
    );
  }

  function updateDraft(mutator: (p: AlertPolicyExt) => void) {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutator(next);
      return next;
    });
  }

  function toggleChannel(key: NotifyChannel, checked: boolean) {
    updateDraft((p) => {
      const next = p.notify.channels.filter((c) => c !== key);
      if (checked) next.push(key);
      p.notify.channels = next.length ? next : ["wecom"];
    });
  }

  const statCards = useMemo(() => ([
    { label: "待处理", value: stats?.pending ?? 0, icon: BellRing, color: "text-amber-600", bg: "bg-amber-50" },
    { label: "已触发 RCA", value: stats?.triggered ?? 0, icon: Zap, color: "text-status-resolved", bg: "bg-status-resolved/10" },
    { label: "已合并", value: stats?.coalesced ?? 0, icon: Check, color: "text-info", bg: "bg-info/10" },
    { label: "垃圾箱", value: (stats?.filtered ?? 0) + (stats?.dismissed ?? 0), icon: Trash2, color: "text-muted-foreground", bg: "bg-muted" },
  ]), [stats]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-text-primary">告警中心</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Webhook 告警接入 · 自动去重 / 应用级合并 · 多信号触发 RCA · 近 7 天共 {stats?.total ?? 0} 条
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => navigate("/rca?status=running")}
            title="查看运行中的 RCA 会话"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            进行中事件
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">
              {rcaQueue?.active_count ?? 0}
            </Badge>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <PermissionGate perm="policy">
            <div className="inline-flex items-center rounded-lg border border-border p-0.5" role="group" aria-label="触发模式">
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={busy}
                  aria-pressed={(draft?.mode ?? "auto") === mode}
                  onClick={() => void setMode(mode)}
                  className={cn(
                    "h-7 rounded-md px-3 text-xs font-medium transition-colors",
                    (draft?.mode ?? "auto") === mode
                      ? "bg-interactive-primary text-text-on-solid"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "auto" ? "自动触发" : "人工触发"}
                </button>
              ))}
            </div>
          </PermissionGate>
          <Button variant="ghostMuted" size="icon-sm" onClick={() => void refreshAll()} aria-label="刷新" title="刷新">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* ── KPI ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statCards.map((item) => (
          <Card key={item.label}>
            <CardContent className="flex items-center gap-3 p-3">
              <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", item.bg)}>
                <item.icon className={cn("h-4 w-4", item.color)} />
              </div>
              <div className="min-w-0">
                <p className="text-lg font-bold tabular-nums text-text-primary">{item.value}</p>
                <p className="text-xs text-muted-foreground">{item.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Tabs ───────────────────────────────────────────── */}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v) as TabKey)}>
        <TabsList className="h-9 p-1">
          <TabsTrigger value="inbox" className="gap-1.5 px-3 text-xs">
            <Inbox className="h-3.5 w-3.5" />
            收件箱
            {inboxTotal > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {inboxTotal}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="trash" className="gap-1.5 px-3 text-xs">
            <Trash2 className="h-3.5 w-3.5" />
            垃圾箱
          </TabsTrigger>
          <TabsTrigger value="policy" className="gap-1.5 px-3 text-xs">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            触发策略 · 接入
          </TabsTrigger>
        </TabsList>

        {/* ── Inbox ─────────────────────────────────────────── */}
        <TabsContent value="inbox">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <BellRing className="h-4 w-4" /> 告警收件箱
                </CardTitle>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                      placeholder="搜索告警 ID / 应用 / 内容"
                      className="h-8 w-56 pl-7 text-xs"
                    />
                  </div>
                  {selected.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">已选 {selected.length}</span>
                      <PermissionGate perm="trigger_mode">
                        <Button size="sm" className="h-7 text-xs" onClick={() => void triggerSelected()} disabled={busy}>
                          <PlayCircle className="h-3.5 w-3.5" /> 触发 RCA
                        </Button>
                      </PermissionGate>
                      <PermissionGate perm="inbox_delete">
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void dismissSelected()} disabled={busy}>
                          <X className="h-3.5 w-3.5" /> 忽略
                        </Button>
                      </PermissionGate>
                    </div>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <PageSkeleton />
              ) : inbox.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  暂无告警。把监控系统的告警 POST 到 <code className="mx-1 text-xs bg-muted px-1.5 py-0.5 rounded">/api/alerts/webhook</code> 即可自动接入。
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground text-xs">
                          <th className="px-3 py-2 w-8">
                            <input
                              type="checkbox"
                              className="accent-interactive-primary"
                              checked={selected.length === inbox.length && inbox.length > 0}
                              onChange={(e) => setSelected(e.target.checked ? inbox.map((a) => a.id) : [])}
                            />
                          </th>
                          <th className="text-left px-3 py-2 font-medium">时间</th>
                          <th className="text-left px-3 py-2 font-medium">级别</th>
                          <th className="text-left px-3 py-2 font-medium">类型</th>
                          <th className="text-left px-3 py-2 font-medium">应用 / 对象</th>
                          <th className="text-left px-3 py-2 font-medium">内容</th>
                          <th className="text-left px-3 py-2 font-medium">状态</th>
                          <th className="text-right px-3 py-2 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inbox.map((alert) => (
                          <tr key={alert.id} className="border-b border-border/50 hover:bg-muted/50">
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                className="accent-interactive-primary"
                                checked={selected.includes(alert.id)}
                                onChange={(e) => setSelected((prev) =>
                                  e.target.checked ? [...prev, alert.id] : prev.filter((id) => id !== alert.id)
                                )}
                              />
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                              {fmtTime(alert.alert_time || alert.created_at)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant={SEVERITY_VARIANT[alert.severity_level ?? 4]} className="text-[11px]">
                                {alert.severity_label}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 text-xs">{TYPE_LABEL[alert.alert_type || "unknown"] || alert.alert_type}</td>
                            <td className="px-3 py-2 text-xs">
                              <div className="font-medium text-text-primary">{alert.ci_application || alert.ci_name || "—"}</div>
                              <div className="text-muted-foreground">{alert.ci_name && alert.ci_name !== alert.ci_application ? alert.ci_name : alert.ip || ""}</div>
                            </td>
                            <td className="px-3 py-2 max-w-[280px]">
                              <button
                                className="text-left line-clamp-2 text-xs hover:text-interactive-primary"
                                onClick={() => setDetail(alert)}
                                title={alert.content || ""}
                              >
                                {alert.content || "—"}
                              </button>
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant={STATUS_VARIANT[alert.status] || "secondary"} className="text-[11px]">
                                {STATUS_LABEL[alert.status] || alert.status}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {alert.status === "pending" ? (
                                <PermissionGate perm="trigger_mode">
                                  <Button variant="ghostMuted" size="icon-sm" title="触发 RCA" onClick={() => void triggerOne(alert)}>
                                    <PlayCircle className="h-3.5 w-3.5" />
                                  </Button>
                                </PermissionGate>
                              ) : alert.status === "triggered" && alert.rca_session_id ? (
                                <a href={`/rca?s=${alert.rca_session_id}`} className="text-xs text-interactive-primary hover:underline">
                                  #{alert.rca_session_id}
                                </a>
                              ) : alert.status === "coalesced" && alert.rca_session_id ? (
                                <a href={`/rca?s=${alert.rca_session_id}`} className="text-xs text-interactive-primary hover:underline">
                                  合并至 #{alert.rca_session_id}
                                </a>
                              ) : null}
                              <PermissionGate perm="inbox_delete">
                                <Button variant="ghostMuted" size="icon-sm" title="忽略" onClick={() => void dismissOne(alert)}>
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </PermissionGate>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={page} pages={inboxPages} total={inboxTotal} onChange={setPage} />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Trash ─────────────────────────────────────────── */}
        <TabsContent value="trash">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Trash2 className="h-4 w-4" /> 垃圾箱
                  <span className="text-xs font-normal text-muted-foreground">（策略过滤 / 人工忽略的告警）</span>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Input
                    value={trashSearch}
                    onChange={(e) => { setTrashSearch(e.target.value); setTrashPage(1); }}
                    placeholder="搜索"
                    className="h-8 w-40 text-xs"
                  />
                  <PermissionGate perm="trash_clear">
                    <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void clearTrash()}>
                      <Trash2 className="h-3.5 w-3.5" /> 清空
                    </Button>
                  </PermissionGate>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {trash.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">垃圾箱为空</p>
              ) : (
                <>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-xs">
                        <th className="text-left px-3 py-2 font-medium">时间</th>
                        <th className="text-left px-3 py-2 font-medium">级别</th>
                        <th className="text-left px-3 py-2 font-medium">应用</th>
                        <th className="text-left px-3 py-2 font-medium">内容</th>
                        <th className="text-left px-3 py-2 font-medium">原因</th>
                        <th className="text-right px-3 py-2 font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trash.map((alert) => (
                        <tr key={alert.id} className="border-b border-border/50 hover:bg-muted/50">
                          <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmtTime(alert.created_at)}</td>
                          <td className="px-3 py-2">
                            <Badge variant={SEVERITY_VARIANT[alert.severity_level ?? 4]} className="text-[11px]">{alert.severity_label}</Badge>
                          </td>
                          <td className="px-3 py-2 text-xs">{alert.ci_application || alert.ci_name || "—"}</td>
                          <td className="px-3 py-2 max-w-[280px]">
                            <button className="text-left line-clamp-2 text-xs hover:text-interactive-primary" onClick={() => setDetail(alert)}>
                              {alert.content || "—"}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground max-w-[220px] line-clamp-2">{alert.trigger_reason || "—"}</td>
                          <td className="px-3 py-2 text-right">
                            <Button variant="ghostMuted" size="icon-sm" title="手动触发 RCA" onClick={() => void triggerOne(alert)}>
                              <PlayCircle className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pager page={trashPage} pages={trashPages} total={trashTotal} onChange={setTrashPage} />
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Policy / webhook ───────────────────────────────── */}
        <TabsContent value="policy" className="space-y-6">
          {!draft ? (
            <Card>
              <CardContent className="p-6">
                <Skeleton className="h-64 w-full" />
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="space-y-6">
                {/* ① 触发条件 */}
                <GroupCard
                  index="01"
                  icon={Zap}
                  title="触发条件"
                  description="什么情况下值得起一次 RCA：级别阈值、多信号路径与关键对象名单。"
                  dirty={dirtyGroups.trigger}
                >
                  <div className="grid gap-4 md:grid-cols-2 md:gap-5">
                    <Field label="严重级别阈值" hint="≤ 该级别的告警立即触发 RCA（1 最严重，5 最轻）">
                      <select
                        className={POLICY_SELECT_CLASS}
                        value={draft.trigger.severity_max}
                        onChange={(e) => updateDraft((p) => { p.trigger.severity_max = Number(e.target.value); })}
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>{n} · {SEVERITY_LABEL[n - 1]}</option>
                        ))}
                      </select>
                    </Field>

                    <Field label="多信号路径" hint="按业务信号补充判断；关闭级别触发后仅这些路径生效">
                      <div className="flex flex-wrap gap-2">
                        {MULTI_PATH_OPTIONS.map((option) => (
                          <CheckChip
                            key={option.key}
                            label={option.label}
                            hint={option.hint}
                            checked={draft.multi.trigger_paths[option.key]}
                            onChange={(checked) => updateDraft((p) => { p.multi.trigger_paths[option.key] = checked; })}
                          />
                        ))}
                      </div>
                    </Field>

                    <ToggleRow
                      className="md:col-span-2"
                      label="按严重级别直接触发"
                      hint="关闭后仅按关键组件 / 高危签名 / 交易量波动触发"
                      checked={draft.trigger.severity_trigger}
                      onChange={(checked) => updateDraft((p) => { p.trigger.severity_trigger = checked; })}
                    />

                    <CollapsibleList
                      className="md:col-span-2"
                      label="关键组件"
                      hint="命中且级别达标即触发"
                      value={draft.trigger.critical_components}
                      onChange={(lines) => updateDraft((p) => { p.trigger.critical_components = lines; })}
                      placeholder={"payment-service\norder-service"}
                    />
                    <CollapsibleList
                      className="md:col-span-2"
                      label="高危故障签名"
                      hint="命中即触发，无需级别达标"
                      value={draft.trigger.high_risk_keywords}
                      onChange={(lines) => updateDraft((p) => { p.trigger.high_risk_keywords = lines; })}
                      placeholder={"OOMKilled\ndeadlock"}
                    />
                  </div>
                </GroupCard>

                {/* ② 时序与合并 */}
                <GroupCard
                  index="02"
                  icon={Clock}
                  title="时序与合并"
                  description="触发之后如何收敛：前溯、合并、去重与并发，决定 RCA 会话数量和分析质量。"
                  dirty={dirtyGroups.timing}
                  footer={<p className="text-xs text-muted-foreground">窗口越大越不容易重复触发，但首次分析也可能被延后。</p>}
                >
                  <div className="grid gap-4 md:grid-cols-2 md:gap-5">
                    <Field label="分析前溯（分钟）" hint="从告警时间往前回看的数据范围，0–240">
                      <Input
                        type="number" min={0} max={240} className={POLICY_INPUT_CLASS}
                        value={draft.trigger.analysis_start_offset_minutes}
                        onChange={(e) => updateDraft((p) => { p.trigger.analysis_start_offset_minutes = Number(e.target.value); })}
                      />
                    </Field>
                    <Field label="应用合并窗口（秒）" hint="同应用新告警附着到进行中的 RCA，不重复拉起">
                      <Input
                        type="number" min={0} max={86400} className={POLICY_INPUT_CLASS}
                        value={draft.trigger.app_coalesce_window}
                        onChange={(e) => updateDraft((p) => { p.trigger.app_coalesce_window = Number(e.target.value); })}
                      />
                    </Field>
                    <Field label="去重窗口（秒）" hint="窗口内相同 alertId 的告警直接忽略">
                      <Input
                        type="number" min={0} max={86400} className={POLICY_INPUT_CLASS}
                        value={draft.dedup.window_seconds}
                        onChange={(e) => updateDraft((p) => { p.dedup.window_seconds = Number(e.target.value); })}
                      />
                    </Field>
                    <Field label="RCA 超时（秒）" hint="单次分析超过该时长即标记失败，60–7200">
                      <Input
                        type="number" min={60} max={7200} className={POLICY_INPUT_CLASS}
                        value={draft.rca.run_timeout_seconds}
                        onChange={(e) => updateDraft((p) => { p.rca.run_timeout_seconds = Number(e.target.value); })}
                      />
                    </Field>
                    <Field label="并发上限" hint="同时运行的 RCA 会话数量，1–16">
                      <Input
                        type="number" min={1} max={16} className={POLICY_INPUT_CLASS}
                        value={draft.rca.concurrency}
                        onChange={(e) => updateDraft((p) => { p.rca.concurrency = Number(e.target.value); })}
                      />
                    </Field>
                    <Field label="当前队列" hint="实时运行 / 排队中的 RCA 会话">
                      <div className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5">
                        <Badge variant="success" className="text-[11px] tabular-nums">运行 {rcaQueue?.active_count ?? 0}</Badge>
                        <Badge variant="secondary" className="text-[11px] tabular-nums">排队 {rcaQueue?.queued_count ?? 0}</Badge>
                        <span className="text-xs text-muted-foreground tabular-nums">上限 {rcaQueue?.max_concurrency ?? draft.rca.concurrency}</span>
                      </div>
                    </Field>
                  </div>
                </GroupCard>

                {/* ③ 保留与通知 */}
                <GroupCard
                  index="03"
                  icon={BellRing}
                  title="保留与通知"
                  description="数据存多久、清理是否自动，以及 RCA 进度要推送到哪里。"
                  dirty={dirtyGroups.retention}
                >
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-text-primary">数据保留</p>
                      <Badge
                        variant={draft.retention.auto_clear_enabled ? "success" : "outline"}
                        className="text-[11px]"
                      >
                        {draft.retention.auto_clear_enabled ? "自动清理已开启" : "仅手动清理"}
                      </Badge>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 md:gap-5">
                      <Field label="收件箱保留（天）" hint="0 = 不自动清理，0–3650">
                        <Input
                          type="number" min={0} max={3650} className={POLICY_INPUT_CLASS}
                          value={draft.retention.inbox_days}
                          onChange={(e) => updateDraft((p) => { p.retention.inbox_days = Number(e.target.value); })}
                        />
                      </Field>
                      <Field label="垃圾箱保留（天）" hint="0 = 不自动清理，0–3650">
                        <Input
                          type="number" min={0} max={3650} className={POLICY_INPUT_CLASS}
                          value={draft.retention.trash_days}
                          onChange={(e) => updateDraft((p) => { p.retention.trash_days = Number(e.target.value); })}
                        />
                      </Field>
                    </div>

                    <ToggleRow
                      label="自动清空"
                      hint="按保留期在后台清理，每小时最多一次（随 webhook / 列表访问惰性触发）"
                      checked={draft.retention.auto_clear_enabled}
                      onChange={(checked) => updateDraft((p) => { p.retention.auto_clear_enabled = checked; })}
                    />

                    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
                      <p className="text-xs text-muted-foreground">需要立即释放空间？按当前保留期立刻清理本团队的过期告警。</p>
                      <div className="flex justify-end">
                        <PermissionGate perm="trash_clear">
                          <Button
                            variant="ghostMuted" size="sm" className="h-7 shrink-0 text-xs"
                            disabled={purgeBusy}
                            onClick={() => void purgeNow()}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> 立即清理
                          </Button>
                        </PermissionGate>
                      </div>
                    </div>
                  </div>

                  <Separator className="bg-border/60" />

                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-text-primary">通知通道</p>
                      <Badge variant={draft.notify.enabled ? "success" : "outline"} className="text-[11px]">
                        {draft.notify.enabled ? "已启用" : "未启用"}
                      </Badge>
                    </div>

                    <ToggleRow
                      label="启用通知"
                      hint="RCA 开始 / 完成 / 失败时推送"
                      checked={draft.notify.enabled}
                      onChange={(checked) => updateDraft((p) => { p.notify.enabled = checked; })}
                    />

                    <Field label="通知渠道" hint="未选择时默认企业微信；渠道配置在关闭通知后仍会保留">
                      <div className="flex flex-wrap gap-2">
                        {NOTIFY_CHANNEL_OPTIONS.map((option) => (
                          <CheckChip
                            key={option.key}
                            label={option.label}
                            hint={option.hint}
                            checked={draft.notify.channels.includes(option.key)}
                            onChange={(checked) => toggleChannel(option.key, checked)}
                          />
                        ))}
                      </div>
                    </Field>

                    <div className="grid gap-4 md:grid-cols-2 md:gap-5">
                      {draft.notify.channels.includes("wecom") && (
                        <Field label="企业微信群 chat_id（可选）" hint="留空使用默认接收群">
                          <Input
                            placeholder="企微群 chat_id（可选）"
                            className={cn(POLICY_INPUT_CLASS, "text-xs")}
                            value={draft.notify.wecom_chat_id}
                            onChange={(e) => updateDraft((p) => { p.notify.wecom_chat_id = e.target.value; })}
                          />
                        </Field>
                      )}

                      {draft.notify.channels.includes("webhook") && (
                        <Field className="md:col-span-2" label="Webhook 通知地址" hint="POST JSON，5 秒超时；留空则该通道静默跳过">
                          <Input
                            placeholder="https://hooks.example.com/incident"
                            className={cn(POLICY_INPUT_CLASS, "font-mono text-xs")}
                            value={draft.notify.webhook_url}
                            onChange={(e) => updateDraft((p) => { p.notify.webhook_url = e.target.value; })}
                          />
                          {!draft.notify.webhook_url.trim() && (
                            <p className="text-xs text-amber-600">
                              已选择 Webhook 通道但未填写地址，保存后该通道会被静默跳过。
                            </p>
                          )}
                        </Field>
                      )}

                      {draft.notify.channels.includes("email") && (
                        <Field
                          className="md:col-span-2"
                          label="邮件收件人"
                          hint="多个用逗号 / 换行分隔；SMTP 主机与账号通过环境变量配置：SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS（可选 SMTP_SSL / SMTP_TLS、SMTP_FROM），未配置时邮件通道静默跳过"
                        >
                          <textarea
                            placeholder={"oncall@example.com\nsre@example.com"}
                            className={cn(POLICY_TEXTAREA_CLASS, "h-20")}
                            value={draft.notify.email_to}
                            onChange={(e) => updateDraft((p) => { p.notify.email_to = e.target.value; })}
                          />
                        </Field>
                      )}
                    </div>
                  </div>
                </GroupCard>

                {/* Webhook 接入 */}
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                          <Webhook className="h-4 w-4 text-muted-foreground" /> Webhook 接入
                        </CardTitle>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          把监控系统告警 POST 到下方地址，自动进入去重 / 合并 / 触发流程。
                        </p>
                      </div>
                      {webhook && (
                        <Badge
                          variant={webhook.token_configured ? "success" : "investigating"}
                          className="shrink-0 text-[11px]"
                        >
                          {webhook.token_configured ? "鉴权已启用" : "开放接入"}
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {!webhook ? (
                      <Skeleton className="h-64 w-full" />
                    ) : (
                      <>
                        {/* 1. 接入地址 */}
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                              1
                            </span>
                            <p className="text-xs font-medium text-text-secondary">接入地址</p>
                            <Badge variant="secondary" className="text-[11px]">POST</Badge>
                          </div>
                          <div className="flex gap-2">
                            <Input
                              readOnly
                              value={webhook.url}
                              aria-label="Webhook 接入地址"
                              className="h-9 font-mono text-xs"
                            />
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 shrink-0"
                              onClick={() => copyText(webhook.url, "地址")}
                              aria-label="复制接入地址"
                              title="复制接入地址"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">支持单条 JSON 对象或数组批量推送，批量时逐条判定触发。</p>
                        </div>

                        <Separator className="bg-border/60" />

                        {/* 2. 鉴权令牌 */}
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
                              2
                            </span>
                            <p className="text-xs font-medium text-text-secondary">鉴权令牌</p>
                            <Badge
                              variant={webhook.token_configured ? "success" : "outline"}
                              className="text-[11px]"
                            >
                              {webhook.token_configured ? "已启用" : "未启用"}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Input
                              readOnly
                              type={showToken ? "text" : "password"}
                              value={webhook.token || "未设置"}
                              aria-label="Webhook 鉴权令牌"
                              className="h-9 min-w-[12rem] flex-1 font-mono text-xs"
                            />
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 shrink-0"
                              onClick={() => setShowToken((v) => !v)}
                              aria-label={showToken ? "隐藏令牌" : "显示令牌"}
                              title={showToken ? "隐藏令牌" : "显示令牌"}
                            >
                              {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 shrink-0"
                              onClick={() => copyText(webhook.token, "令牌")}
                              aria-label="复制令牌"
                              title="复制令牌"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            {isAdmin && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-9 shrink-0 text-xs"
                                onClick={() => void rotateToken()}
                              >
                                <RefreshCw className="h-3.5 w-3.5" /> 重新生成
                              </Button>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {webhook.token_configured
                              ? "推送需携带 X-Webhook-Token 请求头或 ?token= 查询参数。"
                              : "当前未启用令牌，任何来源都可推送；建议重新生成令牌。"}
                          </p>
                        </div>

                        {/* 3. 测试命令（默认折叠） */}
                        <details className="group rounded-lg border border-border/70">
                          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                            <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="flex-1 text-xs font-medium text-text-secondary">测试命令</span>
                            <span className="text-xs text-muted-foreground">curl 自测</span>
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                          </summary>
                          <div className="space-y-2 border-t border-border/60 p-3">
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3 text-[11px] leading-relaxed text-text-secondary">{webhook.curl}</pre>
                            <div className="flex justify-end">
                              <Button
                                variant="ghostMuted"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => copyText(webhook.curl, "命令")}
                              >
                                <Copy className="h-3 w-3" /> 复制 curl
                              </Button>
                            </div>
                          </div>
                        </details>

                        {/* 支持的告警格式（默认折叠） */}
                        <details className="group rounded-lg border border-border/70">
                          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                            <span className="flex-1 text-xs font-medium text-text-secondary">支持的告警格式</span>
                            <Badge variant="secondary" className="text-[11px] tabular-nums">
                              {webhook.formats.length}
                            </Badge>
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                          </summary>
                          <ul className="space-y-1 border-t border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
                            {webhook.formats.map((f) => (
                              <li key={f} className="flex gap-1.5">
                                <span aria-hidden="true">·</span>
                                <span>{f}</span>
                              </li>
                            ))}
                          </ul>
                        </details>

                        {/* 示例 JSON（默认折叠） */}
                        <details className="group rounded-lg border border-border/70">
                          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                            <span className="flex-1 text-xs font-medium text-text-secondary">示例告警 JSON</span>
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                          </summary>
                          <pre className="max-h-72 overflow-auto border-t border-border/60 p-3 text-[11px] leading-relaxed">{JSON.stringify(webhook.sample_payload, null, 2)}</pre>
                        </details>

                        <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                          <p>· 支持单条对象或 JSON 数组批量推送；Tarsier 原生字段与通用字段（alertId / alertLevel / alertContent…）均可。</p>
                          <p>· 去重窗内重复 alertId 会被忽略；同应用在合并窗口内的新告警会附着到进行中的 RCA，不重复拉起会话。</p>
                          <p>· 自动模式下按策略判定；人工模式下所有告警先入收件箱，可勾选后触发。</p>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Multi-team webhook tokens (P2-13) */}
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                          <KeyRound className="h-4 w-4 text-muted-foreground" /> Webhook 令牌 → 团队
                          <Badge variant="outline" className="text-[11px]">仅管理员</Badge>
                        </CardTitle>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          多团队接入：按令牌把告警路由到不同团队，未配置时全部归入 team 1。
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!isAdmin ? (
                      <p className="text-xs text-muted-foreground">仅管理员可查看和管理 webhook 令牌。</p>
                    ) : !tokens ? (
                      <Skeleton className="h-24 w-full" />
                    ) : (
                      <>
                        <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
                          {tokens.configured ? (
                            <p>
                              已配置 {tokens.items.length} 个令牌：推送时按 <code className="mx-0.5">X-Webhook-Token</code>
                              （或 <code className="mx-0.5">?token=</code>）匹配团队；未命中或已禁用一律返回 401。
                            </p>
                          ) : (
                            <p>
                              当前为单团队兼容模式：未配置令牌映射，所有 webhook 告警归入 team 1，
                              并沿用全局令牌校验（若已设置）。
                            </p>
                          )}
                          {tokens.configured && tokens.legacy_token_configured && (
                            <p>旧全局令牌仍可用，统一视为 team 1；如需完全隔离，请清空全局令牌。</p>
                          )}
                          <p>令牌明文只保存一份，列表仅显示前 6 位；创建后完整值仅展示一次。</p>
                        </div>

                        {tokens.items.length > 0 && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-border text-muted-foreground text-xs">
                                  <th className="text-left px-3 py-2 font-medium">名称</th>
                                  <th className="text-left px-3 py-2 font-medium">团队</th>
                                  <th className="text-left px-3 py-2 font-medium">创建时间</th>
                                  <th className="text-left px-3 py-2 font-medium">令牌（掩码）</th>
                                  <th className="text-right px-3 py-2 font-medium">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {tokens.items.map((item) => (
                                  <tr key={item.id} className="border-b border-border/50">
                                    <td className="px-3 py-2 text-xs">{item.name}</td>
                                    <td className="px-3 py-2 text-xs">
                                      {item.team_name || "—"}
                                      <span className="text-muted-foreground">（team {item.team_id}）</span>
                                    </td>
                                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                      {fmtTime(item.created_at)}
                                    </td>
                                    <td className="px-3 py-2">
                                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{item.masked}</code>
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                      <Button
                                        variant="ghostMuted" size="icon-sm" title="删除令牌"
                                        disabled={tokenBusy}
                                        onClick={() => void deleteToken(item)}
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        <div className="flex flex-wrap items-end gap-2">
                          <Field label="名称（可选）">
                            <Input
                              value={tokenName}
                              onChange={(e) => setTokenName(e.target.value)}
                              placeholder="例如：支付团队接入"
                              className="h-9 w-52 text-xs"
                            />
                          </Field>
                          <Field label="归属团队">
                            <select
                              className={cn(POLICY_SELECT_CLASS, "w-auto")}
                              value={tokenTeam}
                              onChange={(e) => setTokenTeam(Number(e.target.value))}
                              disabled={tokens.teams.length === 0}
                            >
                              {tokens.teams.map((team) => (
                                <option key={team.id} value={team.id}>
                                  {team.name}（team {team.id}）
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Button
                            size="sm" className="h-9 text-xs"
                            disabled={
                              tokenBusy
                              || tokens.teams.length === 0
                              || tokens.items.length >= tokens.max_tokens
                            }
                            onClick={() => void createToken()}
                          >
                            <Plus className="h-3.5 w-3.5" /> 生成令牌
                          </Button>
                        </div>

                        {createdToken && (
                          <div className="rounded-lg border border-status-resolved/40 bg-status-resolved/10 p-3 space-y-2">
                            <p className="text-xs font-medium text-text-primary">
                              新令牌（仅完整展示这一次，请立即复制保存）
                            </p>
                            <div className="flex gap-2">
                              <Input readOnly value={createdToken.token} className="h-9 font-mono text-xs" />
                              <Button
                                variant="outline" size="icon"
                                className="h-9 w-9 shrink-0"
                                onClick={() => copyText(createdToken.token, "令牌")}
                                aria-label="复制新令牌"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              名称 {createdToken.item.name} · 归属 {createdToken.item.team_name || "—"}
                              （team {createdToken.item.team_id}）
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* 底部粘性保存栏：集中「保存策略」+ 已修改提示 */}
              <div className="sticky bottom-0 z-20">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {policyDirty ? (
                      <>
                        <Badge variant="investigating" className="text-[11px]">有未保存的修改</Badge>
                        <span className="text-xs text-muted-foreground">保存后立即生效</span>
                      </>
                    ) : (
                      <>
                        <Badge variant="success" className="text-[11px]">已保存</Badge>
                        <span className="text-xs text-muted-foreground">策略与当前生效配置一致</span>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghostMuted" size="sm" className="h-8 text-xs"
                      disabled={!policyDirty || busy}
                      onClick={() => setDraft(policy ? normalizePolicy(policy) : null)}
                    >
                      还原
                    </Button>
                    <PermissionGate perm="policy">
                      <Button
                        size="sm" className="h-8 gap-1.5 text-xs"
                        disabled={!policyDirty || busy}
                        onClick={() => void saveDraft()}
                      >
                        {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        保存策略
                      </Button>
                    </PermissionGate>
                  </div>
                </div>
                {!has("policy") && (
                  <p className="mt-1.5 text-right text-xs text-muted-foreground">
                    当前角色缺少「改变触发策略」权限，仅可查看。
                  </p>
                )}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Alert detail drawer */}
      <Sheet open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <SheetContent side="right" className="w-[520px] sm:max-w-[520px] p-0 overflow-y-auto">
          {detail && (
            <>
              <SheetHeader className="border-b border-border">
                <SheetTitle>告警详情</SheetTitle>
              </SheetHeader>
              <div className="p-4 space-y-3 text-sm">
                <Kv label="告警 ID" value={detail.alert_uid || "—"} mono />
                <Kv label="状态" value={STATUS_LABEL[detail.status] || detail.status} />
                <Kv label="级别" value={`${detail.severity_label}（原始值 ${detail.severity ?? "—"}）`} />
                <Kv label="类型" value={TYPE_LABEL[detail.alert_type || "unknown"] || detail.alert_type || "—"} />
                <Kv label="来源 / IP" value={`${detail.source || "—"} / ${detail.ip || "—"}`} />
                <Kv label="应用 / 对象" value={`${detail.ci_application || "—"} / ${detail.ci_name || "—"}`} />
                <Kv label="告警时间" value={fmtTime(detail.alert_time)} />
                <Kv label="触发原因" value={detail.trigger_reason || "—"} />
                {detail.rca_session_id && <Kv label="RCA 会话" value={`#${detail.rca_session_id}`} />}
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">告警内容</p>
                  <p className="text-sm whitespace-pre-wrap">{detail.content || "—"}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground mb-1">原始报文</p>
                  <pre className="rounded-lg bg-muted/60 p-3 text-[11px] overflow-x-auto max-h-80">{JSON.stringify(detail.raw_payload, null, 2)}</pre>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  {detail.status === "pending" && (
                    <Button size="sm" onClick={() => { void triggerOne(detail); setDetail(null); }}>
                      <PlayCircle className="h-3.5 w-3.5" /> 触发 RCA
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setDetail(null)}>关闭</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ── small helpers ─────────────────────────────────────── */

function splitEmails(text: string): string[] {
  return text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function emailsToText(value: NotifyExtras["email_to"]): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  return typeof value === "string" ? value : "";
}

function normalizeChannels(value: unknown): NotifyChannel[] {
  const allowed = new Set<NotifyChannel>(["wecom", "webhook", "email"]);
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const out: NotifyChannel[] = [];
  for (const item of raw) {
    const key = String(item).toLowerCase() as NotifyChannel;
    if (allowed.has(key) && !out.includes(key)) out.push(key);
  }
  return out.length ? out : ["wecom"];
}

/** 把后端策略（含根级 notify_ext）转成 UI 草稿。 */
function normalizePolicy(input: AlertPolicy): AlertPolicyExt {
  const raw = input as AlertPolicy & { notify_ext?: NotifyExtras };
  const ext = raw.notify_ext ?? {};
  const notify = input.notify as Partial<NotifyDraft> & NotifyExtras;
  return {
    ...input,
    notify: {
      enabled: Boolean(notify.enabled),
      wecom_chat_id: notify.wecom_chat_id ?? "",
      channels: normalizeChannels(notify.channels ?? ext.channels),
      webhook_url: String(notify.webhook_url ?? ext.webhook_url ?? ""),
      email_to: emailsToText(notify.email_to ?? ext.email_to),
    },
  };
}

/** UI 草稿 → 保存载荷：notify 保留兼容字段，扩展项写入 notify_ext。 */
function toPolicyPayload(draft: AlertPolicyExt): AlertPolicyExt {
  const channels = draft.notify.channels.length
    ? draft.notify.channels
    : (["wecom"] as NotifyChannel[]);
  const webhookUrl = draft.notify.webhook_url.trim();
  return {
    ...draft,
    notify: {
      enabled: draft.notify.enabled,
      wecom_chat_id: draft.notify.wecom_chat_id.trim(),
      channels,
      webhook_url: webhookUrl,
      email_to: draft.notify.email_to,
    },
    notify_ext: {
      channels,
      webhook_url: webhookUrl,
      email_to: splitEmails(draft.notify.email_to),
    },
  };
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-sm ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function Pager({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border text-xs text-muted-foreground">
      <span>共 {total} 条 · 第 {page}/{pages} 页</span>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</Button>
      </div>
    </div>
  );
}
