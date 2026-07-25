/** Application systems — agent cognition layer backed by Hermes mem0. */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Search, Trash2, Pencil, Layers, RefreshCw,
  Database, Shield, BookOpen, Activity, Link2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { systemApi, type AppSystem } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth/auth-context";

const TIER_META: Record<string, { label: string; className: string }> = {
  L0: { label: "L0 · 核心", className: "bg-red-100 text-red-700 border-red-200" },
  L1: { label: "L1 · 重要", className: "bg-orange-100 text-orange-700 border-orange-200" },
  L2: { label: "L2 · 一般", className: "bg-gray-100 text-gray-600 border-gray-200" },
};

const RESOURCE_TYPE_LABELS: Record<string, { label: string; icon: typeof Shield }> = {
  alert_rule: { label: "告警规则", icon: Shield },
  data_source: { label: "数据源", icon: Database },
  knowledge_doc: { label: "知识文档", icon: BookOpen },
  rca_session: { label: "RCA", icon: Activity },
};

export default function SystemsPage() {
  const { isAdmin } = useAuth();
  const [systems, setSystems] = useState<AppSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [detail, setDetail] = useState<AppSystem | null>(null);

  /* Create / Edit dialog */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AppSystem | null>(null);
  const [form, setForm] = useState({ name: "", tier: "L2", description: "" });
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    const p: Record<string, string | undefined> = {};
    if (search) p.search = search;
    if (tierFilter !== "all") p.tier = tierFilter;
    systemApi.list(p).then(setSystems).catch(() => toast.error("加载失败")).finally(() => setLoading(false));
  }, [search, tierFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", tier: "L2", description: "" });
    setDialogOpen(true);
  }

  function openEdit(s: AppSystem) {
    setEditing(s);
    setForm({ name: s.name, tier: s.tier, description: s.description ?? "" });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("请输入系统名称"); return; }
    setSaving(true);
    try {
      if (editing) {
        await systemApi.update(editing.id, { name: form.name, tier: form.tier, description: form.description });
        toast.success("已更新");
      } else {
        await systemApi.create({ name: form.name, tier: form.tier, description: form.description });
        toast.success("已创建");
      }
      setDialogOpen(false); refresh();
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setSaving(false); }
  }

  async function handleDelete(s: AppSystem) {
    if (!confirm(`确定删除 "${s.name}"？此操作不可撤销。`)) return;
    try { await systemApi.delete(s.id); toast.success("已删除"); if (detail?.id === s.id) setDetail(null); refresh(); }
    catch { toast.error("删除失败"); }
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">应用系统</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            管理智能体对应用系统的认知，用于 RCA 和故障分析
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          {isAdmin && (
            <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建系统档案</Button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-7" placeholder="搜索系统…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-xs"
          value={tierFilter}
          onChange={e => setTierFilter(e.target.value)}
        >
          <option value="all">全部层级</option>
          <option value="L0">L0 核心</option>
          <option value="L1">L1 重要</option>
          <option value="L2">L2 一般</option>
        </select>
      </div>

      {/* Content: list + detail split */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* System cards */}
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 bg-surface-secondary animate-pulse rounded-lg" />
            ))}</div>
          ) : systems.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
              {isAdmin ? (
                <>
                  <Layers className="h-10 w-10 mx-auto mb-2 text-muted-foreground/40" />
                  <p>还没有应用系统</p>
                  <p className="text-xs mt-1">点击「新建系统档案」开始交互式访谈，让智能体了解你的系统</p>
                </>
              ) : (
                <p>暂无应用系统</p>
              )}
            </CardContent></Card>
          ) : (
            systems.map(s => {
              const t = TIER_META[s.tier] ?? TIER_META.L2;
              return (
                <Card
                  key={s.id}
                  className={cn("cursor-pointer hover:border-interactive-primary/50 transition-colors", detail?.id === s.id && "border-interactive-primary/70 ring-1 ring-interactive-primary/20")}
                  onClick={() => setDetail(s)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold truncate">{s.name}</h3>
                          <Badge variant="outline" className={cn("text-[10px] px-1.5", t.className)}>{t.label}</Badge>
                          {s.status !== "active" && (
                            <Badge variant="secondary" className="text-[10px]">{s.status === "archived" ? "已归档" : "停用"}</Badge>
                          )}
                        </div>
                        {s.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                          <span>{s.resources.length} 个关联</span>
                          {s.updated_at && <span>更新于 {new Date(s.updated_at).toLocaleDateString()}</span>}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Detail panel */}
        <Card><CardContent className="p-4">
          {!detail ? (
            <p className="text-sm text-muted-foreground py-10 text-center">选择系统查看详情</p>
          ) : (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm">{detail.name}</h3>
                    <Badge variant="outline" className={cn("text-[10px]", TIER_META[detail.tier]?.className)}>
                      {TIER_META[detail.tier]?.label ?? detail.tier}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    创建于 {detail.created_at ? new Date(detail.created_at).toLocaleDateString() : "-"}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button variant="ghostMuted" size="icon-sm" onClick={() => openEdit(detail)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghostMuted" size="icon-sm" onClick={() => handleDelete(detail)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                  </div>
                )}
              </div>

              {detail.description && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1">描述</p>
                  <p className="text-xs">{detail.description}</p>
                </div>
              )}

              {/* Resource associations */}
              <div>
                <p className="text-[11px] font-medium text-muted-foreground mb-2">关联资源</p>
                {detail.resources.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无关联</p>
                ) : (
                  <div className="space-y-1">
                    {detail.resources.map(r => {
                      const meta = RESOURCE_TYPE_LABELS[r.resource_type] ?? { label: r.resource_type, icon: Link2 };
                      const Icon = meta.icon;
                      return (
                        <div key={r.id} className="flex items-center gap-2 text-xs bg-surface-secondary rounded px-2 py-1">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                          <span>{meta.label}</span>
                          <span className="text-muted-foreground font-mono">#{r.resource_id}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent></Card>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>{editing ? "编辑系统" : "新建系统档案"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "修改系统的基本元信息"
              : "创建应用系统索引记录。系统知识内容将通过 Hermes 访谈技能采集。"}
          </DialogDescription>
          <div className="space-y-3 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">系统名称</label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如: 订单系统" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">业务层级</label>
              <select
                className="w-full h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={form.tier}
                onChange={e => setForm({ ...form, tier: e.target.value })}
              >
                <option value="L0">L0 · 核心链路</option>
                <option value="L1">L1 · 重要服务</option>
                <option value="L2">L2 · 一般服务</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">描述</label>
              <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="简要说明系统职责" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghostMuted" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button onClick={handleSave} disabled={saving}>{saving ? "保存中..." : "保存"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
