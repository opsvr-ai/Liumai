import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/components/auth/auth-context";
import { LiumaiLogo } from "@/components/liumai-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const { login, setup, checkSetup, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [isSetup, setIsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkSetup().then((needs) => { setIsSetup(needs); setLoading(false); });
  }, [checkSetup]);

  if (isAuthenticated) { navigate("/", { replace: true }); return null; }

  const handleSetup = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim()) { setError("请输入用户名"); return; }
    if (password.length < 6) { setError("密码至少6位"); return; }
    if (password !== confirm) { setError("两次密码不一致"); return; }
    try { await setup(username.trim(), password); navigate("/", { replace: true }); }
    catch (err) { setError(err instanceof Error ? err.message : "初始化失败"); }
  }, [username, password, confirm, setup, navigate]);

  const handleLogin = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim()) { setError("请输入用户名"); return; }
    try { await login(username.trim(), password); navigate("/", { replace: true }); }
    catch { setError("登录失败，请重试"); }
  }, [username, password, login, navigate]);

  if (loading) return null;

  const isFirstSetup = isSetup;

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-[#f7f7f8] px-4">
      <div className="w-full max-w-[360px] -mt-16">
        <div className="text-center mb-10">
          <div className="mx-auto mb-6">
            <LiumaiLogo size={64} className="text-primary" />
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-foreground">
            {isFirstSetup ? "初始化平台" : "欢迎使用 六脉"}
          </h1>
          <p className="text-[15px] text-muted-foreground mt-2">
            {isFirstSetup ? "创建管理员账户以开始使用" : "智能化运维数智平台"}
          </p>
        </div>

        {isFirstSetup ? (
          <form onSubmit={handleSetup} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="username" className="text-[13px] font-medium text-muted-foreground">管理员用户名</label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="设置管理员用户名" autoFocus />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-[13px] font-medium text-muted-foreground">密码</label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少6位" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="confirm" className="text-[13px] font-medium text-muted-foreground">确认密码</label>
              <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" />
            </div>
            {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full h-10 text-[15px] rounded-xl mt-2">创建管理员并登录</Button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="username" className="text-[13px] font-medium text-muted-foreground">用户名</label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="输入用户名" autoFocus />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-[13px] font-medium text-muted-foreground">密码</label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入密码" />
            </div>
            {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full h-10 text-[15px] rounded-xl mt-2">登录</Button>
          </form>
        )}

        <p className="text-[12px] text-muted-foreground/60 text-center mt-8">六脉 v0.1</p>
      </div>
    </div>
  );
}
