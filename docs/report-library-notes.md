# 报告库页面化 + 批量导出 ZIP（实现备注）

## 1. 后端契约

### GET /api/rca/reports（保持兼容，仅新增字段）
- 查询参数：`page`、`page_size`（1–100）、`search`（根因/服务/分类模糊搜索）、`service`。
- 返回 `PaginatedResponse`：`{items, total, page, page_size}`，按 `created_at` 倒序。
- `items[]` 仍为 `RcaReportOut` 字段（id、session_id、service_name、alert_count、category、
  root_cause、confidence、evidence、impacted_services、recommended_actions、created_at），
  本次**新增可选 `top3: string[]`**（与单报告接口同一 `_session_top3()` 派生逻辑，列表接口
  用一次批量查询取回会话 JSONB，最多一次额外查询）。团队隔离沿用 `RcaReport.team_id`。

### POST /api/rca/reports/export（新增）
- Body：`{"session_ids": [1..200], "format": "md" | "html"}`。
  - `session_ids`：Pydantic `min_length=1, max_length=200`，去重后按请求顺序打包；**超过 200 条 → 422**。
  - `format`：`Literal["md","html"]`，默认 `md`；非法值 → 422。
- 处理逻辑（`backend/app/routes/rca.py: export_reports`）：
  1. 只查 `RcaSession.team_id == current_user.team_id` 的会话；跨团队/不存在的 ID 一律按“不存在”跳过，
     不泄露存在性。
  2. 无报告的会话跳过（“该会话尚无报告”）。
  3. 复用 `_render_report_markdown` / `_render_report_html`，单文件渲染异常会被 catch、
     记录 warning 并跳过，不影响整包。
  4. 时间线用 `_timeline_summaries_bulk`（按会话批量查询，语义与 `_timeline_summary` 一致：
     最近 30 条非心跳事件、按时间正序；总数含心跳）。
- 响应：
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="liumai-rca-reports-YYYYmmdd-HHMMSS.zip"`
    （时间戳为 Asia/Shanghai，另附 RFC 5987 `filename*`）
  - ZIP 内每个会话一个 `rca-report-{session_id}-{service}.{fmt}`（文件名过滤
    `<>:"/\|?*` 等 Windows 非法字符，空服务名回退 `report`）。
  - 有跳过项时写入 `README.txt`（生成时间、格式、成功/跳过数、逐条跳过原因）。
  - `X-Skipped-Count: <n>` 响应头供前端提示。

### 单报告下载
已有 `GET /api/rca/sessions/{session_id}/report/download?format=md|html`（团队隔离 + 404），
批量导出直接复用其渲染函数，**未新增** `GET /api/rca/reports/{id}/download`，避免重复入口。

## 2. 前端

- `src/lib/api.ts`：`reportApi.exportZip(sessionIds, format)` —— JSON body 传会话 ID，
  `Authorization: Bearer <token>` 走请求头（token 不进 URL）；解析 `Content-Disposition`
  文件名（复用 `_attachmentFilename`），并解析 `X-Skipped-Count`；401 与单报告下载同一套登出逻辑。
- `src/pages/rca/rca-page.tsx` 报告库 tab：
  - 首列复选框 + 表头全选（支持 indeterminate）；行选中态高亮；显示“已选 N 项”。
  - “导出 Markdown / 导出 HTML”按钮：无选择或导出中禁用；成功后 `URL.createObjectURL` 触发下载，
    并按 `skipped` 额外 toast 提示查看 README.txt。
  - 根因列展示 `root_cause` + 第二行 `Top3 · 首条`（`title` 悬浮显示完整 3 条），
    置信度列保持原有百分比展示。
  - 刷新/搜索后清空选择，避免用过期 session_id 导出。

## 3. 验证与已知环境问题

- `python -m py_compile backend/app/routes/rca.py` 通过；`ruff check backend/app/routes/rca.py` 通过。
- 用 fake DB + `TestClient` 冒烟验证导出端点：201 个 ID → 422、非法 format → 422、成功 200 且
  `X-Skipped-Count` / `Content-Disposition` 正确、ZIP 内含 2 份 Markdown + README.txt、
  HTML 变体无 README；另用 fake session/report 验证渲染与文件名字符过滤。
- `npx tsc -p tsconfig.app.json --noEmit` 在当前环境报 `TS5102 baseUrl removed`（TypeScript 7
  与本仓库 `tsconfig.app.json` 的既有冲突，非本次改动）；改用去掉 `baseUrl` 的临时配置全量检查，
  `src/lib/api.ts`、`src/pages/rca/rca-page.tsx` **无类型错误**，其余报错为
  `dashboard-shell.tsx`/`datasources.tsx` 等既有问题。
- `npm run build` 因 `node_modules/rolldown` 缺少平台原生 binding（`MODULE_NOT_FOUND`）失败，
  属本地依赖安装问题，与本次改动无关；未执行任何 docker 命令。
