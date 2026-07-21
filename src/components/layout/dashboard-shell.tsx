import { type ReactNode, useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { LiumaiBrand } from "@/components/liumai-brand";
import {
  ChevronLeft,
  ChevronRight,
  Menu,
  Bell,
  HelpCircle,
  LogOut,
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
 *    - Fixed top header bar (56-64px)
 *    - Collapsible left sidebar (240px / 56px)
 *    - Scrollable main content area
 *    - Optional right detail drawer (via Sheet)
 *
 *  Usage:
 *    <DashboardShell
 *      headerContent={<HeaderContent />}
 *      sidebarItems={sidebarItems}
 *      drawerContent={<DrawerContent />}
 *      drawerOpen={isDrawerOpen}
 *      onDrawerClose={handleDrawerClose}
 *    >
 *      <MainContent />
 *    </DashboardShell>
 * ========================================================================== */

export interface SidebarItem {
  id: string;
  label: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  isActive?: boolean;
  badge?: string | number;
}

export interface UserInfo {
  username: string;
  role: string;
  onLogout: () => void;
}

export interface DashboardShellProps {
  /** Main content rendered in the center area */
  children: ReactNode;
  /** Navigation items for the sidebar */
  sidebarItems: SidebarItem[];
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
  /** Number of active incidents to show in header (0 = hide) */
  activeIncidentCount?: number;
}

export function DashboardShell({
  children,
  sidebarItems,
  userInfo,
  drawerContent,
  drawerOpen = false,
  onDrawerClose,
  drawerTitle,
  onHomeClick,
  activeIncidentCount = 0,
}: DashboardShellProps) {
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="h-dvh grid grid-cols-[auto_1fr] grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground">
      {/* ================================================================ */}
      {/* Header                                                          */}
      {/* ================================================================ */}
      <header
        role="banner"
        className="col-span-2 h-14 md:h-16 flex items-center gap-2 px-3 md:px-4 border-b border-border bg-surface-primary z-30"
      >
        {/* Mobile menu toggle */}
        <button
          type="button"
          className="md:hidden p-1.5 -ml-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Logo area */}
        <button type="button" onClick={onHomeClick}>
          <LiumaiBrand size={28} />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Help Center */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghostMuted"
              size="icon-sm"
              onClick={() => navigate("/help")}
              aria-label="帮助中心"
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>帮助中心</p></TooltipContent>
        </Tooltip>

        {/* Active incident indicator */}
        {activeIncidentCount > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghostMuted"
                size="icon-sm"
                className="relative"
                aria-label={`${activeIncidentCount} 个活跃事件`}
              >
                <Bell className="h-4 w-4" />
                <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[1rem] px-1 flex items-center justify-center rounded-full bg-status-active text-[10px] font-bold text-white">
                  {activeIncidentCount > 9 ? "9+" : activeIncidentCount}
                </span>
              </Button>
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
        aria-label="Main navigation"
        className={cn(
          "flex flex-col border-r border-border bg-surface-secondary overflow-y-auto transition-all duration-slide ease-in-out",
          sidebarCollapsed ? "w-14" : "w-60"
        )}
      >
        {/* Sidebar collapse toggle (desktop) */}
        <button
          type="button"
          onClick={toggleSidebar}
          className={cn(
            "hidden md:flex items-center justify-end p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
            sidebarCollapsed ? "justify-center" : "pr-3"
          )}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {sidebarCollapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>

        {/* Navigation items */}
        <div className="flex flex-col gap-0.5 px-2 py-2">
          {sidebarItems.map((item) => {
            const button = (
              <button
                key={item.id}
                type="button"
                onClick={item.onClick}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors w-full text-left",
                  item.isActive
                    ? "bg-white text-foreground shadow-sm"
                    : "text-[#6b6b80] hover:text-foreground hover:bg-white/60"
                )}
                aria-current={item.isActive ? "page" : undefined}
              >
                <span className="shrink-0 h-4 w-4 flex items-center justify-center">
                  {item.icon}
                </span>
                {!sidebarCollapsed && (
                  <>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge !== undefined && (
                      <span className="shrink-0 h-5 min-w-[1.25rem] px-1 flex items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </button>
            );

            // Show tooltip when sidebar is collapsed
            if (sidebarCollapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right">
                    <p>{item.label}</p>
                  </TooltipContent>
                </Tooltip>
              );
            }
            return button;
          })}
        </div>

        {/* Sidebar footer — user profile */}
        {userInfo && (
          <div className="mt-auto border-t border-border relative" ref={menuRef}>
            {sidebarCollapsed ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="w-full flex items-center justify-center py-3 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <div className="h-7 w-7 rounded-full bg-interactive-primary text-white flex items-center justify-center text-[11px] font-bold">
                      {userInfo.username.charAt(0).toUpperCase()}
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right"><p>{userInfo.username}</p></TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="w-full flex items-center gap-3 px-3 py-3 hover:bg-white/60 transition-colors text-left"
              >
                <div className="h-8 w-8 rounded-full bg-interactive-primary text-white flex items-center justify-center text-xs font-bold shrink-0">
                  {userInfo.username.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-text-primary truncate">{userInfo.username}</p>
                  <p className="text-[11px] text-muted-foreground">{roleLabel[userInfo.role] ?? userInfo.role}</p>
                </div>
              </button>
            )}

            {/* Dropdown popover */}
            {userMenuOpen && (
              <div className={cn(
                "absolute bg-white rounded-xl shadow-lg border border-border py-1.5 z-50 min-w-[180px]",
                sidebarCollapsed ? "left-full bottom-0 ml-2 mb-1" : "left-3 right-3 bottom-full mb-1"
              )}>
                <div className="px-3 py-2 border-b border-border/50">
                  <p className="text-[13px] font-medium text-text-primary">{userInfo.username}</p>
                  <p className="text-[11px] text-muted-foreground">{roleLabel[userInfo.role] ?? userInfo.role}</p>
                </div>
                <button
                  type="button"
                  onClick={() => { navigate("/profile"); setUserMenuOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-muted transition-colors"
                >
                  <User className="h-3.5 w-3.5" />
                  个人中心
                </button>
                <button
                  type="button"
                  onClick={() => { userInfo.onLogout(); setUserMenuOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-text-secondary hover:bg-muted transition-colors"
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
      <main
        role="main"
        className="overflow-auto bg-surface-primary"
      >
        {/* aria-live region for dynamic content updates */}
        <div aria-live="polite" role="status" className="sr-only" id="main-status-announcements" />
        {children}
      </main>

      {/* ================================================================ */}
      {/* Right Detail Drawer                                             */}
      {/* ================================================================ */}
      {drawerContent && (
        <Sheet open={drawerOpen} onOpenChange={(open) => { if (!open) onDrawerClose?.(); }}>
          <SheetContent
            side="right"
            className="w-[400px] sm:max-w-[400px] p-0 flex flex-col"
          >
            {drawerTitle && (
              <div className="px-4 py-3 border-b border-border shrink-0">
                <h2 className="text-sm font-semibold text-foreground">{drawerTitle}</h2>
              </div>
            )}
            <div className="flex-1 overflow-auto p-4">
              {drawerContent}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
