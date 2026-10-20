"""Unit tests for the LDAP/AD authentication fix.

No real directory is contacted: ``ldap3`` is replaced with an in-memory fake so
the filter fallback chain, direct UPN bind, diagnostic mapping and the login
route's 401/503 split can be exercised deterministically.
"""

from __future__ import annotations

import asyncio
import sys
import types
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

import app.routes.auth as auth_routes
import app.services.ldap as ldap_service
from app.models import AuthType, Team, User, UserRole

BASE_DN = "dc=corp,dc=example,dc=com"
SERVICE_DN = "cn=svc,dc=corp,dc=example,dc=com"
ALICE_DN = "CN=Alice,OU=People,DC=corp,DC=example,DC=com"


# ── Fake ldap3 ──────────────────────────────────────────────────────────────

class _FakeState:
    def __init__(self) -> None:
        self.bind_handler = lambda user, password: False
        self.search_handler = lambda _filter: []
        self.anonymous_ok = False
        self.failed_bind_result = {
            "result": 49,
            "description": "invalidCredentials",
            "message": "80090308: LdapErr: DSID-0C09044E, data 52e",
        }
        self.connections: list["_FakeConnection"] = []
        self.searches: list[str] = []


state = _FakeState()


class _FakeServer:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.args = args
        self.kwargs = kwargs


class _Value:
    def __init__(self, value: Any) -> None:
        self.value = value


class _Entry:
    def __init__(self, dn: str, attrs: dict[str, Any] | None = None) -> None:
        self.entry_dn = dn
        self._attrs = attrs or {}

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._attrs:
            return _Value(self._attrs[name])
        raise AttributeError(name)


class _FakeConnection:
    def __init__(
        self,
        server: _FakeServer,
        user: str | None = None,
        password: str | None = None,
        auto_bind: bool = False,
        receive_timeout: int | None = None,
        **kwargs: Any,
    ) -> None:
        self.server = server
        self.user = user
        self.password = password
        self.auto_bind = auto_bind
        self.receive_timeout = receive_timeout
        self.entries: list[_Entry] = []
        self.result: dict[str, Any] = {}
        self.bound = False
        self.unbound = False
        state.connections.append(self)

    def bind(self) -> bool:
        if self.user is None and self.password is None and state.anonymous_ok:
            self.bound = True
            self.result = {"result": 0, "description": "success", "message": ""}
            return True
        try:
            ok = bool(state.bind_handler(self.user, self.password))
        except Exception:
            raise
        if ok:
            self.bound = True
            self.result = {"result": 0, "description": "success", "message": ""}
        else:
            self.result = dict(state.failed_bind_result)
        return ok

    def search(
        self,
        search_base: str,
        search_filter: str,
        attributes: Any = None,
    ) -> bool:
        state.searches.append(search_filter)
        self.entries = list(state.search_handler(search_filter) or [])
        return bool(self.entries)

    def unbind(self) -> None:
        self.unbound = True


def _fake_ldap3() -> types.ModuleType:
    module = types.ModuleType("ldap3")
    module.Server = _FakeServer
    module.Connection = _FakeConnection
    module.ALL = "ALL"
    module.ALL_ATTRIBUTES = "*"
    module.Tls = lambda **kwargs: None
    return module


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def fake_ldap(monkeypatch: pytest.MonkeyPatch):
    global state
    state = _FakeState()
    monkeypatch.setitem(sys.modules, "ldap3", _fake_ldap3())

    monkeypatch.setattr(ldap_service, "_ldap_enabled", True)
    monkeypatch.setattr(ldap_service, "_ldap_server", "ldap://ad.corp.example.com")
    monkeypatch.setattr(ldap_service, "_ldap_base_dn", BASE_DN)
    monkeypatch.setattr(ldap_service, "_ldap_user_filter", "(uid={username})")
    monkeypatch.setattr(ldap_service, "_ldap_bind_dn", "")
    monkeypatch.setattr(ldap_service, "_ldap_bind_password", "")
    monkeypatch.setattr(ldap_service, "_ldap_username_attr", "uid")
    monkeypatch.setattr(ldap_service, "_ldap_auto_create_user", True)
    monkeypatch.setattr(
        ldap_service, "_ldap_display_name_attr", "displayName",
    )
    monkeypatch.setattr(ldap_service, "_ldap_email_attr", "mail")
    monkeypatch.setattr(ldap_service, "_ldap_department_attr", "department")
    yield


def run(coro):
    return asyncio.run(coro)


# ── Filter placeholders & AD fallbacks ─────────────────────────────────────

@pytest.mark.parametrize(
    ("template", "expected"),
    [
        ("(sAMAccountName={username})", "(sAMAccountName=alice)"),
        ("(sAMAccountName=%(user)s)", "(sAMAccountName=alice)"),
        ("(sAMAccountName=%s)", "(sAMAccountName=alice)"),
        ("(&(objectClass=user)(sAMAccountName={username}))",
         "(&(objectClass=user)(sAMAccountName=alice))"),
    ],
)
def test_filter_placeholder_compatibility(template: str, expected: str) -> None:
    assert ldap_service._expand_user_filter(template, "alice") == expected


def test_filter_without_placeholder_is_config_error() -> None:
    assert ldap_service._expand_user_filter("(objectClass=user)", "alice") is None


def test_ad_fallback_filters_and_domain_derivation() -> None:
    filters = ldap_service._candidate_filters("alice", "(uid={username})", BASE_DN)
    assert filters == [
        "(uid=alice)",
        "(sAMAccountName=alice)",
        "(userPrincipalName=alice@corp.example.com)",
    ]
    assert ldap_service._domain_from_base_dn("dc=corp,dc=example,dc=com") == "corp.example.com"


def test_ldap_injection_is_escaped_before_formatting() -> None:
    filters = ldap_service._candidate_filters("a*)(uid=*", "(uid={username})", BASE_DN)
    assert filters[0] == "(uid=a\\2a\\29\\28uid=\\2a)"


def test_custom_restrictive_filter_is_not_widened() -> None:
    template = "(&(objectClass=user)(memberOf=CN=Ops)(uid={username}))"
    assert ldap_service._is_legacy_uid_template(template) is False
    filters = ldap_service._candidate_filters(
        "alice", template, BASE_DN, allow_ad_fallback=False,
    )
    assert filters == ["(&(objectClass=user)(memberOf=CN=Ops)(uid=alice))"]


# ── Search mode ─────────────────────────────────────────────────────────────

def test_search_mode_falls_back_to_samaccountname(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ldap_service, "_ldap_bind_dn", SERVICE_DN)
    monkeypatch.setattr(ldap_service, "_ldap_bind_password", "svcpass")

    def bind(user: str | None, password: str | None) -> bool:
        if (user, password) == (SERVICE_DN, "svcpass"):
            return True
        return (user, password) == (ALICE_DN, "correct")

    entry = _Entry(
        ALICE_DN,
        {
            "displayName": "Alice",
            "mail": "alice@corp.example.com",
            "memberOf": ["CN=Ops,OU=Groups,DC=corp,DC=example,DC=com"],
        },
    )
    state.bind_handler = bind
    state.search_handler = lambda filt: [entry] if "sAMAccountName=alice" in filt else []

    result = run(ldap_service.authenticate_ldap_detailed("alice", "correct"))

    assert result.ok is True
    assert result.filter_used == "(sAMAccountName=alice)"
    assert result.filters_tried[:2] == ["(uid=alice)", "(sAMAccountName=alice)"]
    assert result.user is not None
    assert result.user.email == "alice@corp.example.com"
    assert result.user.display_name == "Alice"
    assert result.user.groups == ["CN=Ops,OU=Groups,DC=corp,DC=example,DC=com"]
    # Only the matched DN was used for the user rebind; no DN is in the result.
    assert ALICE_DN not in result.detail


def _search_auth_with(
    monkeypatch: pytest.MonkeyPatch, entry: _Entry,
) -> ldap_service.LdapAuthResult:
    """Run search-mode auth against *entry* (service bind + user rebind)."""
    monkeypatch.setattr(ldap_service, "_ldap_bind_dn", SERVICE_DN)
    monkeypatch.setattr(ldap_service, "_ldap_bind_password", "svcpass")

    def bind(user: str | None, password: str | None) -> bool:
        if (user, password) == (SERVICE_DN, "svcpass"):
            return True
        return (user, password) == (ALICE_DN, "correct")

    state.bind_handler = bind
    state.search_handler = lambda filt: [entry] if "sAMAccountName=alice" in filt else []
    return run(ldap_service.authenticate_ldap_detailed("alice", "correct"))


def test_profile_fields_read_with_default_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = _Entry(
        ALICE_DN,
        {
            "displayName": "Alice",
            "mail": "alice@corp.example.com",
            "department": "平台运维部",
        },
    )
    result = _search_auth_with(monkeypatch, entry)

    assert result.ok is True and result.user is not None
    assert result.user.display_name == "Alice"
    assert result.user.email == "alice@corp.example.com"
    assert result.user.department == "平台运维部"


def test_profile_fields_read_with_custom_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ldap_service, "_ldap_display_name_attr", "preferredName")
    monkeypatch.setattr(ldap_service, "_ldap_email_attr", "corpMail")
    monkeypatch.setattr(ldap_service, "_ldap_department_attr", "orgUnit")
    entry = _Entry(
        ALICE_DN,
        {
            # Configured attributes win over the built-in aliases.
            "preferredName": "Alice Custom",
            "displayName": "Alice Alias",
            "corpMail": "custom@corp.example.com",
            "orgUnit": "SRE",
        },
    )
    result = _search_auth_with(monkeypatch, entry)

    assert result.user is not None
    assert result.user.display_name == "Alice Custom"
    assert result.user.email == "custom@corp.example.com"
    assert result.user.department == "SRE"


def test_profile_fields_take_first_list_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = _Entry(
        ALICE_DN,
        {
            "displayName": ["Alice", "Alice B"],
            "mail": ["alice@corp.example.com", "alice2@corp.example.com"],
            "department": ["平台运维部", "SRE"],
        },
    )
    result = _search_auth_with(monkeypatch, entry)

    assert result.user is not None
    assert result.user.display_name == "Alice"
    assert result.user.email == "alice@corp.example.com"
    assert result.user.department == "平台运维部"


def test_profile_fields_fall_back_to_common_aliases(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = _Entry(
        ALICE_DN,
        {
            "cn": "Alice CN",
            "userPrincipalName": "alice@corp.example.com",
            "physicalDeliveryOfficeName": "运维中心",
        },
    )
    result = _search_auth_with(monkeypatch, entry)

    assert result.user is not None
    assert result.user.display_name == "Alice CN"
    assert result.user.email == "alice@corp.example.com"
    assert result.user.department == "运维中心"


def test_profile_fields_use_ou_when_department_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = _Entry(ALICE_DN, {"ou": "研发部"})
    result = _search_auth_with(monkeypatch, entry)

    assert result.user is not None
    assert result.user.department == "研发部"


def test_profile_fields_blank_values_never_win(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry = _Entry(ALICE_DN, {"displayName": "", "cn": "Fallback Name", "mail": "  "})
    result = _search_auth_with(monkeypatch, entry)

    assert result.user is not None
    assert result.user.display_name == "Fallback Name"
    assert result.user.email is None
    assert result.user.department is None


def test_search_mode_no_result_reports_user_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ldap_service, "_ldap_bind_dn", SERVICE_DN)
    monkeypatch.setattr(ldap_service, "_ldap_bind_password", "svcpass")
    state.bind_handler = lambda user, password: (user, password) == (SERVICE_DN, "svcpass")
    state.search_handler = lambda _filt: []

    result = run(ldap_service.authenticate_ldap_detailed("ghost", "whatever"))

    assert result.ok is False
    assert result.stage == ldap_service.STAGE_SEARCH
    assert result.error == ldap_service.ERR_USER_NOT_FOUND
    assert result.result_code == "filter_no_result"
    assert len(result.filters_tried) == 3
    assert "未找到" in result.detail


def test_search_mode_bad_password_maps_to_invalid_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ldap_service, "_ldap_bind_dn", SERVICE_DN)
    monkeypatch.setattr(ldap_service, "_ldap_bind_password", "svcpass")
    state.bind_handler = lambda user, password: (user, password) == (SERVICE_DN, "svcpass")
    entry = _Entry(ALICE_DN)
    state.search_handler = lambda _filt: [entry]

    result = run(ldap_service.authenticate_ldap_detailed("alice", "wrong"))

    assert result.ok is False
    assert result.stage == ldap_service.STAGE_USER_BIND
    assert result.error == ldap_service.ERR_INVALID_CREDENTIALS
    assert result.result_code == "49"


# ── Direct bind mode ────────────────────────────────────────────────────────

def test_direct_mode_uses_upn_first() -> None:
    state.bind_handler = lambda user, password: (
        user, password
    ) == ("alice@corp.example.com", "correct")

    result = run(ldap_service.authenticate_ldap_detailed("alice", "correct"))

    assert result.ok is True
    assert result.bound_as == "upn"
    assert state.connections[0].user == "alice@corp.example.com"
    assert state.searches == []


def test_direct_mode_falls_back_to_configured_dn() -> None:
    state.bind_handler = lambda user, password: (
        user, password
    ) == (f"uid=alice,{BASE_DN}", "correct")

    result = run(ldap_service.authenticate_ldap_detailed("alice", "correct"))

    assert result.ok is True
    assert result.bound_as == "dn"
    assert [c.user for c in state.connections[:2]] == [
        "alice@corp.example.com",
        f"uid=alice,{BASE_DN}",
    ]


def test_direct_mode_anonymous_search_then_rebind() -> None:
    state.anonymous_ok = True

    def bind(user: str | None, password: str | None) -> bool:
        if user is None:
            return True
        return (user, password) == (ALICE_DN, "correct")

    state.bind_handler = bind
    state.search_handler = lambda filt: [_Entry(ALICE_DN)] if "sAMAccountName=alice" in filt else []

    result = run(ldap_service.authenticate_ldap_detailed("alice", "correct"))

    assert result.ok is True
    assert result.bound_as == "dn"
    assert result.filter_used == "(sAMAccountName=alice)"


def test_direct_mode_service_unavailable_is_classified() -> None:
    def bind(_user: str | None, _password: str | None) -> bool:
        raise OSError("connection refused")

    state.bind_handler = bind

    result = run(ldap_service.authenticate_ldap_detailed("alice", "correct"))

    assert result.ok is False
    assert result.stage == ldap_service.STAGE_SERVICE_BIND
    assert result.error == ldap_service.ERR_SERVICE_UNAVAILABLE
    assert "不可用" in result.detail


# ── Error-code mapping ──────────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("code", "description", "message", "expected"),
    [
        ("49", "invalidCredentials", "data 52e", ldap_service.ERR_INVALID_CREDENTIALS),
        ("49", "invalidCredentials", "data 532", ldap_service.ERR_PASSWORD_EXPIRED),
        ("49", "invalidCredentials", "data 775", ldap_service.ERR_ACCOUNT_LOCKED),
        ("49", "invalidCredentials", "data 525", ldap_service.ERR_USER_NOT_FOUND),
        ("49", "invalidCredentials", "data 533", ldap_service.ERR_ACCOUNT_DISABLED),
        ("49", "invalidCredentials", "data 701", ldap_service.ERR_ACCOUNT_EXPIRED),
        ("52", "unavailable", "", ldap_service.ERR_SERVICE_UNAVAILABLE),
        ("50", "insufficientAccessRights", "", ldap_service.ERR_CONFIG_ERROR),
    ],
)
def test_bind_result_mapping(
    code: str, description: str, message: str, expected: str,
) -> None:
    category, detail = ldap_service._classify_bind_result(code, description, message)
    assert category == expected
    assert detail


# ── Login route: 503 vs 401 vs auto-create failure ─────────────────────────

class _ScalarResult:
    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any:
        return self._value


class _FakeDb:
    def __init__(self, existing: Any = None, team: Any = None, flush_error: Exception | None = None):
        self.existing = existing
        self.team = team
        self.flush_error = flush_error
        self.added: list[Any] = []

    async def execute(self, _stmt: Any) -> _ScalarResult:
        return _ScalarResult(self.existing)

    async def get(self, _model: Any, _pk: Any) -> Any:
        return self.team

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        if self.flush_error is not None:
            raise self.flush_error

    async def refresh(self, _obj: Any) -> None:
        return None


def _ldap_failure(category: str, stage: str, detail: str) -> ldap_service.LdapAuthResult:
    return ldap_service.LdapAuthResult(
        ok=False, stage=stage, error=category, detail=detail,
    )


def test_login_maps_service_unavailable_to_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_auth(_username: str, _password: str):
        return _ldap_failure(
            ldap_service.ERR_SERVICE_UNAVAILABLE,
            ldap_service.STAGE_SERVICE_BIND,
            "LDAP 服务不可用（无法连接或超时），请检查服务器地址与网络",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    body = auth_routes.LoginRequest(username="alice", password="whatever")

    with pytest.raises(HTTPException) as exc:
        run(auth_routes.login(body, db=_FakeDb()))

    assert exc.value.status_code == 503
    assert "LDAP" in str(exc.value.detail)


def test_login_maps_config_error_to_503(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_auth(_username: str, _password: str):
        return _ldap_failure(
            ldap_service.ERR_CONFIG_ERROR,
            ldap_service.STAGE_SEARCH,
            "LDAP 配置错误：用户过滤器缺少占位符",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    body = auth_routes.LoginRequest(username="alice", password="whatever")

    with pytest.raises(HTTPException) as exc:
        run(auth_routes.login(body, db=_FakeDb()))

    assert exc.value.status_code == 503
    assert "配置错误" in str(exc.value.detail)


def test_login_keeps_wrong_password_as_401(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_auth(_username: str, _password: str):
        return _ldap_failure(
            ldap_service.ERR_INVALID_CREDENTIALS,
            ldap_service.STAGE_USER_BIND,
            "用户名或密码错误（LDAP 返回 invalidCredentials）",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    body = auth_routes.LoginRequest(username="alice", password="wrong")

    with pytest.raises(HTTPException) as exc:
        run(auth_routes.login(body, db=_FakeDb()))

    assert exc.value.status_code == 401
    assert exc.value.detail == "用户名或密码错误"


def test_login_auto_create_failure_is_not_swallowed_as_password_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_auth(_username: str, _password: str):
        return ldap_service.LdapAuthResult(
            ok=True,
            user=ldap_service.LdapUser(username="alice"),
            stage=ldap_service.STAGE_USER_BIND,
            detail="LDAP 认证成功",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    team = Team(id=1, name="Default Team")
    unique_error = IntegrityError(
        "INSERT INTO users ...",
        {},
        Exception('duplicate key value violates unique constraint "users_username_key"'),
    )
    db = _FakeDb(existing=None, team=team, flush_error=unique_error)
    body = auth_routes.LoginRequest(username="alice", password="correct")

    with pytest.raises(HTTPException) as exc:
        run(auth_routes.login(body, db=db))

    assert exc.value.status_code == 500
    detail = str(exc.value.detail)
    assert "自动创建" in detail
    assert "唯一约束" in detail
    assert "用户名或密码错误" not in detail


# ── Diagnostic endpoint contract ────────────────────────────────────────────

def test_ldap_test_user_endpoint_failure_returns_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_auth(_username: str, _password: str):
        return _ldap_failure(
            ldap_service.ERR_USER_NOT_FOUND,
            ldap_service.STAGE_SEARCH,
            "目录搜索无结果：未找到该用户",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    body = auth_routes.LdapTestUserRequest(username="ghost", password="whatever")

    response = run(auth_routes.test_ldap_user_login(body, db=_FakeDb(), _admin=object()))

    assert response.ok is False
    assert response.stage == "search"
    assert "未找到" in response.detail
    assert "whatever" not in response.detail


def test_ldap_test_user_endpoint_auto_create_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_auth(_username: str, _password: str):
        return ldap_service.LdapAuthResult(
            ok=True,
            user=ldap_service.LdapUser(username="newuser"),
            stage=ldap_service.STAGE_USER_BIND,
            detail="LDAP 认证成功",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    monkeypatch.setattr(ldap_service, "_ldap_auto_create_user", False)
    body = auth_routes.LdapTestUserRequest(username="newuser", password="secret")

    response = run(
        auth_routes.test_ldap_user_login(
            body, db=_FakeDb(existing=None), _admin=object(),
        )
    )

    assert response.ok is False
    assert response.stage == "auto_create"
    assert "未开启" in response.detail


def test_ldap_test_user_endpoint_existing_ldap_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_auth(_username: str, _password: str):
        return ldap_service.LdapAuthResult(
            ok=True,
            user=ldap_service.LdapUser(username="alice"),
            stage=ldap_service.STAGE_USER_BIND,
            detail="LDAP 认证成功",
        )

    monkeypatch.setattr(auth_routes, "authenticate_ldap_detailed", fake_auth)
    existing = User(
        username="alice",
        role=UserRole.OPERATOR,
        team_id=1,
        auth_type=AuthType.LDAP,
    )
    body = auth_routes.LdapTestUserRequest(username="alice", password="secret")

    response = run(
        auth_routes.test_ldap_user_login(
            body, db=_FakeDb(existing=existing), _admin=object(),
        )
    )

    assert response.ok is True
    assert response.stage == "user_bind"
    assert "已存在" in response.detail
    assert "secret" not in response.detail


# ── Local mirror sync (display_name / email / department) ───────────────────

def test_create_ldap_user_mirrors_profile_fields() -> None:
    db = _FakeDb(existing=None, team=Team(id=1, name="Default Team"))
    ldap_user = ldap_service.LdapUser(
        username="alice",
        display_name=" Alice ",
        email="alice@corp.example.com",
        department="平台运维部",
    )

    user = run(auth_routes._create_ldap_user(db, ldap_user))

    assert user.display_name == "Alice"
    assert user.email == "alice@corp.example.com"
    assert user.department == "平台运维部"
    assert user.auth_type == AuthType.LDAP


def test_existing_user_profile_is_refreshed_on_login() -> None:
    existing = User(
        username="alice",
        role=UserRole.OPERATOR,
        team_id=1,
        auth_type=AuthType.LDAP,
        display_name="Old Name",
        email="old@corp.example.com",
        department=None,
    )
    ldap_user = ldap_service.LdapUser(
        username="alice",
        display_name="Alice New",
        email=None,  # must not clear the stored address
        department="平台运维部",
    )

    returned = run(
        auth_routes._ensure_ldap_local_user(_FakeDb(existing=existing), existing, ldap_user)
    )

    assert returned is existing
    assert existing.display_name == "Alice New"
    assert existing.email == "old@corp.example.com"
    assert existing.department == "平台运维部"


def test_profile_sync_is_noop_when_values_match() -> None:
    existing = User(
        username="alice",
        role=UserRole.OPERATOR,
        team_id=1,
        auth_type=AuthType.LDAP,
        display_name="Alice",
        email="alice@corp.example.com",
        department="平台运维部",
    )
    ldap_user = ldap_service.LdapUser(
        username="alice",
        display_name="Alice",
        email="alice@corp.example.com",
        department="平台运维部",
    )

    assert auth_routes._sync_ldap_profile(existing, ldap_user) is False


def test_reload_ldap_config_profile_attributes() -> None:
    ldap_service.reload_ldap_config({})
    assert ldap_service._ldap_display_name_attr == "displayName"
    assert ldap_service._ldap_email_attr == "mail"
    assert ldap_service._ldap_department_attr == "department"

    ldap_service.reload_ldap_config({
        "ldap_display_name_attr": " cn ",
        "ldap_email_attr": "userPrincipalName",
        "ldap_department_attr": "physicalDeliveryOfficeName",
    })
    assert ldap_service._ldap_display_name_attr == "cn"
    assert ldap_service._ldap_email_attr == "userPrincipalName"
    assert ldap_service._ldap_department_attr == "physicalDeliveryOfficeName"

    # Blank/absent values fall back to the shipped defaults.
    ldap_service.reload_ldap_config({
        "ldap_display_name_attr": "  ",
        "ldap_email_attr": "",
    })
    assert ldap_service._ldap_display_name_attr == "displayName"
    assert ldap_service._ldap_email_attr == "mail"
    assert ldap_service._ldap_department_attr == "department"
