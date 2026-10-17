import { type ReactNode, useState, useCallback, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { LiumaiBrand } from "@/components/liumai-brand";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Menu,
  Bell,
  HelpCircle,
  LogOut,
  Moon,
  Search,
  Sun,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/* ==========================================================================
 *  DashboardShell — Main Application Layout
 *
 *  Full-viewport grid layout with:
 *    - Fixed top header bar (56-64px) with ⌘K trigger + theme toggle
 *    - Collapsible grouped left sidebar (240px / 56px)
 *    - Scrollable main content area
 *    - Optional right detail drawer (via Sheet)
 *
 *  The sidebar receives pre-grouped, pre-filtered navigation from
 *  `nav-config.ts`; this component only renders it.
 * ========================================================================== */

export interface SidebarNavItem {
  id: string;
  label: string;
  href: string;
  icon: ReactNode;
  isActive: boolean;
  badge?: string | number;
}

export interface SidebarGroup {
  id: string;
  label: string;
  items: SidebarNavItem[];
  /** Whether the group header folds its items (default: true). */
  collapsible?: boolean;
}

export interface UserInfo {
  username: string;
  role: string;
  onLogout: () => void;
}

export interface DashboardShellProps {
  /** Main content rendered in the center area */
  children: ReactNode;
  /** Navigation groups for the sidebar */
  navGroups: SidebarGroup[];
  /** Current user info for the sidebar footer */
  userInfo?: UserInfo;
  /** Content for the right detail drawer (uses Sheet) */
  drawerContent?: ReactNode;
  /** Whether the right detail drawer is open */
  drawerOpen?: boolean;
  /** Called when the right detail drawer should close */
  onDrawerClose?: () => void;
  /** Optional title for the detail drawer */
  drawerTitle?: string;
  /** Called when the user clicks the logo/header to go home */
  onHomeClick?: () => void;
  /** Opens the ⌘K command palette */
  onOpenCommandPalette?: () => void;
  /** Number of active incidents to show in header (0 = hide) */
  activeIncidentCount?: number;
}

const STORAGE_SIDEBAR = "liumai_sidebar_collapsed";
const STORAGE_GROUPS = "liumai_nav_collapsed_groups";

function readStoredBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function readStoredStringArray(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function SidebarLink({ item, collapsed }: { item: SidebarNavItem; collapsed: boolean }) {
  const link = (
    <Link
      to={item.href}
      aria-current={item.isActive ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
        collapsed && "justify-center px-0",
        item.isActive
          ? "bg-interactive-primary/10 text-interactive-primary"
          : "text-text-secondary hover:bg-surface-tertiary/60 hover:text-text-primary",
      )}
    >
      {item.isActive && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-interactive-primary"
        />
      )}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        {item.icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.badge !== undefined && (
            <span className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[11px] font-medium text-muted-foreground">
              {item.badge}
            </span>
          )}
        </>
      )}
    </Link>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">
        <p>{item.label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function DashboardShell({
  children,
  navGroups,
  userInfo,
  drawerContent,
  drawerOpen = false,
  onDrawerClose,
  drawerTitle,
  onHomeClick,
  onOpenCommandPalette,
  activeIncidentCount = 0,
}: DashboardShellProps) {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStoredBool(STORAGE_SIDEBAR));
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => readStoredStringArray(STORAGE_GROUPS));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_SIDEBAR, sidebarCollapsed ? "1" : "0");
    } catch {
      /* storage unavailable — ignore */
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_GROUPS, JSON.stringify(collapsedGroups));
    } catch {
      /* storage unavailable — ignore */
    }
  }, [collapsedGroups]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [userMenuOpen]);

  const roleLabel: Record<string, string> = { ADMIN: "管理员", OPERATOR: "运维", VIEWER: "只读" };

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) =>
      prev.includes(groupId) ? prev.filter((id) => id !== groupId) : [...prev, groupId],
    );
  }, []);

  return (
    <div className="grid h-dvh grid-cols-[auto_1fr] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground">
      {/* ================================================================ */}
      {/* Header                                                          */}
      {/* ================================================================ */}
      <header
        role="banner"
        className="col-span-2 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface-primary px-3 md:h-16 md:px-4"
      >
        {/* Mobile menu toggle */}
        <button
          type="button"
          className="-ml-1.5 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Logo area */}
        <button type="button" onClick={onHomeClick} aria-label="返回概览">
          <LiumaiBrand size={28} />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* ⌘K command palette trigger (desktop) */}
        {onOpenCommandPalette && (
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="hidden h-8 min-w-[190px] items-center gap-2 rounded-lg border border-border bg-surface-secondary/60 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-text-primary md:flex"
            aria-label="打开命令面板（Ctrl 或 Cmd + K）"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="flex-1 text-left">搜索页面与操作</span>
            <kbd className="rounded border border-border bg-surface-primary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ⌘K
            </kbd>
          </button>
        )}

        {/* ⌘K command palette trigger (mobile) */}
        {onOpenCommandPalette && (
          <Button
            variant="ghostMuted"
            size="icon-sm"
            className="md:hidden"
            onClick={onOpenCommandPalette}
            aria-label="打开命令面板"
          >
            <Search className="h-4 w-4" />
          </Button>
        )}

        {/* Theme toggle */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghostMuted"
                size="icon-sm"
                aria-label={isDark ? "切换到浅色主题" : "切换到深色主题"}
                onClick={() => setTheme(isDark ? "light" : "dark")}
              />
            }
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </TooltipTrigger>
          <TooltipContent>
            <p>{isDark ? "浅色主题" : "深色主题"}</p>
          </TooltipContent>
        </Tooltip>

        {/* Help Center */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghostMuted"
                size="icon-sm"
                onClick={() => navigate("/help")}
                aria-label="帮助中心"
              />
            }
          >
            <HelpCircle className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>
            <p>帮助中心</p>
          </TooltipContent>
        </Tooltip>

        {/* Active incident indicator */}
        {activeIncidentCount > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghostMuted"
                  size="icon-sm"
                  className="relative"
                  aria-label={`${activeIncidentCount} 个活跃事件`}
                />
              }
            >
              <Bell className="h-4 w-4" />
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-status-active px-1 text-[10px] font-bold text-text-on-solid">
                {activeIncidentCount > 9 ? "9+" : activeIncidentCount}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{activeIncidentCount} 个活跃事件</p>
            </TooltipContent>
          </Tooltip>
        )}
      </header>

      {/* ================================================================ */}
      {/* Left Sidebar                                                    */}
      {/* ================================================================ */}
      <nav
        role="navigation"
        aria-label="主导航"
        className={cn(
          "flex flex-col overflow-y-auto border-r border-border bg-surface-secondary transition-all duration-200 ease-in-out",
          sidebarCollapsed ? "w-14" : "w-60",
        )}
      >
        {/* Sidebar collapse toggle (desktop) */}
        <button
          type="button"
          onClick={toggleSidebar}
          className={cn(
            "hidden items-center p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex",
            sidebarCollapsed ? "justify-center" : "justify-end pr-3",
          )}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>

        {/* Navigation groups */}
        <div className="flex-1 px-2 py-2">
          {navGroups.map((group, groupIndex) => {
            const groupCollapsed =
              !sidebarCollapsed && collapsedGroups.includes(group.id) && group.collapsible !== false;

            return (
              <div
                key={group.id}
                className={cn(
                  groupIndex > 0 && "mt-1",
                  groupIndex > 0 && sidebarCollapsed && "mt-2 border-t border-border/70 pt-2",
                )}
              >
                {!sidebarCollapsed && (
                  <>
                    {group.collapsible === false ? (
                      <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground">
                        {group.label}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        aria-expanded={!groupCollapsed}
                        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground transition-colors hover:text-text-primary"
                      >
                        <span className="flex-1 text-left">{group.label}</span>
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 transition-transform duration-100",
                            groupCollapsed && "-rotate-90",
                          )}
                          aria-hidden="true"
                        />
                      </button>
                    )}
                  </>
                )}

                {!groupCollapsed && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {group.items.map((item) => (
                      <SidebarLink key={item.id} item={item} collapsed={sidebarCollapsed} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sidebar footer — user profile */}
        {userInfo && (
          <div className="relative mt-auto border-t border-border" ref={menuRef}>
            {sidebarCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="flex w-full items-center justify-center py-3 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={userInfo.username}
                    />
                  }
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-interactive-primary text-[11px] font-bold text-text-on-solid">
                    {userInfo.username.charAt(0).toUpperCase()}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{userInfo.username}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-muted"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-interactive-primary text-xs font-bold text-text-on-solid">
                  {userInfo.username.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-text-primary">{userInfo.username}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {roleLabel[userInfo.role] ?? userInfo.role}
                  </p>
                </div>
              </button>
            )}

            {/* Dropdown popover */}
            {userMenuOpen && (
              <div
                className={cn(
                  "absolute z-50 min-w-[180px] rounded-xl border border-border bg-popover py-1.5 text-popover-foreground shadow-lg",
                  sidebarCollapsed ? "bottom-0 left-full mb-1 ml-2" : "right-3 bottom-full left-3 mb-1",
                )}
              >
                <div className="border-b border-border/50 px-3 py-2">
                  <p className="text-[13px] font-medium text-text-primary">{userInfo.username}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {roleLabel[userInfo.role] ?? userInfo.role}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigate("/profile");
                    setUserMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
                >
                  <User className="h-3.5 w-3.5" />
                  个人中心
                </button>
                <button
                  type="button"
                  onClick={() => {
                    userInfo.onLogout();
                    setUserMenuOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  退出登录
                </button>
              </div>
            )}
          </div>
        )}
      </nav>

      {/* ================================================================ */}
      {/* Main Content                                                    */}
      {/* ================================================================ */}
      <main role="main" className="overflow-auto bg-surface-primary">
        {/* aria-live region for dynamic content updates */}
        <div aria-live="polite" role="status" className="sr-only" id="main-status-announcements" />
        {children}
      </main>

      {/* ================================================================ */}
      {/* Right Detail Drawer                                             */}
      {/* ================================================================ */}
      {drawerContent && (
        <Sheet
          open={drawerOpen}
          onOpenChange={(open) => {
            if (!open) onDrawerClose?.();
          }}
        >
          <SheetContent side="right" className="flex w-[400px] flex-col p-0 sm:max-w-[400px]">
            {drawerTitle && (
              <div className="shrink-0 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">{drawerTitle}</h2>
              </div>
            )}
            <div className="flex-1 overflow-auto p-4">{drawerContent}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
