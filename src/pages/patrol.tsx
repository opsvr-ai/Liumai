import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BellRing,
  ChevronDown,
  ClipboardList,
  EyeOff,
  Info,
  ListChecks,
  RefreshCw,
  Server,
  TriangleAlert,
  Undo2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ==========================================================================
 *  巡检建议 — /patrol
 *
 *  今日主动巡检建议：GET /api/patrol/suggestions + GET /api/patrol/summary。
 *  - 顶部统计（总数 / 高 / 中 / 低）与服务筛选
 *  - 建议卡：严重级别、标题、原因、证据 chips、置信度、关联会话、建议动作
 *  - 「已忽略」只存本地 localStorage（可恢复），不写后端
 *  - 页面可见时每 60 秒静默刷新
 * ========================================================================== */

type NodeId = string | number;
type SeverityKey = "high" | "medium" | "low";

interface PatrolItem {
  id: NodeId;
  severity: string;
  service: string;
  title: string;
  reason: string;
  evidence: string[];
  confidence: number;
  related_session_ids: number[];
  suggested_action: string;
}

interface PatrolSuggestionsResponse {
  generated_at?: string | null;
  items?: unknown;
  stats?: {
    total?: number;
    by_severity?: Record<string, number>;
    services?: unknown;
  };
}

interface PatrolSummaryResponse {
  generated_at?: string | null;
  total?: number;
  by_severity?: Record<string, number>;
  top_services?: Array<{ service?: string; count?: number }>;
}

interface PatrolSummary {
  generatedAt: string | null;
  total: number;
  bySeverity: Record<string, number>;
  topServices: Array<{ service: string; count: number }>;
}

interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

const TOKEN_KEY = "liumai_token";
const IGNORED_KEY = "liumai_patrol_ignored";
const REFRESH_MS = 60_000;
const ITEM_LIMIT = 50;

const EMPTY_COUNTS: SeverityCounts = { high: 0, medium: 0, low: 0 };

interface SeverityMeta {
  label: string;
  cardLabel: string;
  variant: "active" | "investigating" | "outline";
}

const SEVERITY_META: Record<SeverityKey, SeverityMeta> = {
  high: { label: "高危", cardLabel: "高", variant: "active" },
  medium: { label: "中危", cardLabel: "中", variant: "investigating" },
  low: { label: "低危", cardLabel: "低", variant: "outline" },
};

function numberOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function itemKey(id: NodeId): string {
  return String(id);
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

/** Accept both 0–1 fractions and already-scaled percentages. */
function confidencePercent(value: number): number {
  const numeric = Number.isFinite(value) ? value : 0;
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return clamp(Math.round(percent), 0, 100);
}

function severityKey(raw: string): SeverityKey | null {
  const key = String(raw ?? "").trim().toLowerCase();
  if (!key) return null;

  const numeric = Number(key);
  if (Number.isFinite(numeric)) {
    if (numeric <= 2) return "high";
    if (numeric === 3) return "medium";
    return "low";
  }

  if (["high", "critical", "severe", "p0", "p1", "严重", "高", "高危"].includes(key)) {
    return "high";
  }
  if (["medium", "warning", "warn", "moderate", "p2", "重要", "中", "中危"].includes(key)) {
    return "medium";
  }
  if (["low", "info", "notice", "p3", "p4", "一般", "低", "低危", "提示"].includes(key)) {
    return "low";
  }
  return null;
}

function severityOf(item: PatrolItem): SeverityKey {
  return severityKey(item.severity) ?? "low";
}

function severityRank(item: PatrolItem): number {
  const severity = severityOf(item);
  return severity === "high" ? 0 : severity === "medium" ? 1 : 2;
}

function countSeverities(items: PatrolItem[]): SeverityCounts {
  const counts: SeverityCounts = { ...EMPTY_COUNTS };
  for (const item of items) counts[severityOf(item)] += 1;
  return counts;
}

function countsFromMap(
  map: Record<string, number>,
  fallback: SeverityCounts,
): SeverityCounts {
  const counts: SeverityCounts = { ...EMPTY_COUNTS };
  let recognised = false;
  for (const [key, value] of Object.entries(map)) {
    const severity = severityKey(key);
    const numeric = Number(value);
    if (!severity || !Number.isFinite(numeric)) continue;
    counts[severity] += numeric;
    recognised = true;
  }
  return recognised ? counts : fallback;
}

/** Defensive parser for both API items and localStorage snapshots. */
function toItem(raw: unknown): PatrolItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const rawId = record.id;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;

  return {
    id: rawId,
    severity: typeof record.severity === "string" ? record.severity : "low",
    service: typeof record.service === "string" ? record.service : "",
    title: typeof record.title === "string" ? record.title : "",
    reason: typeof record.reason === "string" ? record.reason : "",
    evidence: Array.isArray(record.evidence)
      ? record.evidence.filter((entry): entry is string => typeof entry === "string")
      : [],
    confidence: numberOr(record.confidence, 0),
    related_session_ids: Array.isArray(record.related_session_ids)
      ? [
          ...new Set(
            record.related_session_ids
              .map((entry) => Number(entry))
              .filter((entry) => Number.isFinite(entry)),
          ),
        ]
      : [],
    suggested_action:
      typeof record.suggested_action === "string" ? record.suggested_action : "",
  };
}

function toItems(raw: unknown): PatrolItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(toItem).filter((item): item is PatrolItem => item !== null);
}

function normalizeSummary(
  raw: PatrolSummaryResponse | null | undefined,
): PatrolSummary {
  const topServices = Array.isArray(raw?.top_services)
    ? raw.top_services
        .map((entry) => ({
          service: typeof entry?.service === "string" ? entry.service : "",
          count: numberOr(entry?.count, 0),
        }))
        .filter((entry) => entry.service !== "")
    : [];

  return {
    generatedAt: raw?.generated_at ?? null,
    total: numberOr(raw?.total, 0),
    bySeverity: raw?.by_severity ?? {},
    topServices,
  };
}

function readIgnoredItems(): PatrolItem[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(IGNORED_KEY) ?? "[]");
    return toItems(raw);
  } catch {
    return [];
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}

function readErrorMessage(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.detail === "string" && record.detail) return record.detail;
      if (typeof record.message === "string" && record.message) return record.message;
    }
  } catch {
    // Plain-text proxy error — fall through.
  }
  return "";
}

/** Page-local fetch: bearer token stays in a header (no api.ts change). */
async function fetchPatrol<T>(path: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // localStorage unavailable — send the request without a token.
  }

  const res = await fetch(path, { headers, signal });

  if (res.status === 401) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem("liumai_user");
      localStorage.removeItem("liumai_role");
      localStorage.removeItem("liumai_auth_type");
    } catch {
      // ignore
    }
    if (window.location.pathname !== "/login") window.location.href = "/login";
    throw new Error("登录已过期，请重新登录");
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    const detail = readErrorMessage(raw);
    throw new Error(detail || `加载巡检建议失败（HTTP ${res.status}）`);
  }

  return (await res.json()) as T;
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  background,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  color: string;
  background: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", background)}>
          <Icon className={cn("h-4 w-4", color)} />
        </div>
        <div>
          <p className="text-lg font-bold text-text-primary">{value}</p>
          <p className="text-[11px] text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PatrolPage() {
  const navigate = useNavigate();

  const [service, setService] = useState("");
  const [items, setItems] = useState<PatrolItem[]>([]);
  const [suggestStats, setSuggestStats] = useState<{
    total: number;
    bySeverity: Record<string, number>;
  } | null>(null);
  const [summary, setSummary] = useState<PatrolSummary | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [knownServices, setKnownServices] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ignoredItems, setIgnoredItems] = useState<PatrolItem[]>(() => readIgnoredItems());
  const [showIgnored, setShowIgnored] = useState(false);

  const requestSeq = useRef(0);

  const load = useCallback(
    async (silent: boolean, signal?: AbortSignal) => {
      const seq = ++requestSeq.current;
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setItems([]);
        setSuggestStats(null);
        setGeneratedAt(null);
      }

      try {
        const params = new URLSearchParams({ limit: String(ITEM_LIMIT) });
        if (service) params.set("service", service);

        const summaryPromise = fetchPatrol<PatrolSummaryResponse>(
          "/api/patrol/summary",
          signal,
        ).catch((err: unknown) => {
          if (isAbortError(err)) throw err;
          // The summary is an enhancement (service options); never block the list.
          return null;
        });

        const [rawSuggestions, rawSummary] = await Promise.all([
          fetchPatrol<PatrolSuggestionsResponse>(
            `/api/patrol/suggestions?${params.toString()}`,
            signal,
          ),
          summaryPromise,
        ]);

        if (seq !== requestSeq.current) return;

        const nextItems = toItems(rawSuggestions?.items);
        setItems(nextItems);
        setSuggestStats({
          total: numberOr(rawSuggestions?.stats?.total, nextItems.length),
          bySeverity: rawSuggestions?.stats?.by_severity ?? {},
        });
        setGeneratedAt(rawSuggestions?.generated_at ?? null);
        if (rawSummary) setSummary(normalizeSummary(rawSummary));
        setError(null);
      } catch (err) {
        if (isAbortError(err) || seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : "加载巡检建议失败");
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [service],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [load]);

  // 60s auto-refresh, paused while the tab is hidden.
  useEffect(() => {
    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void load(true);
      }, REFRESH_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void load(true);
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem(IGNORED_KEY, JSON.stringify(ignoredItems));
    } catch {
      // Quota / privacy mode — ignoring still works for this session.
    }
  }, [ignoredItems]);

  useEffect(() => {
    const found = new Set<string>();
    for (const item of items) {
      if (item.service) found.add(item.service);
    }
    for (const entry of summary?.topServices ?? []) {
      if (entry.service) found.add(entry.service);
    }
    if (found.size === 0) return;

    setKnownServices((prev) => {
      const merged = new Set(prev);
      for (const name of found) merged.add(name);
      return [...merged].sort((a, b) => a.localeCompare(b, "zh"));
    });
  }, [items, summary]);

  const serviceOptions = useMemo(() => {
    const merged = new Set(knownServices);
    if (service) merged.add(service);
    return [...merged].sort((a, b) => a.localeCompare(b, "zh"));
  }, [knownServices, service]);

  const itemCounts = useMemo(() => countSeverities(items), [items]);

  const counts = useMemo(() => {
    const raw = suggestStats?.bySeverity;
    if (raw && Object.keys(raw).length > 0) return countsFromMap(raw, itemCounts);
    return itemCounts;
  }, [suggestStats, itemCounts]);

  const total = suggestStats?.total ?? items.length;

  const ignoredIds = useMemo(
    () => new Set(ignoredItems.map((item) => itemKey(item.id))),
    [ignoredItems],
  );

  const visibleItems = useMemo(
    () =>
      [...items]
        .sort(
          (a, b) =>
            severityRank(a) - severityRank(b) ||
            confidencePercent(b.confidence) - confidencePercent(a.confidence),
        )
        .filter((item) => !ignoredIds.has(itemKey(item.id))),
    [items, ignoredIds],
  );

  const allIgnored = items.length > 0 && visibleItems.length === 0;
  const latestGeneratedAt = generatedAt ?? summary?.generatedAt ?? null;

  function ignoreItem(item: PatrolItem) {
    setIgnoredItems((prev) =>
      prev.some((entry) => itemKey(entry.id) === itemKey(item.id))
        ? prev
        : [item, ...prev],
    );
  }

  function restoreItem(id: NodeId) {
    setIgnoredItems((prev) =>
      prev.filter((entry) => itemKey(entry.id) !== itemKey(id)),
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ClipboardList className="h-4 w-4 text-interactive-primary" />
            巡检建议
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            基于告警 / 知识 / 数据源健康度自动生成 · 更新于 {fmtTime(latestGeneratedAt)} ·
            页面可见时每 60 秒自动刷新
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {refreshing && <span className="text-[11px] text-muted-foreground">更新中…</span>}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>服务</span>
            <select
              value={service}
              onChange={(event) => setService(event.target.value)}
              aria-label="按服务筛选巡检建议"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <option value="">全部服务</option>
              {serviceOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            刷新
          </Button>
        </div>
      </div>

      {loading ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-[66px] w-full rounded-xl" />
            ))}
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Card key={index}>
                <CardContent className="space-y-3 p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-1 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : (
        <>
          {error && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <TriangleAlert className="h-3.5 w-3.5" />
              <span className="flex-1 break-words">
                {error}
                {items.length > 0 ? "（下方为上次成功加载的建议）" : ""}
              </span>
              <Button variant="ghostMuted" size="xs" onClick={() => void load(false)}>
                重试
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="总数"
              value={total}
              icon={ListChecks}
              color="text-interactive-primary"
              background="bg-interactive-primary/10"
            />
            <StatCard
              label={SEVERITY_META.high.cardLabel}
              value={counts.high}
              icon={TriangleAlert}
              color="text-status-active"
              background="bg-status-active/10"
            />
            <StatCard
              label={SEVERITY_META.medium.cardLabel}
              value={counts.medium}
              icon={BellRing}
              color="text-status-investigating"
              background="bg-status-investigating/10"
            />
            <StatCard
              label={SEVERITY_META.low.cardLabel}
              value={counts.low}
              icon={Info}
              color="text-muted-foreground"
              background="bg-muted"
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              当前展示 {visibleItems.length} 条
              {ignoredItems.length > 0 ? ` · 已忽略 ${ignoredItems.length} 条` : ""}
            </span>
            <span>按严重级别 / 置信度排序</span>
          </div>

          {visibleItems.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <ClipboardList className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">
                  {allIgnored ? "全部建议已忽略" : service ? "该服务暂无巡检建议" : "暂无巡检建议"}
                </p>
                <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                  {allIgnored
                    ? "可在下方「已忽略」列表中恢复任意一条建议。"
                    : "巡检建议由后端基于告警、知识与数据源健康度生成，可稍后刷新重试。"}
                </p>
                <div className="flex gap-2 pt-1">
                  {service && (
                    <Button variant="outline" size="sm" onClick={() => setService("")}>
                      清除筛选
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => void load(false)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    刷新
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {visibleItems.map((item) => {
                const severity = severityOf(item);
                const meta = SEVERITY_META[severity];
                const percent = confidencePercent(item.confidence);
                const sessions = item.related_session_ids;

                return (
                  <Card key={itemKey(item.id)}>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Server className="h-3 w-3" />
                          {item.service || "未标注服务"}
                        </span>
                        <Button
                          variant="ghostMuted"
                          size="xs"
                          className="ml-auto"
                          title="本地忽略，可随时恢复"
                          onClick={() => ignoreItem(item)}
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                          忽略
                        </Button>
                      </div>

                      <div className="space-y-1">
                        <h3 className="break-words text-sm font-semibold text-text-primary">
                          {item.title || "未命名建议"}
                        </h3>
                        {item.reason && (
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {item.reason}
                          </p>
                        )}
                      </div>

                      {item.evidence.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {item.evidence.map((evidence, index) => (
                            <span
                              key={`${itemKey(item.id)}-evidence-${index}`}
                              title={evidence}
                              className="max-w-[280px] truncate rounded-md bg-muted px-2 py-0.5 text-[11px] text-text-secondary"
                            >
                              {evidence}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <span className="w-9 shrink-0 text-[11px] text-muted-foreground">置信度</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-interactive-primary"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                          {percent}%
                        </span>
                      </div>

                      {item.suggested_action && (
                        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                          <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-interactive-primary" />
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium text-text-secondary">建议动作</p>
                            <p className="break-words text-xs leading-relaxed text-text-secondary">
                              {item.suggested_action}
                            </p>
                          </div>
                        </div>
                      )}

                      {sessions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className="text-muted-foreground">关联会话</span>
                          {sessions.map((sessionId) => (
                            <button
                              key={sessionId}
                              type="button"
                              onClick={() => navigate(`/rca?s=${sessionId}`)}
                              className="font-medium text-interactive-primary hover:underline"
                            >
                              #{sessionId}
                            </button>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {ignoredItems.length > 0 && (
            <Card>
              <CardContent className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setShowIgnored((value) => !value)}
                    className="flex items-center gap-2 text-sm font-medium"
                    aria-expanded={showIgnored}
                  >
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                    已忽略（{ignoredItems.length}）
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 transition-transform",
                        showIgnored && "rotate-180",
                      )}
                    />
                  </button>
                  {showIgnored && (
                    <Button
                      variant="ghostMuted"
                      size="sm"
                      onClick={() => setIgnoredItems([])}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      全部恢复
                    </Button>
                  )}
                </div>

                {showIgnored && (
                  <ul className="mt-3 space-y-2">
                    {ignoredItems.map((item) => {
                      const meta = SEVERITY_META[severityOf(item)];
                      return (
                        <li
                          key={itemKey(item.id)}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
                        >
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          {item.service && (
                            <span className="text-[11px] text-muted-foreground">{item.service}</span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                            {item.title || `建议 #${itemKey(item.id)}`}
                          </span>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => restoreItem(item.id)}
                          >
                            <Undo2 className="h-3 w-3" />
                            恢复
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
