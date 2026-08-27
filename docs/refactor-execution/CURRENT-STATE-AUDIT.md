# 当前实现审计

> 负责人：Grok。Phase 0A 填写。除明确标注为“事实”的内容外，不得把猜测写成结论。

## 1. 审计元数据

| 字段 | 值 |
| --- | --- |
| 审计时间 | 2026-08-27 10:54–11:15 CST |
| 审计 Agent | Grok |
| 分支 | `dev` |
| HEAD commit | `e2507331451ac18a49cf140d617ed26286d6e12b` (`docs: add multi-agent refactor execution playbook`) |
| `origin/dev` commit | `e2507331451ac18a49cf140d617ed26286d6e12b`（与 HEAD 一致） |
| 工作区状态 | **不干净**，因此未执行 `git pull --ff-only`。已有改动不属于本阶段：5 份 `docs/refactor-execution/` 打包策略修订（未纳入本提交）；未跟踪 `src/client/components/EnvironmentMonitoringDashboard.vue`。本阶段只写入本文件与 `STATUS.md`。 |
| Node/npm/操作系统 | Node `v26.0.0`，npm `11.12.1`，Darwin arm64 |

## 2. 未跟踪监控组件审计

目标：`src/client/components/EnvironmentMonitoringDashboard.vue`

- 来源线索：从未进入 Git 历史（`git log --all -- <path>` 为空；`git log -S EnvironmentMonitoringDashboard` 只命中执行手册提交 `e250733`）。文件 mtime `2026-08-26 22:30`，865 行。文案与三视图（主机基础设施 / 业务服务 APM / NOC 投屏大屏）与 `docs/SERVICE-MAINTENANCE-AND-MONITORING-REFACTOR.md` 模块二同构。仓库内除执行文档外 **没有任何 `.vue` / `.ts` import**。生产 `vite build` chunk 中无此文件。结论：环境级 UI 草稿，不是已接线产品。
- 完成度：三视图壳和 NOC CSS 热力图可用作 IA 参考；数据层、过滤、暂停、last-updated、全局路由、Fullscreen API、`prefers-reduced-motion`、探针管理均未达到 Phase 3。
- 引用但不存在的 API/类型/样式：
  - 调用 `GET /api/v1/environments/:id/service-maintenance`，**该路径不存在**。真实路径是 `GET /api/v1/environments/:id/maintenance`。
  - 本地 `HostSnapshot` 使用 `cpuUsagePercent` / `memoryUsagePercent`；真实 payload 是 `cpuUsedPercent` / `memoryUsedPercent`。集群均值、pill、热力图会显示 0。
  - 本地主机 `status: "ready" \| "offline" \| "unsupported" \| "error"`；真实是 `monitorStatus: "ready" \| "missing" \| "error" \| "unknown"` + `monitorOffline`。无 `hosts[].id`，主键是 `sshConnectionId`。
  - 部署字段 `cpuPercent` / `hostName` / `kind` 与真实 `metrics.cpuUsedPercent` / `sshConnectionName` / `provider` 不一致。
  - `GET /api/v1/monitor-alerts?environmentId=` 的 query **不被服务端使用**（按授权工作空间聚合，`LIMIT 100`）。
  - 多条 `$t(...)` 文案在 `src/shared/i18n-messages.ts` 中无对应条目（例如「监控大盘」「主机基础设施」「NOC 投屏大屏」）。
  - 未使用 import：`DeploymentMonitorDashboard`、`ArrowUpRight`、`Clock`、`Flame`、`LayoutDashboard`、`Zap`。
- 是否能独立通过类型检查：**能**。`tsconfig.json` include `src/client/**/*.vue` 且未开 `noUnusedLocals`；`npm run typecheck` 在该文件存在时通过。**不能作为可运行功能**：错误 URL 与错误字段是运行时问题；未接入路由，不进入 `vite build` 图。
- 与现有监控组件重复内容：主机明细直接内嵌 `HostMonitorDashboard`；服务时序 import 了 `DeploymentMonitorDashboard` 但模板未挂载；告警列表与 `MonitorAlertCenter` 重复轮询；再造了一套与 `service-maintenance/types.ts` 冲突的 payload 类型。
- 可复用部分：三视图 IA、集群摘要条、NOC 两栏/热力图 CSS、15s 轮询的卸载 `clearInterval` 模式。数据层、健康着色、服务 APM、过滤/暂停必须重写。
- 建议处置：`拆分复用`
- 证据：
  - `rg EnvironmentMonitoringDashboard` 仅命中 `docs/refactor-execution/*` 与该文件自身。
  - `src/client/router.ts` 无 `/monitoring`；`AppShell.vue` `menuItems` 无监控项。
  - `src/client/components/service-maintenance/use-maintenance-payload.ts:157` 使用 `/maintenance`。
  - `npm run typecheck` 通过；`npm run build` 产物不含该组件。
  - 轮询：`onMounted` 15s `setInterval`，`onBeforeUnmount` 清理；不取消 in-flight 请求；缺失 snapshot 被当成 0% 健康。

未得到用户批准前，不得删除该文件。Gate 1 前禁止接入路由。Phase 0A **不** `git add` 该文件。

## 3. 需求实现矩阵

状态使用：`DONE`、`PARTIAL`、`MISSING`、`CONFLICT`。

| 需求 | 状态 | 现有实现位置 | 缺口/冲突 | 证据 |
| --- | --- | --- | --- | --- |
| 密钥与证书一级入口 | MISSING | `AppShell.vue` `menuItems` 仍为 `SSH 密钥` → `/ssh-keys` | 无「密钥与证书」菜单与双 Tab 页 | `AppShell.vue:60`；`router.ts:29` |
| SSH 密钥 Tab | PARTIAL | `SshKeysView.vue` 独立页：导入/生成/导出/指纹/关联数 | 不是凭据中心的 Tab；能力本身可用 | `SshKeysView.vue`；`tests/ssh-keys.test.ts` |
| SSL/TLS 证书资产列表 | PARTIAL | `ServiceMaintenancePanel` 证书工作区 + `groupTlsEndpoints` | 环境级、端点中心，不是工作空间证书资产 | `use-tls-certificates.ts`；`tls_endpoints` 无 `workspace_id` |
| SHA-256 指纹归并 | PARTIAL | 探测后内存分组 `groupTlsEndpoints`；同源 HTTPS 复用端点 | DB 唯一键是 `(environment_id, ssh_bind_key, host, port, sni)`，无 `(workspace, fingerprint)` | `shared/tls-certificates.ts:230`；`sqlite-schema.ts:1134` |
| 多 Web 入口关联 | PARTIAL | `tls_endpoint_web_entries`；创建/更新 Web 入口时 `syncWebEntryTlsEndpoint` | 同 origin 归并；不同主机同一张通配证书不在 DB 归并 | `tls-certificates.ts:442`；`web-entries.ts:113` |
| Web 入口证书徽标 | PARTIAL | `GET .../web-entries` 附加 `tls`；卡片显示过期/即将到期/主机名不匹配 | 正常剩余天数、未探测、探测中不展示；点击跳维护页，无 Popover | `EnvironmentDetailView.vue:483-494,973` |
| 证书重新探测 | PARTIAL | `POST /api/v1/tls-endpoints/:id/probe`；维护页按钮；1 分钟冷却 | Web 入口无就地重探；探测不要求 manager | `service-maintenance.ts:547`；`tls-certificates.ts:505` |
| 服务维护移除证书 | MISSING | 证书仍是第三工作区 | Phase 2 目标尚未开始 | `ServiceMaintenancePanel.vue:318-327`；`tests/service-discovery-layout.test.ts` 断言证书在服务/主机 Tab 之外但仍在本页 |
| 服务维护移除历史主机监控 | MISSING | 主机 Tab 内嵌 `HostMonitorDashboard`；服务 Tab 内嵌 `DeploymentMonitorDashboard` | 历史时序仍挂在维护页 | `ServiceMaintenancePanel.vue:541-584` |
| Runbook 快捷动作 | PARTIAL | `service_script_actions` + 服务级功能按钮条 | 规格中的具名按钮（平滑重启/全链路体检等）未内置，需用户自建脚本 | `use-script-actions.ts`；`POST .../script-actions/:id/execute` |
| 部署节点矩阵 | PARTIAL | 卡片网格：指标 + 启停重启 + 节点脚本 | 无卡片直连 SSH；k8s/裸进程无标准启停 | `ServiceMaintenancePanel.vue` deployment-grid；`maintenanceCommand` 对 kubernetes/process 返回 null |
| 服务发现纳管 | PARTIAL | 主机工作区「服务发现」子 Tab + `ServiceDiscoveryPanel` | 非顶部常驻「扫描发现 (N)」入口；默认 facet 仅 systemd/docker/kubernetes | `ServiceDiscoveryPanel.vue`；`service-maintenance.test.ts` enroll 流 |
| 全局监控大盘路由 | MISSING | 无 `/monitoring`；告警铃跳到 `tab=maintenance` | Phase 3 未开始 | `router.ts`；`shared/monitor-alerts.ts` `monitorAlertNavigationQuery` |
| 主机基础设施视图 | PARTIAL | 维护页主机监控 + 未跟踪草稿 | 非全局一级；草稿字段错误 | `HostMonitorDashboard.vue`；未跟踪组件 |
| 服务性能视图 | PARTIAL | `DeploymentMonitorDashboard` 按主机拉 history 再切 deployment 序列 | 无服务聚合排名 API；草稿 Top5 因字段错误恒为 0 | `DeploymentMonitorDashboard.vue:116` |
| NOC 全屏模式 | MISSING | 仅未跟踪 CSS `position:fixed` 草稿 | 未路由；非 Fullscreen API；无 Esc/reduced-motion | 未跟踪组件 template NOC section |
| 时序降采样 | PARTIAL | history API `maximumPoints = 480` + stride | 无 `GET /monitoring/overview` 或独立 timeseries 合同测试 | `monitor-history.ts:306-317` |
| 智能 Findings | PARTIAL | `buildMonitorDiagnostics` 在 Host 看板展示最多 8 条 | 无独立 Findings 引擎/跨主机聚合 | `HostMonitorDashboard.vue`；`shared/monitor-performance.ts` |

## 4. 可复用资产

### 客户端

| 文件 | 职责 | 依赖 | 复用方式 | 风险 |
| --- | --- | --- | --- | --- |
| `SshKeysView.vue` (299) | SSH 密钥 CRUD/导入生成导出 | `/api/v1/ssh-keys` | Phase 1 升级为双 Tab 容器的 SSH 侧 | 改名/路由时需同步 `managerOnly`、MCP、i18n |
| `ServiceMaintenancePanel.vue` (1894) | 服务/主机/证书三栏巨型面板 | 多个 composable + Host/Deployment 看板 | Phase 2 瘦身宿主 | 拆分时保护 layout 字符串测试 |
| `service-maintenance/use-*.ts` | payload、目录排序、安装、脚本、告警、TLS | `context.ts` Proxy 互引 | 按阶段搬走 TLS/历史监控 | `api-contract.ts` 是机械类型快照 |
| `ServiceDiscoveryPanel.vue` (539) | 候选扫描与纳管 | hosts[].candidates | Phase 2 保留 | 部分 layout 源码断言 |
| `HostMonitorDashboard.vue` (900) | 单机 1h–30d 时序、进程堆叠、Findings | `GET .../history?range=` | Phase 3 主机视图直接复用 | 无自身定时器；靠父 `lastCollectedAt` |
| `DeploymentMonitorDashboard.vue` (346) | 服务节点 CPU/内存历史 | 对每个唯一 host `Promise.all` history | Phase 3 服务视图可复用 | **无并发上限** |
| `MonitorTimeSeriesChart.vue` (465) | 图表 | — | 复用 | 含源码字符串测试 |
| `MonitorAlertCenter.vue` (378) | 全局告警铃 | `/api/v1/monitor-alerts` 10s | 导航目标需随大盘改 | 与草稿重复轮询 |
| `EnvironmentDetailView.vue` | 环境页签与 Web 入口徽标 | web-entries `tls` | Phase 1 徽标/Popover | 目前只显示异常三类 |
| `monitor-history-loading.ts` | 先 1h 再目标 range | — | 复用 | 已有单测 |
| 未跟踪 `EnvironmentMonitoringDashboard.vue` | 三视图壳 | 错误 API | 只拆布局，不整文件接入 | 见 §2 |

### 服务端

| 模块 | 职责 | 数据来源 | 权限 | 风险 |
| --- | --- | --- | --- | --- |
| `routes/ssh-keys.ts` | 工作空间密钥 | `ssh_keys` | 全部 manager | 已按 workspace 隔离 |
| `tls-certificates.ts` | 端点 CRUD、探测、Web 同步、定时探测 | `tls_endpoints` | 路由层 env ACL | 无 workspace 证书表；探测经 SSH openssl |
| `routes/service-maintenance.ts` | 维护聚合、TLS HTTP、服务/部署/脚本/探针安装 | services + monitor_hosts + tls | GET 任意有环境权的登录用户；写操作多数 manager；**启停/脚本执行/探测/安装不是 manager** | 巨型 GET；权限文案比实际更严 |
| `routes/web-entries.ts` | Web 入口 + TLS 徽标 | web_entries + junction | 读 env；写 manager | 无 `certificate_id` 列 |
| `routes/monitor-history.ts` | 降采样历史 | `monitor_samples` | env + SSH | SQLite/MySQL 两条取数路径 |
| `routes/monitor-alerts.ts` + `monitor-alerts.ts` | 设置、评估、用户已读 | alert 表 | 读授权工作空间；写设置 manager | GET 忽略 environmentId query |
| `service-monitor.ts` | pull/collect、样本写入 | SSH `viron-monitor` | 后台 | `INSERT OR IGNORE` 依赖 MySQL 改写 |
| `monitor-installer.ts` + `monitor-install-task-manager.ts` | 预检/安装/升级 | `/opt` 包 | env + SSH | 已有安全测试 |

### Schema 与迁移

- **SQLite** `tls_endpoints`：环境 FK CASCADE；SSH FK SET NULL；`CHECK(source)`、`CHECK(probe_status)`；唯一索引 `(environment_id, ssh_bind_key, host, port, sni)`；`fingerprint_sha256` **无唯一约束**。
- **MySQL** 同唯一键与 FK；**无 CHECK**；`leaf_sans_json` / `probe_error` **无 DEFAULT**；环境索引无 `DESC`；`fingerprint_sha256 VARCHAR(128)`。
- 无 `ssl_certificates` / `ssl_endpoints`；`web_entries` 无 `certificate_id`。
- 监控表双方都有：`monitor_hosts`、`monitor_samples`（PK `ssh_connection_id, agent_id, sequence_end`）、`monitor_sequence_gaps`、`monitor_install_tasks`、`monitor_alert_*`。SQLite 对 status/rule_type 有 CHECK，MySQL 无。
- `INSERT OR IGNORE` 由 `normalizeMysqlSql` 改为 `INSERT IGNORE`（`database-adapter.test.ts`）。
- 现有库用 `CREATE TABLE IF NOT EXISTS`；新增证书资产表 **不能只改 schema dump**，需要显式迁移器。
- `tests/mysql.integration.test.ts` 在 `VIRON_MYSQL_TEST=1` 时测的是 **MariaDB 工作台**，不是 Viron 自身 TLS/监控 schema。本次 `VIRON_MYSQL_TEST` 未设置，该文件 skip。

### 测试

行为测试（`app.inject` / SSH mock / 纯函数）：`tls-certificates.test.ts`、`tls-certificate-maintenance.test.ts`、`service-maintenance.test.ts`、`ssh-keys.test.ts`、`monitor-alerts.test.ts`、`monitor-history.test.ts`、`monitor-installer.test.ts` 等。

源码字符串测试：`service-discovery-layout.test.ts`、`app-shell-navigation.test.ts`、`monitor-alert-toasts.test.ts`、`monitor-chart-pointer.test.ts`、`monitor-runtime-security.test.ts`。Phase 2 若挪证书 Tab，**会打破** discovery-layout 对证书开关的断言。

缺口见 §8。

## 5. 当前 API 和 Payload

| API | 权限 | 当前用途 | Payload 风险 | 目标阶段 |
| --- | --- | --- | --- | --- |
| `GET/POST/PUT/DELETE /api/v1/ssh-keys*` | 全部 workspace manager | SSH 密钥 | 列表不含私钥 | Phase 1 保留并扩证书 Tab |
| `GET /api/v1/environments/:id/maintenance` | 登录 + 环境权 | 维护首页 | **重**：hosts 全量 snapshot + candidates + k8s + tlsEndpoints + 管理员 scriptBody；客户端每 10s 刷新。不含历史点数 | Phase 2 必须变轻 |
| `POST/PUT/DELETE /api/v1/tls-endpoints*` | 写：manager；探测：环境+SSH | 证书端点 | 环境作用域 | Phase 1 可能替换/兼容 |
| `POST /api/v1/tls-endpoints/:id/probe` | 环境+SSH，**非 manager** | 手动探测 | 经 SSH openssl；冷却 60s | Phase 1 |
| `GET /api/v1/environments/:id/web-entries` | 环境权 | 入口列表 + `tls` 徽标 | `tls` 可为 null | Phase 1 徽标/Popover |
| `GET .../monitor-hosts/:connectionId/history?range=` | 环境+SSH | 1h/6h/24h/7d/30d 降采样 | 最大约 480 点；Deployment 看板 N 路并发 | Phase 3 复用并限制并发 |
| `GET/PUT .../monitor-alert-settings` | GET 环境权；PUT manager | 阈值与 TLS 告警天数 | 环境级 | Phase 2/3 |
| `GET /api/v1/monitor-alerts` | 登录，工作空间授权 | 告警铃 | 忽略 `environmentId` query；LIMIT 100 | Phase 3 若大盘要环境过滤需改 |
| `POST .../service-deployments/:id/actions` | 环境+SSH，**非 manager** | start/stop/restart | docker/systemd/podman/supervisor；k8s/process 400 | Phase 2 |
| `POST .../script-actions/:id/execute` | 环境+SSH，**非 manager** | Runbook | 并发 4；部分成功 200 | Phase 2 |
| 探针 install/refresh/clear | 环境+SSH | 安装生命周期 | 已有预检与审计 | Phase 2 可留在维护或迁出安装入口 |
| `GET /api/v1/workspaces/:id/certificates` | 不存在 | — | — | Phase 1 待合同 |
| `GET /api/v1/monitoring/overview` | 不存在 | — | — | Phase 3 待合同 |
| `GET /api/v1/environments/:id/service-maintenance` | **不存在** | 仅草稿误用 | 404 | 禁止接入 |

## 6. 数据模型差异

重点比较：

- **当前**：`tls_endpoints` 为中心。证书字段（CN、SAN、issuer、fingerprint、validity、probe_*）存在 **每一行端点** 上。作用域是 `environment_id`。身份唯一键是探测坐标 `(environment_id, ssh_bind_key, host, port, sni)`。
- **目标**：`ssl_certificates`（工作空间资产，`fingerprint_sha256` 去重）+ `ssl_endpoints`（探测点）+ `web_entries.certificate_id` 或动态匹配。
- **当前关联**：`tls_endpoint_web_entries` 多对多主键；同步逻辑按 URL origin 保持一入口对应一端点。无 `web_entries.certificate_id`。
- **工作空间作用域**：从 `environments.workspace_type/workspace_id` + `canAccessEnvironment` 推导，**表上没有 workspace_id**。跨工作空间不会共享行，但跨环境的同一指纹 **不会** 归并。
- **指纹为空**：未探测/失败行为 `''`。`groupTlsEndpoints` 用 `pending:${id}` 避免空指纹合并。若对空指纹加 `UNIQUE(workspace_id, fingerprint)` 会碰撞。
- **探测失败**：只更新 `probe_status/error/probed_at`，**不清空** 旧证书字段。
- **证书轮换**：同端点行上覆盖 fingerprint；目标模型应把端点改挂到新证书资产。
- **相同证书不同端点**：通配符多主机 → 多行；UI 仅在同环境、双方探测成功后分组。

审计结论（不替 Codex 作最终决定）：现状是 **环境级探测端点登记表 + 可选 UI 分组**，不是工作空间证书资产。迁到 `ssl_certificates + ssl_endpoints` 是身份、告警 `target_id`、删除级联和 Web 深链的真实迁移，不是改名。兼容窗口必须处理空指纹、跨环境合并是否发生、以及 `customized`/`source=web_entry` 孤儿清理。

## 7. 安全、权限和性能风险

| 风险 | 等级 | 触发条件 | 现有保护 | 建议验证 |
| --- | --- | --- | --- | --- |
| TLS 探测打到 SSH 主机可达的任意 host:port | 中 | 已绑定 SSH 的用户提交内网/元数据地址 | 探测在 **远端 SSH** 上跑 openssl，不是 Viron 进程出网；host 字符集过滤；`quotePosixShellArg`；超时 10s / 64KiB；每环境 50 端点 | Gate 1 明确是否禁止 loopback/RFC1918/169.254.169.254；补非法 host/port/SNI 与注入单测 |
| 命令注入 | 低 | host/sni/externalId 含 shell 元字符 | `isValidTlsHost` 拒绝 `;|&$\` 等；参数单引号包裹；脚本走 stdin 而非 argv | 已有日志路径引号测试；TLS 路径缺对等用例 |
| 工作空间隔离 | 低–中 | 跨空间读证书/告警 | 环境/连接 ACL；SSH 密钥 `workspaceWhere`；history 按 workspace 合并 agent | 缺「两工作空间相同指纹互不可见」测试 |
| 服务操作授权宽于文案 | 中 | org member 有环境+SSH 授权 | 启停/脚本/探测/安装 **不** 走 `requireManager`；UI 用 `canOperate` | Codex 在合同中确认是否有意；补 member vs manager 矩阵 |
| 维护首页过重 + 10s 刷新 | 高 | 打开服务维护 | 历史点数不在 GET 中，但 snapshot/candidates/TLS 全量仍在 | Phase 2 轻量 payload |
| Deployment 看板无限并发 | 中 | 服务跨很多主机 | `requestSequence` 防过期响应 | Phase 3 限制并发 |
| 草稿当健康 | 高（若误接入） | 把未跟踪组件挂上路由 | 目前未引用 | 禁止接入直至重写数据层 |
| 告警 GET 忽略 environmentId | 中 | 大盘按环境过滤 | 工作空间授权 + LIMIT 100 | Phase 3 若需要环境过滤则改 API |
| SQLite/MySQL 语义 | 中 | `INSERT IGNORE`、无 CHECK、无 DEFAULT | adapter 改写已测 | Gate 1 迁移必须双库幂等 |
| 刷新竞态 | 中 | 10s reload vs 排序保存 | 排序中跳过 silent load | 拆分后需保留 |

至少已检查：TLS 探测不在应用进程做 HTTP SSRF；host/port/SNI 校验存在但允许私网；工作空间隔离依赖环境 ACL；服务启停有确认框与 `runningAction`；时序 480 点；维护 10s 与告警 10s、草稿 15s 定时器在对应组件卸载时清理（Host 看板无自身 timer）。

## 8. 测试基线

| 命令 | 结果 | 耗时 | 失败说明 |
| --- | --- | --- | --- |
| `npm run typecheck` | **通过**（含未跟踪 Vue 文件） | real 9.91s | 无 |
| 相关定向测试（13 files / 44 tests：tls、maintenance、monitor、ssh-keys、database-adapter） | **通过** | real 3.47s | 无 |
| `npm test` | **1 个测试文件失败**；164 passed / 6 skipped（171 files）；728 passed / 8 skipped tests | real 15.68s | `tests/desktop-local-web.integration.test.ts` 在并行套件中顶层 `require("electron")`，与其他 desktop-local-* 同时下载 Electron 冲突：`failed to create '.../Electron Framework': File exists (os error 17)` → `Electron failed to install correctly`。该文件在 `VIRON_DESKTOP_WEB_TEST !== "1"` 时应 skip。Electron 二进制到位后单独重跑：**1 skipped**。属既有环境竞态，与本次重构无关；按任务书不修生产代码、不改测试。`VIRON_MYSQL_TEST` 未设置，`mysql.integration.test.ts` skip。 |
| `npm run build` | **通过** | real 10.00s | vite 有 >500kB chunk 警告（既有）。产物不含未跟踪监控组件 |

定向测试文件：`tls-certificates`、`tls-certificate-maintenance`、`service-maintenance`、`service-maintenance-payload`、`monitor-history`、`monitor-alerts`、`ssh-keys`、`monitor-installer`、`monitor-runtime-security`、`monitor-performance`、`monitor-alert-migration`、`monitor-history-loading`、`database-adapter`。

**覆盖缺口（相对方案强制测试，不是本次失败）：**

- 无 SQLite/MySQL TLS schema 对齐测试。
- 无旧数据升级/迁移幂等（证书资产尚不存在）。
- 无「同指纹多入口归并 / 跨工作空间不归并」DB 测试。
- 无 SSRF/非法 host 边界测试。
- 无 docker/podman/supervisor/process 状态映射与启停矩阵。
- 无 member vs manager 权限矩阵。
- 无降采样 480 上限/stride 单测。
- 无全局监控路由/NOC/reduced-motion。
- 若干 UI 测试是源码 `toContain`，拆组件时会碎。

## 9. 建议实施边界

以下为审计建议，**不是**最终架构决定。最终以 Gate 1 `TECH-CONTRACT.md` 为准。

### Phase 1 建议文件范围

- `src/client/views/SshKeysView.vue`、`router.ts`、`AppShell.vue`、相关 i18n / MCP 标题
- `src/server/sqlite-schema.ts`、`mysql-schema.ts`、显式迁移、`tls-certificates.ts`、`routes/service-maintenance.ts` 中 TLS HTTP、`routes/web-entries.ts`
- `src/shared/tls-certificates.ts`、`use-tls-certificates.ts`、`EnvironmentDetailView.vue` 徽标
- 测试：`tls-*.test.ts`、`ssh-keys.test.ts`、新增迁移/隔离/探测失败用例
- **不要** 删除维护页证书 UI（那是 Phase 2）；**不要** 接入未跟踪监控组件

### Phase 2 建议文件范围

- `ServiceMaintenancePanel.vue` 及 `service-maintenance/*`（去掉证书工作区与 Host/Deployment 历史看板挂载）
- `GET /maintenance` 瘦身（移走 tlsEndpoints 与不必要 snapshot/candidates）
- `ServiceDiscoveryPanel.vue`、`use-script-actions.ts`、`use-maintenance-payload.ts` 启停
- `EnvironmentDetailView.vue` 计数/深链
- 测试：`service-maintenance*.test.ts`、`service-discovery-layout.test.ts`（当前断言证书仍在本页，必须改合同后再改）
- 保留 `HostMonitorDashboard` / `DeploymentMonitorDashboard` 实现文件供 Phase 3

### Phase 3 建议文件范围

- 新全局视图 + `router.ts` + `AppShell.vue`
- 按 ADR-006 **拆分复用** 未跟踪组件，禁止无说明覆盖
- 复用 Host/Deployment/TimeSeries/history/alerts
- `MonitorAlertCenter` 跳转目标
- `DeploymentMonitorDashboard` 并发限制
- 测试：导航、过滤、卸载、陈旧/离线、NOC、reduced-motion
- 不要重做探针安装引擎或 TLS schema

## 10. 开放问题

| 编号 | 问题 | 建议决策人 | 阻断阶段 |
| --- | --- | --- | --- |
| A-001 | 证书模型：演进现有 `tls_endpoints`，还是新建 `ssl_certificates + ssl_endpoints` 并迁移？空指纹如何唯一？ | Codex | Gate 1 / Phase 1 |
| A-002 | 同一工作空间跨环境的相同指纹是否归并？归并后告警 `target_id`、删除、深链如何指向？ | 用户 + Codex | Gate 1 |
| A-003 | Web 入口用 junction 继续，还是加 `certificate_id`？入口删除时共享证书是否保留？ | Codex | Gate 1 |
| A-004 | 未跟踪 `EnvironmentMonitoringDashboard.vue`：拆分复用（审计建议）/ 纳管后重写 / 外部备份 / 废弃？ | 用户；写入 ADR-006 | Gate 1；Phase 3 实施 |
| A-005 | 工作区另有执行手册「纯文档不打包」修订（已暂存未提交），以及并行完成的 Phase 0B `UIUX-SPEC.md`（staged，不在本 0A 提交中）。0A 不把未批准规格当作实现输入。 | 用户 | 不阻断 0A；Gate 1 需用户批准 0B |
| A-006 | 启停、脚本执行、TLS 探测、探针安装是否应改为仅 workspace manager？现在 member+SSH 即可。 | 用户 + Codex | Gate 1 / Phase 2 |
| A-007 | TLS 探测是否禁止 SSH 主机访问 loopback/私网/云元数据？当前允许。 | Codex | Gate 1 |
| A-008 | 维护 GET 轻量字段集：hosts 是否仍返回 latest snapshot/candidates？历史图是否完全离开维护页？ | Gemini（体验）+ Codex | Gate 1 / Phase 2 |
| A-009 | 监控 overview 是新 API，还是组合现有 `/maintenance`（瘦身版）+ `/history`？ | Codex | Gate 1 / Phase 3 |
| A-010 | `GET /monitor-alerts` 是否应按 `environmentId` 过滤？当前忽略 query。 | Codex | Phase 3 |
| A-011 | Web 徽标是否展示正常剩余天数/未探测/探测中？点击是 Popover 还是继续跳维护？ | Gemini | Phase 0B / Gate 0 |
| A-012 | Runbook 是继续用户自定义脚本，还是交付规格中的内置动作？ | 用户 + Gemini | Phase 0B / Gate 0 |
| A-013 | `npm test` Electron 并行安装竞态是否视为发布阻塞？本次复现后单独重跑即 skip。 | Codex（Gate 4） | 不阻断 0A；Gate 4 前需策略 |
| A-014 | 无 `VIRON_MYSQL_TEST` 时双库一致性如何在 CI 证明？ | Codex | Gate 1 测试合同 |
