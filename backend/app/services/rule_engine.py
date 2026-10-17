"""Alert-rule matching engine (dependency-free condition evaluator).

Background
----------
``AlertRule`` used to be pure CRUD: the webhook ingestion pipeline
(``alert_pipeline.ingest_alert``) never queried the table, so an operator could
configure a rule on the rules page and nothing would ever happen.  This module
closes that gap.

Condition model
---------------
A rule's ``conditions`` JSONB column holds an **array of condition rows**::

    [{"field": "severity_level", "op": "lte", "value": "2"},
     {"field": "content", "op": "contains", "value": "CPU"}]

All rows are combined with **AND** (a rule only matches when every row
matches).  Supported operators:

    eq / neq / contains / in / gte / lte / regex

Field whitelist (aliases such as ``level`` / ``application`` / ``service`` are
normalised to the canonical name):

    severity / severity_level / ci_name / ci_application / service_name /
    ip / source / metric / content

Semantics:

* ``severity`` – matches the raw severity string **or** any alias of the mapped
  1-5 level (``critical``/``高``/``2``/…); ``gte``/``lte`` compare the numeric
  level.  This lets both ``severity eq high`` and ``severity gte 2`` work.
* ``severity_level`` – strict 1-5 numeric comparisons (values such as
  ``high`` / ``重要`` are accepted and mapped to their level).
* other fields – plain string comparisons on the normalised (lower-cased,
  whitespace-collapsed) value.
* ``in`` – comma-separated string or JSON array on the rule side, matched
  against the alert value.
* ``regex`` – Python ``re`` (case-insensitive ``search``).  A pattern that does
  not compile makes the condition (therefore the rule) **not match**, and a
  warning is logged.

Abuse limits: at most :data:`MAX_CONDITIONS` conditions per rule and at most
:data:`MAX_VALUE_LENGTH` characters per value (``in`` may carry up to
:data:`MAX_IN_VALUES` values).  A rule with no (parseable) conditions is treated
as *never matching* instead of matching everything — a "match all" rule would
let a half-configured rule trigger RCA on the entire alert stream.

Legacy free-text conditions
----------------------------
Before this module the UI posted free-text ``condition_expr`` values such as
``severity >= "high" AND source == "prometheus"``.  Stored conditions may
therefore still be a string (or an array of strings).  They are parsed on a
best-effort basis by :func:`parse_legacy_conditions`; when a fragment cannot be
parsed the rule simply does not match (and a warning is logged).  ``>`` / ``<``
are approximated as ``gte`` / ``lte`` because the engine has no strict
comparison operators.

Caching
-------
Enabled rules are cached per team for :data:`RULE_CACHE_TTL_SECONDS` seconds so
a chatty webhook does not issue one query per alert.  The rules CRUD API calls
:func:`invalidate_rule_cache` after every mutation, so in-process changes take
effect immediately; other workers converge within the TTL.
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AlertRule

# ═══════════════════════════════════════════════════════════════════════════════
# Limits & vocabulary
# ═══════════════════════════════════════════════════════════════════════════════

MAX_CONDITIONS = 20
MAX_VALUE_LENGTH = 200
MAX_IN_VALUES = 20
MAX_RULES_PER_TEAM = 200
RULE_CACHE_TTL_SECONDS = 15.0

FIELD_WHITELIST: tuple[str, ...] = (
    "severity",
    "severity_level",
    "ci_name",
    "ci_application",
    "service_name",
    "ip",
    "source",
    "metric",
    "content",
)

FIELD_LABELS: dict[str, str] = {
    "severity": "级别",
    "severity_level": "级别数值",
    "ci_name": "CI 名称",
    "ci_application": "CI 应用",
    "service_name": "服务名",
    "ip": "IP",
    "source": "告警来源",
    "metric": "指标",
    "content": "告警内容",
}

#: Lower-cased alias -> canonical field name.
FIELD_ALIASES: dict[str, str] = {
    "severity": "severity",
    "level": "severity_level",
    "severitylevel": "severity_level",
    "severity_level": "severity_level",
    "sev": "severity",
    "ciname": "ci_name",
    "ci_name": "ci_name",
    "hostname": "ci_name",
    "host": "ci_name",
    "ci": "ci_name",
    "ciapplication": "ci_application",
    "ci_application": "ci_application",
    "application": "ci_application",
    "app": "ci_application",
    "service": "service_name",
    "service_name": "service_name",
    "servicename": "service_name",
    "ip": "ip",
    "host_ip": "ip",
    "hostip": "ip",
    "source": "source",
    "source_name": "source",
    "sourcename": "source",
    "alert_source": "source",
    "metric": "metric",
    "kpi": "metric",
    "kpiname": "metric",
    "content": "content",
    "message": "content",
    "msg": "content",
    "summary": "content",
    "alertcontent": "content",
    # Chinese labels used by the rules page
    "级别": "severity",
    "级别数值": "severity_level",
    "ci名称": "ci_name",
    "应用": "ci_application",
    "服务名": "service_name",
    "来源": "source",
    "指标": "metric",
    "内容": "content",
}

SUPPORTED_OPS: tuple[str, ...] = ("eq", "neq", "contains", "in", "gte", "lte", "regex")

OP_LABELS: dict[str, str] = {
    "eq": "等于",
    "neq": "不等于",
    "contains": "包含",
    "in": "属于",
    "gte": "≥",
    "lte": "≤",
    "regex": "正则匹配",
}

#: Lower-cased operator/alias -> canonical operator.
OP_ALIASES: dict[str, str] = {
    "eq": "eq",
    "=": "eq",
    "==": "eq",
    "equals": "eq",
    "neq": "neq",
    "ne": "neq",
    "!=": "neq",
    "<>": "neq",
    "not_eq": "neq",
    "not_equals": "neq",
    "contains": "contains",
    "contain": "contains",
    "like": "contains",
    "in": "in",
    "oneof": "in",
    "in_list": "in",
    "gte": "gte",
    ">=": "gte",
    ">": "gte",
    "ge": "gte",
    "lte": "lte",
    "<=": "lte",
    "<": "lte",
    "le": "lte",
    "regex": "regex",
    "regexp": "regex",
    "matches": "regex",
    "=~": "regex",
    "~": "regex",
}

SEVERITY_LABELS: dict[int, str] = {1: "严重", 2: "重要", 3: "一般", 4: "告警", 5: "提示"}

#: Aliases (lower-cased) accepted for each severity level.
SEVERITY_ALIASES: dict[int, tuple[str, ...]] = {
    1: ("1", "严重", "紧急", "critical", "fatal", "urgent", "p0", "p1"),
    2: ("2", "重要", "高", "high", "major", "error", "p2"),
    3: ("3", "一般", "中", "medium", "minor", "p3"),
    4: ("4", "告警", "低", "warn", "warning", "low", "p4"),
    5: ("5", "提示", "info", "notice", "p5"),
}

_SEVERITY_TO_LEVEL: dict[str, int] = {
    alias: level for level, aliases in SEVERITY_ALIASES.items() for alias in aliases
}

_WHITESPACE_RE = re.compile(r"\s+")
_AND_SPLIT_RE = re.compile(r"\s+(?:AND|且)\s+", re.IGNORECASE)
_LEGACY_CLAUSE_RE = re.compile(
    r"^\s*(?P<field>[A-Za-z_][\w.]*|[\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*"
    r"(?P<op>>=|<=|==|!=|=~|~|=|>|<|(?:contains|in|eq|neq|gte|lte|regex|ne|ge|le)(?=\s))"
    r"\s*(?P<value>.+?)\s*$",
    re.IGNORECASE,
)


class ConditionValidationError(ValueError):
    """Raised when a condition payload cannot be normalised/compiled."""


# ═══════════════════════════════════════════════════════════════════════════════
# Normalisation helpers
# ═══════════════════════════════════════════════════════════════════════════════


def normalize_text(value: Any) -> str:
    """Lower-case, trim and collapse whitespace (``None`` -> ``""``)."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    text = value if isinstance(value, str) else str(value)
    return _WHITESPACE_RE.sub(" ", text.strip()).casefold()


def _display_value(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        return "、".join(str(v) for v in value)
    return str(value)


def _strip_quotes(text: str) -> str:
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def normalize_field(value: Any) -> str:
    """Resolve a user supplied field name to the canonical whitelist entry."""
    key = normalize_text(value)
    if not key:
        raise ConditionValidationError("条件缺少字段名")
    canonical = FIELD_ALIASES.get(key, key)
    if canonical not in FIELD_WHITELIST:
        raise ConditionValidationError(
            f"不支持的字段 {value!r}，可选：{', '.join(FIELD_WHITELIST)}"
        )
    return canonical


def normalize_op(value: Any) -> str:
    """Resolve a user supplied operator to the canonical operator."""
    key = normalize_text(value)
    if not key:
        raise ConditionValidationError("条件缺少操作符")
    canonical = OP_ALIASES.get(key)
    if canonical is None or canonical not in SUPPORTED_OPS:
        raise ConditionValidationError(
            f"不支持的操作符 {value!r}，可选：{', '.join(SUPPORTED_OPS)}"
        )
    return canonical


def _to_level(value: Any) -> int:
    """Map a severity value (number / digit / alias) to the 1-5 Tarsier scale."""
    if isinstance(value, bool):
        raise ConditionValidationError(f"无法将取值 {value!r} 映射为 1-5 的严重级别")
    if isinstance(value, (int, float)):
        number = int(value)
        if 1 <= number <= 5:
            return number
        raise ConditionValidationError(f"严重级别 {value!r} 超出 1-5 范围")
    key = normalize_text(value)
    if key.isdigit():
        number = int(key)
        if 1 <= number <= 5:
            return number
        raise ConditionValidationError(f"严重级别 {value!r} 超出 1-5 范围")
    level = _SEVERITY_TO_LEVEL.get(key)
    if level is None:
        raise ConditionValidationError(f"无法将取值 {value!r} 映射为 1-5 的严重级别")
    return level


def _normalize_scalar(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        raise ConditionValidationError("该操作符只接受单一取值")
    if isinstance(value, Mapping):
        raise ConditionValidationError("条件取值不能是对象")
    text = "" if value is None else (value if isinstance(value, str) else str(value))
    text = _WHITESPACE_RE.sub(" ", text.strip())
    if not text:
        raise ConditionValidationError("条件取值不能为空")
    if len(text) > MAX_VALUE_LENGTH:
        raise ConditionValidationError(f"条件取值长度不能超过 {MAX_VALUE_LENGTH} 个字符")
    return text


def _normalize_in_values(value: Any) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        if len(text) >= 2 and text[0] == "[" and text[-1] == "]":
            text = text[1:-1]
        elif len(text) >= 2 and text[0] == "(" and text[-1] == ")":
            text = text[1:-1]
        items = [part.strip() for part in re.split(r"[,，;；]", text) if part.strip()]
    elif isinstance(value, (list, tuple, set)):
        items = []
        for item in value:
            items.append(_normalize_scalar(item))
    else:
        raise ConditionValidationError("操作符 in 需要一个取值列表，例如 \"a,b,c\"")

    cleaned: list[str] = []
    for item in items:
        text = _strip_quotes(str(item).strip())
        if not text:
            continue
        if len(text) > MAX_VALUE_LENGTH:
            raise ConditionValidationError(
                f"条件取值长度不能超过 {MAX_VALUE_LENGTH} 个字符"
            )
        cleaned.append(text)
    if not cleaned:
        raise ConditionValidationError("操作符 in 至少需要一个取值")
    if len(cleaned) > MAX_IN_VALUES:
        raise ConditionValidationError(f"操作符 in 最多支持 {MAX_IN_VALUES} 个取值")
    return cleaned


def normalize_condition(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Normalise a single condition row to ``{field, op, value}``."""
    if not isinstance(raw, Mapping):
        raise ConditionValidationError("条件必须是 {field, op, value} 对象")
    field = normalize_field(raw.get("field", raw.get("name")))
    op = normalize_op(raw.get("op", raw.get("operator", raw.get("comparator"))))
    value = raw.get("value")

    if op in ("gte", "lte") and field not in ("severity", "severity_level"):
        raise ConditionValidationError(
            "操作符 gte/lte 仅适用于 severity / severity_level 字段"
        )

    if op == "in":
        canonical_value: Any = _normalize_in_values(value)
    else:
        canonical_value = _normalize_scalar(value)

    # Fail fast when a severity comparison can never be resolved.
    if field == "severity_level" and op in ("eq", "neq", "gte", "lte"):
        _to_level(canonical_value)
    elif field == "severity" and op in ("gte", "lte"):
        _to_level(canonical_value)
    elif field == "severity_level" and op == "in":
        for item in canonical_value:
            _to_level(item)

    return {"field": field, "op": op, "value": canonical_value}


def _parse_legacy_value(op: str, raw: str) -> Any:
    text = raw.strip()
    if op == "in":
        if len(text) >= 2 and text[0] == "[" and text[-1] == "]":
            text = text[1:-1]
        elif len(text) >= 2 and text[0] == "(" and text[-1] == ")":
            text = text[1:-1]
        parts = [
            _strip_quotes(part.strip())
            for part in re.split(r"[,，;；]", text)
            if part.strip()
        ]
        if not parts:
            raise ConditionValidationError("in 条件缺少取值")
        return parts
    return _strip_quotes(text)


def parse_legacy_conditions(expression: str) -> list[dict[str, Any]]:
    """Best-effort parser for the pre-structured free-text ``condition_expr``.

    Supports ``field op value`` fragments joined by ``AND`` (or ``且``), e.g.
    ``severity >= "high" AND source == "prometheus"``.  Anything that cannot be
    parsed raises :class:`ConditionValidationError`.
    """
    text = str(expression or "").strip()
    if not text:
        return []
    if len(text) > MAX_CONDITIONS * (MAX_VALUE_LENGTH + 40):
        raise ConditionValidationError("旧版条件表达式过长")

    clauses = [clause.strip() for clause in _AND_SPLIT_RE.split(text) if clause.strip()]
    if not clauses:
        return []
    if len(clauses) > MAX_CONDITIONS:
        raise ConditionValidationError(f"条件数量不能超过 {MAX_CONDITIONS} 条")

    rows: list[dict[str, Any]] = []
    for clause in clauses:
        match = _LEGACY_CLAUSE_RE.match(clause)
        if not match:
            raise ConditionValidationError(f"无法解析旧版条件片段：{clause!r}")
        op = OP_ALIASES.get(normalize_text(match.group("op")))
        if op is None:  # pragma: no cover - defensive, regex is the source of truth
            raise ConditionValidationError(f"不支持的操作符：{match.group('op')!r}")
        value = _parse_legacy_value(op, match.group("value"))
        rows.append(
            normalize_condition(
                {"field": match.group("field"), "op": op, "value": value}
            )
        )
    return rows


def normalize_conditions(conditions: Any) -> list[dict[str, Any]]:
    """Normalise a stored/requested conditions payload.

    Accepts a list of condition rows, a single row, a free-text expression or a
    list mixing rows and legacy strings.  Never silently drops a fragment: an
    unparseable row raises :class:`ConditionValidationError`.
    """
    if conditions is None:
        return []
    if isinstance(conditions, str):
        return parse_legacy_conditions(conditions)
    if isinstance(conditions, Mapping):
        return [normalize_condition(conditions)]
    if isinstance(conditions, (list, tuple)):
        if len(conditions) > MAX_CONDITIONS:
            raise ConditionValidationError(f"条件数量不能超过 {MAX_CONDITIONS} 条")
        rows: list[dict[str, Any]] = []
        for index, item in enumerate(conditions):
            if item is None:
                continue
            try:
                if isinstance(item, str):
                    rows.extend(parse_legacy_conditions(item))
                elif isinstance(item, Mapping):
                    rows.append(normalize_condition(item))
                else:
                    raise ConditionValidationError(
                        f"条件必须是对象或字符串，收到 {type(item).__name__}"
                    )
            except ConditionValidationError as exc:
                raise ConditionValidationError(
                    f"第 {index + 1} 个条件无效：{exc}"
                ) from exc
        if len(rows) > MAX_CONDITIONS:
            raise ConditionValidationError(f"条件数量不能超过 {MAX_CONDITIONS} 条")
        return rows
    raise ConditionValidationError("conditions 必须是条件行数组或自由文本表达式")


def legacy_expression(conditions: Any) -> str | None:
    """Return the original free-text expression, if the payload was legacy."""
    if isinstance(conditions, str):
        text = conditions.strip()
        return text or None
    if isinstance(conditions, (list, tuple)):
        parts = [
            str(item).strip()
            for item in conditions
            if isinstance(item, str) and str(item).strip()
        ]
        return " AND ".join(parts) or None
    return None


def describe_conditions(conditions: Any) -> str:
    """Human readable one-line summary (used in logs / the RCA timeline)."""
    try:
        rows = normalize_conditions(conditions)
    except ConditionValidationError as exc:
        return f"无效条件：{exc}"
    if not rows:
        return "无条件（永不命中）"
    parts = []
    for row in rows:
        field = FIELD_LABELS.get(row["field"], row["field"])
        op = OP_LABELS.get(row["op"], row["op"])
        value = row["value"]
        if row["op"] == "regex":
            shown = f"/{_display_value(value)}/i"
        else:
            shown = _display_value(value)
        parts.append(f"{field} {op} {shown}")
    return " 且 ".join(parts)


# ═══════════════════════════════════════════════════════════════════════════════
# Alert context & evaluation
# ═══════════════════════════════════════════════════════════════════════════════


def build_alert_context(
    normalized: Mapping[str, Any], level: int
) -> dict[str, list[str]]:
    """Build the normalised matching context for a normalised alert."""
    try:
        severity_level = max(1, min(5, int(level)))
    except (TypeError, ValueError):
        severity_level = 4

    raw_severity = normalize_text(normalized.get("severity"))
    severity_candidates = {
        normalize_text(alias) for alias in SEVERITY_ALIASES[severity_level]
    }
    if raw_severity:
        severity_candidates.add(raw_severity)

    ci_application = normalize_text(normalized.get("ci_application"))
    ci_name = normalize_text(normalized.get("ci_name"))
    source = normalize_text(normalized.get("source"))
    service_name = ci_application or ci_name or source

    return {
        "severity": sorted(severity_candidates),
        "severity_level": [str(severity_level)],
        "ci_name": [ci_name] if ci_name else [],
        "ci_application": [ci_application] if ci_application else [],
        "service_name": [service_name] if service_name else [],
        "ip": [normalize_text(normalized.get("ip"))],
        "source": [source],
        "metric": [normalize_text(normalized.get("metric"))],
        "content": [normalize_text(normalized.get("content"))],
    }


@dataclass(frozen=True)
class CompiledCondition:
    """A validated condition row with pre-computed operands / regex."""

    field: str
    op: str
    value: Any
    operand: int | list[int] | None = None
    pattern: re.Pattern[str] | None = None


def compile_condition(row: Mapping[str, Any]) -> CompiledCondition:
    """Validate *row* and pre-compute everything the matcher needs.

    Raises :class:`ConditionValidationError` for unsupported fields/operators,
    over-long values and invalid regular expressions.
    """
    canonical = normalize_condition(row)
    field = canonical["field"]
    op = canonical["op"]
    value = canonical["value"]

    operand: int | list[int] | None = None
    pattern: re.Pattern[str] | None = None

    if field == "severity_level" and op in ("eq", "neq", "gte", "lte"):
        operand = _to_level(value)
    elif field == "severity" and op in ("gte", "lte"):
        operand = _to_level(value)
    elif field == "severity_level" and op == "in":
        operand = [_to_level(item) for item in value]

    if op == "regex":
        try:
            pattern = re.compile(str(value), re.IGNORECASE)
        except re.error as exc:
            raise ConditionValidationError(f"正则表达式无效：{exc}") from exc

    return CompiledCondition(
        field=field, op=op, value=value, operand=operand, pattern=pattern
    )


def _evaluate_compiled(
    compiled: CompiledCondition, context: Mapping[str, list[str]]
) -> tuple[bool, list[str]]:
    """Evaluate one compiled condition; returns ``(matched, warnings)``."""
    candidates = context.get(compiled.field) or []
    if not candidates:
        return False, []

    if compiled.op in ("gte", "lte"):
        if compiled.operand is None:
            return False, [f"条件取值无法映射为级别：{compiled.value!r}"]
        level = int(context["severity_level"][0])
        operand = int(compiled.operand)  # type: ignore[arg-type]
        matched = level >= operand if compiled.op == "gte" else level <= operand
        return matched, []

    if compiled.field == "severity_level" and compiled.op in ("eq", "neq"):
        level = int(context["severity_level"][0])
        operand = int(compiled.operand)  # type: ignore[arg-type]
        matched = level == operand if compiled.op == "eq" else level != operand
        return matched, []

    if compiled.field == "severity_level" and compiled.op == "in":
        level = int(context["severity_level"][0])
        return level in set(compiled.operand or []), []

    if compiled.op == "eq":
        target = normalize_text(compiled.value)
        return any(candidate == target for candidate in candidates), []

    if compiled.op == "neq":
        target = normalize_text(compiled.value)
        return all(candidate != target for candidate in candidates), []

    if compiled.op == "contains":
        target = normalize_text(compiled.value)
        return any(target in candidate for candidate in candidates), []

    if compiled.op == "in":
        targets = {normalize_text(item) for item in compiled.value}
        return any(candidate in targets for candidate in candidates), []

    if compiled.op == "regex":
        if compiled.pattern is None:  # pragma: no cover - compile() guards this
            return False, [f"正则表达式无效：{compiled.value!r}"]
        return any(compiled.pattern.search(candidate) for candidate in candidates), []

    return False, [f"不支持的操作符：{compiled.op}"]


def evaluate_conditions(
    conditions: Any,
    normalized: Mapping[str, Any],
    level: int,
) -> tuple[bool, list[dict[str, Any]], list[str]]:
    """Evaluate a conditions payload against a normalised alert.

    Returns ``(matched, matched_rows, warnings)``.  This helper performs no DB
    access and is used by the matcher plus ad-hoc verification scripts.
    """
    try:
        rows = normalize_conditions(conditions)
    except ConditionValidationError as exc:
        return False, [], [str(exc)]
    if not rows:
        return False, [], ["规则未配置任何条件，视为不命中"]
    if len(rows) > MAX_CONDITIONS:
        return False, [], [f"条件数量超过 {MAX_CONDITIONS} 条，视为不命中"]

    context = build_alert_context(normalized, level)
    matched_rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for index, row in enumerate(rows):
        try:
            compiled = compile_condition(row)
        except ConditionValidationError as exc:
            warnings.append(f"第 {index + 1} 个条件无法编译：{exc}")
            return False, [], warnings
        matched, row_warnings = _evaluate_compiled(compiled, context)
        warnings.extend(row_warnings)
        if not matched:
            return False, [], warnings
        matched_rows.append(row)
    return True, matched_rows, warnings


# ═══════════════════════════════════════════════════════════════════════════════
# Rule snapshots, cache & DB matcher
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class RuleSnapshot:
    """In-memory, compiled representation of one enabled :class:`AlertRule`."""

    rule_id: int
    rule_name: str
    team_id: int
    rows: tuple[dict[str, Any], ...]
    compiled: tuple[CompiledCondition, ...]
    actions: dict[str, Any]
    invalid_reason: str | None = None


@dataclass(frozen=True)
class RuleMatch:
    """A rule that matched an alert."""

    rule_id: int
    rule_name: str
    conditions: tuple[dict[str, Any], ...]
    actions: dict[str, Any]

    @property
    def trigger_reason(self) -> str:
        """Stable reason string persisted on the alert/session."""
        return f"rule:{self.rule_id}:{self.rule_name}"

    @property
    def summary(self) -> str:
        return describe_conditions(list(self.conditions))

    def to_detail(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "rule_name": self.rule_name,
            "conditions": [dict(row) for row in self.conditions],
            "summary": self.summary,
            "actions": dict(self.actions),
        }


_RULE_CACHE: dict[int, tuple[float, tuple[RuleSnapshot, ...]]] = {}


def _merge_actions(actions: Any) -> dict[str, Any]:
    """Flatten the ``actions`` JSONB array into a single override mapping."""
    if isinstance(actions, Mapping):
        items: list[Any] = [actions]
    elif isinstance(actions, (list, tuple)):
        items = list(actions)
    else:
        items = []
    merged: dict[str, Any] = {}
    for item in items:
        if not isinstance(item, Mapping):
            continue
        for key, value in item.items():
            merged[str(key)] = value
    return merged


def _compile_snapshot(rule: AlertRule) -> RuleSnapshot:
    """Compile one ORM rule; invalid rules become inert snapshots."""
    rows, warnings = stored_conditions(rule.conditions)
    actions = _merge_actions(rule.actions)
    if warnings:
        logger.warning(
            "AlertRule {} ({!r}) 条件警告：{}", rule.id, rule.name, "；".join(warnings)
        )

    if not rows:
        return RuleSnapshot(
            rule_id=rule.id,
            rule_name=rule.name,
            team_id=rule.team_id,
            rows=(),
            compiled=(),
            actions=actions,
            invalid_reason="；".join(warnings) or "未配置条件",
        )

    compiled: list[CompiledCondition] = []
    for index, row in enumerate(rows):
        try:
            compiled.append(compile_condition(row))
        except ConditionValidationError as exc:
            reason = f"第 {index + 1} 个条件无效：{exc}"
            logger.warning(
                "AlertRule {} ({!r}) 将被忽略（{}）", rule.id, rule.name, reason
            )
            return RuleSnapshot(
                rule_id=rule.id,
                rule_name=rule.name,
                team_id=rule.team_id,
                rows=tuple(rows),
                compiled=(),
                actions=actions,
                invalid_reason=reason,
            )

    return RuleSnapshot(
        rule_id=rule.id,
        rule_name=rule.name,
        team_id=rule.team_id,
        rows=tuple(rows),
        compiled=tuple(compiled),
        actions=actions,
        invalid_reason=None,
    )


def stored_conditions(conditions: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Best-effort parse of stored conditions; never raises."""
    try:
        rows = normalize_conditions(conditions)
    except ConditionValidationError as exc:
        return [], [str(exc)]
    if not rows:
        return [], ["规则未配置任何条件，视为永不命中"]
    return rows, []


async def load_team_rules(
    db: AsyncSession,
    team_id: int,
    *,
    use_cache: bool = True,
) -> tuple[RuleSnapshot, ...]:
    """Load (and cache) the enabled rules of a team, ordered by id."""
    now = time.monotonic()
    if use_cache:
        cached = _RULE_CACHE.get(team_id)
        if cached is not None and now - cached[0] <= RULE_CACHE_TTL_SECONDS:
            return cached[1]

    result = await db.execute(
        select(AlertRule)
        .where(AlertRule.team_id == team_id, AlertRule.enabled.is_(True))
        .order_by(AlertRule.id.asc())
        .limit(MAX_RULES_PER_TEAM)
    )

    snapshots: list[RuleSnapshot] = []
    for rule in result.scalars().all():
        try:
            snapshots.append(_compile_snapshot(rule))
        except Exception:  # pragma: no cover - defensive, one bad rule must not break ingestion
            logger.exception("AlertRule {} 编译失败，已跳过", getattr(rule, "id", "?"))
    frozen = tuple(snapshots)
    if use_cache:
        _RULE_CACHE[team_id] = (now, frozen)
    return frozen


def invalidate_rule_cache(team_id: int | None = None) -> None:
    """Drop cached rules (all teams when *team_id* is ``None``)."""
    if team_id is None:
        _RULE_CACHE.clear()
    else:
        _RULE_CACHE.pop(int(team_id), None)


async def match_rule(
    db: AsyncSession,
    team_id: int,
    normalized: Mapping[str, Any],
    level: int,
    *,
    use_cache: bool = True,
) -> RuleMatch | None:
    """Return the first enabled team rule that matches *normalized*, if any.

    Rules are evaluated in id order (creation order); all conditions of a rule
    must match (AND).  Invalid rules are skipped (their warnings are logged at
    load time).  This function performs a single read query at most and never
    raises for malformed rule data.
    """
    snapshots = await load_team_rules(db, int(team_id), use_cache=use_cache)
    if not snapshots:
        return None

    context = build_alert_context(normalized, level)
    for snapshot in snapshots:
        if snapshot.invalid_reason or not snapshot.compiled:
            continue
        matched = True
        for compiled in snapshot.compiled:
            ok, warnings = _evaluate_compiled(compiled, context)
            for warning in warnings:
                logger.warning(
                    "AlertRule {} 条件求值警告：{}", snapshot.rule_id, warning
                )
            if not ok:
                matched = False
                break
        if matched:
            logger.info(
                "AlertRule 命中：rule={} ({!r}) team={} 条件={}",
                snapshot.rule_id,
                snapshot.rule_name,
                team_id,
                describe_conditions(list(snapshot.rows)),
            )
            return RuleMatch(
                rule_id=snapshot.rule_id,
                rule_name=snapshot.rule_name,
                conditions=snapshot.rows,
                actions=dict(snapshot.actions),
            )
    return None


__all__ = [
    "ConditionValidationError",
    "FIELD_WHITELIST",
    "FIELD_LABELS",
    "MAX_CONDITIONS",
    "MAX_IN_VALUES",
    "MAX_VALUE_LENGTH",
    "OP_LABELS",
    "RULE_CACHE_TTL_SECONDS",
    "RuleMatch",
    "RuleSnapshot",
    "SEVERITY_LABELS",
    "SUPPORTED_OPS",
    "build_alert_context",
    "compile_condition",
    "describe_conditions",
    "evaluate_conditions",
    "invalidate_rule_cache",
    "legacy_expression",
    "load_team_rules",
    "match_rule",
    "normalize_condition",
    "normalize_conditions",
    "normalize_field",
    "normalize_op",
    "normalize_text",
    "parse_legacy_conditions",
    "stored_conditions",
]
