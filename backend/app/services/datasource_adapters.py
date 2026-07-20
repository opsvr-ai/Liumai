"""Pluggable data-source adapters — one class per source type.

Each adapter knows how to:
- Authenticate (resolve auth config → headers/params)
- Test connectivity (lightweight ping)
- Execute a query (fetch + parse)
"""

from __future__ import annotations

import json
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
        url = query or self._url()  # query override or default
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
