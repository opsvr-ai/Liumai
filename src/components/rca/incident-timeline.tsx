import { type ReactNode, useRef, useEffect } from "react";
import {
  Bell,
  Search,
  FileText,
  MessageSquare,
  UserPlus,
  CheckCircle2,
  CheckCircle,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";

/* ==========================================================================
 *  IncidentTimeline — Horizontal Incident Timeline
 *
 *  A horizontal timeline with severity-coded lanes showing the incident
 *  lifecycle: alert received -> RCA started -> evidence found ->
 *  WeCom group created -> manual findings -> RCA completed -> resolved.
 *
 *  Usage:
 *    <IncidentTimeline events={events} />
 * ========================================================================== */

/* ---- Event Type Definitions ---- */

export type IncidentEventType =
  | "alert_received"
  | "rca_started"
  | "evidence_found"
  | "wecom_group_created"
  | "manual_finding"
  | "rca_completed"
  | "incident_resolved";

export type EventSeverity = "critical" | "warning" | "info" | "resolved";

export interface TimelineEvent {
  /** Unique event identifier */
  id: string;
  /** Event type (determines icon) */
  type: IncidentEventType;
  /** Severity for lane color coding */
  severity: EventSeverity;
  /** ISO-8601 timestamp string (displayed as-is or formatted) */
  timestamp: string;
  /** Short event title */
  title: string;
  /** Optional detailed description */
  description?: string;
  /** Optional reference to the related agent investigation step */
  agentStep?: string;
  /** Optional custom icon override */
  icon?: ReactNode;
}

/* ---- Event Type Config ---- */

interface EventTypeConfig {
  icon: ReactNode;
  defaultTitle: string;
  defaultSeverity: EventSeverity;
}

const EVENT_TYPE_CONFIG: Record<IncidentEventType, EventTypeConfig> = {
  alert_received: {
    icon: <Bell className="h-3.5 w-3.5" />,
    defaultTitle: "告警接收",
    defaultSeverity: "critical",
  },
  rca_started: {
    icon: <Search className="h-3.5 w-3.5" />,
    defaultTitle: "RCA 开始",
    defaultSeverity: "warning",
  },
  evidence_found: {
    icon: <FileText className="h-3.5 w-3.5" />,
    defaultTitle: "发现证据",
    defaultSeverity: "info",
  },
  wecom_group_created: {
    icon: <MessageSquare className="h-3.5 w-3.5" />,
    defaultTitle: "WeCom 群组已创建",
    defaultSeverity: "info",
  },
  manual_finding: {
    icon: <UserPlus className="h-3.5 w-3.5" />,
    defaultTitle: "人工提交发现",
    defaultSeverity: "info",
  },
  rca_completed: {
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    defaultTitle: "RCA 完成",
    defaultSeverity: "resolved",
  },
  incident_resolved: {
    icon: <CheckCircle className="h-3.5 w-3.5" />,
    defaultTitle: "事件已解决",
    defaultSeverity: "resolved",
  },
};

/* ---- Severity Color Map ---- */

function getSeverityColors(severity: EventSeverity) {
  switch (severity) {
    case "critical":
      return {
        bar: "bg-status-active",
        dot: "bg-status-active/10 text-status-active",
        text: "text-status-active",
      };
    case "warning":
      return {
        bar: "bg-status-investigating",
        dot: "bg-status-investigating/10 text-status-investigating",
        text: "text-status-investigating",
      };
    case "info":
      return {
        bar: "bg-status-info",
        dot: "bg-status-info/10 text-status-info",
        text: "text-status-info",
      };
    case "resolved":
      return {
        bar: "bg-status-resolved",
        dot: "bg-status-resolved/10 text-status-resolved",
        text: "text-status-resolved",
      };
  }
}

/* ---- IncidentTimeline Component ---- */

export interface IncidentTimelineProps {
  /** Array of timeline events */
  events: TimelineEvent[];
  /** Optional custom class name */
  className?: string;
  /** If true, auto-scroll to the latest event on mount */
  autoScroll?: boolean;
  /** Show loading skeleton state */
  isLoading?: boolean;
}

export function IncidentTimeline({
  events,
  className,
  autoScroll = true,
  isLoading = false,
}: IncidentTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef<HTMLLIElement>(null);

  // Auto-scroll to latest event
  useEffect(() => {
    if (autoScroll && latestRef.current && scrollRef.current) {
      latestRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
    }
  }, [events.length, autoScroll]);

  // Loading state: skeleton placeholders
  if (isLoading) {
    return (
      <div
        className={cn("flex items-center gap-3 p-4 overflow-x-auto", className)}
        aria-busy="true"
        role="region"
        aria-label="加载事件时间线"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col min-w-[160px] max-w-[200px]">
            <Skeleton className="h-1 w-full rounded-t-sm" />
            <div className="flex items-start gap-3 p-3 w-full">
              <Skeleton className="h-6 w-6 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-32 text-muted-foreground", className)}>
        <div className="text-center">
          <Clock className="h-6 w-6 mx-auto mb-1" />
          <p className="text-xs">暂无时间线事件</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={cn("overflow-x-auto", className)}
      role="region"
      aria-label="事件时间线"
    >
      <ol className="flex gap-0 min-w-max" role="list">
        {events.map((event, index) => {
          const config = EVENT_TYPE_CONFIG[event.type];
          const colors = getSeverityColors(event.severity);
          const isLatest = index === events.length - 1;

          return (
            <li
              key={event.id}
              ref={isLatest ? latestRef : undefined}
              className="flex flex-col relative min-w-[160px] max-w-[200px]"
            >
              {/* Severity lane color bar */}
              <div className={cn("h-1 w-full rounded-t-sm shrink-0", colors.bar)} />

              {/* Event content */}
              <div className="flex items-start gap-3 p-3 w-full">
                {/* Event icon */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        "mt-0.5 h-6 w-6 rounded-full flex items-center justify-center shrink-0",
                        colors.dot
                      )}
                    >
                      {event.icon ?? config.icon}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p>{config.defaultTitle}</p>
                  </TooltipContent>
                </Tooltip>

                {/* Event details */}
                <div className="flex-1 min-w-0">
                  {/* Timestamp */}
                  <time
                    className="text-xs font-mono tabular-nums text-muted-foreground block leading-tight"
                    dateTime={event.timestamp}
                  >
                    {event.timestamp}
                  </time>

                  {/* Title */}
                  <p className="text-sm text-foreground mt-1 font-medium leading-snug">
                    {event.title || config.defaultTitle}
                  </p>

                  {/* Description */}
                  {event.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
                      {event.description}
                    </p>
                  )}

                  {/* Agent step reference */}
                  {event.agentStep && (
                    <p className="text-[11px] text-muted-foreground mt-1 italic">
                      {event.agentStep}
                    </p>
                  )}
                </div>
              </div>

              {/* Connector line to next event */}
              {index < events.length - 1 && (
                <div className="absolute top-4 -right-2 w-4 h-px bg-border" />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---- Empty State ---- */

export function EmptyTimelineState() {
  return (
    <div className="flex items-center justify-center h-32 text-muted-foreground">
      <div className="text-center">
        <Clock className="h-6 w-6 mx-auto mb-1" />
        <p className="text-xs">暂无时间线事件</p>
      </div>
    </div>
  );
}
