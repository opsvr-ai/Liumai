# 个人中心 (Profile Center)

**Date**: 2026-07-20 | **Status**: Design approved

## Context

当前平台的用户系统只有登录/登出，没有个人中心页面。侧栏用户菜单只有一个"退出登录"按钮。需要为每个用户提供个人中心，集中管理个人信息、安全设置、偏好和使用统计。

## Layout

左右分栏布局，与平台其他设置页面风格一致：

```
┌──────────────────────────────────────────────┐
│  ← 返回        个人中心                      │
├────────────┬─────────────────────────────────┤
│ 个人信息   │  头像区 + 基本信息卡片            │
│ 修改密码*  │  ─── 使用统计 ───                │
│ 会话历史   │  对话次数 / Token 消耗 / 在线时长  │
│ 偏好设置   │                                  │
│ 主题风格   │  * LDAP 用户不显示修改密码       │
│ 使用统计   │                                   │
└────────────┴─────────────────────────────────┘
```

## Modules

### 1. 个人信息
- **头像**: 支持上传图片，存储为文件或 base64 URL
- **用户名**: 只读展示
- **角色**: 只读 badge（管理员/运维/只读）
- **认证方式**: 只读 badge（本地/LDAP）
- **后端**: User 模型新增 `avatar_url` 列；新增 `GET/PUT /api/users/me` 端点

### 2. 修改密码
- **条件**: 仅 `auth_type == LOCAL` 用户可见
- **表单**: 旧密码 + 新密码 + 确认新密码
- **后端**: 复用 `POST /api/auth/change-password`，需让前端能获取当前用户的 `auth_type`

### 3. 会话历史
- 展示当前用户的所有聊天会话列表（分页）
- 支持删除会话
- **后端**: 复用现有 sessions API，限制为查询当前用户

### 4. 偏好设置
- 默认聊天模式选择（RCA / 知识问答 / 通用）
- **后端**: SystemConfig 或新建 UserPreference 表

### 5. 主题风格
- 亮色/暗色切换 Toggle
- **前端**: 利用已有 `next-themes`，补充 `.dark` CSS 变量到 `globals.css`
- **不涉及后端**

### 6. 使用统计
- 对话总次数
- Token 总消耗
- 在线时长（可选）
- **后端**: 从 ChatSession/ChatMessage 统计计算

## Files to Change

| File | Change |
|------|--------|
| `src/pages/profile.tsx` | **NEW** — profile page with tab navigation |
| `src/styles/globals.css` | Add `.dark` CSS variables for dark theme |
| `backend/app/models/__init__.py` | Add `avatar_url` to User |
| `backend/app/routes/users.py` | Add `GET/PUT /users/me` endpoints |
| `backend/app/routes/auth.py` | Return `auth_type` in login response |
| `src/components/layout/dashboard-shell.tsx` | Add profile entry to sidebar user menu |
| `src/lib/api.ts` | Add profile API client methods |
| `src/components/auth/auth-context.tsx` | Store `auth_type` in AuthState |

## Backend API Additions

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/users/me` | JWT | Get current user profile (incl avatar_url, auth_type) |
| PUT | `/api/users/me` | JWT | Update profile (avatar_url) |
| GET | `/api/users/me/sessions` | JWT | List own chat sessions (paginated) |
| DELETE | `/api/users/me/sessions/{id}` | JWT | Delete own session |
| GET | `/api/users/me/stats` | JWT | Usage statistics |
| POST | `/api/auth/change-password` | JWT | Already exists — no change needed |

## Dark Theme CSS Variables

Add to `globals.css` under `.dark` selector:
- Surfaces invert from light to dark grays
- Text inverts from near-black to near-white
- Status/interactive colors adjust for dark backgrounds
- Shadows become lighter/glow on dark

## Verification

- `npx tsc --noEmit` passes
- `docker compose build && docker compose up -d`
- Login → click user menu → enter profile center
- Edit avatar, verify persistence
- LDAP user: verify change-password tab hidden
- Toggle dark mode, verify all pages render correctly
- Check stats numbers are reasonable
