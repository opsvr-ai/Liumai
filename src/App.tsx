import { useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, Database, History, Home, MessageCircle, Settings, Shield, Users, Wrench } from "lucide-react";
import { AuthProvider, useAuth } from "@/components/auth/auth-context";
import { DashboardShell, type SidebarItem } from "@/components/layout/dashboard-shell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "sonner";

import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import ChatPage from "@/pages/chat/chat-page";
import RcaPage from "@/pages/rca/rca-page";
import RulesPage from "@/pages/rules/rules-page";
import HistoryPage from "@/pages/history/history-page";
import SettingsPage from "@/pages/settings";
import UsersPage from "@/pages/users";
import SkillsPage from "@/pages/skills";
import DataSourcesPage from "@/pages/datasources";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { username, role, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const sidebarItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [
      { id: "home", label: "概览", icon: <Home className="h-4 w-4" />, isActive: location.pathname === "/", onClick: () => navigate("/") },
      { id: "chat", label: "智能对话", icon: <MessageCircle className="h-4 w-4" />, isActive: location.pathname.startsWith("/chat"), onClick: () => navigate("/chat") },
      { id: "rca", label: "RCA 分析", icon: <Activity className="h-4 w-4" />, isActive: location.pathname.startsWith("/rca"), onClick: () => navigate("/rca") },
      { id: "rules", label: "告警规则", icon: <Shield className="h-4 w-4" />, isActive: location.pathname.startsWith("/rules"), onClick: () => navigate("/rules") },
      { id: "datasources", label: "数据源", icon: <Database className="h-4 w-4" />, isActive: location.pathname.startsWith("/datasources"), onClick: () => navigate("/datasources") },
      { id: "history", label: "历史记录", icon: <History className="h-4 w-4" />, isActive: location.pathname.startsWith("/history"), onClick: () => navigate("/history") },
      { id: "skills", label: "技能中心", icon: <Wrench className="h-4 w-4" />, isActive: location.pathname.startsWith("/skills"), onClick: () => navigate("/skills") },
    ];
    if (isAdmin) {
      items.push(
        { id: "users", label: "用户管理", icon: <Users className="h-4 w-4" />, isActive: location.pathname.startsWith("/users"), onClick: () => navigate("/users") },
        { id: "settings", label: "系统设置", icon: <Settings className="h-4 w-4" />, isActive: location.pathname.startsWith("/settings"), onClick: () => navigate("/settings") },
      );
    }
    return items;
  }, [location.pathname, navigate, isAdmin]);

  return (
    <DashboardShell
      sidebarItems={sidebarItems}
      onHomeClick={() => navigate("/")}
      userInfo={{
        username: username ?? "",
        role: role ?? "",
        onLogout: () => { logout(); navigate("/login"); },
      }}
    >
      {children}
    </DashboardShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={
              <RequireAuth>
                <Shell>
                  <Routes>
                    <Route path="/" element={<DashboardPage />} />
                    <Route path="/chat" element={<ChatPage />} />
                    <Route path="/rca" element={<RcaPage />} />
                    <Route path="/rules" element={<RulesPage />} />
                    <Route path="/history" element={<HistoryPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/users" element={<UsersPage />} />
                    <Route path="/skills" element={<SkillsPage />} />
                    <Route path="/datasources" element={<DataSourcesPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Shell>
              </RequireAuth>
            } />
          </Routes>
          <Toaster position="top-right" richColors />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}
