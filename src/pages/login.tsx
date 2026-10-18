import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/components/auth/auth-context";
import { authApi } from "@/lib/api";
import { LiumaiLogoFull } from "@/components/liumai-logo-full";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, X, KeyRound, Copy, ShieldCheck, ShieldAlert, ShieldQuestion } from "lucide-react";

/* ── Password strength helpers ──────────────────────────────── */

const MIN_LENGTH = 10;

type Strength = "weak" | "fair" | "strong";

interface Checks {
  length: boolean;
  upper: boolean;
  lower: boolean;
  digit: boolean;
  special: boolean;
}

function assessPassword(pw: string): { strength: Strength; checks: Checks; score: number } {
  const checks: Checks = {
    length: pw.length >= MIN_LENGTH,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /\d/.test(pw),
    special: /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?/~`]/.test(pw),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  let strength: Strength = "weak";
  let score = 0;
  if (passed >= 3) { strength = "fair"; score = 50; }
  if (passed >= 5) { strength = "strong"; score = 100; }
  // Scale score within the passed range
  if (passed === 2) score = 25;
  if (passed === 4) score = 75;
  return { strength, checks, score };
}

const STRENGTH_META: Record<Strength, { label: string; bar: string; icon: typeof ShieldCheck }> = {
  weak:   { label: "弱",  bar: "bg-status-active",   icon: ShieldQuestion },
  fair:   { label: "中等", bar: "bg-amber-500",       icon: ShieldAlert },
  strong: { label: "强",  bar: "bg-status-resolved",  icon: ShieldCheck },
};

const CHECK_ITEMS: { key: keyof Checks; label: string }[] = [
  { key: "length",  label: `至少 ${MIN_LENGTH} 位` },
  { key: "upper",   label: "包含大写字母 (A-Z)" },
  { key: "lower",   label: "包含小写字母 (a-z)" },
  { key: "digit",   label: "包含数字 (0-9)" },
  { key: "special", label: "包含特殊字符 (!@#$% 等)" },
];

/* ── Component ───────────────────────────────────────────────── */

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, setup, checkSetup, isAuthenticated } = useAuth();
  const [isFirstSetup, setIsFirstSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [genPw, setGenPw] = useState("");
  const [copyLabel, setCopyLabel] = useState("复制");

  const pwMeta = useMemo(() => assessPassword(password), [password]);
  const StrengthIcon = pwMeta.strength === "weak" ? ShieldQuestion : pwMeta.strength === "fair" ? ShieldAlert : ShieldCheck;

  useEffect(() => {
    if (isAuthenticated) { navigate("/", { replace: true }); return; }
    checkSetup().then(setIsFirstSetup);
  }, [isAuthenticated, checkSetup, navigate]);

  const handleGeneratePassword = useCallback(async () => {
    try {
      const { password: pw } = await authApi.generateSetupPassword();
      setGenPw(pw);
      setPassword(pw);
      setConfirm(pw);
      setShowPw(true);
      setCopyLabel("已复制");
      try { await navigator.clipboard.writeText(pw); } catch { /* clipboard may be blocked */ }
      setTimeout(() => setCopyLabel("复制"), 2000);
    } catch { /* endpoint may not exist yet */ }
  }, []);

  const handleSetup = useCallback(async (e: FormEvent) => {
    e.preventDefault(); setError("");
    if (password.length < MIN_LENGTH) { setError(`密码至少 ${MIN_LENGTH} 位`); return; }
    if (password !== confirm) { setError("密码不一致"); return; }
    const { checks } = assessPassword(password);
    if (!checks.length || !checks.upper || !checks.lower || !checks.digit || !checks.special) {
      setError("密码不符合安全要求 — 请满足下方所有条件");
      return;
    }
    setLoading(true);
    try { await setup(username, password, confirm); navigate("/", { replace: true }); }
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
        <div className="absolute top-1/4 -left-32 w-96 h-96 rounded-full bg-blue-400/[0.06] blur-[120px]" />
        <div className="absolute bottom-1/4 -right-32 w-80 h-80 rounded-full bg-indigo-400/[0.05] blur-[100px]" />
      </div>

      {/* ── Glass card ─────────────────────────────────────── */}
      <div className="relative w-full max-w-[420px]">
        <div className="backdrop-blur-xl bg-white/70 border border-black/[0.06] rounded-3xl shadow-xl shadow-black/[0.03] p-10">
          {/* Logo + brand */}
          <div className="flex flex-col items-center mb-6">
            <LiumaiLogoFull size={132} />
            <h1 className="text-[21px] font-bold tracking-tight text-text-primary mt-5">
              {isFirstSetup ? "初始化 六脉" : "六脉智能运维数智平台"}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1.5 tracking-wide">
              {isFirstSetup ? "创建管理员账户以开始使用" : "Liumai · Intelligent AIOps Platform"}
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

              {/* ── Password field + strength bar ──────────────── */}
              <div className="space-y-1.5">
                <div className="flex items-end justify-between">
                  <label htmlFor="password" className="text-[13px] font-medium text-text-secondary">密码</label>
                  {password.length > 0 && (
                    <span className={`text-[11px] font-medium flex items-center gap-1 ${
                      pwMeta.strength === "strong" ? "text-status-resolved" :
                      pwMeta.strength === "fair" ? "text-amber-600" :
                      "text-status-active"
                    }`}>
                      强度: {STRENGTH_META[pwMeta.strength].label}
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Input id="password" type={showPw ? "text" : "password"}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder={`至少 ${MIN_LENGTH} 位，含大小写字母、数字和特殊字符`}
                    autoComplete="new-password" />
                </div>
                {/* Strength bar */}
                {password.length > 0 && (
                  <div className="flex gap-1 mt-1">
                    {[1, 2, 3, 4].map((seg) => (
                      <div key={seg} className="flex-1 h-1 rounded-full bg-border/50 overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-300 ${
                          seg * 25 <= pwMeta.score ? STRENGTH_META[pwMeta.strength].bar : "bg-transparent"
                        }`} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Confirm password ────────────────────────────── */}
              <div className="space-y-1.5">
                <label htmlFor="confirm" className="text-[13px] font-medium text-text-secondary">确认密码</label>
                <Input id="confirm" type={showPw ? "text" : "password"} value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再次输入密码" autoComplete="new-password" />
                {password && confirm && password !== confirm && (
                  <p className="text-[11px] text-status-active">密码不一致</p>
                )}
              </div>

              {/* ── Show password toggle ────────────────────────── */}
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={showPw} onChange={() => setShowPw((v) => !v)}
                  className="w-3.5 h-3.5 rounded accent-interactive-primary" />
                <span className="text-[12px] text-muted-foreground">显示密码</span>
              </label>

              {/* ── Password requirements checklist ─────────────── */}
              <div className="rounded-xl border border-border/50 bg-surface-secondary/50 p-3 space-y-1">
                <p className="text-[11px] font-medium text-text-secondary mb-1.5">密码要求</p>
                {CHECK_ITEMS.map((item) => {
                  const ok = pwMeta.checks[item.key];
                  return (
                    <div key={item.key} className={`flex items-center gap-1.5 text-[11px] ${ok ? "text-status-resolved" : "text-muted-foreground"}`}>
                      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3 opacity-40" />}
                      {item.label}
                    </div>
                  );
                })}
              </div>

              {/* ── Generate random password ────────────────────── */}
              <button type="button" onClick={handleGeneratePassword}
                className="flex items-center gap-1.5 text-[12px] text-interactive-primary hover:text-interactive-primary/80 transition-colors font-medium">
                <KeyRound className="h-3.5 w-3.5" />生成高安全随机密码
              </button>

              {/* Generated password display */}
              {genPw && (
                <div className="rounded-lg bg-surface-secondary border border-border/50 px-3 py-2 flex items-center justify-between">
                  <code className="text-[13px] text-text-primary select-all">{genPw}</code>
                  <button type="button" onClick={async () => {
                    try { await navigator.clipboard.writeText(genPw); setCopyLabel("已复制"); setTimeout(() => setCopyLabel("复制"), 2000); } catch {}
                  }} className="text-[11px] text-interactive-primary hover:underline ml-2 shrink-0 flex items-center gap-1">
                    <Copy className="h-3 w-3" />{copyLabel}
                  </button>
                </div>
              )}

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
                  placeholder="输入用户名" autoFocus autoComplete="username" />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-[13px] font-medium text-text-secondary">密码</label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码" autoComplete="current-password" />
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
          LIUMAI v0.3
        </p>
      </div>
    </div>
  );
}
