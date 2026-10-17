# 统一错误信封 / 请求追踪 / 权限位 — 落地说明

> 任务：架构报告 Top-3（错误可诊断、请求可追踪、权限可声明）。
> 改动文件：`backend/app/main.py`、`backend/app/auth.py`、`backend/app/routes/auth.py`。
> 未改表结构，未给业务路由加装饰器，未触碰 `chat.py / rca.py / alerts.py / knowledge.py / src/**`。

## 1. 统一错误信封

所有由 FastAPI 处理的 4xx / 5xx（含显式 `HTTPException`、路由 404/405、Pydantic 422、未捕获 500）返回：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "权限不足：当前角色缺少「批量终止」权限",
    "request_id": "3f2a…",
    "detail": "权限不足：当前角色缺少「批量终止」权限",
    "details": {"permission": "rca_terminate", "role": "VIEWER"}
  },
  "detail": {"code": "PERMISSION_DENIED", "message": "…", "permission": "rca_terminate", "role": "VIEWER"}
}
```

- `error.code`：机器码，默认按 HTTP 状态映射（见下表）；`HTTPException(detail={...})` 中的 `code` 会覆盖它（大小写归一为 `UPPER_SNAKE`）。
- `error.message`：中文可读信息。`detail` 为字符串时直接作为 message；为 dict 时读取其中的 `message`（或 `msg`），缺省用状态码默认中文。
- `error.details`：仅在存在结构化信息时出现。dict 型 `detail` 去掉 `code`/`message` 后剩余字段平铺到这里；422 为 `{"errors": [...]}`。
- **兼容旧前端**：响应顶层保留 FastAPI 原样 `detail` 字段（字符串即原字符串；dict 即原 dict；422 即原错误列表），同时 `error.detail` 提供 message 别名。HTTPException 自带的 headers（如 `WWW-Authenticate`）会保留。
- 500 处理不向前端泄漏异常文本，只回固定中文 message；`details.type` 仅给异常类名，完整堆栈只写服务端日志（含 request_id）。

### 状态码 → 机器码

| HTTP | code | HTTP | code |
|---|---|---|---|
| 400 | `BAD_REQUEST` | 429 | `RATE_LIMITED` |
| 401 | `UNAUTHORIZED` | 500 | `INTERNAL_ERROR` |
| 403 | `FORBIDDEN` | 501 | `NOT_IMPLEMENTED` |
| 404 | `NOT_FOUND` | 502 | `BAD_GATEWAY` |
| 405 | `METHOD_NOT_ALLOWED` | 503 | `SERVICE_UNAVAILABLE` |
| 409 | `CONFLICT` | 504 | `GATEWAY_TIMEOUT` |
| 413 | `PAYLOAD_TOO_LARGE` | 其它 4xx | `HTTP_<status>` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 其它 5xx | `INTERNAL_ERROR` |
| 422 | `VALIDATION_ERROR` | | |

业务侧建议写法（信封自动展开）：

```python
raise HTTPException(404, detail={"code": "RCA_NOT_FOUND", "message": "会话不存在", "session_id": 42})
# → error.code=RCA_NOT_FOUND, error.message=会话不存在, error.details={"session_id": 42}
```

实现位置：`backend/app/main.py` 的 `_error_payload` + 三个 exception handler；在 app 创建后注册：
`StarletteHTTPException`、`RequestValidationError`、`Exception`。

## 2. 请求追踪（X-Request-ID）

`RequestIDMiddleware`（`backend/app/auth.py`，纯 ASGI，无第三方依赖）在 `main.py` 中**最后注册 → 位于最外层**：

1. 若请求带 `X-Request-ID` 且匹配 `^[A-Za-z0-9._:-]{1,128}$`，沿用；否则生成 `uuid4().hex`（拒绝空格/控制字符，防 header/日志注入）。
2. 写入 `request.state.request_id` 与 ContextVar（`app.auth._request_id_ctx`，可被 loguru 绑定）。
3. 对每个 HTTP 响应（成功 / 4xx / 5xx）注入 `X-Request-ID` 响应头；错误信封的 `error.request_id` 与响应头一致。
4. CORS 增加 `expose_headers=["X-Request-ID"]`，浏览器端可读取该头做问题反馈。

注意：未捕获异常的 500 响应由 Starlette `ServerErrorMiddleware` 在中间件外层生成，因此该 handler 自行读取 `request.state.request_id` 并设置响应头——已验证透传。

## 3. 权限位（12 个，从 `User.role` 推导，不改表）

`backend/app/auth.py` 常量与目录（key 与老平台 `PERMISSION_CATALOG` 完全一致，前端/审计可直接复用）：

| # | key | 名称 | ADMIN | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| 1 | `policy` | 改变触发策略 | ✓ | — | — |
| 2 | `model` | 调整模型 | ✓ | — | — |
| 3 | `trigger_mode` | 调整触发模式 | ✓ | ✓ | — |
| 4 | `inbox_delete` | 告警列表·删除所选 | ✓ | ✓ | — |
| 5 | `inbox_autoclear` | 告警列表·定时清空 | ✓ | ✓ | — |
| 6 | `trash_clear` | 垃圾箱·清空全部 | ✓ | ✓ | — |
| 7 | `trash_autoclear` | 垃圾箱·定时清空 | ✓ | ✓ | — |
| 8 | `rca_terminate` | 批量终止 | ✓ | ✓ | — |
| 9 | `report_export` | 导出报告 | ✓ | ✓ | — |
| 10 | `kb_annotate` | 知识库标注 | ✓ | ✓ | — |
| 11 | `kb_edit` | 根因库维护 | ✓ | — | — |
| 12 | `kb_advice` | 处置建议维护 | ✓ | — | — |

- `ADMIN` = 全部 12；`OPERATOR` = 8 个日常运维位（触发模式/告警与垃圾箱操作/RCA 终止/报告导出/根因标注），治理与知识维护留给 ADMIN；`VIEWER` = 空集（只读，不持有任何变更位）。未知角色按最小权限（等同 VIEWER）处理。
- 角色映射集中在 `ROLE_PERMISSIONS`，后续要调整只改这一处。
- API：
  - `user_permissions(user) -> list[str]`（按目录顺序稳定输出）
  - `user_has_permission(user, perm) -> bool`
  - `require_permission(perm)`：FastAPI 依赖工厂；未知 perm 在**构造时**抛 `ValueError`（尽早暴露拼写错误）；拒绝时抛 403，`detail` 为 dict，信封得到 `code=PERMISSION_DENIED` + `details.{permission,permission_label,role}`。
- 业务接线（后续任务）：`user: User = Depends(require_permission(PERM_RCA_TERMINATE))`，即返回 `User`，不改变现有端点签名。旧 `require_role/require_admin` 原样保留，灰度期不 403。
- 新端点 `GET /api/auth/permissions`（需登录）返回：

```json
{"role": "OPERATOR", "permissions": ["trigger_mode", "…"], "catalog": [{"key": "policy", "label": "改变触发策略", "description": "…"}, …]}
```

## 4. 验证记录

- `python -m py_compile backend/app/main.py backend/app/auth.py backend/app/routes/auth.py` → 通过。
- TestClient 临时脚本（未入库）对真实 app + 依赖覆盖跑通 **43 项断言**：成功响应 request-id 生成/透传/非法值替换；401/403/404/405/422/500 信封结构与 `code/message/request_id/detail`；dict detail 展开；`X-Request-ID` 响应头透传；三角色权限集合；`GET /api/auth/permissions` 三角色；`require_permission` 三态（ADMIN/OPERATOR 200、VIEWER 403）+ `PERMISSION_DENIED` 细节；未知权限位 `ValueError`。
- `app.openapi()` 正常生成，`/api/auth/permissions` 已在 schema 中；现有端点签名未变。
- `ruff check` 仅剩改动前既有问题（`auth.py` 的 `select` 未使用、`main.py`/`routes/auth.py` 原有的 E402），本次未新增 lint 问题。

## 5. 已知边界 / 后续

- 本次**不**给业务路由挂 `require_permission`（按任务约定由后续任务接线）；接线前这些 12 个位仅由 `/api/auth/permissions` 暴露，不改变现有鉴权行为。
- 本目录只覆盖“变更类”权限；读权限仍由登录态 + 现有逻辑控制（架构报告中的 `chat:read` 等未在本次范围）。
- 错误信封对**所有**错误路径生效，包含非 `/api` 路径（如 `/health`、静态 404）；若某个上游代理依赖 FastAPI 原始错误文本，需改为读取 `error.message`。
- 422 的 `details.errors` 为 Pydantic 原始错误列表（`jsonable_encoder` 后），字段结构同样保留在顶层 `detail`。
