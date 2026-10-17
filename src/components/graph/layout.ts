/* ==========================================================================
 *  知识图谱布局 — 纯函数、无第三方依赖
 *
 *  分层力导向（hierarchical force-directed）：
 *    1. 服务节点按 3×N 网格落位（保证整体均匀铺开、互不重叠）；
 *    2. 告警 / 根因 / 处置动作以「锚定服务」为中心分环初始化
 *       （告警内环、根因中环、动作环绕各自根因，角度扇区互斥）；
 *    3. 约 300 次迭代的力导向模拟：斥力按度数加权、弹簧按边权与层级
 *       给不同静止长度、向心力 + 服务锚点、指数冷却与阻尼；
 *    4. 90 轮碰撞松弛（碰撞半径 = r_a + r_b + gap，服务之间额外留白），
 *       保证 57 个节点在 900×560 内不重叠、标签不打架。
 *
 *  标签去重叠：按优先级择优放置（选中/邻居 > 服务 > 其它），下方优先、
 *  上方兜底，并同时避开其它标签与节点圆。
 * ========================================================================== */

export type NodeId = string | number;

export interface GraphNode {
  id: NodeId;
  type: string;
  label: string;
  weight?: number;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  source: NodeId;
  target: NodeId;
  type: string;
  weight?: number;
}

export interface GraphStats {
  services?: number;
  alerts?: number;
  causes?: number;
  actions?: number;
}

export interface GraphOverviewResponse {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  stats?: GraphStats;
}

export interface NeighborsResponse {
  node?: GraphNode;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

export interface TypeMeta {
  label: string;
  color: string;
}

/** 画布坐标（viewBox 单位）。 */
export const GRAPH_WIDTH = 900;
export const GRAPH_HEIGHT = 560;

/** 节点半径范围（按度数映射）。 */
export const MIN_NODE_RADIUS = 6;
export const MAX_NODE_RADIUS = 22;

/** 节点类型的中文名与固定配色（沿用既有主题色）。 */
export const TYPE_DEFS: Record<string, TypeMeta> = {
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
  had_alert: "产生告警",
  root_cause: "根因",
  caused_by: "导致",
  causes: "导致",
  cause: "导致",
  action: "处置",
  resolved_by: "解决",
  resolves: "解决",
  affects: "影响",
  affected_by: "受影响",
  similar: "相似",
  documented_in: "记录于",
  related_to: "相关",
  alert_of: "属于",
  triggered: "触发",
  action_for: "处置",
  suggested_action: "建议动作",
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rawKey(id: NodeId): string {
  return String(id);
}

export function nodeKey(node: GraphNode): string {
  return rawKey(node.id);
}

export function normalizeType(type: string): string {
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

export function colorForType(type: string): string {
  return TYPE_DEFS[type]?.color ?? hashColor(type);
}

export function labelForType(type: string): string {
  return TYPE_DEFS[type]?.label ?? (type === "other" ? "其他" : type);
}

export function edgeTypeLabel(type: string | undefined): string {
  if (!type) return "关联";
  return EDGE_LABELS[type] ?? type;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface PositionedNode extends GraphNode {
  key: string;
  /** 归一化类型（service / alert / cause / action / other）。 */
  ntype: string;
  rawType: string;
  x: number;
  y: number;
  /** 度数：节点半径与 tooltip 的权重来源。 */
  deg: number;
  weightValue: number;
  r: number;
  color: string;
}

export interface LayoutEdge extends GraphEdge {
  key: string;
  sourceKey: string;
  targetKey: string;
  typeLabel: string;
  weightValue: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: LayoutEdge[];
  byKey: Map<string, PositionedNode>;
  width: number;
  height: number;
  /** 归一化类型 → 节点数。 */
  typeCounts: Record<string, number>;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** 模拟迭代次数（默认 300，允许 250~400）。 */
  iterations?: number;
  seed?: number;
}

function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimNode extends PositionedNode {
  vx: number;
  vy: number;
  mass: number;
  charge: number;
  anchorX: number;
  anchorY: number;
}

interface SimEdge {
  a: SimNode;
  b: SimNode;
  rest: number;
  strength: number;
}

/**
 * 计算图谱布局。纯函数：同样的输入（节点顺序 + 固定种子）总能得到同样的输出，
 * 因此筛选 / 图例开关不会让节点跳动。
 */
export function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: LayoutOptions = {},
): LayoutResult {
  const W = options.width ?? GRAPH_WIDTH;
  const H = options.height ?? GRAPH_HEIGHT;
  const ITERATIONS = clamp(Math.round(options.iterations ?? 300), 60, 400);
  const PAD = 20;
  const GAP = 9;

  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      byKey: new Map(),
      width: W,
      height: H,
      typeCounts: {},
    };
  }

  const random = createRandom(options.seed ?? 20261017);
  const placed: SimNode[] = nodes.map((node) => ({
    ...node,
    key: nodeKey(node),
    ntype: normalizeType(String(node.type)),
    rawType: String(node.type ?? ""),
    x: 0,
    y: 0,
    deg: 0,
    weightValue: Math.max(1, Number(node.weight) || 1),
    r: MIN_NODE_RADIUS,
    color: "#8e8ea0",
    vx: 0,
    vy: 0,
    mass: 1,
    charge: 1,
    anchorX: 0,
    anchorY: 0,
  }));

  const byKey = new Map<string, SimNode>();
  for (const node of placed) {
    if (!byKey.has(node.key)) byKey.set(node.key, node);
  }

  // ── 边 / 度数 ─────────────────────────────────────────────────────────
  const adjacency = new Map<string, Array<{ key: string; type: string; weight: number }>>();
  for (const node of byKey.values()) adjacency.set(node.key, []);

  const seenEdges = new Set<string>();
  const rawEdges: Array<{ a: SimNode; b: SimNode; type: string; weight: number }> = [];
  for (const edge of edges) {
    const a = byKey.get(rawKey(edge.source));
    const b = byKey.get(rawKey(edge.target));
    if (!a || !b || a === b) continue;
    const type = String(edge.type ?? "");
    const weight = Math.max(1, Number(edge.weight) || 1);
    const signature = `${a.key}\u0000${b.key}\u0000${type}`;
    if (seenEdges.has(signature)) continue;
    seenEdges.add(signature);
    rawEdges.push({ a, b, type, weight });
    a.deg += 1;
    b.deg += 1;
    adjacency.get(a.key)?.push({ key: b.key, type, weight });
    adjacency.get(b.key)?.push({ key: a.key, type, weight });
  }

  const maxDeg = Math.max(1, ...placed.map((node) => node.deg));
  const typeCounts: Record<string, number> = {};
  for (const node of placed) {
    typeCounts[node.ntype] = (typeCounts[node.ntype] ?? 0) + 1;
    const degreeRatio = maxDeg > 1 ? (node.deg - 1) / (maxDeg - 1) : 0;
    node.r = MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * Math.sqrt(clamp(degreeRatio, 0, 1));
    node.charge = 0.9 + 0.5 * Math.sqrt(clamp(degreeRatio, 0, 1));
    node.mass = node.ntype === "service" ? 3.4 : node.ntype === "cause" ? 1.7 : 1;
    node.color = colorForType(node.ntype);
  }

  // ── 服务锚点（网格） ──────────────────────────────────────────────────
  const cx = W / 2;
  const cy = H / 2;
  const services = placed
    .filter((node) => node.ntype === "service")
    .sort((a, b) => b.deg - a.deg || a.key.localeCompare(b.key));

  const nS = services.length;
  let cols = 1;
  let rows = 1;
  if (nS > 0) {
    let bestScore = -1;
    for (let c = 1; c <= nS; c += 1) {
      const r = Math.ceil(nS / c);
      if (c * r < nS) continue;
      const sx = c > 1 ? (0.64 * W) / (c - 1) : Number.POSITIVE_INFINITY;
      const sy = r > 1 ? (0.51 * H) / (r - 1) : Number.POSITIVE_INFINITY;
      const score = Math.min(sx, sy);
      if (score > bestScore) {
        bestScore = score;
        cols = c;
        rows = r;
      }
    }
  }
  const cell = Math.min(
    cols > 1 ? (0.64 * W) / (cols - 1) : 320,
    rows > 1 ? (0.51 * H) / (rows - 1) : 250,
  );
  const clusterScale = clamp(cell / 300, 0.5, 1.15);
  const alertRing = 62 * clusterScale;
  const causeRing = 88 * clusterScale;
  const actionRing = 34 * clusterScale;

  services.forEach((service, index) => {
    const row = Math.floor(index / cols);
    const inRow = Math.min(cols, nS - row * cols);
    const col = index - row * cols;
    const fx = inRow === 1 ? 0.5 : 0.19 + (col / (inRow - 1)) * 0.62;
    const fy = rows === 1 ? 0.5 : 0.255 + (row / (rows - 1)) * 0.49;
    service.x = W * fx + (random() - 0.5) * 14;
    service.y = H * fy + (random() - 0.5) * 14;
    service.anchorX = service.x;
    service.anchorY = service.y;
  });

  // ── 归属服务（告警 / 根因 / 动作的锚点） ───────────────────────────────
  const anchor = new Map<string, SimNode>();
  for (const service of services) anchor.set(service.key, service);

  const serviceNeighbours = (node: SimNode): SimNode[] => {
    const result: SimNode[] = [];
    for (const link of adjacency.get(node.key) ?? []) {
      const other = byKey.get(link.key);
      if (other?.ntype === "service") result.push(other);
    }
    return result;
  };

  for (const node of placed) {
    if (node.ntype === "service" || node.ntype === "action") continue;
    const owners = serviceNeighbours(node);
    if (owners.length === 0) continue;
    // 选择权重更高（连接计数更大）的服务；同样则按 id 稳定排序。
    let best: SimNode | null = null;
    let bestWeight = -1;
    for (const owner of owners) {
      let weight = 0;
      for (const link of adjacency.get(owner.key) ?? []) {
        if (link.key === node.key) weight += link.weight;
      }
      if (weight > bestWeight || (weight === bestWeight && (!best || owner.key < best.key))) {
        best = owner;
        bestWeight = weight;
      }
    }
    if (best) anchor.set(node.key, best);
  }

  for (const node of placed) {
    if (node.ntype !== "action" || anchor.has(node.key)) continue;
    let viaCause: SimNode | null = null;
    let viaService: SimNode | null = null;
    for (const link of adjacency.get(node.key) ?? []) {
      const other = byKey.get(link.key);
      if (other?.ntype === "cause") viaCause = other;
      if (other?.ntype === "service") viaService = other;
    }
    const host = (viaCause && anchor.get(viaCause.key)) || viaService;
    if (host) anchor.set(node.key, host);
  }

  // 兜底：BFS 查找最近的服务节点
  for (const node of placed) {
    if (node.ntype === "service" || anchor.has(node.key)) continue;
    const visited = new Set<string>([node.key]);
    let frontier: SimNode[] = [node];
    let found: SimNode | null = null;
    for (let depth = 0; depth < 4 && !found; depth += 1) {
      const next: SimNode[] = [];
      for (const current of frontier) {
        for (const link of adjacency.get(current.key) ?? []) {
          const other = byKey.get(link.key);
          if (!other || visited.has(other.key)) continue;
          visited.add(other.key);
          if (other.ntype === "service") {
            found = other;
            break;
          }
          next.push(other);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (found) anchor.set(node.key, found);
  }

  // ── 初始位置：分层分环 ────────────────────────────────────────────────
  const groups = new Map<string, SimNode[]>();
  for (const service of services) groups.set(service.key, []);
  const loose: SimNode[] = [];
  for (const node of placed) {
    if (node.ntype === "service") continue;
    const host = anchor.get(node.key);
    if (host) groups.get(host.key)?.push(node);
    else loose.push(node);
  }

  const TWO_PI = Math.PI * 2;
  const sine = Math.sin;
  const cosine = Math.cos;

  services.forEach((service, index) => {
    const members = groups.get(service.key) ?? [];
    const alerts = members
      .filter((node) => node.ntype === "alert")
      .sort((a, b) => b.deg - a.deg || a.key.localeCompare(b.key));
    const causes = members
      .filter((node) => node.ntype === "cause")
      .sort((a, b) => b.deg - a.deg || a.key.localeCompare(b.key));
    const actions = members.filter((node) => node.ntype === "action");

    const outward =
      nS <= 1 ? -Math.PI / 2 : Math.atan2(service.y - cy, service.x - cx) + (index % 2 ? 0.18 : -0.12);

    const causeSpread = causes.length <= 1 ? 0 : Math.min(1.15, TWO_PI / 9);
    const causeAngle = new Map<string, number>();
    causes.forEach((cause, order) => {
      const angle = outward + (order - (causes.length - 1) / 2) * causeSpread;
      causeAngle.set(cause.key, angle);
      cause.x = service.x + cosine(angle) * causeRing;
      cause.y = service.y + sine(angle) * causeRing;
    });

    const causeSector = causes.length > 0 ? causeSpread * causes.length + 0.5 : 0;
    const available = TWO_PI - causeSector;
    const start = outward + causeSector / 2;
    const alertRingForCount = alertRing + Math.min(26, Math.max(0, alerts.length - 5) * 4);
    alerts.forEach((alert, order) => {
      const angle =
        alerts.length <= 1
          ? start + available / 2
          : start + (order / alerts.length) * available;
      alert.x = service.x + cosine(angle) * alertRingForCount;
      alert.y = service.y + sine(angle) * alertRingForCount;
    });

    const actionsByCause = new Map<string, SimNode[]>();
    for (const action of actions) {
      let host: string | null = null;
      for (const link of adjacency.get(action.key) ?? []) {
        const other = byKey.get(link.key);
        if (other?.ntype === "cause" && groups.get(service.key)?.includes(other)) {
          host = other.key;
          break;
        }
      }
      const listKey = host ?? "__service";
      const list = actionsByCause.get(listKey) ?? [];
      list.push(action);
      actionsByCause.set(listKey, list);
    }
    for (const [hostKey, list] of actionsByCause) {
      const host = hostKey === "__service" ? service : byKey.get(hostKey) ?? service;
      const base = hostKey === "__service" ? outward : causeAngle.get(hostKey) ?? outward;
      const spread = Math.min(1.5, 0.5 * list.length);
      list.forEach((action, order) => {
        const t = list.length <= 1 ? 0 : order / (list.length - 1) - 0.5;
        const angle = base + t * spread + (order % 2 ? 0.14 : -0.14);
        action.x = host.x + cosine(angle) * actionRing;
        action.y = host.y + sine(angle) * actionRing;
      });
    }
  });

  loose.forEach((node, index) => {
    const angle = (index / Math.max(1, loose.length)) * TWO_PI;
    node.x = cx + cosine(angle) * (W * 0.36);
    node.y = cy + sine(angle) * (H * 0.34);
  });

  // ── 弹簧（按边类型与边权） ────────────────────────────────────────────
  const area = (W - 2 * PAD) * (H - 2 * PAD);
  const k = Math.sqrt(area / placed.length) * 0.62;
  const restByType: Record<string, number> = {
    had_alert: alertRing + 8,
    root_cause: causeRing,
    action: actionRing,
    similar: Math.min(W, H) * 0.42,
  };
  const springs: SimEdge[] = rawEdges.map((edge) => {
    const bothServices = edge.a.ntype === "service" && edge.b.ntype === "service";
    const leaf = !bothServices && (edge.a.ntype === "service" || edge.b.ntype === "service");
    const base = restByType[edge.type] ?? k;
    return {
      a: edge.a,
      b: edge.b,
      rest: base + edge.a.r + edge.b.r,
      strength: bothServices
        ? 0.012
        : 0.06 * (0.55 + Math.min(4, edge.weight) * 0.15) * (leaf ? 1.7 : 1),
    };
  });

  // ── 力导向迭代 ────────────────────────────────────────────────────────
  const K_REPULSION = 240;
  const DAMPING = 0.66;
  const n = placed.length;
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const alpha = Math.max(0.02, 1 - iteration / ITERATIONS);

    // 斥力：按度数加权的电荷，距离越近越强
    for (let i = 0; i < n; i += 1) {
      const a = placed[i]!;
      for (let j = i + 1; j < n; j += 1) {
        const b = placed[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 0.01) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          distanceSq = 0.01;
        }
        const distance = Math.sqrt(distanceSq);
        const force = Math.min(
          (K_REPULSION * a.charge * b.charge) / distanceSq,
          9,
        );
        const ux = dx / distance;
        const uy = dy / distance;
        a.vx -= (ux * force) / a.mass;
        a.vy -= (uy * force) / a.mass;
        b.vx += (ux * force) / b.mass;
        b.vy += (uy * force) / b.mass;
      }
    }

    // 弹簧：边权越大越硬，层级不同静止长度不同
    for (const spring of springs) {
      const { a, b } = spring;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const force = (distance - spring.rest) * spring.strength;
      const ux = dx / distance;
      const uy = dy / distance;
      a.vx += (ux * force) / a.mass;
      a.vy += (uy * force) / a.mass;
      b.vx -= (ux * force) / b.mass;
      b.vy -= (uy * force) / b.mass;
    }

    // 服务锚点（保持分层网格） + 全局向心力
    for (const service of services) {
      service.vx += (service.anchorX - service.x) * 0.06;
      service.vy += (service.anchorY - service.y) * 0.06;
    }
    for (const node of placed) {
      const gravity = node.ntype === "service" ? 0.002 : 0.0006;
      node.vx += (cx - node.x) * gravity;
      node.vy += (cy - node.y) * gravity;
    }

    // 冷却：速度阻尼 + 单步位移上限
    const step = 0.06 + 0.4 * alpha;
    const maxSpeed = 20 * alpha + 1.5;
    for (const node of placed) {
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      const speed = Math.hypot(node.vx, node.vy);
      if (speed > maxSpeed) {
        node.vx = (node.vx / speed) * maxSpeed;
        node.vy = (node.vy / speed) * maxSpeed;
      }
      node.x += node.vx * step;
      node.y += node.vy * step;
      node.x = clamp(node.x, PAD + node.r, W - PAD - node.r);
      node.y = clamp(node.y, PAD + node.r, H - PAD - node.r);
    }
  }

  // ── 碰撞松弛：节点半径 + 间距；服务之间额外留出簇间距 ────────────────
  const serviceClearance = 150;
  for (let pass = 0; pass < 90; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = placed[i]!;
      for (let j = i + 1; j < n; j += 1) {
        const b = placed[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          distance = Math.hypot(dx, dy) || 0.01;
        }
        const bothServices = a.ntype === "service" && b.ntype === "service";
        const wanted = a.r + b.r + (bothServices ? serviceClearance : GAP);
        if (distance >= wanted) continue;
        const push = (wanted - distance) * 0.5;
        const ux = dx / distance;
        const uy = dy / distance;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
    for (const node of placed) {
      node.x = clamp(node.x, PAD + node.r, W - PAD - node.r);
      node.y = clamp(node.y, PAD + node.r, H - PAD - node.r);
    }
  }

  // ── 最终铺开：小图放大到画布（只放大，不会引入新的重叠） ──────────────
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxRadius = MIN_NODE_RADIUS;
  for (const node of placed) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
    maxRadius = Math.max(maxRadius, node.r);
  }
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);
  const availWidth = W - 2 * PAD - 2 * maxRadius;
  const availHeight = H - 2 * PAD - 2 * maxRadius;
  let scaleX = clamp(availWidth / boundsWidth, 1, 2.2);
  let scaleY = clamp(availHeight / boundsHeight, 1, 2.2);
  // 限制纵横比失真，让簇保持接近圆形
  if (scaleX / scaleY > 1.7) scaleX = scaleY * 1.7;
  else if (scaleY / scaleX > 1.7) scaleY = scaleX * 1.7;
  const middleX = (minX + maxX) / 2;
  const middleY = (minY + maxY) / 2;
  for (const node of placed) {
    node.x = cx + (node.x - middleX) * scaleX;
    node.y = cy + (node.y - middleY) * scaleY;
  }

  // ── 输出 ──────────────────────────────────────────────────────────────
  const positioned: PositionedNode[] = placed.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    weight: node.weight,
    meta: node.meta,
    key: node.key,
    ntype: node.ntype,
    rawType: node.rawType,
    x: Math.round(node.x * 100) / 100,
    y: Math.round(node.y * 100) / 100,
    deg: node.deg,
    weightValue: node.weightValue,
    r: Math.round(node.r * 100) / 100,
    color: node.color,
  }));
  const positionedByKey = new Map(positioned.map((node) => [node.key, node]));

  const layoutEdges: LayoutEdge[] = rawEdges.map((edge, index) => ({
    source: edge.a.id,
    target: edge.b.id,
    type: edge.type,
    weight: edge.weight,
    key: `${edge.a.key}\u0000${edge.b.key}\u0000${edge.type}\u0000${index}`,
    sourceKey: edge.a.key,
    targetKey: edge.b.key,
    typeLabel: edgeTypeLabel(edge.type),
    weightValue: Number(edge.weight) || 1,
  }));

  return {
    nodes: positioned,
    edges: layoutEdges,
    byKey: positionedByKey,
    width: W,
    height: H,
    typeCounts,
  };
}

/* ==========================================================================
 *  局部斥力：拖动单个节点后只松弛其周边的邻居，保持全局布局稳定
 * ========================================================================== */

export function relaxAround(
  positions: Map<string, { x: number; y: number }>,
  nodes: PositionedNode[],
  pinnedKey: string,
  radius = 240,
  passes = 14,
): Map<string, { x: number; y: number }> {
  const pinned = positions.get(pinnedKey);
  if (!pinned) return positions;
  const centre = nodes.find((node) => node.key === pinnedKey);
  if (!centre) return positions;

  const affected = nodes.filter((node) => {
    if (node.key === pinnedKey) return false;
    const point = positions.get(node.key);
    if (!point) return false;
    return Math.hypot(point.x - pinned.x, point.y - pinned.y) <= radius + node.r;
  });
  if (affected.length === 0) return positions;

  const next = new Map(positions);
  for (let pass = 0; pass < passes; pass += 1) {
    const target = next.get(pinnedKey) ?? pinned;
    for (const node of affected) {
      const point = next.get(node.key);
      if (!point) continue;
      let dx = point.x - target.x;
      let dy = point.y - target.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.01) {
        dx = 0.01;
        dy = 0.01;
        distance = 0.01;
      }
      const wanted = centre.r + node.r + 9;
      if (distance < wanted) {
        const push = (wanted - distance) * 0.5;
        next.set(node.key, {
          x: point.x + (dx / distance) * push,
          y: point.y + (dy / distance) * push,
        });
      }
    }
    // 受影响节点之间也互相推开，避免挤压成一团
    for (let i = 0; i < affected.length; i += 1) {
      const a = affected[i]!;
      const pa = next.get(a.key);
      if (!pa) continue;
      for (let j = i + 1; j < affected.length; j += 1) {
        const b = affected[j]!;
        const pb = next.get(b.key);
        if (!pb) continue;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = 0.01;
          dy = 0.01;
          distance = 0.01;
        }
        const wanted = a.r + b.r + 9;
        if (distance >= wanted) continue;
        const push = (wanted - distance) * 0.35;
        pa.x -= (dx / distance) * push;
        pa.y -= (dy / distance) * push;
        pb.x += (dx / distance) * push;
        pb.y += (dy / distance) * push;
      }
    }
    for (const node of affected) {
      const point = next.get(node.key);
      if (!point) continue;
      point.x = clamp(point.x, node.r + 20, GRAPH_WIDTH - node.r - 20);
      point.y = clamp(point.y, node.r + 20, GRAPH_HEIGHT - node.r - 20);
    }
  }
  return next;
}

/* ==========================================================================
 *  标签去重叠
 * ========================================================================== */

export interface LabelCandidate {
  key: string;
  x: number;
  y: number;
  r: number;
  text: string;
  priority: number;
}

export interface LabelPlacement {
  x: number;
  y: number;
  width: number;
  text: string;
}

export interface LabelContext {
  fontSize: number;
  /** 标签与节点圆之间的间隙（画布单位）。 */
  gap?: number;
  width: number;
  height: number;
  /** 参与避让的节点圆（通常是全部可见节点）。 */
  circles: Array<{ key: string; x: number; y: number; r: number }>;
}

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 估算单行文本宽度（CJK ≈ 1em，其余 ≈ 0.56em）。 */
export function measureText(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += CJK_RE.test(char) ? fontSize : fontSize * 0.56;
  return width;
}

function overlaps(
  box: { x: number; y: number; w: number; h: number },
  other: { x: number; y: number; w: number; h: number },
): boolean {
  return !(
    box.x + box.w < other.x ||
    box.x > other.x + other.w ||
    box.y + box.h < other.y ||
    box.y > other.y + other.h
  );
}

/**
 * 贪心放置标签：优先保证选中/邻居/服务节点，其次高权重节点；下方优先，
 * 其次上方，最后才放弃。标签与节点圆、已放置标签都不能相交。
 */
export function layoutLabels(
  candidates: LabelCandidate[],
  context: LabelContext,
): Map<string, LabelPlacement> {
  const result = new Map<string, LabelPlacement>();
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const fontSize = context.fontSize;
  const height = fontSize + 2;

  const sorted = [...candidates].sort(
    (a, b) => b.priority - a.priority || b.r - a.r,
  );

  for (const candidate of sorted) {
    const text = truncate(candidate.text, 18);
    const width = measureText(text, fontSize);
    const gap = context.gap ?? 4;
    const below = {
      x: candidate.x - width / 2,
      y: candidate.y + candidate.r + gap,
      w: width,
      h: height,
    };
    const above = {
      x: candidate.x - width / 2,
      y: candidate.y - candidate.r - gap - height,
      w: width,
      h: height,
    };

    const fits = (box: { x: number; y: number; w: number; h: number }) => {
      if (
        box.x < 2 ||
        box.y < 2 ||
        box.x + box.w > context.width - 2 ||
        box.y + box.h > context.height - 2
      ) {
        return false;
      }
      if (placed.some((other) => overlaps(box, other))) return false;
      for (const circle of context.circles) {
        if (circle.key === candidate.key) continue;
        const nearestX = clamp(circle.x, box.x, box.x + box.w);
        const nearestY = clamp(circle.y, box.y, box.y + box.h);
        if (Math.hypot(circle.x - nearestX, circle.y - nearestY) < circle.r + 1) {
          return false;
        }
      }
      return true;
    };

    const box = fits(below) ? below : fits(above) ? above : null;
    if (!box) continue;
    placed.push(box);
    result.set(candidate.key, {
      x: candidate.x,
      y: box.y + fontSize,
      width,
      text,
    });
  }

  return result;
}
