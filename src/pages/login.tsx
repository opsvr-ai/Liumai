import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/components/auth/auth-context";
import { LoginLogo } from "@/components/login-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, setup, checkSetup, isAuthenticated } = useAuth();
  const [isFirstSetup, setIsFirstSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated) { navigate("/", { replace: true }); return; }
    checkSetup().then(setIsFirstSetup);
  }, [isAuthenticated, checkSetup, navigate]);

  const handleSetup = useCallback(async (e: FormEvent) => {
    e.preventDefault(); setError("");
    if (password.length < 6) { setError("密码至少 6 位"); return; }
    if (password !== confirm) { setError("密码不一致"); return; }
    setLoading(true);
    try { await setup(username, password); navigate("/", { replace: true }); }
    catch (err: any) { setError(err.message || "初始化失败"); }
    finally { setLoading(false); }
  }, [username, password, confirm, setup, navigate]);

  const handleLogin = useCallback(async (e: FormEvent) => {
    e.preventDefault(); setError("");
    setLoading(true);
    try { await login(username, password); navigate("/", { replace: true }); }
    catch (err: any) { setError(err.message || "登录失败"); }
    finally { setLoading(false); }
  }, [username, password, login, navigate]);

  if (isFirstSetup === null) return null;

  return (
    <div className="min-h-dvh flex bg-surface-secondary">
      {/* ── Left: Animated logo ────────────────────────────── */}
      <div className="hidden lg:flex flex-1 items-center justify-center relative overflow-hidden bg-gradient-to-br from-surface-primary via-blue-50/30 to-surface-primary">
        <LoginLogo className="w-[340px] h-[340px]" />
      </div>

      {/* ── Right: Login form ──────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center px-8 bg-surface-primary">
        <div className="w-full max-w-[380px]">
          {/* Mobile logo */}
          <div className="lg:hidden flex justify-center mb-8">
            <LoginLogo className="w-28 h-28" />
          </div>

          <div className="mb-8">
            <h1 className="text-[28px] font-bold tracking-tight text-text-primary">
              {isFirstSetup ? "初始化平台" : "欢迎回来"}
            </h1>
            <p className="text-[15px] text-muted-foreground mt-2">
              {isFirstSetup ? "创建管理员账户以开始使用" : "登录六脉 · 智能化运维数智平台"}
            </p>
          </div>

          {isFirstSetup ? (
            <form onSubmit={handleSetup} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="username" className="text-[13px] font-medium text-text-secondary">管理员用户名</label>
                <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder="设置管理员用户名" autoFocus />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-[13px] font-medium text-text-secondary">密码</label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="confirm" className="text-[13px] font-medium text-text-secondary">确认密码</label>
                <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再次输入密码" />
              </div>
              {error && <p className="text-[13px] text-status-active" role="alert">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full h-11 text-[15px] rounded-xl mt-2">
                {loading ? "处理中…" : "创建管理员并登录"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="username" className="text-[13px] font-medium text-text-secondary">用户名</label>
                <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入用户名" autoFocus />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-[13px] font-medium text-text-secondary">密码</label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码" />
              </div>
              {error && <p className="text-[13px] text-status-active" role="alert">{error}</p>}
              <Button type="submit" disabled={loading} className="w-full h-11 text-[15px] rounded-xl mt-2">
                {loading ? "登录中…" : "登录"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
