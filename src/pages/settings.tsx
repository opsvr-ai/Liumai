import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server, Shield, Key, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { authApi, type LdapStatus } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-context";
import { toast } from "sonner";

export default function SettingsPage() {
  const { user } = useAuth();
  const [ldap, setLdap] = useState<LdapStatus | null>(null);
  const [ldapLoading, setLdapLoading] = useState(true);

  /* ── Change password ────────────────────────────────────── */
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ old: "", new: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);

  const loadLdap = useCallback(() => {
    setLdapLoading(true);
    authApi
      .ldapStatus()
      .then(setLdap)
      .catch(() => setLdap(null))
      .finally(() => setLdapLoading(false));
  }, []);

  useEffect(() => {
    loadLdap();
  }, [loadLdap]);

  async function handleChangePw() {
    if (!pw.old || !pw.new) { toast.error("请填写原密码和新密码"); return; }
    if (pw.new.length < 6) { toast.error("新密码至少 6 位"); return; }
    if (pw.new !== pw.confirm) { toast.error("两次输入的新密码不一致"); return; }
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

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl mx-auto">
      <div>
        <h2 className="text-lg font-semibold">系统设置</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          平台配置与 LDAP 连接状态
        </p>
      </div>

      {/* ── LDAP status ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="h-4 w-4" />
            LDAP 企业目录
          </CardTitle>
        </CardHeader>
        <CardContent>
          {ldapLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
          ) : ldap ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">状态:</span>
                {ldap.enabled ? (
                  <Badge variant="default" className="gap-1">
                    {ldap.ok ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                    {ldap.ok ? "已连接" : "已启用 (未连接)"}
                  </Badge>
                ) : (
                  <Badge variant="secondary">未启用</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{ldap.message}</p>
              <Button variant="ghostMuted" size="sm" onClick={loadLdap}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                重新检测
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              无法获取 LDAP 状态（需要管理员权限）
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Auth info ───────────────────────────────────── */}
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
              <p className="text-sm font-medium">{user?.username ?? "—"}</p>
              <p className="text-xs text-muted-foreground">
                角色: {user?.role ?? "—"}
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
