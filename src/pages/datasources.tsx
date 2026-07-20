/** Data sources — manage external monitoring/telemetry connections. */

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, RefreshCw, FlaskConical, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { dataSourceApi, type DataSourceOut } from "@/lib/api";
import { toast } from "sonner";

const TYPE_META: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  prometheus: { label: "Prometheus", variant: "default" },
  zabbix: { label: "Zabbix", variant: "secondary" },
  clickhouse: { label: "ClickHouse", variant: "outline" },
  kafka: { label: "Kafka", variant: "destructive" },
  api: { label: "API", variant: "secondary" },
};

const TYPE_FIELDS: Record<string, { key: string; label: string; placeholder: string }[]> = {
  prometheus: [
    { key: "url", label: "URL", placeholder: "http://localhost:9090" },
    { key: "token", label: "Token (可选)", placeholder: "Bearer token" },
    { key: "query_interval", label: "查询间隔 (秒)", placeholder: "60" },
  ],
  zabbix: [
    { key: "url", label: "API URL", placeholder: "http://zabbix.example.com" },
    { key: "username", label: "用户名", placeholder: "Admin" },
    { key: "password", label: "密码", placeholder: "zabbix" },
  ],
  clickhouse: [
    { key: "host", label: "主机", placeholder: "localhost" },
    { key: "port", label: "端口", placeholder: "8123" },
    { key: "database", label: "数据库", placeholder: "default" },
    { key: "user", label: "用户名", placeholder: "default" },
    { key: "password", label: "密码", placeholder: "" },
  ],
  kafka: [
    { key: "brokers", label: "Brokers (逗号分隔)", placeholder: "localhost:9092" },
    { key: "topic", label: "Topic", placeholder: "alerts" },
    { key: "group_id", label: "Group ID", placeholder: "liumai" },
  ],
  api: [
    { key: "url", label: "URL", placeholder: "https://api.example.com/alerts" },
    { key: "method", label: "Method", placeholder: "GET" },
    { key: "headers", label: "Headers (JSON)", placeholder: '{"Authorization": "Bearer ..."}' },
    { key: "poll_interval", label: "轮询间隔 (秒)", placeholder: "60" },
  ],
};

export default function DataSourcesPage() {
  const [sources, setSources] = useState<DataSourceOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DataSourceOut | null>(null);
  const [formType, setFormType] = useState("prometheus");
  const [formName, setFormName] = useState("");
  const [formConfig, setFormConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    dataSourceApi.list().then(setSources).catch(() => toast.error("加载失败")).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function openCreate() {
    setEditing(null);
    setFormType("prometheus");
    setFormName("");
    setFormConfig({});
    setDialogOpen(true);
  }

  function openEdit(ds: DataSourceOut) {
    setEditing(ds);
    setFormType(ds.type);
    setFormName(ds.name);
    const cfg: Record<string, string> = {};
    if (ds.config) {
      for (const [k, v] of Object.entries(ds.config)) {
        cfg[k] = typeof v === "string" ? v : Array.isArray(v) ? v.join(",") : JSON.stringify(v);
      }
    }
    setFormConfig(cfg);
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!formName.trim()) { toast.error("请输入名称"); return; }
    setSaving(true);
    try {
      const config: Record<string, unknown> = {};
      for (const f of TYPE_FIELDS[formType] ?? []) {
        const v = formConfig[f.key];
        if (v) {
          if (f.key === "query_interval" || f.key === "port" || f.key === "poll_interval") {
            config[f.key] = Number(v) || v;
          } else if (f.key === "brokers") {
            config[f.key] = v.split(",").map((s) => s.trim()).filter(Boolean);
          } else if (f.key === "headers") {
            try { config[f.key] = JSON.parse(v); } catch { config[f.key] = v; }
          } else {
            config[f.key] = v;
          }
        }
      }
      if (editing) {
        await dataSourceApi.update(editing.id, { name: formName, config });
        toast.success("已更新");
      } else {
        await dataSourceApi.create({ name: formName, type: formType, config });
        toast.success("已创建");
      }
      setDialogOpen(false);
      refresh();
    } catch (e: any) {
      toast.error(`保存失败: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(ds: DataSourceOut) {
    if (!confirm(`确定删除 "${ds.name}"？`)) return;
    try { await dataSourceApi.delete(ds.id); toast.success("已删除"); refresh(); }
    catch (e: any) { toast.error(`删除失败: ${e.message}`); }
  }

  async function handleTest(ds: DataSourceOut) {
    setTesting(ds.id);
    try {
      const r = await dataSourceApi.test(ds.id);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch (e: any) {
      toast.error(`测试失败: ${e.message}`);
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">数据源</h2>
          <p className="text-sm text-muted-foreground mt-0.5">管理 Prometheus、Zabbix、ClickHouse、Kafka、API 等外部数据源连接</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建数据源</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">暂无数据源，点击"新建数据源"添加</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs">
                <th className="text-left px-4 py-2 font-medium">名称</th>
                <th className="text-left px-4 py-2 font-medium">类型</th>
                <th className="text-left px-4 py-2 font-medium">连接信息</th>
                <th className="text-left px-4 py-2 font-medium">状态</th>
                <th className="text-right px-4 py-2 font-medium">操作</th>
              </tr></thead>
              <tbody>{sources.map((ds) => (
                <tr key={ds.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="px-4 py-2.5 font-medium">{ds.name}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={TYPE_META[ds.type]?.variant ?? "secondary"} className="text-[11px]">
                      {TYPE_META[ds.type]?.label ?? ds.type}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[200px] truncate">
                    {ds.type === "prometheus" && (ds.config as any)?.url}
                    {ds.type === "clickhouse" && `ClickHouse ${(ds.config as any)?.host}:${(ds.config as any)?.port}`}
                    {ds.type === "zabbix" && (ds.config as any)?.url}
                    {ds.type === "kafka" && `Topic: ${(ds.config as any)?.topic ?? "-"}`}
                    {ds.type === "api" && `${(ds.config as any)?.method ?? "GET"} ${(ds.config as any)?.url ?? ""}`}
                  </td>
                  <td className="px-4 py-2.5">
                    {ds.enabled ? <span className="text-green-600 text-xs flex items-center gap-1"><Check className="h-3 w-3" />启用</span> : <span className="text-muted-foreground text-xs"><X className="h-3 w-3" />禁用</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button variant="ghostMuted" size="icon-sm" onClick={() => handleTest(ds)} disabled={testing === ds.id}>
                        <FlaskConical className={`h-3.5 w-3.5 ${testing === ds.id ? "animate-spin" : ""}`} />
                      </Button>
                      <Button variant="ghostMuted" size="icon-sm" onClick={() => openEdit(ds)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghostMuted" size="icon-sm" onClick={() => handleDelete(ds)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogTitle>{editing ? "编辑数据源" : "新建数据源"}</DialogTitle>
          <DialogDescription>配置外部监控系统的连接信息</DialogDescription>
          <div className="space-y-3 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">名称</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="生产环境 Prometheus" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">类型</label>
              <select
                className="w-full h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm"
                value={formType}
                onChange={(e) => { setFormType(e.target.value); setFormConfig({}); }}
                disabled={!!editing}
              >
                {Object.entries(TYPE_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            {(TYPE_FIELDS[formType] ?? []).map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs font-medium">{f.label}</label>
                <Input
                  value={formConfig[f.key] ?? ""}
                  onChange={(e) => setFormConfig((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                />
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghostMuted" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button onClick={handleSave} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
