# Hermes 容器化部署与六脉（Liumai）对接配置指南

> 性质：**只读分析**（未改业务代码、未重启本机服务）。
> 适用场景：内网中 **Hermes 跑在容器里**，六脉后端也跑在容器里。
> 分析时间：2026-10-20。
> 依据：`hermes-docs/` 本地镜像、Hermes 官网（`https://hermes-agent.nousresearch.com/docs`，当日抓取）、
> 本机源码 `/opt/hermes`（`C:\Users\11490\AppData\Local\hermes\hermes-agent`，版本 `0.22.2+1104.g0ab43d4`）、
> 六脉仓库 `docker-compose.yml` / `backend/` / `src/pages/settings.tsx`。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| Hermes 容器内最小配置 | `API_SERVER_ENABLED=true`、`API_SERVER_HOST=0.0.0.0`、`API_SERVER_PORT=8642`、`API_SERVER_KEY=<强随机>`；另加 `HERMES_WRITE_SAFE_ROOT=/opt/data:/data/hermes-files` |
| 启动命令 | 容器 `command: ["gateway", "run"]`（不要覆盖 entrypoint）；宿主是 `hermes gateway run` |
| 网络方案 | **同一 Docker 网络**（推荐）：六脉填 `http://hermes:8642/v1`，Hermes 不需要 `ports`；跨 compose 用 external network；跨主机才用“内网 IP + 端口映射” |
| 共享目录 | 命名卷 `hermes-files` 同时挂到 Hermes 与 backend 的 **同一容器路径 `/data/hermes-files`**；backend 设 `HERMES_FILES_DIR=/data/hermes-files` 且 `HERMES_FILES_HOST_PATH=/data/hermes-files` |
| 六脉设置页 | URL = `http://hermes:8642/v1`（**必须带 `/v1`**）；API Key = Hermes 的 `API_SERVER_KEY`（必填，不是可选） |
| 是否需要 wecom 等平台 | **不需要**。六脉只走 API Server；WeCom/Telegram 等是可选旁路 |
| 最常见 3 个坑 | ① 绑定 `127.0.0.1` → 其它容器连不上；② 六脉 URL **漏 `/v1`**（测试连接还能过，聊天 404）；③ 共享卷里 backend 以 root 建目录，Hermes（uid 10000）写不进去 |

---

## 1. 先读：本地镜像 / 官网 / 本机源码的差异

`hermes-docs/` 是 Docusaurus 源码快照，但 **容器机制和 API Key 规则已经落后**。与本题相关、且会影响配置的差异如下：

| 事项 | `hermes-docs/` 镜像 | 官网（2026-10-20） | 本机源码 `0.22.2+1104` | 本文采用 |
|---|---|---|---|---|
| 容器入口 | `entrypoint.sh` + gosu（旧） | s6-overlay 监管 gateway | `ENTRYPOINT /opt/hermes/docker/entrypoint-dispatch.sh` + s6 | 不覆盖 entrypoint，只传 `gateway run` |
| `API_SERVER_KEY` 长度 | ≥8 字符（`user-guide/docker.md:44`） | 仍写 ≥8 | 启动守卫 `has_usable_secret(min_length=16)`，`api_server.py:4424` | **≥16，建议 `openssl rand -hex 32`（64 字符）** |
| Key 何时必需 | “绑定非回环才强制” | “所有部署都必需，包括 127.0.0.1” | 所有部署都必需（`api_server.py:4405-4434`） | 永远设置，不依赖“本地就不用 key” |
| 启用开关 | `API_SERVER_ENABLED=true` | 同左，另支持 `gateway.api_server` | 只要 `API_SERVER_KEY` 可用就启用（`gateway/config_env.py:112-120`）；`ENABLED` 仍保留兼容 | **两个都设**，跨版本最稳 |
| `/health/detailed` | 未说认证 | 需 Bearer | `@_require_auth`（`api_server.py:2370`） | 带 Bearer 测 |
| `/health`、`/v1/health` | 示例不带 Key | 公开 | 公开（无 `_require_auth`） | 只能证明“进程活着”，不能证明 Key 对 |
| CORS | 可选 allowlist | 可选；Docker 示例给 `*` | 支持 `*`，但等于放开浏览器跨域 | 六脉是服务端调用，**不设 CORS** |
| 配置方式 | “config.yaml 暂不支持” | 支持 `gateway.api_server.{enabled,port,host,key,...}` | 支持 `platforms.api_server` / `gateway.api_server` 桥接 | 统一用环境变量，避免版本差异 |

**结论**：以官网当前页 + 本机源码为准；本地镜像只用来理解概念。下文若与镜像冲突，以本文为准。

官方页面：
- API Server：<https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server>
- Docker：<https://hermes-agent.nousresearch.com/docs/user-guide/docker>

---

## 2. A. 在 Hermes 容器内启用 API Server

### 2.1 四个必设环境变量

| 变量 | 必须值 | 默认 | 作用与坑 |
|---|---|---|---|
| `API_SERVER_ENABLED` | `true` | `false` | 文档口径的启用开关。当前源码里 Key 可用即启用，但仍建议显式设 `true` |
| `API_SERVER_HOST` | `0.0.0.0` | `127.0.0.1` | **最大的坑**。`127.0.0.1` 只监听容器回环，六脉容器、宿主端口映射都连不上 |
| `API_SERVER_PORT` | `8642` | `8642` | 六脉默认按 8642 对接；改端口要同步改六脉 URL |
| `API_SERVER_KEY` | 强随机，≥16 字符（建议 64 hex） | 无（缺省拒绝启动） | 六脉和 Hermes 必须完全一致；不要用占位符 |

补充变量：

| 变量 | 建议 | 说明 |
|---|---|---|
| `API_SERVER_CORS_ORIGINS` | **不设** | 六脉后端是服务端调用，不需要 CORS；设 `*` 只会扩大浏览器攻击面 |
| `API_SERVER_MODEL_NAME` | 不设 | 默认 `hermes-agent`；RCA 请求固定写 `model: hermes-agent`（聊天请求里的 `model` 只是展示字段，真实模型由 Hermes 服务端配置决定），所以无需改 |
| `HERMES_WRITE_SAFE_ROOT` | `/opt/data:/data/hermes-files` | **共享目录必设**，否则 agent 的 `file` 写工具拒绝写 `/data/hermes-files`（见 §4.5） |
| `HERMES_UID` / `HERMES_GID` | `10000` / `10000` | 官方镜像运行用户；要与共享卷属主、backend 运行用户对齐（见 §4.4） |

生成 Key：

```bash
openssl rand -hex 32
# 例：9f1c...（64 个十六进制字符）
```

### 2.2 Key 的坑（按出现频率排序）

1. **长度**：镜像/官网写“≥8”，但 0.22.2+ 源码强制 `min_length=16`，且拒绝 `changeme`、`your_api_key_here`、纯 `x` 等占位符；否则 gateway 日志出现 `Refusing to start: API_SERVER_KEY ... too short`，API Server 根本不会监听。
2. **两端不一致**：Hermes 改了 Key，六脉设置页没改 → `401 {"error":{"message":"Invalid gateway API key (API_SERVER_KEY)",...}}`。
3. **把 LLM 的 Key 填到 API Key**：同样是 401；Hermes 的 `API_SERVER_KEY` 与 `DEEPSEEK_API_KEY`/`OPENAI_API_KEY` 完全无关。
4. **Compose 与 `/opt/data/.env` 同时存在**：compose 的 `environment` 优先于 `.env`。改了 `.env` 却不生效时，先检查 compose 里是否还有一个旧的 `API_SERVER_KEY`。
5. **Whitespace / 引号**：YAML 里 `API_SERVER_KEY: "  abc  "` 会把空格带进去，`hmac.compare_digest` 直接 401。用十六进制最省事。
6. **改了环境变量没重启**：API Server 在 gateway 启动时初始化，必须重启（见 2.3）。

### 2.3 启动命令与“改完要重启”

容器内**不要**执行 `docker exec hermes hermes gateway run` 再起一个（会抢 8642）；让容器主进程自己跑：

```yaml
command: ["gateway", "run"]
```

等价宿主命令是 `hermes gateway run`（文档里也写作 `hermes gateway`）。正常日志：

```text
[api_server] API server listening on http://0.0.0.0:8642 (model: hermes-agent)
```

重启矩阵：

| 改了什么 | 正确操作 |
|---|---|
| compose 的 `environment` / `command` / `volumes` | `docker compose up -d --force-recreate hermes`（`docker restart` 不会重读容器环境变量） |
| `/opt/data/.env` 里的 `API_SERVER_*` | `docker restart hermes`，或 `docker exec hermes hermes gateway restart`（s6 镜像会转给 s6-svc） |
| 只改六脉设置页 | 不用重启后端；保存时 `reload_hermes_config()` 立即生效（`backend/app/routes/auth.py:469-470`） |

:::warning
不要覆盖官方镜像的 entrypoint。s6 版本需要 `/init` 做 UID 重映射、数据卷 chown、服务注册；把 entrypoint 改成 `hermes` 会导致权限和 gateway 托管都失效。
:::

### 2.4 可直接复制的 compose 片段（并入六脉现有 compose）

把下面 `hermes` 服务加到 `docker-compose.yml` 的 `services:` 下；`hermes-data` / `hermes-files` 加到 `volumes:` 下。
**同一网络内不要写 `ports`**（少一个暴露面）；需要从宿主调试时再打开注释里的回环映射。

```yaml
  # -----------------------------------------------------------
  # Hermes Agent — OpenAI 兼容 API Server（只给六脉内网调用）
  # -----------------------------------------------------------
  hermes:
    image: nousresearch/hermes-agent:latest   # 生产建议固定 stable / 版本号 / digest
    container_name: hermes
    restart: unless-stopped
    command: ["gateway", "run"]
    shm_size: "1g"                     # Chromium 需要，否则浏览器工具易崩
    environment:
      API_SERVER_ENABLED: "true"
      API_SERVER_HOST: "0.0.0.0"       # 必须；127.0.0.1 只监听容器自己
      API_SERVER_PORT: "8642"
      # 从仓库根 .env 读取；未设置时 compose 直接报错，避免空 Key 启动
      API_SERVER_KEY: "${HERMES_API_SERVER_KEY:?set HERMES_API_SERVER_KEY in .env}"
      # 允许 agent 的 file 写工具写共享卷；不能漏掉 /opt/data
      HERMES_WRITE_SAFE_ROOT: "/opt/data:/data/hermes-files"
      HERMES_UID: "10000"
      HERMES_GID: "10000"
      TZ: "Asia/Shanghai"
    volumes:
      - hermes-data:/opt/data            # 配置 / .env / sessions / skills / 记忆
      - hermes-files:/data/hermes-files  # 与 backend 共享的产物目录
    networks:
      - liumai-net
    # 同一网络不需要 ports；仅宿主调试时开放到回环，并避开宿主已占用的 8642：
    # ports:
    #   - "127.0.0.1:18642:8642"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8642/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 90s
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: "2.0"
```

```yaml
volumes:
  postgres_data:
  redis_data:
  hermes-data:      # 新增
  hermes-files:     # 新增
```

在仓库根 `.env` 增加（该文件已被 `.gitignore` 忽略）：

```dotenv
HERMES_API_SERVER_KEY=<openssl rand -hex 32 的输出>
```

> 更严格的做法：不把 Key 放 compose `environment`（`docker inspect` 可见），而是写进 Hermes 的 `/opt/data/.env`（宿主 `~/.hermes/.env`，权限 600）。此时注意 compose 里不要再留旧的 `API_SERVER_KEY`，否则会覆盖文件值。

### 2.5 还需要 wecom / Telegram 等平台吗？

| 平台 | 是否必需 | 说明 |
|---|---|---|
| `api_server` | **必需** | 六脉的聊天、RCA、Jobs、Skills 全部走同一个 API Server（`/v1/*` 与 `/api/*`） |
| WeCom / 企业微信 | 可选 | 六脉自己的企微通知由六脉后端发送；Hermes 侧配 WeCom 只是让 Hermes 也能直接被企微 @ |
| Telegram / Slack / Discord / 飞书… | 可选 | 纯旁路，不影响六脉 |
| Dashboard（9119） | 可选 | 管理面板，**不要**为了对接六脉而暴露；需要时单独加认证/反代 |

只开 API Server 时，gateway 也能正常常驻（api_server 本身就是一个 platform adapter）。
六脉的 WeCom 凭据（`WECOM_CORP_ID` 等）和 Hermes 的 WeCom 凭据是两套，别混用。

### 2.6 Hermes 侧自检

```bash
docker exec hermes hermes --version
docker logs --tail 100 hermes 2>&1 | grep -iE 'API server listening|Refusing to start|API_SERVER_KEY'
docker exec hermes sh -lc 'curl -fsS http://127.0.0.1:8642/health'
```

看到 `listening on http://0.0.0.0:8642` 且 `/health` 返回 `{"status":"ok",...}` 才算真正启用。镜像版本不同（s6 / 旧 tini）Key 校验与入口行为可能不同，以容器内 `hermes --version` 为准。

---

## 3. B. 网络：让六脉容器访问 Hermes

### 3.1 方案 1（推荐）：同一 Docker 网络，用服务名

把 Hermes 加进六脉的 compose（§2.4）后，两者都在 `liumai_liumai-net` 网络里，直接使用 **服务名 + 容器端口**：

```text
六脉设置页 URL = http://hermes:8642/v1
```

要点：

- 用 **服务名**（`hermes`）或 `container_name` 都可以；服务名更稳（改容器名不影响）。
- 用 **容器内端口 8642**，不是宿主映射端口。
- 同一网络无需 `ports`；`ports` 只影响“从宿主/其它主机访问”，不影响容器间访问。
- 容器内 `localhost` / `127.0.0.1` 永远指六脉 backend 自己，不是 Hermes。

验证 DNS：

```bash
docker exec liumai-backend getent hosts hermes
# 172.x.x.x  hermes
```

### 3.2 方案 2：Hermes 在另一个 compose 项目 → 加入同一网络

跨 compose 项目的容器默认不在同一网络，容器名无法解析。两种做法：

**A. external network（可持久化，推荐）**

Hermes 自己的 compose 文件：

```yaml
services:
  hermes:
    image: nousresearch/hermes-agent:latest   # 生产建议固定 stable / 版本号 / digest
    container_name: hermes
    restart: unless-stopped
    command: ["gateway", "run"]
    shm_size: "1g"
    environment:
      API_SERVER_ENABLED: "true"
      API_SERVER_HOST: "0.0.0.0"
      API_SERVER_PORT: "8642"
      API_SERVER_KEY: "${HERMES_API_SERVER_KEY:?set HERMES_API_SERVER_KEY}"
      HERMES_WRITE_SAFE_ROOT: "/opt/data:/data/hermes-files"
    volumes:
      - hermes-data:/opt/data
      - hermes-files:/data/hermes-files
    networks:
      - liumai-net
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8642/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 90s

networks:
  liumai-net:
    external: true
    # 实际网络名用 `docker network ls` 确认；六脉当前是 liumai_liumai-net
    name: liumai_liumai-net

volumes:
  # 共享产物卷也必须用 external，否则 Hermes 项目会新建一个自己的 hermes-files
  hermes-files:
    external: true
    name: liumai_hermes-files
  # hermes-data 只归 Hermes 自己，保持普通命名卷
  hermes-data:
```

注意：跨 compose 共享的是**宿主上的同一个命名卷**时，卷名也要用实际名（例如 `liumai_hermes-files`，见 §4.3），否则两个 compose 会各建一个同名但不同的卷。external 卷必须先存在，否则 compose 启动会报 `volume ... not found`；先让六脉 compose 把卷建出来（或 `docker volume create liumai_hermes-files`）。

**B. 运行时临时接入（仅排障，不持久）**

```bash
docker network connect liumai_liumai-net hermes
# 容器重建后失效
```

**长期建议**：给共享网络起固定名字，避免 compose 项目前缀变化：

```yaml
networks:
  ai-net:
    name: ai-net          # 固定名，两个 compose 都能 external 引用
    driver: bridge
```

（改成新网络需要重建相关容器，别在生产窗口随手做。）

### 3.3 方案 3：跨主机 → 内网 IP + 端口映射

Hermes 在 A 主机（192.168.10.20），六脉在 B 主机：

Hermes compose：

```yaml
    ports:
      - "192.168.10.20:8642:8642"   # 绑定到内网网卡，避免 0.0.0.0 全开
```

六脉设置页：

```text
http://192.168.10.20:8642/v1
```

要点：

- 容器内仍必须 `API_SERVER_HOST=0.0.0.0`，否则宿主端口映射到的是容器回环，照样连不上。
- **端口映射的左右两端要分清**：`"18642:8642"` 表示宿主 18642 → 容器 8642；六脉若跨主机访问，URL 要用 **宿主端口 18642**，不是 8642。
- 宿主防火墙只放行六脉主机/网段，不要放行整个互联网（§5）。

### 3.4 这些地址不要填（最容易错）

| 填法 | 结果 |
|---|---|
| `http://localhost:8642/v1` | 在六脉容器里指向 backend 自己 → Connection refused / 测试连接失败 |
| `http://127.0.0.1:8642/v1` | 同上 |
| `http://host.docker.internal:8642/v1` | 只有 **Hermes 跑在宿主** 时成立（六脉 compose 已加 `extra_hosts`）。Hermes 在容器里时，这个地址指向宿主网关，那里没人监听 |
| `http://hermes:18642/v1` | 同一网络里没有 18642 监听（18642 只是宿主映射） |
| `http://hermes:8642`（漏 `/v1`） | **测试连接可能通过**，但聊天/RCA 404（见 §6.2） |

### 3.5 healthcheck 与启动顺序

Hermes 的 compose healthcheck 用镜像自带的 `curl` 打公开的 `/health`（官方镜像装的是完整 `curl`，不是 `wget`）：

```yaml
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8642/health"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 90s
```

- **不建议**让六脉 backend `depends_on: hermes: service_healthy`：Hermes 升级/重启会连带六脉起不来；六脉本身对 Hermes 失败有 503/502 降级，让它自己重试即可。
- 首次启动要等 skills 同步/配置初始化，`start_period` 给到 60–90s，避免刚起就被判 unhealthy。
- `curl -f` 会在 401 时返回非 0；`/health` 是公开的，不会 401，适合做存活探针。

### 3.6 防火墙（只在内网开放）

Linux（ufw）：

```bash
sudo ufw allow from 192.168.10.0/24 to any port 8642 proto tcp
```

firewalld：

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.10.0/24 port port=8642 protocol=tcp accept'
sudo firewall-cmd --reload
```

**Docker 的坑**：`ports` 发布的端口走 `DOCKER-USER`/nat，不经过 ufw 的 `INPUT` 规则，`ufw deny 8642` 不一定挡得住。要么不发布端口（推荐），要么在 `DOCKER-USER` 里限制来源：

```bash
sudo iptables -I DOCKER-USER -p tcp --dport 8642 ! -s 192.168.10.0/24 -j DROP
```

Windows 宿主（如果 Hermes 在 Windows 的 Docker Desktop）：

```powershell
New-NetFirewallRule -DisplayName "Hermes API 8642" -Direction Inbound -Protocol TCP `
  -LocalPort 8642 -RemoteAddress 192.168.10.0/24 -Action Allow
```

### 3.7 Hermes 容器自己的出网

Hermes 在容器里执行 agent 工具，RCA 技能的脚本也在 Hermes 容器里跑。因此 Hermes 容器必须能访问：

- LLM provider（DeepSeek/OpenAI/内网网关）；
- 监控平台、日志易、ClickHouse 等数据源；
- 内网 DNS、必要的 HTTP 代理。

这些 **不是** 六脉 backend 能代劳的：`hermes-skills/rca-fault-delimitation/scripts/*.py` 读取的是 **Hermes 进程所在环境** 的 `CLICKHOUSE_HOST`、`MONITORING_API_URL` 等变量。容器化后要把这些变量/网络给 Hermes 容器，而不是只给 backend。

---

## 4. C. 容器内的工具与文件路径语义

### 4.1 工具在哪个容器执行

- Hermes 的 `terminal`、`file`、`execute_code` 默认在 **Hermes 容器内部** 执行（`terminal.backend` 默认 `local`）。
- 产物路径是 **Hermes 容器的路径**；六脉 backend 容器看不到 Hermes 容器文件系统，除非共享卷。
- 六脉 backend 生成的提示词会要求 agent 写到 `HERMES_FILES_DIR/<session_id>/`，并回 `[[artifact: 文件名]]`（`backend/app/routes/chat.py:247-256`）。所以 **Hermes 里的路径必须和 backend 的 `HERMES_FILES_DIR` 是同一个挂载点**。

数据流：

```text
六脉 backend（/data/hermes-files） ──写提示词“请写到 /data/hermes-files/<id>/”
        │
        ▼
Hermes 容器（同一命名卷挂在 /data/hermes-files）──file/terminal 写文件
        │
        ▼
六脉 backend 读同一目录 → GET /api/chat/artifacts/{session_id}/{filename} → 前端下载
```

### 4.2 `terminal.backend` 必须保持 `local`

Hermes 容器里 **不要** 再设 `terminal.backend: docker`：

- 那会在 Hermes 容器里再起一个“沙箱容器”，agent 的产物落在沙箱里，不在 `/data/hermes-files`；
- 还需要把宿主 `docker.sock` 挂进 Hermes 容器，权限放大，且内网 Docker 版本/嵌套限制多。

保持默认 `terminal.backend: local`，让命令直接在 Hermes 容器内、以 `hermes` 用户执行。

### 4.3 共享卷 compose 片段（Hermes + backend + 权限初始化）

目标：两个容器都挂 **同一个卷** 到 **同一个路径** `/data/hermes-files`。

```yaml
  # 一次性权限初始化：命名卷第一次挂载时是 root:root，hermes(10000) 写不进去
  liumai-files-init:
    image: alpine:3.20
    container_name: liumai-files-init
    restart: "no"
    user: "0:0"
    command:
      - sh
      - -c
      - |
        mkdir -p /data/hermes-files /app-data
        chown -R 10000:10000 /data/hermes-files /app-data
        chmod 0775 /data/hermes-files /app-data
    volumes:
      - hermes-files:/data/hermes-files
      - liumai-app-data:/app-data

  backend:
    # ... 其余保持原样 ...
    # 关键：与 Hermes 运行时用户一致，避免 backend 建出来的目录 hermes 不能写
    user: "10000:10000"
    environment:
      HERMES_FILES_DIR: /data/hermes-files
      # 让提示词里的“宿主路径”也指向同一容器路径，别再把 E:\... 传给 Hermes
      HERMES_FILES_HOST_PATH: /data/hermes-files
      HOME: /tmp
      # 可选：数据库里还没配置时用 env 兜底（设置页保存后 DB 优先）
      HERMES_GATEWAY_URL: "http://hermes:8642/v1"
      HERMES_API_KEY: "${HERMES_API_SERVER_KEY:?set HERMES_API_SERVER_KEY in .env}"
      # ... 其他环境变量保持原样 ...
    volumes:
      - ./hermes-skills:/opt/hermes-skills:ro
      - hermes-files:/data/hermes-files   # 替换原来的 ./hermes-files:/data/hermes-files
      - liumai-app-data:/app/data         # 非 root 后头像目录仍可写
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      liumai-files-init:
        condition: service_completed_successfully
```

```yaml
volumes:
  hermes-data:
  hermes-files:
  liumai-app-data:
```

说明：

- backend 镜像当前 **没有** `USER`，默认 root（`docker exec liumai-backend id` → `uid=0`）。root 建出来的会话目录是 `0755 root:root`，Hermes 的 `hermes`（uid 10000）**无法写入**，会得到 `Permission denied`。
- 上面用“backend 也跑 10000 + init 把卷 chown 给 10000”解决。backend 以 10000 运行时，唯一已知的额外写路径是 `/app/data/avatars`（`backend/app/main.py:436-437`），所以用 `liumai-app-data:/app/data` 兜住；上线前请顺手测一次头像上传。`/app` 下 `__pycache__` 写不进去最多是告警，不影响运行（`HOME: /tmp` 已兜住用户级缓存）。
- 如果内网没有 `alpine:3.20`，换成已有镜像；或在一台一次性容器里手工 `chown -R 10000:10000 <卷挂载点>`。
- 若宿主是 SELinux（RHEL/CentOS），bind mount 需要 `:z`；命名卷一般无此问题。
- **不要把 `hermes-data` 同时挂给两个 gateway**（session/SQLite 并发写会坏），官方文档明确警告；`hermes-files` 是普通文件目录，可以共享。

### 4.4 目录权限 / 用户：root vs 非 root

| 角色 | 默认 UID | 说明 |
|---|---|---|
| Hermes 官方镜像 | `hermes` = 10000（可用 `HERMES_UID/HERMES_GID` 重映射，必须 1–65534） | s6 启动时降权；`/opt/data` 会被 chown 给该用户 |
| 六脉 backend | `root`（0） | 镜像未设 `USER`；启动时会 `mkdir` 产物会话目录 |
| 共享卷根目录 | 首次挂载 root:root 0755 | 谁都不写 → 必须 init chown 或 ACL |

三种落地方式：

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）统一 UID** | Hermes `HERMES_UID=10000`；backend `user: "10000:10000"`；init 容器把卷 chown 给 10000 | 权限最简单，长期稳定 | 需要重建 backend；要处理 `/app/data` 可写 |
| B 保留 backend root + ACL | init 容器 `setfacl -R -m u:10000:rwx -m d:u:10000:rwx /data/hermes-files` | 不改 backend 运行用户 | 需要带 `acl` 的镜像（`apk add acl` 要能联网/有内网源）；文件系统要支持 ACL |
| C 仅 PoC | 卷目录 `chmod 777`，backend `umask: "000"`（Compose 2.30+/Docker 26+ 才支持 `umask`） | 快 | 777 不适合生产；umask 依赖版本 |

**不要** 试图把 Hermes 跑成 root（源码/入口会拒绝，且会把 root 文件写进数据卷，后续 dashboard/gateway 无法处理）。

### 4.5 关键坑：`HERMES_WRITE_SAFE_ROOT` 会挡住共享目录

官方镜像内置：

```dockerfile
ENV HERMES_WRITE_SAFE_ROOT=/opt/data
```

`agent/file_safety.py:222-228, 300-302` 会把它当作 **file 写工具的白名单**：路径不在白名单内直接拒绝，报：

```text
Write denied: '/data/hermes-files/...' is outside HERMES_WRITE_SAFE_ROOT (/opt/data). Unset the variable or add this path's directory prefix.
```

所以只挂卷还不够，必须把共享目录加进去（`os.pathsep` 在 Linux 是 `:`）：

```yaml
      HERMES_WRITE_SAFE_ROOT: "/opt/data:/data/hermes-files"
```

注意：

- **不能只写 `/data/hermes-files`**，否则 agent 连自己的记忆/SOUL 都写不了；
- `terminal` 工具不受这个白名单约束（源码注释也说明它不是安全边界），所以你可能看到“`write_file` 被拒，但 `echo >` 成功”的诡异现象；
- 想完全避开这条，也可以把卷在两边都挂到 `/opt/data/hermes-files`，并把两边的 `HERMES_FILES_DIR` / `HERMES_FILES_HOST_PATH` 都设成 `/opt/data/hermes-files`；这样天然落在 safe root 内，代价是 backend 里出现一个 `/opt/data` 路径、备份语义变混。通常不如直接加白名单清晰。

### 4.6 关键坑：`HERMES_FILES_HOST_PATH` 还留着 Windows 路径

`backend/app/routes/chat.py:226-228, 247-256` 会用两个变量拼提示词：

- 容器路径：`HERMES_FILES_DIR/<token>`
- “宿主路径”：`HERMES_FILES_HOST_PATH + "\" + token`

默认值仍是 `E:\dev\Liumai\hermes-files`（`HERMES_FILES_DIR` 默认 `/data/hermes-files`）。在 Linux Hermes 容器里，这个“宿主路径”不存在；模型可能照它创建出一个名字里带反斜杠的目录，产物六脉看不到。

**必须设置**：

```yaml
      HERMES_FILES_HOST_PATH: /data/hermes-files
```

小瑕疵：实现用 `"\\"` 拼接，提示词里会显示成 `/data/hermes-files\<id>`（反斜杠）。只是提示词可读性问题，不影响按前一个容器路径写入；要彻底优雅得改 `os.path.join`/`posixpath`，不在本次只读范围内。

### 4.7 技能（skills）也要放进 Hermes 容器

六脉 compose 里的 `./hermes-skills:/opt/hermes-skills:ro` **只挂给了 backend**，而 backend 代码并没有读 `/opt/hermes-skills`。Hermes 的技能目录是数据卷里的 `/opt/data/skills/`。

容器化 Hermes 后，RCA 要真正跑起来，需要：

```bash
# 把仓库里的技能复制进 Hermes 的数据卷（或在镜像/卷初始化时同步）
docker cp ./hermes-skills/rca-fault-delimitation hermes:/opt/data/skills/
docker cp ./hermes-skills/emergency-collaboration hermes:/opt/data/skills/
# docker cp 会保留源属主（可能不是 10000），顺手改回 hermes
docker exec -u 0 hermes chown -R 10000:10000 /opt/data/skills/
docker exec hermes hermes skills list   # 确认已加载
```

同时给 Hermes 容器配置技能脚本所需的数据源环境变量（见 §3.7），否则技能里的脚本连不上监控/日志/ClickHouse。

---

## 5. D. 安全

| 项 | 要求 | 说明 |
|---|---|---|
| 暴露面 | **不发布 8642 到公网**；同一网络优先不写 `ports` | API Server 拥有完整 terminal/file 工具权限，等于“可执行命令的入口” |
| 网络 | 仅内网 / VPN / 专线；跨主机只放行六脉网段 | 源码在“非回环 + terminal.backend=local”时会打警告（`api_server.py:4485-4498`） |
| Key | ≥16（建议 64 hex）；定期轮换；不写进镜像/仓库 | 轮换要同时改 Hermes 与六脉设置页 |
| CORS | 不设；确需浏览器直连时用精确 origin 列表 | 不要照抄文档里的 `API_SERVER_CORS_ORIGINS='*'` |
| TLS | 跨主机/跨网段建议 nginx/Traefik 终止 TLS | 六脉是服务端调用，私 CA 要装进 backend 容器，否则 httpx 校验失败 |
| 资源 | Hermes 2–4G 内存、2 CPU；`shm_size: 1g` | 浏览器工具最吃内存；不给限制可能拖垮宿主 |
| 并发 | `gateway.api_server.max_concurrent_runs`（config.yaml，默认 10，超限 429） | 六脉 `RCA_MAX_CONCURRENCY` 默认 5，建议把 Hermes 侧也设 5，避免排队雪崩 |
| 凭据 | 不要在 Hermes 里挂宿主 `docker.sock` | 除非确实需要 agent 操作宿主 Docker；那等于把宿主 root 交出去 |
| 镜像 | 生产用 `stable` 或固定版本/摘要，不用 `latest` | 避免半夜被升级改行为 |
| 数据 | 定期备份 `hermes-data` 与 `hermes-files` | `docker compose down -v` 会一起删掉 |

TLS 反代示例（nginx，SSE 必须关 buffering）：

```nginx
server {
    listen 443 ssl;
    server_name hermes.internal;

    ssl_certificate     /etc/nginx/certs/hermes.crt;
    ssl_certificate_key /etc/nginx/certs/hermes.key;

    location / {
        proxy_pass http://hermes:8642;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;          # /v1/chat/completions 的 SSE 流
        proxy_cache off;
        proxy_read_timeout 3600s;     # RCA 单次可能几分钟
        proxy_send_timeout 3600s;
        client_max_body_size 10m;     # 与 Hermes 的 MAX_REQUEST_BYTES 一致
    }
}
```

此时六脉 URL 填 `https://hermes.internal/v1`。

---

## 6. E. 六脉设置页应该填什么

入口：**系统设置 → 智能引擎 → Hermes 智能引擎**（`src/pages/settings.tsx:363-385`）。
字段只有两个：`API 地址`、`API Key（可选）`。

### 6.1 正确值

| 字段 | 同网络（推荐） | 跨主机 | TLS 反代 |
|---|---|---|---|
| API 地址 | `http://hermes:8642/v1` | `http://192.168.10.20:8642/v1` | `https://hermes.internal/v1` |
| API Key | Hermes 的 `API_SERVER_KEY` | 同左 | 同左 |

- **必须带 `/v1`**：六脉客户端直接把用户填的 URL 当 `base_url`，再拼 `/chat/completions`（`backend/app/services/hermes.py:364-367, 414`）；它只会在健康探测时临时去掉 `/v1`。
- Key **不是可选**：UI 的括号“可选”是旧文案，当前 Hermes 所有部署都强制 Key。
- 保存后立即生效（`reload_hermes_config`），不用重启 backend。
- **新部署别跳过设置页**：DB 为空时后端会回退到 `HERMES_GATEWAY_URL` 的默认值 `http://hermes-gateway:8080`（`backend/app/config.py:65-72`），既没有 `hermes-gateway` 这个 DNS，也不是 8642。要么在设置页保存一次，要么在 compose 里给 backend 设 `HERMES_GATEWAY_URL` 兜底。
- 设置页的 placeholder `http://host.docker.internal:8642/v1` 是“Hermes 在宿主”时代的示例，容器化 Hermes 时不要照抄。

### 6.2 正确 / 错误对照表

| 写法 / 示例 | 结果 | 原因 |
|---|---|---|
| URL `http://localhost:8642/v1` | 测试连接失败 / Connection refused | 容器内 localhost = backend 自己 |
| URL `http://127.0.0.1:8642/v1` | 同上 | 同上 |
| URL `http://host.docker.internal:8642/v1` | 连接被拒或超时 | Hermes 在容器里，宿主网关没有 8642 监听（除非恰好在宿主跑） |
| URL `http://hermes:8642`（漏 `/v1`） | **测试连接显示正常，聊天/RCA 404** | 健康探测会走根路径 `/health`；聊天去 `/chat/completions`，Hermes 没有这个路由 |
| URL `http://hermes:18642/v1` | Connection refused | 18642 是宿主映射端口，容器网络里只有 8642 |
| URL `http://192.168.10.20:18642/v1`（映射为 `18642:8642`） | 跨主机的正确写法；写成 `:8642` 才错 | 跨主机看宿主端口 |
| URL 末尾多 `/`：`http://hermes:8642/v1/` | 正常 | 客户端会 `rstrip("/")` |
| Key 留空 | 401 `Invalid gateway API key` | Hermes 强制 Key；但“测试连接”可能仍显示正常（`/health` 公开） |
| Key 填 LLM Key（DeepSeek/OpenAI） | 401 | 两套凭据无关 |
| Key 与 Hermes 不一致 / 少一位 / 带空格 | 401 | `hmac.compare_digest` 精确匹配 |
| Key 在 UI 里看到 `••••` 就复制到别处 | 401 | UI 返回的是掩码值，不是真 Key（`_mask_key`） |
| 两个容器不在同一网络 | `getent hosts hermes` 无结果 | 需要 §3.2 的 external network |

### 6.3 为什么“测试连接”通过不代表配置对

`backend/app/routes/auth.py:494-553` 的测试只调用健康探测链：`/health/detailed` → `/health` → `/v1/health`，并且 **401 时会去掉 Authorization 再试一次**，最后 `/health` 是公开的。因此：

- URL 漏 `/v1` → 仍可能显示“服务正常”；
- Key 填错 → 可能显示“正常”，但带一条“使用 /health 回退”的黄色警告；
- 真正验证 Key 只能用 `/v1/models`（见 §7）。

---

## 7. F. 验证命令

> 约定：Hermes 容器名 `hermes`，六脉后端容器名 `liumai-backend`，网络 `liumai_liumai-net`。
> `<KEY>` 替换成 `API_SERVER_KEY`，不要留在 shell history 里（可用 `read -s`）。
> 下面的命令按 **Linux 宿主 bash** 书写；在 Windows PowerShell 里执行时，`python -c` 的内层引号会被吞掉，
> 优先用 `docker exec -i ... python -` + here-string，或先 `wsl` 进 Linux 环境。

### 7.1 Hermes 容器内自测

```bash
# 1) 存活（公开端点）
docker exec hermes sh -lc 'curl -fsS http://127.0.0.1:8642/health'
# {"status":"ok","platform":"hermes-agent","version":"..."}

# 2) 启动日志 / Key 是否被拒
docker logs --tail 100 hermes 2>&1 | grep -iE 'API server listening|Refusing to start|API_SERVER_KEY'

# 3) 带 Key 列模型
docker exec hermes sh -lc 'curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/v1/models'
# {"object":"list","data":[{"id":"hermes-agent",...}]}

# 4) 详细健康（这个要 Bearer）
docker exec hermes sh -lc 'curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/health/detailed' | head -c 400

# 5) 无 Key 必须 401（证明鉴权生效）
docker exec hermes sh -lc 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8642/v1/models'
# 401

# 6) 错误 Key 必须 401
docker exec hermes sh -lc 'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong" http://127.0.0.1:8642/v1/models'
# 401
```

如果 Key 只在 `/opt/data/.env` 里：

```bash
docker exec hermes sh -lc 'set -a; . /opt/data/.env; set +a; curl -fsS -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/v1/models'
```

### 7.2 六脉 backend 容器内自测

> 六脉 backend 镜像基于 `python:3.12-slim`，**没有 curl，也没有 wget**（已实测）。用 Python 标准库。

```bash
# DNS 是否解析
docker exec liumai-backend getent hosts hermes
docker exec liumai-backend python -c 'import socket; print(socket.gethostbyname("hermes"))'

# /health（公开，不带 Key）
docker exec liumai-backend python -c 'import urllib.request as u; print(u.urlopen("http://hermes:8642/health", timeout=5).read().decode())'

# /health/detailed + /v1/models（带 Key）
docker exec liumai-backend python -c '
import urllib.request as u
key = "<KEY>"
for path in ("/health/detailed", "/v1/models"):
    req = u.Request("http://hermes:8642" + path, headers={"Authorization": "Bearer " + key})
    try:
        with u.urlopen(req, timeout=10) as r:
            print(path, r.status, r.read(300).decode())
    except Exception as e:
        print(path, "ERR", e)
'
```

多行不方便时用单行：

```bash
docker exec liumai-backend python -c 'import urllib.request as u; r=u.Request("http://hermes:8642/v1/models", headers={"Authorization":"Bearer <KEY>"}); print(u.urlopen(r, timeout=10).read().decode())'
```

### 7.3 端到端：真的发一次 chat completion

```bash
docker exec liumai-backend python -c '
import json, urllib.request as u
key = "<KEY>"
body = json.dumps({"model": "hermes-agent", "messages": [{"role": "user", "content": "只回复 OK"}], "stream": False}).encode()
req = u.Request("http://hermes:8642/v1/chat/completions", data=body,
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
print(u.urlopen(req, timeout=600).read().decode()[:500])
'
```

预期返回 OpenAI 格式的 `choices[0].message.content`。RCA 请求可能跑几分钟，超时要像六脉一样给 600s。

### 7.4 共享目录验证（双向）

```bash
# 1) 卷已挂到两边
docker exec hermes sh -lc 'mount | grep hermes-files || df -h /data/hermes-files'
docker exec liumai-backend python -c 'import os; print(os.path.isdir("/data/hermes-files"))'

# 2) Hermes 写入，backend 能读
docker exec hermes sh -lc 'id; mkdir -p /data/hermes-files/smoke; echo hello > /data/hermes-files/smoke/a.txt; stat -c "%u:%g %a %n" /data/hermes-files/smoke/a.txt'
docker exec liumai-backend python -c 'print(open("/data/hermes-files/smoke/a.txt").read())'

# 3) backend 建目录，Hermes 能写（检验权限方案）
docker exec liumai-backend python -c 'import os; os.makedirs("/data/hermes-files/perm-probe", exist_ok=True); print("uid", os.stat("/data/hermes-files/perm-probe").st_uid)'
docker exec hermes sh -lc 'echo x > /data/hermes-files/perm-probe/x.txt && echo hermes-write-ok'

# 4) safe root 配置
docker exec hermes sh -lc 'echo "HERMES_WRITE_SAFE_ROOT=$HERMES_WRITE_SAFE_ROOT"'
# 期望：HERMES_WRITE_SAFE_ROOT=/opt/data:/data/hermes-files
```

第 3 步若 `Permission denied`，就是 §4.4 的 UID 没对齐（最常见：backend 仍 root，目录 755 root:root）。

### 7.5 宿主侧（仅当发布了端口）

```bash
curl -fsS http://127.0.0.1:18642/health
curl -fsS -H "Authorization: Bearer <KEY>" http://127.0.0.1:18642/v1/models
```

### 7.6 失败 → 定位表

| 现象 | 优先检查 |
|---|---|
| 六脉测试连接：Connection refused | Hermes 是否 `0.0.0.0`；两容器是否同网络；DNS `getent hosts hermes` |
| 401 | 两端 Key 是否一致；是否有空格；是否把掩码值当真 Key |
| 404（聊天/RCA） | URL 是否漏 `/v1`（测试连接可能仍是正常） |
| 404（`/v1/models` 也 404） | 是不是连到了别的服务/旧 Gateway（8080）；端口是否写错 |
| 连接超时 | 跨主机端口映射/防火墙；`ports` 左侧端口是否写对 |
| `Write denied ... outside HERMES_WRITE_SAFE_ROOT` | 按 §4.5 加 `/data/hermes-files` |
| 产物在 Hermes 里，但六脉下载 404 | 两边不是同一个卷/同一路径；`HERMES_FILES_DIR` 不一致 |
| 产物写到了 `E:\...` 之类的目录 | `HERMES_FILES_HOST_PATH` 没改（§4.6） |
| 目录 `Permission denied` | §4.4 UID/ACL 没对齐 |

---

## 8. 附录

### 8.1 最小变更清单（只改部署，不改代码）

| # | 位置 | 变更 | 是否必须 |
|---|---|---|---|
| 1 | compose 新增 `hermes` 服务 | §2.4 的 env + `hermes-data` / `hermes-files` 卷 + `liumai-net` | 必须 |
| 2 | 仓库根 `.env` | `HERMES_API_SERVER_KEY=<openssl rand -hex 32>` | 必须 |
| 3 | `backend` 服务 | `HERMES_FILES_DIR`、`HERMES_FILES_HOST_PATH` 指向 `/data/hermes-files`；用命名卷替换 `./hermes-files` | 必须 |
| 4 | `backend` 服务 | 与 Hermes 统一 UID（`user: "10000:10000"` + `/app/data` 卷 + init chown） | 必须（否则 Hermes 写不进产物目录） |
| 5 | `hermes` 服务 | `HERMES_WRITE_SAFE_ROOT=/opt/data:/data/hermes-files` | 必须 |
| 6 | 六脉设置页 | URL `http://hermes:8642/v1` + Key | 必须 |
| 7 | 数据卷 | 把旧 `./hermes-files` 里已有产物迁移进新卷（可选） | 建议 |
| 8 | Hermes | 安装 RCA 技能到 `/opt/data/skills` + 数据源环境变量 | RCA 必需 |

旧产物迁移示例（在仓库根执行，先把 `hermes-files` 备份）：

```bash
docker run --rm -v liumai_hermes-files:/to -v "$PWD/hermes-files":/from alpine:3.20 \
  sh -c 'cp -a /from/. /to/ && chown -R 10000:10000 /to'
```

### 8.2 回滚

- 只回滚六脉配置：设置页改回旧 URL/Key 即可，立即生效。
- 回滚 compose：恢复 `./hermes-files` bind mount 与 backend root 用户，然后 `docker compose up -d backend`。
- **不要** `docker compose down -v`：会删除 `postgres_data`、`redis_data`、`hermes-data`、`hermes-files`（仓库 `docker-compose.yml` 顶部已有警告）。

### 8.3 本文引用的关键位置

| 结论 | 依据 |
|---|---|
| 默认 bind/端口 | `gateway/platforms/api_server.py:218-233` |
| Key 强制 + ≥16 + 占位符拒绝 | `gateway/platforms/api_server.py:4405-4434`；`hermes_cli/auth.py`（`has_usable_secret`） |
| 非回环 + local 终端警告 | `gateway/platforms/api_server.py:4485-4498` |
| Key 可用即启用 | `gateway/config_env.py:112-120` |
| 镜像用户/数据卷/safe root | `Dockerfile:174, 461-462, 508` |
| file 写白名单 | `agent/file_safety.py:222-228, 300-302` |
| 六脉 URL 拼接与 `/v1` | `backend/app/services/hermes.py:364-367, 414` |
| 产物路径与提示词 | `backend/app/routes/chat.py:223-256` |
| 六脉测试连接只探健康 | `backend/app/routes/auth.py:494-553` |
| 设置页字段与 placeholder | `src/pages/settings.tsx:375-385` |
| 当前 compose 的卷/网络名 | `docker-compose.yml:70-107, 138-144`；`docker network ls` → `liumai_liumai-net` |

### 8.4 一句话版本

> Hermes 容器：`0.0.0.0:8642` + 强 Key + `HERMES_WRITE_SAFE_ROOT` 带共享目录；
> 六脉与 Hermes 同网络，URL 填 `http://hermes:8642/v1`；
> 两边同挂 `hermes-files` 到 `/data/hermes-files`，UID 对齐；
> 六脉 URL 的 `/v1` 和“Key 必填”是两个最容易静默失败的点。
