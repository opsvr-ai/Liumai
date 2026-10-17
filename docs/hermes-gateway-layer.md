# Hermes 统一网关适配层（只读）

本文档记录 `backend/app/routes/hermes.py` 新增的 Hermes 只读适配层。它把原先散落在
`chat.py`、`rca_runner.py`、`knowledge.py` 里的 Hermes 访问能力收敛到一组统一入口，
并补齐此前未暴露的能力（capabilities / model-options / sessions / runs / jobs / health）。

> 本次只新增只读代理，不修改任何现有接口；写操作继续走原有的 `/api/chat`、`/api/jobs`、
> `/api/rca`、`/api/knowledge` 等路由，功能没有迁移或删减。

## 1. 注册与鉴权

`backend/app/main.py`：

```python
app.include_router(hermes.router, prefix="/api/hermes", tags=["hermes"])
```

`backend/app/routes/hermes.py`：

```python
router = APIRouter(dependencies=[Depends(get_current_user)])
```

- 所有端点统一要求平台 JWT（`get_current_user`），未登录返回中文 `401`。
- 鉴权在 router 级别挂载，新增端点不会漏鉴权。
- Hermes 是全局引擎，这些接口**不做团队隔离**；所有已登录用户看到同一份上游数据。
- 平台到 Hermes 的调用是服务端转发，使用 `app.services.hermes` 中可热加载的
  `_hermes_url` / `_hermes_api_key`；管理员改配置后无需重启。
- API Key 只写入出站 `Authorization: Bearer ...` 头：
  - 不出现在任何响应体、日志或错误详情中；
  - 若上游错误信息回显了 Key，会替换为 `***`。

## 2. 端点清单

| 平台端点 | 上游 Hermes 路径 | 说明 |
|---|---|---|
| `GET /api/hermes/capabilities` | `GET /v1/capabilities` | 能力位；进程内缓存 60 秒 |
| `GET /api/hermes/model-options` | `GET /api/model/options` | provider / 模型 / 价格目录，原样透传 |
| `GET /api/hermes/sessions?limit=50` | `GET /api/sessions?limit=50` | 会话列表，裁剪为摘要字段 |
| `GET /api/hermes/sessions/{session_id}/messages` | `GET /api/sessions/{session_id}/messages` | 完整消息历史 |
| `GET /api/hermes/runs/{run_id}` | `GET /v1/runs/{run_id}` | Run 轮询状态，原样透传 |
| `GET /api/hermes/jobs` | `GET /api/jobs` | 计划任务列表，只读 |
| `GET /api/hermes/health` | `GET /health/detailed` | 健康摘要 |

路径拼接规则：从 `_hermes_url` 去掉末尾的 `/v1` 得到根地址，再拼上表中的路径。
因此 `_hermes_url` 可以是 `http://host:8642` 或 `http://host:8642/v1` 两种形态。
`session_id` / `run_id` 会做 URL 编码后再进入路径，避免路径穿越。

## 3. 超时与错误映射

所有只读调用共用 `_hermes_call()`：

- 总超时 **10 秒**；连接超时 5 秒（`httpx.Timeout(10.0, connect=5.0)`）。
- 这是只读发现接口的预算；聊天/RCA 等长任务仍走原有的 600 秒客户端。

| 场景 | 平台状态码 | 中文 `detail` 示例 |
|---|---|---|
| `_hermes_url` 为空/空白 | `503` | `Hermes 网关未配置：请先在系统设置中填写 Hermes 地址` |
| Hermes 返回 4xx | **原样透传**（400/401/403/404/409/422/429） | `Hermes 资源不存在（HTTP 404）：<上游信息>` |
| 连接失败（DNS/拒绝连接等） | `502` | `无法连接到 Hermes 服务：<原因>` |
| 请求超时 | `504` | `Hermes 请求超时（10 秒）：/api/jobs` |
| 上游 5xx | `502` | `Hermes 网关异常（HTTP 500）：<上游信息>` |
| 2xx 但响应不是 JSON | `502` | `Hermes 返回了非 JSON 响应（HTTP 200）：/api/model/options` |
| 2xx 但 JSON 结构不符合预期 | `502` | `Hermes 会话接口返回了非预期的数据结构` |

上游错误体解析兼容 `{"error": {"message": ...}}`、`{"error": "..."}`、
`{"detail": ...}` 与纯文本；纯文本截断到 500 字符。

## 4. 缓存策略

`GET /api/hermes/capabilities`：

- 进程内缓存 **60 秒**（`CAPABILITIES_CACHE_TTL_SECONDS = 60.0`）。
- 缓存键是全局的：Hermes 能力位与用户无关；缓存同时绑定当前 Hermes 根地址，
  改配置指向另一台网关后不会命中旧缓存。
- 配置为空时先返回 `503`，不会用旧缓存掩盖“未配置”状态。
- 响应头：
  - `X-Hermes-Cache: HIT` / `MISS`
  - `X-Hermes-Fetched-At: <ISO-8601 UTC>`
- 响应体保持 Hermes 原始 capabilities 结构，不额外包裹。
- 缓存过期后上游失败不会回退旧值，按第 3 节返回错误；避免把过期能力位当成实时状态。
- 多 worker 部署时每个进程各自缓存，最多产生一次/进程/60 秒的上游调用。
- 并发 miss 可能产生重复上游请求（只读且幂等，未加锁）。

## 5. 输出字段

### 5.1 会话列表（裁剪后）

`GET /api/hermes/sessions` 返回：

```json
{
  "sessions": [
    {
      "id": "20250305_091523_a1b2c3d4",
      "title": "支付超时排查",
      "model": "anthropic/claude-sonnet-4",
      "provider": "openrouter",
      "tokens": 1500,
      "input_tokens": 1000,
      "output_tokens": 500,
      "cost": 0.0123,
      "message_count": 8,
      "created_at": "2025-03-05T09:15:23+00:00",
      "updated_at": null,
      "last_active_at": "2025-03-05T09:30:00Z",
      "preview": "首条用户消息的前 200 字符"
    }
  ],
  "count": 1,
  "limit": 50
}
```

- `limit` 默认 50，范围 1–200；既作为上游 query 参数，也在本地再次截断。
- 丢弃 `messages`、`tool_calls`、原始 `usage` 等大字段；`preview` 最多 200 字符。
- 字段名统一为现有后端 API 的 **snake_case** 风格。
- 兼容上游数字/毫秒时间戳，统一转 ISO-8601 UTC 字符串。
- 缺少 `id` 的记录会被跳过（无法再查询消息或详情）。

### 5.2 会话消息

`GET /api/hermes/sessions/{session_id}/messages`：

```json
{
  "session_id": "20250305_091523_a1b2c3d4",
  "messages": [{"role": "user", "content": "..."}],
  "count": 1
}
```

消息体不裁剪（这是本接口的交付内容）；兼容上游裸数组或
`{"messages"|"history"|"items"|"data": [...]}` 信封。

### 5.3 能力 / 模型目录 / Run / Jobs

- `capabilities`、`model-options`、`runs/{id}` 均原样返回上游 JSON 对象。
- `jobs` 原样返回上游 JSON（对象或数组），不提供任何写操作。
- 不改变 Hermes 自身的字段命名；Hermes 侧本来就是 snake_case 的字段保持不变。

### 5.4 健康摘要

`GET /api/hermes/health` 只暴露运维需要的摘要：

```json
{
  "ok": true,
  "status": "ok",
  "version": "0.22.1",
  "readiness": {"status": "ok", "checks": {"disk": "ok", "db": "ok"}},
  "platforms": {"telegram": "running", "slack": "stopped"},
  "gateway_state": "running",
  "latency_ms": 23,
  "checked_at": "2026-10-17T13:09:13+00:00"
}
```

- `ok` 由 `readiness.status`（缺失时回退顶层 `status`）推导，而不是 HTTP 状态码；
  Hermes 降级时仍返回 HTTP 200。
- `platforms` / `gateway_state` 中 `{"state": "..."}` / `{"status": "..."}` 会展开为字符串。
- 不返回 Hermes 的配置值、路径、命令、凭据等内部细节。

## 6. 使用示例

```bash
# 平台 JWT
TOKEN="<liumai-jwt>"

curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8000/api/hermes/capabilities

curl -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8000/api/hermes/sessions?limit=20"

curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8000/api/hermes/runs/run_abc123

curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8000/api/hermes/health
```

## 7. 已知边界

- **会话类端点来自 Hermes dashboard REST**（`/api/sessions*`），不在
  OpenAI 兼容 API Server 的文档契约内。纯 API Server 部署可能返回 `404`，此时平台
  按 4xx 原样透传，并在 `detail` 中说明。需要该能力时，确保 `_hermes_url` 指向同时
  提供 dashboard REST 的网关地址。
- dashboard REST 的官方鉴权是 `X-Hermes-Session-Token`（每次 dashboard 启动轮换），
  而本适配层按平台既有 Hermes 服务约定统一使用 `Authorization: Bearer <API Key>`。
  若目标部署的 sessions 端点只认 dashboard token，会得到透传的 `401/403`；此时需要
  在网关侧放开该 key 或改用支持 Bearer 的统一网关。
- `/health/detailed`、`/api/model/options` 是根级路径，不在 `/v1` 下；适配层已统一处理。
- 本模块只读，不提供 stop/steer/approval/job CRUD；这些能力继续使用现有专用路由。
- 没有新增配置项、数据库表或前端改动。
