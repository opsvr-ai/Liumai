# 前端外壳重构说明（架构报告 Top-2）

日期：2026-10-17 · 范围：极简、清晰、可扩展的前端外壳
约束：未改动 `src/lib/api.ts`、`src/hooks/useChat.ts`、`src/pages/rca/**`、`src/pages/alerts.tsx`；未执行任何 docker 命令。

---

## 1. 导航分组（单一事实来源 `src/components/layout/nav-config.ts`）

导航从 App.tsx 的 13 个内联项收敛为 **5 组**，每项含 `icon`、`path`、`keywords`、`description`，并预留 `permission` 权限位。

| 分组 | 页面 | 路径 | permission | 备注 |
| --- | --- | --- | --- | --- |
| 工作台 workspace | 概览 | `/` | authenticated | 首屏页面 |
| 工作台 workspace | 告警中心 | `/alerts` | authenticated | |
| 工作台 workspace | RCA 分析 | `/rca` | authenticated | 完整会话列表/操作仍在此页 |
| 工作台 workspace | 历史记录 | `/history` | authenticated | 只读归档 |
| 对话 assistant | 智能对话 | `/chat` | authenticated | |
| 知识 knowledge | 知识中心 | `/knowledge` | authenticated | |
| 自动化 automation | 技能中心 | `/skills` | authenticated | |
| 自动化 automation | 定时任务 | `/jobs` | admin | |
| 系统 system | 告警规则 | `/rules` | authenticated | |
| 系统 system | 应用系统 | `/systems` | authenticated | |
| 系统 system | 数据源 | `/datasources` | authenticated | |
| 系统 system | 用户管理 | `/users` | admin | |
| 系统 system | 系统设置 | `/settings` | admin | |

- 账户页不出现在侧边栏，但仍可路由与 ⌘K 搜索：`/profile`、`/help`（`SECONDARY_PAGES`）。
- 权限判断集中在 `canAccess()`：`admin` 仅 ADMIN；`operator` 预留给 ADMIN/OPERATOR；`authenticated` 不限。路由守卫（`RequirePermission`）与侧边栏过滤使用同一个函数，避免两侧漂移。
- 折叠能力：
  - 侧边栏整体折叠 240px ↔ 56px，折叠后图标 + 右侧 Tooltip；
  - 每个分组标题可单独折叠/展开；
  - 两种折叠状态分别持久化到 `localStorage`（`liumai_sidebar_collapsed`、`liumai_nav_collapsed_groups`）。
- 激活态由 `isNavItemActive()` 按 pathname 推导，支持 `/rca?s=12` 等查询参数场景；导航改为真实 `<Link>`，URL 与浏览器前进/后退行为不变。

## 2. 路由表与懒加载边界（`src/routes.tsx`）

- `APP_ROUTES` 是唯一路由表，页面全部使用 `React.lazy(() => import(...))`；App.tsx 不再同步 import 任何页面。
- **入口 chunk**：`main.tsx`、`App.tsx`、路由表（仅 lazy 声明）、导航配置、DashboardShell、CommandPalette、AuthProvider、UI 基础组件、globals.css。
- **异步 chunk**：`/`、`/alerts`、`/rca`、`/history`、`/chat`、`/knowledge`、`/skills`、`/jobs`、`/rules`、`/systems`、`/datasources`、`/users`、`/settings`、`/profile`、`/help`、`/login` 各自独立；Vite 对每个 `import()` 生成独立 chunk，首屏只请求当前路由（默认工作台）对应 chunk。
- Suspense 边界两处：
  1. `AppShell` 内 `<Suspense fallback={<PageLoader />}><Outlet /></Suspense>`：页面切换时以骨架屏占位，保留外壳不闪；
  2. `/login` 独立 `<Suspense fallback={<BootLoader />}>`：未登录首屏不加载任何业务页。
- 15 条既有 URL 全部保留（含 `/profile`、`/help`）；未知路径仍重定向 `/`；admin 路由仍由 `permission: "admin"` 守卫。
- 注意：构建环境缺少 Windows 原生 rolldown binding，无法实际产出 chunk 清单（见第 7 节），但 `tsc` 已验证所有动态 import 路径可解析。

## 3. ⌘K 命令面板（`src/components/layout/command-palette.tsx`）

- 无新增依赖：使用项目已有的 `@base-ui/react/dialog` + lucide 图标 + next-themes。
- 打开方式：任意位置 `Ctrl+K` / `Cmd+K` 切换；顶栏“搜索页面与操作 ⌘K”按钮；移动端顶栏搜索图标。
- 搜索范围：5 组导航页 + 账户页（个人中心/帮助中心），匹配标题、分组、描述、路径、英文关键词（如 `rca`、`chat`、`refresh`）；结果按分组显示。
- 快捷动作：
  - 新对话 → `/chat`
  - 刷新当前页 → `window.location.reload()`
  - 切换深色/浅色主题 → `next-themes.setTheme`
- 键盘交互：`↑`/`↓` 循环选择（自动滚动到可视区）、`Enter` 执行、`Esc` 关闭；中文输入法组合输入期间 `Enter` 不触发命令（`isComposing` 守卫）。
- 可访问性：Dialog 提供焦点陷阱/焦点恢复/遮罩点击关闭；输入框 `role=combobox` + `aria-activedescendant`，结果列表 `role=listbox`，选项 `role=option` + `aria-selected`，标题视觉隐藏。
- 动效只用 CSS keyframes（`lm-command-panel-in` / `lm-command-backdrop-in`）并尊重 `prefers-reduced-motion`；关键帧动画的是 `translate`/`scale` 独立属性，不与 Tailwind v4 的 `-translate-x-1/2` 叠加。

## 4. 设计 token 收口与暗色验收点

改动点：

| 位置 | 修复前 | 修复后 |
| --- | --- | --- |
| dashboard 快捷入口/队列卡 | `bg-indigo-50`、`text-indigo-600`、`bg-amber-50`、`text-amber-600`、`bg-emerald-50`、`text-emerald-600` | `bg-interactive-primary/10`、`text-interactive-primary`、`bg-status-investigating/10`、`text-status-investigating`、`bg-status-resolved/10`、`text-status-resolved` |
| dashboard 平台摘要 | `from-amber-50` | `from-status-investigating/5` |
| history 统计卡 | `bg-amber-50`、`text-amber-600` | `bg-status-investigating/10`、`text-status-investigating` |
| shell 侧边栏 | `bg-white`、`text-[#6b6b80]`、`hover:bg-white/60` | `bg-interactive-primary/10` + `text-interactive-primary`、`text-text-secondary`、`hover:bg-surface-tertiary/60` |
| shell 弹层 | `bg-white` | `bg-popover` / `text-popover-foreground` |
| shell 徽标/头像 | `text-white` | `text-text-on-solid`（globals.css 新增 token，暗色下仍为白色） |
| 命令面板/骨架屏 | — | `bg-popover`、`bg-overlay`、`border-border`、`bg-muted`、`text-text-primary` |

暗色验收清单：

1. 顶栏 Moon/Sun 按钮或 ⌘K“切换主题”切换后 `<html class="dark">` 生效，刷新后由 next-themes 保持。
2. 侧边栏：底色 `surface-secondary`、hover `surface-tertiary/60`、选中 `interactive-primary/10` + 左侧竖条在每个分组都清晰可见；折叠态 Tooltip 背景为 `foreground`。
3. 顶栏、用户菜单、命令面板：无白色残留块，文字对比度正常（`text-text-primary/secondary` 与 `muted-foreground`）。
4. 概览：快捷入口与队列卡的状态色块不再出现浅黄/浅绿“白底块”，摘要行 hover 为 `muted/60`。
5. 历史页：统计卡、Badge、行 hover、分页按钮在暗色下可读；链接保持 `interactive-primary`。
6. 命令面板遮罩在暗色下更暗（`--color-overlay` 0.6），面板为 `bg-popover`；骨架屏为 `bg-muted` 可见。
7. 键盘焦点环使用 `--primary`，暗色下可见。
8. 侧边栏/分组折叠状态刷新后保持。

## 5. RCA 会话呈现去重

- **概览**：只请求并展示最近 **3** 条会话摘要，删除与 RCA 页重复的表头 + “操作”列；整行点击跳 `/rca?s=<id>` 查看详情；页头“全部会话 →”跳 `/rca`，卡片底部“浏览历史归档 →”跳 `/history`；队列统计仅代表这 3 条（副标题已标注“最近 N 条”）。
- **历史记录**：保留“历史/归档”语义（全量分页、状态统计），明确为只读视图；不再提供任何分析/重跑操作，唯一的会话动作是“查看 RCA 详情 → `/rca?s=<id>`”；页头提供“前往 RCA 分析”入口。
- RCA 页（未改动）继续承载完整会话列表、详情抽屉、重新分析等全部操作；`/rca?s=<id>` 深链行为保持不变。

## 6. 文件清单

修改：

- `src/App.tsx`（路由表接入、Suspense、权限守卫、命令面板挂载）
- `src/components/layout/dashboard-shell.tsx`（分组折叠、token 化、⌘K 入口、主题切换）
- `src/styles/globals.css`（`--color-text-on-solid`、命令面板动效）
- `src/pages/dashboard.tsx`（token、最近 3 条摘要、去重）
- `src/pages/history/history-page.tsx`（token、只读归档语义、详情跳转）

新增：

- `src/components/layout/nav-config.ts`（5 组导航 + permission + ⌘K 页面源）
- `src/components/layout/command-palette.tsx`（⌘K 面板）
- `src/components/layout/page-loader.tsx`（页面/启动骨架屏）
- `src/routes.tsx`（React.lazy 路由表）

未触碰：`src/lib/api.ts`、`src/hooks/useChat.ts`、`src/pages/rca/**`、`src/pages/alerts.tsx`。

## 7. 验证记录

- 类型检查（因 tsconfig 使用 TS 7 已移除的 `baseUrl`，用临时等价配置检查，检查后已删除临时文件）：
  - 改动范围（App/routes/layout/dashboard/history）：**0 错误**；
  - 仓库剩余错误只在 `src/components/rca/incident-timeline.tsx`、`src/pages/datasources.tsx`、`src/pages/knowledge.tsx`、`src/pages/users.tsx`，均为 baseline 既有错误；本次顺带修掉了 `dashboard-shell.tsx` 原有的 4 处 Tooltip `asChild` 类型错误。
- `npm run build` / `npm run dev` 在本机失败于**改动前即存在**的环境问题：`node_modules` 只安装了 `@rolldown/binding-linux-x64-gnu`，缺少 Windows 原生包 `@rolldown/binding-win32-x64-msvc`，Vite 在加载配置前即报 `Cannot find native binding`。未执行 `npm i`（避免影响其它并行任务），需在 Windows 环境执行 `npm install` 后补做一次构建与视觉验收。
- 人工静态核对：chunk 动态 import 路径、路由可达性、权限过滤、token 类名（无 `bg-white`/hex/`amber-*` 残留于改动处）、命令面板键盘与 IME 分支。
