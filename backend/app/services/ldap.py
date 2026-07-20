"""LDAP / Active Directory authentication service."""

from __future__ import annotations

from dataclasses import dataclass

from loguru import logger

from app.config import settings


@dataclass
class LdapUser:
    """Result of a successful LDAP authentication."""
    username: str
    display_name: str | None = None
    email: str | None = None
    groups: list[str] | None = None


async def authenticate_ldap(username: str, password: str) -> LdapUser | None:
    """Authenticate against the configured LDAP server.  Returns LdapUser or None."""
    if not settings.LDAP_ENABLED:
        return None
    try:
        import ldap3
    except ImportError:
        logger.warning("ldap3 not installed")
        return None

    server = ldap3.Server(settings.LDAP_SERVER, get_info=ldap3.ALL)

    if settings.LDAP_BIND_DN:
        # Search mode: bind with service account, search for user, rebind as user
        try:
            conn = ldap3.Connection(
                server, user=settings.LDAP_BIND_DN,
                password=settings.LDAP_BIND_PASSWORD, auto_bind=True,
            )
        except ldap3.core.exceptions.LDAPException as exc:
            logger.error("LDAP bind failed: {}", exc)
            return None

        filt = settings.LDAP_USER_FILTER.format(username=username)
        conn.search(
            search_base=settings.LDAP_BASE_DN, search_filter=filt,
            attributes=[settings.LDAP_USERNAME_ATTR, "displayName", "mail", "memberOf"],
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
    user_dn = settings.LDAP_USER_FILTER.format(username=username)
    if not (user_dn.startswith("cn=") or user_dn.startswith("uid=")):
        user_dn = f"uid={username},{settings.LDAP_BASE_DN}"
    try:
        conn = ldap3.Connection(server, user=user_dn, password=password, auto_bind=True)
        conn.unbind()
        return LdapUser(username=username)
    except ldap3.core.exceptions.LDAPException:
        return None


async def test_ldap_connection() -> tuple[bool, str]:
    """Test LDAP connectivity.  Returns (ok, message)."""
    if not settings.LDAP_ENABLED:
        return False, "LDAP 未启用"
    try:
        import ldap3
    except ImportError:
        return False, "ldap3 库未安装"
    try:
        server = ldap3.Server(settings.LDAP_SERVER, get_info=ldap3.ALL)
        if settings.LDAP_BIND_DN:
            conn = ldap3.Connection(
                server, user=settings.LDAP_BIND_DN,
                password=settings.LDAP_BIND_PASSWORD, auto_bind=True,
            )
        else:
            conn = ldap3.Connection(server, auto_bind=True)
        conn.unbind()
        return True, "LDAP 连接成功"
    except ldap3.core.exceptions.LDAPException as exc:
        return False, f"LDAP 连接失败: {exc}"
