"""Unified multi-channel notification dispatch.

One entry point — :func:`send_notification` — fans a single RCA event out to the
channels selected by ``policy.notify.channels`` (default ``["wecom"]``):

* ``wecom``   — reuses the existing WeCom app-chat markdown sender
  (:class:`app.services.wecom.WeComClient`).  Missing chat id or credentials is
  a silent no-op, exactly like the previous ``rca_runner._notify``.
* ``webhook`` — ``POST`` a compact JSON envelope
  ``{title, markdown, links, session_id, ts}`` to ``policy.notify.webhook_url``
  with a 5 s timeout.
* ``email``   — stdlib :mod:`smtplib` plain-text + HTML mail.  The SMTP relay
  (host/port/user/pass) and fallback recipients come from environment
  variables, never from the policy: ``SMTP_HOST``, ``SMTP_PORT``, ``SMTP_USER``,
  ``SMTP_PASS`` (or ``SMTP_PASSWORD``), ``SMTP_FROM``, ``SMTP_TO``,
  ``SMTP_SSL`` / ``SMTP_TLS``.  When the relay or the recipient list is not
  configured the channel is **silently skipped** (debug log only).

Failure isolation
-----------------
Every channel runs inside its own ``try``/``except``: a broken webhook or mail
server produces a single ``warning`` and never prevents the other channels from
running, nor does it ever bubble up into the RCA session.  ``asyncio``
cancellation is the only exception that is re-raised.

Persistence note (no ``alert_pipeline.py`` change)
--------------------------------------------------
``alert_pipeline.save_policy`` strips the ``notify`` object before storing the
JSON policy and persists only ``notify.enabled`` / ``notify.wecom_chat_id`` as
``system_config`` rows.  To let the alert UI save per-channel options without
touching that module, the UI writes them under the root key ``notify_ext``
(which the generic deep-merge *does* persist).  This module therefore resolves
the effective config from ``policy.notify`` first and ``policy.notify_ext`` as a
fallback — a plain ``{"notify": {"channels": [...]}}`` policy keeps working, so
both shapes are supported.
"""

from __future__ import annotations

import asyncio
import html
import os
import re
import smtplib
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formatdate
from typing import Any, Iterable

import httpx
from loguru import logger

from app.config import settings
from app.services.wecom import WeComClient

__all__ = ["DEFAULT_CHANNELS", "SUPPORTED_CHANNELS", "send_notification"]

# ── Tuning ───────────────────────────────────────────────────────────────────

DEFAULT_CHANNELS: tuple[str, ...] = ("wecom",)
SUPPORTED_CHANNELS: frozenset[str] = frozenset({"wecom", "webhook", "email"})

WEBHOOK_TIMEOUT_SECONDS = 5.0
WECOM_TIMEOUT_SECONDS = 15.0
EMAIL_TIMEOUT_SECONDS = 20.0
# WeCom markdown content is capped at 4096 bytes; keep a safe character budget
# so Chinese text never trips the upstream limit.
WECOM_CONTENT_LIMIT = 1800

# Root-level fallback key used by the alert UI (see module docstring).
NOTIFY_EXT_KEY = "notify_ext"

_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


# ═══════════════════════════════════════════════════════════════════════════════
# Policy helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _truthy(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("1", "true", "yes", "on"):
            return True
        if text in ("0", "false", "no", "off", ""):
            return False
    return default


def _setting(name: str) -> str:
    """Env var first, then an optional ``settings`` field (no config.py edit)."""
    value = os.getenv(name)
    if value is None or str(value).strip() == "":
        value = getattr(settings, name, "")
    return str(value or "").strip()


def _address_list(value: Any) -> list[str]:
    """Normalise e-mail recipients (list or comma/semicolon/newline string)."""
    if value is None:
        return []
    if isinstance(value, str):
        parts: Iterable[Any] = re.split(r"[,;\s]+", value)
    elif isinstance(value, (list, tuple, set)):
        parts = value
    else:
        parts = [value]
    out: list[str] = []
    for part in parts:
        address = str(part or "").strip()
        if not address or "@" not in address:
            continue
        if address not in out:
            out.append(address)
        if len(out) >= 50:
            break
    return out


def _normalise_channels(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        return list(DEFAULT_CHANNELS)
    channels: list[str] = []
    for item in value:
        name = str(item or "").strip().lower()
        if name and name not in channels:
            channels.append(name)
    return channels or list(DEFAULT_CHANNELS)


def notify_config(policy: dict[str, Any] | None) -> dict[str, Any]:
    """Effective notify config: ``policy.notify`` wins over ``notify_ext``.

    A missing ``enabled`` flag is treated as enabled (a caller that explicitly
    configured channels clearly wants them); an explicit ``false`` disables the
    whole dispatch, preserving the historical notification switch semantics.
    """
    policy = policy or {}
    notify = policy.get("notify")
    notify = dict(notify) if isinstance(notify, dict) else {}

    extra = policy.get(NOTIFY_EXT_KEY)
    if isinstance(extra, dict):
        for key, value in extra.items():
            current = notify.get(key)
            if current in (None, "", []):
                notify[key] = value

    notify["channels"] = _normalise_channels(notify.get("channels"))
    if notify.get("enabled") is None:
        notify["enabled"] = True
    return notify


# ═══════════════════════════════════════════════════════════════════════════════
# Links / payload helpers
# ═══════════════════════════════════════════════════════════════════════════════


def _normalise_links(links: Any) -> list[dict[str, str]]:
    """Accept dict / list[dict] / list[(label, url)] / list[str] link shapes."""
    out: list[dict[str, str]] = []

    def _add(label: Any, url: Any) -> None:
        text = str(url or "").strip()
        if not text:
            return
        out.append({"label": str(label or text).strip() or text, "url": text})

    if isinstance(links, dict):
        for label, url in links.items():
            _add(label, url)
    elif isinstance(links, (list, tuple, set)):
        for item in links:
            if isinstance(item, dict):
                _add(item.get("label") or item.get("title"), item.get("url"))
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                _add(item[0], item[1])
            elif isinstance(item, str):
                _add(item, item)
    elif isinstance(links, str):
        _add(links, links)
    return out


def _mask_url(url: str) -> str:
    """Hide credentials/query strings so warnings never leak secrets."""
    text = (url or "").strip()
    text = re.sub(r"//[^/@]*@", "//***@", text)
    return text.split("?", 1)[0][:200]


# ═══════════════════════════════════════════════════════════════════════════════
# WeCom channel
# ═══════════════════════════════════════════════════════════════════════════════


def _wecom_configured() -> bool:
    """True only when real credentials are present (template values count as off)."""
    corp = str(settings.WECOM_CORP_ID or "").strip()
    secret = str(settings.WECOM_CORP_SECRET or "").strip()
    if not corp or not secret:
        return False
    if corp.lower().startswith("your_") or secret.lower().startswith("your_"):
        return False
    return True


async def _send_wecom(conf: dict[str, Any], markdown: str) -> tuple[str, str]:
    chat_id = str(conf.get("wecom_chat_id") or "").strip()
    if not chat_id or not _wecom_configured():
        return "skipped", "企业微信未配置（chat_id 或凭据缺失）"
    try:
        await asyncio.wait_for(
            WeComClient().send_message(
                chat_id, str(markdown)[:WECOM_CONTENT_LIMIT], msg_type="markdown",
            ),
            timeout=WECOM_TIMEOUT_SECONDS,
        )
        return "sent", ""
    except asyncio.TimeoutError:
        logger.warning("企业微信 RCA 通知超时（已跳过，不影响其它通道）")
        return "failed", "timeout"
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 单通道失败只 warning
        logger.warning("企业微信 RCA 通知失败（不影响其它通道）: {}", exc)
        return "failed", str(exc)[:300]


# ═══════════════════════════════════════════════════════════════════════════════
# Webhook channel
# ═══════════════════════════════════════════════════════════════════════════════


async def _send_webhook(
    conf: dict[str, Any],
    *,
    title: str,
    markdown: str,
    links: list[dict[str, str]],
    session_id: int | None,
) -> tuple[str, str]:
    url = str(conf.get("webhook_url") or "").strip()
    if not url:
        return "skipped", "未配置 webhook_url"
    if not url.lower().startswith(("http://", "https://")):
        logger.warning(
            "RCA Webhook 通知地址非法（已跳过）: {}", _mask_url(url),
        )
        return "skipped", "invalid_url"
    payload = {
        "title": str(title),
        "markdown": str(markdown),
        "links": links,
        "session_id": session_id,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    try:
        async with httpx.AsyncClient(timeout=WEBHOOK_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload)
        if response.status_code >= 400:
            logger.warning(
                "RCA Webhook 通知失败 HTTP {}（不影响其它通道）url={}",
                response.status_code,
                _mask_url(url),
            )
            return "failed", f"HTTP {response.status_code}"
        return "sent", ""
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 单通道失败只 warning
        logger.warning(
            "RCA Webhook 通知失败（不影响其它通道）url={} err={}",
            _mask_url(url),
            exc,
        )
        return "failed", str(exc)[:300]


# ═══════════════════════════════════════════════════════════════════════════════
# Email channel (stdlib smtplib, env-configured relay)
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _SmtpConfig:
    host: str
    port: int
    user: str
    password: str
    sender: str
    recipients: tuple[str, ...]
    use_ssl: bool
    use_tls: bool


def _smtp_config(conf: dict[str, Any]) -> _SmtpConfig | None:
    """Build the SMTP config, or ``None`` when mail is not fully configured.

    Requires relay host + account + password + at least one recipient.  Port
    defaults to 465 (SSL) or 587 (STARTTLS).  Recipients come from the policy
    (``notify.email_to``) with ``SMTP_TO`` as the fallback.
    """
    host = _setting("SMTP_HOST")
    user = _setting("SMTP_USER")
    password = _setting("SMTP_PASS") or _setting("SMTP_PASSWORD")
    if not host or not user or not password:
        return None

    sender = _setting("SMTP_FROM") or user
    recipients = _address_list(conf.get("email_to")) or _address_list(
        _setting("SMTP_TO")
    )
    if not recipients or not sender:
        return None

    ssl_flag = _truthy(_setting("SMTP_SSL") or _setting("SMTP_USE_SSL"), False)
    raw_port = _setting("SMTP_PORT")
    if raw_port:
        try:
            port = int(raw_port)
        except ValueError:
            return None
    else:
        port = 465 if ssl_flag else 587
    use_ssl = ssl_flag or port == 465
    # STARTTLS is the sensible default for plain SMTP; explicit off wins.
    raw_tls = _setting("SMTP_TLS") or _setting("SMTP_USE_TLS")
    use_tls = _truthy(raw_tls, not use_ssl)

    return _SmtpConfig(
        host=host,
        port=port,
        user=user,
        password=password,
        sender=sender,
        recipients=tuple(recipients),
        use_ssl=use_ssl,
        use_tls=use_tls,
    )


def _markdown_to_text(markdown: str, links: list[dict[str, str]]) -> str:
    text = _LINK_RE.sub(lambda m: f"{m.group(1)} ({m.group(2)})", str(markdown or ""))
    text = _BOLD_RE.sub(lambda m: m.group(1), text)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.MULTILINE)
    lines = [line.rstrip() for line in text.strip().splitlines() if line.strip()]
    if links:
        lines.append("")
        lines.append("链接：")
        lines.extend(f"- {item['label']}: {item['url']}" for item in links)
    return "\n".join(lines) or "(无内容)"


def _markdown_to_html(markdown: str, links: list[dict[str, str]]) -> str:
    body: list[str] = []
    for raw in str(markdown or "").strip().splitlines():
        if not raw.strip():
            continue
        line = html.escape(raw, quote=True)
        line = _LINK_RE.sub(
            lambda m: (
                f'<a href="{m.group(2)}" rel="noopener noreferrer">'
                f"{m.group(1)}</a>"
            ),
            line,
        )
        line = _BOLD_RE.sub(lambda m: f"<strong>{m.group(1)}</strong>", line)
        if re.match(r"^\s*>\s?", raw):
            body.append(
                f'<p class="quote">{re.sub(r"^&gt;\s?", "", line)}</p>'
            )
        else:
            body.append(f"<p>{line}</p>")
    if links:
        items = "".join(
            f'<li><a href="{html.escape(item["url"], quote=True)}" '
            f'rel="noopener noreferrer">{html.escape(item["label"])}</a></li>'
            for item in links
        )
        body.append(f"<ul>{items}</ul>")
    inner = "\n".join(body) or "<p>(无内容)</p>"
    return (
        "<html><body style=\"font-family:system-ui,-apple-system,'Segoe UI',"
        "sans-serif;color:#1f2933;line-height:1.55\">"
        f"{inner}"
        "</body></html>"
    )


def _send_email_sync(
    smtp: _SmtpConfig,
    *,
    subject: str,
    markdown: str,
    links: list[dict[str, str]],
) -> None:
    message = EmailMessage()
    message["Subject"] = (subject or "六脉 RCA 通知")[:200]
    message["From"] = smtp.sender
    message["To"] = ", ".join(smtp.recipients)
    message["Date"] = formatdate(localtime=False)
    message.set_content(_markdown_to_text(markdown, links))
    message.add_alternative(_markdown_to_html(markdown, links), subtype="html")

    context = ssl.create_default_context()
    if smtp.use_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            smtp.host, smtp.port, timeout=EMAIL_TIMEOUT_SECONDS, context=context,
        )
    else:
        server = smtplib.SMTP(smtp.host, smtp.port, timeout=EMAIL_TIMEOUT_SECONDS)
    with server:
        if not smtp.use_ssl and smtp.use_tls:
            server.starttls(context=context)
            server.ehlo()
        server.login(smtp.user, smtp.password)
        server.send_message(message)


async def _send_email(
    conf: dict[str, Any],
    *,
    title: str,
    markdown: str,
    links: list[dict[str, str]],
) -> tuple[str, str]:
    smtp = _smtp_config(conf)
    if smtp is None:
        # 未配置 SMTP / 收件人：静默跳过（仅 debug，避免刷告警日志）。
        logger.debug("邮件通知未配置（SMTP 或收件人缺失），已静默跳过")
        return "skipped", "SMTP 未配置"
    try:
        await asyncio.wait_for(
            asyncio.to_thread(
                _send_email_sync,
                smtp,
                subject=title,
                markdown=markdown,
                links=links,
            ),
            timeout=EMAIL_TIMEOUT_SECONDS + 5,
        )
        return "sent", ""
    except asyncio.TimeoutError:
        logger.warning("RCA 邮件通知超时（已跳过，不影响其它通道）")
        return "failed", "timeout"
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 单通道失败只 warning
        logger.warning("RCA 邮件通知失败（不影响其它通道）: {}", exc)
        return "failed", str(exc)[:300]


# ═══════════════════════════════════════════════════════════════════════════════
# Public entry point
# ═══════════════════════════════════════════════════════════════════════════════


async def send_notification(
    policy: dict[str, Any] | None,
    title: str,
    markdown: str,
    links: Any = None,
    *,
    session_id: int | None = None,
) -> list[dict[str, Any]]:
    """Deliver one notification to every channel enabled by *policy*.

    Returns a per-channel result list (``{"channel", "status", "detail"}``) for
    logging/observability.  The call is strictly best-effort: it never raises
    for transport problems, and a disabled policy is a silent no-op.
    """
    conf = notify_config(policy)
    if not conf.get("enabled"):
        return []

    channels = conf["channels"]
    normalised_links = _normalise_links(links)
    title = str(title or "六脉 RCA 通知")
    markdown = str(markdown or "")
    results: list[dict[str, Any]] = []

    for channel in channels:
        status, detail = "skipped", "不支持的通知通道"
        try:
            if channel == "wecom":
                status, detail = await _send_wecom(conf, markdown)
            elif channel == "webhook":
                status, detail = await _send_webhook(
                    conf,
                    title=title,
                    markdown=markdown,
                    links=normalised_links,
                    session_id=session_id,
                )
            elif channel == "email":
                status, detail = await _send_email(
                    conf,
                    title=title,
                    markdown=markdown,
                    links=normalised_links,
                )
            else:
                logger.warning("未知通知通道 {!r}，已跳过", channel)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — 通道之间必须互相隔离
            status, detail = "failed", str(exc)[:300]
            logger.warning(
                "RCA 通知通道 {} 异常（不影响其它通道）: {}", channel, exc,
            )
        results.append({"channel": channel, "status": status, "detail": detail})
    return results
