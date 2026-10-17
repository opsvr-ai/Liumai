import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { NavPermission } from "@/components/layout/nav-config";

/* ==========================================================================
 *  Route table — every page is code-split with React.lazy.
 *
 *  Import order here never pulls page code into the entry chunk: Vite emits
 *  one async chunk per `import()` and only the matched route's chunk is
 *  fetched. The authenticated shell and this table stay in the entry chunk.
 * ========================================================================== */

export interface AppRoute {
  path: string;
  Component: LazyExoticComponent<ComponentType>;
  /** Reserved permission bit, mirrors nav-config. */
  permission?: NavPermission;
}

export const LoginPage = lazy(() => import("@/pages/login"));

export const APP_ROUTES: AppRoute[] = [
  // ── 工作台 ────────────────────────────────────────────────────────────
  { path: "/", Component: lazy(() => import("@/pages/dashboard")) },
  { path: "/incidents", Component: lazy(() => import("@/pages/incidents")) },
  {
    path: "/incidents/:kind/:id",
    Component: lazy(() => import("@/pages/incident-workspace")),
  },
  { path: "/alerts", Component: lazy(() => import("@/pages/alerts")) },
  { path: "/rca", Component: lazy(() => import("@/pages/rca/rca-page")) },
  { path: "/history", Component: lazy(() => import("@/pages/history/history-page")) },
  // ── 对话 ──────────────────────────────────────────────────────────────
  { path: "/chat", Component: lazy(() => import("@/pages/chat/chat-page")) },
  // ── 知识 ──────────────────────────────────────────────────────────────
  { path: "/knowledge", Component: lazy(() => import("@/pages/knowledge")) },
  { path: "/graph", Component: lazy(() => import("@/pages/graph")) },
  // ── 自动化 ────────────────────────────────────────────────────────────
  { path: "/skills", Component: lazy(() => import("@/pages/skills")) },
  { path: "/patrol", Component: lazy(() => import("@/pages/patrol")) },
  { path: "/jobs", Component: lazy(() => import("@/pages/jobs")), permission: "admin" },
  // ── 系统 ──────────────────────────────────────────────────────────────
  { path: "/rules", Component: lazy(() => import("@/pages/rules/rules-page")) },
  { path: "/systems", Component: lazy(() => import("@/pages/systems")) },
  { path: "/datasources", Component: lazy(() => import("@/pages/datasources")) },
  { path: "/users", Component: lazy(() => import("@/pages/users")), permission: "admin" },
  { path: "/settings", Component: lazy(() => import("@/pages/settings")), permission: "admin" },
  // ── 账户（不出现在侧边栏，但路由与 ⌘K 可达）────────────────────────────
  { path: "/profile", Component: lazy(() => import("@/pages/profile")) },
  { path: "/help", Component: lazy(() => import("@/pages/help")) },
];
