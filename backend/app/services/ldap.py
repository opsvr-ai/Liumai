"""LDAP / Active Directory authentication service.

Configuration precedence: database (set via admin UI) > environment variables.
When the admin saves config through ``PUT /api/auth/ldap-config``, the database
values are reloaded into this module immediately — no restart required.
"""

from __future__ import annotations

import ssl
from dataclasses import dataclass

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

# RFC 4515 LDAP filter escaping — special characters must be replaced with
# their \xx hex representation to prevent LDAP injection.
_LDAP_ESCAPE_TABLE = str.maketrans({
    "*": "\\2a",
    "(": "\\28",
    ")": "\\29",
    "\\": "\\5c",
    "\x00": "\\00",
})


def _escape_ldap_filter(value: str) -> str:
    """Escape special characters in an LDAP filter value per RFC 4515.

    Prevents LDAP injection attacks through username input.
    """
    return value.translate(_LDAP_ESCAPE_TABLE)


def _make_server(uri: str) -> "ldap3.Server":
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


async def authenticate_ldap(username: str, password: str) -> LdapUser | None:
    """Authenticate against the configured LDAP server.  Returns LdapUser or None."""
    if not _ldap_enabled:
        return None
    try:
        import ldap3
    except ImportError:
        logger.warning("ldap3 not installed — LDAP auth disabled")
        return None

    # Escape username to prevent LDAP injection
    safe_username = _escape_ldap_filter(username)
    server = _make_server(_ldap_server)

    if _ldap_bind_dn:
        # ── Search mode: bind with service account, search for user, rebind as user ──
        conn = None
        try:
            conn = ldap3.Connection(
                server, user=_ldap_bind_dn, password=_ldap_bind_password,
                auto_bind=True, receive_timeout=_RECEIVE_TIMEOUT,
            )
        except ldap3.core.exceptions.LDAPException as exc:
            logger.warning("LDAP service bind failed: {}", exc)
            return None

        try:
            filt = _ldap_user_filter.format(username=safe_username)
            conn.search(
                search_base=_ldap_base_dn, search_filter=filt,
                attributes=ldap3.ALL_ATTRIBUTES,
            )
            if not conn.entries:
                return None

            entry = conn.entries[0]
            user_dn = str(entry.entry_dn)
            dn = str(entry.displayName) if hasattr(entry, "displayName") else None
            mail = str(entry.mail) if hasattr(entry, "mail") else None
            groups = [str(g) for g in entry.memberOf] if hasattr(entry, "memberOf") else None
        except ldap3.core.exceptions.LDAPException as exc:
            logger.warning("LDAP search failed: {}", exc)
            return None
        finally:
            if conn:
                try:
                    conn.unbind()
                except Exception:
                    pass

        # Rebind as user to verify password
        try:
            uc = ldap3.Connection(
                server, user=user_dn, password=password,
                auto_bind=True, receive_timeout=_RECEIVE_TIMEOUT,
            )
            uc.unbind()
        except ldap3.core.exceptions.LDAPException:
            return None
        return LdapUser(username=username, display_name=dn, email=mail, groups=groups)

    # ── Direct bind mode (no service account; bind directly as the user) ──
    # Construct user DN using the base DN and username attribute
    user_dn = f"{_ldap_username_attr}={safe_username},{_ldap_base_dn}"
    try:
        conn = ldap3.Connection(
            server, user=user_dn, password=password,
            auto_bind=True, receive_timeout=_RECEIVE_TIMEOUT,
        )
        conn.unbind()
        return LdapUser(username=username)
    except ldap3.core.exceptions.LDAPException:
        return None


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
    except ldap3.core.exceptions.LDAPException as exc:
        # Map known error codes to generic messages — don't leak LDAP internals
        msg = str(exc)
        if "invalidCredentials" in msg or "52e" in msg:
            return False, "LDAP 认证失败 — 请检查 Bind DN 和密码"
        if "unavailable" in msg.lower():
            return False, "LDAP 服务器不可达 — 请检查地址和网络"
        if "timeout" in msg.lower():
            return False, "LDAP 连接超时 — 请检查网络延迟"
        return False, "LDAP 连接失败 — 请检查配置"
