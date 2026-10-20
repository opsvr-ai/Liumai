"""Pluggable data-source adapters — one class per source type.

Each adapter knows how to:
- Authenticate (resolve auth config → headers/params)
- Test connectivity (lightweight ping)
- Execute a query (fetch + parse)
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx
from loguru import logger


# ═══════════════════════════════════════════════════════════════════════════════
# Shared types
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class QueryResult:
    rows: list[dict[str, Any]] = field(default_factory=list)
    raw: Any = None


# ═══════════════════════════════════════════════════════════════════════════════
# Read-only SQL policy
# ═══════════════════════════════════════════════════════════════════════════════
#
# Path C (business-volume fluctuation) runs operator-supplied SQL against a
# ClickHouse data source, so it is deliberately conservative: exactly one
# statement, and it must start with SELECT (or a WITH ... SELECT CTE).  String
# literals / comments are stripped before keyword inspection so a literal such
# as ``'delete'`` cannot trip the guard, and a ``--``/``/* */`` comment cannot
# hide a second statement.  The ClickHouse adapter additionally asks the server
# for ``readonly=2`` so even a validation bypass cannot write data.

MAX_READONLY_SQL_LENGTH = 8000

# Statement keywords that are never part of a read-only SELECT.
_FORBIDDEN_SQL_KEYWORDS = re.compile(
    r"\b(?:insert|update|delete|drop|alter|create|truncate|rename|attach|"
    r"detach|replace|merge|grant|revoke|optimize|kill|use|set|call|execute)\b",
    re.IGNORECASE,
)
# SELECT ... INTO OUTFILE/DUMPFILE writes to the server filesystem.
_FORBIDDEN_SQL_CLAUSE = re.compile(r"\binto\s+(?:outfile|dumpfile)\b", re.IGNORECASE)
# ClickHouse table functions that can read the filesystem / network / external DBs.
_FORBIDDEN_SQL_FUNCTIONS = re.compile(
    r"\b(?:url|file|remote|remotesecure|hdfs|s3|azureblobstorage|gcs|mysql|"
    r"postgresql|jdbc|odbc|sqlite|mongodb|redis|executable|input)\s*\(",
    re.IGNORECASE,
)


class ReadOnlyQueryError(ValueError):
    """Raised when SQL violates the single-statement read-only policy."""


def _strip_sql_literals_and_comments(sql: str) -> str:
    """Return *sql* with literals/comments blanked, preserving structure.

    This is a small lexer rather than a regex so quotes, doubled quotes,
    backslash escapes, ``--`` comments and ``/* ... */`` comments are handled
    correctly.  Raises :class:`ReadOnlyQueryError` for an unterminated block
    comment (which could otherwise hide the rest of the query).
    """
    out: list[str] = []
    i = 0
    length = len(sql)
    while i < length:
        char = sql[i]
        if char in ("'", '"', "`"):
            quote = char
            i += 1
            while i < length:
                current = sql[i]
                if current == "\\":
                    i += 2
                    continue
                if current == quote:
                    if i + 1 < length and sql[i + 1] == quote:
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            out.append("''")
            continue
        if char == "-" and i + 1 < length and sql[i + 1] == "-":
            newline = sql.find("\n", i)
            i = length if newline < 0 else newline + 1
            out.append(" ")
            continue
        if char == "/" and i + 1 < length and sql[i + 1] == "*":
            end = sql.find("*/", i + 2)
            if end < 0:
                raise ReadOnlyQueryError("SQL 包含未闭合的块注释")
            i = end + 2
            out.append(" ")
            continue
        out.append(char)
        i += 1
    return "".join(out)


def validate_readonly_sql(sql: str) -> str:
    """Validate and return a single read-only SELECT statement.

    Rules:
      * non-empty, at most :data:`MAX_READONLY_SQL_LENGTH` characters;
      * exactly one statement (one optional trailing ``;`` is allowed);
      * first keyword is ``SELECT`` or ``WITH`` (a CTE must contain ``SELECT``);
      * no DDL/DML statement keywords, no ``SELECT ... INTO OUTFILE``, and no
        filesystem/network/external-DB ClickHouse table functions.

    Raises :class:`ReadOnlyQueryError` on violation.  The returned value never
    contains a trailing semicolon, so it cannot be interpreted as multiple
    statements by the HTTP endpoint.
    """
    if not isinstance(sql, str):
        raise ReadOnlyQueryError("SQL 必须是字符串")
    text = sql.strip()
    if not text:
        raise ReadOnlyQueryError("SQL 为空")
    if "\x00" in text:
        raise ReadOnlyQueryError("SQL 包含非法 NUL 字符")
    if len(text) > MAX_READONLY_SQL_LENGTH:
        raise ReadOnlyQueryError(
            f"SQL 过长（>{MAX_READONLY_SQL_LENGTH} 字符）"
        )

    structure = _strip_sql_literals_and_comments(text).strip()
    while structure.endswith(";"):
        structure = structure[:-1].rstrip()
    if ";" in structure:
        raise ReadOnlyQueryError("只允许单条 SQL 语句（检测到多语句）")

    first = re.match(r"([A-Za-z]+)", structure)
    if first is None:
        raise ReadOnlyQueryError("SQL 必须以 SELECT 开头")
    leading = first.group(1).lower()
    if leading not in ("select", "with"):
        raise ReadOnlyQueryError("只允许 SELECT 查询")
    if leading == "with" and not re.search(r"\bselect\b", structure, re.IGNORECASE):
        raise ReadOnlyQueryError("WITH 子句必须包含 SELECT")

    attack = _FORBIDDEN_SQL_KEYWORDS.search(structure)
    if attack is not None:
        raise ReadOnlyQueryError(f"SQL 包含被禁止的关键字: {attack.group(0)}")
    if _FORBIDDEN_SQL_CLAUSE.search(structure):
        raise ReadOnlyQueryError("SQL 不允许 INTO OUTFILE / DUMPFILE")
    function = _FORBIDDEN_SQL_FUNCTIONS.search(structure)
    if function is not None:
        raise ReadOnlyQueryError(f"SQL 不允许外部读写函数: {function.group(0)}")

    cleaned = text.rstrip()
    while cleaned.endswith(";"):
        cleaned = cleaned[:-1].rstrip()
    return cleaned


# ═══════════════════════════════════════════════════════════════════════════════
# Base
# ═══════════════════════════════════════════════════════════════════════════════


class BaseAdapter(ABC):
    """Abstract adapter — subclasses implement per-type logic."""

    type_slug: str = ""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    @abstractmethod
    async def test_connection(self) -> tuple[bool, str]:
        """Lightweight connectivity check."""
        ...

    @abstractmethod
    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        """Run a query and return structured rows."""
        ...

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _parse_json_path(data: Any, path: str) -> Any:
        """Simple dot-notation JSON path: 'data.result[0].value'."""
        parts = path.replace("[", ".").replace("]", "").split(".")
        current = data
        for p in parts:
            if not p:
                continue
            if isinstance(current, dict):
                current = current.get(p)
            elif isinstance(current, list) and p.isdigit():
                current = current[int(p)] if int(p) < len(current) else None
            else:
                return None
            if current is None:
                return None
        return current

    def _http_client(self) -> httpx.AsyncClient:
        timeout = int(self.config.get("timeout_secs", 30))
        return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10))


# ═══════════════════════════════════════════════════════════════════════════════
# URL normalisation + diagnostics helpers
# ═══════════════════════════════════════════════════════════════════════════════

_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://")

# Prometheus API paths users paste instead of the root address.  Longest first
# so "/api/v1/query_range" is stripped before "/api/v1".
_PROM_STRIP_SUFFIXES = (
    "/api/v1/query_range",
    "/api/v1/query",
    "/api/v1/status/buildinfo",
    "/api/v1/status/config",
    "/api/v1/status/runtimeinfo",
    "/api/v1",
)

_PROM_ROOT_HINT = (
    "Prometheus 根地址（可带 /prometheus 或 VictoriaMetrics 的 "
    "/select/0/prometheus 前缀，不要带 /api/v1/... 查询路径）"
)


def _short_text(text: Any, limit: int = 160) -> str:
    """Collapse *text* into a short single-line diagnostic fragment."""
    cleaned = " ".join(str(text or "").split())
    return cleaned[:limit] + ("…" if len(cleaned) > limit else "")


def _split_url(raw: str) -> tuple[str, str, str]:
    """Return ``(scheme, netloc, path)`` for user-supplied input.

    Query strings and fragments are dropped (they never belong to a base URL)
    and a missing scheme defaults to ``http://``.
    """
    from urllib.parse import urlsplit

    text = str(raw or "").strip()
    if not text:
        return "", "", ""
    # Ignore query strings / fragments: "…/api/v1/query?query=up" → "…/api/v1/query".
    text = text.split("#", 1)[0].split("?", 1)[0].strip()
    if not _SCHEME_RE.match(text):
        text = f"http://{text}"
    parts = urlsplit(text)
    return parts.scheme.lower(), parts.netloc, parts.path or ""


def _normalize_prom_url(raw: str) -> str:
    """Normalise a Prometheus URL to a query-free root address.

    * trailing ``/`` is removed;
    * a pasted query/API path (``/api/v1/query``, ``/api/v1/query_range``,
      ``/api/v1/status/buildinfo``, …) is stripped back to the base;
    * real path prefixes such as ``/prometheus`` or VictoriaMetrics'
      ``/select/0/prometheus`` are preserved untouched;
    * ``?query=...`` query strings are ignored.
    """
    scheme, netloc, path = _split_url(raw)
    if not netloc:
        return ""
    path = path.rstrip("/")
    lowered = path.lower()
    for _ in range(8):
        for suffix in _PROM_STRIP_SUFFIXES:
            if lowered.endswith(suffix):
                path = path[: -len(suffix)].rstrip("/")
                lowered = path.lower()
                break
        else:
            break
    return f"{scheme}://{netloc}{path}"


def _prom_prefixed_base(base: str) -> str:
    """Return ``{base}/prometheus`` unless *base* already is that prefix."""
    if base.lower().rstrip("/").endswith("/prometheus"):
        return ""
    return f"{base}/prometheus"


def _normalize_clickhouse_url(raw: str) -> str:
    """Normalise a ClickHouse HTTP endpoint.

    A missing scheme defaults to ``http://``; only ``http``/``https`` are used
    because the platform talks to ClickHouse over its HTTP interface (the
    native protocol on port 9000 is never used).
    """
    scheme, netloc, path = _split_url(raw)
    if not netloc:
        return ""
    return f"{'https' if scheme == 'https' else 'http'}://{netloc}{path.rstrip('/')}"


# ═══════════════════════════════════════════════════════════════════════════════
# Prometheus
# ═══════════════════════════════════════════════════════════════════════════════


class PrometheusAdapter(BaseAdapter):
    type_slug = "prometheus"

    def _auth_headers(self) -> dict[str, str]:
        auth = self.config.get("auth", {}) or {}
        t = auth.get("type", "none")
        if t == "basic":
            import base64
            creds = base64.b64encode(f"{auth.get('username', '')}:{auth.get('password', '')}".encode()).decode()
            return {"Authorization": f"Basic {creds}"}
        if t == "bearer":
            return {"Authorization": f"Bearer {auth.get('token', '')}"}
        return {}

    def _base_url(self) -> str:
        return _normalize_prom_url(self.config.get("url") or "")

    def _timeout_seconds(self) -> int:
        try:
            return max(1, int(self.config.get("timeout_secs") or 30))
        except (TypeError, ValueError):
            return 30

    @staticmethod
    def _success_message(kind: str, base: str, response: httpx.Response) -> str:
        if kind == "buildinfo":
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            data = payload.get("data") if isinstance(payload, dict) else None
            version = data.get("version") if isinstance(data, dict) else None
            if not version and isinstance(payload, dict):
                version = payload.get("version")
            if version:
                return f"连接成功：Prometheus {version}（{base}）"
            return f"Prometheus 兼容端点可用（{base}）"
        return (
            f"Prometheus 兼容端点可用（{base}）："
            "/api/v1/status/buildinfo 不可用，但 /api/v1/query 返回正常"
        )

    async def test_connection(self) -> tuple[bool, str]:
        raw = str(self.config.get("url") or "").strip()
        if not raw:
            return False, f"未配置 Prometheus URL：请填写{_PROM_ROOT_HINT}，例如 http://host:9090"
        base = self._base_url()
        if not base:
            return False, (
                f"Prometheus URL 无效：{_short_text(raw)}；请填写{_PROM_ROOT_HINT}，"
                "例如 http://host:9090"
            )
        headers = self._auth_headers()
        timeout = self._timeout_seconds()
        # buildinfo → query (buildinfo 不存在时) → {base}/prometheus 前缀（404 时）
        candidates: list[tuple[str, str]] = [
            (f"{base}/api/v1/status/buildinfo", "buildinfo"),
            (f"{base}/api/v1/query?query=up", "query"),
        ]
        attempted: list[str] = []
        last_error = ""
        try:
            async with self._http_client() as client:
                index = 0
                while index < len(candidates):
                    url, kind = candidates[index]
                    index += 1
                    try:
                        r = await client.get(url, headers=headers)
                    except httpx.TimeoutException:
                        return False, (
                            f"连接超时（>{timeout}s）：{url} 无响应。"
                            "请确认 Prometheus 与本服务网络互通、端口正确，或调大超时时间"
                        )
                    except httpx.ConnectError as exc:
                        return False, (
                            f"无法连接 {url}（{_short_text(exc)}）。"
                            "请确认主机/端口正确且内网可达（检查防火墙、安全组、反向代理）"
                        )
                    except httpx.HTTPError as exc:
                        return False, f"请求 Prometheus 失败：{url}（{_short_text(exc)}）"

                    attempted.append(f"{url} → HTTP {r.status_code}")
                    status_code = r.status_code
                    if status_code == 200:
                        return True, self._success_message(kind, base, r)
                    if status_code in (401, 403):
                        return False, (
                            f"认证失败（HTTP {status_code}）：请检查用户名/密码（Basic）"
                            f"或 Token（Bearer）是否正确；URL: {url}；"
                            f"原始响应: {_short_text(r.text)}"
                        )
                    if status_code == 400:
                        last_error = (
                            f"HTTP 400 路径错误：{url} 不是可用的 Prometheus API 路径。"
                            "URL 可能填成了查询路径（如 /api/v1/query），应填"
                            f"{_PROM_ROOT_HINT}；原始响应: {_short_text(r.text)}"
                        )
                        continue
                    if status_code in (404, 405):
                        # Only one prefix retry, and only when the base has no API path yet.
                        if len(candidates) == 2 and "/api/v1" not in base.lower():
                            prefixed = _prom_prefixed_base(base)
                            if prefixed:
                                candidates.append(
                                    (f"{prefixed}/api/v1/status/buildinfo", "buildinfo")
                                )
                        continue
                    last_error = (
                        f"HTTP {status_code}：Prometheus 返回异常；"
                        f"URL: {url}；原始响应: {_short_text(r.text)}"
                    )
        except Exception as exc:  # noqa: BLE001 - always return a diagnostic instead of raising
            return False, f"测试 Prometheus 连接失败：{_short_text(exc)}（URL: {base}）"

        hint = f"已尝试: {'; '.join(attempted)}。"
        if last_error:
            return False, f"{last_error}。{hint}"
        return False, (
            f"连接失败：{hint}请确认填写的是{_PROM_ROOT_HINT}，"
            "且反向代理已将 /api/v1 转发到 Prometheus"
        )

    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        base = self._base_url()
        if not base:
            raise ValueError(f"未配置或无法解析 Prometheus URL，请填写{_PROM_ROOT_HINT}")
        urls = [f"{base}/api/v1/query"]
        prefixed = _prom_prefixed_base(base)
        if prefixed and "/api/v1" not in base.lower():
            urls.append(f"{prefixed}/api/v1/query")
        headers = self._auth_headers()
        response: httpx.Response | None = None
        async with self._http_client() as client:
            for idx, url in enumerate(urls):
                response = await client.get(url, params={"query": query}, headers=headers)
                if response.status_code == 404 and idx + 1 < len(urls):
                    continue
                break
        if response is None:  # pragma: no cover - defensive
            raise ValueError("Prometheus 查询未发起")
        response.raise_for_status()
        data = response.json()
        results = data.get("data", {}).get("result", [])
        rows = [
            {"metric": item.get("metric", {}), "value": item.get("value", [None, None])[1]}
            for item in results
        ]
        return QueryResult(rows=rows, raw=data)


# ═══════════════════════════════════════════════════════════════════════════════
# Zabbix
# ═══════════════════════════════════════════════════════════════════════════════


class ZabbixAdapter(BaseAdapter):
    type_slug = "zabbix"

    def _base_url(self) -> str:
        return (self.config.get("url") or "").rstrip("/")

    async def _get_token(self, client: httpx.AsyncClient) -> str | None:
        auth = self.config.get("auth", {}) or {}
        user = auth.get("username") or self.config.get("username", "")
        pwd = auth.get("password") or self.config.get("password", "")
        if not user or not pwd:
            return None
        r = await client.post(
            f"{self._base_url()}/api_jsonrpc.php",
            json={"jsonrpc": "2.0", "method": "user.login", "params": {"username": user, "password": pwd}, "id": 1},
        )
        data = r.json()
        return data.get("result") if "result" in data else None

    async def test_connection(self) -> tuple[bool, str]:
        url = self._base_url()
        if not url:
            return False, "未配置 Zabbix URL"
        try:
            async with self._http_client() as c:
                token = await self._get_token(c)
                if token:
                    return True, f"Zabbix 连接成功 (已认证)"
                r = await c.post(
                    f"{url}/api_jsonrpc.php",
                    json={"jsonrpc": "2.0", "method": "apiinfo.version", "id": 1, "params": []},
                )
                ver = r.json().get("result", "unknown")
                return True, f"Zabbix {ver} (未认证)"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        async with self._http_client() as c:
            token = await self._get_token(c)
            r = await c.post(
                f"{self._base_url()}/api_jsonrpc.php",
                json={
                    "jsonrpc": "2.0",
                    "method": query,
                    "params": params or {},
                    "id": 1,
                    "auth": token,
                },
            )
        r.raise_for_status()
        data = r.json()
        return QueryResult(rows=data.get("result", []), raw=data)


# ═══════════════════════════════════════════════════════════════════════════════
# ClickHouse
# ═══════════════════════════════════════════════════════════════════════════════


class ClickHouseAdapter(BaseAdapter):
    type_slug = "clickhouse"

    def _base_url(self) -> str:
        raw = str(self.config.get("url") or "").strip()
        if raw:
            return _normalize_clickhouse_url(raw)
        host = str(self.config.get("host") or "").strip() or "localhost"
        if _SCHEME_RE.match(host) or host.count(":") == 1:
            # host already carries a scheme or "host:port"
            return _normalize_clickhouse_url(host)
        port = str(self.config.get("port") or "").strip() or "8123"
        return _normalize_clickhouse_url(f"{host}:{port}")

    def _auth_params(self) -> dict[str, str]:
        user = self.config.get("user", "default")
        pwd = self.config.get("password", "")
        params = {"user": user}
        if pwd:
            params["password"] = pwd
        return params

    def _timeout_seconds(self) -> int:
        try:
            return max(1, int(self.config.get("timeout_secs") or 30))
        except (TypeError, ValueError):
            return 30

    _NATIVE_PORT_HINT = (
        "检测到 ClickHouse 原生 TCP 端口 9000（或原生协议）：本平台通过 HTTP 接口访问，"
        "请改用 HTTP 端口 8123（或 clickhouse 配置中的 http_port）"
    )

    def _native_port_hint(self) -> str:
        """Warn when the config points at the native protocol port instead of HTTP."""
        raw = " ".join(str(self.config.get(k) or "") for k in ("url", "host", "port"))
        native = (
            str(self.config.get("port") or "").strip() == "9000"
            or re.search(r":9000(?=$|[/?#\s])", raw) is not None
            or "tcp://" in raw.lower()
            or "clickhouse://" in raw.lower()
        )
        return self._NATIVE_PORT_HINT if native else ""

    @staticmethod
    async def _server_version(
        client: httpx.AsyncClient, base: str, auth: dict[str, str],
    ) -> str:
        """Best-effort version lookup; empty string when unavailable."""
        try:
            r = await client.get(
                f"{base}/",
                params={**auth, "query": "SELECT version()", "default_format": "TabSeparated"},
            )
        except httpx.HTTPError:
            return ""
        if r.status_code != 200:
            return ""
        return r.text.strip().split("\n")[0].strip()[:40]

    async def test_connection(self) -> tuple[bool, str]:
        base = self._base_url()
        if not base:
            return False, "未配置 ClickHouse 地址：请填写主机 + HTTP 端口（默认 8123）"
        auth = self._auth_params()
        timeout = self._timeout_seconds()
        hint = self._native_port_hint()
        suffix = f"（{hint}）" if hint else ""
        try:
            async with self._http_client() as client:
                # 1) HTTP /ping (works on 8123 and any custom http_port)
                r = await client.get(f"{base}/ping", params=auth)
                if r.status_code == 200 and r.text.strip().lower().startswith("ok"):
                    version = await self._server_version(client, base, auth)
                    label = f"ClickHouse 在线（HTTP {base}）"
                    return True, f"{label}，版本 {version}" if version else label
                if r.status_code in (401, 403):
                    return False, (
                        f"认证失败（HTTP {r.status_code}）：请检查 user/password 是否正确；"
                        f"目标 {base}{suffix}；原始响应: {_short_text(r.text)}"
                    )

                # 2) Fall back to a plain HTTP query when /ping is disabled/proxied away.
                ping_note = f"/ping 返回 HTTP {r.status_code}: {_short_text(r.text)}"
                r2 = await client.get(f"{base}/", params={**auth, "query": "SELECT 1"})
                if r2.status_code == 200:
                    version = await self._server_version(client, base, auth)
                    label = f"ClickHouse 在线（HTTP {base}）：{ping_note}，但 SELECT 1 正常"
                    return True, f"{label}，版本 {version}" if version else label
                if r2.status_code in (401, 403):
                    return False, (
                        f"认证失败（HTTP {r2.status_code}）：请检查 user/password 是否正确；"
                        f"目标 {base}{suffix}；原始响应: {_short_text(r2.text)}"
                    )
                return False, (
                    f"ClickHouse 不可用：{ping_note}；GET /?query=SELECT 1 返回 "
                    f"HTTP {r2.status_code}: {_short_text(r2.text)}。"
                    f"请确认 {base} 是 ClickHouse 的 HTTP 端口（默认 8123，或 http_port），"
                    f"且服务已启动{suffix}"
                )
        except httpx.TimeoutException:
            return False, (
                f"连接超时（>{timeout}s）：{base} 无响应。请确认 ClickHouse 与本服务处于同一内网、"
                f"端口已放通（防火墙/安全组），必要时调大超时时间{suffix}"
            )
        except httpx.ConnectError as exc:
            return False, (
                f"无法连接 {base}（{_short_text(exc)}）：连接被拒绝通常是端口不对或服务未启动。"
                "请确认主机可达并使用 HTTP 端口 8123（或 clickhouse 的 http_port），"
                f"不要使用 9000 原生端口{suffix}"
            )
        except httpx.HTTPError as exc:
            return False, f"请求 ClickHouse 失败：{base}（{_short_text(exc)}）"

    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        url = self._base_url()
        qp = self._auth_params()
        qp["query"] = query
        qp["default_format"] = "JSONEachRow"
        async with self._http_client() as c:
            r = await c.post(url, params=qp)
        r.raise_for_status()
        rows = [json.loads(line) for line in r.text.strip().split("\n") if line]
        return QueryResult(rows=rows, raw=rows)

    async def execute_readonly(
        self, query: str, *, timeout_seconds: float = 3.0,
    ) -> QueryResult:
        """Execute one validated read-only SELECT with a hard timeout.

        Used by the Path C trigger (business-volume fluctuation), never by the
        generic admin query route.  Three layers of protection apply:

        * :func:`validate_readonly_sql` — single statement, SELECT-only, no
          DDL/DML and no external-read table functions;
        * ClickHouse ``readonly=2`` — the server rejects data modification even
          if validation were bypassed (2, not 1, so ``max_execution_time`` may
          be supplied as a setting);
        * both an ``httpx`` timeout and server-side ``max_execution_time``.
        """
        sql = validate_readonly_sql(query)
        timeout = max(0.1, float(timeout_seconds))
        qp = self._auth_params()
        qp.update({
            "query": sql,
            "default_format": "JSONEachRow",
            "readonly": "2",
            "max_execution_time": str(max(1, int(round(timeout)))),
        })
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=min(2.0, timeout)),
        ) as client:
            r = await client.post(self._base_url(), params=qp)
        r.raise_for_status()
        rows = [json.loads(line) for line in r.text.strip().split("\n") if line.strip()]
        return QueryResult(rows=rows, raw=rows)


# ═══════════════════════════════════════════════════════════════════════════════
# Kafka
# ═══════════════════════════════════════════════════════════════════════════════


class KafkaAdapter(BaseAdapter):
    type_slug = "kafka"

    async def test_connection(self) -> tuple[bool, str]:
        brokers = self.config.get("brokers", [])
        if isinstance(brokers, str):
            brokers = [b.strip() for b in brokers.split(",") if b.strip()]
        if not brokers:
            return False, "未配置 Kafka brokers"
        try:
            from kafka import KafkaAdminClient
            admin = KafkaAdminClient(bootstrap_servers=brokers, request_timeout_ms=5000)
            topics = admin.list_topics()
            admin.close()
            return True, f"Kafka 连接成功 ({len(topics)} topics)"
        except ImportError:
            return False, "kafka-python 库未安装"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        return QueryResult(rows=[], raw={"note": "Kafka query execution requires a consumer; not yet implemented for sync preview"})


# ═══════════════════════════════════════════════════════════════════════════════
# Generic API
# ═══════════════════════════════════════════════════════════════════════════════


class APIAdapter(BaseAdapter):
    type_slug = "api"

    def _auth_headers(self) -> dict[str, str]:
        auth = self.config.get("auth", {}) or {}
        t = auth.get("type", "none")
        if t == "bearer":
            return {"Authorization": f"Bearer {auth.get('token', '')}"}
        if t == "basic":
            import base64
            creds = base64.b64encode(f"{auth.get('username', '')}:{auth.get('password', '')}".encode()).decode()
            return {"Authorization": f"Basic {creds}"}
        if t == "api_key_header":
            kn = auth.get("key_name", "X-API-Key")
            kv = auth.get("key_value", "")
            return {kn: kv}
        return {}

    def _auth_query_params(self) -> dict[str, str]:
        auth = self.config.get("auth", {}) or {}
        if auth.get("type") == "api_key_query":
            return {auth.get("query_param", "api_key"): auth.get("key_value", "")}
        return {}

    def _url(self) -> str:
        return self.config.get("url", "")

    def _method(self) -> str:
        return (self.config.get("method") or "GET").upper()

    def _headers(self) -> dict[str, str]:
        h = dict(self.config.get("headers") or {})
        h.update(self._auth_headers())
        return h

    def _body(self) -> Any:
        body_cfg = self.config.get("body") or {}
        if body_cfg.get("type") == "json":
            return body_cfg.get("template")
        if body_cfg.get("type") == "form":
            return body_cfg.get("template")  # dict of form fields
        return None

    async def test_connection(self) -> tuple[bool, str]:
        url = self._url()
        if not url:
            return False, "未配置 API URL"
        try:
            async with self._http_client() as c:
                r = await c.request(
                    self._method(),
                    url,
                    headers=self._headers(),
                    json=self._body() if self._method() in ("POST", "PUT", "PATCH") else None,
                    params=self._auth_query_params(),
                )
            return r.status_code < 500, f"HTTP {r.status_code}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        # NEVER allow query string to override the configured URL (SSRF prevention).
        # The query param is used as a JSONPath expression for data extraction,
        # NOT as a URL override.
        url = self._url()
        if not url:
            raise ValueError("API data source URL is not configured")
        async with self._http_client() as c:
            r = await c.request(
                self._method(),
                url,
                headers=self._headers(),
                json=self._body() if self._method() in ("POST", "PUT", "PATCH") else None,
                params=self._auth_query_params(),
            )
        r.raise_for_status()
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"text": r.text}
        return QueryResult(rows=[data] if isinstance(data, dict) else data, raw=data)


# ═══════════════════════════════════════════════════════════════════════════════
# Registry
# ═══════════════════════════════════════════════════════════════════════════════

ADAPTERS: dict[str, type[BaseAdapter]] = {
    "prometheus": PrometheusAdapter,
    "zabbix": ZabbixAdapter,
    "clickhouse": ClickHouseAdapter,
    "kafka": KafkaAdapter,
    "api": APIAdapter,
}


def get_adapter(type_slug: str, config: dict[str, Any]) -> BaseAdapter:
    cls = ADAPTERS.get(type_slug)
    if cls is None:
        raise ValueError(f"不支持的数据源类型: {type_slug}")
    return cls(config)
