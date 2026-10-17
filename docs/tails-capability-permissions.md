# 能力探测与前端权限门（Tails / 收尾）

> 范围：`backend/app/routes/chat.py`、`src/hooks/usePermissions.ts`、
> `src/components/auth/permission-gate.tsx`、`src/hooks/useChat.ts` 与
> alerts / RCA / rules / knowledge 四个页面。未修改 `App.tsx`、`routes.tsx`、
> `components/layout/**`、`backend/app/routes/incidents.py`。

## 1. 非管理员能力端点

`GET /api/chat/hermes-capabilities`（`app.routes.chat`）

- 鉴权：`Depends(get_current_user)`，**不是** `require_admin`。
- 数据源：`HermesClient().get_capabilities()` → Hermes 的
  `GET /v1/capabilities.features`。
- 返回字段（仅这些，不含 URL / 版本 / 模型 / 健康详情）：

  | 字段 | 含义 |
  | --- | --- |
  | `run_submission` | Runs API 可用（agent 轮次） |
  | `run_stop` | 服务端可真正中断 |
  | `run_steer` | 运行中补充指令 |
  | `run_approval_response` | 工具审批应答 |
  | `tool_progress_events` | 工具进度事件 |
  | `chat_completions_streaming` | 兼容 chat/completions 流 |
  | `session_continuity_header` | 会话续传头名称（字符串或布尔，可为 `null`） |

- 缓存：进程内 60 秒（`_CAPABILITIES_CACHE_TTL_SECONDS`），同时以当前
  `_hermes_url` 作为失效键；管理员切换 Hermes 地址后下一次请求会重新探测。
- 降级：Hermes 未配置 / 不可达 / 返回异常时，六个能力位全部为 `false`，
  `session_continuity_header` 为 `null`，HTTP 仍为 **200**，前端据此隐藏 Runs
  相关控件并回退 `/api/chat/stream`。
- 上游超时 10 秒并 `close()` 客户端，避免半死网关拖住聊天页；探测异常不向
  页面抛 5xx。
- 管理员用的富信息 `GET /api/chat/hermes-info` 保持原样（仍 `require_admin`），
  设置页继续使用。

## 2. `usePermissions()`

`src/hooks/usePermissions.ts`

- 调用一次 `GET /api/auth/permissions`，返回
  `{ permissions: Set<string>, has(perm), role, loading }`。
- 内存缓存 5 分钟，多组件共享同一个快照与同一个在途请求（不会重复打接口）。
- 缓存以 `liumai_token` 为键：同标签页切换账号不会继承上一个用户的权限。
- 失败 / 加载中 → 空集合（保守隐藏），失败只缓存 30 秒，避免短暂网络抖动
  让控件消失五分钟。
- `clearPermissionsCache()` 供测试或显式失效使用。

## 3. `<PermissionGate>`

`src/components/auth/permission-gate.tsx`

```tsx
<PermissionGate perm="rca_terminate" fallback={null}>
  <Button>终止</Button>
</PermissionGate>
```

- 只控制渲染，不替代后端校验（后端路由继续用
  `require_permission(...)` / `require_admin`）。
- 权限未加载或接口失败时 `permissions` 为空，因此子节点不渲染。

## 4. 页面接线

| 页面 | 控件 | 权限位 |
| --- | --- | --- |
| alerts | 自动/人工触发切换、保存策略 | `policy` |
| alerts | 批量触发 / 单条触发 | `trigger_mode` |
| alerts | 批量忽略 / 单条忽略 | `inbox_delete` |
| alerts | 清空垃圾箱、立即清理 | `trash_clear` |
| rca | 终止分析（列表 + 详情） | `rca_terminate` |
| rca | 重新分析 | `rca_terminate` |
| rca | 报告库批量导出（MD / HTML） | `report_export` |
| rca | 根因库确认根因 / 标记误报 | `kb_annotate` |
| rules | 新建 / 编辑 / 删除 / 启停 / 保存 | `policy`（权限表无 rule 专用位，`auth.py` 中有 `policy`，故未回退 `kb_edit`） |
| knowledge | 勾选、批量删除、重新入库 / 重试 | `kb_edit` |
| knowledge | 知识蒸馏候选批准 / 拒绝（标注） | `kb_annotate` |

说明：

- 上传文档、Webhook 管理仍沿用原有 `isAdmin` 判断（本次任务未要求改动）。
- alerts 中 Webhook 令牌管理仍为 `isAdmin`。

## 5. `useChat` 能力探测

- 删除对 `/api/chat/hermes-info` 的依赖（设置页仍保留）。
- 挂载时调用 `GET /api/chat/hermes-capabilities`，映射为
  `{runs, stop, steer, approval}`。
- 成功：按服务端返回设置；失败 / 非 2xx：四项全部置 `false`，`sendMessage`
  自动走 `/api/chat/stream`，停止 / 插话 / 审批控件不出现。
- `configureRunCapabilities()` 仍保留，供 ChatPanel 或测试覆盖。

## 6. 校验

- `python -m py_compile backend/app/routes/chat.py` → 通过。
- 直接导入 `app.routes.chat` 确认路由存在：
  `('/hermes-capabilities', ['GET'])`。
- 以假 Hermes 客户端驱动端点：首次探测 + 二次命中缓存只上游调用一次；
  未配置时六位全 `false` 且无上游调用。
- 前端 TypeScript：仓库自带 `tsconfig.app.json` 在本地 TypeScript 7 下因
  `baseUrl` 已移除而无法直接执行；用等价临时 tsconfig（仅将 `paths` 改为
  绝对映射）检查 `src`，本次改动文件无新增错误。既有错误集中在
  `incident-timeline.tsx` / `datasources.tsx` / `users.tsx`，与本次改动无关。

## 7. 已知遗留 / 后续建议

1. `src/components/chat/ChatPanel.tsx` 仍在挂载时调用管理员专用的
   `/api/chat/hermes-info`。普通用户会继续产生一次 403（虽然 `useChat` 已不再
   依赖它）；其 `catch` 会把 steer/approval 置为 false，可能覆盖新端点的探测
   结果。该文件不在本次写入范围，建议后续把 ChatPanel 的探测改为新端点（或
   直接删除，交由 `useChat` 负责）。
2. `backend/app/routes/rules.py` 的写接口仍为 `require_admin`，而前端已按
   `policy` 隐藏；当前角色矩阵里二者等价（仅 ADMIN 拥有 `policy`），若将来把
   `policy` 授予 OPERATOR，需要同步把后端改为 `require_permission(PERM_POLICY)`。
3. RCA 导出接口（`/reports/export`、`/report/download`）后端仍只要求登录；
   本次按需求只在前端按 `report_export` 隐藏批量导出按钮，未改后端。
4. `incidents.tsx` 也有自己的 `rca_terminate` 探测逻辑，不在本次写入范围，
   后续可统一迁移到 `usePermissions()`。
