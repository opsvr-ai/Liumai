import { useMemo } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Activity, History, Home, LogOut, MessageCircle, Shield } from "lucide-react";
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const sidebarItems = useMemo<SidebarItem[]>(() => [
    { id: "home", label: "概览", icon: <Home className="h-4 w-4" />, isActive: location.pathname === "/", onClick: () => navigate("/") },
    { id: "chat", label: "智能对话", icon: <MessageCircle className="h-4 w-4" />, isActive: location.pathname.startsWith("/chat"), onClick: () => navigate("/chat") },
    { id: "rca", label: "RCA 分析", icon: <Activity className="h-4 w-4" />, isActive: location.pathname.startsWith("/rca"), onClick: () => navigate("/rca") },
    { id: "rules", label: "告警规则", icon: <Shield className="h-4 w-4" />, isActive: location.pathname.startsWith("/rules"), onClick: () => navigate("/rules") },
    { id: "history", label: "历史记录", icon: <History className="h-4 w-4" />, isActive: location.pathname.startsWith("/history"), onClick: () => navigate("/history") },
    { id: "logout", label: "退出", icon: <LogOut className="h-4 w-4" />, onClick: () => { logout(); navigate("/login"); } },
  ], [location.pathname, logout, navigate]);

  return <DashboardShell sidebarItems={sidebarItems} onHomeClick={() => navigate("/")}>{children}</DashboardShell>;
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
