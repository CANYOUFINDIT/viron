# Grok 现状审计与主力实现 Agent 执行任务书

## 1. 你的角色

你是本次重构的主力工程实现者，负责现状审计、主要前后端代码、数据库迁移、自动化测试和普通问题修复。默认必须按垂直业务阶段交付可运行成果；当前 `STATUS.md` 记录的用户批准例外允许你在一次连续批次中依次完成 Phase 2 和 Phase 3，但不得扩展到这两个阶段之外。

你无权自行改变已经由用户批准的 UI/UX 规格或 Codex 冻结的技术合同。出现冲突时停止实现，在 `STATUS.md` 记录阻塞，等待用户或 Codex 决策。

## 2. 开始前必须阅读

1. 仓库根目录 `AGENTS.md`。
2. `docs/SERVICE-MAINTENANCE-AND-MONITORING-REFACTOR.md`。
3. `docs/refactor-execution/README.md`。
4. `docs/refactor-execution/STATUS.md`。
5. 当前阶段需要的 `CURRENT-STATE-AUDIT.md`、`UIUX-SPEC.md`、`TECH-CONTRACT.md` 和 `ACCEPTANCE.md`。

开始写入前必须：

- 确认分支为 `dev`。
- 检查 `git status --short`。
- 确认 `STATUS.md` 写锁为 `UNLOCKED`。
- 工作区干净时执行 `git pull --ff-only origin dev`。
- 取得写锁并声明预计修改范围。

不得覆盖或清理不属于你的现有改动。

## 3. Phase 0A：只读现状审计

当前首先执行本阶段。除审计文档和状态文件外，不修改生产代码。

### 已知线索

- `src/client/components/ServiceMaintenancePanel.vue` 约 1894 行，仍包含服务、主机与证书 UI。
- `src/client/components/HostMonitorDashboard.vue` 约 900 行。
- `src/client/components/DeploymentMonitorDashboard.vue` 约 346 行。
- `src/client/views/SshKeysView.vue` 约 299 行。
- `src/server/routes/service-maintenance.ts` 约 1226 行。
- `src/server/tls-certificates.ts` 约 616 行。
- SQLite/MySQL 已存在 `tls_endpoints` 和 `tls_endpoint_web_entries`。
- `src/server/routes/web-entries.ts` 已包含 TLS 关联逻辑。
- 已有 TLS、服务维护、监控历史、监控告警和探针相关测试。
- 工作区有未跟踪的 `src/client/components/EnvironmentMonitoringDashboard.vue`，约 865 行。

### 审计要求

完整填写 `CURRENT-STATE-AUDIT.md`：

1. 当前提交、分支和工作区状态。
2. 未跟踪监控组件的来源线索、完成度、依赖、是否可编译及建议处置。
3. 原始方案每项需求的 `已完成 / 部分完成 / 未完成 / 与现状冲突` 矩阵。
4. 可复用的组件、composable、API、Schema 和测试。
5. 现有 `tls_endpoints` 与目标证书资产模型的差异和迁移风险。
6. SQLite/MySQL 一致性风险。
7. 监控数据获取、降采样、刷新、告警和探针生命周期。
8. 服务启停、脚本、SSH、日志操作的权限与安全边界。
9. 当前测试基线和缺口。
10. 建议的 Phase 1～3 文件范围，但不作最终架构决定。

审计允许执行只读命令、类型检查和测试；不得为了“让测试通过”修改生产代码。

Phase 0A 只修改审计与状态文档，因此完成后不执行 `npm run package:current-os`。

## 4. Gate 1 之前的禁止事项

在 `TECH-CONTRACT.md` 标记为 `FROZEN` 之前，禁止：

- 新建或迁移证书数据表。
- 改变 API 路径或响应结构。
- 从服务维护删除现有功能。
- 把未跟踪监控组件接入路由。
- 批量重写组件或样式。
- 推测并实现 Gemini 尚未定义的交互。

## 5. Phase 1：密钥与证书中心及 Web 入口联动

仅在 Gate 1 通过后执行。

### 实现范围

- 按技术合同完成 SQLite 和 MySQL Schema/迁移。
- 实现工作空间级证书资产、探测端点和 Web 入口关系。
- 基于规范化 SHA-256 指纹去重，作用域不得跨工作空间。
- 升级 SSH 密钥页面为「密钥与证书」。
- 实现证书统计、列表/卡片、筛选、详情和运维动作。
- 为 Web 入口实现证书徽标、详情 Popover 和重新探测。
- 保持旧 TLS 数据可迁移、可读取或按合同兼容。

### 强制测试

- SQLite 与 MySQL Schema 对齐。
- 旧数据升级和重复执行迁移的幂等性。
- 相同指纹多入口归并、不同工作空间不归并。
- 权限和工作空间隔离。
- 探测失败、超时、主机名/SNI、证书链异常。
- SSRF、命令注入和非法 host/port 输入边界。
- 删除、解绑和共享证书的数据完整性。
- Web 入口 HTTP/HTTPS、未探测和数据陈旧状态。

## 6. Phase 2：服务维护瘦身

仅在 Gate 2 通过后执行。

当前合并批次要求：先完整实现 Phase 2，执行 Phase 2 定向测试、typecheck 和 build，并提交一个独立 Phase 2 commit。发现 P0、冻结合同冲突或无法证明服务操作安全时必须停止并标记 `BLOCKED`；否则不释放写锁、不交 Codex，继续执行 Phase 3。

### 实现范围

- 从 `ServiceMaintenancePanel` 移除证书 UI 和证书专属状态。
- 把繁重主机历史监控迁出服务维护，不破坏探针和监控数据能力。
- 保留并强化服务发现、Runbook、部署节点、启停、SSH 和日志。
- 按技术合同拆分超大组件和服务端路由。
- 提供轻量服务与部署节点 Payload，避免把历史指标随维护首页加载。
- 正确处理批量操作、部分成功、超时、重复点击和刷新竞争。

### 强制测试

- Docker、Systemd、Kubernetes、裸进程状态映射。
- 启动、停止、重启、脚本、SSH 和日志权限。
- 危险操作确认与防重复提交。
- 服务发现纳管。
- 旧服务维护功能回归。
- 证书与历史主机监控不再出现在服务维护页面和 Payload。

## 7. Phase 3：独立监控大盘与 NOC

默认仅在 Gate 3 通过后执行。用户已于 2026-08-27 15:22 CST 批准当前合并批次跳过中间 Gate 3；因此在 Phase 2 已完成内部自验并形成独立 commit 后，可以在同一会话继续本阶段。该例外不允许忽略 Phase 2 验收失败，也不改变本阶段范围。

### 实现范围

- 新增全局导航和路由。
- 复用现有主机、部署、时序、告警和探针能力。
- 实现主机基础设施、服务性能和 NOC 三个视图。
- 实现环境/主机/服务/时间过滤、自动刷新、暂停和最后更新时间。
- 明确显示离线、陈旧、缺失和局部失败数据。
- 检查未跟踪 `EnvironmentMonitoringDashboard.vue` 后按审计决定复用、拆分或替换，禁止无说明覆盖。
- 避免 N+1 请求、无限并发、重复定时器、订阅泄漏和全量未降采样数据传输。
- 遵守 Gemini 的响应式、全屏、动效和可访问性规格。

### 强制测试

- 导航、权限和工作空间/环境过滤。
- 刷新竞态、组件卸载和定时器清理。
- 无数据、离线、陈旧和局部 API 失败。
- 时间范围与降采样参数。
- NOC 进入/退出全屏和 `prefers-reduced-motion`。
- 关键用户流和桌面构建。

## 8. 每个实现阶段的完成流程

1. 只修改当前阶段允许的范围。
2. 自审完整 diff，移除调试代码和无关格式化。
3. 运行相关定向测试。
4. 运行 `npm run typecheck`。
5. 运行 `npm test`。
6. 运行 `npm run build`；涉及桌面行为时运行桌面验证。
7. 提交说明性 commit；当前合并批次必须分别保留 Phase 2 和 Phase 3 的实现 commit。
8. 非合并阶段更新 `STATUS.md` 为 `REVIEW_REQUIRED` 并推送；当前合并批次在 Phase 2 commit 后继续持有写锁，完成 Phase 3 后再统一更新状态并推送 `origin/dev`。
9. 当前阶段修改了代码，因此执行 `npm run package:current-os`；合并批次只需基于 Phase 3 最终代码执行一次，但 Phase 2 的内部测试证据必须单独记录。
10. 合并批次完成后提供服务维护、监控大盘和 NOC 的实际运行截图，记录命令结果、两个输出 commit、风险和交接对象，释放写锁并交 Gemini 整体验收。

不得以“测试太慢”为由跳过项目要求。若测试因既有问题失败，记录可复现证据并停止，不要顺手修复无关范围。

## 9. 接收 Codex 或 Gemini 问题清单

- 逐条回应问题编号。
- 修复范围限定为问题本身。
- 对不同意的问题提供代码和测试证据，不得仅凭主观判断关闭。
- 修复后补充能防止回归的测试。
- 重新执行阶段完成流程并交回原审查者。

## 10. 完成条件

- 当前阶段在 `ACCEPTANCE.md` 中的所有必选项通过；合并批次必须同时满足 Phase 2 和 Phase 3 条目。
- 没有未说明的 API、Schema 或产品范围变化。
- 测试、提交、推送和当前系统打包完成。
- `STATUS.md` 信息足以让下一位 Agent 无需依赖聊天记录继续工作。
