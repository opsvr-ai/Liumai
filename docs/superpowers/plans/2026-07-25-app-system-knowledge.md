# 应用系统知识 — 平台端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在平台上构建应用系统知识的采集入口和轻量索引层，通过触发 Hermes `app-system-onboarding` 技能实现 AI 交互式访谈，平台侧仅存索引 + 关联，知识内容全在 Hermes mem0。

**Architecture:** 平台新增 `/systems` 页面（卡片列表 + 详情 + 新建入口），新建时通过 SSE 对话触发 Hermes 访谈技能，访谈完成后写入 `app_systems` 索引 + `app_system_resources` 关联表。不存储档案内容。

**Tech Stack:** FastAPI (Python) + React (TypeScript) + PostgreSQL (SQLAlchemy async) + SSE streaming

## Global Constraints

- 平台不存储系统档案内容，内容全在 Hermes mem0
- 平台 `app_systems` 仅存索引字段：id, name, tier, status, description
- API 认证：列表/详情需登录，创建/更新/删除需 admin
- 前端路由 `/systems`，导航栏放在「告警规则」和「数据源」之间
- 遵循现有代码模式：Pydantic v2 `model_validate`, SQLAlchemy async, React hooks + shadcn/ui

---

## File Structure

```
Create:
  src/pages/systems.tsx           — 系统卡片列表 + 详情 + 新建入口
  src/pages/systems/              — (备用拆分目录，本期不强求)

Modify:
  backend/migrations/init.sql     — 新增 app_systems + app_system_resources 表
  backend/app/models/__init__.py  — 新增 AppSystem + AppSystemResource SQLAlchemy 模型
  backend/app/routes/systems.py   — 新建路由文件 (CRUD + 资源关联)
  backend/app/main.py             — 注册 systems 路由
  src/lib/api.ts                  — 新增 systemApi + AppSystem 类型
  src/App.tsx                     — 新增 /systems 路由 + 侧边栏导航项
```

---

### Task 1: 数据库表 + init.sql

**Files:**
- Modify: `backend/migrations/init.sql`

- [ ] **Step 1: 在 init.sql 末尾添加两张新表**

在文件末尾追加：

```sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- Application systems — lightweight index for Hermes mem0-backed system profiles
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_systems (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL UNIQUE,
    tier        VARCHAR(10)  NOT NULL DEFAULT 'L2',
    status      VARCHAR(20)  NOT NULL DEFAULT 'active',
    description VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_system_resources (
    id            SERIAL PRIMARY KEY,
    system_id     INTEGER NOT NULL REFERENCES app_systems(id) ON DELETE CASCADE,
    resource_type VARCHAR(30) NOT NULL,
    resource_id   INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(system_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_asr_system_id ON app_system_resources(system_id);
CREATE INDEX IF NOT EXISTS idx_asr_type_id ON app_system_resources(resource_type, resource_id);
```

- [ ] **Step 2: 验证 SQL 语法**

```bash
docker exec liumai-postgres psql -U liumai -d liumai -c "
CREATE TABLE IF NOT EXISTS app_systems (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL UNIQUE,
    tier        VARCHAR(10)  NOT NULL DEFAULT 'L2',
    status      VARCHAR(20)  NOT NULL DEFAULT 'active',
    description VARCHAR(500),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS app_system_resources (
    id            SERIAL PRIMARY KEY,
    system_id     INTEGER NOT NULL REFERENCES app_systems(id) ON DELETE CASCADE,
    resource_type VARCHAR(30) NOT NULL,
    resource_id   INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(system_id, resource_type, resource_id)
);
"
```

Expected: `CREATE TABLE` (no errors)

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/init.sql
git commit -m "feat: add app_systems + app_system_resources tables to init.sql

Platform-side lightweight index for the AI agent cognition layer.
Knowledge content lives in Hermes mem0; these tables provide system
directory and resource association only.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: SQLAlchemy 模型

**Files:**
- Modify: `backend/app/models/__init__.py`

**Consumes:** Task 1 (tables exist in DB)

**Produces:**
- `AppSystem` — SQLAlchemy model
- `AppSystemResource` — SQLAlchemy model

- [ ] **Step 1: 在 models/__init__.py 末尾添加两个模型类**

在文件末尾追加：

```python
# ═══════════════════════════════════════════════════════════════════════════════
# Application systems — lightweight index (content lives in Hermes mem0)
# ═══════════════════════════════════════════════════════════════════════════════


class AppSystem(Base):
    __tablename__ = "app_systems"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    tier: Mapped[str] = mapped_column(String(10), default="L2", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AppSystemResource(Base):
    __tablename__ = "app_system_resources"

    id: Mapped[int] = mapped_column(primary_key=True)
    system_id: Mapped[int] = mapped_column(ForeignKey("app_systems.id", ondelete="CASCADE"), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(30), nullable=False)
    resource_id: Mapped[int] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("system_id", "resource_type", "resource_id"),
    )
```

- [ ] **Step 2: 重启后端验证导入无报错**

```bash
docker compose restart backend && sleep 3 && docker logs liumai-backend --tail 5
```

Expected: 日志显示正常启动，无 import error

- [ ] **Step 3: Commit**

```bash
git add backend/app/models/__init__.py
git commit -m "feat: add AppSystem + AppSystemResource SQLAlchemy models

Lightweight index models for the agent cognition layer — content
stored in Hermes mem0, platform only holds directory + associations.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Backend API — systems CRUD

**Files:**
- Create: `backend/app/routes/systems.py`
- Modify: `backend/app/main.py`

**Consumes:** Task 2 (AppSystem + AppSystemResource models)

**Produces:**
- `GET /api/systems` — list (with search + tier filter)
- `GET /api/systems/{id}` — detail (with resource associations)
- `POST /api/systems` — create index (admin only)
- `PUT /api/systems/{id}` — update name/tier/status/description (admin only)
- `DELETE /api/systems/{id}` — delete (admin only)
- `SystemOut` Pydantic schema
- `SystemCreate` Pydantic schema
- `SystemUpdate` Pydantic schema

- [ ] **Step 1: 创建 routes/systems.py**

```python
"""Application system profiles — lightweight index backed by Hermes mem0."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth import get_current_user, require_admin
from app.models import AppSystem, AppSystemResource, User
from app.models.database import get_db_session

router = APIRouter()

# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════

VALID_TIERS = {"L0", "L1", "L2"}
VALID_STATUSES = {"active", "inactive", "archived"}


class SystemResourceRef(BaseModel):
    id: int
    resource_type: str
    resource_id: int


class SystemOut(BaseModel):
    id: int
    name: str
    tier: str
    status: str
    description: str | None = None
    resources: list[SystemResourceRef] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class SystemCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    tier: str = Field("L2", pattern="^(L0|L1|L2)$")
    description: str | None = None


class SystemUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    tier: str | None = Field(None, pattern="^(L0|L1|L2)$")
    status: str | None = Field(None, pattern="^(active|inactive|archived)$")
    description: str | None = None


class ResourceAttach(BaseModel):
    resource_type: str = Field(..., min_length=1, max_length=30)
    resource_id: int


# ═══════════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════════


async def _load_resources(db: AsyncSession, system_id: int) -> list[SystemResourceRef]:
    rows = await db.execute(
        select(AppSystemResource).where(AppSystemResource.system_id == system_id)
    )
    return [
        SystemResourceRef(id=r.id, resource_type=r.resource_type, resource_id=r.resource_id)
        for r in rows.scalars()
    ]


async def _system_to_out(db: AsyncSession, sys: AppSystem) -> SystemOut:
    resources = await _load_resources(db, sys.id)
    return SystemOut(
        id=sys.id,
        name=sys.name,
        tier=sys.tier,
        status=sys.status,
        description=sys.description,
        resources=resources,
        created_at=sys.created_at,
        updated_at=sys.updated_at,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("", response_model=list[SystemOut])
async def list_systems(
    search: str | None = Query(None),
    tier: str | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[SystemOut]:
    """List application systems with optional search and tier filter."""
    q = select(AppSystem).order_by(AppSystem.tier.asc(), AppSystem.name.asc())

    if search:
        q = q.where(AppSystem.name.ilike(f"%{search}%"))
    if tier:
        q = q.where(AppSystem.tier == tier)

    rows = (await db.execute(q)).scalars().all()
    return [await _system_to_out(db, s) for s in rows]


@router.get("/{system_id}", response_model=SystemOut)
async def get_system(
    system_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SystemOut:
    """Get a single system with its resource associations."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")
    return await _system_to_out(db, sys)


@router.post("", response_model=SystemOut, status_code=201)
async def create_system(
    body: SystemCreate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> SystemOut:
    """Create a new application system index record (after onboarding interview)."""
    # Check uniqueness
    existing = await db.execute(select(AppSystem).where(AppSystem.name == body.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="同名系统已存在")

    sys = AppSystem(name=body.name, tier=body.tier, description=body.description)
    db.add(sys)
    await db.flush()
    await db.refresh(sys)
    logger.info("AppSystem created: id={} name={!r} tier={!r}", sys.id, sys.name, sys.tier)
    return await _system_to_out(db, sys)


@router.put("/{system_id}", response_model=SystemOut)
async def update_system(
    system_id: int,
    body: SystemUpdate,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> SystemOut:
    """Update system metadata (name, tier, status, description)."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")

    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="没有提供要更新的字段")

    for key, val in update_data.items():
        setattr(sys, key, val)

    await db.flush()
    await db.refresh(sys)
    return await _system_to_out(db, sys)


@router.delete("/{system_id}")
async def delete_system(
    system_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete a system and its resource associations."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")
    await db.delete(sys)
    await db.flush()
    logger.info("AppSystem deleted: id={}", system_id)
    return Response(status_code=204)
```

- [ ] **Step 2: 添加资源关联端点**

在上面的文件 `delete_system` 之后追加：

```python

# ═══════════════════════════════════════════════════════════════════════════════
# Resource associations
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/{system_id}/resources", response_model=list[SystemResourceRef])
async def list_system_resources(
    system_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[SystemResourceRef]:
    """List resources associated with a system."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")
    return await _load_resources(db, system_id)


@router.post("/{system_id}/resources", response_model=SystemResourceRef, status_code=201)
async def attach_resource(
    system_id: int,
    body: ResourceAttach,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> SystemResourceRef:
    """Associate a resource (alert rule, data source, etc.) with a system."""
    sys = await db.get(AppSystem, system_id)
    if not sys:
        raise HTTPException(status_code=404, detail="系统不存在")

    rel = AppSystemResource(
        system_id=system_id,
        resource_type=body.resource_type,
        resource_id=body.resource_id,
    )
    db.add(rel)
    await db.flush()
    await db.refresh(rel)
    return SystemResourceRef(id=rel.id, resource_type=rel.resource_type, resource_id=rel.resource_id)


@router.delete("/{system_id}/resources/{resource_id}")
async def detach_resource(
    system_id: int,
    resource_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Remove a resource association."""
    rel = await db.get(AppSystemResource, resource_id)
    if not rel or rel.system_id != system_id:
        raise HTTPException(status_code=404, detail="关联不存在")
    await db.delete(rel)
    await db.flush()
    return Response(status_code=204)
```

- [ ] **Step 3: 注册路由到 main.py**

在 `backend/app/main.py` 的路由注册区添加：

找到现有的路由注册区（在 `from app.routes import datasources` 等 import 行附近），添加：

```python
from app.routes import systems as systems_routes
```

然后在 `app.include_router(...)` 区域，添加在合适位置（按功能分组）：

```python
app.include_router(systems_routes.router, prefix="/api/systems", tags=["systems"])
```

- [ ] **Step 4: 重启后端并测试**

```bash
docker compose restart backend && sleep 3

# Test list (empty)
TOKEN=$(curl -s -X POST http://localhost:8642/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123456"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s http://localhost:8642/api/systems -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: `[]` (空数组)

```bash
# Test create
curl -s -X POST http://localhost:8642/api/systems \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"测试系统","tier":"L1","description":"测试"}' | python3 -m json.tool
```

Expected: 返回创建的 system 对象，包含 id, name, tier, resources: []

```bash
# Test delete
curl -s -X DELETE http://localhost:8642/api/systems/1 \
  -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}"
```

Expected: 204

- [ ] **Step 5: Commit**

```bash
git add backend/app/routes/systems.py backend/app/main.py
git commit -m "feat: add /api/systems CRUD + resource association endpoints

- GET/POST /api/systems — list (search+tier filter) and create
- GET/PUT/DELETE /api/systems/{id} — read, update, delete
- GET/POST/DELETE /api/systems/{id}/resources — resource association
- Admin-only for mutations; all authenticated users can read

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Frontend API client

**Files:**
- Modify: `src/lib/api.ts`

**Consumes:** Task 3 (backend endpoints up)
**Produces:** `systemApi` object + `AppSystem` / `AppSystemResource` types

- [ ] **Step 1: 在 api.ts 中添加类型和 API 对象**

在 `dataSourceApi` 对象结束之后（`};` 之后）添加：

```typescript
/* ── Application Systems ──────────────────────────── */

export interface AppSystemResource {
  id: number;
  resource_type: string;
  resource_id: number;
}

export interface AppSystem {
  id: number;
  name: string;
  tier: "L0" | "L1" | "L2";
  status: "active" | "inactive" | "archived";
  description?: string | null;
  resources: AppSystemResource[];
  created_at?: string | null;
  updated_at?: string | null;
}

export const systemApi = {
  list(params?: { search?: string; tier?: string }) {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.tier) qs.set("tier", params.tier);
    const q = qs.toString();
    return request<AppSystem[]>("GET", `/systems${q ? `?${q}` : ""}`);
  },

  get(id: number) {
    return request<AppSystem>("GET", `/systems/${id}`);
  },

  create(data: { name: string; tier?: string; description?: string }) {
    return request<AppSystem>("POST", "/systems", data);
  },

  update(id: number, data: { name?: string; tier?: string; status?: string; description?: string }) {
    return request<AppSystem>("PUT", `/systems/${id}`, data);
  },

  delete(id: number) {
    return request<void>("DELETE", `/systems/${id}`);
  },

  resources: {
    list(systemId: number) {
      return request<AppSystemResource[]>("GET", `/systems/${systemId}/resources`);
    },

    attach(systemId: number, resourceType: string, resourceId: number) {
      return request<AppSystemResource>("POST", `/systems/${systemId}/resources`, {
        resource_type: resourceType,
        resource_id: resourceId,
      });
    },

    detach(systemId: number, resourceId: number) {
      return request<void>("DELETE", `/systems/${systemId}/resources/${resourceId}`);
    },
  },
};
```

- [ ] **Step 2: TypeScript 编译检查**

```bash
npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: 无新增类型错误（可能有旧的 unrelated 错误）

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add systemApi client + AppSystem types

TypeScript types and API methods for the /api/systems endpoints.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Frontend — 系统页面

**Files:**
- Create: `src/pages/systems.tsx`
- Modify: `src/App.tsx`

**Consumes:** Task 4 (systemApi in api.ts)

- [ ] **Step 1: 创建 systems.tsx — 页面骨架**

```tsx
/** Application systems — agent cognition layer backed by Hermes mem0. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, Search, Trash2, Pencil, Layers, RefreshCw,
  Database, Shield, BookOpen, Activity, X, Link2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { systemApi, type AppSystem } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/auth/auth-context";

const TIER_META: Record<string, { label: string; className: string }> = {
  L0: { label: "L0 · 核心", className: "bg-red-100 text-red-700 border-red-200" },
  L1: { label: "L1 · 重要", className: "bg-orange-100 text-orange-700 border-orange-200" },
  L2: { label: "L2 · 一般", className: "bg-gray-100 text-gray-600 border-gray-200" },
};

const RESOURCE_TYPE_LABELS: Record<string, { label: string; icon: typeof Shield }> = {
  alert_rule: { label: "告警规则", icon: Shield },
  data_source: { label: "数据源", icon: Database },
  knowledge_doc: { label: "知识文档", icon: BookOpen },
  rca_session: { label: "RCA", icon: Activity },
};

export default function SystemsPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [systems, setSystems] = useState<AppSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [detail, setDetail] = useState<AppSystem | null>(null);

  /* Create / Edit dialog */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AppSystem | null>(null);
  const [form, setForm] = useState({ name: "", tier: "L2", description: "" });
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    const p: Record<string, string | undefined> = {};
    if (search) p.search = search;
    if (tierFilter !== "all") p.tier = tierFilter;
    systemApi.list(p).then(setSystems).catch(() => toast.error("加载失败")).finally(() => setLoading(false));
  }, [search, tierFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  function openCreate() {
    setEditing(null);
    setForm({ name: "", tier: "L2", description: "" });
    setDialogOpen(true);
  }

  function openEdit(s: AppSystem) {
    setEditing(s);
    setForm({ name: s.name, tier: s.tier, description: s.description ?? "" });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("请输入系统名称"); return; }
    setSaving(true);
    try {
      if (editing) {
        await systemApi.update(editing.id, { name: form.name, tier: form.tier, description: form.description });
        toast.success("已更新");
      } else {
        await systemApi.create({ name: form.name, tier: form.tier, description: form.description });
        toast.success("已创建");
      }
      setDialogOpen(false); refresh();
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setSaving(false); }
  }

  async function handleDelete(s: AppSystem) {
    if (!confirm(`确定删除 "${s.name}"？此操作不可撤销。`)) return;
    try { await systemApi.delete(s.id); toast.success("已删除"); if (detail?.id === s.id) setDetail(null); refresh(); }
    catch { toast.error("删除失败"); }
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">应用系统</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            管理智能体对应用系统的认知，用于 RCA 和故障分析
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghostMuted" size="icon-sm" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          {isAdmin && (
            <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新建系统档案</Button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-7" placeholder="搜索系统…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-xs"
          value={tierFilter}
          onChange={e => setTierFilter(e.target.value)}
        >
          <option value="all">全部层级</option>
          <option value="L0">L0 核心</option>
          <option value="L1">L1 重要</option>
          <option value="L2">L2 一般</option>
        </select>
      </div>

      {/* Content: list + detail split */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* System cards */}
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-20 bg-surface-secondary animate-pulse rounded-lg" />
            ))}</div>
          ) : systems.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
              {isAdmin ? (
                <>
                  <Layers className="h-10 w-10 mx-auto mb-2 text-muted-foreground/40" />
                  <p>还没有应用系统</p>
                  <p className="text-xs mt-1">点击「新建系统档案」开始交互式访谈，让智能体了解你的系统</p>
                </>
              ) : (
                <p>暂无应用系统</p>
              )}
            </CardContent></Card>
          ) : (
            systems.map(s => {
              const t = TIER_META[s.tier] ?? TIER_META.L2;
              return (
                <Card
                  key={s.id}
                  className={cn("cursor-pointer hover:border-interactive-primary/50 transition-colors", detail?.id === s.id && "border-interactive-primary/70 ring-1 ring-interactive-primary/20")}
                  onClick={() => setDetail(s)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold truncate">{s.name}</h3>
                          <Badge variant="outline" className={cn("text-[10px] px-1.5", t.className)}>{t.label}</Badge>
                          {s.status !== "active" && (
                            <Badge variant="secondary" className="text-[10px]">{s.status === "archived" ? "已归档" : "停用"}</Badge>
                          )}
                        </div>
                        {s.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                          <span>{s.resources.length} 个关联</span>
                          {s.updated_at && <span>更新于 {new Date(s.updated_at).toLocaleDateString()}</span>}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Detail panel */}
        <Card><CardContent className="p-4">
          {!detail ? (
            <p className="text-sm text-muted-foreground py-10 text-center">选择系统查看详情</p>
          ) : (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm">{detail.name}</h3>
                    <Badge variant="outline" className={cn("text-[10px]", TIER_META[detail.tier]?.className)}>
                      {TIER_META[detail.tier]?.label ?? detail.tier}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    创建于 {detail.created_at ? new Date(detail.created_at).toLocaleDateString() : "-"}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button variant="ghostMuted" size="icon-sm" onClick={() => openEdit(detail)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghostMuted" size="icon-sm" onClick={() => handleDelete(detail)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                  </div>
                )}
              </div>

              {detail.description && (
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground mb-1">描述</p>
                  <p className="text-xs">{detail.description}</p>
                </div>
              )}

              {/* Resource associations */}
              <div>
                <p className="text-[11px] font-medium text-muted-foreground mb-2">关联资源</p>
                {detail.resources.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无关联</p>
                ) : (
                  <div className="space-y-1">
                    {detail.resources.map(r => {
                      const meta = RESOURCE_TYPE_LABELS[r.resource_type] ?? { label: r.resource_type, icon: Link2 };
                      const Icon = meta.icon;
                      return (
                        <div key={r.id} className="flex items-center gap-2 text-xs bg-surface-secondary rounded px-2 py-1">
                          <Icon className="h-3 w-3 text-muted-foreground" />
                          <span>{meta.label}</span>
                          <span className="text-muted-foreground font-mono">#{r.resource_id}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent></Card>
      </div>

      {/* Create / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>{editing ? "编辑系统" : "新建系统档案"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "修改系统的基本元信息"
              : "创建应用系统索引记录。系统知识内容将通过 Hermes 访谈技能采集。"}
          </DialogDescription>
          <div className="space-y-3 mt-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">系统名称</label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="例如: 订单系统" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">业务层级</label>
              <select
                className="w-full h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={form.tier}
                onChange={e => setForm({ ...form, tier: e.target.value })}
              >
                <option value="L0">L0 · 核心链路</option>
                <option value="L1">L1 · 重要服务</option>
                <option value="L2">L2 · 一般服务</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">描述</label>
              <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="简要说明系统职责" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghostMuted" onClick={() => setDialogOpen(false)}>取消</Button>
              <Button onClick={handleSave} disabled={saving}>{saving ? "保存中..." : "保存"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: 在 App.tsx 中注册路由和导航**

在 `src/App.tsx` 中添加 import：

```tsx
import SystemsPage from "@/pages/systems";
```

在 sidebar items 数组中添加导航项（放在 rules 和 datasources 之间）：

找到这段：
```tsx
{ id: "rules", label: "告警规则", ... },
{ id: "datasources", label: "数据源", ... },
```

改为：
```tsx
{ id: "rules", label: "告警规则", icon: <Shield className="h-4 w-4" />, isActive: location.pathname.startsWith("/rules"), onClick: () => navigate("/rules") },
{ id: "systems", label: "应用系统", icon: <Layers className="h-4 w-4" />, isActive: location.pathname.startsWith("/systems"), onClick: () => navigate("/systems") },
{ id: "datasources", label: "数据源", icon: <Database className="h-4 w-4" />, isActive: location.pathname.startsWith("/datasources"), onClick: () => navigate("/datasources") },
```

需要确保 `Layers` 在 lucide-react import 中存在。检查 App.tsx 的 import 行，追加 `Layers`：

```tsx
import { Activity, BookOpen, Clock, Database, HelpCircle, History, Home, Layers, MessageCircle, Settings, Shield, Users, Wrench } from "lucide-react";
```

在 Routes 中添加：

```tsx
<Route path="/systems" element={<SystemsPage />} />
```

- [ ] **Step 3: 前端构建验证**

```bash
cd /mnt/e/dev/Liumai && npx vite build 2>&1 | tail -10
```

Expected: Build succeeded (no errors)

- [ ] **Step 4: 重启前端验证页面**

```bash
docker compose restart frontend && sleep 5 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/systems
```

Expected: 200（SPA 路由返回 index.html）

- [ ] **Step 5: Commit**

```bash
git add src/pages/systems.tsx src/App.tsx
git commit -m "feat: add /systems page with card list, detail panel, and CRUD dialog

New page for managing application system profiles. Displays system
cards with tier badges, resource associations, and inline editing.
Navigation added between alert rules and data sources.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 端到端验证 + 推送

- [ ] **Step 1: 全栈部署确认**

```bash
docker compose restart backend frontend && sleep 5
```

- [ ] **Step 2: API 端到端测试**

```bash
TOKEN=$(curl -s -X POST http://localhost:8642/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123456"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Create
curl -s -X POST http://localhost:8642/api/systems \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"订单系统","tier":"L0","description":"承接用户下单到履约全流程"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Created: id={d[\"id\"]} name={d[\"name\"]}')"

# List
curl -s http://localhost:8642/api/systems -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(f'List: {len(json.load(sys.stdin))} system(s)')"

# Add resource association
curl -s -X POST http://localhost:8642/api/systems/1/resources \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resource_type":"alert_rule","resource_id":1}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Attached: {d[\"resource_type\"]}#{d[\"resource_id\"]}')"

# Get detail with resources
curl -s http://localhost:8642/api/systems/1 -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Detail: {d[\"name\"]} with {len(d[\"resources\"])} resource(s)')"
```

Expected: 所有请求正常返回

- [ ] **Step 3: 前端页面可访问**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/systems
```

Expected: 200

- [ ] **Step 4: 清理测试数据并推送**

```bash
# 删除测试系统
TOKEN=$(curl -s -X POST http://localhost:8642/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123456"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s -X DELETE http://localhost:8642/api/systems/1 -H "Authorization: Bearer $TOKEN" -w "\n%{http_code}"

# 推送
git push
```

---

## 完成状态

平台端实施完成后，以下能力就绪：

- [x] `app_systems` + `app_system_resources` 表
- [x] `/api/systems` CRUD + 关联管理 8 个端点
- [x] `/systems` 前端页面（卡片列表 + 详情 + 创建/编辑弹窗）
- [x] 侧边栏导航入口

**待 Hermes 侧配合：**
- `app-system-onboarding` 技能（访谈 → mem0 写入）
- `app-system-update` 技能（增量更新）
- mem0 记忆写入端点确认

此时可在平台创建系统索引 → 触发 Hermes 访谈 → 完成知识采集闭环。
