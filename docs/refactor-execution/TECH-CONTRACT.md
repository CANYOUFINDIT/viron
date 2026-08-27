# 技术合同：服务维护、监控大盘与凭据中心

> 负责人：Codex。状态：`FROZEN`。本合同是 Phase 1–3 的 Schema、API、安全、性能和组件边界基准；未经用户批准和新的 ADR，不得偏离。

## 1. 合同信息

| 字段 | 值 |
| --- | --- |
| 状态 | `FROZEN` |
| 负责人 | Codex |
| 输入代码 commit | `2677bbea80ad5aa3e9e7f8b5436ad75a909985da` |
| 现状审计 | `CURRENT-STATE-AUDIT.md`，输出 commit `8357549` |
| UI/UX 版本 | `UIUX-SPEC.md` 2.0.0-final，用户于 2026-08-27 11:24 CST 批准 |
| 冻结时间 | 2026-08-27 11:24 CST |
| 用户批准的例外 | 无 |

## 2. 合同原则与术语

1. **当前工作空间**由认证会话中的 `(workspace_type, workspace_id)` 唯一确定，不接受客户端传入另一个工作空间来扩大查询范围。
2. **证书资产**是工作空间内由非空 SHA-256 叶证书指纹标识的实体；**探测端点**是环境内从指定 SSH 连接访问的 `(host, port, SNI)`。
3. 证书的 CN、SAN、颁发者和有效期属于资产；探测状态、错误、主机名匹配和链完整性属于端点。同一证书可被同工作空间的多个环境、端点和 Web 入口引用。
4. `daysRemaining`、`valid/expiring/expired` 和陈旧状态均在读取时根据 UTC 当前时间、阈值与最后成功时间计算，不作为长期真相重复持久化。
5. 跨工作空间资源查询统一返回 `404`，不得通过 `403`、唯一键冲突、计数或错误文案泄漏资产是否存在。
6. 所有时间使用 UTC ISO-8601 字符串；JSON 列保存规范 JSON 文本；布尔值在 SQLite/MySQL 均用 `0/1` 表达。

## 3. 决策记录

| ID | 决策 | 选择 | 理由 | 兼容/迁移影响 |
| --- | --- | --- | --- | --- |
| ADR-001 | 证书资产模型 | 新建 `ssl_certificates` + `ssl_endpoints`，不继续把证书字段复制在 `tls_endpoints` 每一行 | 全局资产中心、同指纹跨环境归并和证书轮换都需要稳定的资产身份；端点状态又不能错误合并到资产 | Phase 1 迁移旧数据；旧表保留并双写到本次重构发布完成，不在本项目删除 |
| ADR-002 | Web 入口关联方式 | 保留端点—Web 入口 junction，使用新的 `ssl_endpoint_web_entries`；不向 `web_entries` 增加 `certificate_id` | Web 入口应跟随端点探测到的新证书自动轮换；直接保存证书 ID 会产生双真相和陈旧引用 | 旧 junction 原 ID 迁移；每个 Web 入口最多绑定一个活动端点，一个端点可服务多个入口 |
| ADR-003 | 指纹与工作空间作用域 | 同一工作空间跨环境归并；唯一键为 `(workspace_type, workspace_id, fingerprint_sha256)` | 满足集中资产库，同时阻止跨租户归并和存在性泄漏 | 空/非法指纹不生成资产，只保留未关联端点；告警继续以环境端点为目标 |
| ADR-004 | 服务维护 Payload | 新增轻量 `GET /environments/:id/service-deployments`；Phase 2 将旧 `/maintenance` 改为同一轻量 DTO 的兼容别名 | 当前 10 秒请求包含主机快照、候选和 TLS，职责及体积都错误 | Phase 1 旧 Payload 不变；Phase 2 同批切换客户端并移除重字段 |
| ADR-005 | 监控聚合与时序 | 新增一次性概览 API；单主机继续复用现有 history 路由；服务时序使用服务级聚合 API | 避免重复实现成熟单主机解析，也避免 `DeploymentMonitorDashboard` 对 N 台主机无限并发 | history 响应收紧到最多 480 点；全局首页不得逐主机拉 history |
| ADR-006 | 未跟踪监控组件处置 | **拆分复用，但保持原文件只读且不纳管** | 草稿的三视图 IA/CSS 有参考价值，但 URL、字段、权限和生命周期错误，不能直接成为生产代码 | Phase 3 在新 tracked 文件中重写数据层并摘取布局；未经用户另行授权不得覆盖或删除原未跟踪文件 |
| ADR-007 | 权限 | 全局密钥与证书中心及全部变更操作仅 workspace owner/admin；普通 member 仅能在已授权环境的 Web 入口和监控页面读取裁剪后的状态 | 与现有 SSH 密钥安全边界一致，并消除服务启停、脚本、探测、探针安装权限宽于 UI 文案的问题 | Phase 1 收紧 TLS 探测；Phase 2 收紧服务操作与探针操作；跨版本 member 写请求开始返回 403 |
| ADR-008 | 服务操作可靠性 | 使用持久化 operation run、幂等键和资源锁；危险命令不自动重试 | 防止双击、请求重放、刷新竞态和进程重启后不明状态 | Phase 2 新增 operation 表和 202/polling 合同；旧同步入口保留路径但改为异步语义 |
| ADR-009 | 兼容策略 | 同版本桌面客户端/服务端为支持组合；旧 TLS 路径保留适配，旧重型维护 Payload 不无限保留 | 桌面 App 同包发布，可在 Phase 2 同步切换；无限兼容会永久保留错误边界 | API 仍为 v1；删除旧表、旧 Payload 回退和跨大版本客户端兼容均不在本次范围 |
| ADR-010 | 告警环境过滤 | `GET /monitor-alerts?environmentId=` 必须真实过滤且复用环境授权；无参数才返回当前用户全部可见工作空间 | 当前忽略 query，会让大盘环境筛选显示错误告警 | Phase 3 修复路由和告警导航；无权/跨空间 environmentId 返回 404 |
| ADR-011 | Operations Ribbon 内容 | 继续使用用户配置的现有 Runbook actions；UI 规格中的平滑重启/体检/清缓存是示例，不自动植入脚本 | 系统无法安全猜测每个服务的部署、健康检查和缓存命令，自动 seed 会形成高风险任意操作 | Phase 2 优化展示、批量目标和结果，不新增不可审计的硬编码业务脚本 |

## 4. 数据模型

### 4.1 实体与关系

```text
workspace (type, id)
  ├─ 1:N environments
  │    ├─ 1:N ssl_endpoints ── N:1 ssl_certificates（可空，首次成功探测后建立）
  │    └─ 1:N web_entries ── 1:1 active endpoint link
  └─ 1:N ssl_certificates（同工作空间 SHA-256 唯一）

services ── 1:N service_deployments
service operation run ── 1:N target results（存于受限 result_json）
service operation lock ── 每个 deployment 同时至多一个危险操作
```

`ssl_certificates` 最终字段：

| 字段 | 语义 |
| --- | --- |
| `id` | UUID 主键 |
| `workspace_type`, `workspace_id` | 明确租户边界；`workspace_type` 仅 `personal/organization` |
| `fingerprint_sha256` | 64 位小写十六进制、无冒号；非空 |
| `leaf_cn`, `leaf_sans_json`, `issuer`, `serial`, `signature_algorithm` | 叶证书主体元数据 |
| `not_before`, `not_after` | UTC ISO 时间；解析成功的资产非空 |
| `is_self_signed` | 布尔值 |
| `first_seen_at`, `last_seen_at`, `created_at`, `updated_at` | 资产发现与更新时间 |

唯一键：`(workspace_type, workspace_id, fingerprint_sha256)`。索引：工作空间 + `not_after`，工作空间 + `leaf_cn`。不创建跨工作空间指纹索引，不保存空指纹资产。

`ssl_endpoints` 最终字段：

| 字段 | 语义 |
| --- | --- |
| `id` | 沿用旧 endpoint UUID，便于告警和深链兼容 |
| `environment_id` | FK，环境删除时 `CASCADE` |
| `certificate_id` | nullable FK，证书删除时 `SET NULL`；通常由成功探测维护 |
| `ssh_connection_id` | nullable FK，SSH 删除时 `SET NULL` |
| `ssh_bind_key` | `ssh_connection_id ?? ''` 的稳定唯一键部分；SSH 删除后保留原值，重新绑定时更新 |
| `host`, `port`, `sni` | 规范化探测目标 |
| `source`, `observe_enabled`, `customized`, `sort_order` | 沿用旧行为 |
| `probe_status`, `probe_error`, `probed_at`, `last_success_at` | 最近尝试和最近成功状态 |
| `hostname_match`, `chain_complete` | 端点相关的校验结果 |
| `created_at`, `updated_at` | UTC ISO 时间 |

唯一键：`(environment_id, ssh_bind_key, host, port, sni)`。索引：环境排序、SSH + 最近探测、证书 ID。`probe_status` 仅为 `never/ok/connect_failed/handshake_failed/timeout/probe_unavailable/skipped`。

`ssl_endpoint_web_entries`：`endpoint_id` 和 `web_entry_id` 双 FK、删除均 `CASCADE`；主键 `(endpoint_id, web_entry_id)`，另对 `web_entry_id` 建唯一索引，保证一个入口只有一个活动端点。应用层必须验证端点与入口属于同一环境。

Phase 2 新增：

- `service_operation_runs`：`id`、工作空间、`environment_id`、`idempotency_key`、`request_hash`、`operation_type`、`resource_id`、`requested_by_user_id`、`status`、`progress_json`、`result_json`、`error_code`、`created_at/started_at/completed_at/updated_at`。唯一键为工作空间 + `idempotency_key`。
- `service_operation_locks`：工作空间 + `resource_key` 为主键，关联 `operation_id`，含 `expires_at`。一次 deployment 只能存在一个未过期危险操作。
- operation 状态仅为 `queued/running/succeeded/partial/failed/timed_out/interrupted`。MySQL 由应用校验，SQLite 同时使用 CHECK。

### 4.2 SQLite Schema 约束

- 主键/字符串使用 `TEXT`，布尔使用 `INTEGER NOT NULL DEFAULT 0/1`，JSON 使用带默认值的 `TEXT`。
- `workspace_type`、`probe_status`、operation status 使用 CHECK。
- 使用显式 FK 和上述 `ON DELETE` 规则；迁移完成后必须通过 `PRAGMA foreign_key_check`。
- 创建 `schema_migrations(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)` 记录 `20260827_ssl_asset_v1`；只有校验全部通过才写 marker。
- 表重建或数据回填在事务中完成；任何失败回滚新表数据，旧 `tls_*` 表不变。

### 4.3 MySQL Schema 约束

- ID 使用 `VARCHAR(64)`，指纹使用 `CHAR(64) CHARACTER SET ascii COLLATE ascii_bin`，时间使用 `VARCHAR(32)`，JSON 文本使用 `LONGTEXT`，布尔使用 `TINYINT`。
- 使用 InnoDB、显式命名 FK/索引和与 SQLite 相同的级联语义。
- MySQL DDL 可能隐式提交，因此按“建表 → 幂等回填事务 → 校验 → 写 marker”分段；中断后安全重跑。
- MySQL 缺少的 CHECK 语义必须由同一 Zod/领域校验器实现，测试不得只比较 DDL 文本。
- 所有 upsert、空值、大小写、唯一冲突、级联和事务结果必须与 SQLite 行为一致。

### 4.4 指纹规范

1. 从 `X509Certificate.fingerprint256` 获取 SHA-256，移除 `:`，转为小写；必须匹配 `^[0-9a-f]{64}$`。
2. API 的 `fingerprintSha256` 返回上述 canonical 值；UI 可另行格式化为大写冒号分隔，不得把展示值写回数据库。
3. 空指纹、解析失败或非 SHA-256 指纹只保留 endpoint，`certificate_id = NULL`，不得参与唯一归并。
4. 探测成功时，在一个事务内按当前环境派生工作空间、upsert 资产、更新 endpoint；唯一竞争后重新 SELECT，不能把唯一错误透传为另一个工作空间存在。

### 4.5 旧数据迁移、幂等与回滚

迁移 ID：`20260827_ssl_asset_v1`。

1. 创建新表、索引和 migration marker 表；绝不删除或重命名旧 `tls_endpoints`、`tls_endpoint_web_entries`。
2. 按 `tls_endpoints.environment_id -> environments` 派生工作空间。缺环境、跨环境 junction 或无效 FK 视为校验失败，停止激活并记录具体行 ID，不静默丢弃。
3. 对每个合法非空指纹 upsert `ssl_certificates`；同工作空间同指纹归并，不同工作空间创建不同资产。
4. 以旧 endpoint ID 幂等 upsert `ssl_endpoints`；成功快照填入资产，失败/未探测行保持 `certificate_id = NULL`。旧 `probed_at` 同时作为成功行的 `last_success_at`。
5. 迁移 junction，并验证端点和 Web 入口同环境；重复执行不得增加行数或改变既有 ID。
6. 校验旧/新 endpoint 总数、junction 总数、每个合法指纹映射、唯一键、FK 以及按工作空间的计数；通过后写 marker 并切换新表为运行时真相。
7. 兼容窗口内所有 endpoint CRUD、探测结果和 junction 变更在一个数据库事务中双写新旧表。旧表不承载跨环境证书资产，只保证旧二进制回滚时端点数据不丢失。

回滚不执行破坏性 DDL：回退旧二进制后继续读取旧表即可；新增表和 marker 可保留。若新旧双写任一侧失败，本次写入整体失败。删除旧表、停止双写和迁移旧告警 target 均延期到本重构之外的独立版本化迁移。

### 4.6 生命周期

- **证书轮换**：端点成功探测到新指纹时 upsert 新资产并原子切换 `certificate_id`；旧资产保留，若无端点即成为 orphan。
- **探测失败**：保留上次成功的 `certificate_id` 和资产元数据，仅更新失败状态/时间；API 必须标记 `error + stale`，不能显示为健康。
- **删除端点**：删除 junction，恢复该端点活动告警，再删除 endpoint；共享证书及其它端点不受影响。
- **解绑 Web 入口**：只删除 junction。若 endpoint 来源为 `web_entry`、未自定义且无其它入口，可自动删除 endpoint；证书资产保留为 orphan。
- **删除 Web 入口**：同解绑；不影响真实网络连接，也不删除被其它入口/端点使用的证书。
- **删除证书**：默认有 endpoint 时返回 `409 CERTIFICATE_IN_USE`；只有 manager 明确 `cascade=endpoints` 才同时删除其 endpoint/junction、恢复告警并保留 Web 入口本身。必须展示影响计数并审计。
- **删除 SSH 连接**：endpoint FK 置空，标记 `probe_unavailable`，保留历史证书和 `ssh_bind_key`，等待重新绑定。
- **删除环境**：级联删除该环境 endpoints/junction；共享证书保留，孤立证书不自动清理。
- **孤立证书**：显示 `orphan`/“待关联”；本次重构不做自动定时删除，只允许 manager 明确删除。

## 5. API 合同

### 5.1 通用约定

- 所有路由使用 `/api/v1`、登录认证和当前工作空间；资源 ID 为 UUID。
- 成功列表统一返回 `{ items, pageInfo, summary? }`；`pageInfo` 至少包含 `page/pageSize/total` 或 `nextCursor/hasMore`。
- 错误统一为 `{ error: string, message: string, details?: object }`。跨工作空间、无资源授权和不存在统一 `404`。
- 列表参数、枚举、ID 数组和字符串长度用 Zod 校验；未知字段拒绝或剥离须在同一路由保持一致。
- 所有变更写审计；探测、服务操作和批量操作同时审计开始、完成/失败、目标数、耗时和错误码，不记录私钥、完整脚本或无限制 stdout/stderr。

### 5.2 路由矩阵

| API | 方法 | 权限 | 请求 | 响应 | 限制 |
| --- | --- | --- | --- | --- | --- |
| `/certificates` | GET | workspace manager | `page=1&pageSize<=100&q&status&environmentId&sort` | 证书资产、裁剪后的 endpoints/Web entries、统计 | 默认 50；查询只在当前工作空间 |
| `/certificates/:id` | GET | workspace manager | ID | 单资产详情及全部同空间关联 | 跨空间 404 |
| `/certificates/:id?cascade=endpoints` | DELETE | workspace manager | 默认无 cascade | 204 | 有关联默认 409；cascade 必须显式确认并审计 |
| `/environments/:environmentId/tls-endpoints` | POST | workspace manager + env/SSH 权限 | `{host,port,sni,sshConnectionId,observeEnabled}` | 201 `{ item }` | 每环境最多 50；同身份 409 |
| `/tls-endpoints/:id` | PUT/DELETE | workspace manager + env/SSH 权限 | 完整 endpoint patch / ID | `{item}` / 204 | 删除按生命周期处理 |
| `/tls-endpoints/:id/probe` | POST | workspace manager + env/SSH 权限 | 无 body | `{ item }` | 同 endpoint 60 秒；单 SSH 串行、全局最多 4 |
| `/tls-endpoints/:id/web-entries` | PUT | workspace manager | `{webEntryIds:string[]}` | `{item}` | 最多 100；必须同环境；入口唯一绑定 |
| `/environments/:id/web-entries` | GET | 有环境读取权 | 现有请求 | 每项 `tls` 状态、资产摘要、同环境可见关联 | 不泄漏其它无权环境入口 |
| `/environments/:id/service-deployments` | GET | 有环境读取权 | `cursor&limit<=100` | 轻量 services/deployments/actions/log refs | 不含 hosts、candidates、TLS、history、scriptBody |
| `/service-deployments/:id/actions` | POST | workspace manager + env/SSH 权限 | `Idempotency-Key` + `{action}` | 202 operation | 单资源锁；标准危险操作 120 秒 |
| `/service-deployments/actions` | POST | workspace manager + env/SSH 权限 | key + `{deploymentIds<=50,action}` | 202 operation | 并发 4；逐目标结果 |
| `/service-script-actions/:id/execute` | POST | workspace manager + env/SSH 权限 | key + `{deploymentIds?<=50}` | 202 operation | 并发 4；总运行最长 10 分钟 |
| `/service-operations/:id` | GET | 同空间且仍有环境读取权 | ID | 状态、进度、裁剪结果 | 轮询不快于 1 秒 |
| `/monitoring/overview` | GET | 登录 + 授权环境过滤 | `environmentId?&hostCursor?&hostLimit<=200&serviceLimit<=100` | summary、host cards、service ranking、partialFailures | 仅 DB 快照；不发 SSH；无 history |
| `/environments/:environmentId/monitor-hosts/:connectionId/history` | GET | env + SSH 读取权 | `range=1h/6h/24h/7d/30d` | 现有 host points/gaps/findings | 每序列最多 480 点，含首末边界 |
| `/monitoring/services/:serviceId/timeseries` | GET | 服务环境读取权 | `range` | 服务聚合与 deployment 序列 | 最多 480 点、最多 50 deployment，超限分页/明确截断 |
| `/monitor-alerts` | GET | 登录 + 授权环境过滤 | `environmentId?` + 现有分页/状态参数 | 只含可见工作空间/环境告警 | 提供 environmentId 时必须生效；无权环境 404 |

路径表省略的 `/api/v1` 前缀为固定前缀。

### 5.3 证书 DTO

证书 item 至少包含：`id`、canonical `fingerprintSha256`、`leafCn`、`leafSans`、`issuer`、`serial`、`notBefore/notAfter`、派生 `status/daysRemaining`、`orphan`、`endpointCount/webEntryCount`、`endpoints[]`、`webEntries[]`、`firstSeenAt/lastSeenAt`。endpoint 项必须分别给出 `probeStatus/probeError/probedAt/lastSuccessAt/stale/hostnameMatch/chainComplete`。

Web 入口的 `tls` 为 `null`（HTTP）或包含：`endpointId`、`certificateId|null`、`fingerprintSha256|null`、`status`（`unconfigured/probing/valid/expiring/expired/mismatch/error`）、`daysRemaining|null`、`probedAt`、`stale`、`probeError`。缺失、离线或陈旧数据不得用 0/绿色替代。

### 5.4 服务维护轻量 Payload

`GET /service-deployments` 只返回：

- `canConfigure/canOperate`（本合同下两者均只对 manager 为 true）；
- service 的 ID、名称、描述、启用状态、排序、轻量 action 元数据和 log IDs；
- deployment 的 ID、provider、结构化 target、显示名、SSH 连接 ID/名称、当前状态、最近一次轻量指标、lastCheckedAt、capabilities；
- discovery summary 只含每主机候选计数，不含候选详情；打开抽屉时再调用现有 discovery/refresh API；
- `generatedAt/nextCursor/partialFailures`。

禁止字段：主机完整 snapshot、历史点、Top processes、全部 candidates、Kubernetes config 原文、TLS endpoint、完整 scriptBody 和无限制日志路径/输出。单响应最多 100 个 service、500 个 deployment、1 MiB；超过必须分页或返回明确 `truncated`，不能静默丢项。

Phase 2 中旧 `GET /environments/:id/maintenance` 调用同一 mapper 返回轻量 DTO，并带 `Deprecation`/文档说明；不再提供重字段。桌面客户端必须与服务端同批切换。

### 5.5 服务操作并发、幂等与恢复

1. 所有危险 POST 必须提供 16–128 字符 `Idempotency-Key`；服务端保存规范请求 SHA-256。
2. 同工作空间同 key + 同 request hash 返回既有 operation；同 key + 不同 body 返回 `409 IDEMPOTENCY_KEY_REUSED`。
3. 取得 deployment 资源锁后才入队；未过期锁返回 `409 OPERATION_IN_PROGRESS` 和既有 operation ID。锁 TTL 必须大于命令超时，完成后释放。
4. 单目标命令超时 120 秒；batch 最多 50 目标、并发 4、总时限 10 分钟。状态变更命令失败不得自动重试。
5. batch 逐目标返回 `ok/exitCode/durationMs/errorCode/message/truncated`，整体为 `succeeded/partial/failed`；部分成功不能用单一 500 丢失成功结果。
6. stdout/stderr 每目标各最多 8 KiB、operation 总结果最多 256 KiB；截断必须显式标记。
7. 进程启动时发现 `queued/running` operation，统一标记 `interrupted`、错误 `INTERRUPTED_BY_RESTART` 并释放锁；不得猜测远端命令是否完成或自动重放。
8. `service_operation_runs` 至少保留 7 天；审计事件遵守平台审计保留期。
9. Provider capability：systemd/docker/podman/supervisor 可声明 start/stop/restart；Kubernetes 仅对结构化且校验通过的 controller 暴露 restart；裸进程不提供通用 start/restart/kill，需使用显式 Runbook。UI 必须按 `capabilities` 展示禁用原因。
10. Operations Ribbon 只展示 manager 已配置的现有 Runbook；不得因名称相似自动生成或执行“平滑重启/体检/清缓存”脚本。

## 6. 客户端组件边界

### 6.1 密钥与证书

- 路由继续使用 `/ssh-keys`，以 `SecurityCredentialsView`（可由现 `SshKeysView.vue` 演进）只负责 Tab、URL 和页面级权限。
- SSH 密钥 CRUD 保持独立 panel/composable；证书使用 `CertificateCenter`、`CertificateCard/List`、`CertificateEndpointList` 和 `use-certificates-api`。
- 证书中心与 Web 入口必须共用 `src/shared/tls-certificates.ts` DTO/状态派生函数；不得在 Vue 文件再造冲突类型。
- Web 入口 `TlsStatusBadge/TlsPopover` 只刷新当前 endpoint，并通过缓存失效/事件更新关联入口；不得启动另一套全局轮询。

### 6.2 服务维护

- `ServiceMaintenancePanel.vue` 变为编排容器；拆出 service selector、operations ribbon、deployment grid/card、batch progress 和 discovery drawer。
- 数据 composable 只消费轻量 DTO；TLS、`HostMonitorDashboard`、`DeploymentMonitorDashboard` 及其 history 请求必须移出。
- discovery drawer 懒加载候选；operation store 按 operation ID 管理轮询、取消 UI 订阅和部分失败重试。
- 拆分测试优先行为/DTO 测试；现有源码字符串断言只保留确有安全价值的部分，不得成为唯一证明。

### 6.3 监控大盘

- 新建 tracked `MonitoringView.vue` 及 Host Fleet、Service APM、NOC 子组件；未跟踪草稿只作只读视觉参考。
- 首屏只请求 overview；选中主机后才加载单主机 history。服务历史由服务级 API 一次聚合，禁止每次渲染 `Promise.all(allHosts)`。
- 复用 `MonitorTimeSeriesChart`、`buildMonitorDiagnostics`、history load plan；`HostMonitorDashboard` 可拆出展示层，不能复制解析逻辑。
- 页面级 controller 统一持有 scope、range、refresh、lastUpdated、AbortController 和 timer。切换 scope/range 取消旧请求；同类请求最多一个 in-flight。
- NOC 使用 Fullscreen API，监听 `fullscreenchange`/`visibilitychange`/`keydown`；退出、卸载或隐藏时清理 timer/listener/request。`prefers-reduced-motion` 关闭滚动/脉冲动画。

## 7. 权限与安全

### 7.1 权限矩阵

| 能力 | Owner/Admin | Member |
| --- | --- | --- |
| 全局 SSH 密钥与证书中心 | 读写 | 不进入；在已授权 Web 入口查看裁剪 TLS 状态 |
| 证书/端点 CRUD、绑定、手动/批量探测 | 允许且需 env/SSH 权限 | 403 |
| 监控概览、时序、告警读取 | 允许 | 仅授权环境/连接 |
| 告警设置、探针安装/升级/清理 | 允许且需 env/SSH 权限 | 403 |
| 服务配置、启停、批量操作、Runbook 执行 | 允许且需 env/SSH 权限 | 403 |
| SSH/日志下钻 | 按现有资源授权 | 按现有资源授权 |

所有资源先限定当前工作空间，再检查环境和 SSH 权限；跨空间 ID 统一 404。UI 置灰不是安全边界，服务端每条路由必须独立校验。

### 7.2 TLS 探测与 SSRF/注入

- 仅支持远端 SSH 上的原始 TLS 握手，不接受 URL、scheme、path、userinfo、重定向、HTTP 或任意 shell 命令。
- host 仅允许规范 DNS、IPv4 或 IPv6 literal；port 为 1–65535；SNI 仅 DNS 名。拒绝控制符、空白、shell 元字符、zone ID、未规范化括号和超长标签。
- 拒绝 literal link-local/multicast/unspecified 地址、`169.254.169.254`、`100.100.100.200` 及已知 metadata hostname。私网和 loopback 因内部 TLS 运维场景允许，但仅 manager、仅经当前环境已授权 SSH 连接，并完整审计。
- DNS 在远端解析，无法无损阻断所有 DNS rebinding；残余风险由“manager 本就拥有该 SSH 的服务操作能力”、无 HTTP 语义、速率限制和审计共同约束。实现不得声称这是应用主机出网探测。
- 所有参数仍必须通过 `quotePosixShellArg`；命令模板固定为 `openssl s_client`。超时 10 秒、输出最多 64 KiB、end stdin；错误输出对用户最多 500 字符。
- 每环境最多 50 endpoint、每 endpoint 手动探测间隔 60 秒、同 SSH 内串行、全局并发最多 4；批量 UI 不得绕过限制。

### 7.3 服务操作

- Provider target 必须使用结构化白名单解析并再次 shell quoting；禁止把 UI 文本直接拼接为命令。
- 脚本正文只从 manager 创建的 server-side Runbook 读取，通过 stdin 执行；API 不接受临时任意脚本正文。
- 审计保存 action、目标、actor、结果、耗时和受限错误摘要；不保存密钥、凭据或完整输出。
- 破坏性操作客户端需确认影响范围；服务端仍以权限、幂等和资源锁为准。

## 8. 性能合同

| 项目 | 合同 |
| --- | --- |
| 证书列表 | 默认 50、最大 100/页；过滤/排序在 DB；禁止逐卡 N+1 查询 |
| TLS 探测 | 10 秒/64 KiB；全局并发 4；每 SSH 串行；每环境 50 endpoint |
| 服务维护 | 首屏单请求；最大 1 MiB、100 services、500 deployments；10 秒静默刷新改为不快于 15 秒且页面隐藏暂停 |
| Overview | 只读 DB 快照，不执行 SSH；host 最大 200、service 最大 100；同 scope 5 秒服务端短缓存可选，必须含 generatedAt |
| 时序范围 | 仅 1h/6h/24h/7d/30d；不接受任意无界时间 |
| 时序点数 | 每序列严格 `<= 480`，保留首末点和 gap；按时间桶/稳定算法降采样，不以无界原始 JSON 返回 |
| 进程/服务 | 每点 Top 5 进程；服务时序单请求最多 50 deployments，超限分页或标记 truncated |
| 客户端并发 | history 最多 4 个，但正常首屏为 0、选中主机为 1；禁止全 host `Promise.all` |
| 刷新 | overview 最快 15 秒；时序最快 30 秒；scope/range 切换取消旧请求；无重叠 interval |
| 生命周期 | hidden 页面暂停；卸载/退出 NOC 清理 timer、listener、AbortController；过期响应不得覆盖新 scope |
| 陈旧 | 超过 2 个预期采集周期标 `stale`；缺失/错误不得按 0% 健康参与聚合 |

SQLite 和 MySQL 必须使用等价过滤、排序和边界包含语义。实现应在真实规模 fixture（200 hosts、500 deployments、30d samples）上验证响应限制，而非只断言常量存在。

## 9. 错误与兼容策略

标准错误码至少包括：

- `INVALID_*` 400：请求/host/port/SNI/range/分页无效；
- `*_NOT_FOUND` 404：不存在、跨空间或无资源读取权；
- `WORKSPACE_ADMIN_REQUIRED` 403：member 发起变更；
- `CERTIFICATE_IN_USE`、`TLS_ENDPOINT_EXISTS`、`TLS_PROBE_IN_PROGRESS`、`OPERATION_IN_PROGRESS`、`IDEMPOTENCY_KEY_REUSED` 409；
- `TLS_PROBE_RATE_LIMIT` 429；
- `TLS_PROBE_TIMEOUT` / operation timeout 504；SSH/远端命令失败 502，且返回可辨识业务错误码；
- 列表超限优先分页；无法安全分页的批量请求返回 413，不得截断请求后继续执行。

兼容窗口：

1. Phase 1 旧 `/tls-endpoints*` 路径和 DTO 字段继续存在，由新模型适配并双写旧表。
2. Phase 1 的 `/maintenance` 仍返回旧 TLS/hosts 字段，避免提前破坏 Phase 2；Phase 2 同批切换客户端后改为轻量 DTO。
3. `web-entries[].tls` 保留旧字段并只新增字段；HTTP 入口仍为 `null`。
4. 告警 target 继续使用 endpoint ID，因迁移保留 ID，无需把告警改为跨环境 certificate target。
5. 局部探测/主机失败以 200 中的 item state 或 batch target result 表达；只有整个请求无法执行才用 4xx/5xx。
6. 数据陈旧时保留最后成功值并显式标记时间和 stale，绝不回落为绿色 0 值。

## 10. 测试合同

| 层级 | 必测内容 | 通过条件 |
| --- | --- | --- |
| 纯函数/单元 | 指纹规范、hostname、host/SNI/metadata 拒绝、状态/陈旧/倒计时、降采样、capability、idempotency hash | 边界和恶意输入均覆盖；不依赖源码字符串 |
| SQLite 迁移 | 空库、旧库、失败行、重复执行、重复指纹、轮换、junction、回滚双写、FK | 两次迁移数据一致，旧表保留，`foreign_key_check` 为空 |
| MySQL 集成 | 与 SQLite 相同的真实 schema/CRUD/级联/唯一/事务/迁移 fixture | 独立 CI MySQL/MariaDB job 必须通过；现有工作台 `mysql.integration` skip 不能代替 |
| 路由/API | manager/member、跨空间同指纹、404 隐匿、分页、删除/解绑、探测限流/并发/超时、轻量 Payload | 响应与本合同完全一致；无跨环境关联泄漏 |
| 服务操作 | 同 key 重放、key 冲突、并发锁、timeout、partial、重启 interrupted、输出截断、审计 | 不重复执行；每个目标结果可辨识且锁最终释放 |
| 监控 | 200 hosts/500 deployments、480 点上限、首末/gap、stale/offline、service 聚合、无 N+1 | SQLite/MySQL 等价；请求数和并发上限有行为测试 |
| 客户端组件 | badge/popover、只读权限、空/错/局部失败、operation polling、scope 竞态、Abort、timer/fullscreen/reduced-motion | 以渲染/交互测试为主，卸载后无继续请求 |
| 用户流 | 多入口同证书、轮换、服务批量部分失败、监控下钻、NOC 进退全屏 | Given/When/Then 全部通过 |
| 桌面启动/打包 | 每个含代码 Phase 的 `package:current-os`；Gate 4 完整启动冒烟 | 安装包生成，桌面核心路径可启动 |

Gate 2 不得在没有真实 MySQL 应用 schema 证据时以“本地未配置所以 skip”通过。Gate 4 的 Electron 并行安装竞态必须通过预安装/串行 bootstrap 消除，不接受偶发重跑作为发布通过依据。

## 11. 阶段文件边界

### Phase 1 允许修改

- Schema/migration：`src/server/database.ts`、`sqlite-schema.ts`、`mysql-schema.ts` 及专用 migration helper。
- TLS/API：`tls-certificates.ts`、`routes/service-maintenance.ts` 中 TLS 兼容路由、`routes/web-entries.ts`、新 certificates route、shared TLS DTO。
- 客户端：`SshKeysView.vue`/新凭据中心子组件、`EnvironmentDetailView.vue` TLS badge/popover、router/AppShell/i18n/MCP 标题。
- 测试：证书迁移、双库、隔离、安全、路由和 UI 行为测试。
- 禁止移除服务维护证书/监控区，禁止接入监控草稿，禁止实现 Phase 2/3。

### Phase 2 允许修改

- `ServiceMaintenancePanel.vue`、`service-maintenance/*`、`ServiceDiscoveryPanel.vue` 及轻量 route/operation helper/schema。
- 移除维护页 TLS 与 Host/Deployment history 挂载；切换轻量 Payload；实现 operation run/lock 和 provider capabilities。
- 更新相应行为测试、源码断言和深链。
- 禁止创建全局监控路由/大盘，禁止删除 Host/Deployment/TimeSeries 复用资产，禁止停止 TLS 旧表双写。

### Phase 3 允许修改

- 新 tracked Monitoring view/子组件、router/AppShell/i18n、overview/service timeseries route、现有 monitor 组件的可复用拆分。
- 修复 history 点数、并发、Abort、timer、NOC lifecycle、alert navigation 和 Gemini 验收问题。
- 未跟踪 `EnvironmentMonitoringDashboard.vue` 仅可读取；不得修改、git add 或删除。
- 禁止重做证书模型、服务 operation 或探针安装引擎。

### 全阶段禁止范围

- `main` 分支、private/、`.env`、密钥、本地数据和 release 生成物。
- 未经 ADR 修改已冻结 Schema/API/权限；未经用户批准扩大到自动续签/部署证书、通用 APM tracing 或任意进程控制。
- 为通过测试而只改源码字符串断言、吞掉错误、把缺失数据显示为 0/健康、取消工作空间过滤或提高无界限制。

## 12. 非目标

- 不存储、签发、自动续期或部署私钥/证书；只观察远端叶证书元数据。
- 不实现 OCSP/CRL、CT 日志、完整信任链 PKI 管理或公网扫描器。
- 不支持跨工作空间共享证书资产，也不把 organization 内不同 workspace 合并。
- 不实现 OpenTelemetry tracing、日志索引引擎、通用 APM agent 或预测型 AI 根因分析。
- 不提供裸进程的通用 kill/restart，也不对不结构化 Kubernetes target 拼接命令。
- 不在本项目删除旧 TLS 表或停止双写；该清理需独立版本化迁移。
- 不直接纳管、覆盖或删除未跟踪监控草稿。

## 13. 冻结检查

- [x] 审计 A-001～A-014 均已决定或明确阶段/延期策略。
- [x] UI/UX 后端依赖都有合同或明确降级边界。
- [x] SQLite/MySQL 迁移、回滚、双写和幂等可验证。
- [x] API 路径、请求、响应、分页、权限、限制和错误行为完整。
- [x] TLS SSRF/注入、工作空间隔离与服务操作安全已评估。
- [x] 服务维护 Payload、监控点数/刷新/并发和组件边界明确。
- [x] 每阶段允许/禁止范围明确。
- [x] 用户已批准 UI/UX 2.0.0-final；无重大范围例外。
- [x] 未跟踪监控组件处置已冻结为“只读参考、拆分复用、不纳管”。
- [x] 文档状态为 `FROZEN`。
