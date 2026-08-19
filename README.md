<p align="center"><img src="design/logo/viron-logo.svg" alt="Viron" width="160" /></p>

<h1 align="center">Viron</h1>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  开发运维全家桶<br />
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" /></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.6-informational.svg" />
</p>

Viron 是面向开发与运维的一站式工作台。它把 Web 浏览器、SSH 终端、MySQL / MariaDB、Redis、主机监控和 Agent 放在同一个环境里，减少在终端、数据库客户端、浏览器和跳板机之间来回切换。组织、项目组和资源授权用来控制谁能进哪套环境；操作审计、终端录像和 SQL 历史用来追溯谁做了什么。

<p align="center"><img src="image/封面.png" alt="Viron 登录页" width="920" /></p>

## 服务端、Web 客户端和桌面 App

Viron 是同一套产品的三个部分，共用账号、工作空间、环境和加密凭据，并不是三套互不相干的工具。

```text
                         Viron 服务端
              账号 · 权限 · 凭据 · 审计 · 环境
                            │
           ┌────────────────┴────────────────┐
           │                                 │
         Full 版本                         Lite / Full
      静态页面 + Chromium                 API / WebSocket
           │                                 │
      Web 客户端                          桌面 App
      （浏览器打开）                     （macOS / Windows）
      目标流量从服务端出去                 默认本机直连，
                                         也可改走服务端转发
```

**服务端** 是控制面。用户、组织、环境、加密凭据和审计都保存在这里。Web 和 App 都连接到同一个 Endpoint。服务端有两个版本：

| 版本 | 包含什么 | 不包含什么 |
| --- | --- | --- |
| **Full** | API、WebSocket、Web 页面、用于打开目标网站的 Chromium，以及 SSH / SFTP / 日志 / 数据库 / Redis 的服务端转发 | 浏览器使用时没有缺项 |
| **Lite** | API、凭据授权，以及 SSH / SFTP / 日志 / 数据库 / Redis 的服务端转发 | 没有 Web 页面，也没有 Chromium。请用 App 连接，不要用浏览器打开 |

**Web 客户端** 是 Full 服务端提供的页面。用浏览器打开服务地址即可，不用安装。SSH、数据库、Redis、日志和目标网站都由**服务端**发起；目标网页跑在服务端 Chromium 里。适合不装客户端、需要统一网络出口的场景。

**桌面 App** 是同一套工作台的 macOS 12+ / Windows 安装包。在 App 里填写 Viron Endpoint（Lite 或 Full 都可以）。目标连接默认从**当前电脑**发出；本机到不了目标时，可以把支持的协议改成服务端转发。如果服务端不能代理网站（Lite，或 Full 未提供该能力），App 仍用本机 Chromium 打开这些页面。App 还提供原生悬浮层、本机 MCP 和系统通知。

| | Web 客户端 | 桌面 App |
| --- | --- | --- |
| 怎么进入 | 浏览器打开 Full 服务地址 | 安装 App，填写 Endpoint |
| 对接哪类服务端 | 只对接 Full | Lite 或 Full 都可以 |
| 目标流量从哪出去 | 一律从服务端 | 默认从本机，也可改走服务端 |
| 目标网站怎么打开 | 服务端 Chromium | 本机 Chromium；Full 支持转发时也可以走服务端 |
| 更适合 | 免安装、统一出口 | 直连内网，或按网络位置混用两种出口 |

工作台界面是同一套。选 Web 还是 App，只是连接从哪里发出，不是另一套产品。

## 功能

- **Web 浏览器**：以网站为单位录入多个登录账号，并可同时打开。账号之间登录态隔离，开发时不用反复切换视角。
- **SSH 终端**：真实终端，支持登录脚本、命令历史和收藏，常用命令不用反复手敲。同时提供双栏 SFTP，以及浏览器里的 `rz` / `sz`。
- **数据库**：MySQL / MariaDB 工作台覆盖 Navicat 日常运维中约 70% 的能力，包括对象树、SQL、表设计、数据网格、导入导出和同步。
- **Redis**：Standalone 工作台覆盖绝大多数常用场景，包括键浏览、六种核心类型维护、TTL 和受控命令。
- **监控**：经现有 SSH 链路一键安装 `viron-monitor`，采集主机状态，并在异常时告警。
- **Agent**：内置助手可以分析当前环境信息，必要时按确认直接操作环境数据。同时也提供 MCP，方便接到其他 Agent 里使用。
- **组织与审计**：个人空间、组织、项目组和资源授权满足企业内部的数据权限控制；操作事件、终端录像和 SQL 历史可按成员追溯。

## 界面

示例图来自真实使用界面。图中含内部信息，因此做了大面积马赛克，请见谅。

**环境总览** — 按组浏览环境卡片，查看每个环境的 Web、SSH、数据库和 Redis 资源。

<p align="center"><img src="image/环境总览.png" alt="环境总览" width="920" /></p>

**Web 入口** — 同一网站下管理多个账号，登录态相互隔离。

<p align="center"><img src="image/环境详情-web.png" alt="环境详情 Web 入口" width="920" /></p>

**SSH 终端** — 登录脚本、命令历史，以及 SFTP 和 `rz` / `sz`。

<p align="center"><img src="image/环境详情-SSH.png" alt="环境详情 SSH 终端" width="920" /></p>

**实时日志** — 经 SSH 跟踪多个文件，支持过滤、高亮和上下文。

<p align="center"><img src="image/环境详情-日志.png" alt="环境详情实时日志" width="920" /></p>

**数据库** — MySQL / MariaDB 对象树、查询和表数据维护。

<p align="center"><img src="image/环境详情-数据库.png" alt="环境详情数据库" width="920" /></p>

**监控** — 一键安装采集服务，查看主机状态并接收告警。

<p align="center"><img src="image/环境详情-服务维护.png" alt="环境详情服务维护" width="920" /></p>

## 快速开始

需要 Docker 24 与 Docker Compose v2。当前版本为 **0.1.6**。

```bash
cp .env.example .env
```

编辑 `.env`，至少修改首次管理员密码。然后启动 Full 服务端：

```bash
docker compose -f docker-compose.full.yml up -d --build
```

浏览器打开 `http://127.0.0.1:8080`。存活检查为同一地址的 `GET /healthz`；容器健康检查为 `GET /readyz`，它会真实探测元数据库，不可用时返回 503。

只为桌面客户端提供服务、不需要浏览器页面时，改用 Lite：

```bash
docker compose -f docker-compose.lite.yml up -d --build
```

生产环境请保持 `ALLOW_WEAK_PASSWORDS=false`。直接使用 HTTP 时保持 `COOKIE_SECURE=false`；放在 HTTPS 反向代理后面时设为 `true`。元数据库默认使用 `DATA_DIR` 下的 SQLite；也可以改为已有的 MySQL 8+ / MariaDB 10.6+。

桌面客户端支持 macOS 12+（Apple Silicon / Intel）和 Windows（x86 / x64 / arm64）。更完整的部署、迁移、备份和客户端安装说明见 [使用手册](./docs/USER-GUIDE.md)。

## 本地开发

需要 Node.js 22.19+。

```bash
npm ci
cp .env.example .env
./scripts/dev-service.sh start
```

默认 API 地址为 `http://127.0.0.1:8080`。启用浏览器客户端时，开发界面为 `http://127.0.0.1:5173`。

```bash
npm run typecheck
npm test
npm run build
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用手册](./docs/USER-GUIDE.md) | 功能说明、操作路径和管理维护 |
| [技术设计](./TECHNICAL-DESIGN.md) | 架构、安全边界、数据模型和验收口径 |
| [MCP](./docs/MCP.md) | 远程 / 本机 MCP 接入与能力范围 |
| [脚本同步](./docs/SCRIPT-SYNC.md) | 隔离脚本同步的输入输出约定 |
| [路线图](./docs/ROADMAP.md) | 尚未交付的后续方向 |
| [安全政策](./SECURITY.md) | 漏洞披露方式 |

## 安全

连接密码、私钥、Cookie 和 TLS 材料使用 AES-256-GCM 加密保存。实例主密钥默认生成在数据目录中，权限为 `0600`。MCP 默认关闭；开启后也不会把已保存的秘密写入工具参数或返回结果。

请勿把 `.env`、`data/` 或 `secrets/` 提交到版本库。发现漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可

本项目以 [Apache License 2.0](./LICENSE) 发布。第三方组件见 [NOTICE](./NOTICE) 和 [monitor/THIRD_PARTY_NOTICES.md](./monitor/THIRD_PARTY_NOTICES.md)。

Navicat 是 PremiumSoft CyberTech Ltd. 的商标。SecureCRT 是 VanDyke Software, Inc. 的商标。Viron 与这些产品没有从属关系，仅提供独立实现的连接导入和协议兼容。
