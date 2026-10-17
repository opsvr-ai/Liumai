import { useState, useEffect, useCallback } from "react";
import { Plus, RefreshCw, Play, Pause, RotateCcw, Trash2, Clock, Zap, Pencil, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { jobsApi, type JobItem } from "@/lib/api";
import { toast } from "sonner";

const stateBadge: Record<
  string,
  { variant: "default" | "secondary" | "outline" | "destructive"; label: string }
> = {
  scheduled: { variant: "default", label: "已调度" },
  paused: { variant: "secondary", label: "已暂停" },
  running: { variant: "default", label: "执行中" },
  completed: { variant: "outline", label: "已完成" },
  error: { variant: "destructive", label: "错误" },
};

/** Map Hermes' free-form ``last_status`` to a short Chinese label + colour. */
function lastStatusMeta(status?: string | null): { label: string; className: string } | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (["success", "succeeded", "completed", "ok"].includes(s)) {
    return { label: "成功", className: "text-status-resolved" };
  }
  if (["failed", "failure", "error"].includes(s)) {
    return { label: "失败", className: "text-status-active" };
  }
  if (["running", "started"].includes(s)) {
    return { label: "执行中", className: "text-status-investigating" };
  }
  return { label: status, className: "text-muted-foreground" };
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JobItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Form
  const [formName, setFormName] = useState("");
  const [formSchedule, setFormSchedule] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSkills, setFormSkills] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    jobsApi.list(true)
      .then(setJobs)
      .catch(() => { if (!silent) toast.error("加载失败"); })
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  // Lightweight polling: refresh every 15s only while the tab is visible so a
  // backgrounded page stops hitting the Hermes Jobs API.
  useEffect(() => {
    refresh();
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) { window.clearInterval(timer); timer = null; }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") refresh(true);
      }, 15000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") { refresh(true); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  const stats = {
    total: jobs.length,
    scheduled: jobs.filter((j) => j.state === "scheduled").length,
    running: jobs.filter((j) => j.state === "running").length,
    paused: jobs.filter((j) => j.state === "paused").length,
    nextRun: jobs.filter((j) => j.next_run_at).sort((a, b) =>
      (a.next_run_at || "").localeCompare(b.next_run_at || ""))[0]?.next_run_at,
  };

  const openCreate = () => {
    setEditingJob(null);
    setFormName(""); setFormSchedule(""); setFormPrompt(""); setFormSkills("");
    setDialogOpen(true);
  };

  /** Rebuild an editable schedule string from Hermes' structured schedule.
   *
   * ``schedule_display`` is human text ("once at 2026-10-18 09:00", "every 10m")
   * which Hermes rejects when sent back.  Prefer the raw expression when the
   * API provides it, and only fall back to the display text.
   */
  const scheduleToInput = (job: JobItem): string => {
    const s = job.schedule as any;
    if (s && typeof s === "object") {
      if (typeof s.expr === "string" && s.expr) return s.expr;
      if (typeof s.cron === "string" && s.cron) return s.cron;
      if (typeof s.run_at === "string" && s.run_at) return s.run_at;
      if (typeof s.at === "string" && s.at) return s.at;
      if (typeof s.minutes === "number" && s.minutes > 0) return `every ${s.minutes}m`;
      if (typeof s.seconds === "number" && s.seconds > 0) return `${s.seconds}s`;
    }
    return job.schedule_display || "";
  };

  const openEdit = (job: JobItem) => {
    setEditingJob(job);
    setFormName(job.name);
    setFormSchedule(scheduleToInput(job));
    setFormPrompt(job.prompt);
    setFormSkills((job.skills || []).join(", "));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName || !formSchedule || !formPrompt) { toast.error("请填写必填字段"); return; }
    setSaving(true);
    const data: Record<string, unknown> = {
      name: formName,
      // Hermes expects the raw schedule string ("0 9 * * *", "every 2h", "30m"),
      // not a {kind, expr} object — an object makes POST /api/jobs fail.
      schedule: formSchedule,
      prompt: formPrompt,
      skills: formSkills.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      if (editingJob) {
        await jobsApi.update(editingJob.id, data);
        toast.success("任务已更新");
      } else {
        await jobsApi.create(data);
        toast.success("任务已创建");
      }
      setDialogOpen(false);
      refresh();
    } catch { toast.error("保存失败"); }
    finally { setSaving(false); }
  };

  const handleAction = async (id: string, action: "run" | "pause" | "resume") => {
    try {
      if (action === "run") { await jobsApi.run(id); toast.success("已触发执行"); }
      else if (action === "pause") { await jobsApi.pause(id); toast.success("已暂停"); }
      else if (action === "resume") { await jobsApi.resume(id); toast.success("已恢复"); }
      refresh();
    } catch { toast.error("操作失败"); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await jobsApi.delete(deleteTarget.id);
      toast.success("已删除");
      setDeleteTarget(null);
      refresh();
    } catch { toast.error("操作失败"); }
    finally { setDeleting(false); }
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">定时任务</h2>
          <p className="text-sm text-muted-foreground mt-0.5">管理 Hermes 后台定时作业</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={() => refresh()}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建任务</Button>
        </div>
      </div>

      {/* Stats dashboard */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="shrink-0 h-10 w-10 rounded-lg bg-interactive-primary/10 flex items-center justify-center">
              <Zap className="h-5 w-5 text-interactive-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-text-primary">{stats.total}</p>
              <p className="text-xs text-muted-foreground">总计</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="shrink-0 h-10 w-10 rounded-lg bg-interactive-primary/10 flex items-center justify-center">
              <CalendarClock className="h-5 w-5 text-interactive-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-text-primary">{stats.scheduled}</p>
              <p className="text-xs text-muted-foreground">已调度</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="shrink-0 h-10 w-10 rounded-lg bg-status-resolved/10 flex items-center justify-center">
              <Play className="h-5 w-5 text-status-resolved" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-text-primary">{stats.running}</p>
              <p className="text-xs text-muted-foreground">执行中</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="shrink-0 h-10 w-10 rounded-lg bg-status-investigating/10 flex items-center justify-center">
              <Pause className="h-5 w-5 text-status-investigating" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-text-primary">{stats.paused}</p>
              <p className="text-xs text-muted-foreground">已暂停</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="shrink-0 h-10 w-10 rounded-lg bg-interactive-primary/10 flex items-center justify-center">
              <Clock className="h-5 w-5 text-interactive-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-text-secondary truncate">
                {stats.nextRun ? new Date(stats.nextRun).toLocaleString("zh-CN") : "—"}
              </p>
              <p className="text-xs text-muted-foreground">下次执行</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Job table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">暂无定时任务 — 点击"新建任务"创建第一个</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">调度</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">上次执行 / 最近结果</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {jobs.map((job) => {
                  const st = stateBadge[job.state] || { variant: "outline" as const, label: job.state };
                  const last = lastStatusMeta(job.last_status);
                  return (
                    <tr key={job.id} className="hover:bg-surface-secondary/50 transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-medium text-text-primary">{job.name}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">{job.prompt}</p>
                        {(last || job.last_error) && (
                          <p className="md:hidden mt-1 text-[11px]">
                            {last && <span className={last.className}>最近：{last.label}</span>}
                            {job.last_error && (
                              <span className="text-status-active" title={job.last_error}>
                                {last ? " · " : ""}{job.last_error}
                              </span>
                            )}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-secondary">{job.schedule_display || job.schedule?.display || "—"}</td>
                      <td className="px-4 py-3"><Badge variant={st.variant}>{st.label}</Badge></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                        <p>{job.last_run_at ? new Date(job.last_run_at).toLocaleString("zh-CN") : "—"}</p>
                        {last && <p className={`mt-0.5 text-[11px] ${last.className}`}>最近：{last.label}</p>}
                        {job.last_error && (
                          <p className="mt-0.5 text-[11px] text-status-active max-w-[220px] truncate" title={job.last_error}>
                            {job.last_error}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button variant="ghostMuted" size="icon-sm" onClick={() => handleAction(job.id, "run")} title="立即执行">
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                          {job.state === "paused" ? (
                            <Button variant="ghostMuted" size="icon-sm" onClick={() => handleAction(job.id, "resume")} title="恢复">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <Button variant="ghostMuted" size="icon-sm" onClick={() => handleAction(job.id, "pause")} title="暂停">
                              <Pause className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghostMuted" size="icon-sm" onClick={() => openEdit(job)} title="编辑">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghostMuted" size="icon-sm" onClick={() => setDeleteTarget(job)} title="删除">
                            <Trash2 className="h-3.5 w-3.5 text-status-active" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogTitle>{editingJob ? "编辑任务" : "新建任务"}</DialogTitle>
          <DialogDescription>配置定时任务的名称、调度表达式和执行指令</DialogDescription>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-medium text-text-primary">任务名称 *</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="例如：每日告警汇总" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">调度表达式 *</label>
              <Input value={formSchedule} onChange={(e) => setFormSchedule(e.target.value)} placeholder="0 9 * * *  /  every 2h  /  30m" className="mt-1 font-mono text-xs" />
              <p className="text-xs text-muted-foreground mt-1">支持 cron 表达式、every 间隔、相对延迟（30m/2h/1d）或 ISO 时间戳</p>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">Prompt *</label>
              <textarea
                value={formPrompt}
                onChange={(e) => setFormPrompt(e.target.value)}
                placeholder="任务执行的自然语言指令..."
                className="mt-1 w-full min-h-[100px] rounded-md border border-border bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-interactive-primary/20 focus:border-interactive-primary resize-y"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">关联技能</label>
              <Input value={formSkills} onChange={(e) => setFormSkills(e.target.value)} placeholder="skill1, skill2（逗号分隔）" className="mt-1" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "保存中…" : editingJob ? "更新" : "创建"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除定时任务"
        description={deleteTarget ? `确定要删除任务「${deleteTarget.name}」吗？此操作不可撤销。` : ""}
        confirmLabel="删除"
        variant="destructive"
        isLoading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
