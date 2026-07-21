"""Knowledge distillation engine.

Scans conversation history, extracts valuable ops knowledge via LLM,
scores each piece on 5 dimensions, persists high-scoring candidates.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any

import httpx
from loguru import logger
from sqlalchemy import func, select

from app.config import settings

# ── Scoring weights ──────────────────────────────────────────────────────────
WEIGHTS = {
    "source_quality":  0.25,  # How good is the source material?
    "utility":         0.30,  # How actionable is this knowledge?
    "freshness":       0.10,  # How recent is the source?
    "feedback":        0.25,  # Hit count + user feedback
    "structure":       0.10,  # Format quality (title, steps, clarity)
}

CATEGORIES = ["故障排查", "监控告警", "变更操作", "架构知识", "性能优化", "安全配置"]


# ── Prompt ───────────────────────────────────────────────────────────────────

EXTRACT_PROMPT = """你是一个运维知识蒸馏专家。从以下对话记录中提取有价值的运维知识点。
忽略闲聊、问候和无关内容，只提取具有复用价值的专业知识。

要求：
1. 每条知识包含：标题、分类（故障排查/监控告警/变更操作/架构知识/性能优化/安全配置）、核心内容（含步骤/命令/参数）、适用场景、标签（2-4个关键词）
2. 内容应包含完整的排查步骤、命令示例、配置参数
3. 如果对话中没有可提取的运维知识，返回空数组 []
4. 严格返回 JSON 数组格式，示例：
[{{"title": "知识标题", "category": "故障排查", "content": "核心内容", "tags": ["标签1", "标签2"], "confidence": 0.85}}]

---
{conversation}"""


# ═══════════════════════════════════════════════════════════════════════════════
# Distiller
# ═══════════════════════════════════════════════════════════════════════════════


class Distiller:
    """Extracts and scores ops knowledge from chat history using LLM."""

    def __init__(self, db_session: Any) -> None:
        self.db = db_session
        self._llm_cfg: dict[str, str] | None = None

    async def _load_llm_config(self) -> dict[str, str]:
        """Load LLM config from system_config."""
        from app.models import SystemConfig

        rows = await self.db.execute(
            select(SystemConfig).where(
                SystemConfig.key.in_(["llm_base_url", "llm_api_key", "llm_model"])
            )
        )
        return {r.key: r.value for r in rows.scalars()}

    # ── Main entry point ──────────────────────────────────────────────────

    async def run(
        self,
        *,
        session_ids: list[int] | None = None,
        limit: int = 20,
        min_score: float = 40.0,
        auto_store: bool = True,
    ) -> dict[str, Any]:
        """Scan chat sessions, extract knowledge, score and persist.

        Args:
            session_ids: Specific sessions to distill (None = scan all unprocessed)
            limit: Max sessions to scan in one run
            min_score: Minimum score to keep as candidate
            auto_store: Auto-ingest candidates scoring >= 70 into llm-wiki v2

        Returns:
            Summary dict with counts
        """
        if session_ids:
            sessions = await self._get_sessions_by_ids(session_ids)
        else:
            sessions = await self._get_unprocessed_sessions(limit)

        if not sessions:
            return {"sessions_scanned": 0, "knowledge_extracted": 0}

        self._llm_cfg = await self._load_llm_config()
        total_extracted = 0

        from app.models import ChatSession as ChatSessionModel

        for session_id, messages in sessions:
            conversation = "\n\n".join(
                f"[{r}]: {c}" for r, c in messages
            )

            # ── Pre-filter: skip worthless conversations ──────────────────
            if _is_worthless(messages):
                await self._mark_session(session_id, "skipped")
                continue

            # Skip very short conversations
            if len(conversation) < 200:
                await self._mark_session(session_id, "skipped")
                continue

            items = await self._extract_knowledge(conversation)
            if not items:
                await self._mark_session(session_id, "skipped")
                continue

            has_valuable = False
            for item in items:
                score, details = self._score(item, messages)
                if score < min_score:
                    continue

                status = "approved" if score >= 70 else "candidate"

                # Check dedup
                if await self._is_duplicate(item["title"], item["content"]):
                    continue

                from app.models import DistilledKnowledge

                dk = DistilledKnowledge(
                    title=item["title"],
                    content=item["content"],
                    category=item.get("category", "故障排查"),
                    tags=item.get("tags", []),
                    source_type="chat",
                    source_ids=[session_id],
                    score=score,
                    score_details=details,
                    status=status,
                )
                self.db.add(dk)
                await self.db.flush()
                total_extracted += 1
                has_valuable = True

                # Auto-store high-scoring knowledge
                if auto_store and score >= 70:
                    await self._auto_ingest(dk)

            # Mark session as processed
            if has_valuable:
                await self._mark_session(session_id, "distilled")
            else:
                await self._mark_session(session_id, "skipped")

        return {
            "sessions_scanned": len(sessions),
            "knowledge_extracted": total_extracted,
        }

    # ── Internal: scan sessions ────────────────────────────────────────────

    async def _get_unprocessed_sessions(
        self, limit: int,
    ) -> list[tuple[int, list[tuple[str, str]]]]:
        """Get sessions that haven't been distilled yet.

        Only returns sessions where distillation_status is NULL (unprocessed).
        Skips sessions already marked 'distilled' or 'skipped'.
        """
        from app.models import ChatMessage, ChatSession

        rows = await self.db.execute(
            select(ChatSession.id)
            .where(
                ChatSession.distillation_status.is_(None),
                ChatSession.updated_at >= func.now() - func.make_interval(0, 0, 0, 7),
            )
            .order_by(ChatSession.updated_at.desc())
            .limit(limit)
        )
        ids = [r[0] for r in rows.all()]
        return await self._get_sessions_by_ids(ids)

    async def get_queue_count(self) -> int:
        """Return the number of sessions waiting to be distilled."""
        from app.models import ChatSession

        row = await self.db.execute(
            select(func.count(ChatSession.id)).where(
                ChatSession.distillation_status.is_(None),
            )
        )
        return row.scalar() or 0

    async def _get_sessions_by_ids(
        self, ids: list[int],
    ) -> list[tuple[int, list[tuple[str, str]]]]:
        """Fetch messages for a list of session IDs."""
        from app.models import ChatMessage

        result: list[tuple[int, list[tuple[str, str]]]] = []
        for sid in ids:
            rows = await self.db.execute(
                select(ChatMessage.role, ChatMessage.content)
                .where(ChatMessage.session_id == sid)
                .order_by(ChatMessage.created_at.asc())
                .limit(30)
            )
            msgs = [(r[0], r[1] or "") for r in rows.all()]
            if len(msgs) >= 3:
                result.append((sid, msgs))
        return result

    # ── Internal: LLM extraction ──────────────────────────────────────────

    async def _extract_knowledge(
        self, conversation: str,
    ) -> list[dict[str, Any]]:
        """Call LLM to extract knowledge items from a conversation."""
        if not self._llm_cfg:
            return []

        base_url = self._llm_cfg.get("llm_base_url", "").strip()
        api_key = self._llm_cfg.get("llm_api_key", "").strip()
        model = self._llm_cfg.get("llm_model", "").strip()

        if not base_url or not model:
            return []

        url = base_url.rstrip("/")
        if not url.endswith("/chat/completions"):
            url = f"{url}/chat/completions" if "/v1" in url else f"{url}/v1/chat/completions"

        prompt = EXTRACT_PROMPT.format(conversation=conversation[:8000])
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as c:
                resp = await c.post(
                    url,
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": prompt},
                        ],
                        "temperature": 0.1,
                        "max_tokens": 2048,
                    },
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                # Extract JSON array from response
                text = text.strip()
                if text.startswith("```"):
                    lines = text.split("\n")
                    text = "\n".join(lines[1:-1])
                return json.loads(text) if isinstance(json.loads(text), list) else []
        except Exception:
            logger.exception("Knowledge extraction failed")
            return []

    # ── Internal: scoring ──────────────────────────────────────────────────

    def _score(
        self,
        item: dict[str, Any],
        messages: list[tuple[str, str]],
    ) -> tuple[float, dict[str, float]]:
        """Calculate a 0-100 score across 5 dimensions."""
        details: dict[str, float] = {}

        # Source quality: conversation length + role diversity
        roles = set(r for r, _ in messages)
        msg_len = sum(len(c) for _, c in messages)
        details["source_quality"] = min(100, (msg_len / 500) * 60 + (len(roles) >= 2) * 40)

        # Utility: confidence from LLM extraction
        details["utility"] = item.get("confidence", 0.5) * 100

        # Freshness: always 80 for today (decay handled at query time)
        details["freshness"] = 80.0

        # Feedback: start neutral, adjusted by real hits later
        details["feedback"] = 50.0

        # Structure: title length + content completeness
        title_ok = len(item.get("title", "")) >= 5
        content_ok = len(item.get("content", "")) >= 100
        details["structure"] = (title_ok * 40 + content_ok * 60)

        total = sum(WEIGHTS[k] * details[k] for k in WEIGHTS)
        return round(min(total, 100), 1), details

    # ── Internal: dedup ────────────────────────────────────────────────────

    async def _is_duplicate(self, title: str, content: str) -> bool:
        """Semantic dedup: check keyword overlap with existing knowledge."""
        from app.models import DistilledKnowledge

        # Extract keywords from title + content
        import re
        keywords = set(re.findall(r"[一-鿿]{2,}|[a-zA-Z]{3,}", title + " " + content[:200]))
        if not keywords:
            return False

        # Check existing distilled knowledge for overlap
        rows = await self.db.execute(
            select(DistilledKnowledge.title, DistilledKnowledge.content).limit(50)
        )
        for r in rows.all():
            existing_text = (r[0] + " " + (r[1] or "")[:200]).lower()
            overlap = sum(1 for kw in keywords if kw.lower() in existing_text)
            if overlap >= max(2, len(keywords) * 0.5):  # 50% keyword overlap
                logger.info("Dedup: '{}' matches existing '{}' ({} keywords)", title, r[0], overlap)
                return True
        return False

    async def _detect_conflict(
        self, title: str, content: str, category: str,
    ) -> bool:
        """Check if new knowledge conflicts with existing in same category."""
        from app.models import DistilledKnowledge

        rows = await self.db.execute(
            select(DistilledKnowledge.title, DistilledKnowledge.content)
            .where(DistilledKnowledge.category == category)
            .limit(20)
        )
        conflict_keywords = ["不是", "不对", "错误", "纠正", "不同于", "区别于"]
        for r in rows.all():
            combined = (r[1] or "").lower()
            if any(kw in content.lower() for kw in conflict_keywords):
                logger.info("Conflict detected: '{}' vs '{}'", title, r[0])
                return True
        return False

    # ── Internal: mark session ───────────────────────────────────────────

    async def _mark_session(self, session_id: int, status: str) -> None:
        """Mark a chat session as distilled or skipped."""
        from app.models import ChatSession as ChatSessionModel

        row = await self.db.get(ChatSessionModel, session_id)
        if row:
            row.distillation_status = status
            await self.db.flush()

    # ── Internal: auto-ingest ──────────────────────────────────────────────

    async def _auto_ingest(self, dk: Any) -> None:
        """Auto-store high-scoring knowledge into knowledge_documents + llm-wiki v2."""
        from app.models import KnowledgeDocument

        doc = KnowledgeDocument(
            title=f"[蒸馏] {dk.title}",
            source_type="distillation",
            content=dk.content,
            status="pending",
        )
        self.db.add(doc)
        await self.db.flush()

        # Try to ingest via Hermes
        try:
            from app.services.hermes import HermesClient, _hermes_url

            if _hermes_url:
                hermes = HermesClient()
                if hermes.base_url:
                    import uuid as _uuid

                    session_id = f"distill--{_uuid.uuid4().hex}"
                    result = await hermes.run_rca(
                        skill_name="knowledge-ingest",
                        params={
                            "document_title": doc.title,
                            "content_length": len(doc.content),
                            "content_preview": doc.content[:3000],
                        },
                    )
                    doc.status = "stored"
                    doc.hermes_session_id = session_id
                    doc.processed_content = result.get("result", {}).get("output", "")[:5000]
                    doc.knowledge_id = session_id
                    dk.status = "stored"
                    dk.knowledge_id = session_id
                    await self.db.flush()
        except Exception:
            logger.exception("Auto-ingest failed for distilled knowledge {}", dk.id)


# ── Worthless conversation filter ─────────────────────────────────────────────


def _is_worthless(messages: list[tuple[str, str]]) -> bool:
    """Heuristic: skip conversations with no ops value.

    Returns True if the conversation is clearly not worth distilling:
    - Only 2-3 very short messages
    - Pure greetings / chitchat
    - No technical keywords present
    """
    total_len = sum(len(c) for _, c in messages)
    # Too short to contain anything useful
    if len(messages) <= 2 or total_len < 100:
        return True

    combined = " ".join(c.lower() for _, c in messages)

    # Tech/ops-related keywords — must contain at least one
    ops_keywords = [
        "error", "exception", "timeout", "failed", "crash",
        "cpu", "memory", "disk", "network", "latency",
        "deploy", "restart", "config", "log", "alert",
        "service", "pod", "node", "cluster", "db",
        "数据库", "服务", "报错", "故障", "超时", "重启",
        "监控", "告警", "日志", "配置", "部署",
        "端口", "连接", "进程", "磁盘", "内存",
    ]
    if not any(kw in combined for kw in ops_keywords):
        return True

    return False


# ═══════════════════════════════════════════════════════════════════════════════
# Singleton helper
# ═══════════════════════════════════════════════════════════════════════════════


_distiller: Distiller | None = None


def get_distiller(db_session: Any) -> Distiller:
    """Return (or create) the distiller instance for the given DB session."""
    global _distiller
    _distiller = Distiller(db_session)
    return _distiller
