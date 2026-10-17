# Path C · ClickHouse 交易量波动触发

> 状态：已实现（后端）。改动文件：
> `backend/app/services/alert_pipeline.py`、
> `backend/app/services/datasource_adapters.py`。
> 未改前端、未加表结构、未新增依赖。

## 1. 背景

老平台 `webhook_rca_new.py` 的 C 路会在 A（关键组件 + 高严重度）和
B（高危签名）之外，再查 ClickHouse 交易量：当前窗相对基线骤降则触发
RCA。Liumai 的 `decide_trigger` 之前把 `path_c` 硬编码为 `False`，前端
的“交易量波动”开关实际无效。

现在 C 路真正接入 `data_sources` 表中已启用的 ClickHouse 数据源，
并保持默认关闭。

## 2. 策略配置

`system_config.rca_alert_policy` 的 `trigger.path_c`：

```json
{
  "trigger": {
    "path_c": {
      "enabled": false,
      "datasource_id": null,
      "window_minutes": 30,
      "baseline_minutes": 60,
      "drop_pct": 60,
      "metric": "count",
      "sql": ""
    }
  }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；默认关闭 |
| `datasource_id` | `null` | `data_sources.id`；必须存在、`type=clickhouse`、`enabled=true` |
| `window_minutes` | `30` | 最近窗口长度，1–1440 |
| `baseline_minutes` | `60` | 基线回溯长度，1–10080 |
| `drop_pct` | `60` | 跌幅阈值（%），0–100；`>=` 即命中 |
| `metric` | `"count"` | 默认 SQL 中参与聚合的列/表达式（仅安全标识符，可带一个 `.`） |
| `sql` | `""` | 可选，完整只读 SQL 覆盖；空表示用默认 SQL |

读取时 `get_policy` 会做 clamp/修复；非法 `metric` 回落为 `count`，
非法数值回落为默认值，超长 SQL 截断到 8000 字符。

`multi.trigger_paths.C` 作为历史兼容开关保留：`trigger.path_c.enabled`
或 `multi.trigger_paths.C` **任一为 true** 即启用 C 路；默认两者都是
`false`。要彻底关闭 C 路，两个开关都置 false。

## 3. 判定流程

`decide_trigger` 现在是 `async`（内部需要查库 + HTTP 请求），签名：

```python
await decide_trigger(normalized, level, policy, db)  # db 可省略，省略时 C 路降级为不命中
```

1. 先算 severity / A / B。**任一命中则直接返回，不查 ClickHouse**，
   避免无谓的 3 秒开销。
2. 全部未命中且 C 路启用时：
   - 从 `data_sources` 取 `id=datasource_id AND type='clickhouse' AND enabled=true`；
   - 以**当前时刻**为窗口右端（不是告警时间）：最近
     `[now-window, now)` 为当前窗，`[now-window-baseline, now-window)`
     为基线窗；
   - 渲染 SQL → 校验只读 → 适配器执行（3 秒硬超时）；
   - 按分钟行求和：当前窗为 `current`；基线窗求和后按
     `window_minutes / baseline_minutes` 折算到窗口长度，得到可比的
     `baseline`；
   - `drop = (baseline - current) / baseline * 100`；
   - `drop >= drop_pct` → `path_c=True`，`triggered=True`。
3. 证据文本示例：
   `交易量骤降 62.3%（窗口值 1200 / 基线 3180 / 跌幅 62.3%，阈值 60%）`，
   未命中时同样带回窗口值/基线/跌幅，写入 `detail.path_c.evidence`；
   过滤时还会追加到 `trigger_reason`，便于收件箱审计。

`decide_trigger` 返回结构保持兼容：原有 `(triggered, reason, detail)`
三元组、`detail` 的 `triggered/severity_*/component/keywords/matched/paths`
都不变；新增可选的 `detail.path_c`：

```json
{
  "enabled": true,
  "datasource_id": 7,
  "window_minutes": 30,
  "baseline_minutes": 60,
  "drop_pct_threshold": 60,
  "metric": "count",
  "available": true,
  "hit": true,
  "window_value": 1200.0,
  "baseline_value": 3180.0,
  "drop_pct": 62.3,
  "evidence": "交易量骤降 62.3%（窗口值 1200 / 基线 3180 / 跌幅 62.3%，阈值 60%）",
  "error": null,
  "cached": false,
  "evaluated_at": "2026-10-17T12:52:41+00:00"
}
```

## 4. SQL 契约

### 4.1 默认 SQL（每分钟聚合，单位：分钟）

```sql
SELECT toStartOfMinute(time) AS minute,
       sum(toFloat64OrZero({metric})) AS volume
FROM opsobs.dist_metric_trans_min_server
WHERE time >= toDateTime('{baseline_start}')
  AND time < toDateTime('{window_end}')
GROUP BY minute
ORDER BY minute
```

默认表沿用老平台 `opsobs.dist_metric_trans_min_server`。表结构不同时用
`sql` 覆盖。

### 4.2 可用占位符

`sql`（以及默认 SQL）支持：

- `{window_start}`、`{window_end}`、`{baseline_start}`、`{baseline_end}`
  —— `YYYY-MM-DD HH:MM:SS`，CST（UTC+8），需自己加引号；
- `{anchor}` —— 同 `{window_end}`；
- `{window_minutes}`、`{baseline_minutes}` —— 整数；
- `{metric}` —— 配置的 metric（已做标识符校验）。

### 4.3 结果格式

适配器强制 `default_format=JSONEachRow`，因此覆盖 SQL **不要写
`FORMAT ...`**。支持两种结果：

1. **按分钟行**（推荐，默认 SQL 即如此）：每行含时间列
   （`minute/ts/time/timestamp/bucket/start_time/datetime/window_start/date`）
   和数值列（`volume/value/count/cnt/total/sum/amount/txn_count`）。
   由后端切窗、求和、折算基线。
2. **单行聚合**：一行同时含当前值列（`current/window_value/window/current_value/now/last`）
   和基线列（`baseline/baseline_value/base/baseline_avg/previous/historical`）。
   此时视为两个值已经可比，不再折算。

无法识别列、空结果、窗口/基线无数据均视为“不可用”，不命中。

## 5. SQL 安全策略

`datasource_adapters.validate_readonly_sql()` 在发送前校验：

- 非空、≤ 8000 字符、禁止 NUL；
- **只允许单条语句**：去掉字符串/注释后，除末尾一个 `;` 外不允许再出现
  `;`；多语句直接拒绝；
- 首关键字必须是 `SELECT` 或 `WITH`（`WITH` 中必须含 `SELECT`）；
- 禁止 DDL/DML 关键字：`INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/
  TRUNCATE/RENAME/ATTACH/DETACH/REPLACE/MERGE/GRANT/REVOKE/OPTIMIZE/
  KILL/USE/SET/CALL/EXECUTE`；
- 禁止 `INTO OUTFILE/DUMPFILE`；
- 禁止可能读写文件系统/网络/外部库的 ClickHouse 表函数：
  `url/file/remote/remoteSecure/hdfs/s3/azureBlobStorage/gcs/mysql/
  postgresql/jdbc/odbc/sqlite/mongodb/redis/executable/input`。

校验前先用小词法器剥离字符串字面量与 `--`、`/* */` 注释，避免
`'delete'` 之类的字面量误报，也避免注释里藏第二句。

适配器层再加两道防线：

- `ClickHouseAdapter.execute_readonly()` 发送 `readonly=2`，服务端拒绝
  数据修改（用 2 而不是 1，以便同时传 `max_execution_time`）；
- `max_execution_time` 由后端按 3 秒设置，另有 `httpx` 超时和
  `asyncio.wait_for(..., 3.0)` 总时限。

普通 `POST /datasources/{id}/query` 仍走原 `execute_query`，不受影响。

## 6. 降级行为（绝不阻塞主链路）

以下情况一律 `path_c=False`（不命中）、记录 warning，并返回结构化
`detail.path_c.error`：

- 未配置 `datasource_id`；
- 数据源不存在、被禁用、类型不是 `clickhouse`；
- SQL 校验失败、适配器不支持只读查询；
- 查询异常、HTTP 非 2xx、超时（总计 3 秒）；
- 结果为空、列无法识别、窗口/基线无数据、基线为 0。

`decide_trigger` 内部还有一层兜底 `try/except`，C 路任何异常都不会
冒泡到 `ingest_alert`。warning 按数据源/配置键做 60 秒节流，避免
数据源故障时刷日志。

### 进程内缓存

- 键：`datasource_id`（无 id 的配置错误不缓存）；
- TTL：60 秒（`PATH_C_CACHE_TTL_SECONDS`）；
- 缓存的是完整判定结果（含失败结果），因此数据源宕机时，同一分钟内
  后续告警不会反复吃满 3 秒超时；
- 上限 128 个数据源，超出按插入顺序淘汰。

注意：策略里改 SQL/窗口后，已有缓存最多沿用 60 秒。

## 7. 运维启用步骤

1. 在“数据源”页面新建/确认一个 ClickHouse 数据源（`host/port/user/password`），
   记录其 `id`，确认 `enabled=true`。
2. 通过 `PUT /api/alerts/policy`（admin）合并写入，例如：

```json
{
  "trigger": {
    "path_c": {
      "enabled": true,
      "datasource_id": 7,
      "window_minutes": 30,
      "baseline_minutes": 60,
      "drop_pct": 60,
      "metric": "count",
      "sql": ""
    }
  }
}
```

3. 用 `GET /api/alerts/policy` 确认 `trigger.path_c` 已归一化；观察后端
   日志中 `Path C` warning。若默认表不匹配，覆盖 `sql`（仍须单条
   SELECT，建议保留占位符）。

## 8. 已知限制

- 只做“跌幅”判定（按需求），不实现老平台的涨幅阈值；
- 基线为 0/无数据按不命中处理（老平台是“有量即异常”，本实现选择
  保守、可解释）；
- 窗口以当前时刻为锚点，而非告警时间；与按 `datasource_id` 缓存
  60 秒的设计一致；
- 缓存期间（60 秒）修改策略或禁用数据源，最多沿用旧结果 60 秒；
- 默认 SQL 的时间字符串按 CST 生成，ClickHouse 服务端时区若不同需
  自行覆盖 `sql`；
- 未改动前端策略类型/表单；前端目前仍只有 `multi.trigger_paths.C`
  复选框（兼容开关），`path_c` 字段通过策略 API 配置。

## 9. 验证

```powershell
python -m py_compile backend/app/services/alert_pipeline.py backend/app/services/datasource_adapters.py
```

建议手工验证：

- 默认策略下 `decide_trigger` 不发起任何 ClickHouse 请求；
- 开启 C、配置可用数据源、构造窗口/基线数据后可命中，证据含窗口值、
  基线、跌幅；
- 断开 ClickHouse 或把 SQL 改成多语句：告警仍正常入库/过滤，日志
  出现 warning，`detail.path_c.error` 有原因。
