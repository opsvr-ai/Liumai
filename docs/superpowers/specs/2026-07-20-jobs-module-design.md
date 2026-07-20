# 定时任务模块 (Hermes Jobs)

**Date**: 2026-07-20 | **Status**: Design approved

## Context

Hermes 提供 `/api/jobs` 端点管理后台定时/调度任务。Liumai 需要前端界面来管理这些任务，后端做 API 代理避免 CORS。

## Architecture

```
Liumai 前端 (jobs.tsx)  ←→  Liumai 后端 (/api/jobs/*)  ←→  Hermes (/api/jobs/*)
```

后端纯代理转发，不持久化任务数据（任务数据由 Hermes 管理）。

## API Endpoints (Hermes)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/jobs` | 列出所有任务 |
| POST | `/api/jobs` | 创建任务 |
| GET | `/api/jobs/{id}` | 获取任务详情 |
| PATCH | `/api/jobs/{id}` | 更新任务 |
| DELETE | `/api/jobs/{id}` | 删除任务 |
| POST | `/api/jobs/{id}/pause` | 暂停任务 |
| POST | `/api/jobs/{id}/resume` | 恢复任务 |
| POST | `/api/jobs/{id}/run` | 立即执行 |

## Job Fields

name, schedule ({kind, expr}), prompt, deliver, skills[], state, enabled, next_run_at, last_run_at, last_status, repeat

## Page Layout

- **状态看板**: 4 个 stat card (运行中/已暂停/总计/下次执行)
- **任务表格**: 名称 | 调度 | 状态 badge | 上次执行 | 操作按钮
- **创建/编辑 Dialog**: name, schedule expr, prompt, skills (多选), deliver
- **行内操作**: ▶立即执行 ⏸暂停 ▶恢复 ✕删除
- **展开面板**: 选中任务时显示执行历史

## Files

| File | Change |
|------|--------|
| `backend/app/routes/jobs.py` | NEW — proxy 8 Hermes job endpoints |
| `backend/app/main.py` | Register jobs router |
| `src/pages/jobs.tsx` | NEW — job management page |
| `src/lib/api.ts` | Add jobsApi + types |
| `src/App.tsx` | Add route + sidebar item |

## Verification

- Admin login → sidebar "定时任务" → create/edit/delete/run/pause/resume
- `npx tsc --noEmit` passes
- `docker compose build && docker compose up -d`
