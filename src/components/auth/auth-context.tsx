import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface AuthState {
  token: string | null;
  username: string | null;
  role: string | null;
  authType: string | null;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string, passwordConfirm: string) => Promise<void>;
  checkSetup: () => Promise<boolean>;
  logout: () => void;
  isAuthenticated: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthState>({
  token: null, username: null, role: null, authType: null,
  login: async () => {}, setup: async (_u, _p, _c) => {}, checkSetup: async () => false,
  logout: () => {},
  isAuthenticated: false, isAdmin: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    try { return localStorage.getItem("liumai_token"); } catch { return null; }
  });
  const [username, setUsername] = useState<string | null>(() => {
    try { return localStorage.getItem("liumai_user"); } catch { return null; }
  });
  const [role, setRole] = useState<string | null>(() => {
    try { return localStorage.getItem("liumai_role"); } catch { return null; }
  });
  const [authType, setAuthType] = useState<string | null>(() => {
    try { return localStorage.getItem("liumai_auth_type"); } catch { return null; }
  });

  const login = useCallback(async (user: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password }),
    });
    if (!res.ok) {
      throw new Error(await res.text().catch(() => "登录失败"));
    }
    const data = await res.json() as { token: string; username: string; role: string; auth_type?: string };
    localStorage.setItem("liumai_token", data.token);
    localStorage.setItem("liumai_user", data.username);
    localStorage.setItem("liumai_role", data.role);
    localStorage.setItem("liumai_auth_type", data.auth_type || "");
    setToken(data.token);
    setUsername(data.username);
    setRole(data.role);
    setAuthType(data.auth_type || null);
  }, []);

  const setup = useCallback(async (user: string, password: string, passwordConfirm: string) => {
    const res = await fetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password, password_confirm: passwordConfirm }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "初始化失败");
      throw new Error(msg);
    }
    const data = await res.json() as { token: string; username: string; role: string; auth_type?: string };
    localStorage.setItem("liumai_token", data.token);
    localStorage.setItem("liumai_user", data.username);
    localStorage.setItem("liumai_role", data.role);
    localStorage.setItem("liumai_auth_type", data.auth_type || "");
    setToken(data.token);
    setUsername(data.username);
    setRole(data.role);
    setAuthType(data.auth_type || null);
  }, []);

  const checkSetup = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/setup/status");
      if (!res.ok) return false;
      const data = await res.json() as { needs_setup: boolean };
      return data.needs_setup;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("liumai_token");
    localStorage.removeItem("liumai_user");
    localStorage.removeItem("liumai_role");
    localStorage.removeItem("liumai_auth_type");
    setToken(null); setUsername(null); setRole(null); setAuthType(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token, username, role, authType, login, setup, checkSetup, logout,
      isAuthenticated: !!token, isAdmin: role === "ADMIN",
    }),
    [token, username, role, authType, login, setup, checkSetup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
