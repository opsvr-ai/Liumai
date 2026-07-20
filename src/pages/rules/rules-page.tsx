import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Power, PowerOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ruleApi, type AlertRule } from "@/lib/api";
import { toast } from "sonner";

export default function RulesPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [form, setForm] = useState({ name: "", source: "", severity: "high", condition_expr: "", team_id: 1, description: "" });
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    ruleApi.list(1, 50).then((r) => setRules(r.items)).catch(() => toast.error("加载规则失败")).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function openCreate() { setEditing(null); setForm({ name: "", source: "", severity: "high", condition_expr: "", team_id: 1, description: "" }); setDialogOpen(true); }
  function openEdit(r: AlertRule) { setEditing(r); setForm({ name: r.name, source: r.source, severity: r.severity, condition_expr: r.condition_expr, team_id: r.team_id, description: r.description ?? "" }); setDialogOpen(true); }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("请输入规则名称"); return; }
    setSaving(true);
    try {
      if (editing) { await ruleApi.update(editing.id, form); toast.success("规则已更新"); }
      else { await ruleApi.create(form); toast.success("规则已创建"); }
      setDialogOpen(false); refresh();
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setSaving(false); }
  }

  async function handleDelete(r: AlertRule) {
    if (!confirm(`确定删除 "${r.name}"？`)) return;
    try { await ruleApi.delete(r.id); toast.success("已删除"); refresh(); }
    catch (e: any) { toast.error(`删除失败: ${e.message}`); }
  }

  async function handleToggle(r: AlertRule) {
    try { await ruleApi.toggle(r.id); toast.success(r.enabled ? "已禁用" : "已启用"); refresh(); }
    catch (e: any) { toast.error(`操作失败: ${e.message}`); }
  }

  const sevLabel: Record<string, string> = { critical: "严重", high: "高", medium: "中", low: "低" };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div><h2 className="text-lg font-semibold">告警规则</h2><p className="text-sm text-muted-foreground mt-0.5">管理自动触发 RCA 的匹配规则</p></div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建规则</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          : rules.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">暂无规则，点击"新建规则"创建第一条</p>
          : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs">
                <th className="text-left px-4 py-2 font-medium">名称</th><th className="text-left px-4 py-2 font-medium">来源</th><th className="text-left px-4 py-2 font-medium">级别</th><th className="text-left px-4 py-2 font-medium">条件</th><th className="text-left px-4 py-2 font-medium">状态</th><th className="text-right px-4 py-2 font-medium">操作</th>
              </tr></thead>
              <tbody>{rules.map((r) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.source}</td>
                  <td className="px-4 py-2.5"><Badge variant={r.severity === "critical" ? "destructive" : "secondary"} className="text-[11px]">{sevLabel[r.severity] || r.severity}</Badge></td>
                  <td className="px-4 py-2.5 max-w-xs truncate font-mono text-xs">{r.condition_expr}</td>
                  <td className="px-4 py-2.5">{r.enabled ? <span className="text-green-600 text-xs">启用</span> : <span className="text-muted-foreground text-xs">禁用</span>}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button variant="ghostMuted" size="icon-sm" onClick={() => handleToggle(r)}>{r.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}</Button>
                      <Button variant="ghostMuted" size="icon-sm" onClick={() => openEdit(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghostMuted" size="icon-sm" onClick={() => handleDelete(r)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>{editing ? "编辑规则" : "新建规则"}</DialogTitle>
          <DialogDescription>{editing ? "修改告警规则的匹配条件" : "创建新的告警匹配规则"}</DialogDescription>
          <div className="space-y-3 mt-2">
            <div className="space-y-1"><label className="text-xs font-medium">名称</label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="高 CPU 告警" /></div>
            <div className="space-y-1"><label className="text-xs font-medium">来源</label><Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="prometheus" /></div>
            <div className="space-y-1"><label className="text-xs font-medium">严重性</label><select className="w-full h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
            <div className="space-y-1"><label className="text-xs font-medium">匹配条件</label><Input value={form.condition_expr} onChange={(e) => setForm({ ...form, condition_expr: e.target.value })} placeholder='severity >= "high" AND source == "prometheus"' /></div>
            <div className="flex justify-end gap-2 pt-2"><Button variant="ghostMuted" onClick={() => setDialogOpen(false)}>取消</Button><Button onClick={handleSave} disabled={saving}>{saving ? "保存中..." : "保存"}</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
