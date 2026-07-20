# 个人中心 (Profile Center) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal center page where users can view/edit profile info, change password (LOCAL only), browse chat history, set preferences, toggle theme, and see usage stats.

**Architecture:** Left-side vertical tab navigation + right-side content panel. Backend adds `/users/me/*` endpoints for the current user and enriches the login response with `auth_type`. Dark theme uses `.dark` CSS class on `<html>` with a complementary set of design tokens.

**Tech Stack:** FastAPI (Python), React 19 + TypeScript, Tailwind CSS v4, shadcn v4 (base-nova), next-themes, SQLAlchemy + Alembic

## Global Constraints

- LDAP users (`auth_type == "LDAP"`) cannot change their password — hide the tab
- All user-facing text in Chinese (zh-CN)
- Follow existing file/component naming conventions (kebab-case for pages, PascalCase for components)
- Use `--color-*` design tokens defined in `globals.css`, never hardcoded hex values in components (except one-off dark tokens)
- 暗色主题: `.dark` class on `<html>`, toggle via `next-themes` `useTheme()`

---

### Task 1: Backend — Add `avatar_url` to User model

**Files:**
- Modify: `backend/app/models/__init__.py` (User class)

**Interfaces:**
- Produces: `User.avatar_url: Column(String, nullable=True)` — accessible on all User queries

- [ ] **Step 1: Add the column to the User model**

In `backend/app/models/__init__.py`, after the `auth_type` column definition (~line 115):

```python
avatar_url = Column(String(512), nullable=True, default=None)
```

- [ ] **Step 2: Generate and run Alembic migration**

```bash
cd backend && alembic revision --autogenerate -m "add avatar_url to users"
cd backend && alembic upgrade head
```

- [ ] **Step 3: Restart backend to pick up model change**

```bash
docker compose build backend && docker compose up -d backend
```

- [ ] **Step 4: Verify**

```bash
docker compose exec backend python -c "from app.models import User; print('avatar_url' in User.__table__.columns)"
# Expected: True
```

---

### Task 2: Backend — `GET /users/me` and `PUT /users/me` endpoints

**Files:**
- Modify: `backend/app/routes/users.py`

**Interfaces:**
- Produces: `GET /api/users/me → UserProfileOut(id, username, role, auth_type, team_id, avatar_url, created_at)`
- Produces: `PUT /api/users/me { avatar_url } → UserProfileOut`
- Consumes: `User.avatar_url` from Task 1

- [ ] **Step 1: Add `UserProfileOut` schema and `UserProfileUpdate` schema**

At the top of `backend/app/routes/users.py`, after existing schemas:

```python
class UserProfileOut(BaseModel):
    id: int
    username: str
    role: str
    auth_type: str
    team_id: int
    avatar_url: str | None = None
    created_at: str | None = None
    model_config = {"from_attributes": True}

class UserProfileUpdate(BaseModel):
    avatar_url: str | None = None
```

- [ ] **Step 2: Add `GET /users/me` endpoint**

```python
@router.get("/me", response_model=UserProfileOut)
async def get_my_profile(
    user: User = Depends(get_current_user),
) -> UserProfileOut:
    return UserProfileOut(
        id=user.id,
        username=user.username,
        role=user.role.value,
        auth_type=user.auth_type.value,
        team_id=user.team_id,
        avatar_url=user.avatar_url,
        created_at=user.created_at.isoformat() if user.created_at else None,
    )
```

- [ ] **Step 3: Add `PUT /users/me` endpoint**

```python
@router.put("/me", response_model=UserProfileOut)
async def update_my_profile(
    body: UserProfileUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> UserProfileOut:
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url
    await db.flush()
    await db.refresh(user)
    return UserProfileOut(
        id=user.id,
        username=user.username,
        role=user.role.value,
        auth_type=user.auth_type.value,
        team_id=user.team_id,
        avatar_url=user.avatar_url,
        created_at=user.created_at.isoformat() if user.created_at else None,
    )
```

- [ ] **Step 4: Verify with curl**

```bash
# Get token first
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:8000/api/users/me -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# Expected: { "id": 1, "username": "admin", "role": "ADMIN", "auth_type": "LOCAL", ... }
```

---

### Task 3: Backend — Return `auth_type` in login response

**Files:**
- Modify: `backend/app/routes/auth.py`

**Interfaces:**
- Produces: `POST /api/auth/login → { token, username, role, auth_type }`
- Produces: `POST /api/auth/setup → { token, username, role, auth_type }`

- [ ] **Step 1: Add `auth_type` to `LoginResponse`**

In `backend/app/routes/auth.py`, find the `LoginResponse` class and add:

```python
class LoginResponse(BaseModel):
    token: str
    username: str
    role: str
    auth_type: str  # NEW
```

- [ ] **Step 2: Populate `auth_type` in the login endpoint**

Find the login endpoint (~line 180) where `LoginResponse` is returned, add `auth_type`:

```python
return LoginResponse(
    token=token,
    username=user.username,
    role=user.role.value,
    auth_type=user.auth_type.value,  # NEW
)
```

- [ ] **Step 3: Populate `auth_type` in the setup endpoint**

Same change in the setup endpoint where `LoginResponse` is returned.

- [ ] **Step 4: Verify**

```bash
curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | python3 -m json.tool
# Expected: shows "auth_type": "LOCAL" or "LDAP"
```

---

### Task 4: Backend — Own sessions list + delete + usage stats

**Files:**
- Modify: `backend/app/routes/users.py`

**Interfaces:**
- Produces: `GET /api/users/me/sessions → list[ChatSessionOut]` (paginated)
- Produces: `DELETE /api/users/me/sessions/{session_id} → { ok: true }`
- Produces: `GET /api/users/me/stats → { total_sessions, total_messages, total_tokens, ... }`

- [ ] **Step 1: Add sessions list endpoint**

```python
@router.get("/me/sessions")
async def list_my_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """List the current user's chat sessions."""
    from app.models import ChatSession as ChatSessionModel
    offset = (page - 1) * page_size
    total_q = await db.execute(
        select(func.count()).select_from(ChatSessionModel).where(
            ChatSessionModel.user_id == user.id
        )
    )
    total = total_q.scalar_one()
    rows = await db.execute(
        select(ChatSessionModel)
        .where(ChatSessionModel.user_id == user.id)
        .order_by(ChatSessionModel.updated_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    sessions = rows.scalars().all()
    return {
        "items": [
            {
                "id": s.id, "title": s.title,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in sessions
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }
```

- [ ] **Step 2: Add session delete endpoint**

```python
@router.delete("/me/sessions/{session_id}")
async def delete_my_session(
    session_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Delete one of the current user's chat sessions."""
    from app.models import ChatSession as ChatSessionModel, ChatMessage as ChatMessageModel
    row = await db.execute(
        select(ChatSessionModel).where(
            ChatSessionModel.id == session_id,
            ChatSessionModel.user_id == user.id,
        )
    )
    session = row.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    # Delete messages first (cascade)
    await db.execute(
        delete(ChatMessageModel).where(ChatMessageModel.session_id == session_id)
    )
    await db.delete(session)
    await db.flush()
    return {"ok": True}
```

- [ ] **Step 3: Add usage stats endpoint**

```python
@router.get("/me/stats")
async def get_my_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
):
    """Return usage statistics for the current user."""
    from app.models import ChatSession as ChatSessionModel, ChatMessage as ChatMessageModel
    sessions_q = await db.execute(
        select(func.count()).select_from(ChatSessionModel).where(
            ChatSessionModel.user_id == user.id
        )
    )
    total_sessions = sessions_q.scalar_one()

    messages_q = await db.execute(
        select(func.count()).select_from(ChatMessageModel).join(
            ChatSessionModel, ChatMessageModel.session_id == ChatSessionModel.id
        ).where(ChatSessionModel.user_id == user.id)
    )
    total_messages = messages_q.scalar_one()

    return {
        "total_sessions": total_sessions,
        "total_messages": total_messages,
    }
```

- [ ] **Step 4: Add missing imports at top of `users.py`**

```python
from sqlalchemy import func, delete
from fastapi import Query
```

- [ ] **Step 5: Verify**

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:8000/api/users/me/sessions -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
curl -s http://localhost:8000/api/users/me/stats -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

---

### Task 5: Frontend — Store `auth_type` in AuthContext

**Files:**
- Modify: `src/components/auth/auth-context.tsx`

**Interfaces:**
- Produces: `AuthState.authType: string | null`
- Consumes: `POST /api/auth/login` now returns `auth_type`

- [ ] **Step 1: Add `authType` to `AuthState` interface**

At the top of the file, add to the `AuthState` interface:

```typescript
authType: string | null;
```

- [ ] **Step 2: Initialize `authType` from localStorage**

Add after existing localStorage reads:

```typescript
const storedAuthType = localStorage.getItem("liumai_auth_type");
```

In `useState` initializer, add:

```typescript
const [authType, setAuthType] = useState<string | null>(storedAuthType);
```

- [ ] **Step 3: Store `auth_type` in login/setup handlers**

In `login()` function, after parsing the response:

```typescript
localStorage.setItem("liumai_auth_type", data.auth_type || "");
setAuthType(data.auth_type || null);
```

Same in `setup()` function.

- [ ] **Step 4: Clear `auth_type` on logout**

In `logout()` function, add:

```typescript
localStorage.removeItem("liumai_auth_type");
setAuthType(null);
```

- [ ] **Step 5: Update `AuthContext.Provider` value**

Add `authType` to the context value object.

- [ ] **Step 6: Update types in `src/lib/api.ts`**

Find the `LoginResponse` type and add:

```typescript
auth_type?: string;
```

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit
# Expected: no errors
```

---

### Task 6: Frontend — API client methods for profile

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `profileApi.getMe()`, `profileApi.updateMe()`, `profileApi.getMySessions()`, `profileApi.deleteMySession()`, `profileApi.getMyStats()`

- [ ] **Step 1: Add `ProfileData` type and API methods**

After the existing user API section (~line 451), add:

```typescript
export interface ProfileData {
  id: number;
  username: string;
  role: string;
  auth_type: string;
  team_id: number;
  avatar_url: string | null;
  created_at: string | null;
}

export interface SessionItem {
  id: number;
  title: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface UserStats {
  total_sessions: number;
  total_messages: number;
}

export const profileApi = {
  getMe: () => api.get<ProfileData>("/users/me"),
  updateMe: (data: { avatar_url?: string | null }) =>
    api.put<ProfileData>("/users/me", data),
  getMySessions: (page = 1, pageSize = 20) =>
    api.get<{ items: SessionItem[]; total: number; page: number; page_size: number }>(
      `/users/me/sessions?page=${page}&page_size=${pageSize}`
    ),
  deleteMySession: (id: number) =>
    api.del<{ ok: boolean }>(`/users/me/sessions/${id}`),
  getMyStats: () => api.get<UserStats>("/users/me/stats"),
};
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
# Expected: no errors
```

---

### Task 7: Frontend — Profile page

**Files:**
- Create: `src/pages/profile.tsx`

**Interfaces:**
- Consumes: `useAuth()` from AuthContext, `profileApi` from `src/lib/api.ts`
- Consumes: `useTheme()` from `next-themes`
- Produces: `<ProfilePage />` — full page component

- [ ] **Step 1: Create `src/pages/profile.tsx`**

```tsx
import { useState, useEffect, type FC } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/components/auth/auth-context";
import { useTheme } from "next-themes";
import { profileApi, type ProfileData, type SessionItem, type UserStats } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, User, Key, History, Settings, Moon, Sun, BarChart3, Loader2, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type TabKey = "info" | "password" | "sessions" | "prefs" | "theme" | "stats";

const TABS: { key: TabKey; label: string; icon: typeof User; ldapHidden?: boolean }[] = [
  { key: "info", label: "个人信息", icon: User },
  { key: "password", label: "修改密码", icon: Key, ldapHidden: true },
  { key: "sessions", label: "会话历史", icon: History },
  { key: "prefs", label: "偏好设置", icon: Settings },
  { key: "theme", label: "主题风格", icon: Moon },
  { key: "stats", label: "使用统计", icon: BarChart3 },
];

const roleLabel: Record<string, string> = { ADMIN: "管理员", OPERATOR: "运维", VIEWER: "只读" };
const authLabel: Record<string, string> = { LOCAL: "本地", LDAP: "LDAP" };

export default function ProfilePage() {
  const { authType } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("info");

  // Profile
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [avatarUrl, setAvatarUrl] = useState("");

  // Password
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  // Stats
  const [stats, setStats] = useState<UserStats | null>(null);

  const isLdap = authType === "LDAP";
  const visibleTabs = TABS.filter((t) => !t.ldapHidden || !isLdap);

  useEffect(() => {
    profileApi.getMe().then(setProfile).catch(() => {});
    profileApi.getMyStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "sessions") {
      profileApi.getMySessions().then((d) => setSessions(d.items)).catch(() => {});
    }
  }, [tab]);

  const handleAvatarSave = async () => {
    try {
      const updated = await profileApi.updateMe({ avatar_url: avatarUrl || null });
      setProfile(updated);
      toast.success("头像已更新");
    } catch { toast.error("保存失败"); }
  };

  const handlePasswordChange = async () => {
    if (!oldPw || !newPw) { toast.error("请填写完整"); return; }
    if (newPw !== confirmPw) { toast.error("两次新密码不一致"); return; }
    if (newPw.length < 6) { toast.error("新密码至少6位"); return; }
    setPwLoading(true);
    try {
      const token = localStorage.getItem("liumai_token");
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      if (!res.ok) throw new Error();
      toast.success("密码已修改，请重新登录");
      setOldPw(""); setNewPw(""); setConfirmPw("");
    } catch { toast.error("修改失败，请检查旧密码是否正确"); }
    finally { setPwLoading(false); }
  };

  const handleDeleteSession = async (id: number) => {
    try {
      await profileApi.deleteMySession(id);
      setSessions((s) => s.filter((x) => x.id !== id));
      toast.success("会话已删除");
    } catch { toast.error("删除失败"); }
  };

  if (!profile) {
    return <div className="flex items-center justify-center min-h-screen"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="min-h-screen bg-surface-primary">
      {/* Header */}
      <div className="border-b border-border">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghostMuted" size="sm" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> 返回
          </Button>
          <h1 className="text-lg font-semibold text-text-primary">个人中心</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 flex flex-col md:flex-row gap-6">
        {/* Left nav */}
        <nav className="flex md:flex-col gap-0.5 md:w-44 shrink-0 overflow-x-auto">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors whitespace-nowrap",
                tab === t.key
                  ? "bg-interactive-primary/10 text-interactive-primary font-medium"
                  : "text-text-secondary hover:bg-surface-secondary hover:text-text-primary",
              )}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className="flex-1 min-w-0">
          {/* Info tab */}
          {tab === "info" && (
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                <div className="shrink-0 h-20 w-20 rounded-full bg-interactive-primary flex items-center justify-center text-white text-3xl font-bold">
                  {profile.username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-text-primary">{profile.username}</h2>
                  <div className="flex gap-2 mt-1">
                    <Badge variant="default">{roleLabel[profile.role] || profile.role}</Badge>
                    <Badge variant="outline">{authLabel[profile.auth_type] || profile.auth_type}</Badge>
                  </div>
                </div>
              </div>
              <div className="space-y-3 bg-surface-secondary/50 rounded-xl p-4">
                <h3 className="text-sm font-medium text-text-primary">头像 URL</h3>
                <div className="flex gap-2">
                  <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)}
                    placeholder="https://example.com/avatar.png" className="flex-1" />
                  <Button size="sm" onClick={handleAvatarSave}>保存</Button>
                </div>
                <p className="text-xs text-muted-foreground">输入图片 URL 作为头像，留空则使用首字母头像</p>
              </div>
            </div>
          )}

          {/* Password tab */}
          {tab === "password" && (
            <div className="max-w-sm space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">修改密码</h2>
              <Input type="password" placeholder="旧密码" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
              <Input type="password" placeholder="新密码（至少6位）" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              <Input type="password" placeholder="确认新密码" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
              <Button onClick={handlePasswordChange} disabled={pwLoading}>
                {pwLoading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                修改密码
              </Button>
            </div>
          )}

          {/* Sessions tab */}
          {tab === "sessions" && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-text-primary">会话历史</h2>
              {sessions.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无会话记录</p>
              )}
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between bg-surface-secondary/50 rounded-lg px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{s.title}</p>
                    <p className="text-xs text-muted-foreground">{s.updated_at ? new Date(s.updated_at).toLocaleString("zh-CN") : ""}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghostMuted" size="sm" onClick={() => { navigate(`/chat/${s.id}`); }}>
                      打开
                    </Button>
                    <Button variant="ghostMuted" size="sm" onClick={() => handleDeleteSession(s.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-status-active" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Preferences tab */}
          {tab === "prefs" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">偏好设置</h2>
              <p className="text-sm text-muted-foreground">默认聊天模式、通知偏好等设置将在后续版本中提供。</p>
            </div>
          )}

          {/* Theme tab */}
          {tab === "theme" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">主题风格</h2>
              <div className="flex gap-3">
                <button
                  onClick={() => setTheme("light")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-colors",
                    theme === "light" ? "border-interactive-primary bg-interactive-primary/5" : "border-border hover:border-border-default",
                  )}
                >
                  <Sun className="h-5 w-5" />
                  <div className="text-left">
                    <p className="text-sm font-medium text-text-primary">浅色</p>
                    <p className="text-xs text-muted-foreground">明亮清爽</p>
                  </div>
                  {theme === "light" && <Check className="h-4 w-4 text-interactive-primary ml-2" />}
                </button>
                <button
                  onClick={() => setTheme("dark")}
                  className={cn(
                    "flex items-center gap-2 px-4 py-3 rounded-xl border-2 transition-colors",
                    theme === "dark" ? "border-interactive-primary bg-interactive-primary/5" : "border-border hover:border-border-default",
                  )}
                >
                  <Moon className="h-5 w-5" />
                  <div className="text-left">
                    <p className="text-sm font-medium text-text-primary">深色</p>
                    <p className="text-xs text-muted-foreground">护眼舒适</p>
                  </div>
                  {theme === "dark" && <Check className="h-4 w-4 text-interactive-primary ml-2" />}
                </button>
              </div>
            </div>
          )}

          {/* Stats tab */}
          {tab === "stats" && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-text-primary">使用统计</h2>
              {stats && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-surface-secondary/50 rounded-xl p-4">
                    <p className="text-3xl font-bold text-text-primary">{stats.total_sessions}</p>
                    <p className="text-sm text-muted-foreground mt-1">对话次数</p>
                  </div>
                  <div className="bg-surface-secondary/50 rounded-xl p-4">
                    <p className="text-3xl font-bold text-text-primary">{stats.total_messages}</p>
                    <p className="text-sm text-muted-foreground mt-1">消息总数</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route for profile page**

In the app's route configuration (check `src/App.tsx` or `src/main.tsx` for router setup), add:

```tsx
// Find the routes array and add:
{ path: "/profile", element: <ProfilePage /> }
```

And import: `import ProfilePage from "@/pages/profile";`

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
# Expected: no errors
```

---

### Task 8: Frontend — Sidebar profile link

**Files:**
- Modify: `src/components/layout/dashboard-shell.tsx`

**Interfaces:**
- Consumes: `useNavigate()` from react-router-dom

- [ ] **Step 1: Add "个人中心" link to sidebar user dropdown**

In `dashboard-shell.tsx`, find the user menu popover/dropdown section. Add before the "退出登录" button:

```tsx
<button
  onClick={() => { navigate("/profile"); }}
  className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-secondary rounded-lg transition-colors flex items-center gap-2"
>
  <User className="h-4 w-4" />
  个人中心
</button>
```

Make sure `useNavigate` is imported and `const navigate = useNavigate();` is called in the component.

- [ ] **Step 2: Add the route in App.tsx / main.tsx**

Verify the profile route is registered (same route as Task 7 Step 2). If using a different routing setup, adjust accordingly.

- [ ] **Step 3: Verify**

Click the sidebar user avatar → dropdown should show "个人中心" link → click navigates to /profile.

---

### Task 9: Frontend — Dark theme CSS variables

**Files:**
- Modify: `src/styles/globals.css`

- [ ] **Step 1: Add `.dark` CSS variables**

After the existing `:root` block (~line 140), add:

```css
/* ==========================================================================
 * Section 3: Dark Theme
 * ========================================================================== */
.dark {
  --background: #0f0f13;
  --foreground: #e4e4ec;
  --card: #1a1a22;
  --card-foreground: #e4e4ec;
  --popover: #1a1a22;
  --popover-foreground: #e4e4ec;
  --primary: #4f6bf7;
  --primary-foreground: #ffffff;
  --secondary: #1e1e28;
  --secondary-foreground: #e4e4ec;
  --muted: #1e1e28;
  --muted-foreground: #8e8ea0;
  --accent: #1a1a30;
  --accent-foreground: #7c8cf8;
  --destructive: #ef4444;
  --destructive-foreground: #ffffff;
  --success: #10a861;
  --success-foreground: #ffffff;
  --info: #4f6bf7;
  --info-foreground: #ffffff;
  --border: #2a2a36;
  --input: #2a2a36;
  --ring: rgb(79 107 247 / 0.3);

  /* Semantic surface tokens for dark */
  --color-surface-primary: #0f0f13;
  --color-surface-secondary: #1a1a22;
  --color-surface-tertiary: #22222c;
  --color-text-primary: #e4e4ec;
  --color-text-secondary: #9e9eae;
  --color-text-muted: #6e6e80;
  --color-text-inverse: #0f0f13;
  --color-border-default: #2a2a36;
  --color-border-subtle: #1e1e28;
  --color-overlay: rgb(0 0 0 / 0.6);

  color-scheme: dark;
}
```

- [ ] **Step 2: Wrap app with `ThemeProvider`**

In `src/main.tsx` (or the root component), ensure `ThemeProvider` from `next-themes` wraps the app:

```tsx
import { ThemeProvider } from "next-themes";

// In the render tree:
<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
  <App />
</ThemeProvider>
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
docker compose build frontend && docker compose up -d frontend
```
Visit `http://localhost:3000/profile`, click theme → dark, verify all pages render correctly.

---

### Task 10: Wire together + final verification

- [ ] **Step 1: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: Build and deploy**

```bash
docker compose build backend frontend && docker compose up -d
```

- [ ] **Step 3: End-to-end test**

1. Login → sidebar user menu → click "个人中心"
2. Verify info tab shows correct username, role, auth_type badges
3. Verify LDAP user does NOT see "修改密码" tab
4. Test password change (LOCAL user)
5. Test avatar URL save
6. Test session list + delete
7. Test theme toggle (light/dark)
8. Test stats display
9. Navigate back to dashboard → profile should persist

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: user profile center with theme toggle and usage stats"
```
