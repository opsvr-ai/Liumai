/** Data sources — manage external monitoring/telemetry connections. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, RefreshCw, FlaskConical, Check, X, PlusCircle, MinusCircle, Database } from "lucide-react";
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

  /* ── Headers / body editor state ────────────────── */
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [bodyType, setBodyType] = useState<string>("none");
  const [bodyContent, setBodyContent] = useState("");

  const stats = useMemo(() => {
    const byType = (t: string) => sources.filter((s) => s.type === t).length;
    return { total: sources.length, prometheus: byType("prometheus"), zabbix: byType("zabbix"), clickhouse: byType("clickhouse"), kafka: byType("kafka"), api: byType("api") };
  }, [sources]);

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
    setHeaderRows([{ key: "", value: "" }]);
    setBodyType("none");
    setBodyContent("");
    setDialogOpen(true);
  }

  function openEdit(ds: DataSourceOut) {
    setEditing(ds);
    setFormType(ds.type);
    setFormName(ds.name);
    const cfg: Record<string, unknown> = {};
    const hdrs: { key: string; value: string }[] = [];
    let bt = "none";
    let bc = "";
    if (ds.config) {
      for (const [k, v] of Object.entries(ds.config)) {
        if (k === "auth" && typeof v === "object" && v !== null) {
          cfg.auth = { ...v as Record<string, unknown> };
        } else if (k === "headers" && typeof v === "object" && v !== null) {
          for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
            hdrs.push({ key: hk, value: String(hv) });
          }
        } else if (k === "body" && typeof v === "object" && v !== null) {
          const b = v as Record<string, unknown>;
          bt = String(b.type ?? "none");
          bc = b.template ? JSON.stringify(b.template, null, 2) : "";
        } else if (Array.isArray(v)) {
          cfg[k] = (v as string[]).join(",");
        } else {
          cfg[k] = typeof v === "string" ? v : String(v);
        }
      }
    }
    setFormConfig(cfg as Record<string, string>);
    setHeaderRows(hdrs.length > 0 ? hdrs : [{ key: "", value: "" }]);
    setBodyType(bt);
    setBodyContent(bc);
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!formName.trim()) { toast.error("请输入名称"); return; }
    setSaving(true);
    try {
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formConfig)) {
        if (v === "" || v === undefined) continue;
        if (k === "auth" && typeof v === "object") {
          const auth = { ...(v as Record<string, unknown>) };
          for (const [ak, av] of Object.entries(auth)) { if (av === "" || av === undefined) delete auth[ak]; }
          if (Object.keys(auth).length > 1) config.auth = auth;
        } else if (k === "brokers" && typeof v === "string") {
          config[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
        } else if (k === "port" || k === "timeout_secs") {
          config[k] = Number(v) || v;
        } else {
          config[k] = v;
        }
      }
      // Headers
      const hdrs: Record<string, string> = {};
      for (const row of headerRows) {
        if (row.key.trim()) hdrs[row.key.trim()] = row.value;
      }
      if (Object.keys(hdrs).length > 0) config.headers = hdrs;
      // Body
      if (formType === "api" && bodyType !== "none" && bodyContent.trim()) {
        let tmpl: unknown = bodyContent;
        try { tmpl = JSON.parse(bodyContent); } catch { /* raw string */ }
        config.body = { type: bodyType, template: tmpl };
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

      {!loading && sources.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {[
            { label: "总计", value: stats.total, icon: Database, color: "text-interactive-primary", bg: "bg-interactive-primary/10" },
            { label: "Prometheus", value: stats.prometheus, icon: Check, color: "text-status-resolved", bg: "bg-status-resolved/10" },
            { label: "Zabbix", value: stats.zabbix, icon: Check, color: "text-amber-600", bg: "bg-amber-50" },
            { label: "ClickHouse", value: stats.clickhouse, icon: Check, color: "text-indigo-600", bg: "bg-indigo-50" },
            { label: "Kafka / API", value: stats.kafka + stats.api, icon: Check, color: "text-muted-foreground", bg: "bg-surface-secondary" },
          ].filter((s) => s.value > 0 || s.label === "总计").map((s) => (
            <Card key={s.label}><CardContent className="p-3 flex items-center gap-3">
              <div className={`shrink-0 h-9 w-9 rounded-lg ${s.bg} flex items-center justify-center`}><s.icon className={`h-4 w-4 ${s.color}`} /></div>
              <div><p className="text-lg font-bold text-text-primary">{s.value}</p><p className="text-[11px] text-muted-foreground">{s.label}</p></div>
            </CardContent></Card>
          ))}
        </div>
      )}

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
        <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>{editing ? "编辑数据源" : "新建数据源"}</DialogTitle>
          <DialogDescription>配置外部监控系统的连接信息</DialogDescription>
          <div className="space-y-4 mt-2">
            {/* Name */}
            <div className="space-y-1">
              <label className="text-xs font-medium">名称</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="生产环境 Prometheus" />
            </div>

            {/* Type */}
            <div className="space-y-1">
              <label className="text-xs font-medium">类型</label>
              <select className="w-full h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm"
                value={formType} onChange={(e) => { setFormType(e.target.value); setFormConfig({}); }}
                disabled={!!editing}>
                {Object.entries(TYPE_META).map(([k, v]) => (<option key={k} value={k}>{v.label}</option>))}
              </select>
            </div>

            {/* ── Type-specific fields ──────────────────────────── */}
            {(formType === "prometheus" || formType === "zabbix") && (
              <div className="space-y-1">
                <label className="text-xs font-medium">URL</label>
                <Input value={formConfig.url ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, url: e.target.value }))}
                  placeholder={formType === "prometheus" ? "http://localhost:9090" : "http://zabbix.example.com"} />
              </div>
            )}
            {formType === "clickhouse" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1"><label className="text-xs font-medium">主机</label><Input value={formConfig.host ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, host: e.target.value }))} placeholder="localhost" /></div>
                  <div className="space-y-1"><label className="text-xs font-medium">端口</label><Input value={formConfig.port ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, port: e.target.value }))} placeholder="8123" /></div>
                </div>
                <div className="space-y-1"><label className="text-xs font-medium">数据库</label><Input value={formConfig.database ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, database: e.target.value }))} placeholder="default" /></div>
              </>
            )}
            {formType === "kafka" && (
              <>
                <div className="space-y-1"><label className="text-xs font-medium">Brokers (逗号分隔)</label><Input value={formConfig.brokers ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, brokers: e.target.value }))} placeholder="localhost:9092" /></div>
                <div className="space-y-1"><label className="text-xs font-medium">Topic</label><Input value={formConfig.topic ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, topic: e.target.value }))} placeholder="alerts" /></div>
              </>
            )}
            {formType === "api" && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 space-y-1"><label className="text-xs font-medium">URL</label><Input value={formConfig.url ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, url: e.target.value }))} placeholder="https://api.example.com/v1/alerts" /></div>
                  <div className="space-y-1"><label className="text-xs font-medium">Method</label><select className="w-full h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm" value={formConfig.method ?? "GET"} onChange={(e) => setFormConfig((p) => ({ ...p, method: e.target.value }))}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></div>
                </div>

                {/* Headers editor */}
                <div className="border-t border-border pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium">Headers</p>
                    <button type="button" onClick={() => setHeaderRows((r) => [...r, { key: "", value: "" }])} className="text-interactive-primary hover:text-interactive-primary/80">
                      <PlusCircle className="h-4 w-4" />
                    </button>
                  </div>
                  {headerRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2 mb-1.5">
                      <Input className="flex-1" value={row.key} placeholder="Header 名称" onChange={(e) => {
                        const next = [...headerRows]; next[i] = { ...next[i], key: e.target.value }; setHeaderRows(next);
                      }} />
                      <Input className="flex-[2]" value={row.value} placeholder="值" onChange={(e) => {
                        const next = [...headerRows]; next[i] = { ...next[i], value: e.target.value }; setHeaderRows(next);
                      }} />
                      {headerRows.length > 1 && (
                        <button type="button" onClick={() => setHeaderRows((r) => r.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-status-active shrink-0">
                          <MinusCircle className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Body editor */}
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-medium mb-2">Body</p>
                  <select className="w-full h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm mb-2"
                    value={bodyType}
                    onChange={(e) => { setBodyType(e.target.value); if (e.target.value === "none") setBodyContent(""); }}>
                    <option value="none">无 Body</option>
                    <option value="json">JSON (application/json)</option>
                    <option value="form">Form (x-www-form-urlencoded)</option>
                    <option value="raw">Raw Text</option>
                  </select>
                  {bodyType !== "none" && (
                    <textarea
                      className="w-full h-32 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-interactive-primary/25"
                      value={bodyContent}
                      onChange={(e) => setBodyContent(e.target.value)}
                      placeholder={bodyType === "json" ? '{"key": "value"}' : bodyType === "form" ? "key1=value1&key2=value2" : "raw body content"}
                    />
                  )}
                </div>
              </>
            )}

            {/* ── Auth section ─────────────────────────────────── */}
            <div className="border-t border-border pt-3">
              <p className="text-xs font-medium mb-2">认证方式</p>
              {(["prometheus", "zabbix", "kafka", "api"] as const).includes(formType as any) && (
                <>
                  <select className="w-full h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm mb-2"
                    value={(formConfig as any).auth?.type ?? "none"}
                    onChange={(e) => {
                      setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, type: e.target.value } }));
                    }}>
                    <option value="none">无认证</option>
                    {formType !== "zabbix" && <option value="basic">Basic Auth</option>}
                    {formType !== "zabbix" && <option value="bearer">Bearer Token</option>}
                    {formType === "api" && <option value="api_key_header">API Key (Header)</option>}
                    {formType === "api" && <option value="api_key_query">API Key (Query)</option>}
                    {formType === "api" && <option value="oauth2_client_credentials">OAuth2 Client Credentials</option>}
                  </select>

                  {((formConfig as any)?.auth?.type === "basic") && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">用户名</label><Input value={(formConfig as any)?.auth?.username ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, username: e.target.value } }))} /></div>
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">密码</label><Input type="password" value={(formConfig as any)?.auth?.password ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, password: e.target.value } }))} /></div>
                    </div>
                  )}
                  {((formConfig as any)?.auth?.type === "bearer") && (
                    <div className="space-y-1"><label className="text-xs text-muted-foreground">Token</label><Input type="password" value={(formConfig as any)?.auth?.token ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, token: e.target.value } }))} /></div>
                  )}
                  {((formConfig as any)?.auth?.type === "api_key_header") && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">Header 名称</label><Input value={(formConfig as any)?.auth?.key_name ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, key_name: e.target.value } }))} placeholder="X-API-Key" /></div>
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">Key 值</label><Input type="password" value={(formConfig as any)?.auth?.key_value ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, key_value: e.target.value } }))} /></div>
                    </div>
                  )}
                  {((formConfig as any)?.auth?.type === "api_key_query") && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">参数名</label><Input value={(formConfig as any)?.auth?.query_param ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, query_param: e.target.value } }))} placeholder="api_key" /></div>
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">参数值</label><Input type="password" value={(formConfig as any)?.auth?.query_value ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, query_value: e.target.value } }))} /></div>
                    </div>
                  )}
                  {((formConfig as any)?.auth?.type === "oauth2_client_credentials") && (
                    <>
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">Token URL</label><Input value={(formConfig as any)?.auth?.token_url ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, token_url: e.target.value } }))} placeholder="https://auth.example.com/oauth/token" /></div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1"><label className="text-xs text-muted-foreground">Client ID</label><Input value={(formConfig as any)?.auth?.client_id ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, client_id: e.target.value } }))} /></div>
                        <div className="space-y-1"><label className="text-xs text-muted-foreground">Client Secret</label><Input type="password" value={(formConfig as any)?.auth?.client_secret ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, auth: { ...(p as any).auth, client_secret: e.target.value } }))} /></div>
                      </div>
                    </>
                  )}
                  {formType === "zabbix" && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">用户名</label><Input value={(formConfig as any).username ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, username: e.target.value }))} /></div>
                      <div className="space-y-1"><label className="text-xs text-muted-foreground">密码</label><Input type="password" value={(formConfig as any).password ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, password: e.target.value }))} /></div>
                    </div>
                  )}
                </>
              )}

              {/* ClickHouse direct user/pass */}
              {formType === "clickhouse" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1"><label className="text-xs text-muted-foreground">用户名</label><Input value={formConfig.user ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, user: e.target.value }))} placeholder="default" /></div>
                  <div className="space-y-1"><label className="text-xs text-muted-foreground">密码</label><Input type="password" value={formConfig.password ?? ""} onChange={(e) => setFormConfig((p) => ({ ...p, password: e.target.value }))} /></div>
                </div>
              )}
            </div>

            {/* ── Timeout ─────────────────────────────────────── */}
            <div className="space-y-1">
              <label className="text-xs font-medium">超时 (秒)</label>
              <Input value={formConfig.timeout_secs ?? "30"} onChange={(e) => setFormConfig((p) => ({ ...p, timeout_secs: e.target.value }))} placeholder="30" />
            </div>

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
