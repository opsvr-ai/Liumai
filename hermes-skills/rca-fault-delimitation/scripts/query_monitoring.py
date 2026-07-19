#!/usr/bin/env python3
"""
集中监控平台数据查询适配器

六脉 RCA 技能的数据源脚本之一。从集中监控平台（Prometheus /
自研监控系统）查询指标时序数据，计算异常评分。

Usage:
    python query_monitoring.py \\
        --host MONITORING_API_URL \\
        --service my-service \\
        --time-start 2026-07-17T10:00:00Z \\
        --time-end 2026-07-17T10:30:00Z \\
        --metric cpu,memory,latency,error_rate

Environment:
    MONITORING_API_TOKEN: 集中监控平台 API 鉴权 Token
    MONITORING_API_URL:   集中监控平台 API 基础地址（覆盖 --host）
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def parse_args():
    parser = argparse.ArgumentParser(description="集中监控平台数据查询适配器")
    parser.add_argument("--host", default="http://localhost:9090",
                        help="监控平台 API 地址（默认 http://localhost:9090）")
    parser.add_argument("--service", required=True,
                        help="目标服务名称")
    parser.add_argument("--time-start", required=True,
                        help="查询开始时间（ISO8601，如 2026-07-17T10:00:00Z）")
    parser.add_argument("--time-end", required=True,
                        help="查询结束时间（ISO8601，如 2026-07-17T10:30:00Z）")
    parser.add_argument("--metric", default="cpu,memory,latency,error_rate",
                        help="指标名称列表，逗号分隔（默认 cpu,memory,latency,error_rate）")
    return parser.parse_args()


def resolve_base_url(cli_host: str) -> str:
    """解析 API 基础地址：环境变量优先，CLI 参数次之"""
    env_url = os.environ.get("MONITORING_API_URL")
    return env_url.rstrip("/") if env_url else cli_host.rstrip("/")


def resolve_token() -> str | None:
    """获取 API Token"""
    return os.environ.get("MONITORING_API_TOKEN")


def to_unix_ms(iso_str: str) -> int:
    """将 ISO8601 字符串转换为毫秒级 Unix 时间戳"""
    dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def query_metric(base_url: str, token: str | None, service: str,
                 metric: str, start_ms: int, end_ms: int) -> dict:
    """
    查询单个指标数据。

    集中监控平台 API 适配层：
      当前实现为查询接口占位。实际对接时根据平台 API 的
      实际协议（如 Prometheus HTTP API / 自研 REST API）修改此函数。

    返回结构：
    {
      "metric": "cpu",
      "service": "my-service",
      "data_points": [
        {"timestamp": "2026-07-17T10:00:00Z", "value": 45.2},
        ...
      ],
      "anomaly_score": 0.12,
      "unit": "%"
    }
    """
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    # ----------------------------------------------------------------
    # 适配点：替换为实际监控平台 API 调用
    # 示例：Prometheus Range Query
    #   query_url = f"{base_url}/api/v1/query_range"
    #   params = {
    #       "query": f"{metric}{{service=\"{service}\"}}",
    #       "start": start_ms / 1000,
    #       "end": end_ms / 1000,
    #       "step": "60"
    #   }
    # ----------------------------------------------------------------
    _ = base_url  # 替换为实际请求 URL
    _ = headers   # 替换为实际请求头

    # 以下为模拟返回，实际集成时删除
    mock_data = _generate_mock_data(metric, service, start_ms, end_ms)
    return mock_data


def _generate_mock_data(metric: str, service: str,
                        start_ms: int, end_ms: int) -> dict:
    """生成模拟指标数据（仅用于开发/测试阶段）"""
    import random
    step_ms = 60_000  # 每分钟一个数据点
    points = []
    anomalies = []
    ts = start_ms
    while ts <= end_ms:
        if metric == "cpu":
            val = round(random.uniform(10, 80), 1)
        elif metric == "memory":
            val = round(random.uniform(30, 90), 1)
        elif metric == "latency":
            val = round(random.uniform(50, 500), 1)
        elif metric == "error_rate":
            val = round(random.uniform(0, 5), 2)
        else:
            val = round(random.uniform(0, 100), 1)
        points.append({
            "timestamp": datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "value": val
        })
        if val > 80:
            anomalies.append(ts)
        ts += step_ms

    anomaly_score = round(len(anomalies) / max(len(points), 1), 4)
    return {
        "metric": metric,
        "service": service,
        "data_points": points,
        "anomaly_score": anomaly_score,
        "unit": {"cpu": "%", "memory": "%", "latency": "ms",
                 "error_rate": "%"}.get(metric, "")
    }


def main():
    args = parse_args()
    base_url = resolve_base_url(args.host)
    token = resolve_token()
    start_ms = to_unix_ms(args.time_start)
    end_ms = to_unix_ms(args.time_end)
    metrics = [m.strip() for m in args.metric.split(",") if m.strip()]

    results = {}
    success = True
    errors = []

    for metric in metrics:
        try:
            data = query_metric(
                base_url=base_url, token=token, service=args.service,
                metric=metric, start_ms=start_ms, end_ms=end_ms
            )
            results[metric] = data
        except HTTPError as e:
            errors.append({"metric": metric, "error": f"HTTP {e.code}: {e.reason}"})
            success = False
        except URLError as e:
            errors.append({"metric": metric, "error": f"Connection failed: {e.reason}"})
            success = False
        except Exception as e:
            errors.append({"metric": metric, "error": str(e)})
            success = False

    output = {
        "service": args.service,
        "time_range": {"start": args.time_start, "end": args.time_end},
        "results": results,
        "success": success,
        "errors": errors if errors else None,
        "queried_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
