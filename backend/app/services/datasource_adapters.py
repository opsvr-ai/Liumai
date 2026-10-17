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
# Prometheus
# ═══════════════════════════════════════════════════════════════════════════════

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
        return (self.config.get("url") or "").rstrip("/")

    async def test_connection(self) -> tuple[bool, str]:
        url = self._base_url()
        if not url:
            return False, "未配置 Prometheus URL"
        try:
            async with self._http_client() as c:
                r = await c.get(f"{url}/api/v1/status/buildinfo", headers=self._auth_headers())
            if r.status_code == 200:
                data = r.json()
                ver = data.get("data", {}).get("version", "unknown")
                return True, f"Prometheus {ver}"
            return False, f"HTTP {r.status_code}: {r.text[:200]}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

    async def execute_query(self, query: str, params: dict | None = None) -> QueryResult:
        url = f"{self._base_url()}/api/v1/query"
        async with self._http_client() as c:
            r = await c.get(url, params={"query": query}, headers=self._auth_headers())
        r.raise_for_status()
        data = r.json()
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
        host = self.config.get("host", "localhost")
        port = self.config.get("port", 8123)
        return f"http://{host}:{port}"

    def _auth_params(self) -> dict[str, str]:
        user = self.config.get("user", "default")
        pwd = self.config.get("password", "")
        params = {"user": user}
        if pwd:
            params["password"] = pwd
        return params

    async def test_connection(self) -> tuple[bool, str]:
        try:
            async with self._http_client() as c:
                r = await c.get(f"{self._base_url()}/ping", params=self._auth_params())
            ok = r.text.strip() == "Ok"
            return ok, f"ClickHouse {'在线' if ok else '异常'}: {r.text.strip()[:100]}"
        except Exception as exc:
            return False, f"连接失败: {exc}"

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
