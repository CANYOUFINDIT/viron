# 重构验收矩阵

> Gate 1 已由 Codex 根据 `TECH-CONTRACT.md` 补充并冻结。必选项不得在无用户批准和新 ADR 的情况下删除或降级。

## 1. 通用完成定义

每个实现阶段必须满足：

- [ ] 只修改技术合同允许的范围；任何例外均有用户批准和 ADR。
- [ ] UI/UX 行为符合已批准的 `UIUX-SPEC.md` 2.0.0-final。
- [ ] 没有未说明的 Schema、API、权限、错误码或性能限制变化。
- [ ] 新逻辑包含行为测试，不只依赖源码字符串断言。
- [ ] SQLite 与 MySQL 的真实应用 schema/迁移/CRUD 语义均有证据；skip 不算通过。
- [ ] 工作空间隔离、manager/member 和跨空间 404 隐匿测试通过。
- [ ] `npm run typecheck` 通过。
- [ ] 相关定向测试通过。
- [ ] `npm test` 通过，或仅有技术合同明确允许且不影响本阶段的已知非发布问题。
- [ ] `npm run build` 通过。
- [ ] 需要时完成桌面用户流和启动验证。
- [ ] 没有敏感信息、私有数据、`.env`、本地数据和生成的 `release/` 进入提交。
- [ ] 改动已提交到 `dev` 并推送 `origin/dev`，未操作 `main`。
- [ ] 本阶段包含代码修改时，`npm run package:current-os` 成功；纯文档性阶段标记为“不适用”。
- [ ] `STATUS.md` 已记录输入/输出 commit、测试、打包、风险、结论和交接。

## 2. Phase 0 验收

### 现状审计

- [x] 原始方案的每项需求都有实现状态和代码证据。
- [x] 未跟踪监控组件的归属、完成度和处置建议明确。
- [x] SQLite/MySQL、TLS、监控、服务维护和测试现状完整。
- [x] 开放问题均有决策人和阻断阶段。
- [x] Codex 已在 Gate 1 复核审计可作为合同输入。

### UI/UX

- [x] 全局 IA 和跨模块路径完整。
- [x] 三个核心模块都有详细设计。
- [x] 加载、空态、错误、权限、离线、陈旧和部分成功状态完整。
- [x] 桌面宽屏、窄窗口和 NOC 全屏规则完整。
- [x] 每个依赖后端的交互都有数据要求或降级方案。
- [x] 用户已于 2026-08-27 11:24 CST 批准 2.0.0-final，且无例外。

## 3. Gate 1 技术合同验收

- [x] 证书资产与端点模型已明确为 `ssl_certificates + ssl_endpoints`。
- [x] 旧 TLS 数据迁移、兼容双写、回滚和幂等策略明确。
- [x] 指纹格式、唯一键、空指纹行为和工作空间边界明确。
- [x] 证书、端点、Web 入口、SSH、环境和工作空间关系明确。
- [x] 删除、解绑、轮换、探测失败、SSH/环境删除和孤立资产生命周期明确。
- [x] API 请求、响应、分页、权限、限制、审计和错误码明确。
- [x] 服务维护轻量 Payload 及禁带字段明确。
- [x] 服务操作 manager 权限、幂等、锁、超时、部分成功和重启恢复明确。
- [x] 监控 overview、服务时序、单机 history 复用、降采样、点数和刷新限制明确。
- [x] 客户端组件拆分、共享类型、请求取消和 NOC 生命周期边界明确。
- [x] TLS 探测的 host/port/protocol、SSRF、命令注入、限流和残余风险明确。
- [x] SQLite/MySQL 等价语义和真实 MySQL CI 通过条件明确。
- [x] 未跟踪监控组件处置明确为只读参考、拆分复用、不纳管/覆盖/删除。
- [x] 每阶段允许修改和禁止修改范围明确。
- [x] 非目标和兼容窗口明确。
- [x] `TECH-CONTRACT.md` 状态为 `FROZEN`。

## 4. Phase 1 凭据与证书验收

### 数据与迁移

- [x] 新表、索引、FK 和 migration marker 在 SQLite/MySQL 均正确创建。
- [x] 旧 endpoint/junction ID 和数据完整迁移，旧表保留且兼容双写。
- [x] 迁移重复执行不增加行、不改变 ID；失败时不激活、不静默丢数据。
- [x] SQLite `foreign_key_check` 为空；MySQL 约束、事务和级联与 SQLite 等价。
- [x] 相同 canonical SHA-256 指纹在同一工作空间跨环境正确归并。
- [x] 空/非法指纹不创建 certificate；证书轮换原子切换且保留旧 orphan。
- [x] 不同工作空间不会归并、冲突或泄漏资产存在性。

### API 与生命周期

- [x] 证书列表/详情支持分页、搜索、状态/环境过滤和排序，且无逐卡 N+1。
- [x] 多 Web 入口、多 endpoint 与证书关系正确；一个入口最多一个活动 endpoint。
- [x] 删除证书默认保护共享引用；显式 cascade 的影响、告警恢复和审计正确。
- [x] 删除/解绑 Web 入口、endpoint、SSH、环境不会误删共享证书或真实 Web 入口。
- [x] 探测失败保留上次成功资产并标记 error/stale，不显示为健康。
- [x] 旧 `/tls-endpoints*` 路径和 `web-entries[].tls` 兼容字段仍工作。
- [x] Phase 1 的旧 `/maintenance` Payload 尚未提前删除 TLS/hosts 字段。

### 安全与界面

- [x] 全局入口显示「密钥与证书」，SSH 密钥原能力无回归。
- [x] SSL/TLS 统计、筛选、列表/卡片、详情、endpoint 和 Web 入口关联可用。
- [x] Web 入口显示正常、即将到期、过期、异常、未探测、探测中和陈旧状态。
- [x] Popover 支持就地探测与跳转/定位凭据中心，关联入口同步更新。
- [x] 全局中心和所有变更/探测仅 manager；member 仅见授权环境的裁剪状态。
- [x] TLS host/port/SNI、metadata、注入、超时、输出、冷却、每环境上限和并发测试通过。
- [x] 工作空间唯一约束和错误不会泄漏另一空间同指纹资产。
- [x] 旧 `EnvironmentMonitoringDashboard.vue` 保持未修改、未纳管、未接路由。

## 5. Gate 2 Phase 1 审查

- [x] 只审查 `STATUS.md` 记录的 Phase 1 输入/输出 commit diff。
- [x] 所有 Phase 1 验收项均有行为证据，真实 MySQL job 已通过。
- [x] 没有 P0/P1/P2 未关闭问题。
- [x] Gate 2 明确结论为 `PASSED`，并记录 commit/测试/打包/交接。

## 6. Phase 2 服务维护验收

### Payload 与界面

- [x] 服务维护不再包含证书管理 UI、TLS DTO 或 Host/Deployment 历史大盘。
- [x] `GET /service-deployments` 和兼容 `/maintenance` 只返回合同允许的轻量字段。
- [ ] 单响应不超过 1 MiB、100 services、500 deployments；分页/截断明确。
- [x] 服务选择、Operations Ribbon、节点矩阵、日志/SSH 下钻和 discovery drawer 可用。
- [x] Operations Ribbon 只使用 manager 配置的既有 Runbook，不自动植入或猜测业务脚本。
- [x] discovery 候选仅在抽屉打开时懒加载，现有服务发现和纳管无回归。
- [x] Docker、Systemd、Podman、Supervisor、Kubernetes 和裸进程状态/capability 正确。
- [x] 不支持的 K8s/裸进程操作明确禁用并说明原因，不拼接不结构化命令。

### 权限、并发与失败

- [x] 启停、批量操作、脚本执行、探针安装/升级/清理均仅 manager 且校验 env/SSH。
- [x] 危险操作有影响范围确认，服务端仍执行独立权限校验。
- [x] 缺失/重复/冲突的 `Idempotency-Key` 行为符合合同，不重复执行。
- [ ] 同 deployment 资源锁阻止竞态，成功/失败/timeout 后锁均安全释放。
- [ ] 单目标 120 秒、batch 50/并发 4/总计 10 分钟限制生效。
- [ ] batch 返回逐目标成功/失败和可重试边界，部分成功不丢结果。
- [x] 进程重启将 queued/running 标为 `interrupted`，不自动重放危险命令。
- [ ] 输出截断、operation retention、开始/完成/失败审计符合合同。
- [x] 页面刷新/切换不重复提交，过期响应不覆盖新状态。

## 7. 合并 Gate 3+4 的 Phase 2 审查项

- [x] 按 `STATUS.md` 记录的独立 Phase 2 commit 边界审查对应 diff（用户指示 Codex 不可用，由 Grok 代行）。
- [ ] 所有 Phase 2 验收项均有行为证据。
- [ ] 维护 Payload、服务操作安全、幂等和故障恢复没有未关闭 P0/P1/P2。
- [ ] Phase 2 审查结果已记录进合并 Gate 3+4，不因 Phase 3 已完成而降低标准。

## 8. Phase 3 监控大盘验收

### 数据与性能

- [x] 全局导航和 `/monitoring` 按权限访问；member 只看到授权环境/SSH。
- [ ] overview 单请求提供准确 summary、主机矩阵、服务排名和 partial failures，不触发 SSH。
- [x] 首屏不逐主机请求 history；选中主机才加载一条 history。
- [ ] 服务 APM 通过服务级 API 正确聚合，不使用无界 `Promise.all(allHosts)`。
- [ ] 1h/6h/24h/7d/30d 每序列严格不超过 480 点，并保留首末/gap。
- [x] Top processes 每点最多 5，服务时序 deployment 上限/截断明确。
- [ ] 200 hosts、500 deployments、30d fixture 下请求数、体积、延迟和并发限制通过。
- [ ] SQLite/MySQL 聚合、排序、边界和陈旧语义一致。

### 状态与生命周期

- [x] 主机基础设施视图展示关键指标、探针状态、Findings 与 Top 5 进程时序。
- [x] 服务性能视图提供资源排行、高负载节点和服务健康矩阵。
- [ ] 离线、陈旧、缺失和局部失败绝不显示为绿色/0% 健康。
- [x] 自动刷新支持 15/30/60 秒与暂停，最后更新时间正确，无重叠请求。
- [ ] scope/range 切换取消旧请求；过期响应不覆盖新 scope。
- [x] 页面隐藏/卸载清理 timer、listener 和未完成请求。
- [x] NOC 使用 Fullscreen API，可按钮/Esc 退出并适配目标分辨率。
- [x] 退出全屏/卸载完整释放资源，`prefers-reduced-motion` 生效。
- [x] 监控告警导航已指向新大盘并保留环境/目标上下文。
- [x] `GET /monitor-alerts?environmentId=` 真实过滤并执行环境授权；跨空间/无权环境不泄漏告警。
- [x] 新实现位于 tracked 文件；原未跟踪草稿未修改、未提交、未删除。
- [x] Gemini 的 P0/P1/P2 实现验收问题全部关闭。

## 9. 合并 Gate 3+4 最终发布验收

- [ ] 原始方案中所有范围均为已实现或经用户批准延期。
- [x] Gate 2 及 Phase 2+3 整体 UI/UX 验收均为 `PASSED`。
- [ ] 合并 Gate 中 Phase 2 与 Phase 3 审查项均无未关闭 P0/P1/P2。
- [x] `npm run verify:full-regression` 通过。
- [x] Electron bootstrap/安装竞态已消除，发布不依赖偶发重跑。
- [x] `npm run package:current-os` 通过。
- [ ] 桌面 App 能启动并完成凭据中心、Web TLS、服务维护、监控/NOC 核心冒烟。
- [x] Git 工作区没有意外文件；已知未跟踪草稿的最终保留/处置由用户确认并记录。
- [x] 所有提交均位于 `dev` 并已推送 `origin/dev`。
- [x] 未提交 private/、密钥、`.env`、本地数据或生成的 release 产物。
- [x] 未合并或推送 `main`。
- [x] 已知限制、旧 TLS 双写窗口和延期清理项已记录。
- [ ] 合并 Gate 3+4 明确结论为 `PASSED`。

## 10. 延期与例外

用户已于 2026-08-27 15:22 CST 批准执行顺序例外：Grok 连续完成 Phase 2+3，Gemini 整体验收，Grok 集中修复，Codex 合并执行 Gate 3+4。该例外只合并交接和审查时点，不豁免本文件任何 Phase 2、Phase 3 或最终发布验收条目。

任何未通过但希望延期的条目必须在 Gate 前记录并取得用户批准：

| 编号 | 条目 | 原因 | 风险 | 批准人 | 后续任务 |
| --- | --- | --- | --- | --- | --- |
| `UX-P3-001` | NOC 网络吞吐与磁盘水位排行 | Gemini 验收记为体验优化，不阻塞本轮 | 低 | Gemini 复验 | 后续版本 |
| `G34-P2-001` | 批量操作 10 分钟总限触发时，已完成目标结果可能未写入 `result_json`，且其他 worker 会在锁释放后继续运行 | Grok 代行 Gate 时登记；Codex 独立复核判定为 P1 并阻断本轮 | 高 | —（未获该具体延期的用户批准） | 本轮修复超时、取消、锁和部分结果语义 |
| `G34-P2-002` | 监控 overview/timeseries 的 MariaDB 规模对账 | Grok 代行 Gate 时登记；冻结合同要求 SQLite/MySQL 等价行为证据 | 中 | —（未获该具体延期的用户批准） | 本轮新增独立监控 MySQL job 并与 SQLite 对账 |
| `TLS-DUAL-WRITE` | 旧 `tls_*` 表双写与删除 | 冻结合同明确不在本项目删除 | 中 | Gate 1 | 独立版本化迁移 |

2026-08-27 Codex 独立复核说明：用户对“由 Grok 代行 Gate 3+4”的授权不是对 `G34-P2-001`、`G34-P2-002` 两个具体 P1/P2 的延期批准；这两项恢复为本轮阻断工单。`UX-P3-001` 仍为 P3，`TLS-DUAL-WRITE` 仍按冻结合同延期，二者不阻断本轮。

2026-08-27 Codex 对 `04ad5aa` 的第二次独立复核说明：`npm run verify:full-regression` 与 `npm run package:current-os` 均通过，但定向边界复现及真实 MariaDB 套件仍发现未关闭 P1/P2。故 §6 的 Payload/锁/timeout/部分结果/审计、§7 的 Phase 2 行为证据、§8 的严格 480 点/规模/双库/请求生命周期、§9 的无未关闭问题和最终 `PASSED` 继续保持未勾选；精确工单见 `STATUS.md` 的 `G34RR-*`。`UX-P3-001` 与 `TLS-DUAL-WRITE` 的既有延期判断不变。
