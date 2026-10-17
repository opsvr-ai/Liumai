import type { ComponentType } from "react";
import {
  Activity,
  BellRing,
  BookOpen,
  ClipboardList,
  Clock,
  Database,
  HelpCircle,
  History,
  Home,
  Inbox,
  Layers,
  MessageCircle,
  Network,
  Settings,
  Shield,
  User,
  Users,
  Wrench,
} from "lucide-react";

/* ==========================================================================
 *  Navigation configuration — single source of truth
 *
 *  The sidebar is intentionally limited to 5 groups so the shell stays
 *  minimal and scalable:
 *
 *    工作台  workspace   daily operations surface
 *    对话    assistant   conversational entry point
 *    知识    knowledge   long-lived knowledge surface
 *    自动化  automation  capabilities that run on their own
 *    系统    system      configuration & administration
 *
 *  `permission` is a reserved gate. Today only "admin" is enforced by the
 *  route table; "operator" already works and future roles (e.g. "viewer")
 *  can be added here without touching the sidebar component.
 * ========================================================================== */

export type NavPermission = "authenticated" | "operator" | "admin";

export type NavIcon = ComponentType<{ className?: string }>;

export interface NavItem {
  id: string;
  label: string;
  /** Stable route path — never derived from the label. */
  path: string;
  icon: NavIcon;
  /** Reserved permission bit; omitted means "authenticated". */
  permission?: NavPermission;
  /** Extra terms used by the ⌘K palette search. */
  keywords?: string[];
  /** Short description shown in the command palette. */
  description?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  /** Groups can be folded in the expanded sidebar (default: true). */
  collapsible?: boolean;
}

/** Pages that are reachable but intentionally not part of the sidebar. */
export interface SecondaryPage extends NavItem {
  groupLabel: string;
}

export const SECONDARY_PAGES: SecondaryPage[] = [
  {
    id: "profile",
    label: "个人中心",
    path: "/profile",
    icon: User,
    groupLabel: "账户",
    keywords: ["profile", "account", "me"],
    description: "账号与偏好设置",
  },
  {
    id: "help",
    label: "帮助中心",
    path: "/help",
    icon: HelpCircle,
    groupLabel: "账户",
    keywords: ["help", "docs", "support", "faq"],
    description: "使用说明与常见问题",
  },
];

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "workspace",
    label: "工作台",
    items: [
      {
        id: "home",
        label: "概览",
        path: "/",
        icon: Home,
        keywords: ["home", "overview", "dashboard", "gailan"],
        description: "平台运行概览",
      },
      {
        id: "incidents",
        label: "事件中心",
        path: "/incidents",
        icon: Inbox,
        keywords: ["incident", "incidents", "events", "shijian", "inbox"],
        description: "告警 · 进行中 · 报告统一视图",
      },
      {
        id: "alerts",
        label: "告警中心",
        path: "/alerts",
        icon: BellRing,
        keywords: ["alert", "alerts", "gaojing"],
        description: "活跃告警与处置",
      },
      {
        id: "rca",
        label: "RCA 分析",
        path: "/rca",
        icon: Activity,
        keywords: ["rca", "root cause", "analysis", "fenxi"],
        description: "根因分析会话与报告",
      },
      {
        id: "history",
        label: "历史记录",
        path: "/history",
        icon: History,
        keywords: ["history", "archive", "lishi"],
        description: "RCA 会话归档",
      },
    ],
  },
  {
    id: "assistant",
    label: "对话",
    items: [
      {
        id: "chat",
        label: "智能对话",
        path: "/chat",
        icon: MessageCircle,
        keywords: ["chat", "assistant", "ai", "duihua"],
        description: "AI 运维助手",
      },
    ],
  },
  {
    id: "knowledge",
    label: "知识",
    items: [
      {
        id: "knowledge",
        label: "知识中心",
        path: "/knowledge",
        icon: BookOpen,
        keywords: ["knowledge", "kb", "wiki", "zhishi"],
        description: "故障知识库",
      },
      {
        id: "graph",
        label: "知识图谱",
        path: "/graph",
        icon: Network,
        keywords: ["graph", "knowledge graph", "topology", "tupu", "图谱"],
        description: "服务 · 告警 · 根因关联网络",
      },
    ],
  },
  {
    id: "automation",
    label: "自动化",
    items: [
      {
        id: "skills",
        label: "技能中心",
        path: "/skills",
        icon: Wrench,
        keywords: ["skills", "agents", "jineng"],
        description: "Agent 能力目录",
      },
      {
        id: "patrol",
        label: "巡检建议",
        path: "/patrol",
        icon: ClipboardList,
        keywords: ["patrol", "inspection", "suggestions", "xunjian", "巡检"],
        description: "主动巡检与处置建议",
      },
      {
        id: "jobs",
        label: "定时任务",
        path: "/jobs",
        icon: Clock,
        permission: "admin",
        keywords: ["jobs", "scheduler", "cron", "dingshi"],
        description: "计划任务调度",
      },
    ],
  },
  {
    id: "system",
    label: "系统",
    items: [
      {
        id: "rules",
        label: "告警规则",
        path: "/rules",
        icon: Shield,
        keywords: ["rules", "alerting", "guize"],
        description: "规则配置与匹配",
      },
      {
        id: "systems",
        label: "应用系统",
        path: "/systems",
        icon: Layers,
        keywords: ["systems", "apps", "yingyong"],
        description: "业务系统登记",
      },
      {
        id: "datasources",
        label: "数据源",
        path: "/datasources",
        icon: Database,
        keywords: ["datasource", "prometheus", "zabbix", "shujuyuan"],
        description: "监控数据连接",
      },
      {
        id: "users",
        label: "用户管理",
        path: "/users",
        icon: Users,
        permission: "admin",
        keywords: ["users", "accounts", "yonghu"],
        description: "账号与权限",
      },
      {
        id: "settings",
        label: "系统设置",
        path: "/settings",
        icon: Settings,
        permission: "admin",
        keywords: ["settings", "config", "shezhi"],
        description: "平台参数配置",
      },
    ],
  },
];

/**
 * Reserved permission gate. Keep this pure so the sidebar, the route table
 * and the ⌘K palette all make the same decision.
 */
export function canAccess(permission: NavPermission | undefined, role: string | null): boolean {
  if (!permission || permission === "authenticated") return true;
  if (!role) return false;
  const normalized = role.toUpperCase();
  if (permission === "admin") return normalized === "ADMIN";
  // "operator" and future privileged-but-not-admin roles
  return normalized === "ADMIN" || normalized === "OPERATOR";
}

/** Nav groups visible for the current role (empty groups are dropped). */
export function buildNavGroups(role: string | null): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccess(item.permission, role)),
  })).filter((group) => group.items.length > 0);
}

/** Flattened page list for the ⌘K palette (sidebar pages + secondary pages). */
export function buildCommandPages(
  role: string | null,
): Array<NavItem & { groupLabel: string }> {
  const pages: Array<NavItem & { groupLabel: string }> = [];
  for (const group of buildNavGroups(role)) {
    for (const item of group.items) {
      pages.push({ ...item, groupLabel: group.label });
    }
  }
  for (const page of SECONDARY_PAGES) {
    if (canAccess(page.permission, role)) {
      const { groupLabel, ...item } = page;
      pages.push({ ...item, groupLabel });
    }
  }
  return pages;
}

/** Path-based active matching used by the sidebar and the palette. */
export function isNavItemActive(item: Pick<NavItem, "path">, pathname: string): boolean {
  if (item.path === "/") return pathname === "/";
  return pathname === item.path || pathname.startsWith(`${item.path}/`);
}
