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
    <div className="min-h-dvh flex flex-col items-center justify-center relative overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-900">
      {/* Ambient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-20 w-96 h-96 rounded-full bg-blue-500/20 blur-[120px] animate-pulse" />
        <div className="absolute top-1/2 -right-20 w-80 h-80 rounded-full bg-indigo-500/15 blur-[100px] animate-pulse" style={{ animationDelay: "1s" }} />
        <div className="absolute -bottom-32 left-1/3 w-72 h-72 rounded-full bg-cyan-500/10 blur-[90px] animate-pulse" style={{ animationDelay: "2s" }} />
      </div>

      {/* Scan-line overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,rgba(255,255,255,0.03)_2px,rgba(255,255,255,0.03)_4px)]" />

      {/* Card */}
      <div className="relative w-full max-w-[400px] mx-4 -mt-12">
        <div className="backdrop-blur-xl bg-white/[0.04] border border-white/[0.08] rounded-3xl shadow-2xl shadow-black/40 p-10">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <div className="animate-[pulse_3s_ease-in-out_infinite]">
              <LiumaiLogo size={72} className="text-blue-400 drop-shadow-[0_0_20px_rgba(96,165,250,0.4)]" />
            </div>
            <h1 className="text-[26px] font-bold tracking-tight text-white mt-5">
              {isFirstSetup ? "初始化平台" : "六脉"}
            </h1>
            <p className="text-[14px] text-white/40 mt-2 tracking-wide">
              {isFirstSetup ? "创建管理员账户以开始使用" : "智能化运维数智平台"}
            </p>
          </div>

          {isFirstSetup ? (
            <form onSubmit={handleSetup} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="username" className="text-[13px] font-medium text-white/50">管理员用户名</label>
                <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder="设置管理员用户名" autoFocus
                  className="bg-white/[0.06] border-white/[0.1] text-white placeholder:text-white/20 focus:border-blue-400/50 focus:ring-blue-400/20" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-[13px] font-medium text-white/50">密码</label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位"
                  className="bg-white/[0.06] border-white/[0.1] text-white placeholder:text-white/20 focus:border-blue-400/50 focus:ring-blue-400/20" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="confirm" className="text-[13px] font-medium text-white/50">确认密码</label>
                <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再次输入密码"
                  className="bg-white/[0.06] border-white/[0.1] text-white placeholder:text-white/20 focus:border-blue-400/50 focus:ring-blue-400/20" />
              </div>
              {error && <p className="text-[13px] text-red-400" role="alert">{error}</p>}
              <Button type="submit" className="w-full h-11 text-[15px] rounded-xl mt-2 bg-blue-500 hover:bg-blue-400 transition-colors">
                {loading ? "处理中…" : "创建管理员并登录"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="username" className="text-[13px] font-medium text-white/50">用户名</label>
                <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入用户名" autoFocus
                  className="bg-white/[0.06] border-white/[0.1] text-white placeholder:text-white/20 focus:border-blue-400/50 focus:ring-blue-400/20" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-[13px] font-medium text-white/50">密码</label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  className="bg-white/[0.06] border-white/[0.1] text-white placeholder:text-white/20 focus:border-blue-400/50 focus:ring-blue-400/20" />
              </div>
              {error && <p className="text-[13px] text-red-400" role="alert">{error}</p>}
              <Button type="submit" className="w-full h-11 text-[15px] rounded-xl mt-2 bg-blue-500 hover:bg-blue-400 transition-colors">
                {loading ? "登录中…" : "登录"}
              </Button>
            </form>
          )}
        </div>

        <p className="text-[12px] text-white/20 text-center mt-8 tracking-widest">LIUMAI v0.2</p>
      </div>
    </div>
  );
}
