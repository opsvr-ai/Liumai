import { useState, useEffect, useCallback, type FC } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/components/auth/auth-context";
import { useTheme } from "next-themes";
import { profileApi, type ProfileData, type SessionItem, type UserStats } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, User, Key, History, Settings, Moon, Sun, BarChart3, Loader2, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type TabKey = "info" | "password" | "sessions" | "prefs" | "theme" | "stats";

const TAB_DEFS: { key: TabKey; label: string; icon: typeof User; ldapHidden?: boolean }[] = [
  { key: "info", label: "个人信息", icon: User },
  { key: "password", label: "修改密码", icon: Key, ldapHidden: true },
  { key: "sessions", label: "会话历史", icon: History },
  { key: "prefs", label: "偏好设置", icon: Settings },
  { key: "theme", label: "主题风格", icon: Moon },
  { key: "stats", label: "使用统计", icon: BarChart3 },
];

const roleLabel: Record<string, string> = { ADMIN: "管理员", OPERATOR: "运维", VIEWER: "只读" };
const authLabel: Record<string, string> = { LOCAL: "本地", LDAP: "LDAP" };

export default function ProfilePage() {
  const { authType } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("info");

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [savingAvatar, setSavingAvatar] = useState(false);

  // Password
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  // Stats
  const [stats, setStats] = useState<UserStats | null>(null);

  const isLdap = authType === "LDAP";
  const visibleTabs = TAB_DEFS.filter((t) => !t.ldapHidden || !isLdap);

  useEffect(() => {
    profileApi.getMe().then((p) => { setProfile(p); setAvatarUrl(p.avatar_url || ""); }).catch(() => {});
    profileApi.getMyStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "sessions") {
      profileApi.getMySessions().then((d) => setSessions(d.items)).catch(() => {});
    }
  }, [tab]);

  const handleAvatarSave = useCallback(async () => {
    setSavingAvatar(true);
    try {
      const updated = await profileApi.updateMe({ avatar_url: avatarUrl || null });
      setProfile(updated);
      toast.success("头像已更新");
    } catch { toast.error("保存失败"); }
    finally { setSavingAvatar(false); }
  }, [avatarUrl]);

  const handlePasswordChange = useCallback(async () => {
    if (!oldPw || !newPw) { toast.error("请填写完整"); return; }
    if (newPw !== confirmPw) { toast.error("两次新密码不一致"); return; }
    if (newPw.length < 6) { toast.error("新密码至少6位"); return; }
    setPwLoading(true);
    try {
      const token = localStorage.getItem("liumai_token");
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      if (!res.ok) throw new Error();
      toast.success("密码已修改，请重新登录");
      setOldPw(""); setNewPw(""); setConfirmPw("");
    } catch { toast.error("修改失败，请检查旧密码是否正确"); }
    finally { setPwLoading(false); }
  }, [oldPw, newPw, confirmPw]);

  const handleDeleteSession = useCallback(async (id: number) => {
    try {
      await profileApi.deleteMySession(id);
      setSessions((s) => s.filter((x) => x.id !== id));
      toast.success("会话已删除");
    } catch { toast.error("删除失败"); }
  }, []);

  if (!profile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      {/* Header */}
      <div className="border-b border-border">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghostMuted" size="sm" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> 返回
          </Button>
          <h1 className="text-lg font-semibold text-text-primary">个人中心</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 flex flex-col md:flex-row gap-6">
        {/* Left tab nav */}
        <nav className="flex md:flex-col gap-0.5 md:w-44 shrink-0 overflow-x-auto pb-2 md:pb-0">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors whitespace-nowrap",
                tab === t.key
                  ? "bg-interactive-primary/10 text-interactive-primary font-medium"
                  : "text-text-secondary hover:bg-surface-secondary hover:text-text-primary",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className="flex-1 min-w-0">
          {/* ── Info tab ──────────────────────────────────────────────── */}
          {tab === "info" && (
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="shrink-0 h-20 w-20 rounded-full bg-interactive-primary flex items-center justify-center text-white text-3xl font-bold select-none">
                  {profile.username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-text-primary">{profile.username}</h2>
                  <div className="flex gap-2 mt-1">
                    <Badge variant="default">{roleLabel[profile.role] || profile.role}</Badge>
                    <Badge variant="outline">{authLabel[profile.auth_type] || profile.auth_type}</Badge>
                  </div>
                </div>
              </div>
              <div className="space-y-3 bg-surface-secondary/50 rounded-xl p-4">
                <h3 className="text-sm font-medium text-text-primary">头像 URL</h3>
                <div className="flex gap-2">
                  <Input
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    placeholder="https://example.com/avatar.png"
                    className="flex-1"
                  />
                  <Button size="sm" onClick={handleAvatarSave} disabled={savingAvatar}>
                    {savingAvatar && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                    保存
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">输入图片 URL 作为头像，留空则使用首字母头像</p>
              </div>
            </div>
          )}

          {/* ── Password tab ───────────────────────────────────────────── */}
          {tab === "password" && (
            <div className="max-w-sm space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">修改密码</h2>
              <Input type="password" placeholder="旧密码" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
              <Input type="password" placeholder="新密码（至少6位）" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              <Input type="password" placeholder="确认新密码" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
              <Button onClick={handlePasswordChange} disabled={pwLoading}>
                {pwLoading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                修改密码
              </Button>
            </div>
          )}

          {/* ── Sessions tab ───────────────────────────────────────────── */}
          {tab === "sessions" && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-text-primary">会话历史</h2>
              {sessions.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无会话记录</p>
              )}
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between bg-surface-secondary/50 rounded-lg px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{s.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.updated_at ? new Date(s.updated_at).toLocaleString("zh-CN") : ""}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghostMuted" size="sm" onClick={() => navigate(`/chat/${s.id}`)}>
                      打开
                    </Button>
                    <Button variant="ghostMuted" size="sm" onClick={() => handleDeleteSession(s.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-status-active" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Preferences tab ─────────────────────────────────────────── */}
          {tab === "prefs" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">偏好设置</h2>
              <p className="text-sm text-muted-foreground">默认聊天模式、通知偏好等设置将在后续版本中提供。</p>
            </div>
          )}

          {/* ── Theme tab ───────────────────────────────────────────────── */}
          {tab === "theme" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">主题风格</h2>
              <div className="flex gap-3">
                <button
                  onClick={() => setTheme("light")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-colors",
                    theme === "light"
                      ? "border-interactive-primary bg-interactive-primary/5"
                      : "border-border hover:border-border-default",
                  )}
                >
                  <Sun className="h-5 w-5" />
                  <div className="text-left">
                    <p className="text-sm font-medium text-text-primary">浅色</p>
                    <p className="text-xs text-muted-foreground">明亮清爽</p>
                  </div>
                  {theme === "light" && <Check className="h-4 w-4 text-interactive-primary ml-2" />}
                </button>
                <button
                  onClick={() => setTheme("dark")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-colors",
                    theme === "dark"
                      ? "border-interactive-primary bg-interactive-primary/5"
                      : "border-border hover:border-border-default",
                  )}
                >
                  <Moon className="h-5 w-5" />
                  <div className="text-left">
                    <p className="text-sm font-medium text-text-primary">深色</p>
                    <p className="text-xs text-muted-foreground">护眼舒适</p>
                  </div>
                  {theme === "dark" && <Check className="h-4 w-4 text-interactive-primary ml-2" />}
                </button>
              </div>
            </div>
          )}

          {/* ── Stats tab ────────────────────────────────────────────────── */}
          {tab === "stats" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">使用统计</h2>
              {stats ? (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-surface-secondary/50 rounded-xl p-4">
                    <p className="text-3xl font-bold text-text-primary">{stats.total_sessions}</p>
                    <p className="text-sm text-muted-foreground mt-1">对话次数</p>
                  </div>
                  <div className="bg-surface-secondary/50 rounded-xl p-4">
                    <p className="text-3xl font-bold text-text-primary">{stats.total_messages}</p>
                    <p className="text-sm text-muted-foreground mt-1">消息总数</p>
                  </div>
                </div>
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
