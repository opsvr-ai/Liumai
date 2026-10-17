import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BellRing,
  Lightbulb,
  Network,
  RefreshCw,
  RotateCcw,
  Server,
  TriangleAlert,
  Waypoints,
  Wrench,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ==========================================================================
 *  知识图谱 — /graph
 *
 *  自绘 SVG 图谱（无第三方图库）：服务 / 告警 / 根因 / 处置动作的关系网络。
 *  数据来自 GET /api/graph/overview 与 GET /api/graph/neighbors，请求在页面内
 *  fetch（Bearer token），不改 src/lib/api.ts。
 *
 *  - 布局：按节点类型聚类的确定性力导向（≤200 节点，一次性计算）
 *  - 交互：滚轮缩放 / 拖拽平移 / 点击节点高亮一跳邻居 / 类型图例开关
 * ========================================================================== */

type NodeId = string | number;

interface GraphNode {
  id: NodeId;
  type: string;
  label: string;
  weight?: number;
  meta?: Record<string, unknown>;
}

interface GraphEdge {
  source: NodeId;
  target: NodeId;
  type: string;
  weight?: number;
}

interface GraphStats {
  services?: number;
  alerts?: number;
  causes?: number;
  actions?: number;
}

interface GraphOverviewResponse {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  stats?: GraphStats;
}

interface NeighborsResponse {
  node?: GraphNode;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { services: number; alerts: number; causes: number; actions: number };
}

interface TypeInfo {
  type: string;
  label: string;
  color: string;
  count: number;
}

interface PositionedNode extends GraphNode {
  key: string;
  /** Normalised node type (services/alerts/… → service/alert/…). */
  ntype: string;
  rawType: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
}

interface TypeMeta {
  label: string;
  color: string;
}

interface NeighborRow {
  key: string;
  label: string;
  type: string;
  color: string;
  edgeLabels: string[];
  inView: boolean;
}

const TOKEN_KEY = "liumai_token";
const NODE_LIMIT = 200;
const WIDTH = 960;
const HEIGHT = 600;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;

/** Fixed colours per node type — the graph legend and nodes share this map. */
const TYPE_DEFS: Record<string, TypeMeta> = {
  service: { label: "服务", color: "#4f6bf7" },
  alert: { label: "告警", color: "#ef4444" },
  cause: { label: "根因", color: "#f59e0b" },
  action: { label: "处置动作", color: "#10a861" },
};

const TYPE_ALIASES: Record<string, string> = {
  services: "service",
  alerts: "alert",
  causes: "cause",
  actions: "action",
  root_cause: "cause",
  rootcause: "cause",
  reason: "cause",
  remediation: "action",
  suggestion: "action",
};

const FALLBACK_COLORS = [
  "#8b5cf6",
  "#0ea5e9",
  "#14b8a6",
  "#f43f5e",
  "#eab308",
  "#d946ef",
  "#64748b",
];

const EDGE_LABELS: Record<string, string> = {
  caused_by: "导致",
  causes: "导致",
  cause: "导致",
  resolved_by: "解决",
  resolves: "解决",
  affects: "影响",
  affected_by: "受影响",
  similar_to: "相似",
  documented_in: "记录于",
  related_to: "相关",
  has_alert: "产生告警",
  alert_of: "属于",
  triggered: "触发",
  action_for: "处置",
  suggested_action: "建议动作",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function rawKey(id: NodeId): string {
  return String(id);
}

function nodeKey(node: GraphNode): string {
  return rawKey(node.id);
}

function normalizeType(type: string): string {
  const key = String(type ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return "other";
  return TYPE_ALIASES[key] ?? key;
}

function hashColor(type: string): string {
  let hash = 0;
  for (let i = 0; i < type.length; i += 1) {
    hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? "#8e8ea0";
}

function colorForType(type: string): string {
  return TYPE_DEFS[type]?.color ?? hashColor(type);
}

function labelForType(type: string): string {
  return TYPE_DEFS[type]?.label ?? (type === "other" ? "其他" : type);
}

function edgeTypeLabel(type: string | undefined): string {
  if (!type) return "关联";
  return EDGE_LABELS[type] ?? type;
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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
          keys.has(rawKey(edge.target)),
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

/**
 * Deterministic, cluster-aware force layout.
 *
 * Nodes start on a golden-angle spiral around a per-type anchor; a short
 * spring/repulsion simulation then spreads connected clusters apart.  Running
 * it once per dataset (≤200 nodes) keeps pan/zoom interactions smooth.
 */
function computeLayout(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  if (nodes.length === 0) return [];

  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const type = normalizeType(String(node.type));
    const list = groups.get(type) ?? [];
    list.push(node);
    groups.set(type, list);
  }

  const types = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const placed: PositionedNode[] = [];
  const anchorRadius = types.length <= 1 ? 0 : Math.min(190, 80 + types.length * 24);

  types.forEach((type, typeIndex) => {
    const list = groups.get(type) ?? [];
    const angle = types.length <= 1 ? 0 : (typeIndex / types.length) * Math.PI * 2 - Math.PI / 2;
    const anchorX = WIDTH / 2 + Math.cos(angle) * anchorRadius;
    const anchorY = HEIGHT / 2 + Math.sin(angle) * anchorRadius;

    list.forEach((node, index) => {
      const spiralAngle = index * 2.399963229728653;
      const orbit = Math.min(150, 10 + Math.sqrt(index) * 15);
      const weight = Math.max(1, numberOr(node.weight, 1));
      placed.push({
        ...node,
        key: nodeKey(node),
        ntype: type,
        rawType: String(node.type ?? ""),
        x: anchorX + Math.cos(spiralAngle) * orbit,
        y: anchorY + Math.sin(spiralAngle) * orbit,
        vx: 0,
        vy: 0,
        r: clamp(6 + Math.sqrt(weight) * 2.4, 6, 19),
        color: colorForType(type),
      });
    });
  });

  const indexByKey = new Map(placed.map((node, index) => [node.key, index]));
  const edgePairs: Array<[number, number]> = [];
  for (const edge of edges) {
    const source = indexByKey.get(rawKey(edge.source));
    const target = indexByKey.get(rawKey(edge.target));
    if (source === undefined || target === undefined || source === target) continue;
    edgePairs.push([source, target]);
  }

  const iterations = placed.length > 120 ? 140 : 180;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // Pairwise repulsion (only local pairs matter; far pairs are skipped).
    for (let i = 0; i < placed.length; i += 1) {
      const a = placed[i]!;
      for (let j = i + 1; j < placed.length; j += 1) {
        const b = placed[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq > 180 * 180) continue;
        if (distanceSq < 0.01) {
          dx = 0.1;
          dy = 0.1;
          distanceSq = 0.02;
        }
        const distance = Math.sqrt(distanceSq);
        const minDistance = (a.r + b.r) * 1.8 + 12;
        const push = Math.min(4.5, (minDistance * minDistance) / (distanceSq + 1));
        const fx = (dx / distance) * push;
        const fy = (dy / distance) * push;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Edge springs pull related nodes to a readable distance.
    for (const [sourceIndex, targetIndex] of edgePairs) {
      const a = placed[sourceIndex]!;
      const b = placed[targetIndex]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = a.r + b.r + 55;
      const force = (distance - rest) * 0.03;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of placed) {
      node.vx += (WIDTH / 2 - node.x) * 0.002;
      node.vy += (HEIGHT / 2 - node.y) * 0.002;
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x = clamp(node.x + node.vx, node.r + 14, WIDTH - node.r - 14);
      node.y = clamp(node.y + node.vy, node.r + 14, HEIGHT - node.r - 14);
    }
  }

  return placed;
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
  const [neighbors, setNeighbors] = useState<NeighborsResponse | null>(null);
  const [neighborLoading, setNeighborLoading] = useState(false);
  const [neighborError, setNeighborError] = useState<string | null>(null);

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);

  const requestSeq = useRef(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

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

  const typeInfos = useMemo<TypeInfo[]>(() => {
    const map = new Map<string, TypeInfo>();
    for (const node of data?.nodes ?? []) {
      const type = normalizeType(String(node.type));
      const info = map.get(type) ?? {
        type,
        label: labelForType(type),
        color: colorForType(type),
        count: 0,
      };
      info.count += 1;
      map.set(type, info);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, "zh"));
  }, [data]);

  const layout = useMemo(
    () => computeLayout(data?.nodes ?? [], data?.edges ?? []),
    [data],
  );

  const positionByKey = useMemo(
    () => new Map(layout.map((node) => [node.key, node])),
    [layout],
  );

  const visibleNodes = useMemo(
    () => layout.filter((node) => !hiddenTypes.has(node.ntype)),
    [layout, hiddenTypes],
  );

  const visibleKeys = useMemo(
    () => new Set(visibleNodes.map((node) => node.key)),
    [visibleNodes],
  );

  const visibleEdges = useMemo(
    () =>
      (data?.edges ?? []).filter(
        (edge) =>
          visibleKeys.has(rawKey(edge.source)) &&
          visibleKeys.has(rawKey(edge.target)) &&
          rawKey(edge.source) !== rawKey(edge.target),
      ),
    [data, visibleKeys],
  );

  const selectedNode = useMemo(
    () => (data?.nodes ?? []).find((node) => nodeKey(node) === selectedKey) ?? null,
    [data, selectedKey],
  );

  // Drop the selection if a refresh removes the node (e.g. service filter).
  useEffect(() => {
    if (!selectedKey || !data) return;
    if (!data.nodes.some((node) => nodeKey(node) === selectedKey)) {
      setSelectedKey(null);
    }
  }, [data, selectedKey]);

  useEffect(() => {
    if (!selectedNode) {
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
      type: String(selectedNode.type ?? ""),
      id: String(selectedNode.id),
      depth: "1",
    });

    void fetchGraph<NeighborsResponse>(
      `/api/graph/neighbors?${params.toString()}`,
      controller.signal,
    )
      .then((payload) => {
        setNeighbors(payload);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setNeighborError(err instanceof Error ? err.message : "加载邻居失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setNeighborLoading(false);
      });

    return () => controller.abort();
  }, [selectedNode]);

  const localNeighborKeys = useMemo(() => {
    const result = new Set<string>();
    if (!selectedKey) return result;
    for (const edge of data?.edges ?? []) {
      const source = rawKey(edge.source);
      const target = rawKey(edge.target);
      if (source === selectedKey && target !== selectedKey) result.add(target);
      if (target === selectedKey && source !== selectedKey) result.add(source);
    }
    return result;
  }, [data, selectedKey]);

  const activeNeighbors = useMemo(() => {
    if (!neighbors || !neighbors.node) return null;
    return nodeKey(neighbors.node) === selectedKey ? neighbors : null;
  }, [neighbors, selectedKey]);

  const fetchedNeighborKeys = useMemo(() => {
    const result = new Set<string>();
    if (!selectedKey || !activeNeighbors) return result;
    for (const edge of activeNeighbors.edges ?? []) {
      const source = rawKey(edge.source);
      const target = rawKey(edge.target);
      if (source === selectedKey && target !== selectedKey) result.add(target);
      if (target === selectedKey && source !== selectedKey) result.add(source);
    }
    for (const node of activeNeighbors.nodes ?? []) {
      const key = nodeKey(node);
      if (key !== selectedKey) result.add(key);
    }
    return result;
  }, [selectedKey, activeNeighbors]);

  const highlightKeys = useMemo(
    () => new Set([...localNeighborKeys, ...fetchedNeighborKeys]),
    [localNeighborKeys, fetchedNeighborKeys],
  );

  const neighborRows = useMemo<NeighborRow[]>(() => {
    if (!selectedKey) return [];

    const nodeMap = new Map<string, GraphNode>();
    for (const node of data?.nodes ?? []) nodeMap.set(nodeKey(node), node);
    for (const node of activeNeighbors?.nodes ?? []) nodeMap.set(nodeKey(node), node);

    const fetchedEdges = activeNeighbors?.edges ?? [];
    const edgeSource = fetchedEdges.length > 0 ? fetchedEdges : data?.edges ?? [];

    const rows = new Map<string, Set<string>>();
    const addRow = (key: string, edgeType?: string) => {
      if (!key || key === selectedKey) return;
      const labels = rows.get(key) ?? new Set<string>();
      if (edgeType) labels.add(edgeTypeLabel(edgeType));
      rows.set(key, labels);
    };

    for (const edge of edgeSource) {
      const source = rawKey(edge.source);
      const target = rawKey(edge.target);
      if (source === selectedKey) addRow(target, edge.type);
      else if (target === selectedKey) addRow(source, edge.type);
    }
    for (const node of activeNeighbors?.nodes ?? []) {
      addRow(nodeKey(node));
    }

    const inViewKeys = new Set((data?.nodes ?? []).map(nodeKey));

    return [...rows.entries()]
      .map(([key, edgeLabels]) => {
        const node = nodeMap.get(key);
        const type = node ? normalizeType(String(node.type)) : "other";
        const rawLabel = node?.label;
        const label =
          typeof rawLabel === "string" && rawLabel.trim()
            ? rawLabel.trim()
            : rawLabel
              ? String(rawLabel)
              : `#${key}`;
        return {
          key,
          label,
          type,
          color: colorForType(type),
          edgeLabels: [...edgeLabels],
          inView: inViewKeys.has(key),
        };
      })
      .sort(
        (a, b) =>
          Number(b.inView) - Number(a.inView) ||
          a.label.localeCompare(b.label, "zh"),
      );
  }, [data, activeNeighbors, selectedKey]);

  const metaEntries = useMemo(() => {
    const meta = selectedNode?.meta;
    if (!meta || typeof meta !== "object") return [];
    return Object.entries(meta)
      .map(([key, value]) => [key, metaText(value)] as const)
      .filter(([, value]) => value !== "")
      .slice(0, 8);
  }, [selectedNode]);

  const hasGraph = !loading && (data?.nodes.length ?? 0) > 0;

  // Native wheel listener: React's root listener is passive, preventDefault
  // would be ignored and the page would scroll while zooming.
  useEffect(() => {
    if (!hasGraph) return;
    const svg = svgRef.current;
    if (!svg) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
      const py = ((event.clientY - rect.top) / rect.height) * HEIGHT;
      setView((prev) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const k = clamp(prev.k * factor, MIN_ZOOM, MAX_ZOOM);
        const ratio = k / prev.k;
        return {
          k,
          x: px - (px - prev.x) * ratio,
          y: py - (py - prev.y) * ratio,
        };
      });
    };

    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [hasGraph]);

  function zoomBy(factor: number) {
    setView((prev) => {
      const k = clamp(prev.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = k / prev.k;
      const centerX = WIDTH / 2;
      const centerY = HEIGHT / 2;
      return {
        k,
        x: centerX - (centerX - prev.x) * ratio,
        y: centerY - (centerY - prev.y) * ratio,
      };
    });
  }

  function resetView() {
    setView({ x: 0, y: 0, k: 1 });
  }

  function handleServiceChange(next: string) {
    setService(next);
    setSelectedKey(null);
    setNeighbors(null);
    setHiddenTypes(new Set());
    resetView();
  }

  function toggleType(type: string) {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; drag still works without it.
    }
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = WIDTH / rect.width;
    const dx = (event.clientX - drag.startX) * scale;
    const dy = (event.clientY - drag.startY) * scale;
    if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
    setView((prev) => ({ ...prev, x: drag.originX + dx, y: drag.originY + dy }));
  }

  function endDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    try {
      svgRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    if (!drag.moved) setSelectedKey(null);
  }

  function handleNodeKeyDown(
    event: ReactKeyboardEvent<SVGGElement>,
    key: string,
  ) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSelectedKey(key);
  }

  const stats = data?.stats ?? { services: 0, alerts: 0, causes: 0, actions: 0 };
  const selectedType = selectedNode ? normalizeType(String(selectedNode.type)) : "other";

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
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
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
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

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
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
                    <svg
                      ref={svgRef}
                      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                      role="group"
                      aria-label="服务告警知识图谱，可缩放与拖拽"
                      className={cn(
                        "block h-auto w-full touch-none select-none bg-surface-secondary/30",
                        dragging ? "cursor-grabbing" : "cursor-grab",
                      )}
                      onPointerDown={handlePointerDown}
                      onPointerMove={handlePointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      <title>知识图谱</title>
                      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                        {visibleEdges.map((edge, index) => {
                          const source = positionByKey.get(rawKey(edge.source));
                          const target = positionByKey.get(rawKey(edge.target));
                          if (!source || !target) return null;
                          const sourceKey = rawKey(edge.source);
                          const targetKey = rawKey(edge.target);
                          const touchesSelected =
                            selectedKey !== null &&
                            (sourceKey === selectedKey || targetKey === selectedKey);
                          return (
                            <line
                              key={`${sourceKey}-${targetKey}-${index}`}
                              x1={source.x}
                              y1={source.y}
                              x2={target.x}
                              y2={target.y}
                              stroke={touchesSelected ? "var(--primary)" : "var(--border)"}
                              strokeWidth={touchesSelected ? 2 : 1}
                              opacity={selectedKey === null ? 0.4 : touchesSelected ? 0.9 : 0.05}
                            />
                          );
                        })}

                        {visibleNodes.map((node) => {
                          const isSelected = node.key === selectedKey;
                          const isNeighbor = selectedKey !== null && highlightKeys.has(node.key);
                          const related = selectedKey === null || isSelected || isNeighbor;
                          const showLabel =
                            node.ntype === "service" ||
                            visibleNodes.length <= 50 ||
                            isSelected ||
                            isNeighbor;
                          return (
                            <g
                              key={node.key}
                              data-node="true"
                              role="button"
                              tabIndex={0}
                              aria-label={`${labelForType(node.ntype)}：${node.label}`}
                              className={cn("cursor-pointer", !related && "cursor-default")}
                              opacity={related ? 1 : 0.18}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedKey(node.key);
                              }}
                              onKeyDown={(event) => handleNodeKeyDown(event, node.key)}
                            >
                              <title>
                                {node.label} · {labelForType(node.ntype)}
                                {node.rawType && node.rawType !== node.ntype
                                  ? `（${node.rawType}）`
                                  : ""}
                              </title>
                              <circle
                                r={node.r}
                                fill={node.color}
                                stroke={
                                  isSelected || isNeighbor
                                    ? "var(--foreground)"
                                    : "var(--card)"
                                }
                                strokeWidth={isSelected ? 3 : isNeighbor ? 2 : 1.5}
                              />
                              {isSelected && (
                                <circle
                                  r={node.r + 4}
                                  fill="none"
                                  stroke="var(--primary)"
                                  strokeWidth={1.5}
                                  strokeDasharray="3 3"
                                />
                              )}
                              {showLabel && (
                                <text
                                  y={node.r + 11}
                                  textAnchor="middle"
                                  className={cn(
                                    "pointer-events-none select-none fill-current text-[10px] font-medium",
                                    isSelected ? "text-text-primary" : "text-text-secondary",
                                  )}
                                >
                                  {truncate(node.label || `#${node.key}`, 16)}
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </g>
                    </svg>

                    <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-card/85 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
                      滚轮缩放 · 拖拽平移 · 点击节点查看邻居
                    </div>

                    <div className="absolute right-3 top-3 flex flex-col gap-1">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="bg-card/90"
                        title="放大"
                        aria-label="放大"
                        onClick={() => zoomBy(1.25)}
                      >
                        <ZoomIn className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="bg-card/90"
                        title="缩小"
                        aria-label="缩小"
                        onClick={() => zoomBy(0.8)}
                      >
                        <ZoomOut className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        className="bg-card/90"
                        title="重置视图"
                        aria-label="重置视图"
                        onClick={resetView}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    <div className="absolute bottom-3 left-3 flex max-w-[92%] flex-wrap gap-1.5">
                      {typeInfos.map((info) => {
                        const hidden = hiddenTypes.has(info.type);
                        return (
                          <button
                            key={info.type}
                            type="button"
                            aria-pressed={!hidden}
                            title={hidden ? "显示该类型" : "隐藏该类型"}
                            onClick={() => toggleType(info.type)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-2 py-1 text-[11px] backdrop-blur transition-opacity hover:bg-muted",
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
                    </div>

                    {visibleNodes.length === 0 && (
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

            {/* Neighbor panel */}
            <Card className="h-fit lg:sticky lg:top-4">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Waypoints className="h-4 w-4 text-interactive-primary" />
                  节点详情
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!selectedNode ? (
                  <div className="space-y-2 py-2">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      点击图中任意节点，高亮它的一跳邻居，并在这里查看邻居列表。
                    </p>
                    <ul className="space-y-1 text-[11px] text-muted-foreground">
                      <li>· 滚轮 / 右下角按钮缩放</li>
                      <li>· 按住空白处拖拽平移</li>
                      <li>· 图例可切换节点类型的显示</li>
                    </ul>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: colorForType(selectedType) }}
                      />
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                          "bg-muted text-text-secondary",
                        )}
                      >
                        {labelForType(selectedType)}
                      </span>
                      <span className="text-[11px] text-muted-foreground">#{String(selectedNode.id)}</span>
                    </div>

                    <p className="break-words text-sm font-semibold text-text-primary">
                      {selectedNode.label || `节点 ${String(selectedNode.id)}`}
                    </p>

                    {metaEntries.length > 0 && (
                      <dl className="space-y-1 rounded-lg border border-border/60 bg-muted/20 p-2 text-[11px]">
                        {metaEntries.map(([key, value]) => (
                          <div key={key} className="flex gap-2">
                            <dt className="w-20 shrink-0 truncate text-muted-foreground">{key}</dt>
                            <dd className="min-w-0 flex-1 break-words text-text-secondary">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}

                    <div className="flex items-center justify-between border-t border-border/60 pt-2">
                      <p className="text-xs font-medium">邻居</p>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {neighborRows.length}
                        {neighborLoading ? " · 加载中…" : ""}
                      </span>
                    </div>

                    {neighborRows.length === 0 ? (
                      <p className="py-3 text-center text-[11px] text-muted-foreground">
                        {neighborLoading ? "正在加载邻居…" : "该节点暂无关联邻居"}
                      </p>
                    ) : (
                      <ul className="max-h-72 space-y-1 overflow-y-auto pr-0.5">
                        {neighborRows.map((row) => (
                          <li key={row.key}>
                            <button
                              type="button"
                              disabled={!row.inView}
                              title={row.inView ? "查看该节点" : "该节点不在当前视图中"}
                              onClick={() => {
                                if (row.inView) setSelectedKey(row.key);
                              }}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                                row.inView
                                  ? "hover:bg-muted"
                                  : "cursor-default opacity-55",
                              )}
                            >
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: row.color }}
                              />
                              <span className="min-w-0 flex-1 truncate text-text-secondary">
                                {row.label}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {row.edgeLabels.join(" · ") || labelForType(row.type)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {neighborError && (
                      <p className="text-[11px] leading-relaxed text-status-investigating">
                        邻居接口不可用，已展示图中直连节点。
                      </p>
                    )}

                    <Button
                      variant="ghostMuted"
                      size="sm"
                      className="w-full"
                      onClick={() => setSelectedKey(null)}
                    >
                      清除选择
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
