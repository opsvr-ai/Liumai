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
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthState>({
  token: null, username: null, role: null,
  login: async () => {}, logout: () => {},
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

  const login = useCallback(async (user: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password }),
    });
    if (!res.ok) {
      throw new Error(await res.text().catch(() => "登录失败"));
    }
    const data = await res.json() as { token: string; username: string; role: string };
    localStorage.setItem("liumai_token", data.token);
    localStorage.setItem("liumai_user", data.username);
    localStorage.setItem("liumai_role", data.role);
    setToken(data.token);
    setUsername(data.username);
    setRole(data.role);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("liumai_token");
    localStorage.removeItem("liumai_user");
    localStorage.removeItem("liumai_role");
    setToken(null); setUsername(null); setRole(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token, username, role, login, logout,
      isAuthenticated: !!token, isAdmin: role === "ADMIN",
    }),
    [token, username, role, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
