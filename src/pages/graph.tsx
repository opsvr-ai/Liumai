import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  Lightbulb,
  Network,
  RefreshCw,
  Search,
  Server,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GraphCanvas, type FocusRequest } from "@/components/graph/graph-canvas";
import { NodeDetailPanel, type NeighborRow } from "@/components/graph/node-detail-panel";
import {
  colorForType,
  computeLayout,
  edgeTypeLabel,
  labelForType,
  nodeKey,
  normalizeType,
  rawKey,
  type GraphEdge,
  type GraphNode,
  type GraphOverviewResponse,
  type NeighborsResponse,
} from "@/components/graph/layout";

/* ==========================================================================
 *  知识图谱 — /graph
 *
 *  自绘 SVG（无第三方图库）：服务 / 告警 / 根因 / 处置动作的关系网络。
 *  数据来自 GET /api/graph/overview 与 GET /api/graph/neighbors，页面内
 *  fetch（Bearer token），后端接口保持不变。
 *
 *  - 布局：分层力导向（服务网格 + 告警/根因/动作分环 + 300 次模拟 + 碰撞松弛）
 *  - 交互：滚轮焦点缩放 / 平移 / 拖动节点 / 单击聚焦 / 双击详情 / 悬停 tooltip
 *  - 筛选：服务筛选、类型图例开关、搜索定位、可见计数
 * ========================================================================== */

const TOKEN_KEY = "liumai_token";
const NODE_LIMIT = 200;

interface GraphStats {
  services: number;
  alerts: number;
  causes: number;
  actions: number;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

interface TypeInfo {
  type: string;
  label: string;
  color: string;
  count: number;
}

function numberOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function metaText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
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
      const detail = record.detail;
      if (detail && typeof detail === "object") {
        const nested = detail as Record<string, unknown>;
        if (typeof nested.message === "string" && nested.message) return nested.message;
      }
    }
  } catch {
    // Plain-text proxy error — fall through.
  }
  return "";
}

/** Page-local fetch: bearer token stays in a header (no api.ts change). */
async function fetchGraph<T>(path: string, signal?: AbortSignal): Promise<T> {
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
    throw new Error(detail || `加载图谱失败（HTTP ${res.status}）`);
  }

  return (await res.json()) as T;
}

function normalizeOverview(raw: GraphOverviewResponse | null | undefined): GraphData {
  const nodes = Array.isArray(raw?.nodes)
    ? raw.nodes.filter(
        (node): node is GraphNode =>
          Boolean(node) &&
          typeof node === "object" &&
          node.id !== undefined &&
          node.id !== null,
      )
    : [];
  const keys = new Set(nodes.map(nodeKey));
  const edges = Array.isArray(raw?.edges)
    ? raw.edges.filter(
        (edge): edge is GraphEdge =>
          Boolean(edge) &&
          typeof edge === "object" &&
          keys.has(rawKey(edge.source)) &&
          keys.has(rawKey(edge.target)) &&
          rawKey(edge.source) !== rawKey(edge.target),
      )
    : [];

  const countType = (type: string) =>
    nodes.filter((node) => normalizeType(String(node.type)) === type).length;

  return {
    nodes,
    edges,
    stats: {
      services: numberOr(raw?.stats?.services, countType("service")),
      alerts: numberOr(raw?.stats?.alerts, countType("alert")),
      causes: numberOr(raw?.stats?.causes, countType("cause")),
      actions: numberOr(raw?.stats?.actions, countType("action")),
    },
  };
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  background,
}: {
  label: string;
  value: number;
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

export default function GraphPage() {
  const [service, setService] = useState("");
  const [data, setData] = useState<GraphData | null>(null);
  const [knownServices, setKnownServices] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  const [neighbors, setNeighbors] = useState<NeighborsResponse | null>(null);
  const [neighborLoading, setNeighborLoading] = useState(false);
  const [neighborError, setNeighborError] = useState<string | null>(null);

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const requestSeq = useRef(0);
  const focusSeq = useRef(0);

  const load = useCallback(
    async (silent: boolean, signal?: AbortSignal) => {
      const seq = ++requestSeq.current;
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setData(null);
      }
      try {
        const params = new URLSearchParams({ limit: String(NODE_LIMIT) });
        if (service) params.set("service", service);
        const raw = await fetchGraph<GraphOverviewResponse>(
          `/api/graph/overview?${params.toString()}`,
          signal,
        );
        if (seq !== requestSeq.current) return;
        setData(normalizeOverview(raw));
        setError(null);
      } catch (err) {
        if (isAbortError(err) || seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : "加载图谱失败");
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

  useEffect(() => {
    if (!data) return;
    const found = data.nodes
      .filter((node) => normalizeType(String(node.type)) === "service")
      .map((node) => String(node.label ?? "").trim())
      .filter(Boolean);
    if (found.length === 0) return;
    setKnownServices((prev) => {
      const merged = new Set(prev);
      for (const name of found) merged.add(name);
      return [...merged].sort((a, b) => a.localeCompare(b, "zh"));
    });
  }, [data]);

  // 布局只依赖数据本身：切换图例 / 搜索不会让节点跳动。
  const layout = useMemo(
    () => computeLayout(data?.nodes ?? [], data?.edges ?? [], { iterations: 300 }),
    [data],
  );

  // 数据（含服务筛选）变化 → 清空选择与详情
  useEffect(() => {
    setSelectedKey(null);
    setDetailKey(null);
    setPanelOpen(false);
    setNeighbors(null);
    setNeighborError(null);
  }, [data]);

  const typeInfos = useMemo<TypeInfo[]>(() => {
    return Object.entries(layout.typeCounts)
      .map(([type, count]) => ({
        type,
        label: labelForType(type),
        color: colorForType(type),
        count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh"));
  }, [layout]);

  const selectedNode = selectedKey ? layout.byKey.get(selectedKey) ?? null : null;
  const detailNode = detailKey ? layout.byKey.get(detailKey) ?? null : null;

  // 详情侧栏打开时才请求邻居接口（保持接口调用最小化）
  useEffect(() => {
    if (!panelOpen || !detailNode) {
      setNeighbors(null);
      setNeighborLoading(false);
      setNeighborError(null);
      return;
    }

    const controller = new AbortController();
    setNeighborLoading(true);
    setNeighborError(null);
    setNeighbors(null);

    const params = new URLSearchParams({
      type: detailNode.ntype,
      id: String(detailNode.id),
      depth: "1",
    });

    void fetchGraph<NeighborsResponse>(
      `/api/graph/neighbors?${params.toString()}`,
      controller.signal,
    )
      .then((payload) => setNeighbors(payload))
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setNeighborError(err instanceof Error ? err.message : "加载邻居失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setNeighborLoading(false);
      });

    return () => controller.abort();
  }, [panelOpen, detailNode]);

  const activeNeighbors = useMemo(() => {
    if (!neighbors || !neighbors.node || !detailKey) return null;
    return nodeKey(neighbors.node) === detailKey ? neighbors : null;
  }, [neighbors, detailKey]);

  const neighborRows = useMemo<NeighborRow[]>(() => {
    if (!detailKey) return [];

    const nodeMap = new Map<string, { key: string; label: string; ntype: string; color: string }>();
    for (const node of layout.nodes) {
      nodeMap.set(node.key, {
        key: node.key,
        label: node.label || `#${node.id}`,
        ntype: node.ntype,
        color: node.color,
      });
    }
    for (const node of activeNeighbors?.nodes ?? []) {
      const key = nodeKey(node);
      if (nodeMap.has(key)) continue;
      nodeMap.set(key, {
        key,
        label: String(node.label ?? `#${node.id}`),
        ntype: normalizeType(String(node.type)),
        color: colorForType(normalizeType(String(node.type))),
      });
    }

    const fetchedEdges = activeNeighbors?.edges ?? [];
    const edgeSource = fetchedEdges.length > 0 ? fetchedEdges : layout.edges;

    const rows = new Map<string, Set<string>>();
    const addRow = (key: string, edgeType?: string) => {
      if (!key || key === detailKey) return;
      const labels = rows.get(key) ?? new Set<string>();
      if (edgeType) labels.add(edgeTypeLabel(edgeType));
      rows.set(key, labels);
    };

    for (const edge of edgeSource) {
      const source = rawKey(edge.source);
      const target = rawKey(edge.target);
      if (source === detailKey) addRow(target, edge.type);
      else if (target === detailKey) addRow(source, edge.type);
    }
    for (const node of activeNeighbors?.nodes ?? []) addRow(nodeKey(node));

    return [...rows.entries()]
      .map(([key, edgeLabels]) => {
        const node = nodeMap.get(key);
        const type = node?.ntype ?? "other";
        return {
          key,
          label: node?.label ?? `#${key}`,
          type,
          color: node?.color ?? colorForType(type),
          edgeLabels: [...edgeLabels],
          inView: Boolean(layout.byKey.get(key)) && !hiddenTypes.has(type),
        };
      })
      .sort(
        (a, b) =>
          Number(b.inView) - Number(a.inView) || a.label.localeCompare(b.label, "zh"),
      );
  }, [activeNeighbors, detailKey, hiddenTypes, layout]);

  const metaEntries = useMemo(() => {
    const meta = detailNode?.meta;
    if (!meta || typeof meta !== "object") return [];
    return Object.entries(meta)
      .map(([key, value]) => [key, metaText(value)] as const)
      .filter(([, value]) => value !== "")
      .slice(0, 8);
  }, [detailNode]);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return layout.nodes
      .filter((node) => {
        const label = String(node.label ?? "").toLowerCase();
        const key = node.key.toLowerCase();
        return label.includes(query) || key.includes(query);
      })
      .sort((a, b) => {
        const aExact = a.key.toLowerCase().endsWith(`:${query}`) || a.label.toLowerCase() === query;
        const bExact = b.key.toLowerCase().endsWith(`:${query}`) || b.label.toLowerCase() === query;
        if (aExact !== bExact) return Number(bExact) - Number(aExact);
        const aService = a.ntype === "service";
        const bService = b.ntype === "service";
        if (aService !== bService) return Number(bService) - Number(aService);
        return b.deg - a.deg || a.label.localeCompare(b.label, "zh");
      })
      .slice(0, 8);
  }, [layout, search]);

  const searchKeys = useMemo(
    () => (search.trim() ? searchResults.map((node) => node.key) : []),
    [search, searchResults],
  );

  const requestFocus = useCallback((key: string) => {
    focusSeq.current += 1;
    setFocusRequest({ key, seq: focusSeq.current });
  }, []);

  const selectNode = useCallback(
    (key: string) => {
      setSelectedKey(key);
      if (panelOpen) setDetailKey(key);
      requestFocus(key);
      setSearchOpen(false);
    },
    [panelOpen, requestFocus],
  );

  const openDetail = useCallback(
    (key: string) => {
      setSelectedKey(key);
      setDetailKey(key);
      setPanelOpen(true);
      requestFocus(key);
      setSearchOpen(false);
      // 窄屏时详情面板在下方，双击后滚动到可见位置
      window.requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>("[data-node-detail]");
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (rect.top > window.innerHeight - 120 || rect.bottom < 0) {
          element.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    },
    [requestFocus],
  );

  const clearSelection = useCallback(() => setSelectedKey(null), []);

  const pickSearchResult = useCallback(
    (key: string) => {
      const node = layout.byKey.get(key);
      if (node) {
        setHiddenTypes((prev) => {
          if (!prev.has(node.ntype)) return prev;
          const next = new Set(prev);
          next.delete(node.ntype);
          return next;
        });
      }
      setSelectedKey(key);
      if (panelOpen) setDetailKey(key);
      requestFocus(key);
      setSearch("");
      setSearchOpen(false);
    },
    [layout, panelOpen, requestFocus],
  );

  function handleServiceChange(next: string) {
    setService(next);
    setSearch("");
    setHiddenTypes(new Set());
  }

  function toggleType(type: string) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const stats = data?.stats ?? { services: 0, alerts: 0, causes: 0, actions: 0 };
  const hasGraph = !loading && (data?.nodes.length ?? 0) > 0;
  const allTypesHidden = hasGraph && typeInfos.length > 0 && typeInfos.every((info) => hiddenTypes.has(info.type));

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Network className="h-4 w-4 text-interactive-primary" />
            知识图谱
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            服务 · 告警 · 根因 · 处置动作的关联网络
            {data ? ` · ${data.nodes.length} 个节点 / ${data.edges.length} 条边` : ""}
            {service ? ` · 当前服务：${service}` : ""}
          </p>
          <p className="mt-1 hidden text-[11px] text-muted-foreground/80 sm:block">
            滚轮 / +− 缩放 · 拖拽平移 · 拖动节点局部重整 · 单击聚焦 · 双击详情 · 图例开关类型
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && searchResults[0]) {
                  event.preventDefault();
                  pickSearchResult(searchResults[0].key);
                } else if (event.key === "Escape") {
                  setSearch("");
                  setSearchOpen(false);
                }
              }}
              placeholder="搜索服务 / 告警 id…"
              aria-label="搜索服务或告警 id"
              className="h-8 w-52 rounded-lg border border-input bg-background pl-7 pr-7 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            {search && (
              <button
                type="button"
                aria-label="清除搜索"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSearch("");
                  setSearchOpen(false);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {searchOpen && search.trim() !== "" && (
              <div className="absolute right-0 top-9 z-30 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
                {searchResults.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">没有匹配的节点</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto py-1">
                    {searchResults.map((node) => (
                      <li key={node.key}>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => pickSearchResult(node.key)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: node.color }}
                          />
                          <span className="min-w-0 flex-1 truncate text-text-secondary">
                            {node.label || `#${node.id}`}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {labelForType(node.ntype)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>服务</span>
            <select
              value={service}
              onChange={(event) => handleServiceChange(event.target.value)}
              aria-label="按服务筛选图谱"
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <option value="">全部服务</option>
              {knownServices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {refreshing && <span className="text-[11px] text-muted-foreground">更新中…</span>}
          <Button
            variant="ghostMuted"
            size="icon-sm"
            aria-label="刷新图谱"
            title="刷新图谱"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
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
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Skeleton className="aspect-[8/5] w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </>
      ) : error && !data ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <TriangleAlert className="h-7 w-7 text-status-investigating" />
            <p className="text-sm font-medium">图谱加载失败</p>
            <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">{error}</p>
            <p className="max-w-lg text-[11px] text-muted-foreground">
              请确认后端 /api/graph/overview 已部署，且当前账号可访问该服务的数据。
            </p>
            <div className="flex gap-2 pt-1">
              {service && (
                <Button variant="outline" size="sm" onClick={() => handleServiceChange("")}>
                  清除筛选
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => void load(false)}>
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {error && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <TriangleAlert className="h-3.5 w-3.5" />
              <span className="flex-1 break-words">{error}（下方为上次成功加载的数据）</span>
              <Button variant="ghostMuted" size="xs" onClick={() => void load(true)}>
                重试
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label="服务"
              value={stats.services}
              icon={Server}
              color="text-interactive-primary"
              background="bg-interactive-primary/10"
            />
            <StatCard
              label="告警"
              value={stats.alerts}
              icon={BellRing}
              color="text-status-active"
              background="bg-status-active/10"
            />
            <StatCard
              label="根因"
              value={stats.causes}
              icon={Lightbulb}
              color="text-status-investigating"
              background="bg-status-investigating/10"
            />
            <StatCard
              label="处置动作"
              value={stats.actions}
              icon={Wrench}
              color="text-status-resolved"
              background="bg-status-resolved/10"
            />
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="overflow-hidden">
              <CardContent className="relative p-0">
                {(data?.nodes.length ?? 0) === 0 ? (
                  <div className="flex aspect-[8/5] w-full flex-col items-center justify-center gap-2 p-6 text-center">
                    <Network className="h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm font-medium">暂无图谱数据</p>
                    <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                      {service
                        ? "该服务当前没有可展示的关联节点，清除筛选或完成一次 RCA 分析后再试。"
                        : "完成一次 RCA 分析后，服务、告警、根因与处置动作会自动关联成图。"}
                    </p>
                    <div className="flex gap-2 pt-1">
                      {service && (
                        <Button variant="outline" size="sm" onClick={() => handleServiceChange("")}>
                          清除筛选
                        </Button>
                      )}
                      <Button variant="ghostMuted" size="sm" onClick={() => void load(false)}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        重新加载
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="aspect-[8/5] w-full bg-surface-secondary/30">
                      <GraphCanvas
                        layout={layout}
                        hiddenTypes={hiddenTypes}
                        selectedKey={selectedKey}
                        detailKey={detailKey}
                        searchKeys={searchKeys}
                        focusRequest={focusRequest}
                        onSelectNode={selectNode}
                        onOpenDetail={openDetail}
                        onClearSelection={clearSelection}
                      />
                    </div>

                    {/* 类型图例（点击开关） */}
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-3 py-2">
                      {typeInfos.map((info) => {
                        const hidden = hiddenTypes.has(info.type);
                        return (
                          <button
                            key={info.type}
                            type="button"
                            data-graph-type={info.type}
                            aria-pressed={!hidden}
                            title={hidden ? `显示${info.label}` : `隐藏${info.label}`}
                            onClick={() => toggleType(info.type)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-[11px] transition-opacity hover:bg-muted",
                              hidden ? "opacity-45" : "opacity-100",
                            )}
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: info.color }}
                            />
                            <span className={cn(hidden && "line-through")}>{info.label}</span>
                            <span className="tabular-nums text-muted-foreground">{info.count}</span>
                          </button>
                        );
                      })}
                      {hiddenTypes.size > 0 && (
                        <button
                          type="button"
                          onClick={() => setHiddenTypes(new Set())}
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          显示全部
                        </button>
                      )}
                      <span className="ml-auto hidden text-[10px] text-muted-foreground/80 sm:inline">
                        节点半径按度数映射 6–22px
                      </span>
                    </div>

                    {allTypesHidden && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-center backdrop-blur-[1px]">
                        <p className="text-sm font-medium">所有类型已隐藏</p>
                        <Button variant="outline" size="sm" onClick={() => setHiddenTypes(new Set())}>
                          显示全部类型
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <NodeDetailPanel
              open={panelOpen}
              node={detailNode ?? selectedNode}
              ntype={(detailNode ?? selectedNode)?.ntype ?? "other"}
              rows={neighborRows}
              metaEntries={metaEntries}
              loading={neighborLoading}
              error={neighborError}
              onClose={() => {
                setPanelOpen(false);
                setDetailKey(null);
              }}
              onSelectNeighbor={(key) => {
                setSelectedKey(key);
                setDetailKey(key);
                requestFocus(key);
              }}
              onFocus={() => {
                const key = detailKey ?? selectedKey;
                if (key) requestFocus(key);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
