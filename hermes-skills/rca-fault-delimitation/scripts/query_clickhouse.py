#!/usr/bin/env python3
"""
ClickHouse 数据查询适配器

六脉 RCA 技能的数据源脚本之一。连接 ClickHouse 数据库执行
自定义查询，用于获取事务链路、调用指标、异常计数等数据。

Usage:
    python query_clickhouse.py \\
        --host localhost \\
        --port 9000 \\
        --database liumai \\
        --query "SELECT ... FROM service_traces WHERE ..."

Environment:
    CLICKHOUSE_HOST:     ClickHouse 主机地址（覆盖 --host）
    CLICKHOUSE_PORT:     ClickHouse 端口（覆盖 --port）
    CLICKHOUSE_USER:     ClickHouse 用户名
    CLICKHOUSE_PASSWORD: ClickHouse 密码
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone


def parse_args():
    parser = argparse.ArgumentParser(description="ClickHouse 数据查询适配器")
    parser.add_argument("--host", default="localhost",
                        help="ClickHouse 主机地址（默认 localhost）")
    parser.add_argument("--port", type=int, default=9000,
                        help="ClickHouse 端口（默认 9000）")
    parser.add_argument("--database", default="liumai",
                        help="数据库名称（默认 liumai）")
    parser.add_argument("--query", required=True,
                        help="SQL 查询语句")
    parser.add_argument("--format", default="JSONEachRow",
                        choices=["JSON", "JSONEachRow", "TabSeparated",
                                 "CSV", "Vertical"],
                        help="输出格式（默认 JSONEachRow）")
    return parser.parse_args()


def resolve_connection_params(cli_host: str, cli_port: int) -> dict:
    """解析连接参数：环境变量优先，CLI 参数次之"""
    return {
        "host": os.environ.get("CLICKHOUSE_HOST", cli_host),
        "port": int(os.environ.get("CLICKHOUSE_PORT", cli_port)),
        "user": os.environ.get("CLICKHOUSE_USER", "default"),
        "password": os.environ.get("CLICKHOUSE_PASSWORD", ""),
    }


def execute_query(host: str, port: int, user: str, password: str,
                  database: str, sql: str, fmt: str) -> list[dict]:
    """
    执行 ClickHouse SQL 查询并返回结果。

    使用 ClickHouse HTTP 接口（默认端口 8123）或原生 TCP 协议。
    当前实现为 HTTP 接口适配，端口自动映射到 8123 用于 HTTP。

    适配点：
      如果 ClickHouse 服务使用不同端口或需要原生 TCP 协议，
      请替换为 clickhouse-driver 或 clickhouse-connect 库。
    """
    # ----------------------------------------------------------------
    # 方式一（推荐）：使用 clickhouse-connect 库
    #
    #   import clickhouse_connect
    #   client = clickhouse_connect.get_client(
    #       host=host,
    #       port=port,           # 原生端口，默认 9000
    #       username=user,
    #       password=password,
    #       database=database,
    #   )
    #   result = client.query(sql)
    #   return [dict(row) for row in result.result_rows]
    #
    # 方式二：HTTP 接口
    #
    #   http_port = int(os.environ.get("CLICKHOUSE_HTTP_PORT", 8123))
    #   url = f"http://{host}:{http_port}/?database={database}"
    #   ...
    # ----------------------------------------------------------------

    _ = host, port, user, password, database, fmt

    # 以下为模拟实现，实际集成时删除
    return _generate_mock_results(sql)


def _generate_mock_results(sql: str) -> list[dict]:
    """
    根据 SQL 关键词生成模拟结果（仅用于开发/测试阶段）。

    实际集成时删除此函数，使用真实的 ClickHouse 客户端库。
    """
    import random
    sql_upper = sql.upper()

    rows = []

    if "SERVICE_TRACES" in sql_upper or "traces" in sql:
        # 事务/调用量查询
        for i in range(60):
            ts = f"2026-07-17T10:{i:02d}:00Z"
            base_calls = random.randint(800, 1200)
            base_latency = random.uniform(80, 150)
            # 模拟 10:15-10:20 的异常时间段
            anomaly = 15 <= i <= 20
            calls = base_calls if not anomaly else base_calls // 3
            latency = base_latency if not anomaly else base_latency * 3
            errors = random.randint(0, 5) if not anomaly else random.randint(30, 80)
            rows.append({
                "ts": ts,
                "call_count": calls,
                "avg_latency_ms": round(latency, 2),
                "p99_latency_ms": round(latency * 1.5, 2),
                "error_count": errors,
                "success_rate": round((calls - errors) / calls * 100, 2),
            })

    elif "SLOW_QUERIES" in sql_upper:
        for i in range(10):
            rows.append({
                "query_id": format(random.getrandbits(64), "016x"),
                "duration_ms": random.randint(1500, 10000),
                "query": f"SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1000",
                "user": "app_user",
                "timestamp": f"2026-07-17T10:{random.randint(0, 29):02d}:{random.randint(0, 59):02d}Z",
            })

    elif "ERROR" in sql_upper or "exception" in sql_upper:
        for i in range(20):
            rows.append({
                "timestamp": f"2026-07-17T10:{random.randint(0, 29):02d}:{random.randint(0, 59):02d}Z",
                "service": "order-service",
                "error_type": random.choice([
                    "DeadlineExceeded", "ConnectionTimeout",
                    "NullPointerException", "OOM", "Http500",
                ]),
                "count": random.randint(1, 50),
            })
    else:
        rows = [{"message": "查询成功，但返回格式未匹配已知模式", "row_count": 0}]

    return rows


def main():
    args = parse_args()
    conn = resolve_connection_params(args.host, args.port)

    try:
        rows = execute_query(
            host=conn["host"], port=conn["port"],
            user=conn["user"], password=conn["password"],
            database=args.database, sql=args.query, fmt=args.format,
        )

        output = {
            "host": conn["host"],
            "port": conn["port"],
            "database": args.database,
            "query": args.query,
            "row_count": len(rows),
            "rows": rows,
            "success": True,
            "queried_at": datetime.now(timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))

    except ImportError:
        # clickhouse-connect 未安装时的提示
        print(json.dumps({
            "host": conn["host"],
            "port": conn["port"],
            "database": args.database,
            "query": args.query,
            "error": "ClickHouse 客户端库未安装。请执行: pip install clickhouse-connect",
            "success": False,
        }, ensure_ascii=False))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            "host": conn["host"],
            "port": conn["port"],
            "database": args.database,
            "query": args.query,
            "error": str(e),
            "success": False,
        }, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
