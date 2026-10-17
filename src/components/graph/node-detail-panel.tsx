import { ArrowUpRight, Crosshair, Waypoints, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { colorForType, labelForType, type PositionedNode } from "./layout";

/* ==========================================================================
 *  节点详情侧栏（双击节点打开）
 *  - 类型 / id / 权重 / meta
 *  - 一跳邻居列表（来自 /api/graph/neighbors + 本地边），可在图中聚焦
 *  - 关联跳转：服务 → RCA、告警 → 告警中心、根因/动作 → 知识库
 * ========================================================================== */

export interface NeighborRow {
  key: string;
  label: string;
  type: string;
  color: string;
  edgeLabels: string[];
  inView: boolean;
}

interface NodeDetailPanelProps {
  open: boolean;
  node: PositionedNode | null;
  ntype: string;
  rows: NeighborRow[];
  metaEntries: Array<readonly [string, string]>;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSelectNeighbor: (key: string) => void;
  onFocus: () => void;
}

interface JumpLink {
  href: string;
  label: string;
  hint: string;
}

function jumpLinksFor(ntype: string, label: string, id: string): JumpLink[] {
  const encoded = encodeURIComponent(label);
  if (ntype === "service") {
    return [
      {
        href: `/rca?service=${encoded}`,
        label: "查看该服务的 RCA",
        hint: label,
      },
    ];
  }
  if (ntype === "alert") {
    return [
      {
        href: "/alerts",
        label: "在告警中心查看",
        hint: `告警 #${id}`,
      },
    ];
  }
  if (ntype === "cause") {
    return [
      {
        href: `/knowledge?search=${encoded}`,
        label: "在知识库中检索该根因",
        hint: "根因排查经验",
      },
    ];
  }
  if (ntype === "action") {
    return [
      {
        href: `/knowledge?search=${encoded}`,
        label: "在知识库中检索处置动作",
        hint: "处置方案",
      },
    ];
  }
  return [];
}

export function NodeDetailPanel({
  open,
  node,
  ntype,
  rows,
  metaEntries,
  loading,
  error,
  onClose,
  onSelectNeighbor,
  onFocus,
}: NodeDetailPanelProps) {
  const color = colorForType(ntype);
  const rawId = node ? String(node.id) : "";
  const idText = rawId.includes(":") ? rawId.slice(rawId.indexOf(":") + 1) : rawId;
  const jumps = node ? jumpLinksFor(ntype, String(node.label ?? ""), idText) : [];

  return (
    <Card data-node-detail className="h-fit lg:sticky lg:top-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Waypoints className="h-4 w-4 text-interactive-primary" />
          节点详情
          {open && node && (
            <span className="ml-auto flex items-center gap-1">
              <Button
                variant="ghostMuted"
                size="icon-xs"
                title="在图中聚焦"
                aria-label="在图中聚焦"
                onClick={onFocus}
              >
                <Crosshair className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghostMuted"
                size="icon-xs"
                title="关闭详情"
                aria-label="关闭详情"
                onClick={onClose}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!open || !node ? (
          <div className="space-y-2 py-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              双击图中任意节点打开详情：查看一跳邻居、跳转 RCA / 告警中心 / 知识库。
            </p>
            <ul className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
              <li>· 单击节点：聚焦并高亮一跳邻居</li>
              <li>· 拖动节点：局部斥力重新排布</li>
              <li>· 滚轮 / +−：以鼠标为中心缩放</li>
              <li>· 图例点击：隐藏 / 显示该类型</li>
            </ul>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                {labelForType(ntype)}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">#{idText}</span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                度数 {node.deg} · 权重 {node.weightValue}
              </span>
            </div>

            <p className="break-words text-sm font-semibold leading-snug text-text-primary">
              {node.label || `节点 ${idText}`}
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

            {jumps.length > 0 && (
              <div className="space-y-1">
                {jumps.map((jump) => (
                  <Link
                    key={jump.href}
                    to={jump.href}
                    className="flex items-center gap-2 rounded-md border border-border/70 bg-card px-2 py-1.5 text-[11px] text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-interactive-primary" />
                    <span className="min-w-0 flex-1 truncate">{jump.label}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{jump.hint}</span>
                  </Link>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between border-t border-border/60 pt-2">
              <p className="text-xs font-medium">一跳邻居</p>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {rows.length}
                {loading ? " · 加载中…" : ""}
              </span>
            </div>

            {rows.length === 0 ? (
              <p className="py-3 text-center text-[11px] text-muted-foreground">
                {loading ? "正在加载邻居…" : "该节点暂无关联邻居"}
              </p>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-y-auto pr-0.5">
                {rows.map((row) => (
                  <li key={row.key}>
                    <button
                      type="button"
                      disabled={!row.inView}
                      title={row.inView ? "在图中聚焦该节点" : "该节点不在当前视图中"}
                      onClick={() => row.inView && onSelectNeighbor(row.key)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        row.inView ? "hover:bg-muted" : "cursor-default opacity-55",
                      )}
                    >
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-text-secondary">{row.label}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {row.edgeLabels.join(" · ") || labelForType(row.type)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error && (
              <p className="text-[11px] leading-relaxed text-status-investigating">
                邻居接口不可用，已展示图中直连节点。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
