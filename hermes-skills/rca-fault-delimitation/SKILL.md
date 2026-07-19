---
name: rca-fault-delimitation
description: 六脉故障定界 — 多数据源根因分析
version: 1.0.0
author: 六脉 Team
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [AIOps, RCA, 故障定界]
    related_skills: [emergency-collaboration]
    requires_toolsets: [terminal]
    config:
      - key: rca.data_sources
        description: 已启用的数据源适配器列表
        default: '["monitoring", "rizhiyi", "clickhouse"]'
        prompt: 数据源适配器列表（JSON 数组，可选值：monitoring, rizhiyi, clickhouse）
      - key: rca.time_window_default
        description: 默认分析时间窗口
        default: "30m"
        prompt: 默认时间窗口（例如 15m、30m、1h、2h）
      - key: rca.concurrency_limit
        description: 最大并发 RCA 会话数
        default: 5
        prompt: 最大并发 RCA 会话数
required_environment_variables:
  - name: MONITORING_API_URL
    prompt: 集中监控平台 API 地址
    required_for: 查询监控指标数据
  - name: MONITORING_API_TOKEN
    prompt: 集中监控平台 API Token
    required_for: 查询监控指标数据
  - name: RIZHIYI_API_URL
    prompt: 日志易 API 地址
    required_for: 查询日志数据
  - name: RIZHIYI_API_TOKEN
    prompt: 日志易 API Token
    required_for: 查询日志数据
  - name: CLICKHOUSE_HOST
    prompt: ClickHouse 主机地址
    required_for: 查询事务和指标数据
  - name: CLICKHOUSE_PORT
    prompt: ClickHouse 端口
    default: "9000"
    required_for: 查询事务和指标数据
  - name: CLICKHOUSE_USER
    prompt: ClickHouse 用户名
    required_for: 查询事务和指标数据
  - name: CLICKHOUSE_PASSWORD
    prompt: ClickHouse 密码
    required_for: 查询事务和指标数据
---

# 故障定界 (RCA) — 多数据源根因分析

六脉平台的故障定界技能。收到告警或人工触发后，跨集中监控平台、日志易、ClickHouse 等多个数据源执行自动化根因分析，输出结构化定界结果。

## When to Use

触发条件：

1. **被动触发（告警匹配）**：外部监控系统的告警经规则引擎匹配后，自动传入此技能。
2. **主动触发（人工操作）**：运维人员在平台 UI 上选择"RCA 场景"，指定时间窗口后手动启动。

## Data Sources

本技能通过可插拔的数据源适配器查询以下系统：

| 数据源 | 适配器 | 用途 |
|--------|--------|------|
| 集中监控平台 | `scripts/query_monitoring.py` | 获取 CPU、内存、网络、磁盘等系统指标及异常评分 |
| 日志易 | `scripts/query_logs.py` | 按时间窗口和错误模式搜索应用日志 |
| ClickHouse | `scripts/query_clickhouse.py` | 查询事务链路、调用量、延迟、错误率等指标 |

适配器通过 `${HERMES_SKILL_DIR}/scripts/` 下的 Python 脚本调用。各数据源实现独立，可单独启用或禁用。如需新增数据源，在 `scripts/` 下添加适配器脚本并在 `metadata.hermes.config.data_sources` 中注册即可。

## Procedure

标准的故障定界流程包含以下 6 个步骤：

### Step 1: 解析告警上下文

从传入的告警或请求中提取关键信息：

- 涉及服务（service name）
- 时间窗口（time window，默认 `${HERMES_SKILL_DIR}` 中配置的 30m）
- 告警级别（severity：critical / warning / info）
- 告警类型（alert type：如响应超时、错误率飙升、资源耗尽）
- 可选：关联的 Trace ID 或 事件 ID

输出结构化上下文对象供后续步骤使用。

### Step 2: 查询监控平台指标

调用 `query_monitoring.py` 获取时间窗口内的系统指标：

```bash
python ${HERMES_SKILL_DIR}/scripts/query_monitoring.py \
  --service <service_name> \
  --time-start <ISO8601_START> \
  --time-end <ISO8601_END> \
  --metric cpu,memory,latency,error_rate
```

分析返回的指标数据点及异常评分（anomaly_score），识别异常时间段：

- 高 CPU / 内存使用率 -> 可能资源瓶颈
- 延迟显著升高 -> 可能应用或网络问题
- 错误率突增 -> 可能代码缺陷或依赖故障

### Step 3: 查询日志易日志

调用 `query_logs.py` 在时间窗口内搜索错误模式：

```bash
python ${HERMES_SKILL_DIR}/scripts/query_logs.py \
  --service <service_name> \
  --time-start <ISO8601_START> \
  --time-end <ISO8601_END> \
  --pattern "error|exception|timeout|OOM|panic"
```

分析返回的日志条目：

- 统计错误级别分布（FATAL / ERROR / WARN）
- 提取 `exception` 堆栈中的关键类型
- 按日志模式聚类（group by error signature），识别高频错误
- 记录首次出现时间（first occurrence）以定位故障起点

### Step 4: 查询 ClickHouse 事务数据

调用 `query_clickhouse.py` 获取事务和业务指标：

```bash
python ${HERMES_SKILL_DIR}/scripts/query_clickhouse.py \
  --host $CLICKHOUSE_HOST \
  --port $CLICKHOUSE_PORT \
  --database liumai \
  --query "
    SELECT toStartOfMinute(timestamp) AS ts,
           count() AS call_count,
           avg(latency_ms) AS avg_latency,
           countIf(status != 'success') AS error_count
    FROM service_traces
    WHERE service = '<service_name>'
      AND timestamp BETWEEN '<START>' AND '<END>'
    GROUP BY ts
    ORDER BY ts
  "
```

分析结果：

- 调用量突降 -> 可能上游熔断或服务不可用
- 平均延迟 / P99 延迟骤升 -> 性能退化
- 错误数对比基线 -> 确认异常范围

### Step 5: 跨源关联分析

将前三步的发现进行关联：

1. **时间轴对齐**：将各数据源的异常时间点对齐到统一时间轴。
2. **因果关系推断**：
   - 日志错误出现时间 vs 指标异常时间 —— 哪个在先？
   - 资源瓶颈（CPU/内存）是否先于应用错误？
   - 外部依赖（数据库、缓存）是否同时出现异常？
3. **依赖链分析**：根据服务拓扑判断故障传播路径。
4. **排除法**：对于偶发或相关性不强的异常，降低置信度。

### Step 6: 生成定界结论

输出结构化的 JSON 根因分析结果。

## Output Format

```json
{
  "root_cause": "string — 根因描述（如：database-01 节点内存溢出导致查询超时级联）",
  "confidence": 0.95,
  "evidence": [
    {
      "source": "monitoring|rizhiyi|clickhouse",
      "time": "ISO8601",
      "detail": "具体证据内容",
      "severity": "critical|warning|info"
    }
  ],
  "impacted_services": ["service-a", "service-b"],
  "impact_scope": "string — 影响范围描述",
  "anomaly_timeline": [
    {
      "time": "ISO8601",
      "event": "事件描述",
      "source": "证据来源"
    }
  ],
  "recommended_actions": [
    {
      "priority": "P0|P1|P2",
      "action": "操作描述",
      "target": "操作目标（服务/节点）"
    }
  ],
  "session_id": "string — Horned 会话 ID",
  "investigation_duration_ms": 12345
}
```

## Pitfalls

1. **数据源超时**：单个数据源查询超时不中断整个分析流程，应在 Step 5 标记此路证据缺失并降低置信度。
2. **时间窗口误判**：如果告警延迟到达，实际故障时间可能在窗口之前。查询时应适当扩展窗口边界（建议前扩 5min）。
3. **多故障叠加**：同一时间窗口可能出现多个独立故障。应分别输出各故障的根因，标记置信度，不要强行合并。
4. **依赖数据缺失**：服务拓扑数据不完整时，证据链可能断裂。应明确标注依赖缺失的部分。

## Verification

确认项：

- [ ] 各数据源适配器返回非空结构且格式正确
- [ ] 时间轴对齐后，异常时间点之间存在合理的因果顺序
- [ ] 输出 JSON 中 `evidence` 数组长度 >= 2（至少两个数据源提供证据）
- [ ] `confidence` 值合理（单一证据源 <= 0.7，多源交叉验证 >= 0.8）
- [ ] 所有时间戳为 ISO8601 格式（含时区）
