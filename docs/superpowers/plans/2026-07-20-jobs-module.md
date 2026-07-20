# Hermes 定时任务模块 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a scheduled job management page that proxies Hermes `/api/jobs` endpoints through the Liumai backend, with CRUD, run control, and status dashboard.

**Architecture:** Backend acts as a transparent proxy (`/api/jobs/*` → Hermes `/api/jobs/*`) with admin auth. Frontend provides a table-based management page with stat cards, inline actions, and modal forms.

**Tech Stack:** FastAPI + httpx (backend), React 19 + TypeScript + Tailwind CSS v4 + shadcn/base-nova (frontend)

## Global Constraints

- All job endpoints require admin authentication (`require_admin`)
- Backend proxies to Hermes at `{_hermes_url}/api/jobs` (NOT `/v1/api/jobs`)
- Job IDs are 12-character hex strings
- Schedule can be cron expression, `every 2h`, `30m`, or ISO timestamp
- Frontend follows existing patterns: table-based (like datasources), `cn()` for classes, `toast` for notifications
- All user-facing text in Chinese

---

### Task 1: Backend — Jobs proxy route

**Files:**
- Create: `backend/app/routes/jobs.py`

**Interfaces:**
- Produces: `jobs_router` (APIRouter) with 8 proxy endpoints
- Consumes: `_hermes_url`, `_hermes_api_key` from `app.services.hermes`
- Consumes: `require_admin`, `get_current_user` from `app.auth`

- [ ] **Step 1: Create the file with all proxy endpoints**

```python
"""Proxy endpoints for Hermes Jobs API — background scheduled work."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.auth import get_current_user, require_admin
from app.models import User

router = APIRouter()


async def _proxy(
    method: str,
    path: str,
    body: dict | None = None,
    params: dict | None = None,
) -> JSONResponse:
    """Forward a request to the Hermes Jobs API and return its response."""
    from app.services.hermes import _hermes_url, _hermes_api_key

    import httpx

    url = f"{_hermes_url.rstrip('/')}/api/jobs{path}"
    headers: dict[str, str] = {}
    if _hermes_api_key:
        headers["Authorization"] = f"Bearer {_hermes_api_key}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers, params=params)
            elif method == "POST":
                resp = await client.post(url, headers=headers, json=body)
            elif method == "PATCH":
                resp = await client.patch(url, headers=headers, json=body)
            elif method == "DELETE":
                resp = await client.delete(url, headers=headers)
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported method: {method}")

        # Try JSON, fall back to text
        try:
            data = resp.json()
        except Exception:
            data = {"detail": resp.text[:500]}

        return JSONResponse(
            content=data,
            status_code=resp.status_code,
        )
    except httpx.ConnectError:
        raise HTTPException(status_code=502, detail="无法连接到 Hermes 服务")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Hermes 请求超时")


# ── List / Create ──────────────────────────────────────────────────────────

@router.get("")
async def list_jobs(
    include_disabled: bool = False,
    _admin: User = Depends(require_admin),
):
    """List all cron jobs."""
    return await _proxy("GET", "", params={"include_disabled": str(include_disabled).lower()})


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_job(
    body: dict,
    _admin: User = Depends(require_admin),
):
    """Create a new cron job."""
    return await _proxy("POST", "", body=body)


# ── Single job ─────────────────────────────────────────────────────────────

@router.get("/{job_id}")
async def get_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Get a single job by ID."""
    return await _proxy("GET", f"/{job_id}")


@router.patch("/{job_id}")
async def update_job(
    job_id: str,
    body: dict,
    _admin: User = Depends(require_admin),
):
    """Update an existing job."""
    return await _proxy("PATCH", f"/{job_id}", body=body)


@router.delete("/{job_id}")
async def delete_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Delete a job."""
    return await _proxy("DELETE", f"/{job_id}")


# ── Actions ────────────────────────────────────────────────────────────────

@router.post("/{job_id}/pause")
async def pause_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Pause a scheduled job."""
    return await _proxy("POST", f"/{job_id}/pause")


@router.post("/{job_id}/resume")
async def resume_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Resume a paused job."""
    return await _proxy("POST", f"/{job_id}/resume")


@router.post("/{job_id}/run")
async def run_job(
    job_id: str,
    _admin: User = Depends(require_admin),
):
    """Trigger immediate execution of a job."""
    return await _proxy("POST", f"/{job_id}/run")
```

- [ ] **Step 2: Verify the file has no syntax errors**

```bash
cd backend && python -c "from app.routes.jobs import router; print('OK')"
```

---

### Task 2: Backend — Register jobs router in main.py

**Files:**
- Modify: `backend/app/main.py`

**Interfaces:**
- Consumes: `jobs.router` from Task 1

- [ ] **Step 1: Add jobs router import and registration**

In `backend/app/main.py`, find the router imports (line ~130):

```python
from app.routes import alerts, auth, chat, datasources, history, rca, rules, users  # noqa: E402
```

Add `jobs`:

```python
from app.routes import alerts, auth, chat, datasources, history, jobs, rca, rules, users  # noqa: E402
```

Find the router registrations and add after datasources:

```python
app.include_router(jobs.router, prefix="/api/jobs", tags=["jobs"])
```

- [ ] **Step 2: Verify**

```bash
docker compose build backend && docker compose up -d backend
curl -s http://localhost:8000/health
# Expected: {"status":"ok",...}
```

---

### Task 3: Frontend — API client + types

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `JobItem`, `jobsApi` — consumed by Task 4

- [ ] **Step 1: Add types and API object at end of api.ts**

```typescript
/* ── Hermes Jobs ────────────────────────────────── */

export interface JobItem {
  id: string;
  name: string;
  prompt: string;
  schedule: { kind: string; expr: string };
  skills: string[];
  deliver: string;
  state: "scheduled" | "paused" | "running" | "completed";
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  repeat: { times: number | null; completed: number } | null;
}

export const jobsApi = {
  list: (includeDisabled = false) =>
    request<JobItem[]>("GET", `/jobs?include_disabled=${includeDisabled}`),
  get: (id: string) => request<JobItem>("GET", `/jobs/${id}`),
  create: (data: Partial<JobItem>) => request<JobItem>("POST", "/jobs", data),
  update: (id: string, data: Partial<JobItem>) =>
    request<JobItem>("PATCH", `/jobs/${id}`, data),
  delete: (id: string) => request<void>("DELETE", `/jobs/${id}`),
  pause: (id: string) => request<JobItem>("POST", `/jobs/${id}/pause`),
  resume: (id: string) => request<JobItem>("POST", `/jobs/${id}/resume`),
  run: (id: string) => request<JobItem>("POST", `/jobs/${id}/run`),
};
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
# Expected: no errors
```

---

### Task 4: Frontend — Jobs page

**Files:**
- Create: `src/pages/jobs.tsx`

**Interfaces:**
- Consumes: `jobsApi`, `JobItem` from Task 3
- Consumes: `Button`, `Badge`, `Dialog`, `Input`, `Skeleton` from `@/components/ui/*`

- [ ] **Step 1: Create the full page component**

```tsx
import { useState, useEffect, useCallback, type FC } from "react";
import { Plus, RefreshCw, Play, Pause, RotateCcw, Trash2, Clock, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { jobsApi, type JobItem } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const stateBadge: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
  scheduled: { variant: "default", label: "运行中" },
  paused: { variant: "secondary", label: "已暂停" },
  running: { variant: "default", label: "执行中" },
  completed: { variant: "outline", label: "已完成" },
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobItem | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formSchedule, setFormSchedule] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSkills, setFormSkills] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    jobsApi.list(true).then(setJobs).catch(() => toast.error("加载失败")).finally(() => setLoading(false));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const stats = {
    total: jobs.length,
    running: jobs.filter((j) => j.state === "scheduled" || j.state === "running").length,
    paused: jobs.filter((j) => j.state === "paused").length,
    nextRun: jobs.filter((j) => j.next_run_at).sort((a, b) =>
      (a.next_run_at || "").localeCompare(b.next_run_at || ""))[0]?.next_run_at,
  };

  const openCreate = () => {
    setEditingJob(null);
    setFormName(""); setFormSchedule(""); setFormPrompt(""); setFormSkills("");
    setDialogOpen(true);
  };

  const openEdit = (job: JobItem) => {
    setEditingJob(job);
    setFormName(job.name);
    setFormSchedule(job.schedule?.expr || "");
    setFormPrompt(job.prompt);
    setFormSkills((job.skills || []).join(", "));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName || !formSchedule || !formPrompt) { toast.error("请填写必填字段"); return; }
    setSaving(true);
    const data = {
      name: formName,
      schedule: { kind: "cron", expr: formSchedule },
      prompt: formPrompt,
      skills: formSkills.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      if (editingJob) {
        await jobsApi.update(editingJob.id, data);
        toast.success("任务已更新");
      } else {
        await jobsApi.create(data as JobItem);
        toast.success("任务已创建");
      }
      setDialogOpen(false);
      refresh();
    } catch { toast.error("保存失败"); }
    finally { setSaving(false); }
  };

  const handleAction = async (id: string, action: "run" | "pause" | "resume" | "delete") => {
    try {
      if (action === "run") { await jobsApi.run(id); toast.success("已触发执行"); }
      else if (action === "pause") { await jobsApi.pause(id); toast.success("已暂停"); }
      else if (action === "resume") { await jobsApi.resume(id); toast.success("已恢复"); }
      else if (action === "delete") { await jobsApi.delete(id); toast.success("已删除"); }
      refresh();
    } catch { toast.error("操作失败"); }
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
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建任务</Button>
        </div>
      </div>

      {/* Stats dashboard */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "总计", value: stats.total, icon: Zap },
          { label: "运行中", value: stats.running, icon: Play },
          { label: "已暂停", value: stats.paused, icon: Pause },
          { label: "下次执行", value: stats.nextRun ? new Date(stats.nextRun).toLocaleString("zh-CN") : "—", icon: Clock },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="shrink-0 h-10 w-10 rounded-lg bg-interactive-primary/10 flex items-center justify-center">
                <s.icon className="h-5 w-5 text-interactive-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold text-text-primary">
                  {typeof s.value === "number" ? s.value : ""}
                </p>
                {typeof s.value === "string" && <p className="text-xs text-text-secondary truncate">{s.value}</p>}
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Job table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">暂无定时任务</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">调度</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">上次执行</th>
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {jobs.map((job) => {
                  const st = stateBadge[job.state] || { variant: "outline" as const, label: job.state };
                  return (
                    <tr key={job.id} className="hover:bg-surface-secondary/50 transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-medium text-text-primary">{job.name}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">{job.prompt}</p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-secondary">{job.schedule?.expr || "—"}</td>
                      <td className="px-4 py-3"><Badge variant={st.variant}>{st.label}</Badge></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                        {job.last_run_at ? new Date(job.last_run_at).toLocaleString("zh-CN") : "—"}
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
                          <Button variant="ghostMuted" size="icon-sm" onClick={() => handleAction(job.id, "delete")} title="删除">
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
              <Input value={formSchedule} onChange={(e) => setFormSchedule(e.target.value)} placeholder="0 9 * * *  / every 2h  / 30m" className="mt-1 font-mono text-xs" />
              <p className="text-xs text-muted-foreground mt-1">支持 cron 表达式、every 间隔、相对延迟（30m/2h/1d）或 ISO 时间戳</p>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">Prompt *</label>
              <Textarea value={formPrompt} onChange={(e) => setFormPrompt(e.target.value)} placeholder="任务执行的自然语言指令..." className="mt-1" rows={4} />
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
    </div>
  );
}
```

Note: The page uses `Pencil` and `Trash2` icons — add to lucide imports.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
# Fix any missing imports (Textarea may not exist — use Input with as="textarea" or a plain textarea)
```

---

### Task 5: Frontend — Register route + sidebar item

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import JobsPage**

```tsx
import JobsPage from "@/pages/jobs";
```

- [ ] **Step 2: Add sidebar item**

In the `Shell` component's `useMemo`, after the skills item:

```tsx
{ id: "jobs", label: "定时任务", icon: <Clock className="h-4 w-4" />, isActive: location.pathname.startsWith("/jobs"), onClick: () => navigate("/jobs") },
```

- [ ] **Step 3: Add route**

In the authenticated routes block:

```tsx
<Route path="/jobs" element={<JobsPage />} />
```

- [ ] **Step 4: Add `Clock` to lucide import** (if not already imported)

Check the imports in App.tsx. `Clock` may need to be added to the lucide-react import line.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit
docker compose build frontend && docker compose up -d frontend
```

---

### Task 6: Wire together + final verification

- [ ] **Step 1: Full build and deploy**

```bash
docker compose build backend frontend && docker compose up -d
```

- [ ] **Step 2: End-to-end test**

1. Login as admin → sidebar shows "定时任务"
2. Click → page loads, shows stat cards + empty table
3. Click "新建任务" → fill form → save
4. Task appears in table with status badge
5. Click ▶ 立即执行 → status updates
6. Click ⏸ 暂停 → status changes to "已暂停"
7. Click ▶ 恢复 → status changes back
8. Click ✕ 删除 → task removed

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: Hermes scheduled jobs management module with CRUD and run control"
```
