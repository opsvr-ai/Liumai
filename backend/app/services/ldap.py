"""LDAP / Active Directory authentication service.

Configuration precedence: database (set via admin UI) > environment variables.
When the admin saves config through ``PUT /api/auth/ldap-config``, the database
values are reloaded into this module immediately — no restart required.

Two authentication modes are supported:

* **Search mode** (``bind_dn`` configured): bind as the service account, search
  for the user, then rebind as the user's DN to verify the password.
* **Direct bind mode** (no ``bind_dn``): try the AD-friendly UPN
  (``user@domain``), then the configured DN template, then an anonymous search
  followed by a DN rebind.

Every failure is classified (bad password, unknown user, locked account,
expired password, service unavailable, bad config) so the login endpoint can
return a 503 for infrastructure/config problems instead of a misleading 401.
Passwords and full DNs are never logged or returned.
"""

from __future__ import annotations

import re
import ssl
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from app.config import settings

# ── Runtime LDAP config (can be reloaded at runtime from DB) ─────────────────
# These start as copies of the env-var settings; reload_ldap_config() replaces
# them with DB values once an admin saves config through the UI.

_ldap_enabled: bool = settings.LDAP_ENABLED
_ldap_server: str = settings.LDAP_SERVER
_ldap_base_dn: str = settings.LDAP_BASE_DN
_ldap_user_filter: str = settings.LDAP_USER_FILTER
_ldap_bind_dn: str = settings.LDAP_BIND_DN
_ldap_bind_password: str = settings.LDAP_BIND_PASSWORD
_ldap_username_attr: str = settings.LDAP_USERNAME_ATTR
_ldap_auto_create_user: bool = settings.LDAP_AUTO_CREATE_USER

# Constants
_CONNECT_TIMEOUT = 5  # seconds
_RECEIVE_TIMEOUT = 10  # seconds

# ── Diagnostic vocabulary ───────────────────────────────────────────────────
# ``stage`` values are part of the ``POST /api/auth/ldap-test-user`` contract.
STAGE_SERVICE_BIND = "service_bind"
STAGE_SEARCH = "search"
STAGE_USER_BIND = "user_bind"
STAGE_AUTO_CREATE = "auto_create"

# Failure categories.  The login route maps only the first two to HTTP 503;
# everything else stays a 401 so credentials/account state are not disclosed.
ERR_USER_NOT_FOUND = "user_not_found"
ERR_INVALID_CREDENTIALS = "invalid_credentials"
ERR_ACCOUNT_LOCKED = "account_locked"
ERR_PASSWORD_EXPIRED = "password_expired"
ERR_ACCOUNT_DISABLED = "account_disabled"
ERR_ACCOUNT_EXPIRED = "account_expired"
ERR_SERVICE_UNAVAILABLE = "service_unavailable"
ERR_CONFIG_ERROR = "config_error"
ERR_UNKNOWN = "unknown"

#: Categories that indicate an infrastructure/configuration problem, not a
#: wrong password.  ``routes/auth.py`` turns these into HTTP 503.
LDAP_UNAVAILABLE_ERRORS = frozenset({ERR_SERVICE_UNAVAILABLE, ERR_CONFIG_ERROR})

# RFC 4515 LDAP filter escaping — special characters must be replaced with
# their \xx hex representation to prevent LDAP injection.
_LDAP_ESCAPE_TABLE = str.maketrans({
    "*": "\\2a",
    "(": "\\28",
    ")": "\\29",
    "\\": "\\5c",
    "\x00": "\\00",
})

# AD "AcceptSecurityContext" sub-codes carried in the bind error message.
# https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-adts/...
_AD_SUBCODE_MAP: dict[str, tuple[str, str]] = {
    "525": (ERR_USER_NOT_FOUND, "域用户不存在（AD 子码 525），请确认用户名"),
    "52e": (ERR_INVALID_CREDENTIALS, "用户名或密码错误（AD 子码 52e）"),
    "530": (ERR_INVALID_CREDENTIALS, "该账户不允许在当前时间登录（AD 子码 530）"),
    "531": (ERR_INVALID_CREDENTIALS, "该账户不允许在当前工作站登录（AD 子码 531）"),
    "532": (ERR_PASSWORD_EXPIRED, "域账户密码已过期（AD 子码 532），请先修改密码"),
    "533": (ERR_ACCOUNT_DISABLED, "域账户已被禁用（AD 子码 533）"),
    "701": (ERR_ACCOUNT_EXPIRED, "域账户已过期（AD 子码 701）"),
    "773": (ERR_PASSWORD_EXPIRED, "域账户要求下次登录时修改密码（AD 子码 773）"),
    "775": (ERR_ACCOUNT_LOCKED, "域账户已被锁定（AD 子码 775），请联系域管理员解锁"),
}

#: LDAP result codes that mean "the server / transport is not usable".
_SERVICE_RESULT_CODES = frozenset({"51", "52", "53", "91"})


def _escape_ldap_filter(value: str) -> str:
    """Escape special characters in an LDAP filter value per RFC 4515.

    Prevents LDAP injection attacks through username input.
    """
    return value.translate(_LDAP_ESCAPE_TABLE)


def _escape_dn_value(value: str) -> str:
    """Escape a value inserted into a DN (RFC 4514).

    Filter escaping is *not* valid DN escaping; keep the two separate.
    """
    escaped = (
        value.replace("\\", "\\\\")
        .replace(",", "\\,")
        .replace("+", "\\+")
        .replace('"', '\\"')
        .replace("<", "\\<")
        .replace(">", "\\>")
        .replace(";", "\\;")
        .replace("=", "\\=")
    )
    if escaped[:1] in (" ", "#"):
        escaped = "\\" + escaped
    if escaped.endswith(" "):
        escaped = escaped[:-1] + "\\ "
    return escaped


def _make_server(uri: str) -> Any:
    """Create an ldap3 Server with TLS verification and timeouts."""
    import ldap3
    tls_config = None
    if uri.startswith("ldaps://"):
        tls_config = ldap3.Tls(validate=ssl.CERT_REQUIRED)
    return ldap3.Server(
        uri, get_info=ldap3.ALL, connect_timeout=_CONNECT_TIMEOUT, tls=tls_config,
    )


def reload_ldap_config(db_entries: dict[str, str]) -> None:
    """Reload LDAP config from DB values (called after admin saves config)."""
    global _ldap_enabled, _ldap_server, _ldap_base_dn, _ldap_user_filter
    global _ldap_bind_dn, _ldap_bind_password, _ldap_username_attr, _ldap_auto_create_user

    _ldap_enabled = db_entries.get("ldap_enabled", "false") == "true"
    _ldap_server = db_entries.get("ldap_server", settings.LDAP_SERVER)
    _ldap_base_dn = db_entries.get("ldap_base_dn", settings.LDAP_BASE_DN)
    _ldap_user_filter = db_entries.get("ldap_user_filter", settings.LDAP_USER_FILTER)
    _ldap_bind_dn = db_entries.get("ldap_bind_dn", settings.LDAP_BIND_DN)
    _ldap_bind_password = db_entries.get("ldap_bind_password", settings.LDAP_BIND_PASSWORD)
    _ldap_username_attr = db_entries.get("ldap_username_attr", settings.LDAP_USERNAME_ATTR)
    _ldap_auto_create_user = db_entries.get("ldap_auto_create_user", "true") == "true"
    logger.info("LDAP config reloaded (enabled={})", _ldap_enabled)


@dataclass
class LdapUser:
    """Result of a successful LDAP authentication."""
    username: str
    display_name: str | None = None
    email: str | None = None
    groups: list[str] | None = None


@dataclass
class LdapAuthResult:
    """Detailed outcome of an LDAP authentication attempt.

    ``detail`` is safe for the admin diagnostic endpoint: it never contains the
    password or a full DN.  ``filter_used`` / ``filters_tried`` are returned for
    logs and diagnostics (LDAP filters are not secrets).
    """
    ok: bool = False
    user: LdapUser | None = None
    stage: str = STAGE_SEARCH
    detail: str = ""
    error: str | None = None
    result_code: str | None = None
    exception_type: str | None = None
    filter_used: str | None = None
    filters_tried: list[str] = field(default_factory=list)
    bound_as: str | None = None


@dataclass
class _BindOutcome:
    ok: bool
    category: str | None = None
    detail: str = ""
    result_code: str | None = None
    exception_type: str | None = None


@dataclass
class _SearchOutcome:
    ok: bool
    entry: Any = None
    user_dn: str | None = None
    filter_used: str | None = None
    filters_tried: list[str] = field(default_factory=list)
    category: str | None = None
    detail: str = ""
    result_code: str | None = None
    exception_type: str | None = None


# ── Filter / identity helpers ───────────────────────────────────────────────

def _expand_user_filter(template: str, username: str) -> str | None:
    """Expand a configured filter template.

    Supports all three historical spellings:

    * ``(sAMAccountName={username})``
    * ``(sAMAccountName=%(user)s)``
    * ``(sAMAccountName=%s)``

    Returns ``None`` when the template has no placeholder (misconfiguration)
    or cannot be expanded.
    """
    raw = (template or "").strip()
    if not raw:
        return None
    if "{username}" in raw:
        try:
            return raw.format(username=username)
        except (KeyError, IndexError, ValueError):
            # Other literal braces in the template must not break login.
            return raw.replace("{username}", username)
    if "%(user)s" in raw:
        return raw.replace("%(user)s", username)
    if "%s" in raw:
        try:
            return raw % username
        except (TypeError, ValueError):
            return None
    return None


def _domain_from_base_dn(base_dn: str) -> str:
    """Derive the DNS domain from the DC components of a base DN.

    ``dc=corp,dc=example,dc=com`` → ``corp.example.com``.
    """
    parts: list[str] = []
    for component in (base_dn or "").split(","):
        key, sep, value = component.strip().partition("=")
        if sep and key.strip().lower() == "dc" and value.strip():
            parts.append(value.strip())
    return ".".join(parts)


def _bare_username(username: str) -> str:
    """Return the account name without a DOMAIN\\ or UPN suffix."""
    raw = (username or "").strip()
    if "\\" in raw:
        raw = raw.rsplit("\\", 1)[1]
    if "@" in raw:
        raw = raw.split("@", 1)[0]
    return raw or (username or "").strip()


def _upn_for(username: str, domain: str) -> str | None:
    """Return the userPrincipalName to try for direct bind, if any."""
    raw = (username or "").strip()
    if not raw:
        return None
    if "@" in raw:
        return raw
    if "\\" in raw:
        raw = raw.rsplit("\\", 1)[1]
    if domain:
        return f"{raw}@{domain}"
    return None


def _is_legacy_uid_template(template: str) -> bool:
    """Whether the template is the shipped ``(uid=...)`` default.

    Only this legacy default gets the AD attribute fallback.  A deliberately
    restrictive custom filter (for example one with ``memberOf``) is never
    widened behind the admin's back.
    """
    compact = re.sub(r"\s+", "", (template or "").lower())
    return compact in {
        "(uid={username})",
        "(uid=%(user)s)",
        "(uid=%s)",
    }


def _candidate_filters(
    username: str, template: str, base_dn: str, *,
    allow_ad_fallback: bool = True,
) -> list[str]:
    """Return the ordered filters for a search.

    Starts with the configured filter.  For the legacy ``(uid={username})``
    default (and only for it), a no-result search falls back to AD's
    ``sAMAccountName`` and ``userPrincipalName`` — still scoped to ``base_dn``.
    """
    safe = _escape_ldap_filter(username)
    safe_bare = _escape_ldap_filter(_bare_username(username))
    primary = _expand_user_filter(template, safe)
    filters: list[str] = []
    if primary:
        filters.append(primary)

    if not allow_ad_fallback:
        return filters

    domain = _domain_from_base_dn(base_dn)
    upn = _upn_for(username, domain)
    extras: list[str] = [f"(sAMAccountName={safe_bare})"]
    if upn:
        extras.append(f"(userPrincipalName={_escape_ldap_filter(upn)})")

    seen = {f.strip().lower() for f in filters}
    for candidate in extras:
        if candidate.strip().lower() not in seen:
            filters.append(candidate)
            seen.add(candidate.strip().lower())
    return filters


def _filter_template_valid(template: str) -> bool:
    """A usable template must contain a supported placeholder."""
    return any(token in (template or "") for token in ("{username}", "%(user)s", "%s"))


# ── Result / exception classification ───────────────────────────────────────

def _conn_result(conn: Any) -> tuple[str | None, str, str]:
    """Return (result code, description, message) from an ldap3 connection."""
    result = getattr(conn, "result", None)
    if not isinstance(result, dict):
        return None, "", ""
    raw_code = result.get("result")
    code = str(raw_code) if raw_code is not None else None
    return code, str(result.get("description") or ""), str(result.get("message") or "")


def _ad_subcode(blob: str) -> str | None:
    match = re.search(r"data\s+([0-9a-fA-F]{3})", blob or "")
    return match.group(1).lower() if match else None


def _classify_bind_result(
    result_code: str | None, description: str = "", message: str = "",
) -> tuple[str, str]:
    """Map an LDAP bind result to (category, Chinese detail)."""
    blob = f"{description} {message}".lower()
    subcode = _ad_subcode(blob)
    if subcode and subcode in _AD_SUBCODE_MAP:
        return _AD_SUBCODE_MAP[subcode]

    if result_code == "49" or "invalidcredentials" in blob or "invalid credentials" in blob:
        if "locked" in blob or "lockout" in blob:
            return ERR_ACCOUNT_LOCKED, "域账户已被锁定，请联系域管理员解锁"
        if "expired" in blob:
            return ERR_PASSWORD_EXPIRED, "域账户密码已过期，请先修改密码"
        if "disabled" in blob:
            return ERR_ACCOUNT_DISABLED, "域账户已被禁用"
        return (
            ERR_INVALID_CREDENTIALS,
            "用户名或密码错误（LDAP 返回 invalidCredentials）",
        )
    if result_code == "32" or "nosuchobject" in blob:
        return ERR_USER_NOT_FOUND, "目录中不存在该用户（noSuchObject）"
    if result_code in _SERVICE_RESULT_CODES or any(
        word in blob for word in ("unavailable", "busy", "unwilling", "connecterror")
    ):
        return ERR_SERVICE_UNAVAILABLE, "LDAP 服务不可用或正忙，请稍后重试"
    if result_code == "50" or "insufficientaccess" in blob or "insufficient access" in blob:
        return ERR_CONFIG_ERROR, "LDAP 服务账号权限不足，请检查 Bind DN 的搜索权限"
    if "invalid filter" in blob or "bad search filter" in blob:
        return ERR_CONFIG_ERROR, "LDAP 用户过滤器语法错误，请检查过滤模板"
    return ERR_UNKNOWN, "LDAP 认证失败（未知原因）"


def _classify_exception(exc: Exception) -> tuple[str, str, str | None]:
    """Map a transport/connection exception to (category, detail, code).

    Only the exception *type* and stable result code are surfaced; raw messages
    are never logged because they may contain a full DN.
    """
    name = type(exc).__name__
    blob = str(exc).lower()
    subcode = _ad_subcode(blob)
    if subcode and subcode in _AD_SUBCODE_MAP:
        category, detail = _AD_SUBCODE_MAP[subcode]
        return category, detail, subcode

    result_code: str | None = None
    match = re.search(r"(?:result|code)[^0-9]{0,8}(32|49|50|51|52|53|91)\b", blob)
    if match:
        result_code = match.group(1)

    if "invalidcredentials" in blob or "invalid credentials" in blob or result_code == "49":
        category, detail = _classify_bind_result("49", blob, "")
        return category, detail, result_code or "49"
    if "locked" in blob or "lockout" in blob:
        return ERR_ACCOUNT_LOCKED, "域账户已被锁定，请联系域管理员解锁", result_code
    if "expired" in blob:
        return ERR_PASSWORD_EXPIRED, "域账户密码已过期，请先修改密码", result_code
    if "invalid filter" in blob or "bad search filter" in blob:
        return ERR_CONFIG_ERROR, "LDAP 用户过滤器语法错误，请检查过滤模板", result_code
    if "insufficient" in blob and "access" in blob:
        return ERR_CONFIG_ERROR, "LDAP 服务账号权限不足，请检查 Bind DN 的搜索权限", "50"

    # ldap3 transport errors: LDAPSocketOpenError, LDAPConnectionTimeout,
    # LDAPServerPoolExhaustedError, LDAPUnavailableOperation, etc.
    transport_names = (
        "LDAPSocketOpenError",
        "LDAPConnectionTimeout",
        "LDAPServerPoolExhaustedError",
        "LDAPUnavailableOperation",
        "LDAPResponseTimeoutError",
        "LDAPSessionTerminatedByServerError",
    )
    if name in transport_names or any(
        word in blob
        for word in (
            "timed out",
            "timeout",
            "unavailable",
            "can't contact",
            "cannot contact",
            "connection refused",
            "no route to host",
            "network is unreachable",
            "socket",
        )
    ):
        return (
            ERR_SERVICE_UNAVAILABLE,
            "LDAP 服务不可用（无法连接或超时），请检查服务器地址与网络",
            result_code,
        )
    return ERR_UNKNOWN, "LDAP 认证失败（连接或协议异常）", result_code


# ── LDAP operations ─────────────────────────────────────────────────────────

def _safe_unbind(conn: Any) -> None:
    if conn is None:
        return
    try:
        conn.unbind()
    except Exception:  # noqa: BLE001 — cleanup must never mask the real error
        pass


def _bind_as(ldap3_mod: Any, server: Any, user: str | None, password: str | None) -> tuple[Any, _BindOutcome]:
    """Bind to the server.  Returns (open connection, outcome).

    On success the caller owns the connection and must unbind it.  On failure
    the connection is already closed and the outcome carries a safe diagnosis.
    """
    conn = None
    try:
        conn = ldap3_mod.Connection(
            server,
            user=user,
            password=password,
            auto_bind=False,
            receive_timeout=_RECEIVE_TIMEOUT,
        )
        if bool(conn.bind()):
            return conn, _BindOutcome(ok=True)
        code, description, message = _conn_result(conn)
        category, detail = _classify_bind_result(code, description, message)
        _safe_unbind(conn)
        return None, _BindOutcome(
            ok=False, category=category, detail=detail,
            result_code=code, exception_type=None,
        )
    except Exception as exc:  # noqa: BLE001 — classify all ldap3/socket failures
        _safe_unbind(conn)
        category, detail, code = _classify_exception(exc)
        return None, _BindOutcome(
            ok=False, category=category, detail=detail,
            result_code=code, exception_type=type(exc).__name__,
        )


def _entry_attr(entry: Any, name: str) -> Any:
    """Read an attribute value from an ldap3 Entry without raising."""
    try:
        holder = getattr(entry, name)
    except Exception:  # noqa: BLE001 — ldap3 raises KeyError/AttributeError
        try:
            holder = entry[name]
        except Exception:  # noqa: BLE001
            return None
    value = getattr(holder, "value", holder)
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _entry_groups(entry: Any) -> list[str] | None:
    try:
        holder = getattr(entry, "memberOf")
    except Exception:  # noqa: BLE001
        return None
    value = getattr(holder, "value", holder)
    if value is None:
        return None
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value]
    return [str(value)]


def _search_user(
    ldap3_mod: Any,
    conn: Any,
    username: str,
    base_dn: str,
    template: str,
) -> _SearchOutcome:
    """Search for *username*, falling back to the AD attributes when needed."""
    filters = _candidate_filters(
        username, template, base_dn,
        allow_ad_fallback=_is_legacy_uid_template(template),
    )
    if not filters:
        return _SearchOutcome(
            ok=False,
            category=ERR_CONFIG_ERROR,
            detail=(
                "LDAP 用户过滤器未配置有效占位符（支持 {username} / %(user)s / %s），"
                "无法搜索用户"
            ),
        )

    tried: list[str] = []
    first_error: tuple[str, str, str | None, str | None] | None = None
    for index, filt in enumerate(filters):
        tried.append(filt)
        try:
            conn.search(
                search_base=base_dn,
                search_filter=filt,
                attributes=ldap3_mod.ALL_ATTRIBUTES,
            )
        except Exception as exc:  # noqa: BLE001 — try the next candidate
            category, detail, code = _classify_exception(exc)
            logger.warning(
                "LDAP search failed (filter_index={} category={} result_code={} exc_type={})",
                index, category, code, type(exc).__name__,
            )
            if category == ERR_SERVICE_UNAVAILABLE:
                return _SearchOutcome(
                    ok=False, filters_tried=tried, category=category, detail=detail,
                    result_code=code, exception_type=type(exc).__name__,
                )
            if first_error is None:
                first_error = (category, detail, code, type(exc).__name__)
            continue

        entries = getattr(conn, "entries", None) or []
        if entries:
            entry = entries[0]
            user_dn = str(getattr(entry, "entry_dn", ""))
            if not user_dn:
                continue
            logger.info(
                "LDAP user matched with filter={} (fallback={})",
                filt, index > 0,
            )
            return _SearchOutcome(
                ok=True,
                entry=entry,
                user_dn=user_dn,
                filter_used=filt,
                filters_tried=tried,
            )

    if first_error is not None:
        category, detail, code, exc_type = first_error
        return _SearchOutcome(
            ok=False, filters_tried=tried, category=category, detail=detail,
            result_code=code, exception_type=exc_type,
        )
    return _SearchOutcome(
        ok=False,
        filters_tried=tried,
        category=ERR_USER_NOT_FOUND,
        result_code="filter_no_result",
        detail=(
            f"目录搜索无结果：未找到该用户（已尝试 {len(tried)} 个过滤器）"
            "，请确认用户名或用户过滤器配置"
        ),
    )


def _server_or_failure(ldap3_mod: Any) -> tuple[Any, LdapAuthResult | None]:
    """Create the ldap3 Server, converting bad config into a result."""
    try:
        return _make_server(_ldap_server), None
    except Exception as exc:  # noqa: BLE001 — malformed URI / TLS setup errors
        category, detail, code = _classify_exception(exc)
        if category == ERR_UNKNOWN:
            category = ERR_CONFIG_ERROR
            detail = "LDAP 服务器地址无效或无法初始化，请检查服务器地址配置"
        return None, LdapAuthResult(
            ok=False,
            stage=STAGE_SERVICE_BIND,
            error=category,
            detail=detail,
            result_code=code,
            exception_type=type(exc).__name__,
        )


# ── Authentication modes ────────────────────────────────────────────────────

async def _authenticate_via_search(
    ldap3_mod: Any, username: str, password: str,
) -> LdapAuthResult:
    """Search mode: service bind → search → rebind as the user's DN."""
    if not (_ldap_server or "").strip():
        return LdapAuthResult(
            ok=False, stage=STAGE_SERVICE_BIND, error=ERR_CONFIG_ERROR,
            detail="LDAP 配置错误：服务器地址为空",
        )
    if not (_ldap_base_dn or "").strip():
        return LdapAuthResult(
            ok=False, stage=STAGE_SEARCH, error=ERR_CONFIG_ERROR,
            detail="LDAP 配置错误：Base DN 为空，无法搜索用户",
        )
    if not _filter_template_valid(_ldap_user_filter):
        return LdapAuthResult(
            ok=False, stage=STAGE_SEARCH, error=ERR_CONFIG_ERROR,
            detail=(
                "LDAP 配置错误：用户过滤器缺少占位符（支持 {username} / %(user)s / %s）"
            ),
        )

    server, failure = _server_or_failure(ldap3_mod)
    if failure is not None:
        return failure

    service_conn, bind = _bind_as(
        ldap3_mod, server, _ldap_bind_dn, _ldap_bind_password,
    )
    if not bind.ok:
        stage = STAGE_SERVICE_BIND
        category = bind.category
        detail = bind.detail
        # A failed *service* bind is never the end user's password problem —
        # the admin must fix Bind DN/password or the service-account state.
        if category != ERR_SERVICE_UNAVAILABLE:
            category = ERR_CONFIG_ERROR
            detail = "LDAP 服务账号绑定失败：请检查 Bind DN、Bind Password 及服务账号状态"
        return LdapAuthResult(
            ok=False, stage=stage, error=category, detail=detail,
            result_code=bind.result_code, exception_type=bind.exception_type,
        )

    try:
        search = _search_user(
            ldap3_mod, service_conn, username, _ldap_base_dn, _ldap_user_filter,
        )
    finally:
        _safe_unbind(service_conn)

    if not search.ok:
        # No entry found is a search-stage result; transport trouble is service.
        stage = STAGE_SEARCH
        return LdapAuthResult(
            ok=False,
            stage=stage,
            error=search.category,
            detail=search.detail,
            result_code=search.result_code,
            exception_type=search.exception_type,
            filters_tried=search.filters_tried,
        )

    user_conn, user_bind = _bind_as(ldap3_mod, server, search.user_dn, password)
    if not user_bind.ok:
        return LdapAuthResult(
            ok=False,
            stage=STAGE_USER_BIND,
            error=user_bind.category,
            detail=user_bind.detail,
            result_code=user_bind.result_code,
            exception_type=user_bind.exception_type,
            filter_used=search.filter_used,
            filters_tried=search.filters_tried,
        )
    _safe_unbind(user_conn)

    entry = search.entry
    display_name = _entry_attr(entry, "displayName")
    email = _entry_attr(entry, "mail")
    return LdapAuthResult(
        ok=True,
        user=LdapUser(
            username=username,
            display_name=str(display_name) if display_name is not None else None,
            email=str(email) if email is not None else None,
            groups=_entry_groups(entry),
        ),
        stage=STAGE_USER_BIND,
        detail="LDAP 认证成功（目录搜索 + 用户绑定）",
        filter_used=search.filter_used,
        filters_tried=search.filters_tried,
        bound_as="dn",
    )


async def _authenticate_via_direct_bind(
    ldap3_mod: Any, username: str, password: str,
) -> LdapAuthResult:
    """Direct mode: UPN → configured DN → anonymous search + DN rebind."""
    if not (_ldap_server or "").strip():
        return LdapAuthResult(
            ok=False, stage=STAGE_SERVICE_BIND, error=ERR_CONFIG_ERROR,
            detail="LDAP 配置错误：服务器地址为空",
        )

    server, failure = _server_or_failure(ldap3_mod)
    if failure is not None:
        return failure

    domain = _domain_from_base_dn(_ldap_base_dn)
    attr = (_ldap_username_attr or "uid").strip() or "uid"
    bare = _bare_username(username)
    attempts: list[_BindOutcome] = []
    filters_tried: list[str] = []

    async def _success(detail: str, bound_as: str, filter_used: str | None = None) -> LdapAuthResult:
        return LdapAuthResult(
            ok=True,
            user=LdapUser(username=username),
            stage=STAGE_USER_BIND,
            detail=detail,
            filter_used=filter_used,
            filters_tried=filters_tried,
            bound_as=bound_as,
        )

    # ① AD-recommended UPN bind: user@domain
    upn = _upn_for(username, domain)
    if upn:
        conn, outcome = _bind_as(ldap3_mod, server, upn, password)
        if outcome.ok:
            _safe_unbind(conn)
            return await _success("LDAP 认证成功（UPN 直连）", "upn")
        attempts.append(outcome)
        if outcome.category == ERR_SERVICE_UNAVAILABLE:
            return _direct_failure(outcome, STAGE_SERVICE_BIND, filters_tried)

    # ② Legacy DN template: attr=user,base_dn
    if (_ldap_base_dn or "").strip() and bare:
        user_dn = f"{attr}={_escape_dn_value(bare)},{_ldap_base_dn}"
        conn, outcome = _bind_as(ldap3_mod, server, user_dn, password)
        if outcome.ok:
            _safe_unbind(conn)
            return await _success("LDAP 认证成功（DN 直连）", "dn")
        attempts.append(outcome)
        if outcome.category == ERR_SERVICE_UNAVAILABLE:
            return _direct_failure(outcome, STAGE_SERVICE_BIND, filters_tried)

    # ③ Anonymous (or unauthenticated) search, then rebind as the found DN.
    search: _SearchOutcome | None = None
    if (_ldap_base_dn or "").strip() and _filter_template_valid(_ldap_user_filter):
        anon_conn, anon = _bind_as(ldap3_mod, server, None, None)
        if anon.ok:
            try:
                search = _search_user(
                    ldap3_mod, anon_conn, username, _ldap_base_dn, _ldap_user_filter,
                )
            finally:
                _safe_unbind(anon_conn)
            filters_tried = list(search.filters_tried)
            if search.ok and search.user_dn:
                conn, outcome = _bind_as(ldap3_mod, server, search.user_dn, password)
                if outcome.ok:
                    _safe_unbind(conn)
                    return await _success(
                        "LDAP 认证成功（匿名搜索 + 用户绑定）",
                        "dn",
                        filter_used=search.filter_used,
                    )
                attempts.append(outcome)
                if outcome.category == ERR_SERVICE_UNAVAILABLE:
                    return _direct_failure(outcome, STAGE_SERVICE_BIND, filters_tried)
            elif search.category == ERR_SERVICE_UNAVAILABLE:
                return _direct_failure(
                    _BindOutcome(
                        ok=False,
                        category=search.category,
                        detail=search.detail,
                        result_code=search.result_code,
                        exception_type=search.exception_type,
                    ),
                    STAGE_SERVICE_BIND,
                    filters_tried,
                )
        elif anon.category == ERR_SERVICE_UNAVAILABLE:
            return _direct_failure(anon, STAGE_SERVICE_BIND, filters_tried)

    # No bind succeeded.  If the anonymous search positively found nothing,
    # report "user not found"; otherwise report the last credential failure.
    if search is not None and not search.ok and search.category == ERR_USER_NOT_FOUND:
        return LdapAuthResult(
            ok=False,
            stage=STAGE_SEARCH,
            error=ERR_USER_NOT_FOUND,
            detail=search.detail,
            result_code=search.result_code,
            filter_used=None,
            filters_tried=search.filters_tried,
        )

    if attempts:
        return _direct_failure(
            _most_specific_failure(attempts), STAGE_USER_BIND, filters_tried,
        )

    if not (_ldap_base_dn or "").strip():
        return LdapAuthResult(
            ok=False, stage=STAGE_USER_BIND, error=ERR_CONFIG_ERROR,
            detail="LDAP 配置错误：缺少 Base DN，无法构造 DN 登录名；请配置 Base DN 或 Bind DN",
        )
    return LdapAuthResult(
        ok=False,
        stage=STAGE_USER_BIND,
        error=ERR_CONFIG_ERROR,
        detail="LDAP 配置错误：无法构造域登录名，请检查服务器地址、Base DN 与用户名属性",
    )


_FAILURE_PRIORITY: dict[str, int] = {
    ERR_ACCOUNT_LOCKED: 0,
    ERR_PASSWORD_EXPIRED: 1,
    ERR_ACCOUNT_DISABLED: 2,
    ERR_ACCOUNT_EXPIRED: 3,
    ERR_USER_NOT_FOUND: 4,
    ERR_INVALID_CREDENTIALS: 5,
    ERR_CONFIG_ERROR: 6,
    ERR_SERVICE_UNAVAILABLE: 7,
    ERR_UNKNOWN: 8,
}


def _most_specific_failure(attempts: list[_BindOutcome]) -> _BindOutcome:
    """Prefer a concrete account-state diagnosis over a generic bad password."""
    return min(
        attempts,
        key=lambda outcome: _FAILURE_PRIORITY.get(outcome.category or "", 9),
    )


def _direct_failure(
    outcome: _BindOutcome, stage: str, filters_tried: list[str],
) -> LdapAuthResult:
    detail = outcome.detail or "LDAP 认证失败"
    if outcome.category == ERR_INVALID_CREDENTIALS:
        detail = (
            "用户名或密码错误（AD 返回 invalidCredentials）；"
            "若确认密码正确，请检查账户是否被锁定或改用 user@domain 登录"
        )
    return LdapAuthResult(
        ok=False,
        stage=stage,
        error=outcome.category or ERR_UNKNOWN,
        detail=detail,
        result_code=outcome.result_code,
        exception_type=outcome.exception_type,
        filters_tried=filters_tried,
    )


# ── Public API ──────────────────────────────────────────────────────────────

async def authenticate_ldap_detailed(username: str, password: str) -> LdapAuthResult:
    """Authenticate against LDAP/AD and return a fully classified result.

    This is the entry point used by the login route and the admin diagnostic
    endpoint.  It never raises for LDAP failures and never logs/returns the
    password or a full DN.
    """
    if not _ldap_enabled:
        return LdapAuthResult(
            ok=False, stage=STAGE_SERVICE_BIND, error=ERR_CONFIG_ERROR,
            detail="LDAP 未启用",
        )
    try:
        import ldap3
    except ImportError:
        logger.warning("ldap3 not installed — LDAP auth unavailable")
        return LdapAuthResult(
            ok=False, stage=STAGE_SERVICE_BIND, error=ERR_CONFIG_ERROR,
            detail="LDAP 客户端依赖不可用（ldap3 未安装或依赖缺失）",
        )

    if not username or not password:
        return LdapAuthResult(
            ok=False, stage=STAGE_USER_BIND, error=ERR_INVALID_CREDENTIALS,
            detail="用户名和密码不能为空",
        )

    try:
        if _ldap_bind_dn:
            result = await _authenticate_via_search(ldap3, username, password)
        else:
            result = await _authenticate_via_direct_bind(ldap3, username, password)
    except Exception as exc:  # noqa: BLE001 — never let LDAP break login with 401
        logger.exception(
            "LDAP authentication crashed (stage={} exc_type={})",
            STAGE_USER_BIND, type(exc).__name__,
        )
        return LdapAuthResult(
            ok=False,
            stage=STAGE_USER_BIND,
            error=ERR_SERVICE_UNAVAILABLE,
            detail="LDAP 认证服务异常，请稍后重试或联系管理员",
            exception_type=type(exc).__name__,
        )

    _log_auth_result(username, result)
    return result


def _log_auth_result(username: str, result: LdapAuthResult) -> None:
    """Log a safe, structured one-line outcome (no password, no full DN)."""
    if result.ok:
        logger.info(
            "LDAP auth ok user={} stage={} filter_used={} bound_as={}",
            username, result.stage, result.filter_used, result.bound_as,
        )
        return
    logger.warning(
        "LDAP auth failed user={} stage={} category={} result_code={} "
        "exc_type={} filter_used={} filters_tried={} detail={}",
        username,
        result.stage,
        result.error,
        result.result_code,
        result.exception_type,
        result.filter_used,
        len(result.filters_tried),
        result.detail,
    )


async def authenticate_ldap(username: str, password: str) -> LdapUser | None:
    """Authenticate against the configured LDAP server.  Returns LdapUser or None.

    Backwards-compatible wrapper around :func:`authenticate_ldap_detailed`;
    callers that need stage/error information should use the detailed variant.
    """
    result = await authenticate_ldap_detailed(username, password)
    return result.user if result.ok else None


async def test_ldap_connection() -> tuple[bool, str]:
    """Test LDAP connectivity.  Returns (ok, message)."""
    if not _ldap_enabled:
        return False, "LDAP 未启用"
    try:
        import ldap3
    except ImportError:
        return False, "ldap3 库未安装"
    try:
        server = _make_server(_ldap_server)
        if _ldap_bind_dn:
            conn = ldap3.Connection(
                server, user=_ldap_bind_dn, password=_ldap_bind_password,
                auto_bind=True, receive_timeout=_RECEIVE_TIMEOUT,
            )
        else:
            conn = ldap3.Connection(
                server, auto_bind=True, receive_timeout=_RECEIVE_TIMEOUT,
            )
        conn.unbind()
        return True, "LDAP 连接成功"
    except Exception as exc:  # noqa: BLE001 — map known errors to safe messages
        msg = str(exc)
        if "invalidCredentials" in msg or "52e" in msg:
            return False, "LDAP 认证失败 — 请检查 Bind DN 和密码"
        if "unavailable" in msg.lower():
            return False, "LDAP 服务器不可达 — 请检查地址和网络"
        if "timeout" in msg.lower():
            return False, "LDAP 连接超时 — 请检查网络延迟"
        return False, "LDAP 连接失败 — 请检查配置"
