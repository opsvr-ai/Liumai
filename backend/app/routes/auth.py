"""Authentication endpoints — login, token refresh, password change."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import create_token, get_current_user, hash_password, require_admin, verify_password
from app.models import AuthType, User, UserRole
from app.models.database import get_db_session
from app.services.ldap import authenticate_ldap, test_ldap_connection

router = APIRouter()

# Dummy bcrypt hash used for constant-time comparison when the target user
# does not exist — prevents username enumeration via timing side-channel.
# (bcrypt hash of "dummy_dummy_dummy")
HASH_DUMMY = "$2b$12$HlecgoPIhDe2E1maMkRVIeKxvyl/gJpAPsJKtDfrIGXRwyLphOKjS"


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class LoginResponse(BaseModel):
    token: str
    username: str
    role: str
    auth_type: str


# ── Setup (first-time admin creation) ──────────────────────────────────────

# Password policy — enforced for the initial admin account
MIN_PASSWORD_LENGTH = 10
PASSWORD_POLICY_MSG = (
    "密码不符合安全要求："
    "至少 10 位，且必须包含大写字母、小写字母、数字和特殊字符"
)


def _validate_password_strength(pw: str) -> str | None:
    """Return an error message if *pw* is too weak, or None if it passes."""
    if len(pw) < MIN_PASSWORD_LENGTH:
        return f"密码至少 {MIN_PASSWORD_LENGTH} 位"
    if not any(c.isupper() for c in pw):
        return "密码必须包含至少一个大写字母"
    if not any(c.islower() for c in pw):
        return "密码必须包含至少一个小写字母"
    if not any(c.isdigit() for c in pw):
        return "密码必须包含至少一个数字"
    if not any(c in "!@#$%^&*()_+-=[]{}|;:,.<>?/~`" for c in pw):
        return "密码必须包含至少一个特殊字符 (!@#$% 等)"
    return None


import secrets as _secrets
import string as _string


def _generate_secure_password(length: int = 20) -> str:
    """Generate a cryptographically random password meeting the strength policy."""
    upper = _secrets.choice(_string.ascii_uppercase)
    lower = _secrets.choice(_string.ascii_lowercase)
    digit = _secrets.choice(_string.digits)
    special = _secrets.choice("!@#$%^&*()_+-=[]{}|;:,.<>?")
    remaining = length - 4
    alphabet = _string.ascii_letters + _string.digits + "!@#$%^&*()_+-=[]{}|;:,.<>?"
    rest = "".join(_secrets.choice(alphabet) for _ in range(remaining))
    # Shuffle to avoid predictable positions
    combined = list(upper + lower + digit + special + rest)
    _secrets.SystemRandom().shuffle(combined)
    return "".join(combined)


class SetupStatus(BaseModel):
    needs_setup: bool


class SetupRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=MIN_PASSWORD_LENGTH)
    password_confirm: str = Field(..., min_length=MIN_PASSWORD_LENGTH)


class GeneratedPassword(BaseModel):
    password: str
    length: int


@router.get("/setup/status", response_model=SetupStatus)
async def setup_status(
    db: AsyncSession = Depends(get_db_session),
) -> SetupStatus:
    """Check whether the platform needs initial admin setup."""
    row = await db.execute(select(func.count(User.id)))
    count = row.scalar()
    return SetupStatus(needs_setup=count == 0)


@router.post("/setup", response_model=LoginResponse)
async def setup(
    body: SetupRequest, db: AsyncSession = Depends(get_db_session),
) -> LoginResponse:
    """Create the first platform admin.  Rejected if any users already exist."""
    # Validate password strength
    pw_err = _validate_password_strength(body.password)
    if pw_err:
        raise HTTPException(status_code=400, detail=pw_err)

    # Validate password confirmation
    if body.password != body.password_confirm:
        raise HTTPException(status_code=400, detail="两次输入的密码不一致")

    # Use PostgreSQL advisory lock to prevent race condition when two
    # concurrent setup requests both pass the count==0 check.
    from sqlalchemy import text
    await db.execute(text("SELECT pg_advisory_xact_lock(1001)"))
    row = await db.execute(select(func.count(User.id)))
    if row.scalar() > 0:
        raise HTTPException(status_code=409, detail="系统已初始化")

    if await db.execute(
        select(User).where(User.username == body.username)
    ).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="用户名已存在")

    # Ensure default team exists (needed for FK constraint)
    from app.models import Team
    team = await db.get(Team, 1)
    if team is None:
        team = Team(id=1, name="Default Team")
        db.add(team)
        await db.flush()

    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
        role=UserRole.ADMIN,
        team_id=team.id,
        auth_type=AuthType.LOCAL,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return LoginResponse(
        token=create_token(user), username=user.username, role=user.role.value,
        auth_type=user.auth_type.value,
    )


@router.get("/setup/generate-password", response_model=GeneratedPassword)
async def generate_setup_password() -> GeneratedPassword:
    """Return a cryptographically strong random password meeting the policy.

    Only available when the platform has not yet been initialised.
    """
    pw = _generate_secure_password()
    return GeneratedPassword(password=pw, length=len(pw))


# ── Login ──────────────────────────────────────────────────────────────────
@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest, db: AsyncSession = Depends(get_db_session),
) -> LoginResponse:
    """Authenticate and return a JWT.

    Routing rules:
    - User exists with auth_type=LOCAL → verify local bcrypt password.
    - User does NOT exist, or exists with auth_type=LDAP → try LDAP bind.
      Auto-create on first successful LDAP login (when LDAP_AUTO_CREATE_USER).
    """
    # 1. Look up by username
    row = await db.execute(select(User).where(User.username == body.username))
    user: User | None = row.scalar_one_or_none()

    # 2. LOCAL auth — platform administrator
    if user and user.auth_type == AuthType.LOCAL:
        if not user.password_hash or not verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        return LoginResponse(
            token=create_token(user), username=user.username, role=user.role.value,
            auth_type=user.auth_type.value,
        )

    # 3. LDAP auth — enterprise users
    from app.services.ldap import _ldap_enabled, _ldap_auto_create_user

    # Mitigate timing side-channel: always run bcrypt against a dummy hash when
    # the user does NOT exist, so response time does not leak valid usernames.
    if user is None:
        verify_password(body.password, HASH_DUMMY)

    if _ldap_enabled:
        ldap_user = await authenticate_ldap(body.username, body.password)
        if ldap_user:
            if user is None:
                if _ldap_auto_create_user:
                    # Ensure default team exists
                    from app.models import Team
                    team_row = await db.get(Team, 1)
                    if team_row is None:
                        team_row = Team(id=1, name="Default Team")
                        db.add(team_row)
                        await db.flush()
                    default_team = team_row.id
                    user = User(
                        username=ldap_user.username,
                        role=UserRole.OPERATOR,
                        team_id=default_team,
                        auth_type=AuthType.LDAP,
                    )
                    db.add(user)
                    await db.flush()
                    await db.refresh(user)
                else:
                    raise HTTPException(status_code=401, detail="用户名或密码错误")
            return LoginResponse(
                token=create_token(user), username=user.username, role=user.role.value,
                auth_type=user.auth_type.value,
            )

    # 4. Neither local nor LDAP matched
    raise HTTPException(status_code=401, detail="用户名或密码错误")


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6)


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db_session),
) -> Response:
    """Change the authenticated user's password (LOCAL users only)."""
    if user.auth_type != AuthType.LOCAL:
        raise HTTPException(status_code=403, detail="域账号用户请通过 LDAP 修改密码")
    if not user.password_hash or not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码错误")
    user.password_hash = hash_password(body.new_password)
    await db.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class LdapStatus(BaseModel):
    enabled: bool
    ok: bool
    message: str


class LdapConfig(BaseModel):
    """All LDAP configuration fields exposed to the admin UI."""
    enabled: bool = False
    server: str = "ldap://localhost:389"
    base_dn: str = "dc=example,dc=com"
    user_filter: str = "(uid={username})"
    bind_dn: str = ""
    bind_password: str = ""
    username_attr: str = "uid"
    auto_create_user: bool = True


@router.get("/ldap-status", response_model=LdapStatus)
async def ldap_status(
    _admin: User = Depends(get_current_user),
) -> LdapStatus:
    """Test LDAP connectivity (admin only)."""
    ok, msg = await test_ldap_connection()
    from app.services.ldap import _ldap_enabled
    return LdapStatus(enabled=_ldap_enabled, ok=ok, message=msg)


@router.get("/ldap-config", response_model=LdapConfig)
async def get_ldap_config(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LdapConfig:
    """Return current LDAP configuration (from DB, falling back to env vars)."""
    from app.models import SystemConfig

    rows = await db.execute(select(SystemConfig))
    cfg: dict[str, str] = {r.key: r.value for r in rows.scalars()}

    def _get(key: str, default: str = "") -> str:
        return cfg.get(key, default)

    return LdapConfig(
        enabled=_get("ldap_enabled", "false") == "true",
        server=_get("ldap_server", "ldap://localhost:389"),
        base_dn=_get("ldap_base_dn", "dc=example,dc=com"),
        user_filter=_get("ldap_user_filter", "(uid={username})"),
        bind_dn=_get("ldap_bind_dn", ""),
        bind_password="",  # Never return the actual password
        username_attr=_get("ldap_username_attr", "uid"),
        auto_create_user=_get("ldap_auto_create_user", "true") == "true",
    )


@router.put("/ldap-config", response_model=LdapConfig)
async def save_ldap_config(
    body: LdapConfig,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LdapConfig:
    """Save LDAP configuration to the database. Changes take effect immediately."""
    from app.models import SystemConfig

    entries: dict[str, str] = {
        "ldap_enabled": "true" if body.enabled else "false",
        "ldap_server": body.server,
        "ldap_base_dn": body.base_dn,
        "ldap_user_filter": body.user_filter,
        "ldap_bind_dn": body.bind_dn,
        "ldap_username_attr": body.username_attr,
        "ldap_auto_create_user": "true" if body.auto_create_user else "false",
    }

    # Only update password if one was provided (non-empty)
    if body.bind_password and body.bind_password.strip():
        entries["ldap_bind_password"] = body.bind_password.strip()

    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))

    await db.flush()

    # Reload the LDAP config into the running process
    from app.services.ldap import reload_ldap_config
    reload_ldap_config(entries)

    # Mask password in response
    body.bind_password = ""
    return body


# ── Helpers ────────────────────────────────────────────────────────────────


def _mask_key(key: str) -> str:
    """Mask an API key for safe display: ``sk-1a...f9a``."""
    if not key or len(key) < 8:
        return key
    return f"{key[:4]}...{key[-3:]}"


# ── Hermes config ──────────────────────────────────────────────────────────

class HermesConfigOut(BaseModel):
    url: str = "http://host.docker.internal:8642/v1"
    api_key: str = ""


@router.get("/hermes-config", response_model=HermesConfigOut)
async def get_hermes_config(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> HermesConfigOut:
    """Return Hermes Gateway configuration (DB first, env vars as fallback)."""
    from app.config import settings as s
    from app.models import SystemConfig

    rows = await db.execute(select(SystemConfig))
    cfg: dict[str, str] = {r.key: r.value for r in rows.scalars()}
    raw_key = cfg.get("hermes_api_key") or s.HERMES_API_KEY or ""
    return HermesConfigOut(
        url=cfg.get("hermes_url") or s.HERMES_GATEWAY_URL,
        api_key=_mask_key(raw_key),
    )


@router.put("/hermes-config", response_model=HermesConfigOut)
async def save_hermes_config(
    body: HermesConfigOut,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> HermesConfigOut:
    """Save Hermes Gateway configuration. Changes take effect for new connections."""
    from app.models import SystemConfig

    entries = {
        "hermes_url": body.url,
        "hermes_api_key": body.api_key,
    }
    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))

    await db.flush()

    from app.services.hermes import reload_hermes_config
    reload_hermes_config(entries)

    return body


class HermesTestResult(BaseModel):
    ok: bool
    message: str


@router.post("/hermes-test", response_model=HermesTestResult)
async def test_hermes_connection(
    _admin: User = Depends(require_admin),
) -> HermesTestResult:
    """Test Hermes connectivity via its GET /health/detailed endpoint."""
    from app.services.hermes import _hermes_url, _hermes_api_key

    import httpx
    url = f"{_hermes_url.rstrip('/')}/health/detailed"
    headers: dict[str, str] = {}
    if _hermes_api_key:
        headers["Authorization"] = f"Bearer {_hermes_api_key}"

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code < 500:
            detail = ""
            try:
                body = resp.json()
                detail = f" — {json.dumps(body, ensure_ascii=False)}"
            except Exception:
                detail = ""
            return HermesTestResult(ok=True, message=f"Hermes 服务正常 (HTTP {resp.status_code}){detail}")
        else:
            return HermesTestResult(ok=False, message=f"Hermes 返回 {resp.status_code}: {resp.text[:200]}")
    except httpx.ConnectError:
        return HermesTestResult(ok=False, message="无法连接到 Hermes 服务 — 请检查地址和网络")
    except httpx.TimeoutException:
        return HermesTestResult(ok=False, message="连接 Hermes 超时 — 请检查网络延迟")
    except Exception as exc:
        return HermesTestResult(ok=False, message=f"连接失败: {exc}")


# ── LLM model config (platform-internal use) ────────────────────────────────

class LlmConfigOut(BaseModel):
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    welcome_prompt: str = ""


@router.get("/llm-config", response_model=LlmConfigOut)
async def get_llm_config(
    _admin: User = Depends(require_admin),
) -> LlmConfigOut:
    """Get the configured platform LLM settings."""
    from app.models import SystemConfig
    from app.models.database import async_session_factory
    async with async_session_factory() as s:
        rows = await s.execute(
            select(SystemConfig).where(SystemConfig.key.in_(["llm_base_url", "llm_api_key", "llm_model"]))
        )
        cfg = {r.key: r.value for r in rows.scalars()}
    raw_key = cfg.get("llm_api_key", "")
    return LlmConfigOut(
        base_url=cfg.get("llm_base_url", ""),
        api_key=_mask_key(raw_key),
        model=cfg.get("llm_model", ""),
    )


@router.put("/llm-config", response_model=LlmConfigOut)
async def save_llm_config(
    body: LlmConfigOut,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> LlmConfigOut:
    """Save platform LLM settings."""
    from app.models import SystemConfig
    entries = {"llm_base_url": body.base_url, "llm_api_key": body.api_key, "llm_model": body.model, "welcome_prompt": body.welcome_prompt}
    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))
    await db.flush()
    return body


# ── Welcome message generation ──────────────────────────────────────────────

class WelcomeRequest(BaseModel):
    username: str


@router.post("/generate-welcome")
async def generate_welcome(
    body: WelcomeRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """Generate a personalised welcome message using the configured LLM."""
    from app.models import SystemConfig
    from app.models.database import async_session_factory
    import httpx

    # Load config
    async with async_session_factory() as s:
        rows = await s.execute(
            select(SystemConfig).where(SystemConfig.key.in_([
                "llm_base_url", "llm_api_key", "llm_model", "welcome_prompt",
            ]))
        )
        cfg = {r.key: r.value for r in rows.scalars()}

    base_url = cfg.get("llm_base_url", "").strip()
    api_key = cfg.get("llm_api_key", "").strip()
    model = cfg.get("llm_model", "").strip()

    if not base_url or not model:
        return {"text": (
            "你好！我是六脉智能运维助手。\n\n"
            "我可以帮你：\n"
            "• 实时监控系统指标与告警\n"
            "• 追踪故障根因，定位问题源头\n"
            "• 分析历史数据，发现潜在风险\n"
            "• 协调应急响应，推荐处置方案\n\n"
            "随时向我提问，让我们一起保障系统稳定运行。"
        ).replace("\n", " ")}  # single-line for typewriter; newlines preserved via spaces

    prompt = cfg.get("welcome_prompt", "").strip()
    if not prompt:
        prompt = (
            "你是六脉（Liumai）AIOps 智能运维平台的 AI 助手。"
            "请为用户 {username} 生成一段热情、专业的欢迎语（80-120字），"
            "介绍你能提供的核心能力：实时监控与告警分析、故障根因定位（RCA）、"
            "历史数据洞察、应急协作调度、以及智能问答。"
            "语气自信而亲和，让用户感到你是一个可靠的队友。"
            "只返回欢迎语正文，不要加引号或前缀。"
        )

    # Use the authenticated user's own username (ignore request body)
    system_prompt = prompt.replace("{username}", user.username)

    try:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        base = base_url.rstrip("/")
        url = f"{base}/chat/completions" if not base.endswith("/v1") else f"{base}/chat/completions"

        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            resp = await client.post(
                url,
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": "你好"},
                    ],
                    "max_tokens": 60,
                    "temperature": 0.8,
                },
                headers=headers,
            )
        if resp.status_code < 500:
            data = resp.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if text:
                return {"text": text.strip().strip('"').strip("'")}
        return {"text": "可以问我关于系统状态、故障排查、指标分析等问题"}
    except Exception:
        return {"text": "可以问我关于系统状态、故障排查、指标分析等问题"}
