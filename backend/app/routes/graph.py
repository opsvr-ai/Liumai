"""Knowledge graph — read-only, team-scoped aggregation over RCA + alerts.

Endpoints (both ``GET``, no writes, empty data returns an empty 200 payload):

* ``GET /api/graph/overview?service=&limit=200`` — whole-team graph:
  service / alert / root-cause / action nodes plus aggregated edges.
* ``GET /api/graph/neighbors?type=&id=&depth=1`` — one node and its
  neighbourhood (depth 1 or 2) from the same graph snapshot.

Node ids are stable and human-readable::

    service → ``svc:<service name>``
    alert   → ``alert:<alerts.id>``
    cause   → ``cause:<sha1(normalised root cause)[:12]>``
    action  → ``act:<sha1(normalised action text)[:12]>``

Edge weight is an occurrence count, so a cause seen in three reports or an
action recommended for two reports gets a heavier edge.  The source data is
``rca_sessions`` (service), ``rca_reports`` (root cause / impacted services /
recommended actions) and ``alerts`` (service / application).  Every query is
filtered by ``user.team_id`` and only ever issues SELECTs.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.models import Alert, RcaReport, RcaSession, User
from app.models.database import get_db_session
from app.services.alert_pipeline import severity_label

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════════════════════

NodeType = Literal["service", "alert", "cause", "action"]
EdgeType = Literal["had_alert", "root_cause", "action", "similar"]

#: Scan caps keep one graph request cheap even when a team owns years of data.
#: The newest rows win; ``limit`` below only caps the *returned* node count.
ALERT_SCAN_LIMIT = 500
SESSION_SCAN_LIMIT = 500
REPORT_SCAN_LIMIT = 500

#: ``limit`` upper bound for the overview endpoint.
NODE_LIMIT_MAX = 1000

#: One cause shared by many services must not explode into O(n^2) edges.
SIMILAR_SERVICES_PER_CAUSE = 10

#: One report may list many impacted services; keep the graph readable.
IMPACTED_SERVICES_PER_REPORT = 10

#: Ties are broken deterministically by type, then id.
_TYPE_PRIORITY: dict[str, int] = {
    "service": 0,
    "cause": 1,
    "action": 2,
    "alert": 3,
}
_EDGE_PRIORITY: dict[str, int] = {
    "had_alert": 0,
    "root_cause": 1,
    "action": 2,
    "similar": 3,
}

_NODE_PREFIX: dict[str, str] = {
    "service": "svc",
    "alert": "alert",
    "cause": "cause",
    "action": "act",
}

_TITLE_LIMIT = 160


# ═══════════════════════════════════════════════════════════════════════════════
# Response schemas
# ═══════════════════════════════════════════════════════════════════════════════


class GraphNode(BaseModel):
    """One graph vertex.

    ``weight`` is an occurrence count: the service's observations, the number
    of reports sharing a cause, how often an action was recommended, or simply
    ``1`` for a single alert.  ``meta`` is type-specific (see module docs).
    """

    id: str
    type: NodeType
    label: str
    weight: int
    meta: dict[str, Any] = Field(default_factory=dict)


class GraphEdge(BaseModel):
    """Directed, weighted relation between two node ids."""

    source: str
    target: str
    type: EdgeType
    weight: int


class GraphStats(BaseModel):
    """Node counts **in the returned graph** (after ``limit`` is applied)."""

    services: int
    alerts: int
    causes: int
    actions: int


class GraphOverview(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    stats: GraphStats


class GraphNeighbors(BaseModel):
    """Neighbourhood subgraph: ``node`` is always part of ``nodes``."""

    node: GraphNode
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════════════
# Small helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _clean_text(value: Any, limit: int = _TITLE_LIMIT) -> str:
    """Collapse whitespace and truncate; ``None`` becomes ``""``."""
    if value is None:
        return ""
    text = " ".join(str(value).split())
    return text[:limit]


def _clean_service(value: Any) -> str | None:
    """Return a trimmed service name, or ``None`` for blank values."""
    text = _clean_text(value, 255)
    return text or None


def _digest(value: str) -> str:
    """Stable short hash for cause / action node ids."""
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def _as_utc(value: datetime | None) -> datetime | None:
    """Normalise DB datetimes (aware or naive) for comparisons / formatting."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    dt = _as_utc(value)
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def _later(current: datetime | None, candidate: datetime | None) -> datetime | None:
    if candidate is None:
        return current
    if current is None:
        return candidate
    current_utc = _as_utc(current)
    candidate_utc = _as_utc(candidate)
    assert current_utc is not None and candidate_utc is not None
    return candidate if candidate_utc > current_utc else current


def _text_of(value: Any, preferred_keys: tuple[str, ...] = ()) -> str:
    """Best-effort text for a JSON item (str / dict from legacy RCA payloads)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return _clean_text(value, 400)
    if isinstance(value, dict):
        for key in preferred_keys + (
            "action", "title", "content", "summary", "recommendation",
            "description", "name", "service", "service_name", "text",
            "root_cause", "conclusion",
        ):
            raw = value.get(key)
            if isinstance(raw, str) and raw.strip():
                return _clean_text(raw, 400)
        try:
            return _clean_text(json.dumps(value, ensure_ascii=False), 400)
        except (TypeError, ValueError):
            return _clean_text(str(value), 400)
    return _clean_text(str(value), 400)


def _list_texts(values: Any, preferred_keys: tuple[str, ...] = ()) -> list[str]:
    """Flatten a JSONB list (or a single scalar) into non-empty strings."""
    if values is None:
        items: list[Any] = []
    elif isinstance(values, (list, tuple)):
        items = list(values)
    else:
        items = [values]
    out: list[str] = []
    for item in items:
        text = _text_of(item, preferred_keys)
        if text:
            out.append(text)
    return out


def _service_of_alert(alert: Alert) -> str | None:
    """Alert → service, matching the platform convention (application → CI name)."""
    return _clean_service(alert.ci_application) or _clean_service(alert.ci_name)


def _service_of_report(report: RcaReport, session: RcaSession) -> str | None:
    return (
        _clean_service(report.service_name)
        or _clean_service(session.service_name)
    )


def _alert_label(alert: Alert) -> str:
    return _clean_text(
        alert.content or alert.alert_uid or alert.metric or f"告警 #{alert.id}"
    )


def _alert_severity(alert: Alert) -> str | None:
    if alert.severity_level is not None:
        return severity_label(alert.severity_level)
    return alert.severity or None


# ═══════════════════════════════════════════════════════════════════════════════
# Graph builder
# ═══════════════════════════════════════════════════════════════════════════════


class _GraphBuilder:
    """Accumulates nodes and aggregated (source, target, type) edge weights."""

    def __init__(self) -> None:
        self.nodes: dict[str, GraphNode] = {}
        self.edges: dict[tuple[str, str, str], int] = {}

    def add_node(self, node: GraphNode) -> None:
        self.nodes.setdefault(node.id, node)

    def add_edge(self, source: str, target: str, edge_type: str, weight: int = 1) -> None:
        if not source or not target or source == target or weight <= 0:
            return
        key = (source, target, edge_type)
        self.edges[key] = self.edges.get(key, 0) + weight


async def _build_graph(
    db: AsyncSession,
    team_id: int,
    service: str | None,
) -> _GraphBuilder:
    """Read the team's alerts / sessions / reports and materialise the graph.

    All rows are newest-first and capped by the ``*_SCAN_LIMIT`` constants.
    Nothing is written; the DB session is only used for SELECTs.
    """
    pattern = f"%{service.strip()}%" if service else None

    # ── alerts ────────────────────────────────────────────────────────────
    alert_stmt = (
        select(Alert)
        .where(Alert.team_id == team_id)
        .order_by(
            func.coalesce(Alert.alert_time, Alert.created_at).desc(),
            Alert.id.desc(),
        )
        .limit(ALERT_SCAN_LIMIT)
    )
    if pattern:
        alert_stmt = alert_stmt.where(
            or_(
                Alert.ci_application.ilike(pattern),
                Alert.ci_name.ilike(pattern),
            )
        )
    alerts = list((await db.execute(alert_stmt)).scalars())

    # ── RCA sessions ──────────────────────────────────────────────────────
    session_stmt = (
        select(RcaSession)
        .where(RcaSession.team_id == team_id)
        .order_by(RcaSession.created_at.desc(), RcaSession.id.desc())
        .limit(SESSION_SCAN_LIMIT)
    )
    if pattern:
        session_stmt = session_stmt.where(RcaSession.service_name.ilike(pattern))
    sessions = list((await db.execute(session_stmt)).scalars())

    # ── structured reports (joined to their owning session for tenancy) ──
    report_stmt = (
        select(RcaReport, RcaSession)
        .join(RcaSession, RcaSession.id == RcaReport.session_id)
        .where(RcaSession.team_id == team_id)
        .order_by(RcaReport.created_at.desc(), RcaReport.id.desc())
        .limit(REPORT_SCAN_LIMIT)
    )
    if pattern:
        report_stmt = report_stmt.where(
            or_(
                RcaReport.service_name.ilike(pattern),
                RcaSession.service_name.ilike(pattern),
            )
        )
    report_rows = (await db.execute(report_stmt)).all()

    # ── pass 1: registries ────────────────────────────────────────────────
    services: dict[str, dict[str, Any]] = {}
    causes: dict[str, dict[str, Any]] = {}
    actions: dict[str, dict[str, Any]] = {}
    report_links: list[dict[str, Any]] = []

    def service_entry(name: str) -> dict[str, Any]:
        key = name.casefold()
        entry = services.get(key)
        if entry is None:
            entry = {
                "names": set(),
                "alerts": 0,
                "sessions": 0,
                "reports": 0,
                "last_seen": None,
            }
            services[key] = entry
        entry["names"].add(name)
        return entry

    def service_id(key: str) -> str:
        entry = services[key]
        display = min(entry["names"])
        return f"svc:{display}"

    def register_cause(text: str, service_key: str, confidence: float | None) -> str:
        label = _clean_text(text, 400)
        key = label.casefold()
        entry = causes.get(key)
        if entry is None:
            entry = {
                "label": label,
                "count": 0,
                "services": set(),
                "confidence_sum": 0.0,
                "confidence_n": 0,
                "service_counts": {},
            }
            causes[key] = entry
        entry["count"] += 1
        entry["services"].add(service_key)
        entry["service_counts"][service_key] = (
            entry["service_counts"].get(service_key, 0) + 1
        )
        if confidence is not None:
            entry["confidence_sum"] += confidence
            entry["confidence_n"] += 1
        return f"cause:{_digest(key)}"

    def register_action(text: str, service_key: str) -> str:
        label = _clean_text(text, 400)
        key = label.casefold()
        entry = actions.get(key)
        if entry is None:
            entry = {"label": label, "count": 0, "services": set()}
            actions[key] = entry
        entry["count"] += 1
        entry["services"].add(service_key)
        return f"act:{_digest(key)}"

    # alerts
    alert_nodes: list[tuple[Alert, str]] = []  # (row, service key)
    for alert in alerts:
        name = _service_of_alert(alert)
        if not name:
            continue  # unlinked alerts cannot be placed on the graph
        entry = service_entry(name)
        key = name.casefold()
        entry["alerts"] += 1
        entry["last_seen"] = _later(
            entry["last_seen"], alert.alert_time or alert.created_at
        )
        alert_nodes.append((alert, key))

    # sessions (service nodes even when no report exists yet)
    for session in sessions:
        name = _clean_service(session.service_name)
        if not name:
            continue
        entry = service_entry(name)
        entry["sessions"] += 1
        entry["last_seen"] = _later(entry["last_seen"], session.created_at)

    # reports: causes, actions, impacted services
    for report, session in report_rows:
        name = _service_of_report(report, session)
        if not name:
            continue
        entry = service_entry(name)
        key = name.casefold()
        entry["reports"] += 1
        entry["last_seen"] = _later(entry["last_seen"], report.created_at)

        cause_text = _clean_text(report.root_cause, 400)
        cause_id = (
            register_cause(cause_text, key, report.confidence)
            if cause_text
            else None
        )

        action_ids: list[str] = []
        seen_actions: set[str] = set()
        for action_text in _list_texts(report.recommended_actions):
            action_key = action_text.casefold()
            if action_key in seen_actions:
                continue  # count an action once per report
            seen_actions.add(action_key)
            action_ids.append(register_action(action_text, key))

        impacted: list[str] = []
        for impacted_text in _list_texts(
            report.impacted_services,
            ("name", "service", "service_name", "title"),
        ):
            impacted_name = _clean_service(impacted_text)
            if not impacted_name or impacted_name.casefold() == key:
                continue
            impacted_entry = service_entry(impacted_name)
            impacted_entry["reports"] += 1
            impacted_entry["last_seen"] = _later(
                impacted_entry["last_seen"], report.created_at
            )
            impacted.append(impacted_name.casefold())
            if len(impacted) >= IMPACTED_SERVICES_PER_REPORT:
                break

        report_links.append(
            {
                "service": key,
                "cause_id": cause_id,
                "action_ids": action_ids,
                "impacted": impacted,
            }
        )

    builder = _GraphBuilder()

    # ── pass 2: nodes ─────────────────────────────────────────────────────
    for key, entry in services.items():
        display = min(entry["names"])
        weight = entry["alerts"] + entry["sessions"] + entry["reports"]
        builder.add_node(
            GraphNode(
                id=f"svc:{display}",
                type="service",
                label=display,
                weight=max(1, weight),
                meta={
                    "alerts": entry["alerts"],
                    "sessions": entry["sessions"],
                    "reports": entry["reports"],
                    "last_seen": _iso(entry["last_seen"]),
                },
            )
        )

    for alert, key in alert_nodes:
        builder.add_node(
            GraphNode(
                id=f"alert:{alert.id}",
                type="alert",
                label=_alert_label(alert),
                weight=1,
                meta={
                    "service": min(services[key]["names"]),
                    "severity": _alert_severity(alert),
                    "status": alert.status,
                    "time": _iso(alert.alert_time or alert.created_at),
                },
            )
        )

    for key, entry in causes.items():
        service_names = sorted(
            min(services[svc_key]["names"])
            for svc_key in entry["services"]
            if svc_key in services
        )
        avg_confidence = (
            round(entry["confidence_sum"] / entry["confidence_n"], 2)
            if entry["confidence_n"]
            else None
        )
        builder.add_node(
            GraphNode(
                id=f"cause:{_digest(key)}",
                type="cause",
                label=_clean_text(entry["label"], _TITLE_LIMIT),
                weight=entry["count"],
                meta={
                    "occurrences": entry["count"],
                    "services": service_names,
                    "avg_confidence": avg_confidence,
                },
            )
        )

    for key, entry in actions.items():
        service_names = sorted(
            min(services[svc_key]["names"])
            for svc_key in entry["services"]
            if svc_key in services
        )
        builder.add_node(
            GraphNode(
                id=f"act:{_digest(key)}",
                type="action",
                label=_clean_text(entry["label"], _TITLE_LIMIT),
                weight=entry["count"],
                meta={"occurrences": entry["count"], "services": service_names},
            )
        )

    # ── pass 3: edges ─────────────────────────────────────────────────────
    for alert, key in alert_nodes:
        builder.add_edge(service_id(key), f"alert:{alert.id}", "had_alert")

    for link in report_links:
        svc_id = service_id(link["service"])
        cause_id = link["cause_id"]
        if cause_id:
            builder.add_edge(svc_id, cause_id, "root_cause")
        for action_id in link["action_ids"]:
            # Prefer cause → action; fall back to service → action when the
            # report has actions but no root cause text.
            builder.add_edge(cause_id or svc_id, action_id, "action")
        for impacted_key in link["impacted"]:
            if impacted_key not in services:
                continue
            other_id = service_id(impacted_key)
            source, target = sorted((svc_id, other_id))
            builder.add_edge(source, target, "similar")

    # Services sharing a root cause are "similar" too (weight = shared causes).
    for entry in causes.values():
        service_counts: dict[str, int] = entry["service_counts"]
        if len(service_counts) < 2:
            continue
        ranked = sorted(
            service_counts.items(),
            key=lambda pair: (
                -pair[1],
                min(services[pair[0]]["names"]) if pair[0] in services else pair[0],
            ),
        )[:SIMILAR_SERVICES_PER_CAUSE]
        for index, (left_key, _) in enumerate(ranked):
            for right_key, _ in ranked[index + 1:]:
                if left_key not in services or right_key not in services:
                    continue
                source, target = sorted(
                    (service_id(left_key), service_id(right_key))
                )
                builder.add_edge(source, target, "similar")

    if service:
        _restrict_to_service(builder, service)

    return builder


def _restrict_to_service(builder: _GraphBuilder, service: str) -> None:
    """Keep only services matching *service* plus their alerts / causes / actions.

    When the caller filters by service they expect that service's subgraph, not
    unrelated ``impacted_services`` context.  Edges are kept only when both
    endpoints survive the cut.
    """
    wanted = service.casefold()
    kept = {
        node.id
        for node in builder.nodes.values()
        if node.type == "service" and wanted in node.id.split(":", 1)[-1].casefold()
    }
    if not kept:
        builder.nodes = {}
        builder.edges = {}
        return

    # 1) alerts and causes directly attached to a kept service
    for (source, target, edge_type) in list(builder.edges):
        if source in kept and edge_type in ("had_alert", "root_cause"):
            kept.add(target)
    # 2) actions attached to a kept cause (or directly to a kept service)
    for (source, target, edge_type) in list(builder.edges):
        if edge_type == "action" and source in kept:
            kept.add(target)

    builder.nodes = {
        node_id: node for node_id, node in builder.nodes.items() if node_id in kept
    }
    builder.edges = {
        key: weight
        for key, weight in builder.edges.items()
        if key[0] in kept and key[1] in kept
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Ordering / projection
# ═══════════════════════════════════════════════════════════════════════════════


def _ordered_nodes(nodes: dict[str, GraphNode]) -> list[GraphNode]:
    """Deterministic node order: services → causes → actions → alerts.

    Structural nodes come first so ``limit`` keeps the knowledge skeleton when
    a team has hundreds of individual alerts; alerts fill the remaining slots,
    newest first.
    """
    services = sorted(
        (node for node in nodes.values() if node.type == "service"),
        key=lambda node: (-node.weight, node.id),
    )
    causes = sorted(
        (node for node in nodes.values() if node.type == "cause"),
        key=lambda node: (-node.weight, node.id),
    )
    actions = sorted(
        (node for node in nodes.values() if node.type == "action"),
        key=lambda node: (-node.weight, node.id),
    )
    alerts = sorted(
        (node for node in nodes.values() if node.type == "alert"),
        key=lambda node: (
            node.weight,
            str(node.meta.get("time") or ""),
            node.id,
        ),
        reverse=True,
    )
    return [*services, *causes, *actions, *alerts]


def _select_nodes(nodes: dict[str, GraphNode], limit: int) -> list[GraphNode]:
    return _ordered_nodes(nodes)[:limit]


def _project_edges(
    builder: _GraphBuilder,
    node_ids: set[str] | None = None,
) -> list[GraphEdge]:
    edges = [
        GraphEdge(source=source, target=target, type=edge_type, weight=weight)
        for (source, target, edge_type), weight in builder.edges.items()
        if node_ids is None or (source in node_ids and target in node_ids)
    ]
    edges.sort(
        key=lambda edge: (
            -edge.weight,
            _EDGE_PRIORITY[edge.type],
            edge.source,
            edge.target,
        )
    )
    return edges


def _stats(nodes: list[GraphNode]) -> GraphStats:
    return GraphStats(
        services=sum(1 for node in nodes if node.type == "service"),
        alerts=sum(1 for node in nodes if node.type == "alert"),
        causes=sum(1 for node in nodes if node.type == "cause"),
        actions=sum(1 for node in nodes if node.type == "action"),
    )


def _find_node(
    nodes: dict[str, GraphNode],
    node_type: NodeType,
    raw_id: str,
) -> GraphNode | None:
    """Resolve an exact node id, a bare value, or a case-insensitive suffix."""
    raw_id = raw_id.strip()
    if not raw_id:
        return None
    known_prefixes = tuple(f"{prefix}:" for prefix in _NODE_PREFIX.values())
    if raw_id.startswith(known_prefixes):
        node = nodes.get(raw_id)
        return node if node is not None and node.type == node_type else None

    node = nodes.get(f"{_NODE_PREFIX[node_type]}:{raw_id}")
    if node is not None:
        return node

    wanted = raw_id.casefold()
    matches = [
        candidate
        for candidate in nodes.values()
        if candidate.type == node_type
        and candidate.id.split(":", 1)[-1].casefold() == wanted
    ]
    return sorted(matches, key=lambda candidate: candidate.id)[0] if matches else None


def _neighbourhood(
    builder: _GraphBuilder,
    node: GraphNode,
    depth: int,
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """BFS up to *depth* hops; the start node is always included."""
    adjacency: dict[str, set[str]] = {}
    for source, target, _edge_type in builder.edges:
        adjacency.setdefault(source, set()).add(target)
        adjacency.setdefault(target, set()).add(source)

    distance: dict[str, int] = {node.id: 0}
    frontier = [node.id]
    for hop in range(1, depth + 1):
        next_frontier: list[str] = []
        for current in frontier:
            for neighbour in sorted(adjacency.get(current, ())):
                if neighbour in distance:
                    continue
                distance[neighbour] = hop
                next_frontier.append(neighbour)
        frontier = next_frontier
        if not frontier:
            break

    nodes = [
        builder.nodes[node_id]
        for node_id in distance
        if node_id in builder.nodes
    ]
    nodes.sort(
        key=lambda item: (
            distance[item.id],
            -item.weight,
            _TYPE_PRIORITY[item.type],
            item.id,
        )
    )
    edges = _project_edges(builder, set(distance))
    return nodes, edges


# ═══════════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/overview", response_model=GraphOverview)
async def graph_overview(
    service: str | None = Query(
        None,
        max_length=255,
        description="按服务名过滤（不区分大小写，子串匹配）",
    ),
    limit: int = Query(
        200,
        ge=1,
        le=NODE_LIMIT_MAX,
        description="返回节点总数上限",
    ),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> GraphOverview:
    """Read-only team knowledge graph (services / alerts / causes / actions)."""
    builder = await _build_graph(db, user.team_id, _clean_service(service))
    nodes = _select_nodes(builder.nodes, limit)
    node_ids = {node.id for node in nodes}
    return GraphOverview(
        nodes=nodes,
        edges=_project_edges(builder, node_ids),
        stats=_stats(nodes),
    )


@router.get("/neighbors", response_model=GraphNeighbors)
async def graph_neighbors(
    type: NodeType = Query(..., description="service | alert | cause | action"),
    id: str = Query(
        ...,
        min_length=1,
        max_length=512,
        description="节点 id（如 svc:nginx / alert:12 / cause:ab12cd34ef56），也可传裸值",
    ),
    depth: int = Query(1, ge=1, le=2, description="邻居跳数（1~2）"),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> GraphNeighbors:
    """Return one node plus its depth-1/2 neighbourhood from the same graph."""
    builder = await _build_graph(db, user.team_id, None)
    node = _find_node(builder.nodes, type, id)
    if node is None and type == "service":
        # A service-filtered overview may have surfaced a service outside the
        # unfiltered scan window; retry with that service as the SQL filter.
        hint = _clean_service(id.split(":", 1)[-1])
        if hint:
            builder = await _build_graph(db, user.team_id, hint)
            node = _find_node(builder.nodes, type, id)
    if node is None:
        # Missing and cross-team nodes are indistinguishable (no probing).
        raise HTTPException(status_code=404, detail="节点不存在")
    nodes, edges = _neighbourhood(builder, node, depth)
    return GraphNeighbors(node=node, nodes=nodes, edges=edges)
