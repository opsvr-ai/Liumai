# E3 · RCA 手动终止 + 进行中事件入口

> 改动文件：`backend/app/routes/rca.py`、`src/pages/rca/rca-page.tsx`、`src/pages/dashboard.tsx`、`src/pages/alerts.tsx`、`src/lib/api.ts`、`docs/e3-rca-cancel.md`（新增）。
> 未改表结构、未改 `chat.py / auth.py` 等其它后端文件；未新增状态枚举。

## 1. 后端：`POST /api/rca/sessions/{id}/cancel`

| 项目 | 行为 |
| --- | --- |
| 鉴权 | 登录态 + `rca_terminate` 权限位（`Depends(require_permission(PERM_RCA_TERMINATE))`） |
| 团队隔离 | 复用 `_get_scoped_session`；跨团队 / 不存在统一 404 `{"detail":"RCA 会话不存在"}` |
| 状态限制 | 仅 `QUEUED` / `RUNNING`；其它状态 409 `{"detail":"会话已结束"}` |
| 落库 | `RcaStatus` 没有 `CANCELLED`，沿用 `FAILED`；写 `completed_at`、`root_cause_summary="【手动终止】…"`（`_fmt_dt` 北京时间） |
| 时间线 | `CollaborationEvent` + `metadata.kind="rca_cancelled"`（含 `previous_status/operator/hermes_session_id`） |
| 审计 | `record_audit("RCA手动终止")`，detail 记录 `旧状态→FAILED` 与 Hermes id |
| Hermes | 若 `hermes_session_id` 形如 `run_*` / `api-*`，`POST /v1/runs/{id}/stop`，`asyncio.wait_for` 硬 5s；失败只 `logger.warning` |
| Redis 槽位 | 复用 `rca_runner._release_slot(session_id, reason="cancel")`，票据机制保证幂等、不会重复 DECR |
| 响应 | `200 {"session_id": 42, "status": "FAILED", "hermes_stopped": true|false}` |

顺序：先提交终止状态/时间线/审计 → 再 best-effort 停 Hermes → 最后释放槽位。这样 Hermes 挂起也不会让“终止”丢失。已知边界：已进入 Hermes 调用的 runner 进程在返回时仍可能写回终态（`COMPLETED/FAILED`），stop 请求用于尽快缩短该窗口；runner 不在本次可改文件范围内。

## 2. 前端

- **RCA 页列表操作列 / 详情抽屉**：仅 `QUEUED/RUNNING` 且当前用户含 `rca_terminate` 时显示「终止」；`ConfirmDialog` 二次确认（destructive，请求中 loading）；成功后关闭确认框、刷新列表，抽屉保持打开并重新拉取详情以显示终止时间线。
- **权限**：`GET /api/auth/permissions` 读取 `rca_terminate`；接口失败时回退 `role === ADMIN || OPERATOR`（VIEWER 隐藏）。
- **URL 筛选**：`/rca?status=running` 初始化为 `RUNNING`；列表新增 全部/运行中/排队中/已完成/失败 轻量筛选，切换时同步 `status` query（`replace`），打开/关闭详情只增删 `s`，不会丢筛选。
- **入口**：Dashboard「RCA 队列状态」标题旁、告警页 Header 各一个「进行中事件 N → /rca?status=running」，N 取 `/api/rca/queue` 的 `active_count`。
- **api.ts**：`rca.list(page, pageSize, status?)`、`rca.cancel(sessionId)`，并导出兼容别名 `rcaApi`；新增 `authApi.permissions()`。

## 3. 验证命令（curl）

```bash
BASE=http://localhost:8000
# 0) 登录拿 token（换成实际管理员账号/密码）
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r .token)

# 1) 看队列与运行中会话
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rca/queue" | jq
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rca/sessions?status=RUNNING&page=1&page_size=5" \
  | jq '.items[] | {id,status,hermes_session_id}'

# 2) 终止（把 42 换成实际 QUEUED/RUNNING 会话 id）
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/rca/sessions/42/cancel" | jq

# 3) 校验落库 + 时间线（kind=rca_cancelled）
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rca/sessions/42" \
  | jq '{status,completed_at,root_cause_summary,cancelled:[.timeline[]|select(.metadata.kind=="rca_cancelled")]}'

# 4) 重复终止 → 409 {"detail":"会话已结束"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $TOKEN" "$BASE/api/rca/sessions/42/cancel"

# 5) 权限 / 隔离语义
#   VIEWER 调 cancel → 403（code=PERMISSION_DENIED，details.permission=rca_terminate）
#   其它团队会话 id → 404（不暴露存在性）
curl -s -X POST -H "Authorization: Bearer $VIEWER_TOKEN" "$BASE/api/rca/sessions/42/cancel" | jq
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/rca/sessions/999999/cancel" | jq
```

## 4. 本次验证记录

- `python -m py_compile backend/app/routes/rca.py` → 通过。
- 带 `JWT_SECRET` 导入 `app.routes.rca` → `/sessions/{session_id}/cancel` 已注册为 `POST`。
- 临时脚本（未入库）直调 `cancel_rca_session` 覆盖 6 项：QUEUED 终止、`run_`/`api-` 触发 stop、非 run id 跳过 stop、终态 409、跨团队 404、OPERATOR/VIEWER 权限位；全部通过。
- `tsc -p`（因 TS7 移除 `baseUrl`，使用临时等价 tsconfig）：改动文件 0 新增错误；仅剩改动前已存在的 17 个错误（`incident-timeline.tsx / datasources.tsx / knowledge.tsx / users.tsx`）。
- 前端未启动新服务；如需人工验收，刷新现有 Web GUI 后访问 `/rca?status=running`、Dashboard 与告警页入口。
