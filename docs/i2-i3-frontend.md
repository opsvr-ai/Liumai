# I2 / I3 前端 · 知识图谱与巡检建议

> 改动文件：`src/pages/graph.tsx`（新建）、`src/pages/patrol.tsx`（新建）、
> `src/routes.tsx`、`src/components/layout/nav-config.ts`、`docs/i2-i3-frontend.md`（新建）。
> 未改 `src/lib/api.ts`、`src/App.tsx`、后端、表结构或其它 pages/components；
> 未引入新依赖，页面内 fetch 显式携带 `Authorization: Bearer <token>`。

本任务对应并行后端契约（只消费、不修改后端）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/graph/overview?service=&limit=200` | 图谱节点 / 边 / 统计 |
| `GET /api/graph/neighbors?type=&id=&depth=1` | 单击节点的完整一跳邻居 |
| `GET /api/patrol/suggestions?service=&limit=50` | 巡检建议列表与统计 |
| `GET /api/patrol/summary` | 巡检汇总（服务筛选项、生成时间兜底） |

## 1. 路由与导航

- `src/routes.tsx`：在「知识」下新增懒加载路由 `/graph`，在「自动化」下新增
  `/patrol`；两页均通过既有 `Suspense` / `PageLoader` 按需加载。
- `nav-config.ts`：「知识」组新增「知识图谱」（`Network` 图标），「自动化」组新增
  「巡检建议」（`ClipboardList` 图标）；描述与关键词同时用于 ⌘K 命令面板检索。
  不新增权限位，登录用户即可访问。

## 2. `/graph` 知识图谱

### 2.1 布局

1. **页头**：标题、节点/边数量、当前服务筛选；右侧原生 `select` 服务筛选与刷新按钮。
2. **统计卡**（4 列，移动端 2 列）：服务 / 告警 / 根因 / 处置动作，数值优先取
   `stats`，缺失时按节点类型计数回退。
3. **主体双栏**（`lg` 起 `minmax(0,1fr) / 300px`）：
   - 左：SVG 图谱卡。图例浮于左下，缩放 / 重置按钮浮于右上，操作提示浮于左上；
     空数据显示清晰空态（支持清除服务筛选 / 重新加载）。
   - 右：节点详情卡（`lg:sticky`），展示类型、ID、标签、`meta` 摘要与邻居列表。

### 2.2 图谱渲染与布局

- 纯 SVG 自绘，无第三方图库。固定 `viewBox="0 0 960 600"`，宽度自适应。
- **节点类型固定颜色**：服务 `#4f6bf7`、告警 `#ef4444`、根因 `#f59e0b`、
  处置动作 `#10a861`；未知类型按类型名哈希到固定调色板，保证同类型颜色稳定。
- 类型归一化兼容 `services/alerts/causes/actions`、`root_cause` 等别名。
- **布局**：按类型聚类的确定性力导向。节点先按类型锚点 + 黄金角螺旋初始化，
  再执行 140–180 轮斥力 / 边弹簧 / 向心约束；≤200 节点一次 `useMemo` 计算，
  缩放与拖拽不重算。节点半径按 `weight` 映射（6–19px），重叠时白色描边分隔。
- 标签策略：服务节点、选中节点、邻居节点始终显示；节点总数 ≤50 时全部显示，
  避免大图标签遮挡。完整标签在 SVG `<title>` 与右栏中可查。

### 2.3 交互

- **滚轮缩放**：以鼠标位置为锚点，缩放范围 0.35–4；使用原生 `wheel`
  listener（`passive: false`）阻止页面滚动。
- **拖拽平移**：空白处按住拖拽；`pointerdown` 位移 <4px 视为点击空白，清除选中。
- **点击节点**：立即用本地边高亮一跳邻居（其余节点/边降透明度），同时请求
  `GET /api/graph/neighbors` 补全邻居列表；请求失败时保留本地直连邻居并提示。
- **右侧邻居列表**：显示颜色点、标签、边类型（`caused_by/affected_by/...` 中文化）；
  点击当前视图内的邻居可继续跳转选中；视图外邻居置灰禁用。支持「清除选择」。
- **类型图例开关**：点击图例隐藏/显示对应类型（隐藏项删除线 + 降透明度）；
  全部隐藏时给出「显示全部类型」恢复入口。切换服务时清除选择并重置视图。
- 键盘可达：节点为 `role="button"` + `tabIndex=0`，Enter / Space 选中。

### 2.4 请求、空态与错误态

- 请求携带 `Authorization: Bearer <localStorage.liumai_token>`；401 清理登录态并跳
  `/login`；响应非 2xx 时优先展示 FastAPI `detail`。
- 加载态：统计卡 + 图谱 + 右栏骨架屏；刷新按钮显示旋转与「更新中…」。
- 静默刷新失败保留上次成功数据，顶部显示错误条 + 重试；首次加载失败显示整页错误卡，
  并提示确认 `/api/graph/overview` 已部署。空数据显示「暂无图谱数据」及原因说明。

## 3. `/patrol` 巡检建议

### 3.1 布局

1. **页头**：标题、生成时间（`generated_at` 优先，`summary.generated_at` 兜底）、
   「页面可见时每 60 秒自动刷新」说明；右侧服务筛选 + 刷新按钮。
2. **统计卡**（4 列）：总数 / 高 / 中 / 低。优先使用建议接口的 `stats`，
   缺失或无法识别键名时按当前 `items` 计数回退。
3. **建议卡列表**，按严重级别（高→中→低）、置信度降序排列。每张卡包含：
   - 严重级别徽标（高危 / 中危 / 低危）、服务、右上「忽略」；
   - 标题、原因；
   - 证据 chips（超长省略，`title` 展示全文）；
   - 置信度进度条 + 百分比（兼容 0–1 与 0–100 两种返回）；
   - 「建议动作」高亮块；
   - 关联会话 `#id`，点击跳转 `/rca?s=<id>`。
4. **已忽略区**（仅本地）：折叠展示被忽略建议，支持逐条恢复 / 全部恢复。

### 3.2 忽略与刷新

- localStorage 键 `liumai_patrol_ignored`，存储被忽略建议的完整快照（而非仅 id），
  因此刷新 / 重新登录后仍可展示并恢复；忽略只影响本机展示，不调用后端。
- 进入页面加载一次；`setInterval` 60s 静默刷新，仅在
  `document.visibilityState === "visible"` 时启动；页面隐藏时停止，重新可见时立即
  刷新并重启计时器。手动刷新不会重置忽略状态。
- 请求竞态用递增序号丢弃过期响应；卸载时通过 `AbortController` 取消在途请求。
- 服务筛选变化时重新请求 `suggestions?service=`；服务选项由已加载 items、
  `summary.top_services` 累积合并，筛选后不会丢失其它服务选项。

### 3.3 空态与错误态

- 无建议 / 当前服务无建议 / 全部已忽略分别给出不同文案与恢复 / 刷新入口。
- 首次加载失败显示错误条 + 重试；静默刷新失败保留旧数据并提示「下方为上次成功加载」。
- `summary` 是增强接口：失败不影响建议列表，仅缺少服务选项兜底。

## 4. 验收步骤

### 4.1 类型检查

TS 7 已移除 `baseUrl`，直接对 `tsconfig.app.json` 执行会报 TS5102；按既有约定临时
创建 `.tsconfig.check.json`（与 `tsconfig.app.json` 相同，仅去掉 `baseUrl`、保留
`paths`）后执行：

```bash
node node_modules/typescript/bin/tsc -p .tsconfig.check.json --noEmit
```

验收口径：`src/pages/graph.tsx`、`src/pages/patrol.tsx`、`src/routes.tsx`、
`src/components/layout/nav-config.ts` **0 错误**；仓库既有的
`incident-timeline.tsx` / `datasources.tsx` / `users.tsx` 报错保持原样（共 15 条）。
检查完删除临时配置。

> `vite build` 在本机因缺失 `@rolldown/binding-win32-x64-msvc` 原生依赖无法启动，
> 与本次改动无关，未执行构建产物写入。

本次记录：临时等价 tsconfig 下 `tsc --noEmit` 输出 15 条错误，全部位于改动前既有
文件；本次新增 / 修改文件无错误。构建验证受上述本地依赖限制，未通过。

### 4.2 接口自检（后端实现后）

```bash
BASE=http://localhost:8000
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/graph/overview?limit=200" | jq '{nodes: (.nodes|length), edges: (.edges|length), stats}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/graph/neighbors?type=service&id=<ID>&depth=1" | jq '{node, nodes: (.nodes|length), edges: (.edges|length)}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/patrol/suggestions?limit=50" | jq '{generated_at, items: (.items|length), stats}'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/patrol/summary" | jq '{generated_at, total, top_services}'
```

### 4.3 人工验收

1. 刷新现有 GUI，侧边栏「知识 → 知识图谱」出现并可进入 `/graph`，⌘K 搜索“图谱”可直达。
2. `/graph`：核对 4 张统计卡与图例计数；滚轮缩放以指针为中心、拖拽平移顺滑；
   点击节点后邻居高亮、右侧列表出现；点击邻居可继续跳转；图例可隐藏/恢复类型；
   隐藏全部类型后可一键恢复；切换服务后视图重置且数据更新。
3. 断开后端图谱接口或使用错误 token：确认 401 跳登录、其它错误显示错误卡 / 错误条，
   页面不白屏；无数据时显示空态与清除筛选入口。
4. `/patrol`：「自动化 → 巡检建议」出现；统计卡与列表排序正确；点击关联会话进入
   `/rca?s=<id>`；点击「忽略」后卡片消失、底部「已忽略」计数 +1，展开可恢复，
   刷新页面（60s 自动 / 手动）后忽略状态仍在 localStorage。
5. 切到其它标签页停留 >60s 再回来：不产生后台轮询；返回时立即刷新一次，此后每 60s
   刷新；`generated_at` / 更新提示随之变化。
6. 窄屏（<1024px）：图谱与节点详情上下堆叠、统计卡 2 列；建议卡按钮与证据 chips
   不溢出。

## 5. 已知边界

- `/graph` 的服务筛选选项来自已加载的服务节点；若后端 `limit=200` 截断了某服务节点，
  该服务在首次加载前不会出现在下拉中（加载后按累积结果补充）。
- 邻居接口返回视图外节点时，右栏可见但不可点击跳转（当前图未加载该节点）。
- 「已忽略」是纯本地偏好，不参与后端统计，也不同步多设备。
- 两页的后端接口由并行任务实现；接口未就绪时页面展示错误态，不影响其它路由。
