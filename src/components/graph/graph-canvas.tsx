import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LocateFixed, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clamp,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  labelForType,
  layoutLabels,
  relaxAround,
  truncate,
  type LayoutResult,
  type PositionedNode,
} from "./layout";

/* ==========================================================================
 *  自绘 SVG 图谱画布
 *
 *  - 视图变换：滚轮以鼠标为焦点缩放、拖拽空白平移、按钮 / 键盘 +/- 缩放
 *  - 节点：拖拽（局部斥力松弛）、单击聚焦、双击打开详情、悬停 tooltip
 *  - 标签：按缩放级别显示 + 贪心去重叠，字号/描边在屏幕上保持恒定
 * ========================================================================== */

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;
const LABEL_FONT = 12;

interface Point {
  x: number;
  y: number;
}

interface ViewState {
  x: number;
  y: number;
  k: number;
}

export interface FocusRequest {
  key: string;
  seq: number;
}

interface GraphCanvasProps {
  layout: LayoutResult;
  hiddenTypes: Set<string>;
  selectedKey: string | null;
  detailKey: string | null;
  searchKeys: string[];
  focusRequest: FocusRequest | null;
  onSelectNode: (key: string) => void;
  onOpenDetail: (key: string) => void;
  onClearSelection: () => void;
}

interface HoverState {
  key: string;
  left: number;
  top: number;
}

interface NodeDragState {
  key: string;
  pointerId: number;
  offset: Point;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

interface PanDragState {
  pointerId: number;
  start: Point;
  origin: Point;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

function initialPositions(layout: LayoutResult): Map<string, Point> {
  return new Map(layout.nodes.map((node) => [node.key, { x: node.x, y: node.y }]));
}

export function GraphCanvas({
  layout,
  hiddenTypes,
  selectedKey,
  detailKey,
  searchKeys,
  focusRequest,
  onSelectNode,
  onOpenDetail,
  onClearSelection,
}: GraphCanvasProps) {
  const [positions, setPositions] = useState<Map<string, Point>>(() => initialPositions(layout));
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [dragging, setDragging] = useState<"pan" | "node" | null>(null);
  const [displayWidth, setDisplayWidth] = useState(GRAPH_WIDTH);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef(view);
  const positionsRef = useRef(positions);
  const panRef = useRef<PanDragState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const pendingKeyRef = useRef<string | null>(null);

  viewRef.current = view;
  positionsRef.current = positions;

  // 数据 / 服务筛选变化 → 重新初始化位置与视图
  useLayoutEffect(() => {
    setPositions(initialPositions(layout));
    setView({ x: 0, y: 0, k: 1 });
    setHover(null);
  }, [layout]);

  // 画布实际渲染宽度：用于让标签与描边接近恒定的屏幕像素尺寸
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setDisplayWidth(element.clientWidth || GRAPH_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const screenScale = Math.max(0.2, displayWidth / GRAPH_WIDTH);
  const zoomScale = Math.max(0.2, view.k * screenScale);
  /** 把「屏幕像素」换算成当前变换下的画布单位。 */
  const pixel = useCallback((value: number) => value / zoomScale, [zoomScale]);

  const visibleNodes = useMemo(
    () => layout.nodes.filter((node) => !hiddenTypes.has(node.ntype)),
    [layout.nodes, hiddenTypes],
  );

  const visibleKeys = useMemo(
    () => new Set(visibleNodes.map((node) => node.key)),
    [visibleNodes],
  );

  const visibleEdges = useMemo(
    () => layout.edges.filter((edge) => visibleKeys.has(edge.sourceKey) && visibleKeys.has(edge.targetKey)),
    [layout.edges, visibleKeys],
  );

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of visibleEdges) {
      if (!map.has(edge.sourceKey)) map.set(edge.sourceKey, new Set());
      if (!map.has(edge.targetKey)) map.set(edge.targetKey, new Set());
      map.get(edge.sourceKey)?.add(edge.targetKey);
      map.get(edge.targetKey)?.add(edge.sourceKey);
    }
    return map;
  }, [visibleEdges]);

  const neighborKeys = useMemo(() => {
    if (!selectedKey) return new Set<string>();
    return new Set(adjacency.get(selectedKey) ?? []);
  }, [adjacency, selectedKey]);

  const searchSet = useMemo(() => new Set(searchKeys), [searchKeys]);

  /** client 坐标 → SVG viewBox 坐标（正确处理 letterbox 与缩放）。 */
  const toCanvas = useCallback((clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }, []);

  const toGraph = useCallback((point: Point): Point => {
    const current = viewRef.current;
    return { x: (point.x - current.x) / current.k, y: (point.y - current.y) / current.k };
  }, []);

  const zoomAt = useCallback((factor: number, focus?: Point) => {
    setView((previous) => {
      const k = clamp(previous.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = k / previous.k;
      const fx = focus?.x ?? GRAPH_WIDTH / 2;
      const fy = focus?.y ?? GRAPH_HEIGHT / 2;
      return { k, x: fx - (fx - previous.x) * ratio, y: fy - (fy - previous.y) * ratio };
    });
  }, []);

  const fitView = useCallback(
    (keys?: Iterable<string>) => {
      const keyList = keys ? [...keys] : [...visibleKeys];
      const nodes = keyList
        .map((key) => layout.byKey.get(key))
        .filter((node): node is PositionedNode => Boolean(node));
      if (nodes.length === 0) return;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const node of nodes) {
        const point = positionsRef.current.get(node.key) ?? node;
        minX = Math.min(minX, point.x - node.r);
        maxX = Math.max(maxX, point.x + node.r);
        minY = Math.min(minY, point.y - node.r);
        maxY = Math.max(maxY, point.y + node.r);
      }
      const paddingX = 54;
      const paddingY = 44;
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const k = clamp(
        Math.min((GRAPH_WIDTH - paddingX * 2) / width, (GRAPH_HEIGHT - paddingY * 2) / height),
        MIN_ZOOM,
        nodes.length <= 2 ? 2.2 : 1.8,
      );
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      setView({
        k,
        x: GRAPH_WIDTH / 2 - centerX * k,
        y: GRAPH_HEIGHT / 2 - centerY * k,
      });
    },
    [layout.byKey, visibleKeys],
  );

  const resetView = useCallback(() => {
    setPositions(initialPositions(layout));
    setView({ x: 0, y: 0, k: 1 });
  }, [layout]);

  // 聚焦请求（单击节点 / 搜索结果 / 侧栏「聚焦」）
  useEffect(() => {
    if (!focusRequest) return;
    const node = layout.byKey.get(focusRequest.key);
    if (!node) return;
    const group = new Set<string>([node.key]);
    for (const key of adjacency.get(node.key) ?? []) group.add(key);
    fitView(group);
  }, [focusRequest?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚轮：以鼠标位置为焦点缩放（原生监听，React 的 wheel 是 passive）
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toCanvas(event.clientX, event.clientY);
      if (!point) return;
      zoomAt(Math.exp(-event.deltaY * 0.0016), point);
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [toCanvas, zoomAt]);

  // 键盘 +/- 缩放（在输入框中不拦截）
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomAt(1.2);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomAt(1 / 1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        fitView();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [zoomAt, resetView, fitView]);

  /** 单击聚焦延迟 220ms：双击时取消，避免第一次点击就缩放导致第二次点空。 */
  const scheduleSelect = useCallback(
    (key: string) => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      pendingKeyRef.current = key;
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        const pending = pendingKeyRef.current;
        pendingKeyRef.current = null;
        if (pending) onSelectNode(pending);
      }, 220);
    },
    [onSelectNode],
  );

  const cancelScheduledSelect = useCallback(() => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    pendingKeyRef.current = null;
  }, []);

  useEffect(() => () => cancelScheduledSelect(), [cancelScheduledSelect]);

  const startNodeDrag = useCallback(
    (event: ReactPointerEvent<SVGGElement>, node: PositionedNode) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const canvasPoint = toCanvas(event.clientX, event.clientY);
      if (!canvasPoint) return;
      const graphPoint = toGraph(canvasPoint);
      const point = positionsRef.current.get(node.key) ?? node;
      try {
        svgRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // 指针捕获是增强项，失败也能拖拽
      }
      nodeDragRef.current = {
        key: node.key,
        pointerId: event.pointerId,
        offset: { x: graphPoint.x - point.x, y: graphPoint.y - point.y },
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      };
      setDragging("node");
      setHover(null);
    },
    [toCanvas, toGraph],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const nodeDrag = nodeDragRef.current;
      if (nodeDrag) {
        if (Math.hypot(event.clientX - nodeDrag.startClientX, event.clientY - nodeDrag.startClientY) > 3) {
          nodeDrag.moved = true;
        }
        const canvasPoint = toCanvas(event.clientX, event.clientY);
        if (!canvasPoint) return;
        const graphPoint = toGraph(canvasPoint);
        const next = { x: graphPoint.x - nodeDrag.offset.x, y: graphPoint.y - nodeDrag.offset.y };
        setPositions((previous) => {
          const updated = new Map(previous);
          updated.set(nodeDrag.key, next);
          return nodeDrag.moved ? relaxAround(updated, visibleNodes, nodeDrag.key, 230, 8) : updated;
        });
        return;
      }

      const pan = panRef.current;
      if (!pan) return;
      const canvasPoint = toCanvas(event.clientX, event.clientY);
      if (!canvasPoint) return;
      if (Math.hypot(event.clientX - pan.startClientX, event.clientY - pan.startClientY) > 3) {
        pan.moved = true;
      }
      if (!pan.moved) return;
      setView((previous) => ({
        ...previous,
        x: pan.origin.x + (canvasPoint.x - pan.start.x),
        y: pan.origin.y + (canvasPoint.y - pan.start.y),
      }));
    },
    [toCanvas, toGraph, visibleNodes],
  );

  const finishInteraction = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const nodeDrag = nodeDragRef.current;
      if (nodeDrag) {
        nodeDragRef.current = null;
        setDragging(null);
        try {
          svgRef.current?.releasePointerCapture(nodeDrag.pointerId);
        } catch {
          // ignore
        }
        if (!nodeDrag.moved) scheduleSelect(nodeDrag.key);
        return;
      }
      const pan = panRef.current;
      if (pan) {
        panRef.current = null;
        setDragging(null);
        try {
          svgRef.current?.releasePointerCapture(pan.pointerId);
        } catch {
          // ignore
        }
        if (!pan.moved) {
          cancelScheduledSelect();
          onClearSelection();
        }
      }
    },
    [scheduleSelect, cancelScheduledSelect, onClearSelection],
  );

  const handlePanePointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const canvasPoint = toCanvas(event.clientX, event.clientY);
      if (!canvasPoint) return;
      const current = viewRef.current;
      try {
        svgRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      panRef.current = {
        pointerId: event.pointerId,
        start: canvasPoint,
        origin: { x: current.x, y: current.y },
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      };
      setDragging("pan");
      setHover(null);
    },
    [toCanvas],
  );

  const handleNodeKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>, key: string) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onSelectNode(key);
      } else if (event.key === " ") {
        event.preventDefault();
        onOpenDetail(key);
      }
    },
    [onSelectNode, onOpenDetail],
  );

  /**
   * 双击打开详情：在 SVG 上做命中测试而不是依赖节点上的 dblclick。
   * （指针捕获会把 click/dblclick 重定向到捕获元素，节点级 dblclick 不可靠。）
   */
  const handlePaneDoubleClick = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const canvasPoint = toCanvas(event.clientX, event.clientY);
      if (!canvasPoint) return;
      const graphPoint = toGraph(canvasPoint);
      let best: PositionedNode | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const node of visibleNodes) {
        const point = positionsRef.current.get(node.key) ?? node;
        const distance = Math.hypot(point.x - graphPoint.x, point.y - graphPoint.y);
        const hitRadius = Math.max(node.r + 2, 9 / zoomScale);
        if (distance <= hitRadius && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      if (!best) return;
      cancelScheduledSelect();
      onOpenDetail(best.key);
    },
    [toCanvas, toGraph, visibleNodes, zoomScale, cancelScheduledSelect, onOpenDetail],
  );

  // ── 标签：按缩放级别决定候选集，再贪心去重叠 ──────────────────────────
  const labelLevel = view.k >= 2.4 ? 3 : view.k >= 1.55 ? 2 : 1;
  const showAllLabels = visibleNodes.length <= 16;
  const onlyServiceLabels = visibleNodes.length > 60;
  const labelFontGraph = pixel(clamp(LABEL_FONT * screenScale, 8, 13));
  const labelGap = pixel(4);

  const labels = useMemo(() => {
    const candidates: Array<{
      key: string;
      x: number;
      y: number;
      r: number;
      text: string;
      priority: number;
    }> = [];
    for (const node of visibleNodes) {
      const special =
        node.key === selectedKey ||
        node.key === detailKey ||
        node.key === hover?.key ||
        searchSet.has(node.key);
      // 聚焦某个节点时只保留它与一跳邻居的标签，避免远处标签造成干扰
      if (selectedKey && !special && !(adjacency.get(selectedKey)?.has(node.key) ?? false)) {
        continue;
      }
      const isService = node.ntype === "service";
      let show = special || isService;
      if (!show) {
        if (onlyServiceLabels) show = false;
        else if (showAllLabels) show = true;
        else if (node.ntype === "alert") show = labelLevel >= 3;
        else show = labelLevel >= 2;
      }
      if (!show) continue;
      const point = positions.get(node.key) ?? { x: node.x, y: node.y };
      candidates.push({
        key: node.key,
        x: point.x,
        y: point.y,
        r: node.r,
        text: node.label || `#${node.id}`,
        priority: special ? 1000 : isService ? 500 : 100 + node.deg,
      });
    }
    return layoutLabels(candidates, {
      fontSize: labelFontGraph,
      gap: labelGap,
      width: GRAPH_WIDTH,
      height: GRAPH_HEIGHT,
      circles: visibleNodes.map((node) => {
        const point = positions.get(node.key) ?? { x: node.x, y: node.y };
        return { key: node.key, x: point.x, y: point.y, r: node.r };
      }),
    });
  }, [
    visibleNodes,
    selectedKey,
    detailKey,
    hover,
    searchSet,
    adjacency,
    labelLevel,
    showAllLabels,
    onlyServiceLabels,
    positions,
    labelFontGraph,
    labelGap,
  ]);

  const hoveredNode = hover ? layout.byKey.get(hover.key) ?? null : null;

  const handleNodeEnter = useCallback((event: ReactPointerEvent<SVGGElement>, key: string) => {
    if (nodeDragRef.current || panRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHover({
      key,
      left: clamp(event.clientX - rect.left + 16, 8, Math.max(8, rect.width - 250)),
      top: clamp(event.clientY - rect.top + 14, 8, Math.max(8, rect.height - 86)),
    });
  }, []);

  const edgeWidth = pixel(1.1);
  const hasSelection = selectedKey !== null;
  const labelText = (text: string) => truncate(text, 18);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        role="group"
        aria-label="服务告警知识图谱，可缩放、平移与拖动节点"
        className={cn(
          "absolute inset-0 h-full w-full touch-none select-none",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={handlePanePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={handlePaneDoubleClick}
      >
        <title>知识图谱</title>

        <defs>
          <radialGradient id="node-sheen" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* 边：低透明度；选中 / 悬停节点的相关边高亮 */}
          <g aria-hidden className="text-border">
            {visibleEdges.map((edge) => {
              const source = positions.get(edge.sourceKey);
              const target = positions.get(edge.targetKey);
              if (!source || !target) return null;
              const touchesSelected =
                hasSelection && (edge.sourceKey === selectedKey || edge.targetKey === selectedKey);
              const touchesHover =
                hover !== null && (edge.sourceKey === hover.key || edge.targetKey === hover.key);
              const weight = Math.min(3, edge.weightValue);
              return (
                <line
                  key={edge.key}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="currentColor"
                  strokeWidth={edgeWidth * (0.8 + weight * 0.28)}
                  strokeLinecap="round"
                  className={cn(
                    "transition-opacity duration-150",
                    touchesHover || touchesSelected ? "text-primary" : "text-border",
                  )}
                  opacity={
                    touchesHover
                      ? 0.95
                      : touchesSelected
                        ? 0.8
                        : hasSelection
                          ? 0.1
                          : edge.type === "similar"
                            ? 0.16
                            : 0.3
                  }
                />
              );
            })}
          </g>

          {/* 节点 */}
          {visibleNodes.map((node) => {
            const point = positions.get(node.key) ?? { x: node.x, y: node.y };
            const isSelected = node.key === selectedKey;
            const isDetail = node.key === detailKey;
            const isNeighbor = hasSelection && neighborKeys.has(node.key);
            const isHovered = hover?.key === node.key;
            const isSearch = searchSet.has(node.key);
            const dimmed = hasSelection && !isSelected && !isNeighbor;
            return (
              <g
                key={node.key}
                data-node={node.key}
                transform={`translate(${point.x} ${point.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${labelForType(node.ntype)}：${node.label}`}
                aria-pressed={isSelected}
                className={cn(
                  "cursor-pointer outline-none transition-opacity duration-150",
                  dimmed && "opacity-25",
                )}
                onPointerDown={(event) => startNodeDrag(event, node)}
                onPointerEnter={(event) => handleNodeEnter(event, node.key)}
                onPointerLeave={() => setHover(null)}
                onKeyDown={(event) => handleNodeKeyDown(event, node.key)}
              >
                {/* 透明命中区：小节点 / 缩小视图下也方便点选 */}
                <circle r={Math.max(node.r + 2, pixel(9))} fill="transparent" aria-hidden />
                {(isSelected || isDetail) && (
                  <circle
                    r={node.r + 5}
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth={pixel(1.6)}
                    strokeDasharray={`${pixel(4)} ${pixel(3)}`}
                    opacity={0.9}
                  />
                )}
                {isSearch && (
                  <circle
                    r={node.r + 8}
                    fill="none"
                    stroke="var(--success)"
                    strokeWidth={pixel(1.6)}
                    opacity={0.85}
                  />
                )}
                <circle
                  r={node.r}
                  fill={node.color}
                  stroke={isHovered ? "var(--foreground)" : "var(--card)"}
                  strokeWidth={isHovered ? pixel(2.4) : pixel(1.4)}
                />
                <circle r={node.r} fill="url(#node-sheen)" opacity={0.35} />
              </g>
            );
          })}

          {/* 标签（屏幕字号恒定 + 去重叠） */}
          <g aria-hidden className="pointer-events-none">
            {[...labels.entries()].map(([key, label]) => {
              const node = layout.byKey.get(key);
              if (!node) return null;
              const isService = node.ntype === "service";
              const emphasized =
                key === selectedKey || key === detailKey || searchSet.has(key) || isService;
              return (
                <text
                  key={key}
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  fontSize={labelFontGraph}
                  stroke="var(--card)"
                  strokeWidth={pixel(2.5)}
                  paintOrder="stroke"
                  className={cn(
                    "select-none",
                    emphasized ? "fill-foreground font-semibold" : "fill-muted-foreground font-medium",
                  )}
                >
                  {labelText(label.text)}
                </text>
              );
            })}
          </g>
        </g>
      </svg>

      {/* 右上：可见计数 + 视图控制 */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-1.5">
        <div className="rounded-md border border-border/60 bg-card/85 px-2 py-1 text-[10px] tabular-nums text-muted-foreground backdrop-blur">
          节点 <span className="font-semibold text-foreground">{visibleNodes.length}</span> · 边{" "}
          <span className="font-semibold text-foreground">{visibleEdges.length}</span>
        </div>
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="bg-card/90"
            title="放大（+）"
            aria-label="放大"
            onClick={() => zoomAt(1.25)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="bg-card/90"
            title="缩小（−）"
            aria-label="缩小"
            onClick={() => zoomAt(0.8)}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="bg-card/90"
            title="适配画布（F）"
            aria-label="适配画布"
            onClick={() => fitView()}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="bg-card/90"
            title="重置视图（0）"
            aria-label="重置视图"
            onClick={resetView}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="bg-card/90"
            title="聚焦选中节点"
            aria-label="聚焦选中节点"
            disabled={!selectedKey}
            onClick={() => {
              if (!selectedKey) return;
              fitView([selectedKey, ...(adjacency.get(selectedKey) ?? [])]);
            }}
          >
            <LocateFixed className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 悬停 tooltip：类型 / 标签 / 权重 */}
      {hoveredNode && hover && (
        <div
          className="pointer-events-none absolute z-20 w-[236px] rounded-lg border border-border bg-popover/95 p-2 text-[11px] shadow-md backdrop-blur"
          style={{ left: hover.left, top: hover.top }}
          role="tooltip"
        >
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: hoveredNode.color }} />
            <span className="font-medium text-foreground">{labelForType(hoveredNode.ntype)}</span>
            <span className="ml-auto truncate tabular-nums text-muted-foreground">
              #{String(hoveredNode.id).split(":").slice(1).join(":") || hoveredNode.id}
            </span>
          </div>
          <p className="mt-1 break-words font-semibold leading-snug text-foreground">
            {truncate(hoveredNode.label || `节点 ${String(hoveredNode.id)}`, 44)}
          </p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>度数 {hoveredNode.deg}</span>
            <span>权重 {hoveredNode.weightValue}</span>
            {hoveredNode.rawType !== hoveredNode.ntype && <span>{hoveredNode.rawType}</span>}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] tabular-nums text-muted-foreground/80">
        {Math.round(view.k * 100)}%
      </div>
    </div>
  );
}
