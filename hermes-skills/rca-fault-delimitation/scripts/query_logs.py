#!/usr/bin/env python3
"""
日志易（rizhiyi）日志查询适配器

六脉 RCA 技能的数据源脚本之一。连接日志易 API 在指定时间窗口内
搜索日志条目，支持错误模式匹配和日志聚类。

Usage:
    python query_logs.py \\
        --host RIZHIYI_API_URL \\
        --service my-service \\
        --time-start 2026-07-17T10:00:00Z \\
        --time-end 2026-07-17T10:30:00Z \\
        --pattern "error|exception|timeout|OOM|panic"

Environment:
    RIZHIYI_API_URL:  日志易 API 基础地址（覆盖 --host）
    RIZHIYI_API_TOKEN: 日志易 API 鉴权 Token
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def parse_args():
    parser = argparse.ArgumentParser(description="日志易日志查询适配器")
    parser.add_argument("--host", default="http://localhost:8080",
                        help="日志易 API 地址（默认 http://localhost:8080）")
    parser.add_argument("--service", required=True,
                        help="目标服务名称")
    parser.add_argument("--time-start", required=True,
                        help="查询开始时间（ISO8601，如 2026-07-17T10:00:00Z）")
    parser.add_argument("--time-end", required=True,
                        help="查询结束时间（ISO8601，如 2026-07-17T10:30:00Z）")
    parser.add_argument("--pattern", default="error|exception|timeout",
                        help="错误匹配模式（正则表达式，默认 error|exception|timeout）")
    parser.add_argument("--max-results", type=int, default=1000,
                        help="最大返回条目数（默认 1000）")
    return parser.parse_args()


def resolve_base_url(cli_host: str) -> str:
    env_url = os.environ.get("RIZHIYI_API_URL")
    return env_url.rstrip("/") if env_url else cli_host.rstrip("/")


def resolve_token() -> str | None:
    return os.environ.get("RIZHIYI_API_TOKEN")


def classify_level(message: str) -> str:
    """按日志消息内容分类日志级别"""
    upper = message.upper()
    if any(w in upper for w in ["FATAL", "CRITICAL", "EMERGENCY"]):
        return "FATAL"
    if "ERROR" in upper:
        return "ERROR"
    if any(w in upper for w in ["WARN", "WARNING"]):
        return "WARN"
    if any(w in upper for w in ["INFO", "NOTICE"]):
        return "INFO"
    if any(w in upper for w in ["DEBUG", "TRACE"]):
        return "DEBUG"
    return "UNKNOWN"


def extract_error_signature(message: str) -> str:
    """
    从错误消息中提取签名用于聚类。

    规则：
    - 捕获异常类型（Java: NPE, OOM / Python: TypeError / Go: panic）
    - 如果无明显类型，取前 60 字符并在标点处截断
    """
    exception_patterns = [
        r"(\w+(?:Error|Exception|Fault|Panic))",
        r"(panic:\s*\w+)",
        r"(OOM|OutOfMemory)",
        r"(NullPointer|NPE)",
        r"(StackOverflow)",
        r"(ConnectionRefused|ConnectionTimeout)",
        r"(DeadlineExceeded)",
        r"(TypeError|ValueError|KeyError|IndexError|AttributeError)",
        r"(Segment[Ff]ault)",
    ]
    for pat in exception_patterns:
        m = re.search(pat, message)
        if m:
            return m.group(1)

    # 取前 60 字符 + "..." 作为粗聚类键
    return message[:60].rstrip() + "..."


def query_logs(base_url: str, token: str | None, service: str,
               start_iso: str, end_iso: str, pattern: str,
               max_results: int) -> dict:
    """
    查询日志易获取匹配的日志条目。

    日志易 API 适配层：
      实际对接时根据日志易的 API 协议（REST / SQL 查询接口）修改此函数。

    返回结构：
    {
      "total_matched": 150,
      "entries": [...],
      "level_distribution": {"ERROR": 80, "WARN": 50, ...},
      "top_patterns": [{"signature": "...", "count": 45}, ...],
      "first_occurrence": "ISO8601",
      "last_occurrence": "ISO8601"
    }
    """
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    # ----------------------------------------------------------------
    # 适配点：替换为实际日志易 API 调用
    # 示例：
    #   payload = {
    #       "query": f"service:{service} AND {pattern}",
    #       "timeRange": {"from": start_iso, "to": end_iso},
    #       "size": max_results,
    #       "sort": "timestamp:asc"
    #   }
    #   req = Request(f"{base_url}/api/search", ...)
    # ----------------------------------------------------------------
    _ = base_url
    _ = headers

    return _generate_mock_logs(service, start_iso, end_iso,
                               pattern, max_results)


def _generate_mock_logs(service: str, start_iso: str, end_iso: str,
                        pattern: str, max_results: int) -> dict:
    """生成模拟日志数据（仅用于开发/测试阶段）"""
    import random

    log_templates = [
        # (模板, 权重)
        ("[ERROR] OOM killer terminated process java (pid={pid}) - memory usage {mem}%", 5),
        ("[ERROR] java.lang.OutOfMemoryError: Java heap space at {class}.{method}({file}:{line})", 8),
        ("[ERROR] Connection timeout to {target}:{port} after {timeout_ms}ms", 10),
        ("[ERROR] io.grpc.StatusRuntimeException: DEADLINE_EXCEEDED", 12),
        ("[WARN] Slow query detected: {query_hash} took {latency_ms}ms (threshold 500ms)", 15),
        ("[ERROR] HTTP {status_code} on {method} {path} - upstream timeout", 10),
        ("[INFO] Request completed: {method} {path} -> {status_code} in {latency_ms}ms", 40),
        ("[WARN] Thread pool {pool} is saturated: active={active}, queue={queue}", 6),
        ("[ERROR] panic: runtime error: invalid memory address or nil pointer dereference", 3),
        ("[FATAL] Node {node} is unreachable - heartbeat missed {missed_count} times", 2),
    ]

    start_dt = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    total_range_s = (end_dt - start_dt).total_seconds()

    entries = []
    cluster_counter = Counter()
    level_counter = Counter()

    for i in range(random.randint(50, max_results)):
        template, weight = random.choices(log_templates,
                                          weights=[w for _, w in log_templates])[0]
        offset_s = random.uniform(0, total_range_s)
        ts = start_dt.timestamp() + offset_s
        log_time = datetime.fromtimestamp(ts, tz=timezone.utc)

        msg = template.format(
            pid=random.randint(1000, 9999),
            mem=random.randint(75, 99),
            cls=random.choice(["com.example.service.Handler",
                              "com.example.db.QueryExecutor",
                              "com.example.cache.RedisClient"]),
            method=random.choice(["processRequest", "executeQuery",
                                  "getFromCache", "handleTimeout"]),
            file=random.choice(["Handler.java", "QueryExecutor.java",
                                "RedisClient.java"]),
            line=random.randint(42, 300),
            target=random.choice(["db-01.internal", "cache-01.internal",
                                  "api-gateway.internal"]),
            port=random.choice([3306, 6379, 443, 8080]),
            timeout_ms=random.randint(5000, 30000),
            query_hash=format(random.getrandbits(64), "016x"),
            latency_ms=random.randint(100, 3000),
            status_code=random.choice([500, 502, 503, 504]),
            method=random.choice(["GET", "POST", "PUT", "DELETE"]),
            path=random.choice(["/api/v1/orders", "/api/v1/users",
                                "/api/v1/payments", "/health"]),
            pool=random.choice(["db-pool", "http-pool", "grpc-pool"]),
            active=random.randint(50, 100),
            queue=random.randint(10, 200),
            node=f"node-{random.randint(1, 20):02d}",
            missed_count=random.randint(3, 15),
        )

        level = classify_level(msg)
        signature = extract_error_signature(msg)

        if not re.search(pattern, msg, re.IGNORECASE):
            continue

        level_counter[level] += 1
        if level in ("FATAL", "ERROR", "WARN"):
            cluster_counter[signature] += 1

        entries.append({
            "timestamp": log_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "service": service,
            "level": level,
            "message": msg,
            "signature": signature,
        })

    entries.sort(key=lambda e: e["timestamp"])
    top_patterns = [{"signature": sig, "count": cnt}
                    for sig, cnt in cluster_counter.most_common(10)]

    return {
        "total_matched": len(entries),
        "entries": entries,
        "level_distribution": dict(level_counter),
        "top_patterns": top_patterns,
        "first_occurrence": entries[0]["timestamp"] if entries else None,
        "last_occurrence": entries[-1]["timestamp"] if entries else None,
    }


def main():
    args = parse_args()
    base_url = resolve_base_url(args.host)
    token = resolve_token()

    try:
        data = query_logs(
            base_url=base_url, token=token, service=args.service,
            start_iso=args.time_start, end_iso=args.time_end,
            pattern=args.pattern, max_results=args.max_results,
        )
        output = {
            "service": args.service,
            "time_range": {"start": args.time_start, "end": args.time_end},
            "pattern": args.pattern,
            **data,
            "queried_at": datetime.now(timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))

    except HTTPError as e:
        print(json.dumps({
            "service": args.service,
            "error": f"HTTP {e.code}: {e.reason}",
            "success": False,
        }, ensure_ascii=False))
        sys.exit(1)
    except URLError as e:
        print(json.dumps({
            "service": args.service,
            "error": f"Connection failed: {e.reason}",
            "success": False,
        }, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "service": args.service,
            "error": str(e),
            "success": False,
        }, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
