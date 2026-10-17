"""Knowledge Center — document ingestion into llm-wiki v2 via Hermes.

Provides document CRUD, ingestion to llm-wiki v2 knowledge base, Q&A hit
testing, webhook auto-update, and usage statistics.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
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

# 知识入库：直接从文档提炼结构化知识条目（不再依赖 llm-wiki 工具调用）。
KNOWLEDGE_INGEST_SYSTEM_PROMPT = """你是一个企业知识库的知识提炼助手。请从用户提供的文档内容中提炼可检索的知识条目。

要求：
1. 每条知识包含四个字段：
   - title：简洁明确的知识标题
   - summary：一句话摘要
   - tags：2-5 个检索关键词
   - content：可独立阅读的正文，保留关键步骤、命令、参数与结论
2. 只输出 JSON 数组，不要输出 markdown 代码块、解释或任何多余文字
3. 输出格式：
[{"title": "标题", "summary": "摘要", "tags": ["标签1", "标签2"], "content": "正文"}]
4. 如果文档片段中没有可提炼的知识，返回空数组 []"""

# Webhook 提炼：识别推送数据中的增量信息，忽略噪音。
KNOWLEDGE_WEBHOOK_SYSTEM_PROMPT = """你是一个企业知识库的知识更新助手。请分析 webhook 推送的数据，提炼出有价值、可检索的知识条目。

要求：
1. 每条知识包含四个字段：title（标题）、summary（一句话摘要）、tags（2-5 个检索关键词）、content（可独立阅读的正文）
2. 识别数据中的关键信息和变更，忽略噪音与冗余信息
3. 只输出 JSON 数组，不要输出 markdown 代码块、解释或任何多余文字
4. 输出格式：
[{"title": "标题", "summary": "摘要", "tags": ["标签1", "标签2"], "content": "正文"}]
5. 如果没有可提炼的知识，返回空数组 []"""

# 兼容旧引用：原 llm-wiki 工具型 prompt 已废弃，等价指向新的提炼 prompt。
INGEST_PROMPT = KNOWLEDGE_INGEST_SYSTEM_PROMPT
WEBHOOK_REFINE_PROMPT = KNOWLEDGE_WEBHOOK_SYSTEM_PROMPT


# ── Hermes 调用辅助（知识入库 / Webhook 共用） ─────────────────────────────

_HERMES_CHUNK_CHARS = 8000      # 单次送入 Hermes 的最大字符数
_HERMES_DOC_MAX_CHARS = 30000   # 单篇文档最多送入 Hermes 的字符数


async def _hermes_chat_raw(
    messages: list[dict[str, str]],
    *,
    model: str = "hermes-agent",
    temperature: float = 0.2,
    max_tokens: int = 4096,
) -> tuple[str, str]:
    """直接调用 Hermes ``/chat/completions``，返回 (文本内容, session_id)。

    与 ``HermesClient.run_rca`` 不同，这里不套用 RCA prompt，system prompt
    由调用方按任务（知识入库 / webhook 提炼）自由指定。HTTP 非 2xx、响应
    不可解析或内容为空都会抛出 ``RuntimeError``，由调用方决定业务状态
    （失败时不标记 stored）。

    session_id 只取响应头 ``X-Hermes-Session-Id``（其次响应 JSON 的
    ``session_id`` 字段），取不到就返回空字符串，绝不本地伪造。
    """
    from app.services.hermes import _hermes_api_key, _hermes_url

    if not _hermes_url:
        raise RuntimeError("Hermes 未配置")

    url = f"{_hermes_url.rstrip('/')}/chat/completions"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if _hermes_api_key:
        headers["Authorization"] = f"Bearer {_hermes_api_key}"

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    logger.info(
        "Hermes knowledge chat: model={} messages={} prompt_chars={}",
        model,
        len(messages),
        sum(len(str(m.get("content", ""))) for m in messages),
    )

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(600.0, connect=30.0)
        ) as client:
            resp = await client.post(url, json=payload, headers=headers)
    except httpx.RequestError as exc:
        raise RuntimeError(f"无法连接 Hermes 服务: {exc}") from exc

    # 先取会话 id（即使响应体解析失败也保留在日志中）
    session_id = (resp.headers.get("X-Hermes-Session-Id") or "").strip()

    if not resp.is_success:
        raise RuntimeError(f"Hermes HTTP {resp.status_code}: {resp.text[:500]}")

    try:
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(
            f"Hermes 响应格式异常: {resp.text[:500]}"
        ) from exc

    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("Hermes 返回内容为空")

    # 只有确实存在 session_id 字段时才采用，避免把 completion id 当会话 id。
    if not session_id and isinstance(data, dict):
        raw_sid = data.get("session_id")
        if isinstance(raw_sid, str):
            session_id = raw_sid.strip()

    logger.info(
        "Hermes knowledge chat done: session_id={} output_chars={}",
        session_id or "-",
        len(content),
    )
    return content, session_id


async def _hermes_chat(
    messages: list[dict[str, str]],
    *,
    model: str = "hermes-agent",
    temperature: float = 0.2,
    max_tokens: int = 4096,
) -> str:
    """``_hermes_chat_raw`` 的简化封装：只返回文本内容。"""
    content, _ = await _hermes_chat_raw(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return content


def _chunk_text(
    text: str,
    *,
    chunk_chars: int = _HERMES_CHUNK_CHARS,
    max_chars: int = _HERMES_DOC_MAX_CHARS,
) -> list[str]:
    """按字符数把文档切成 ≤ chunk_chars 的片段，总量截断到 max_chars。"""
    raw = (text or "").strip()
    if not raw:
        return []
    raw = raw[:max_chars]
    return [raw[i:i + chunk_chars] for i in range(0, len(raw), chunk_chars)]


def _parse_knowledge_items(raw: str) -> list[dict[str, Any]]:
    """解析 Hermes 输出的 JSON 数组，容忍 ```json 代码块与前后说明文字。

    只保留同时具备非空 title / content 的条目；无法解析时抛 ValueError，
    确保调用方走失败分支而不是把脏数据标记为 stored。
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # 模型偶尔会在 JSON 前后附加说明，退一步截取第一个 [ 到最后一个 ]
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end <= start:
            raise ValueError(f"Hermes 未返回 JSON 数组: {text[:200]}")
        try:
            parsed = json.loads(text[start:end + 1])
        except json.JSONDecodeError as exc:
            raise ValueError(f"Hermes 返回的 JSON 无法解析: {text[:200]}") from exc

    if not isinstance(parsed, list):
        raise ValueError("Hermes 返回的 JSON 不是数组")

    items: list[dict[str, Any]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        content = str(entry.get("content") or "").strip()
        if not title or not content:
            continue
        raw_tags = entry.get("tags")
        tags: list[str] = []
        if isinstance(raw_tags, list):
            tags = [str(t).strip() for t in raw_tags if str(t).strip()]
        items.append({
            "title": title[:255],
            "summary": str(entry.get("summary") or "").strip(),
            "tags": tags,
            "content": content,
        })
    return items


def _merge_knowledge_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按标题去重合并多个片段的提炼结果（保留首次出现的条目）。"""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = item["title"].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


async def _extract_knowledge_from_document(
    title: str,
    content: str,
    *,
    system_prompt: str,
    context_label: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """分块调用 Hermes 提炼知识条目，返回 (合并后的条目, hermes_session_id)。

    每块 ≤ 8k 字符、整篇最多 30k 字符，避免只发预览或超长上下文；任意
    片段调用/解析失败都会抛异常，由调用方保持 pending/failed 语义。
    """
    chunks = _chunk_text(content)
    if not chunks:
        raise RuntimeError("文档内容为空")

    items: list[dict[str, Any]] = []
    session_id = ""

    for idx, chunk in enumerate(chunks, start=1):
        lines = [f"文档标题：{title}"]
        if context_label:
            lines.append(context_label)
        if len(chunks) > 1:
            lines.append(f"片段序号：{idx}/{len(chunks)}")
        lines.append("文档内容：")
        lines.append(chunk)
        user_message = "\n".join(lines)

        raw, chunk_session_id = await _hermes_chat_raw(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_tokens=4096,
        )
        if not session_id:
            session_id = chunk_session_id

        chunk_items = _parse_knowledge_items(raw)
        # 单个片段允许返回 []（该片段没有可提炼知识），整体为空才算失败。
        items.extend(chunk_items)

    merged = _merge_knowledge_items(items)
    if not merged:
        raise RuntimeError("Hermes 未提炼出知识条目")
    return merged, session_id


# ── 命中统计（P1-11） ───────────────────────────────────────────────────────
#
# 旧逻辑在每次问答 done 时把所有 stored 文档的 hit_count 全部 +1，统计完全
# 失真（一条回答会让整个知识库“命中”一次）。现在只在回答正文里真正出现
# 文档标题（或模型在 sources 里点名）时，才对对应文档 +1；一个文档都没
# 引用到才记为未命中，并对同一问题在短窗口内去重。

_HIT_MATCH_MIN_TITLE_CHARS = 2      # 过短的标题（如“A”）容易误匹配，跳过
_UNANSWERED_DEDUPE_SECS = 600       # 同一问题 10 分钟内只记一次未命中


def _norm_match_text(value: str) -> str:
    """归一化用于标题匹配：去掉所有空白并转小写。"""
    return re.sub(r"\s+", "", value or "").lower()


def _match_referenced_docs(
    answer: str,
    docs: list[KnowledgeDocument],
    extra_sources: list[str] | None = None,
) -> list[KnowledgeDocument]:
    """从回答正文 / 模型列出的 sources 中识别本轮真正引用的文档。

    匹配规则（宽松但不会“全库 +1”）：
    * 回答正文包含文档标题（忽略空白与大小写）；
    * ``sources`` 条目与文档标题互相包含（模型常写“来源：<标题>”）。
    """
    answer_norm = _norm_match_text(answer)
    source_norms = [
        _norm_match_text(str(s)) for s in (extra_sources or []) if str(s).strip()
    ]
    matched: list[KnowledgeDocument] = []
    for doc in docs:
        title = (doc.title or "").strip()
        if len(title) < _HIT_MATCH_MIN_TITLE_CHARS:
            continue
        title_norm = _norm_match_text(title)
        if not title_norm:
            continue
        hit = bool(answer_norm and title_norm in answer_norm)
        if not hit:
            hit = any(
                src == title_norm
                or title_norm in src
                or (len(src) >= _HIT_MATCH_MIN_TITLE_CHARS and src in title_norm)
                for src in source_norms
            )
        if hit:
            matched.append(doc)
    return matched


async def _bump_referenced_hits(
    db: AsyncSession,
    answer: str,
    extra_sources: list[str] | None = None,
) -> list[KnowledgeDocument]:
    """只给本轮回答真正引用的文档 ``hit_count += 1``，返回命中文档列表。"""
    docs = (
        await db.execute(
            select(KnowledgeDocument).where(KnowledgeDocument.status == "stored")
        )
    ).scalars().all()
    matched = _match_referenced_docs(answer, list(docs), extra_sources)
    for doc in matched:
        doc.hit_count = (doc.hit_count or 0) + 1
    if matched:
        await db.flush()
        logger.info(
            "知识命中统计: answer_chars={} matched_docs={}",
            len(answer or ""),
            [d.id for d in matched],
        )
    return matched


async def _record_unanswered(db: AsyncSession, question: str) -> None:
    """记录未命中问题；同一问题在 ``_UNANSWERED_DEDUPE_SECS`` 窗口内只记一次。"""
    from sqlalchemy import text as _text

    # 常量直接内联进 SQL（非用户输入），避免 interval 参数的类型推断问题。
    sql = (
        "INSERT INTO unanswered_queries (question, count, last_asked) "
        "VALUES (:q, 1, NOW()) "
        "ON CONFLICT (question) DO UPDATE "
        "SET count = unanswered_queries.count + 1, last_asked = NOW() "
        "WHERE unanswered_queries.last_asked IS NULL "
        f"OR unanswered_queries.last_asked < NOW() - INTERVAL '{_UNANSWERED_DEDUPE_SECS} seconds'"
    )
    await db.execute(_text(sql), {"q": question[:500]})
    await db.flush()


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

    from app.services.hermes import _hermes_url

    if not _hermes_url:
        doc.status = "failed"
        doc.error_message = "Hermes 未配置"
        await db.flush()
        return IngestResult(ok=False, status="failed", message="Hermes 未配置")

    doc.status = "processing"
    doc.error_message = None
    await db.flush()

    try:
        # 全文分块提炼（每块 ≤ 8k 字符、整篇最多 30k），不再只发 3k 预览。
        items, hermes_session_id = await _extract_knowledge_from_document(
            doc.title,
            doc.content,
            system_prompt=KNOWLEDGE_INGEST_SYSTEM_PROMPT,
        )

        doc.status = "stored"
        # 只使用 Hermes 真实返回的会话 id；取不到时留空，绝不本地伪造。
        doc.hermes_session_id = hermes_session_id or None
        doc.processed_content = json.dumps(items, ensure_ascii=False)[:5000]
        # 条目已由平台侧结构化保存，不再伪造 llm-wiki 条目 id。
        doc.knowledge_id = None
        doc.error_message = None
        await db.flush()

        logger.info(
            "KnowledgeDocument ingested: id={} items={} hermes_session={}",
            doc.id, len(items), doc.hermes_session_id or "-",
        )
        return IngestResult(
            ok=True,
            status="stored",
            hermes_session_id=hermes_session_id or None,
            message=f"知识已存入 llm-wiki v2（{len(items)} 条知识条目）",
        )

    except Exception as exc:
        logger.exception("Knowledge ingest failed for doc {}", doc.id)
        doc.status = "failed"
        doc.error_message = str(exc)[:500]
        await db.flush()
        return IngestResult(ok=False, status="failed", message=f"入库失败: {exc}")


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Q&A Hit Testing
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/test-stream")
async def test_knowledge_hit_stream(
    body: TestQuery,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
):
    """Test knowledge hit with SSE streaming — answer types out in real-time."""
    from app.services.hermes import HermesClient, _hermes_url

    if not _hermes_url:
        async def _no_hermes():
            yield f"event: error\ndata: {json.dumps({'error': 'Hermes 未配置'}, ensure_ascii=False)}\n\n"
        return StreamingResponse(_no_hermes(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    hermes = HermesClient()
    if not hermes.base_url:
        async def _no_url():
            yield f"event: error\ndata: {json.dumps({'error': 'Hermes 未配置'}, ensure_ascii=False)}\n\n"
        return StreamingResponse(_no_url(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    async def _stream():
        try:
            # 累积本轮回答正文，done 时据此识别真正被引用的文档。
            answer_parts: list[str] = []
            # Use chat_stream for real-time output
            async for event in hermes.chat_stream(
                messages=[
                    {"role": "system", "content": (
                        "你是基于 llm-wiki v2 知识库的智能助手。"
                        "请根据知识库中的内容回答用户问题。"
                        "如果找到相关知识，请在回答中引用原文来源。"
                        "如果没有找到，请明确说明'未命中'。"
                    )},
                    {"role": "user", "content": body.question},
                ],
                temperature=0.1,
            ):
                event_type = event.get("type", "unknown")
                if event_type == "delta":
                    answer_parts.append(str(event.get("content") or ""))
                    yield f"data: {json.dumps({'type': 'delta', 'content': event.get('content', '')}, ensure_ascii=False)}\n\n"
                elif event_type == "tool_call":
                    yield f"data: {json.dumps({'type': 'tool_call', 'tool_calls': event.get('tool_calls', [])}, ensure_ascii=False)}\n\n"
                elif event_type == "done":
                    # ── 命中统计（P1-11）──────────────────────────────
                    # 只给本轮回答真正引用的文档 +1；一个都没引用才记未命中。
                    # 统计失败不能影响已经把回答推给前端的流。
                    try:
                        matched = await _bump_referenced_hits(db, "".join(answer_parts))
                        if not matched:
                            await _record_unanswered(db, body.question)
                    except Exception:
                        logger.warning(
                            "知识命中统计失败（不影响回答）: question={!r}",
                            body.question[:80],
                        )
                    yield f"data: {json.dumps({'type': 'done', 'finish_reason': event.get('finish_reason')}, ensure_ascii=False)}\n\n"
                elif event_type == "error":
                    yield f"event: error\ndata: {json.dumps({'error': event.get('error', '未知错误')}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            logger.exception("Knowledge test stream error")
            yield f"event: error\ndata: {json.dumps({'error': f'测试失败: {exc}'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@router.post("/test", response_model=TestResult)
async def test_knowledge_hit(
    body: TestQuery,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> TestResult:
    """Test whether a question hits the llm-wiki v2 knowledge base."""
    from app.services.hermes import _hermes_url

    if not _hermes_url:
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

        # Ask Hermes directly with the knowledge-test prompt.  This used to call
        # run_rca(), which injects the RCA prompt and made the "hit" test
        # meaningless (and never sent the messages built above).
        output = await _hermes_chat(messages, temperature=0.2)

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

        # 只给本轮回答真正引用的文档 +1。旧逻辑在 hit 时给所有 stored 文档
        # +1，一次问答就能把整个知识库的命中数抬高，统计完全失真。
        try:
            await _bump_referenced_hits(
                db,
                answer if isinstance(answer, str) else str(answer),
                sources if isinstance(sources, list) else [],
            )
        except Exception:
            logger.warning(
                "知识命中统计失败（不影响测试结果）: question={!r}",
                body.question[:80],
            )

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


async def _check_webhook_auth(
    db: AsyncSession,
    source: str,
    header_token: str | None,
    query_token: str | None,
) -> None:
    """校验知识中心 webhook 的可选 token 鉴权。

    从 ``system_config.knowledge_webhook_token`` 读取期望值：

    * 键不存在或值为空 → 未启用鉴权，直接放行（向后兼容）；
    * 已配置 → 必须通过 ``X-Webhook-Token`` 头或 ``?token=`` 查询参数
      提供匹配值，否则返回 401。日志与响应都不回显 token 明文。
    """
    from app.models import SystemConfig

    row = await db.get(SystemConfig, "knowledge_webhook_token")
    expected = (row.value or "").strip() if row else ""
    if not expected:
        return

    provided = (header_token or query_token or "").strip()
    if not provided or not hmac.compare_digest(
        provided.encode("utf-8"), expected.encode("utf-8")
    ):
        logger.warning(
            "Webhook 鉴权失败: source={} header_provided={} query_provided={}",
            source,
            bool(header_token),
            bool(query_token),
        )
        raise HTTPException(status_code=401, detail="Webhook 鉴权失败")


@router.post("/webhook/{source}", status_code=201)
async def receive_webhook(
    source: str,
    payload: dict[str, Any],
    db: AsyncSession = Depends(get_db_session),
    x_webhook_token: str | None = Header(None, alias="X-Webhook-Token"),
    token: str | None = Query(None),
) -> dict:
    """Receive webhook data and auto-ingest into knowledge base.

    Optional auth: when ``system_config.knowledge_webhook_token`` is set,
    callers must pass it via ``X-Webhook-Token`` header or ``?token=``.
    A missing key keeps the endpoint open for backward compatibility.

    The webhook payload is stored as a new KnowledgeDocument then
    ingested via Hermes with the webhook-refine prompt.
    """
    # ── 可选鉴权：未配置 knowledge_webhook_token 时保持向后兼容 ──────────
    await _check_webhook_auth(db, source, x_webhook_token, token)

    data_str = json.dumps(payload, ensure_ascii=False, indent=2)
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

    # Log the webhook request for monitoring
    from sqlalchemy import text as _text
    await db.execute(
        _text("INSERT INTO webhook_logs (source, payload, status, doc_id) VALUES (:s, :p, :st, :d)"),
        {"s": source, "p": json.dumps(payload, ensure_ascii=False), "st": "received", "d": doc.id},
    )

    logger.info("Webhook received: source={} doc_id={}", source, doc.id)

    # Auto-ingest via Hermes：完整数据分块提炼，不再只发送 2k 预览。
    from app.services.hermes import _hermes_url

    if _hermes_url:
        try:
            doc.status = "processing"
            await db.flush()

            items, hermes_session_id = await _extract_knowledge_from_document(
                doc.title,
                doc.content,
                system_prompt=KNOWLEDGE_WEBHOOK_SYSTEM_PROMPT,
                context_label=f"Webhook 来源：{source}",
            )

            doc.status = "stored"
            doc.hermes_session_id = hermes_session_id or None
            doc.processed_content = json.dumps(items, ensure_ascii=False)[:5000]
            doc.knowledge_id = None
            doc.error_message = None
            await db.flush()
            logger.info(
                "Webhook ingested: source={} doc_id={} items={}",
                source, doc.id, len(items),
            )
        except Exception as exc:
            logger.exception("Webhook ingest failed for {}", doc.id)
            doc.status = "failed"
            doc.error_message = str(exc)[:500]
            await db.flush()
    else:
        logger.warning("Hermes 未配置，Webhook 文档保持 pending: doc_id={}", doc.id)

    return {"ok": True, "doc_id": doc.id, "status": doc.status}


@router.get("/webhooks", response_model=list[dict])
async def list_webhooks(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """List all webhook sources with monitoring data.

    Combines registered sources (from system_config) with actual request
    data (from knowledge_documents + webhook_logs).
    """
    import json as _json
    from app.models import SystemConfig

    # Load registered sources
    reg_row = await db.get(SystemConfig, "webhook_registered")
    raw = _json.loads(reg_row.value) if reg_row and reg_row.value else []
    registered: list[str] = raw if isinstance(raw, list) else []

    # Actual request data
    doc_rows = await db.execute(
        select(
            KnowledgeDocument.source_name,
            func.count(KnowledgeDocument.id).label("doc_count"),
            func.max(KnowledgeDocument.created_at).label("last_request"),
        )
        .where(KnowledgeDocument.source_type == "webhook")
        .group_by(KnowledgeDocument.source_name)
    )
    actual = {r[0]: {"doc_count": r[1], "last_request": r[2].isoformat() if r[2] else None}
              for r in doc_rows.all() if r[0]}

    # Log counts
    from sqlalchemy import text
    log_rows = await db.execute(
        select(
            text("source"),
            func.count(text("id")).label("total_requests"),
        ).select_from(text("webhook_logs")).group_by(text("source"))
    )
    logs = {r[0]: r[1] for r in log_rows.all()}

    # Merge
    result = []
    all_sources = set(registered) | set(actual.keys())
    for source in sorted(all_sources):
        result.append({
            "source": source,
            "registered": source in registered,
            "doc_count": actual.get(source, {}).get("doc_count", 0),
            "total_requests": logs.get(source, 0),
            "last_request": actual.get(source, {}).get("last_request"),
        })
    return result


@router.post("/webhooks/register")
async def register_webhook(
    body: dict,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> dict:
    """Register a new webhook source."""
    import json as _json
    from app.models import SystemConfig

    source = (body.get("source", "")).strip().lower().replace(" ", "_")
    if not source:
        raise HTTPException(status_code=400, detail="来源名称不能为空")

    reg_row = await db.get(SystemConfig, "webhook_registered")
    raw = _json.loads(reg_row.value) if reg_row and reg_row.value else []
    registered: list[str] = raw if isinstance(raw, list) else []
    if source in registered:
        raise HTTPException(status_code=409, detail="Webhook 已存在")

    registered.append(source)
    if reg_row:
        reg_row.value = _json.dumps(registered)
        reg_row.updated_at = func.now()
    else:
        db.add(SystemConfig(key="webhook_registered", value=_json.dumps(registered)))
    await db.flush()
    return {"ok": True, "source": source}


@router.delete("/webhooks/{source}")
async def delete_webhook_source(
    source: str,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> Response:
    """Delete a webhook source: remove registration + clear docs + logs."""
    import json as _json
    from app.models import SystemConfig
    from sqlalchemy import text as _text

    # Remove from registered list
    reg_row = await db.get(SystemConfig, "webhook_registered")
    if reg_row and reg_row.value:
        raw = _json.loads(reg_row.value)
        registered = raw if isinstance(raw, list) else []
        if source in registered:
            registered.remove(source)
            reg_row.value = _json.dumps(registered)
            reg_row.updated_at = func.now()

    # Delete associated docs
    doc_rows = await db.execute(
        select(KnowledgeDocument).where(KnowledgeDocument.source_name == source)
    )
    for doc in doc_rows.scalars():
        await db.delete(doc)

    # Delete logs
    await db.execute(_text("DELETE FROM webhook_logs WHERE source = :s"), {"s": source})
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
# Routes — Knowledge Distillation
# ═══════════════════════════════════════════════════════════════════════════════


class DistilledOut(BaseModel):
    id: int
    title: str
    content: str = ""
    category: str | None = None
    tags: list[str] = Field(default_factory=list)
    source_type: str
    source_ids: list[int] = Field(default_factory=list)
    score: float = 0.0
    score_details: dict = Field(default_factory=dict)
    status: str
    reviewer_id: int | None = None
    knowledge_id: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class DistillTrigger(BaseModel):
    session_ids: list[int] | None = None
    limit: int = Field(default=20, ge=1, le=100)
    min_score: float = Field(default=40.0)


class ReviewRequest(BaseModel):
    action: str  # "approve" | "reject"
    title: str | None = None
    content: str | None = None
    score: float | None = None


class DistillStats(BaseModel):
    total_candidates: int
    approved_count: int
    rejected_count: int
    avg_score: float
    top_categories: list[dict]


@router.post("/distill/trigger")
async def trigger_distillation(
    body: DistillTrigger | None = None,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> dict:
    """Run knowledge distillation on chat sessions.

    Scans conversation history, extracts ops knowledge via LLM,
    scores and persists candidates.
    """
    from app.services.distiller import Distiller

    distiller = Distiller(db)
    result = await distiller.run(
        session_ids=body.session_ids if body else None,
        limit=body.limit if body else 20,
        min_score=body.min_score if body else 40.0,
    )
    return result


@router.get("/distill/candidates", response_model=list[DistilledOut])
async def list_distilled(
    status: str | None = Query(None),
    category: str | None = Query(None),
    min_score: float | None = Query(None),
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[DistilledOut]:
    """List distilled knowledge candidates."""
    from app.models import DistilledKnowledge

    q = select(DistilledKnowledge).order_by(DistilledKnowledge.score.desc())
    if status:
        q = q.where(DistilledKnowledge.status == status)
    if category:
        q = q.where(DistilledKnowledge.category == category)
    if min_score is not None:
        q = q.where(DistilledKnowledge.score >= min_score)
    rows = await db.execute(q.limit(100))
    return [DistilledOut.model_validate(r) for r in rows.scalars()]


@router.post("/distill/{dk_id}/review", response_model=DistilledOut)
async def review_distilled(
    dk_id: int,
    body: ReviewRequest,
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> DistilledOut:
    """Approve or reject a distilled knowledge candidate."""
    from app.models import DistilledKnowledge

    dk = await db.get(DistilledKnowledge, dk_id)
    if not dk:
        raise HTTPException(status_code=404, detail="候选知识不存在")

    if body.action == "approve":
        dk.status = "approved"
        dk.reviewer_id = user.id
    elif body.action == "reject":
        dk.status = "rejected"
        dk.reviewer_id = user.id
    else:
        raise HTTPException(status_code=400, detail="无效操作")

    if body.title is not None:
        dk.title = body.title
    if body.content is not None:
        dk.content = body.content
    if body.score is not None:
        dk.score = body.score

    await db.flush()

    # If approved and score >= 70, auto-ingest to knowledge base
    if body.action == "approve" and dk.score >= 70:
        try:
            from app.services.distiller import Distiller
            distiller = Distiller(db)
            await distiller._auto_ingest(dk)
        except Exception:
            logger.exception("Review ingest failed for dk {}", dk_id)

    return DistilledOut.model_validate(dk)


@router.get("/distill/queue")
async def get_distill_queue(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Get the number of sessions waiting for distillation."""
    from app.models import ChatSession
    row = await db.execute(
        select(func.count(ChatSession.id)).where(
            ChatSession.distillation_status.is_(None),
        )
    )
    total = await db.execute(select(func.count(ChatSession.id)))
    done = await db.execute(
        select(func.count(ChatSession.id)).where(ChatSession.distillation_status.isnot(None))
    )
    return {
        "queue_count": row.scalar() or 0,
        "total_sessions": total.scalar() or 0,
        "processed": done.scalar() or 0,
    }


@router.get("/distill/stats", response_model=DistillStats)
async def get_distill_stats(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> DistillStats:
    """Get distillation statistics."""
    from app.models import DistilledKnowledge

    total = (await db.execute(select(func.count(DistilledKnowledge.id)))).scalar() or 0
    approved = (await db.execute(
        select(func.count(DistilledKnowledge.id)).where(DistilledKnowledge.status == "approved")
    )).scalar() or 0
    rejected = (await db.execute(
        select(func.count(DistilledKnowledge.id)).where(DistilledKnowledge.status == "rejected")
    )).scalar() or 0
    avg = (await db.execute(select(func.avg(DistilledKnowledge.score)))).scalar() or 0.0
    cats = await db.execute(
        select(DistilledKnowledge.category, func.count(DistilledKnowledge.id))
        .where(DistilledKnowledge.category.isnot(None))
        .group_by(DistilledKnowledge.category)
        .order_by(func.count(DistilledKnowledge.id).desc())
        .limit(5)
    )
    return DistillStats(
        total_candidates=total,
        approved_count=approved,
        rejected_count=rejected,
        avg_score=round(float(avg), 1),
        top_categories=[{"category": r[0], "count": r[1]} for r in cats.all()],
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Auto-distill Config
# ═══════════════════════════════════════════════════════════════════════════════


@router.get("/distill/config")
async def get_distill_config(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    """Get auto-distillation configuration."""
    from app.models import SystemConfig

    rows = await db.execute(
        select(SystemConfig).where(
            SystemConfig.key.in_(["distill_auto_enabled", "distill_interval_secs"])
        )
    )
    cfg = {r.key: r.value for r in rows.scalars()}
    return {
        "auto_enabled": cfg.get("distill_auto_enabled", "false") == "true",
        "interval_secs": int(cfg.get("distill_interval_secs", "3600")),
    }


@router.put("/distill/config")
async def set_distill_config(
    body: dict,
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> dict:
    """Configure auto-distillation."""
    from app.models import SystemConfig

    entries = {
        "distill_auto_enabled": "true" if body.get("auto_enabled") else "false",
        "distill_interval_secs": str(body.get("interval_secs", 3600)),
    }
    for key, value in entries.items():
        row = await db.get(SystemConfig, key)
        if row:
            row.value = value
            row.updated_at = func.now()
        else:
            db.add(SystemConfig(key=key, value=value))
    await db.flush()
    return await get_distill_config(db=db, user=_admin)


# ═══════════════════════════════════════════════════════════════════════════════
# Routes — Knowledge Enhancement (v0.5)
# ═══════════════════════════════════════════════════════════════════════════════


@router.post("/expire")
async def expire_stale_knowledge(
    db: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(require_admin),
) -> dict:
    """Archive knowledge documents that haven't been hit in 90+ days."""
    from sqlalchemy import text as _text

    await db.execute(
        _text("UPDATE knowledge_documents SET archived = TRUE WHERE status = 'stored' AND updated_at < NOW() - INTERVAL '90 days'")
    )
    await db.flush()
    rows = await db.execute(select(func.count(KnowledgeDocument.id)).where(KnowledgeDocument.archived == True))  # noqa: E712
    return {"archived_count": rows.scalar() or 0}


@router.get("/blindspots")
async def get_knowledge_blindspots(
    db: AsyncSession = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """List unanswered queries that suggest knowledge blind spots."""
    from sqlalchemy import text as _text

    rows = await db.execute(
        _text("SELECT question, count, last_asked FROM unanswered_queries WHERE count >= 2 ORDER BY count DESC LIMIT 20")
    )
    return [{"question": r[0], "count": r[1], "last_asked": r[2].isoformat() if r[2] else None} for r in rows.all()]


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
