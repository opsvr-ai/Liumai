"""WeCom (WeChat Work) Self-Built App API client.

Implements D-02: hybrid model where the self-built app API handles
group creation and the Hermes WeCom Bot WebSocket adapter handles
in-group messaging and interaction.

Documentation reference: https://developer.work.weixin.qq.com/document/
"""

from __future__ import annotations

import time
from typing import Any

import httpx
from loguru import logger

from app.config import settings

# ── API endpoints ────────────────────────────────────────────────────────────

WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin"

# ═══════════════════════════════════════════════════════════════════════════════
# Client
# ═══════════════════════════════════════════════════════════════════════════════


class WeComClient:
    """HTTP client for the WeCom (WeChat Work) self-built app API.

    Handles OAuth token acquisition and common API operations for
    emergency collaboration group management.

    Usage::

        wecom = WeComClient()
        token = await wecom.get_access_token()
        chat_id = await wecom.create_group("incident-42", ["user1", "user2"])
    """

    def __init__(self) -> None:
        self._access_token: str | None = None
        self._token_expires_at: float = 0.0

    # ── Token management ──────────────────────────────────────────────────

    async def get_access_token(self) -> str:
        """Obtain or refresh the OAuth access token.

        Uses ``corpid`` + ``corpsecret`` from platform settings.
        Tokens are cached until they expire (default 7200 s).
        """
        if (
            self._access_token
            and time.time() < self._token_expires_at - 60
        ):
            return self._access_token

        if not settings.WECOM_CORP_ID or not settings.WECOM_CORP_SECRET:
            raise RuntimeError(
                "WeCom credentials not configured: set WECOM_CORP_ID "
                "and WECOM_CORP_SECRET environment variables."
            )

        url = f"{WECOM_API_BASE}/gettoken"
        params = {
            "corpid": settings.WECOM_CORP_ID,
            "corpsecret": settings.WECOM_CORP_SECRET,
        }

        async with httpx.AsyncClient() as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode") != 0:
            raise RuntimeError(
                f"WeCom token request failed: {data.get('errmsg', 'unknown')}"
            )

        self._access_token = data["access_token"]
        self._token_expires_at = time.time() + data.get("expires_in", 7200)
        logger.debug("WeCom access token refreshed (expires in {}s)", data.get("expires_in", 7200))
        return self._access_token

    # ── Group (chat) management ───────────────────────────────────────────

    async def create_group(
        self,
        name: str,
        user_ids: list[str],
        owner_userid: str | None = None,
    ) -> str:
        """Create an internal WeCom group chat (war room).

        Args:
            name: Group chat name (e.g. "incident-2026-07-17").
            user_ids: List of user IDs to add (must include the bot).
            owner_userid: Optional owner of the group (defaults to creator).

        Returns:
            The WeCom ``chat_id`` of the newly created group.

        Raises:
            RuntimeError: If the API call fails.
        """
        token = await self.get_access_token()
        url = f"{WECOM_API_BASE}/appchat/create?access_token={token}"

        payload: dict[str, Any] = {
            "name": name,
            "userlist": user_ids,
        }
        if owner_userid:
            payload["owner"] = owner_userid

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode") != 0:
            raise RuntimeError(
                f"WeCom group creation failed: {data.get('errmsg', 'unknown')}"
            )

        chat_id = data["chatid"]
        logger.info("WeCom group created: name={!r} chat_id={}", name, chat_id)
        return chat_id

    # ── Messaging ─────────────────────────────────────────────────────────

    async def send_message(
        self,
        chat_id: str,
        content: str,
        msg_type: str = "text",
    ) -> None:
        """Send a message to an existing group chat.

        Args:
            chat_id: Target group chat ID.
            content: Message body (plain text or markdown).
            msg_type: ``"text"`` or ``"markdown"``.

        Raises:
            RuntimeError: If the API call fails.
        """
        token = await self.get_access_token()
        url = f"{WECOM_API_BASE}/appchat/send?access_token={token}"

        payload: dict[str, Any] = {
            "chatid": chat_id,
            "msgtype": msg_type,
        }
        if msg_type == "markdown":
            payload["markdown"] = {"content": content}
        else:
            payload["text"] = {"content": content}

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode") != 0:
            raise RuntimeError(
                f"WeCom message send failed: {data.get('errmsg', 'unknown')}"
            )

        logger.debug("WeCom message sent to chat_id={} (type={})", chat_id, msg_type)

    # ── Bot management ────────────────────────────────────────────────────

    async def add_bot_to_group(
        self,
        chat_id: str,
        bot_user_id: str,
    ) -> None:
        """Add a Hermes Bot user to an existing group chat.

        After creation, the Hermes WeCom Bot (WebSocket) takes over
        in-group messaging for bidirectional communication.

        Args:
            chat_id: Target group chat ID.
            bot_user_id: The UserID of the Hermes bot in WeCom.
        """
        token = await self.get_access_token()
        url = f"{WECOM_API_BASE}/appchat/update?access_token={token}"

        payload = {
            "chatid": chat_id,
            "add_user_list": [bot_user_id],
        }

        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode") != 0:
            raise RuntimeError(
                f"WeCom add bot to group failed: {data.get('errmsg', 'unknown')}"
            )

        logger.info("Bot {} added to group chat_id={}", bot_user_id, chat_id)
