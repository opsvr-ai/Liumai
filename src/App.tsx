import { Suspense, useMemo, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/components/auth/auth-context";
import { DashboardShell, type SidebarGroup } from "@/components/layout/dashboard-shell";
import { CommandPalette } from "@/components/layout/command-palette";
import { BootLoader, PageLoader } from "@/components/layout/page-loader";
import { buildNavGroups, canAccess, isNavItemActive, type NavPermission } from "@/components/layout/nav-config";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";

import { APP_ROUTES, LoginPage } from "@/routes";

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function RequirePermission({ permission, children }: { permission?: NavPermission; children: ReactNode }) {
  const { role } = useAuth();
  if (!canAccess(permission, role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AppShell() {
  const { username, role, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Navigation is derived from the single config in nav-config.ts. Permission
  // filtering happens there; this layer only maps config → shell view model.
  const navGroups = useMemo<SidebarGroup[]>(() => {
    return buildNavGroups(role).map((group) => ({
      id: group.id,
      label: group.label,
      collapsible: group.collapsible,
      items: group.items.map((item) => ({
        id: item.id,
        label: item.label,
        href: item.path,
        icon: <item.icon className="h-4 w-4" />,
        isActive: isNavItemActive(item, location.pathname),
      })),
    }));
  }, [role, location.pathname]);

  return (
    <>
      <DashboardShell
        navGroups={navGroups}
        onHomeClick={() => navigate("/")}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        userInfo={{
          username: username ?? "",
          role: role ?? "",
          onLogout: () => {
            logout();
            navigate("/login");
          },
        }}
      >
        {/* Route-level code splitting: only the matched page chunk is loaded. */}
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </DashboardShell>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route
                path="/login"
                element={
                  <Suspense fallback={<BootLoader />}>
                    <LoginPage />
                  </Suspense>
                }
              />
              <Route
                element={
                  <RequireAuth>
                    <AppShell />
                  </RequireAuth>
                }
              >
                {APP_ROUTES.map(({ path, Component, permission }) => (
                  <Route
                    key={path}
                    path={path}
                    element={
                      <RequirePermission permission={permission}>
                        <Component />
                      </RequirePermission>
                    }
                  />
                ))}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
            <Toaster position="top-right" richColors />
          </BrowserRouter>
        </AuthProvider>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
