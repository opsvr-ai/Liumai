import { type ReactNode, useState, useCallback } from "react";
import { LiumaiBrand } from "@/components/liumai-brand";
import {
  ChevronLeft,
  ChevronRight,
  Menu,
  Bell,
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

export interface DashboardShellProps {
  /** Main content rendered in the center area */
  children: ReactNode;
  /** Content rendered in the fixed top header bar */
  headerContent?: ReactNode;
  /** Navigation items for the sidebar */
  sidebarItems: SidebarItem[];
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
  headerContent,
  sidebarItems,
  drawerContent,
  drawerOpen = false,
  onDrawerClose,
  drawerTitle,
  onHomeClick,
  activeIncidentCount = 0,
}: DashboardShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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

        {/* User menu area */}
        {headerContent ?? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghostMuted" size="icon-sm" aria-label="用户菜单">
                <User className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>用户菜单</p>
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

        {/* Sidebar footer */}
        {!sidebarCollapsed && (
          <div className="mt-auto px-3 py-3 border-t border-border">
            <p className="text-xs text-muted-foreground leading-tight">
              六脉 v0.1
            </p>
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
