# E2 知识库体验（入库状态机 / 检索可解释 / 文档管理）实现说明

> 改动范围：`backend/app/routes/knowledge.py`、`src/pages/knowledge.tsx`、`src/lib/api.ts`，外加本说明。
> 未新增依赖，未改数据库结构；未触碰 alerts/rca/App/routes/layout 等其它任务占用的文件。

## 1. 入库状态机

文档沿用现有 `knowledge_documents.status` 字段（不新增列）：

```
pending → ingesting → stored | failed
```

- 新写入统一使用 `ingesting`；历史数据里的 `processing` 在读取时归一为 `ingesting`
  （`DocOut` 的 `field_validator`、状态端点、列表筛选 `status=ingesting` 均兼容
  `processing`）。
- `INGEST` 接口改为后台任务（`asyncio.create_task`）执行，POST 立即返回
  `status="ingesting"`，避免长事务/行锁；进度通过下面的 status 端点轮询。
- 实际入库流程不变：分块（≤8k 字符/块，整篇 ≤30k）调用 Hermes 提炼 JSON
  知识条目，成功后写 `processed_content`，失败写 `error_message`。
- 进程内进度（`_INGEST_PROGRESS`）按分块更新，进程重启即丢失（可接受，符合任务要求）；
  容量上限 512 条，超出时机会式清理终态条目。并发重复入库用 `_INGEST_INFLIGHT`
  拦截，返回 `ok=false, status="ingesting"`。

### 进度阶段（`progress.stage`）

| stage | 含义 | step/total |
| --- | --- | --- |
| `queued` | 已入队/准备中 | 0 / 分块数 |
| `chunking` | 文档已切分 | 0 / 分块数 |
| `extracting` | 正在逐块调用 Hermes | 已完成块数 / 分块数 |
| `storing` | 正在写入知识条目 | 分块数 / 分块数 |
| `done` | 入库完成 | 分块数 / 分块数 |
| `failed` | 入库失败 | 0 / 分块数 |

## 2. 接口契约

### 2.1 `GET /api/knowledge/documents/{id}/status`

权限：登录用户（与文档详情一致）。404：文档不存在。

```json
{
  "status": "ingesting",
  "progress": {
    "stage": "extracting",
    "step": 2,
    "total": 4,
    "message": "正在提炼第 2/4 个片段"
  },
  "error": null,
  "updated_at": "2026-10-17T13:36:06.000000+00:00"
}
```

- `status` 为归一后的状态机值；当进程内有进度记录时优先按 `progress.stage`
  推导（覆盖“已入队、DB 尚未提交”的窗口）。
- 无进程内记录时：`stored→done`、`failed→failed`、`pending→queued`；
  而 `ingesting` 且无心跳，视为进程重启/任务丢失，返回
  `status="failed"`、`stage="failed"`、`message="上次入库被中断（进程内进度已丢失），请重试"`
  （可据此重试，避免永久转圈）。该判断假设后端单 worker（Dockerfile 未指定
  `--workers`）。
- `error` 优先取进度中的错误，其次取 `documents.error_message`。

### 2.2 `GET /api/knowledge/search-explain?question=...`

权限：登录用户。调用 Hermes **一次**，返回可解释结果：

```json
{
  "hit": true,
  "answer": "……（回答正文，截断到 4000 字）",
  "sources": [
    { "title": "MySQL 连接池排查", "doc_id": 12, "score": 0.86 },
    { "title": "模型虚构的来源",   "doc_id": null, "score": null }
  ],
  "confidence": 0.74,
  "latency_ms": 1832
}
```

- **来源匹配基于标题，非向量检索**：`sources[].title` 与本地
  `knowledge_documents.title` 做归一化（去空白 + 小写）精确匹配，再退化为互相包含；
  只匹配 `status='stored'` 的文档，匹配不到时 `doc_id=null`。
- `score` 来自模型自报的 0–1 相关度，可缺省（`null`）；`confidence` 收敛到 0–1。
- Hermes 未配置 / 调用失败时返回 200：`hit=false`、`answer` 给出原因、`sources=[]`、
  `confidence=0`，并仍返回 `latency_ms`。
- 命中统计复用既有口径：仅对回答/来源真正点名的 stored 文档 `hit_count += 1`。
- 原有 `POST /test`、`POST /test-stream` 保持不变。

### 2.3 `POST /api/knowledge/documents/batch-delete`

权限：管理员（与单删一致）。

```json
// request
{ "ids": [3, 7, 9] }
// response
{ "deleted": 2, "requested": 3, "missing": [9] }
```

- 去重后按 id 批量删除；不存在的 id 放入 `missing`，不报错。
- 同时清理对应进程内进度。单删 `DELETE /documents/{id}` 契约未变。

### 2.4 `POST /api/knowledge/documents/{id}/ingest`（行为变化）

- 响应结构与字段不变：`{ok, status, hermes_session_id?, message}`。
- 语义由“同步等待入库完成”改为“入队后立即返回”：成功入队时
  `ok=true, status="ingesting", message="已开始入库，进度可在列表中查看"`，
  `hermes_session_id` 此时为 `null`；重复触发返回
  `ok=false, status="ingesting"`。
- 单文档「重新入库」复用该端点，前端对 stored/failed/pending 都可用。

### 2.5 列表（分页契约保持）

`GET /api/knowledge/documents` 仍返回数组（**不是** `{items,total}`），
参数 `page`/`page_size`/`search`/`status`/`source_type` 不变；
`status=ingesting` 会同时匹配历史 `processing`。

## 3. 前端改动

- 文档列表：状态徽标 + 入库中进度条（stage/步骤/文案），失败行展示错误与「重试」；
  详情面板展示进度、错误、`重新入库/重试` 按钮。
- 轮询：仅对 `ingesting`（含 `processing`）的文档轮询
  `GET /documents/{id}/status`，间隔 3s；页面 `visibilitychange` 隐藏时暂停请求、
  恢复可见立即刷新；列表到达终态后自动停止轮询并重新加载列表。
- 排序/筛选：状态筛选新增「入库中」，新增来源筛选（上传 / Webhook / 蒸馏）。
- 批量删除：每行复选框 + 全选本页，批量操作条内二次确认（“确认删除？此操作不可恢复”），
  调用批量删除接口后清空选择并刷新。
- 分页：保留既有 `page/page_size` 契约，新增上一页/下一页（以“本页是否满 20 条”
  判断是否还有下一页，因为列表接口不返回 total）。
- 命中测试：改为单次调用 `search-explain`；展示命中/未命中、置信度、耗时、答案、
  来源列表（标题、score、匹配到的 `文档 #id` 或“未匹配本地文档”）；
  未命中时展示明确空态与 4 条建议；并注明“来源匹配基于标题，非向量检索”。

## 4. 验收步骤

1. 语法/静态检查
   ```powershell
   cd E:\dev\Liumai
   python -m py_compile backend/app/routes/knowledge.py
   # 前端 TS 7 不支持现有 tsconfig 的 baseUrl，可用临时配置检查：
   # 仅对改动文件运行 tsc，无新增错误
   ```
2. 后端导入与路由注册（无 DB 也可执行）
   ```powershell
   cd E:\dev\Liumai\backend
   $env:JWT_SECRET="test-secret"
   python -c "import app.routes.knowledge as k; print([r.path for r in k.router.routes])"
   # 应包含 /documents/{doc_id}/status、/documents/batch-delete、/search-explain
   ```
3. 入库状态机（需运行中的后端 + Hermes）
   - 上传一份文档 → 列表状态 `pending`；
   - 管理员点「入库」→ POST 立即返回 `ingesting`；列表每 3s 刷新进度条；
   - 完成后状态变 `stored`、轮询自动停止；进度消息显示“入库完成，共 N 条知识条目”。
   - 断网/制造 Hermes 失败 → 状态 `failed`、错误可见、行内「重试」可重新入队；
     再次触发前可用 `GET /documents/{id}/status` 确认 `error` 与 `stage=failed`。
4. 检索可解释
   - 「命中测试」输入一个有答案的问题 → 展示置信度、耗时、来源列表与文档 #id；
   - 输入无关问题 → `hit=false`，展示未命中空态与建议；
   - 直接调用：`GET /api/knowledge/search-explain?question=...`（带 Bearer token），
     校验返回字段与 `latency_ms > 0`。
5. 文档管理
   - 状态/来源筛选可组合；分页上一页/下一页正常，`page_size=20`；
   - 勾选多行 → 批量删除 → 出现二次确认 → 确认后数量减少；
   - 已存储文档详情点「重新入库」→ 再次进入 `ingesting` 并最终 `stored`。
6. 权限/隔离
   - 非管理员看不到上传/入库/删除按钮；直接调用 batch-delete 返回 403（`require_admin` 现状）；
   - 列表/状态/命中测试仍为登录可见，未新增团队过滤（保持现状）。

## 5. 已知限制

- 进度为单进程内存态：进程重启后丢失；Dockerfile 以单 worker 启动，因此
  “DB 为 ingesting 但没有心跳”会被判定为中断并允许重试。若未来改成多 worker，
  轮询落到其它 worker 时可能把正在执行的任务误报为中断，需要改为 Redis/DB 进度。
- 入库任务随事件循环运行；进程退出会中断任务，文档可能停留在 `ingesting`，
  下次打开列表会被 status 端点判定为中断（failed），点「重试」即可恢复。
- 来源→文档关联是标题匹配（非向量检索），标题不一致时 `doc_id` 为 `null`；
  这是设计约束，不是缺陷。
