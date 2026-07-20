import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  UserPlus,
  Shield,
  User as UserIcon,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { userApi, type UserOut } from "@/lib/api";
import { toast } from "sonner";

/* ── Role display helpers ─────────────────────────────── */
const ROLE_META: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  ADMIN: { label: "管理员", variant: "default" },
  OPERATOR: { label: "运维", variant: "secondary" },
  VIEWER: { label: "只读", variant: "outline" },
};

const AUTH_LABELS: Record<string, string> = {
  LOCAL: "本地",
  LDAP: "LDAP",
};

export default function UsersPage() {
  const [users, setUsers] = useState<UserOut[]>([]);
  const [loading, setLoading] = useState(true);

  /* ── Data ──────────────────────────────────────────── */
  const refresh = useCallback(() => {
    setLoading(true);
    userApi
      .list()
      .then(setUsers)
      .catch(() => toast.error("加载用户列表失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* ── Create dialog ──────────────────────────────────── */
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    username: "",
    password: "",
    role: "VIEWER",
  });
  const [creating, setCreating] = useState(false);

  function openCreate() {
    setCreateForm({ username: "", password: "", role: "VIEWER" });
    setCreateOpen(true);
  }

  async function handleCreate() {
    if (!createForm.username.trim()) {
      toast.error("请输入用户名");
      return;
    }
    if (createForm.password.length < 6) {
      toast.error("密码至少 6 位");
      return;
    }
    setCreating(true);
    try {
      await userApi.create(createForm);
      toast.success(`用户 "${createForm.username}" 已创建`);
      setCreateOpen(false);
      refresh();
    } catch (e: any) {
      toast.error(`创建失败: ${e.message}`);
    } finally {
      setCreating(false);
    }
  }

  /* ── Edit role dialog ───────────────────────────────── */
  const [editUser, setEditUser] = useState<UserOut | null>(null);
  const [editRole, setEditRole] = useState("");
  const [saving, setSaving] = useState(false);

  function openEdit(user: UserOut) {
    setEditUser(user);
    setEditRole(user.role);
  }

  async function handleEdit() {
    if (!editUser) return;
    setSaving(true);
    try {
      await userApi.update(editUser.id, { role: editRole });
      toast.success(`角色已更新`);
      setEditUser(null);
      refresh();
    } catch (e: any) {
      toast.error(`更新失败: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  /* ── Delete ─────────────────────────────────────────── */
  async function handleDelete(user: UserOut) {
    if (!confirm(`确定删除用户 "${user.username}"？此操作不可撤销。`))
      return;
    try {
      await userApi.delete(user.id);
      toast.success(`已删除 "${user.username}"`);
      refresh();
    } catch (e: any) {
      toast.error(`删除失败: ${e.message}`);
    }
  }

  /* ── Render ─────────────────────────────────────────── */
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">用户管理</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            管理平台用户与角色权限
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={openCreate}>
            <UserPlus className="h-4 w-4 mr-1" />
            新建用户
          </Button>
        </div>
      </div>

      {/* ── Loading state ───────────────────────────── */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="py-4">
                <Skeleton className="h-5 w-32 mb-2" />
                <Skeleton className="h-4 w-48" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Empty state ─────────────────────────────── */}
      {!loading && users.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <UserIcon className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">暂无用户</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={openCreate}
            >
              <Plus className="h-4 w-4 mr-1" />
              创建第一个用户
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── User list ───────────────────────────────── */}
      {!loading && users.length > 0 && (
        <div className="space-y-2">
          {users.map((u) => (
            <Card
              key={u.id}
              className="hover:bg-surface-secondary/30 transition-colors"
            >
              <CardContent className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {u.username}
                    </span>
                    <Badge variant="secondary" className="text-[10px] px-1.5">
                      {AUTH_LABELS[u.auth_type] ?? u.auth_type}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge
                      variant={ROLE_META[u.role]?.variant ?? "outline"}
                      className="gap-1"
                    >
                      <Shield className="h-3 w-3" />
                      {ROLE_META[u.role]?.label ?? u.role}
                    </Badge>
                    {u.created_at && (
                      <span className="text-xs text-muted-foreground/60">
                        {new Date(u.created_at).toLocaleDateString("zh-CN")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghostMuted"
                    size="icon-sm"
                    onClick={() => openEdit(u)}
                    title="编辑角色"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghostMuted"
                    size="icon-sm"
                    onClick={() => handleDelete(u)}
                    title="删除用户"
                    disabled={u.id === 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Create dialog ────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogTitle>新建用户</DialogTitle>
          <DialogDescription>
            创建本地账号。LDAP 用户首次登录时自动创建。
          </DialogDescription>
          <div className="space-y-3 mt-2">
            <Input
              placeholder="用户名"
              value={createForm.username}
              onChange={(e) =>
                setCreateForm({ ...createForm, username: e.target.value })
              }
            />
            <Input
              type="password"
              placeholder="密码 (至少 6 位)"
              value={createForm.password}
              onChange={(e) =>
                setCreateForm({ ...createForm, password: e.target.value })
              }
            />
            <div>
              <Select
                value={createForm.role}
                onValueChange={(v) =>
                  setCreateForm({ ...createForm, role: v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择角色" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">管理员</SelectItem>
                  <SelectItem value="OPERATOR">运维</SelectItem>
                  <SelectItem value="VIEWER">只读</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghostMuted"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? "创建中…" : "创建"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit role dialog ─────────────────────────── */}
      <Dialog
        open={editUser !== null}
        onOpenChange={(open) => {
          if (!open) setEditUser(null);
        }}
      >
        <DialogContent>
          <DialogTitle>编辑用户角色</DialogTitle>
          <DialogDescription>
            用户: {editUser?.username}
          </DialogDescription>
          <div className="space-y-3 mt-2">
            <Select value={editRole} onValueChange={setEditRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ADMIN">管理员</SelectItem>
                <SelectItem value="OPERATOR">运维</SelectItem>
                <SelectItem value="VIEWER">只读</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghostMuted" onClick={() => setEditUser(null)}>
                取消
              </Button>
              <Button onClick={handleEdit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
