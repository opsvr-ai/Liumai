"""LDAP / Active Directory authentication service.

Configuration precedence: database (set via admin UI) > environment variables.
When the admin saves config through ``PUT /api/auth/ldap-config``, the database
values are reloaded into this module immediately — no restart required.
"""

from __future__ import annotations

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
        logger.warning("ldap3 not installed")
        return None

    server = ldap3.Server(_ldap_server, get_info=ldap3.ALL)

    if _ldap_bind_dn:
        # Search mode: bind with service account, search for user, rebind as user
        try:
            conn = ldap3.Connection(
                server, user=_ldap_bind_dn,
                password=_ldap_bind_password, auto_bind=True,
            )
        except ldap3.core.exceptions.LDAPException as exc:
            logger.error("LDAP bind failed: {}", exc)
            return None

        filt = _ldap_user_filter.format(username=username)
        conn.search(
            search_base=_ldap_base_dn, search_filter=filt,
            attributes=[_ldap_username_attr, "displayName", "mail", "memberOf"],
        )
        if not conn.entries:
            conn.unbind(); return None

        entry = conn.entries[0]
        user_dn = entry.entry_dn
        dn = str(entry.displayName) if hasattr(entry, "displayName") else None
        mail = str(entry.mail) if hasattr(entry, "mail") else None
        groups = [str(g) for g in entry.memberOf] if hasattr(entry, "memberOf") else None
        conn.unbind()

        try:
            uc = ldap3.Connection(server, user=user_dn, password=password, auto_bind=True)
            uc.unbind()
        except ldap3.core.exceptions.LDAPException:
            return None
        return LdapUser(username=username, display_name=dn, email=mail, groups=groups)

    # Direct bind mode
    user_dn = _ldap_user_filter.format(username=username)
    if not (user_dn.startswith("cn=") or user_dn.startswith("uid=")):
        user_dn = f"uid={username},{_ldap_base_dn}"
    try:
        conn = ldap3.Connection(server, user=user_dn, password=password, auto_bind=True)
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
        server = ldap3.Server(_ldap_server, get_info=ldap3.ALL)
        if _ldap_bind_dn:
            conn = ldap3.Connection(
                server, user=_ldap_bind_dn,
                password=_ldap_bind_password, auto_bind=True,
            )
        else:
            conn = ldap3.Connection(server, auto_bind=True)
        conn.unbind()
        return True, "LDAP 连接成功"
    except ldap3.core.exceptions.LDAPException as exc:
        return False, f"LDAP 连接失败: {exc}"
