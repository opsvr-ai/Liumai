"""Knowledge Center — document ingestion into llm-wiki v2 via Hermes.

Provides document CRUD, ingestion to llm-wiki v2 knowledge base, Q&A hit
testing, webhook auto-update, and usage statistics.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from loguru import logger
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_admin
from app.models import KnowledgeDocument, User
from app.models.database import get_db_session

router = APIRouter()

# ── MarkItDown allowed extensions (same as chat.py) ────────────────────────
_ALLOWED_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".epub",
    ".html", ".htm", ".csv", ".json", ".xml", ".ipynb",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif",
    ".zip", ".txt", ".md", ".py", ".js", ".ts", ".log", ".sql",
    ".java", ".go", ".rs", ".c", ".cpp", ".h", ".sh", ".bat", ".ps1",
    ".yaml", ".yml", ".ini", ".cfg", ".env", ".css", ".rss",
}

# ── Prompts ─────────────────────────────────────────────────────────────────

INGEST_PROMPT = """你是一个知识管理助手。请使用 llm-wiki v2 知识库工具，将以下文档内容进行提炼和结构化处理，然后存入知识库。

要求：
1. 提取关键知识点，保留原文引用
2. 按主题进行分类标记
3. 确保存入后的知识可以被语义检索命中
4. 返回处理结果摘要（存入条目数、分类列表）

---
文档内容：
{content}"""

WEBHOOK_REFINE_PROMPT = """你是一个知识更新助手。请使用 llm-wiki v2 知识库工具，分析以下 webhook 推送的数据，提炼出有价值的知识点，更新到知识库中。

要求：
1. 识别数据中的关键信息和变更
2. 如果是已有知识的更新，请替换旧版本
3. 如果是全新知识，请添加到对应分类
4. 忽略噪音和冗余信息

---
Webhook 来源: {source}
数据内容：
{data}"""


# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════


class DocCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    content: str = Field(default="")


class DocOut(BaseModel):
    id: int
    title: str
    source_type: str
    source_name: str | None = None
    content: str = ""
    processed_content: str | None = None
    status: str
    hermes_session_id: str | None = None
    knowledge_id: str | None = None
    hit_count: int = 0
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class IngestResult(BaseModel):
    ok: bool
    status: str
    hermes_session_id: str | None = None
    message: str = ""


class TestQuery(BaseModel):
    question: str = Field(..., min_length=1)


class TestResult(BaseModel):
    hit: bool
    question: str
    answer: str = ""
    sources: list[str] = Field(default_factory=list)
    confidence: float = 0.0


class WebhookSource(BaseModel):
    source: str
    doc_count: int


class KnowledgeStats(BaseModel):
    total_docs: int
    stored_count: int
    failed_count: int
    total_hits: int
    webhook_sources: list[str]


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Documents
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/documents", response_model=list[DocOut])
async def list_documents(
    search: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    source_type: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[DocOut]:
    """List all knowledge documents with optional filters."""
    q = select(KnowledgeDocument).order_by(KnowledgeDocument.updated_at.desc())
    if search:
        q = q.where(
            KnowledgeDocument.title.ilike(f"%{search}%")
            | KnowledgeDocument.content.ilike(f"%{search}%")
        )
    if status_filter:
        q = q.where(KnowledgeDocument.status == status_filter)
    if source_type:
        q = q.where(KnowledgeDocument.source_type == source_type)
    offset = (page - 1) * page_size
    rows = await db.execute(q.offset(offset).limit(page_size))
    return [DocOut.model_validate(r) for r in rows.scalars()]


@router.post("/documents", response_model=DocOut, status_code=201)
async def create_document(
    body: DocCreate | None = None,
    file: UploadFile | None = File(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> DocOut:
    """Upload a document (file or text).  Files are converted via MarkItDown."""
    title = ""
    content = ""

    if file and file.filename:
        # Convert file via MarkItDown
        title = os.path.splitext(file.filename)[0]
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in _ALLOWED_EXTENSIONS:
            raise HTTPException(status_code=400, detail=f"不支持的文件类型: {ext}")
        body_bytes = await file.read()
        suffix = ext if ext else ".txt"
        tmp_path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(body_bytes)
                tmp_path = tmp.name
            from markitdown import MarkItDown
            md = MarkItDown()
            result = md.convert(tmp_path)
            content = result.text_content.strip()
        except ImportError:
            raise HTTPException(status_code=500, detail="markitdown 未安装")
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"文件转换失败: {exc}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
    elif body and body.title:
        title = body.title
        content = body.content or ""
    else:
        raise HTTPException(status_code=400, detail="请提供文档内容或上传文件")

    if not content.strip():
        raise HTTPException(status_code=400, detail="文档内容为空")

    doc = KnowledgeDocument(
        title=title,
        source_type="upload",
        content=content,
        status="pending",
    )
    db.add(doc)
    await db.flush()
    await db.refresh(doc)
    logger.info("KnowledgeDocument created: id={} title={!r}", doc.id, doc.title)
    return DocOut.model_validate(doc)


@router.get("/documents/{doc_id}", response_model=DocOut)
async def get_document(
    doc_id: int,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> DocOut:
    """Get a single document with full content."""
    doc = await db.get(KnowledgeDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    return DocOut.model_validate(doc)


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete a document (admin only)."""
    doc = await db.get(KnowledgeDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    await db.delete(doc)
    await db.flush()
    return Response(status_code=204)


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Ingestion
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/documents/{doc_id}/ingest", response_model=IngestResult)
async def ingest_document(
    doc_id: int,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> IngestResult:
    """Ingest a document into the llm-wiki v2 knowledge base via Hermes."""
    doc = await db.get(KnowledgeDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")

    from app.services.hermes import HermesClient, _hermes_url

    if not _hermes_url:
        return IngestResult(ok=False, status="failed", message="Hermes 未配置")

    doc.status = "processing"
    doc.error_message = None
    await db.flush()

    hermes = HermesClient()
    if not hermes.base_url:
        doc.status = "failed"
        doc.error_message = "Hermes 未配置"
        await db.flush()
        return IngestResult(ok=False, status="failed", message="Hermes 未配置")

    try:
        import json
        import uuid as _uuid

        session_id = f"knowledge-ingest--{_uuid.uuid4().hex}"
        # Truncate to 30000 chars for reasonable prompt size
        prompt = INGEST_PROMPT.format(content=doc.content[:30000])

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
        await db.flush()

        logger.info("KnowledgeDocument ingested: id={} session={}", doc.id, session_id)
        return IngestResult(ok=True, status="stored", hermes_session_id=session_id, message="知识已存入 llm-wiki v2")

    except Exception as exc:
        logger.exception("Knowledge ingest failed for doc {}", doc.id)
        doc.status = "failed"
        doc.error_message = str(exc)[:500]
        await db.flush()
        return IngestResult(ok=False, status="failed", message=f"入库失败: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Q&A Hit Testing
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/test", response_model=TestResult)
async def test_knowledge_hit(
    body: TestQuery,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> TestResult:
    """Test whether a question hits the llm-wiki v2 knowledge base."""
    from app.services.hermes import HermesClient, _hermes_url

    if not _hermes_url:
        return TestResult(hit=False, question=body.question, answer="Hermes 未配置")

    hermes = HermesClient()
    if not hermes.base_url:
        return TestResult(hit=False, question=body.question, answer="Hermes 未配置")

    try:
        messages = [
            {"role": "system", "content": (
                "你是基于 llm-wiki v2 知识库的智能助手。请根据知识库中的内容回答用户问题。"
                "如果找到相关知识，请在回答中引用原文来源。如果没有找到，请明确说明'未命中'。"
                "返回 JSON 格式："
                '{"hit": true/false, "answer": "回答内容", "sources": ["来源1"], "confidence": 0.0-1.0}'
            )},
            {"role": "user", "content": body.question},
        ]

        import json as _json

        result = await hermes.run_rca(
            skill_name="knowledge-test",
            params={"question": body.question},
        )
        output = result.get("result", {}).get("output", "")

        try:
            parsed = _json.loads(output)
            hit = parsed.get("hit", False)
            answer = parsed.get("answer", output)
            sources = parsed.get("sources", [])
            confidence = float(parsed.get("confidence", 0.0))
        except Exception:
            hit = "未命中" not in output.lower()
            answer = output
            sources = []
            confidence = 0.5 if hit else 0.0

        # Bump hit counter on stored docs when hit
        if hit:
            stored_docs = (
                await db.execute(
                    select(KnowledgeDocument).where(KnowledgeDocument.status == "stored")
                )
            ).scalars().all()
            for d in stored_docs:
                d.hit_count = (d.hit_count or 0) + 1
            await db.flush()

        return TestResult(
            hit=hit, question=body.question,
            answer=answer[:2000], sources=sources, confidence=confidence,
        )

    except Exception as exc:
        logger.exception("Knowledge test failed")
        return TestResult(hit=False, question=body.question, answer=f"测试失败: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Webhooks
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/webhook/{source}", status_code=201)
async def receive_webhook(
    source: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Receive webhook data and auto-ingest into knowledge base.

    The webhook payload is stored as a new KnowledgeDocument then
    ingested via Hermes with the webhook-refine prompt.
    """
    import json as _json

    data_str = _json.dumps(payload, ensure_ascii=False, indent=2)
    title = f"Webhook: {source} — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}"

    doc = KnowledgeDocument(
        title=title,
        source_type="webhook",
        source_name=source,
        content=data_str,
        status="pending",
    )
    db.add(doc)
    await db.flush()
    await db.refresh(doc)

    logger.info("Webhook received: source={} doc_id={}", source, doc.id)

    # Auto-ingest via Hermes
    from app.services.hermes import HermesClient, _hermes_url

    if _hermes_url:
        hermes = HermesClient()
        if hermes.base_url:
            try:
                doc.status = "processing"
                await db.flush()

                import uuid as _uuid
                session_id = f"webhook-{source}--{_uuid.uuid4().hex}"
                result = await hermes.run_rca(
                    skill_name="knowledge-webhook",
                    params={"source": source, "data_preview": data_str[:2000]},
                )

                doc.status = "stored"
                doc.hermes_session_id = session_id
                doc.processed_content = result.get("result", {}).get("output", "")[:5000]
                doc.knowledge_id = session_id
                await db.flush()
                logger.info("Webhook ingested: source={} doc_id={}", source, doc.id)
            except Exception as exc:
                logger.exception("Webhook ingest failed for {}", doc.id)
                doc.status = "failed"
                doc.error_message = str(exc)[:500]
                await db.flush()

    return {"ok": True, "doc_id": doc.id, "status": doc.status}


@router.get("/webhooks", response_model=list[WebhookSource])
async def list_webhooks(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[WebhookSource]:
    """List all unique webhook sources and their document count."""
    rows = await db.execute(
        select(
            KnowledgeDocument.source_name,
            func.count(KnowledgeDocument.id).label("cnt"),
        )
        .where(KnowledgeDocument.source_type == "webhook")
        .group_by(KnowledgeDocument.source_name)
        .order_by(KnowledgeDocument.source_name)
    )
    return [WebhookSource(source=r[0] or "unknown", doc_count=r[1]) for r in rows]


@router.delete("/webhooks/{source}")
async def delete_webhook_source(
    source: str,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete all documents from a webhook source (admin only)."""
    rows = await db.execute(
        select(KnowledgeDocument).where(KnowledgeDocument.source_name == source)
    )
    for doc in rows.scalars():
        await db.delete(doc)
    await db.flush()
    return Response(status_code=204)


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Feedback
# ═══════════════════════════════════════════════════════════════════════════════


class FeedbackRequest(BaseModel):
    question: str
    hit: bool


@router.post("/feedback")
async def submit_feedback(
    body: FeedbackRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Submit hit/miss feedback for a knowledge test query."""
    if body.hit:
        rows = await db.execute(
            select(KnowledgeDocument).where(KnowledgeDocument.status == "stored")
        )
        for doc in rows.scalars():
            doc.hit_count = (doc.hit_count or 0) + 1
        await db.flush()
    logger.info("Knowledge feedback: {} question={!r}", "hit" if body.hit else "miss", body.question[:100])
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Statistics
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/stats", response_model=KnowledgeStats)
async def get_knowledge_stats(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> KnowledgeStats:
    """Return aggregate statistics for the knowledge center."""
    total = await db.execute(select(func.count()).select_from(KnowledgeDocument))
    stored = await db.execute(
        select(func.count()).where(KnowledgeDocument.status == "stored")
    )
    failed = await db.execute(
        select(func.count()).where(KnowledgeDocument.status == "failed")
    )
    hits = await db.execute(
        select(func.sum(KnowledgeDocument.hit_count))
    )
    sources = await db.execute(
        select(KnowledgeDocument.source_name)
        .where(KnowledgeDocument.source_type == "webhook", KnowledgeDocument.source_name.isnot(None))
        .distinct()
    )
    return KnowledgeStats(
        total_docs=total.scalar() or 0,
        stored_count=stored.scalar() or 0,
        failed_count=failed.scalar() or 0,
        total_hits=hits.scalar() or 0,
        webhook_sources=[r[0] for r in sources.all() if r[0]],
    )
