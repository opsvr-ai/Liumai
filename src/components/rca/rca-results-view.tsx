import { type ReactNode, useState, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { VariantProps } from "class-variance-authority";
import { badgeVariants } from "@/components/ui/badge";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/* ==========================================================================
 *  RcaResultsView — Three-Panel RCA Results View
 *
 *  Layout with three resizable panels:
 *    - Left (40%):   Causal graph visualization
 *    - Center (35%): AI summary + evidence timeline
 *    - Right (25%):  Evidence detail (metrics, logs, traces)
 *
 *  Each panel is collapsible with a sticky header.
 *
 *  Usage:
 *    <RcaResultsView
 *      leftPanel={<CausalGraph />}
 *      centerPanel={<AiSummary />}
 *      rightPanel={<EvidenceDetail />}
 *    />
 * ========================================================================== */

/* ---- Panel Configuration ---- */

export type PanelPosition = "left" | "center" | "right";

interface PanelConfig {
  key: PanelPosition;
  title: string;
  defaultWidth: string; // e.g. "40%", "35%", "25%"
  minWidth: string;
}

const DEFAULT_PANELS: PanelConfig[] = [
  { key: "left",   title: "因果图谱", defaultWidth: "40%", minWidth: "20%" },
  { key: "center", title: "AI 分析摘要", defaultWidth: "35%", minWidth: "20%" },
  { key: "right",  title: "证据详情", defaultWidth: "25%", minWidth: "0%" },
];

/* ---- Confidence Indicator Component ---- */

export interface ConfidenceIndicatorProps {
  /** Confidence score 0-100 */
  score: number;
  className?: string;
}

function getConfidenceLabel(score: number): { label: string; variant: BadgeVariant } {
  if (score >= 80) return { label: "高置信度", variant: "resolved" as BadgeVariant };
  if (score >= 50) return { label: "中等置信度", variant: "investigating" as BadgeVariant };
  return { label: "低置信度", variant: "active" as BadgeVariant };
}

export function ConfidenceIndicator({ score, className }: ConfidenceIndicatorProps) {
  const { label, variant } = getConfidenceLabel(score);
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Badge variant={variant} className="text-xs">
        {label}
      </Badge>
      <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-normal",
            score >= 80 && "bg-status-resolved",
            score >= 50 && score < 80 && "bg-status-investigating",
            score < 50 && "bg-status-active"
          )}
          style={{ width: `${score}%` }}
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`置信度 ${score}%`}
        />
      </div>
      <span className="text-xs font-mono tabular-nums text-muted-foreground">{score}%</span>
    </div>
  );
}

/* ---- Panel Content Component ---- */

export interface PanelContentProps {
  config: PanelConfig;
  isOpen: boolean;
  headerContent?: ReactNode;
  children: ReactNode;
  onToggle: () => void;
}

function PanelContent({ config, isOpen, headerContent, children, onToggle }: PanelContentProps) {
  return (
    <section
      aria-labelledby={`panel-${config.key}-heading`}
      className={cn(
        "flex flex-col overflow-hidden",
        config.key === "left" && "border-r border-border",
        config.key === "right" && "border-l border-border"
      )}
      style={isOpen ? undefined : { minWidth: 0, overflow: "hidden" }}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-surface-secondary px-3 py-2 flex items-center justify-between shrink-0">
        <h2
          id={`panel-${config.key}-heading`}
          className="text-xs font-semibold text-foreground uppercase tracking-wider"
        >
          {config.title}
        </h2>
        <div className="flex items-center gap-1">
          {headerContent}
          <button
            type="button"
            onClick={onToggle}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={isOpen ? `收起 ${config.title}` : `展开 ${config.title}`}
          >
            {isOpen ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Panel body */}
      {isOpen && (
        <ScrollArea className="flex-1">
          <div className="p-3">
            {children}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

/* ---- Main RcaResultsView Component ---- */

export interface RcaResultsViewProps {
  /** Content for the left (causal graph) panel */
  leftPanel?: ReactNode;
  /** Content for the center (AI summary) panel */
  centerPanel?: ReactNode;
  /** Content for the right (evidence detail) panel */
  rightPanel?: ReactNode;
  /** Optional confidence score 0-100 for the center panel header */
  confidenceScore?: number;
  /** Custom class name */
  className?: string;
  /** Show loading skeleton state */
  isLoading?: boolean;
  /** Show error state */
  isError?: boolean;
  /** Error message to display in error state */
  errorMessage?: string;
}

export function RcaResultsView({
  leftPanel,
  centerPanel,
  rightPanel,
  confidenceScore,
  className,
  isLoading = false,
  isError = false,
  errorMessage,
}: RcaResultsViewProps) {
  const [panelState, setPanelState] = useState<Record<PanelPosition, boolean>>({
    left: true,
    center: true,
    right: true,
  });

  const togglePanel = useCallback((panel: PanelPosition) => {
    setPanelState((prev) => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  // Calculate grid template columns dynamically
  const buildGridTemplate = () => {
    const columns: string[] = [];
    for (const config of DEFAULT_PANELS) {
      if (panelState[config.key]) {
        columns.push(config.defaultWidth);
      } else {
        columns.push("auto"); // collapsed — minimal width
      }
    }
    return columns.join(" ");
  };

  const centerHeaderContent = confidenceScore !== undefined ? (
    <ConfidenceIndicator score={confidenceScore} />
  ) : undefined;

  // Loading state: render skeleton placeholders
  if (isLoading) {
    return (
      <div
        className={cn("h-full p-4 space-y-4", className)}
        role="region"
        aria-label="RCA analysis results"
        aria-busy="true"
      >
        <div className="flex items-center justify-end gap-1 px-3 py-1.5">
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="grid h-[calc(100%-2.5rem)] grid-cols-[40%_35%_25%] gap-0">
          <div className="space-y-3 p-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
          <div className="space-y-3 p-3 border-x border-border">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
          <div className="space-y-3 p-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      </div>
    );
  }

  // Error state: show actionable error message
  if (isError) {
    return (
      <div
        className={cn("flex items-center justify-center h-full p-6", className)}
        role="alert"
      >
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>加载 RCA 结果失败</AlertTitle>
          <AlertDescription>
            {errorMessage ?? "无法加载 RCA 分析结果，请稍后重试。"}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div
      className={cn("h-full", className)}
      role="region"
      aria-label="RCA analysis results"
    >
      {/* Collapse all / expand all controls */}
      <div className="flex items-center justify-end gap-1 px-3 py-1.5 border-b border-border bg-surface-secondary">
        <button
          type="button"
          onClick={() => {
            const allOpen = Object.values(panelState).every(Boolean);
            setPanelState({ left: !allOpen, center: !allOpen, right: !allOpen });
          }}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {Object.values(panelState).every(Boolean) ? "全部收起" : "全部展开"}
        </button>
      </div>

      {/* Three-panel grid */}
      <div
        className="grid h-[calc(100%-2rem)]"
        style={{ gridTemplateColumns: buildGridTemplate() }}
      >
        {/* Left Panel — Causal Graph */}
        <PanelContent
          config={DEFAULT_PANELS[0]}
          isOpen={panelState.left}
          onToggle={() => togglePanel("left")}
        >
          {leftPanel ?? (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
              <AlertCircle className="h-8 w-8 mb-2" />
              <p className="text-sm">因果图谱区域</p>
              <span className="text-xs mt-1">服务依赖拓扑将在此处渲染</span>
            </div>
          )}
        </PanelContent>

        {/* Center Panel — AI Summary + Timeline */}
        <PanelContent
          config={DEFAULT_PANELS[1]}
          isOpen={panelState.center}
          headerContent={centerHeaderContent}
          onToggle={() => togglePanel("center")}
        >
          {centerPanel ?? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-surface-primary p-4">
                <p className="text-sm leading-relaxed text-foreground">
                  分析完成后，AI 生成的根因分析摘要将显示在此处。
                </p>
              </div>
              <Separator />
              <div>
                <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
                  证据链时间线
                </h3>
                <p className="text-xs text-muted-foreground">
                  代理调查步骤将在此处显示
                </p>
              </div>
            </div>
          )}
        </PanelContent>

        {/* Right Panel — Evidence Detail */}
        <PanelContent
          config={DEFAULT_PANELS[2]}
          isOpen={panelState.right}
          onToggle={() => togglePanel("right")}
        >
          {rightPanel ?? (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
              <Info className="h-8 w-8 mb-2" />
              <p className="text-sm">证据详情</p>
              <span className="text-xs mt-1">关键指标和日志片段将在此处展示</span>
            </div>
          )}
        </PanelContent>
      </div>
    </div>
  );
}
