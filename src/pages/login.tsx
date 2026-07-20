import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/components/auth/auth-context";
import { LiumaiLogo } from "@/components/liumai-logo";
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
    <div className="min-h-dvh flex items-center justify-center bg-surface-secondary px-4 relative overflow-hidden">
      {/* ── Background decoration ───────────────────────────── */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {/* Soft gradient orbs */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 rounded-full bg-blue-400/[0.06] blur-[120px]" />
        <div className="absolute bottom-1/4 -right-32 w-80 h-80 rounded-full bg-indigo-400/[0.05] blur-[100px]" />
      </div>

      {/* ── Glass card ─────────────────────────────────────── */}
      <div className="relative w-full max-w-[400px]">
        <div className="backdrop-blur-xl bg-white/70 border border-black/[0.06] rounded-3xl shadow-xl shadow-black/[0.03] p-10">
          {/* Logo + brand */}
          <div className="flex flex-col items-center mb-8">
            <div className="bg-[#0B0F19] rounded-3xl p-4 inline-block">
              <LiumaiLogo size={96} />
            </div>
            <h1 className="text-[25px] font-bold tracking-tight text-text-primary mt-5">
              {isFirstSetup ? "初始化 六脉" : "六脉"}
            </h1>
            <p className="text-[14px] text-muted-foreground mt-1.5">
              {isFirstSetup ? "创建管理员账户以开始使用" : "智能化运维数智平台"}
            </p>
          </div>

          {/* Form */}
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

        {/* Footer */}
        <p className="text-[12px] text-muted-foreground/40 text-center mt-8 tracking-widest">
          LIUMAI v0.2
        </p>
      </div>
    </div>
  );
}
