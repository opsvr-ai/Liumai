#!/usr/bin/env python3
"""
企业微信（WeCom）群操作脚本

六脉应急协同技能的核心脚本。通过企业微信自建应用 API 完成
以下操作：
- create:     创建作战室群聊
- send:       向群内发送进度消息
- parse:      解析 @bot 提及消息，提取结构化工单

Usage:
    # 创建群聊
    python wecom_group.py create \\
        --name "故障定界-#12345-order-service" \\
        --members userid1,userid2

    # 发送进度消息
    python wecom_group.py send \\
        --chat-id wr_xxxx \\
        --step "query_monitoring" \\
        --status "completed" \\
        --detail '{"anomaly_score": 0.85, ...}'

    # 解析 @bot 提及消息
    python wecom_group.py parse \\
        --message "@六脉机器人 我们刚刚重启了 db-01，看起来内存泄漏了"

Environment:
    WECOM_CORP_ID:     企业微信 CorpID
    WECOM_CORP_SECRET: 企业微信自建应用 Secret
    WECOM_AGENT_ID:    企业微信自建应用 AgentID
    WECOM_BOT_ID:      企业微信 Bot ID（WEBHOOK）
    WECOM_SECRET:      企业微信 Bot Secret
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


# ─── 工具函数 ───────────────────────────────────────────────────────


def _load_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        print(json.dumps({"error": f"环境变量 {key} 未设置"}, ensure_ascii=False))
        sys.exit(1)
    return val


def _http_post(url: str, data: dict, desc: str = "") -> dict:
    """HTTP POST 请求通用函数"""
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        if result.get("errcode", 0) != 0:
            raise RuntimeError(
                f"WeCom API 错误 [{desc}]: "
                f"errcode={result['errcode']}, errmsg={result.get('errmsg', '')}"
            )
        return result
    except HTTPError as e:
        raise RuntimeError(
            f"HTTP 请求失败 [{desc}]: {e.code} {e.reason}"
        ) from e
    except URLError as e:
        raise RuntimeError(
            f"网络连接失败 [{desc}]: {e.reason}"
        ) from e


def _get_access_token() -> str:
    """获取企业微信自建应用的 Access Token"""
    corp_id = _load_env("WECOM_CORP_ID")
    corp_secret = _load_env("WECOM_CORP_SECRET")
    url = f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={corp_id}&corpsecret={corp_secret}"
    result = _http_post(url, {}, desc="get_access_token")
    return result["access_token"]


# ─── 创建群聊 ────────────────────────────────────────────────────────


def cmd_create(args: argparse.Namespace):
    """
    创建企业微信作战室群聊。

    通过自建应用 API 创建临时群，用于故障协同。
    API: POST /cgi-bin/appchat/create
    """
    token = _get_access_token()
    agent_id = _load_env("WECOM_AGENT_ID")
    url = f"https://qyapi.weixin.qq.com/cgi-bin/appchat/create?access_token={token}"

    payload = {
        "name": args.name,
        "owner": args.members[0] if args.members else "",
        "userlist": args.members,
        "chatid": args.chat_id or "",
    }

    result = _http_post(url, payload, desc="create_chat")
    chat_id = result.get("chatid", "")

    output = {
        "action": "create",
        "chat_id": chat_id,
        "name": args.name,
        "member_count": len(args.members),
        "success": True,
        "created_at": datetime.now(timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


# ─── 发送进度消息 ────────────────────────────────────────────────────


def cmd_send(args: argparse.Namespace):
    """
    向群聊发送 Markdown 进度消息。

    根据 step 和 status 生成格式化的 Markdown 消息体。
    API: POST /cgi-bin/appchat/send
    """
    token = _get_access_token()
    url = f"https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token={token}"

    status_emoji = {
        "investigating": "🔍",
        "completed": "✅",
        "failed": "❌",
        "needs_input": "📢",
    }
    status_label = {
        "investigating": "调查中",
        "completed": "已完成",
        "failed": "失败",
        "needs_input": "需人工介入",
    }

    emoji = status_emoji.get(args.status, "❓")
    label = status_label.get(args.status, args.status)

    # 解析 detail JSON
    try:
        detail_obj = json.loads(args.detail) if isinstance(args.detail, str) else args.detail
    except json.JSONDecodeError:
        detail_obj = {"raw": args.detail[:500]}

    step_names = {
        "initial_brief": "事件简报",
        "query_monitoring": "监控指标分析",
        "query_logs": "日志分析",
        "query_clickhouse": "ClickHouse 事务分析",
        "correlation": "跨源关联分析",
        "completed": "定界完成",
    }
    step_name = step_names.get(args.step, args.step)

    # 构建 Markdown 消息
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    markdown_lines = [
        f"## {emoji} {step_name} — {label}",
        f"> 更新时间：{now_str}",
        "---",
    ]

    if isinstance(detail_obj, dict):
        for key, val in detail_obj.items():
            if isinstance(val, (list, dict)):
                markdown_lines.append(f"**{key}**：```json\n{json.dumps(val, ensure_ascii=False, indent=2)[:300]}\n```")
            else:
                markdown_lines.append(f"**{key}**：{val}")
    else:
        markdown_lines.append(str(detail_obj)[:500])

    content = "\n".join(markdown_lines)

    payload = {
        "chatid": args.chat_id,
        "msgtype": "markdown",
        "markdown": {
            "content": content[:2048],  # 企业微信限制
        },
    }

    _http_post(url, payload, desc="send_message")

    output = {
        "action": "send",
        "chat_id": args.chat_id,
        "step": args.step,
        "status": args.status,
        "success": True,
        "sent_at": now_str,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


# ─── 解析 @bot 消息 ─────────────────────────────────────────────────


def cmd_parse(args: argparse.Namespace):
    """
    解析群成员发送的 @bot 消息，提取结构化发现。

    支持的消息模式：
    - "@机器人 xxx" — 纯文本发现
    - "@机器人 trace_id=xxx ..." — 带 Trace ID 的反馈
    - "@机器人 已处理/已修复/已重启 xxx" — 人工操作记录
    """
    text = args.message

    # 提取 @mention（兼容 @六脉机器人 / @六脉 / @liumai-bot）
    mention_match = re.match(
        r"@(?:六脉机器人|六脉|liumai-bot|机器人)\s*(.*)",
        text.strip(),
        re.IGNORECASE,
    )
    if not mention_match:
        output = {
            "action": "parse",
            "is_mention": False,
            "message": text[:200],
            "finding": None,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    content = mention_match.group(1).strip()

    # 提取结构化信息
    finding: dict[str, Any] = {
        "raw_text": content[:500],
        "timestamp": datetime.now(timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # 提取 Trace ID / Transaction ID
    trace_match = re.search(
        r"(?:trace_id|traceId|transaction_id|txn_id)[=:]\s*(\S+)",
        content, re.IGNORECASE,
    )
    if trace_match:
        finding["trace_id"] = trace_match.group(1)

    # 提取服务名
    service_match = re.search(
        r"(?:service|服务)[=:]\s*(\S+)",
        content, re.IGNORECASE,
    )
    if service_match:
        finding["service"] = service_match.group(1)

    # 提取主机/节点
    node_match = re.search(
        r"(?:node|host|server|实例|节点)[=:\s]*(\S+)",
        content, re.IGNORECASE,
    )
    if node_match:
        finding["node"] = node_match.group(1)

    # 分类消息意图
    if re.search(r"(?:已处理|已修复|已解决|已恢复|已完成|fixed|resolved|done)", content, re.IGNORECASE):
        finding["intent"] = "resolution"
    elif re.search(r"(?:重启|回滚|切换|扩容|relaunch|rollback|restart)", content, re.IGNORECASE):
        finding["intent"] = "mitigation_action"
    elif re.search(r"(?:原因|root.cause|根本原因|可能(?:是|为))", content, re.IGNORECASE):
        finding["intent"] = "root_cause_clue"
    elif re.search(r"(?:怀疑|注意|观察|发现|noticed|observed|suspected)", content, re.IGNORECASE):
        finding["intent"] = "observation"
    else:
        finding["intent"] = "general_feedback"

    output = {
        "action": "parse",
        "is_mention": True,
        "message": text[:200],
        "finding": finding,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


# ─── 主入口 ──────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="企业微信群操作脚本")
    subparsers = parser.add_subparsers(dest="command", required=True,
                                       help="操作命令")

    # create 子命令
    create_parser = subparsers.add_parser("create", help="创建作战室群聊")
    create_parser.add_argument("--name", required=True, help="群名称")
    create_parser.add_argument("--members", nargs="+", required=True,
                               help="成员 UserID 列表")
    create_parser.add_argument("--chat-id", default="", help="自定义群 ID（可选）")

    # send 子命令
    send_parser = subparsers.add_parser("send", help="发送进度消息")
    send_parser.add_argument("--chat-id", required=True, help="群聊 ID")
    send_parser.add_argument("--step", required=True,
                             choices=[
                                 "initial_brief", "query_monitoring",
                                 "query_logs", "query_clickhouse",
                                 "correlation", "completed",
                             ],
                             help="RCA 步骤名称")
    send_parser.add_argument("--status", required=True,
                             choices=["investigating", "completed", "failed", "needs_input"],
                             help="步骤状态")
    send_parser.add_argument("--detail", default="{}", help="详情 JSON 字符串")
    send_parser.add_argument("--file", help="从文件读取 detail")

    # parse 子命令
    parse_parser = subparsers.add_parser("parse", help="解析 @bot 消息")
    parse_parser.add_argument("--message", required=True, help="消息全文")

    args = parser.parse_args()

    # 如果 send 命令指定了 --file，从文件读取 detail
    if hasattr(args, "file") and args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            args.detail = f.read()

    if args.command == "create":
        cmd_create(args)
    elif args.command == "send":
        cmd_send(args)
    elif args.command == "parse":
        cmd_parse(args)


if __name__ == "__main__":
    main()
