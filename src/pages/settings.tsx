import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  Server,
  Shield,
  Key,
  Wifi,
  WifiOff,
  Save,
  FlaskConical,
  ChevronDown,
  ChevronRight,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { authApi, type HermesConfig, type LdapConfig, type LdapStatus } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-context";
import { toast } from "sonner";

export default function SettingsPage() {
  const { username, role } = useAuth();

  /* ── LDAP status ───────────────────────────────────────── */
  const [ldapStatus, setLdapStatus] = useState<LdapStatus | null>(null);
  const [ldapLoading, setLdapLoading] = useState(true);

  /* ── LDAP config form ──────────────────────────────────── */
  const [ldapConfig, setLdapConfig] = useState<LdapConfig | null>(null);
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgExpanded, setCfgExpanded] = useState(false);

  /* ── Hermes config form ────────────────────────────────── */
  const [hermesConfig, setHermesConfig] = useState<HermesConfig | null>(null);
  const [hermesLoading, setHermesLoading] = useState(true);
  const [hermesSaving, setHermesSaving] = useState(false);
  const [hermesExpanded, setHermesExpanded] = useState(false);
  const [hermesTesting, setHermesTesting] = useState(false);

  /* ── Change password ────────────────────────────────────── */
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ old: "", new: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);

  /* ── Load ──────────────────────────────────────────────── */
  const loadLdapStatus = useCallback(() => {
    setLdapLoading(true);
    authApi
      .ldapStatus()
      .then(setLdapStatus)
      .catch(() => setLdapStatus(null))
      .finally(() => setLdapLoading(false));
  }, []);

  const loadLdapConfig = useCallback(() => {
    setCfgLoading(true);
    authApi
      .getLdapConfig()
      .then((cfg) => {
        setLdapConfig(cfg);
        if (cfg.enabled) setCfgExpanded(true);
      })
      .catch(() => toast.error("加载 LDAP 配置失败"))
      .finally(() => setCfgLoading(false));
  }, []);

  const loadHermesConfig = useCallback(() => {
    setHermesLoading(true);
    authApi
      .getHermesConfig()
      .then(setHermesConfig)
      .catch(() => toast.error("加载 Hermes 配置失败"))
      .finally(() => setHermesLoading(false));
  }, []);

  useEffect(() => {
    loadLdapStatus();
    loadLdapConfig();
    loadHermesConfig();
  }, [loadLdapStatus, loadLdapConfig, loadHermesConfig]);

  /* ── Save Hermes config ────────────────────────────────── */
  async function handleSaveHermes() {
    if (!hermesConfig) return;
    setHermesSaving(true);
    try {
      await authApi.saveHermesConfig(hermesConfig);
      toast.success("Hermes 配置已保存");
    } catch (e: any) {
      toast.error(`保存失败: ${e.message}`);
    } finally {
      setHermesSaving(false);
    }
  }

  async function handleTestHermes() {
    setHermesTesting(true);
    try {
      const result = await authApi.testHermes();
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (e: any) {
      toast.error(`测试失败: ${e.message}`);
    } finally {
      setHermesTesting(false);
    }
  }

  /* ── Save LDAP config ──────────────────────────────────── */
  async function handleSaveConfig() {
    if (!ldapConfig) return;
    setCfgSaving(true);
    try {
      await authApi.saveLdapConfig(ldapConfig);
      toast.success("LDAP 配置已保存，立即生效");
      loadLdapStatus();
    } catch (e: any) {
      toast.error(`保存失败: ${e.message}`);
    } finally {
      setCfgSaving(false);
    }
  }

  /* ── Change password ────────────────────────────────────── */
  async function handleChangePw() {
    if (!pw.old || !pw.new) {
      toast.error("请填写原密码和新密码");
      return;
    }
    if (pw.new.length < 6) {
      toast.error("新密码至少 6 位");
      return;
    }
    if (pw.new !== pw.confirm) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    setPwSaving(true);
    try {
      await authApi.changePassword(pw.old, pw.new);
      toast.success("密码已修改，下次登录时生效");
      setPwOpen(false);
      setPw({ old: "", new: "", confirm: "" });
    } catch (e: any) {
      toast.error(`修改失败: ${e.message}`);
    } finally {
      setPwSaving(false);
    }
  }

  function updateCfg<K extends keyof LdapConfig>(key: K, value: LdapConfig[K]) {
    setLdapConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl mx-auto">
      <div>
        <h2 className="text-lg font-semibold">系统设置</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          平台配置与 LDAP 企业目录管理
        </p>
      </div>

      {/* ── LDAP configuration ──────────────────────────── */}
      <Card>
        <CardHeader
          className="pb-3 cursor-pointer select-none"
          onClick={() => setCfgExpanded(!cfgExpanded)}
        >
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4" />
              LDAP / Active Directory 配置
            </CardTitle>
            <div className="flex items-center gap-2">
              {!cfgLoading && ldapStatus && (
                ldapStatus.enabled ? (
                  <Badge variant="default" className="gap-1 text-[10px]">
                    {ldapStatus.ok ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                    {ldapStatus.ok ? "已连接" : "未连接"}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">未启用</Badge>
                )
              )}
              {cfgExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </div>
        </CardHeader>

        {cfgExpanded && (
          <CardContent className="space-y-4">
            {cfgLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : ldapConfig ? (
              <>
                {/* ── Enabled toggle ──────────────────────── */}
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ldapConfig.enabled}
                    onChange={(e) => updateCfg("enabled", e.target.checked)}
                    className="h-4 w-4 rounded border-border/60 accent-interactive-primary"
                  />
                  <span className="text-sm">启用 LDAP 认证</span>
                </label>

                {/* ── Server ──────────────────────────────── */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    LDAP 服务器地址
                  </label>
                  <Input
                    value={ldapConfig.server}
                    onChange={(e) => updateCfg("server", e.target.value)}
                    placeholder="ldap://ldap.example.com:389"
                  />
                </div>

                {/* ── Base DN ─────────────────────────────── */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Base DN
                  </label>
                  <Input
                    value={ldapConfig.base_dn}
                    onChange={(e) => updateCfg("base_dn", e.target.value)}
                    placeholder="dc=example,dc=com"
                  />
                </div>

                {/* ── User filter ─────────────────────────── */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    用户过滤模板
                  </label>
                  <Input
                    value={ldapConfig.user_filter}
                    onChange={(e) => updateCfg("user_filter", e.target.value)}
                    placeholder="(uid={username})"
                  />
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    {"{username}"} 会被替换为登录用户名
                  </p>
                </div>

                {/* ── Bind DN ─────────────────────────────── */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Bind DN (可选，用于搜索模式)
                  </label>
                  <Input
                    value={ldapConfig.bind_dn}
                    onChange={(e) => updateCfg("bind_dn", e.target.value)}
                    placeholder="cn=admin,dc=example,dc=com"
                  />
                </div>

                {/* ── Bind password ────────────────────────── */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    Bind Password
                  </label>
                  <Input
                    type="password"
                    value={ldapConfig.bind_password}
                    onChange={(e) => updateCfg("bind_password", e.target.value)}
                    placeholder="(留空则不修改)"
                  />
                </div>

                {/* ── Username attr ────────────────────────── */}
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    用户名属性
                  </label>
                  <Input
                    value={ldapConfig.username_attr}
                    onChange={(e) => updateCfg("username_attr", e.target.value)}
                    placeholder="uid"
                  />
                </div>

                {/* ── Auto-create ──────────────────────────── */}
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ldapConfig.auto_create_user}
                    onChange={(e) => updateCfg("auto_create_user", e.target.checked)}
                    className="h-4 w-4 rounded border-border/60 accent-interactive-primary"
                  />
                  <span className="text-sm">
                    LDAP 用户首次登录时自动创建本地账号
                  </span>
                </label>

                {/* ── Actions ───────────────────────────────── */}
                <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                  <Button size="sm" onClick={handleSaveConfig} disabled={cfgSaving}>
                    <Save className="h-3.5 w-3.5 mr-1" />
                    {cfgSaving ? "保存中…" : "保存配置"}
                  </Button>
                  <Button
                    variant="ghostMuted"
                    size="sm"
                    onClick={loadLdapStatus}
                    disabled={ldapLoading}
                  >
                    <FlaskConical className="h-3.5 w-3.5 mr-1" />
                    测试连接
                  </Button>
                </div>

                {/* ── Status message ────────────────────────── */}
                {!ldapLoading && ldapStatus && (
                  <p
                    className={`text-xs ${ldapStatus.ok ? "text-status-success" : "text-status-active"}`}
                  >
                    {ldapStatus.message}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                加载 LDAP 配置失败
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ── Hermes Gateway ──────────────────────────────── */}
      <Card>
        <CardHeader
          className="pb-3 cursor-pointer select-none"
          onClick={() => setHermesExpanded(!hermesExpanded)}
        >
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Hermes 智能引擎
            </CardTitle>
            <div className="flex items-center gap-2">
              {hermesExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </div>
        </CardHeader>

        {hermesExpanded && (
          <CardContent className="space-y-4">
            {hermesLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : hermesConfig ? (
              <>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    API 地址
                  </label>
                  <Input
                    value={hermesConfig.url}
                    onChange={(e) =>
                      setHermesConfig((prev) =>
                        prev ? { ...prev, url: e.target.value } : prev,
                      )
                    }
                    placeholder="http://host.docker.internal:8642/v1"
                  />
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    Hermes API Server 地址，应包含 /v1 路径
                  </p>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    API Key（可选）
                  </label>
                  <Input
                    type="password"
                    value={hermesConfig.api_key}
                    onChange={(e) =>
                      setHermesConfig((prev) =>
                        prev ? { ...prev, api_key: e.target.value } : prev,
                      )
                    }
                    placeholder="（留空则不使用认证）"
                  />
                </div>

                <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                  <Button
                    size="sm"
                    onClick={handleSaveHermes}
                    disabled={hermesSaving}
                  >
                    <Save className="h-3.5 w-3.5 mr-1" />
                    {hermesSaving ? "保存中…" : "保存配置"}
                  </Button>
                  <Button
                    variant="ghostMuted"
                    size="sm"
                    onClick={handleTestHermes}
                    disabled={hermesTesting}
                  >
                    <FlaskConical className="h-3.5 w-3.5 mr-1" />
                    {hermesTesting ? "测试中…" : "测试连接"}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                加载 Hermes 配置失败
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {/* ── Account security ────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Shield className="h-4 w-4" />
            账号安全
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{username ?? "—"}</p>
              <p className="text-xs text-muted-foreground">
                角色: {role ?? "—"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPwOpen(!pwOpen)}
            >
              <Key className="h-3.5 w-3.5 mr-1" />
              修改密码
            </Button>
          </div>

          {pwOpen && (
            <div className="space-y-3 pt-2 border-t border-border/50">
              <Input
                type="password"
                placeholder="原密码"
                value={pw.old}
                onChange={(e) => setPw({ ...pw, old: e.target.value })}
              />
              <Input
                type="password"
                placeholder="新密码 (至少 6 位)"
                value={pw.new}
                onChange={(e) => setPw({ ...pw, new: e.target.value })}
              />
              <Input
                type="password"
                placeholder="确认新密码"
                value={pw.confirm}
                onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleChangePw} disabled={pwSaving}>
                  {pwSaving ? "保存中…" : "确认修改"}
                </Button>
                <Button
                  variant="ghostMuted"
                  size="sm"
                  onClick={() => {
                    setPwOpen(false);
                    setPw({ old: "", new: "", confirm: "" });
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
