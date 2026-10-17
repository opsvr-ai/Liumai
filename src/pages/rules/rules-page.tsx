import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Power, PowerOff, RefreshCw, Shield, CheckCircle, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ruleApi, type AlertRule, type AlertRuleInput, type RuleAction, type RuleCondition } from "@/lib/api";
import { toast } from "sonner";

/* ==========================================================================
 * Rule condition editor
 *
 * The backend rule engine evaluates an AND-joined array of condition rows:
 *   [{ field, op, value }, ...]
 * This page keeps rows in local form state and submits them as structured
 * JSON.  Legacy free-text `condition_expr` values (stored by the old UI) are
 * shown read-only on the dialog and in the table.
 * ========================================================================== */

const FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "severity", label: "级别（原始/中文/数字）" },
  { value: "severity_level", label: "级别数值（1-5，1 最严重）" },
  { value: "ci_application", label: "CI 应用" },
  { value: "service_name", label: "服务名" },
  { value: "ci_name", label: "CI 名称" },
  { value: "ip", label: "IP" },
  { value: "source", label: "告警来源" },
  { value: "metric", label: "指标" },
  { value: "content", label: "告警内容" },
];

const OP_OPTIONS: { value: string; label: string; severityOnly?: boolean }[] = [
  { value: "eq", label: "等于" },
  { value: "neq", label: "不等于" },
  { value: "contains", label: "包含" },
  { value: "in", label: "属于（逗号分隔）" },
  { value: "gte", label: "数值 ≥", severityOnly: true },
  { value: "lte", label: "数值 ≤", severityOnly: true },
  { value: "regex", label: "正则匹配" },
];

const SEVERITY_LEVEL_VALUES: { value: string; label: string }[] = [
  { value: "1", label: "1 严重" },
  { value: "2", label: "2 重要" },
  { value: "3", label: "3 一般" },
  { value: "4", label: "4 告警" },
  { value: "5", label: "5 提示" },
];

const SEVERITY_RAW_VALUES: { value: string; label: string }[] = [
  { value: "critical", label: "critical（严重）" },
  { value: "high", label: "high（高）" },
  { value: "medium", label: "medium（中）" },
  { value: "low", label: "low（低）" },
  ...SEVERITY_LEVEL_VALUES,
];

type ConditionRow = { key: string; field: string; op: string; value: string };

type RuleForm = {
  name: string;
  description: string;
  enabled: boolean;
  rows: ConditionRow[];
  actions: RuleAction[];
  legacyExpr: string | null;
};

let rowSeq = 0;

function newRow(field = "severity_level", op = "lte", value = "2"): ConditionRow {
  rowSeq += 1;
  return { key: `row-${rowSeq}`, field, op, value };
}

function emptyForm(): RuleForm {
  return { name: "", description: "", enabled: true, rows: [newRow()], actions: [], legacyExpr: null };
}

function isStructuredCondition(value: unknown): value is RuleCondition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { field?: unknown; op?: unknown };
  return typeof candidate.field === "string" && typeof candidate.op === "string";
}

function conditionToRow(condition: RuleCondition): ConditionRow {
  const value = Array.isArray(condition.value)
    ? condition.value.join(", ")
    : String(condition.value ?? "");
  return newRow(condition.field, condition.op, value);
}

function rowToCondition(row: ConditionRow): RuleCondition {
  const value = row.value.trim();
  return {
    field: row.field,
    op: row.op,
    value:
      row.op === "in"
        ? value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
        : value,
  };
}

function fieldLabel(field: string): string {
  return FIELD_OPTIONS.find((option) => option.value === field)?.label ?? field;
}

function opLabel(op: string): string {
  return OP_OPTIONS.find((option) => option.value === op)?.label ?? op;
}

function conditionText(condition: RuleCondition): string {
  const value = Array.isArray(condition.value) ? condition.value.join("、") : condition.value;
  return `${fieldLabel(condition.field)} ${opLabel(condition.op)} ${value}`;
}

function summarizeRule(rule: AlertRule): string {
  const rows = (Array.isArray(rule.conditions) ? rule.conditions : []).filter(isStructuredCondition);
  if (rows.length) return rows.map(conditionText).join(" 且 ");
  if (rule.condition_expr) return rule.condition_expr;
  return "无条件（永不命中）";
}

function validateForm(form: RuleForm): string | null {
  if (!form.name.trim()) return "请输入规则名称";
  if (form.rows.length === 0) {
    return form.legacyExpr
      ? "该规则使用旧版自由文本条件，请先添加结构化条件行再保存"
      : "请至少添加一条匹配条件";
  }
  if (form.rows.length > 20) return "条件行最多 20 条";
  for (let index = 0; index < form.rows.length; index += 1) {
    const row = form.rows[index];
    const raw = row.value.trim();
    if (!raw) return `第 ${index + 1} 行缺少匹配值`;
    if ((row.op === "gte" || row.op === "lte") && row.field !== "severity" && row.field !== "severity_level") {
      return `第 ${index + 1} 行：≥ / ≤ 仅支持级别字段`;
    }
    const values = row.op === "in"
      ? raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
      : [raw];
    if (values.length === 0) return `第 ${index + 1} 行缺少匹配值`;
    if (row.op === "in" && values.length > 20) return `第 ${index + 1} 行最多 20 个取值`;
    if (values.some((item) => item.length > 200)) return `第 ${index + 1} 行取值长度不能超过 200`;
    if (row.op === "regex") {
      try {
        new RegExp(raw);
      } catch {
        return `第 ${index + 1} 行正则语法无效`;
      }
    }
  }
  return null;
}

export default function RulesPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    ruleApi.list(1, 50).then((r) => setRules(r.items)).catch(() => toast.error("加载规则失败")).finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(rule: AlertRule) {
    const rawConditions: unknown = rule.conditions;
    const structured = (Array.isArray(rawConditions) ? rawConditions : []).filter(isStructuredCondition);
    const legacyExpr =
      rule.condition_expr ??
      (typeof rawConditions === "string" ? rawConditions : null);
    setEditing(rule);
    setForm({
      name: rule.name,
      description: rule.description ?? "",
      enabled: rule.enabled,
      rows: structured.map(conditionToRow),
      actions: Array.isArray(rule.actions) ? rule.actions : [],
      legacyExpr,
    });
    setDialogOpen(true);
  }

  function updateRow(index: number, patch: Partial<ConditionRow>) {
    setForm((previous) => ({
      ...previous,
      rows: previous.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    }));
  }

  function handleFieldChange(index: number, field: string) {
    const value = field === "severity_level" ? "2" : field === "severity" ? "high" : "";
    const op = field === "severity" || field === "severity_level" ? "lte" : "contains";
    updateRow(index, { field, op, value });
  }

  function addRow() {
    setForm((previous) => ({ ...previous, rows: [...previous.rows, newRow()] }));
  }

  function removeRow(index: number) {
    setForm((previous) => ({ ...previous, rows: previous.rows.filter((_, rowIndex) => rowIndex !== index) }));
  }

  async function handleSave() {
    const error = validateForm(form);
    if (error) { toast.error(error); return; }
    setSaving(true);
    try {
      const payload: AlertRuleInput = {
        name: form.name.trim(),
        description: form.description.trim(),
        conditions: form.rows.map(rowToCondition),
        actions: form.actions,
        enabled: form.enabled,
      };
      if (editing) { await ruleApi.update(editing.id, payload); toast.success("规则已更新"); }
      else { await ruleApi.create(payload); toast.success("规则已创建"); }
      setDialogOpen(false);
      refresh();
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setSaving(false); }
  }

  async function handleDelete(rule: AlertRule) {
    if (!confirm(`确定删除 "${rule.name}"？`)) return;
    try { await ruleApi.delete(rule.id); toast.success("已删除"); refresh(); }
    catch (e: any) { toast.error(`删除失败: ${e.message}`); }
  }

  async function handleToggle(rule: AlertRule) {
    try { await ruleApi.toggle(rule.id); toast.success(rule.enabled ? "已禁用" : "已启用"); refresh(); }
    catch (e: any) { toast.error(`操作失败: ${e.message}`); }
  }

  const stats = useMemo(() => {
    const conditionRows = rules.reduce((total, rule) => {
      const rows = (Array.isArray(rule.conditions) ? rule.conditions : []).filter(isStructuredCondition);
      return total + rows.length;
    }, 0);
    return {
      total: rules.length,
      enabled: rules.filter((rule) => rule.enabled).length,
      disabled: rules.filter((rule) => !rule.enabled).length,
      conditionRows,
    };
  }, [rules]);

  const preview = useMemo(() => {
    const rows = form.rows.filter((row) => row.value.trim());
    if (rows.length === 0) {
      return form.legacyExpr ? "旧版条件见上方（只读），请添加结构化条件行后保存" : "尚未配置条件";
    }
    return rows
      .map((row) => {
        const value = row.op === "in"
          ? `[${row.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean).join("、")}]`
          : row.op === "regex"
            ? `/${row.value}/i`
            : row.value;
        return `${fieldLabel(row.field)} ${opLabel(row.op)} ${value}`;
      })
      .join(" 且 ");
  }, [form.rows, form.legacyExpr]);

  const isSeverityField = (field: string) => field === "severity" || field === "severity_level";

  function renderValueControl(row: ConditionRow, index: number) {
    const useSelect = isSeverityField(row.field) && row.op !== "in" && row.op !== "contains" && row.op !== "regex";
    if (useSelect) {
      const options = row.field === "severity" ? SEVERITY_RAW_VALUES : SEVERITY_LEVEL_VALUES;
      const hasCurrent = options.some((option) => option.value === row.value);
      return (
        <select
          className="w-full h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          value={row.value}
          onChange={(event) => updateRow(index, { value: event.target.value })}
        >
          {!hasCurrent && <option value={row.value}>{row.value || "请选择"}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    }
    const placeholder = row.op === "in"
      ? "多个取值用英文逗号分隔，如 critical,high"
      : row.op === "regex"
        ? "如 ^(OOM|CPU 满载)"
        : row.op === "contains"
          ? "如 CPU"
          : "如 prometheus";
    return (
      <Input
        value={row.value}
        onChange={(event) => updateRow(index, { value: event.target.value })}
        placeholder={placeholder}
      />
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div><h2 className="text-lg font-semibold">告警规则</h2><p className="text-sm text-muted-foreground mt-0.5">命中规则的告警优先触发 RCA；未命中时回落全局触发策略</p></div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建规则</Button>
        </div>
      </div>

      {!loading && rules.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "总计", value: stats.total, icon: Shield, color: "text-interactive-primary", bg: "bg-interactive-primary/10" },
            { label: "已启用", value: stats.enabled, icon: CheckCircle, color: "text-status-resolved", bg: "bg-status-resolved/10" },
            { label: "已禁用", value: stats.disabled, icon: PowerOff, color: "text-muted-foreground", bg: "bg-surface-secondary" },
            { label: "条件行", value: stats.conditionRows, icon: AlertTriangle, color: "text-status-active", bg: "bg-status-active/10" },
          ].map((s) => (
            <Card key={s.label}><CardContent className="p-3 flex items-center gap-3">
              <div className={`shrink-0 h-9 w-9 rounded-lg ${s.bg} flex items-center justify-center`}><s.icon className={`h-4 w-4 ${s.color}`} /></div>
              <div><p className="text-lg font-bold text-text-primary">{s.value}</p><p className="text-[11px] text-muted-foreground">{s.label}</p></div>
            </CardContent></Card>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? <div className="p-4 space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          : rules.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">暂无规则，点击"新建规则"创建第一条</p>
          : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs">
                <th className="text-left px-4 py-2 font-medium">名称</th><th className="text-left px-4 py-2 font-medium">匹配条件（AND）</th><th className="text-left px-4 py-2 font-medium">状态</th><th className="text-right px-4 py-2 font-medium">操作</th>
              </tr></thead>
              <tbody>{rules.map((r) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="px-4 py-2.5 align-top">
                    <p className="font-medium">{r.name}</p>
                    {r.description && <p className="text-[11px] text-muted-foreground truncate max-w-[16rem]">{r.description}</p>}
                  </td>
                  <td className="px-4 py-2.5 align-top max-w-md">
                    <p className="font-mono text-xs text-muted-foreground truncate" title={summarizeRule(r)}>{summarizeRule(r)}</p>
                  </td>
                  <td className="px-4 py-2.5 align-top">{r.enabled ? <span className="text-green-600 text-xs">启用</span> : <span className="text-muted-foreground text-xs">禁用</span>}</td>
                  <td className="px-4 py-2.5 text-right align-top">
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
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>{editing ? "编辑规则" : "新建规则"}</DialogTitle>
          <DialogDescription>条件行之间为 AND 关系；全部命中才会触发 RCA。未命中时按全局触发策略处理。</DialogDescription>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1"><label className="text-xs font-medium">名称</label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="高 CPU 告警" /></div>
              <div className="space-y-1"><label className="text-xs font-medium">描述</label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="可选说明" /></div>
            </div>

            {form.legacyExpr && (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-2.5 space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">旧版自由文本条件（只读）</p>
                <code className="block text-xs font-mono break-all">{form.legacyExpr}</code>
                <p className="text-[11px] text-muted-foreground">保存时将以下方结构化条件行替换该旧条件。</p>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium">匹配条件（AND）</label>
                <Button variant="ghostMuted" size="sm" onClick={addRow} disabled={form.rows.length >= 20}>
                  <Plus className="h-3.5 w-3.5 mr-1" />添加条件
                </Button>
              </div>
              {form.rows.length === 0 && (
                <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border px-3 py-4 text-center">
                  尚未添加条件行，规则不会命中任何告警
                </p>
              )}
              {form.rows.map((row, index) => (
                <div key={row.key} className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <select
                    className="w-full sm:w-52 h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    value={row.field}
                    onChange={(event) => handleFieldChange(index, event.target.value)}
                  >
                    {FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select
                    className="w-full sm:w-36 h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    value={row.op}
                    onChange={(event) => updateRow(index, { op: event.target.value })}
                  >
                    {OP_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} disabled={!!option.severityOnly && !isSeverityField(row.field)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="flex-1 min-w-0">{renderValueControl(row, index)}</div>
                  <Button variant="ghostMuted" size="icon-sm" onClick={() => removeRow(index)} disabled={form.rows.length <= 1} title="删除该条件">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="rounded-lg border border-border bg-surface-secondary/60 p-2.5 space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">条件预览（AND）</p>
              <p className="text-xs font-mono break-all">{preview}</p>
            </div>

            <label className="flex items-center gap-2 text-xs font-medium">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              启用该规则（禁用后不参与匹配）
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghostMuted" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button onClick={handleSave} disabled={saving}>{saving ? "保存中..." : "保存"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
