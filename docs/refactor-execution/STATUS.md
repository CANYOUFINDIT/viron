# 重构执行状态与交接记录

> 这是所有 Agent 的共享状态源。开始和完成任务时都必须更新。历史记录只追加，不覆盖。

## 1. 当前状态

| 字段 | 当前值 |
| --- | --- |
| 当前阶段 | Phase 1：凭据与证书修正 |
| 阶段状态 | `CHANGES_REQUIRED` |
| 当前写锁 | `UNLOCKED` |
| 当前负责人 | 无 |
| 产品批准 | 用户已于 2026-08-27 11:24 CST 批准 `UIUX-SPEC.md` 2.0.0-final；无例外 |
| 技术合同状态 | `FROZEN`（Gate 1 `PASSED`） |
| 下一位负责人 | Grok 修正 Gate 2 问题；修正后重新交 Codex 审查 |

## 2. 基线

| 项目 | 值 |
| --- | --- |
| 编写执行手册时的源代码 commit | `cf31e32f27d53f14a89c71deed1e414e933089b5` |
| 实施基线 commit | `e2507331451ac18a49cf140d617ed26286d6e12b`（Phase 0A 审计时 HEAD；无生产代码改动） |
| 当前分支 | `dev` |
| 远端 | `origin/dev` |
| 工作区预期遗留 | 仅保留已知未跟踪 `src/client/components/EnvironmentMonitoringDashboard.vue`；Gate 1 批次只修改四份批准/合同/验收/状态文档。 |
| 未跟踪文件处置 | **拆分复用、原文件只读且不纳管**（ADR-006）。Phase 3 只能在新 tracked 文件重写，未经用户另行授权不得修改、删除或 `git add` 原文件。 |

## 3. 阶段看板

| 阶段 | 负责人 | 状态 | 输入 commit | 输出 commit | 审查结论 |
| --- | --- | --- | --- | --- | --- |
| Phase 0A 现状审计 | Grok | `PASSED` | `e250733` | `8357549` | Codex Gate 1 已复核并采用审计输入 |
| Phase 0B UI/UX 规格 | Gemini | `PASSED` | `e250733` | `0695956` | 用户于 2026-08-27 11:24 CST 批准 2.0.0-final；无例外 |
| Gate 1 技术合同 | Codex | `PASSED` | `2677bbe` | `9526f92` | 技术合同已冻结，验收矩阵已完善，无阻断问题 |
| Phase 1 凭据与证书 | Grok | `CHANGES_REQUIRED` | `9526f92` / `9c3ba63` | `0ec3ab9` | Gate 2 发现迁移、生命周期、分页和 UI/测试阻断项，须在 Phase 1 内修正 |
| Gate 2 Phase 1 审查 | Codex | `CHANGES_REQUIRED` | `9c3ba63` | `0ec3ab9` / 待回填审查记录 commit | 详见 2026-08-27 12:31 交接；不得进入 Phase 2 |
| Phase 2 服务维护瘦身 | Grok | `BLOCKED` | 待填 | 待填 | 等待 Gate 2 |
| Gate 3 Phase 2 审查 | Codex | `BLOCKED` | 待填 | 待填 | 待填 |
| Phase 3 监控大盘 | Grok | `BLOCKED` | 待填 | 待填 | 等待 Gate 3 |
| Phase 3 UI/UX 验收 | Gemini | `BLOCKED` | 待填 | 待填 | 待填 |
| Gate 4 最终质量与发布 | Codex | `BLOCKED` | 待填 | 待填 | 待填 |

状态只能使用：`NOT_STARTED`、`IN_PROGRESS`、`BLOCKED`、`REVIEW_REQUIRED`、`CHANGES_REQUIRED`、`PASSED`。

## 4. 写锁

```text
状态：UNLOCKED
Agent：无
阶段：无
开始时间：-
预计修改范围：-
```

若写锁为 `LOCKED`，其他 Agent 只能进行不写仓库的分析，不得执行代码修改、格式化、迁移或 Git 操作。

## 5. 当前阻塞与风险

Gate 2 结论为 `CHANGES_REQUIRED`，Phase 2 继续阻塞。当前阻断与风险：

1. `G2-P1-001`～`G2-P1-007` 与 `G2-P2-001`～`G2-P2-002` 未关闭；触发条件、后果、修复边界和验证方法见 2026-08-27 12:31 交接。
2. 新旧 TLS 双写窗口仍在；旧 `tls_*` 表未删除。任何停止双写必须延期到独立版本化迁移。
3. 未跟踪 `EnvironmentMonitoringDashboard.vue` 仍只读未纳管，未修改、未提交、未接入路由。
4. 服务维护证书/监控 UI 与重型 `/maintenance` Payload 按合同保留到 Phase 2；修正 Gate 2 时不得提前瘦身。
5. TLS 探测仍允许 manager 经授权 SSH 访问私网/loopback；metadata/link-local/multicast 已拒绝。
6. 本地真实 MariaDB 11.4 测试已执行通过，但仓库没有独立 MySQL CI job，且现有 MySQL 测试未覆盖合同要求的 CRUD/级联/事务回滚等价性。
7. Electron 并行安装竞态仍存在，不阻断 Gate 2，Gate 4 前需解决。

## 6. 交接模板

每次交接在本节下方追加，不得删除旧记录：

```md
### YYYY-MM-DD HH:mm — Agent / 阶段

- 输入 commit：
- 输出 commit：
- 完成内容：
- 修改文件：
- 数据库/API 变化：
- 测试命令及结果：
- `package:current-os` 结果：
- 未完成内容：
- 已知风险：
- 下一位负责人：
- 下一阶段允许修改范围：
- 下一阶段禁止修改内容：
```

## 7. 交接历史

### 2026-08-27 10:58 — Gemini / Phase 0B UI/UX 规格

- 输入 commit：`e250733`
- 输出 commit：`0695956`
- 完成内容：
  1. 完成全套 UI/UX 交互规格文档编制 (`docs/refactor-execution/UIUX-SPEC.md`)。
  2. 定义全局导航演进（AppShell「SSH 密钥」升级为「密钥与证书」、新增「监控大盘」一级入口）。
  3. 定义环境详情页签（「服务维护」纯粹化瘦身、Web 入口就地 HTTPS 证书状态感知徽标与 Popover 联动）。
  4. 制定密钥与证书中心（SSH 密钥 + SSL/TLS 证书双 Tab、SHA-256 指纹去重归并、多 Web 入口关联与管理流程）。
  5. 制定服务维护瘦身规格（Operations Ribbon 快捷工具条、Docker/Systemd/K8s/裸进程四类统一节点卡片、一等公民操作、服务发现抽屉）。
  6. 制定监控大盘全量规格（主机基础设施视图、业务服务 APM 视图、NOC 沉浸式全屏大屏、Findings 智能排障与 Top 5 进程时序堆叠）。
  7. 制定通用状态矩阵（加载/空状态/权限/离线/陈旧/破坏性确认）、响应式断点、可访问性与微动效性能规则。
  8. 给出精确 Given/When/Then 验收条件与后端 API 依赖清单。
- 修改文件：`docs/refactor-execution/UIUX-SPEC.md`、`docs/refactor-execution/STATUS.md`
- 数据库/API 变化：无生产代码与数据库修改（纯设计文档）。
- 测试命令及结果：纯设计文档不修改代码，不涉及运行测试。
- `package:current-os` 结果：不适用（纯文档性改动按规则不执行构建）。
- 未完成内容：无，Phase 0B 规格已全量交付。
- 已知风险：无；等待用户审批 `UIUX-SPEC.md`。
- 下一位负责人：用户（批准规格） / Codex（推进 Gate 1 技术合同冻结）
- 下一阶段允许修改范围：`docs/refactor-execution/TECH-CONTRACT.md`、`docs/refactor-execution/ACCEPTANCE.md`、`docs/refactor-execution/STATUS.md`
- 下一阶段禁止修改内容：生产代码 `src/`、数据库迁移、构建配置（在 Gate 1 冻结前禁止改写生产代码）

### 2026-08-27 11:15 — Grok / Phase 0A 现状审计

- 输入 commit：`e2507331451ac18a49cf140d617ed26286d6e12b`
- 输出 commit：`8357549`
- 完成内容：
  1. 只读审计代码、Schema、API、测试与未跟踪监控组件。
  2. 完整填写 `CURRENT-STATE-AUDIT.md`（需求矩阵、可复用资产、tls_endpoints 与目标模型差异、SQLite/MySQL、监控/权限/测试基线、Phase 1–3 建议范围、开放问题 A-001～A-014）。
  3. 未跟踪 `EnvironmentMonitoringDashboard.vue` 建议处置：**拆分复用**；未 git add、未接入路由、未删除。
  4. 未修改生产代码；未覆盖 0B 的 `UIUX-SPEC.md` 与 0B 交接记录。
- 修改文件：`docs/refactor-execution/CURRENT-STATE-AUDIT.md`、`docs/refactor-execution/STATUS.md`
- 数据库/API 变化：无
- 测试命令及结果：
  - `npm run typecheck`：通过（real 9.91s）
  - 定向测试 13 files / 44 tests：通过（real 3.47s）
  - `npm test`：728 passed / 8 skipped；1 个文件失败（`desktop-local-web.integration.test.ts` Electron 并行安装竞态）。单独重跑该文件：skipped。不修复。
  - `npm run build`：通过（real 10.00s）；产物不含未跟踪监控组件
- `package:current-os` 结果：不适用（Phase 0A 只改审计与状态文档）
- 未完成内容：开放问题交 Codex/用户/Gemini；未提交他人已暂存的执行手册修订与 `UIUX-SPEC.md`
- 已知风险：见第 5 节。工作区开始时不干净，未执行 `git pull --ff-only`。0A 与 0B 曾并行写 `STATUS.md`。
- 下一位负责人：用户批准 UI/UX；Codex Gate 1（须同时引用本审计与已批准规格）
- 下一阶段允许修改范围：Gate 1 仅 `TECH-CONTRACT.md`、`ACCEPTANCE.md`、`STATUS.md`（及合同明确的文档）
- 下一阶段禁止修改内容：生产代码、Schema/API、把未跟踪监控组件接入路由、从服务维护删除功能、新建证书表（直至 `TECH-CONTRACT.md` 为 `FROZEN`）

### 2026-08-27 11:20 — Codex / Gate 1 前置条件核验

- 输入 commit：`252a7b7cb4cd999e5f5f4e042b9fc5c5db70ac8e`（与 `origin/dev` 一致）
- 输出 commit：本次阻塞交接记录所在提交；Gate 1 无输出 commit
- 结论：`BLOCKED`
- 完成内容：
  1. 完整读取 Codex Gate 任务书要求的根目录 `AGENTS.md`、原始重构方案、执行说明、状态、现状审计、UI/UX 规格、技术合同和验收矩阵。
  2. 根据 `STATUS.md` 识别当前目标为 Gate 1，并核验本地及远端 `dev` 均无后续产品批准记录。
  3. 确认 Gate 1 前置条件未满足：`UIUX-SPEC.md` 状态仍为 `REVIEW_REQUIRED`，`STATUS.md` 仍记录“UI/UX 规格尚未用户批准”，验收矩阵“用户已批准设计方向”仍未完成。
  4. 未冻结 `TECH-CONTRACT.md`，未修改 `ACCEPTANCE.md`，未实施 Schema、API、客户端或后续 Phase 1–3 代码。
- 修改文件：`docs/refactor-execution/STATUS.md`（仅本交接记录）
- 数据库/API 变化：无
- 测试命令及结果：未运行；当前仅核验文档前置条件，无代码或合同内容变更
- `package:current-os` 结果：不适用（纯文档性阻塞交接，且无代码修改）
- 未完成内容：Gate 1 的技术决策、`TECH-CONTRACT.md` 冻结和 `ACCEPTANCE.md` 完善均未开始，禁止在用户批准前代替产品决策人推进。
- 已知风险：
  1. 阻塞编号 `G1-PRE-001`：用户尚未批准 `UIUX-SPEC.md`。触发条件是直接执行 Gate 1；实际后果是合同可能冻结未经批准的 IA、权限与关键交互；期望行为是用户明确批准设计或给出修改意见；解除边界是仅更新批准状态或先由 Gemini 修订规格；验证方法是 `UIUX-SPEC.md` 标为 `APPROVED` 且 `STATUS.md` 记录批准人/时间/例外。
  2. 未跟踪 `src/client/components/EnvironmentMonitoringDashboard.vue` 保持原状，未删除、未覆盖、未接入路由、未提交。
- 下一位负责人：用户（批准 `UIUX-SPEC.md` 或提出修改意见）；批准完成后交 Codex 重新执行 Gate 1
- 下一阶段允许修改范围：批准前仅允许处理 `UIUX-SPEC.md` 的用户意见与批准记录；批准后 Gate 1 仅允许修改 `TECH-CONTRACT.md`、`ACCEPTANCE.md`、`STATUS.md` 及合同明确需要的文档
- 下一阶段禁止修改内容：生产代码、Schema/API、未跟踪监控组件、Phase 1–3 实现，以及任何对 `TECH-CONTRACT.md` 的提前冻结

### 2026-08-27 11:39 — Codex / Gate 1 技术合同

- 输入 commit：`2677bbea80ad5aa3e9e7f8b5436ad75a909985da`（开始时与 `origin/dev` 一致）
- 输出 commit：`9526f920b5ee114012fb8f05de3008465665b0b8`
- 结论：`PASSED`
- 完成内容：
  1. 记录用户对 `UIUX-SPEC.md` 2.0.0-final 的正式批准，无例外。
  2. 复核现有 SQLite/MySQL schema、迁移机制、TLS/Web 入口关联、workspace ACL、服务操作、监控 history 和告警实现。
  3. 将 `TECH-CONTRACT.md` 冻结为 `FROZEN`，完成 ADR-001～ADR-011，闭环审计 A-001～A-014。
  4. 冻结独立证书资产/端点模型、工作空间指纹唯一、旧表幂等迁移/兼容双写/回滚、生命周期和 API 合同。
  5. 冻结 manager 权限、TLS SSRF/注入边界、服务 operation 幂等/锁/超时/部分成功/重启恢复合同。
  6. 冻结服务维护轻量 Payload、监控 overview/时序/降采样/刷新/并发、组件拆分和 NOC 生命周期。
  7. 完善 `ACCEPTANCE.md` 的 Phase 1–3、Gate 2–4 和最终发布逐项验收矩阵。
- 修改文件：`docs/refactor-execution/UIUX-SPEC.md`、`TECH-CONTRACT.md`、`ACCEPTANCE.md`、`STATUS.md`
- 数据库/API 变化：无生产实现；仅冻结后续必须实现的数据模型、迁移、API、权限和性能合同
- 测试命令及结果：
  - `git diff --check`：通过
  - 文档状态/占位符/开放问题定向扫描：通过；冻结合同无待定项
  - 未运行代码测试：Gate 1 只有文档改动，未修改生产代码
- `package:current-os` 结果：不适用（纯文档性 Gate 1）
- 未完成内容：无；Gate 1 合同和验收矩阵已冻结。Phase 1 尚未开始。
- 已知风险：
  1. Phase 1 的最高风险是新旧 TLS 模型迁移与双写；Gate 2 必须同时取得 SQLite 和真实 MySQL 行为证据。
  2. 证书探测允许 manager 对授权 SSH 可达的私网/loopback TLS 端点执行探测；metadata/link-local 等被禁止，剩余 DNS rebinding 风险已在合同中接受并由权限、固定 TLS 协议、限流和审计约束。
  3. 未跟踪监控草稿保持只读未提交，Phase 1 不得触碰。
- 下一位负责人：Grok / Phase 1 凭据与证书
- 下一阶段允许修改范围：仅 `TECH-CONTRACT.md` §11 的 Phase 1 文件；实现证书模型迁移/兼容 API、密钥与证书中心、Web 入口 TLS 联动及相应行为测试
- 下一阶段禁止修改内容：服务维护瘦身、operation run、全局监控大盘/NOC、监控 overview、未跟踪监控草稿，以及对冻结合同的无 ADR 偏离

### 2026-08-27 12:16 — Grok / Phase 1 凭据与证书

- 输入 commit：`9526f920b5ee114012fb8f05de3008465665b0b8`（开始时工作区 HEAD `9c3ba63`，其为 Gate 1 输出记录提交）
- 输出 commit：`0ec3ab9`
- 完成内容：
  1. 新增 `ssl_certificates` / `ssl_endpoints` / `ssl_endpoint_web_entries` 与 `schema_migrations`，SQLite/MySQL 对齐；迁移 `20260827_ssl_asset_v1` 幂等、失败不激活。
  2. 运行时以新表为真相并双写旧 `tls_*`；同工作空间指纹归并，跨空间隔离 404。
  3. 证书 API：`GET/DELETE /api/v1/certificates`、按证书重探；旧 `/tls-endpoints*` 兼容；探测改为 manager；拒绝 metadata/link-local/multicast。
  4. 全局入口升级为「密钥与证书」双 Tab；Web 入口 TLS 徽标 + Popover 就地重探/跳转凭据中心。
  5. 未修改、未删除、未提交、未接入 `EnvironmentMonitoringDashboard.vue`。未做 Phase 2/3。
- 修改文件：`src/server/{sqlite-schema,mysql-schema,database,tls-certificates,ssl-asset-migration,app}.ts`、`src/server/routes/{certificates,service-maintenance}.ts`、`src/shared/{tls-certificates,i18n-messages}.ts`、`src/client/views/{SshKeysView,EnvironmentDetailView}.vue`、`src/client/components/AppShell.vue`、`src/client/components/credentials/*`、相关测试、`docs/refactor-execution/STATUS.md`
- 数据库/API 变化：新证书资产模型 + 兼容双写；新增 `/api/v1/certificates*`；探测权限收紧为 manager
- 测试命令及结果：
  - `npm run typecheck`：通过
  - 定向：tls/migration/certificates-api/maintenance/ui：通过
  - `tests/ssl-asset-mysql.test.ts`（Docker MariaDB 11.4）：通过
  - `npm test`：175 files，735 passed / 9 skipped（含既有 skip 的桌面本地集成与工作台 mysql.integration）
  - `npm run build`：通过
- `package:current-os` 结果：成功。macOS arm64 DMG `release/Viron-0.1.6-macos-arm64-self-signed.dmg`（未提交 release/）
- 未完成内容：Phase 2 维护瘦身与 operation run；Phase 3 监控大盘；旧 TLS 表清理延期
- 已知风险：见第 5 节
- 下一位负责人：Codex / Gate 2
- 下一阶段允许修改范围：Gate 2 审查 Phase 1 diff；必要时只提 CHANGES_REQUIRED 问题清单，不扩大到 Phase 2/3
- 下一阶段禁止修改内容：服务维护瘦身、operation run、监控大盘/NOC、未跟踪监控草稿、删除旧 `tls_*` 表、操作 `main`

### 2026-08-27 12:31 — Codex / Gate 2 Phase 1 审查

- 输入 commit：`9c3ba63`（Phase 1 实现前状态记录；冻结合同输出为 `9526f92`）
- 审查 commit：`0ec3ab9`
- 输出 commit：本次 Gate 2 审查记录提交，随后回填精确 commit
- 结论：`CHANGES_REQUIRED`
- 完成内容：
  1. 严格只审查 `9c3ba63..0ec3ab9`，复核 Schema、迁移、SQLite/MySQL、双写、API、权限、TLS 探测、删除生命周期、客户端状态和测试证据。
  2. 未修改 Phase 1 生产代码，未实施 Phase 2/3，未操作 `main`。
  3. 未修改、删除、暂存或提交未跟踪 `src/client/components/EnvironmentMonitoringDashboard.vue`。
- 修改文件：`docs/refactor-execution/STATUS.md`（仅 Gate 2 状态、问题清单与交接）
- 数据库/API 变化：无；本次为只读审查。
- 测试命令及结果：
  - `git diff --check 9c3ba63..0ec3ab9`：通过。
  - `npm run typecheck`：通过。
  - `npm test`：通过；168 files passed / 7 skipped，735 tests passed / 9 skipped；本机 Docker MariaDB 11.4 测试实际执行通过。
  - `npm run build`：通过；仅有既有 chunk size 警告。
  - `npx tsx -e ... tlsEndpointIsStale(...)`：最近成功后 10 分钟发生 `connect_failed` 时返回 `false`，复现 `G2-P2-001`。
- `package:current-os` 结果：不适用；Gate 2 只修改状态文档，Phase 1 的代码安装包已由 Grok 基于 `0ec3ab9` 成功生成且未提交 `release/`。
- 未完成内容：以下问题全部关闭并重新通过 Gate 2 前，禁止进入 Phase 2。
- 审查问题：
  1. **`G2-P1-001`：旧 junction 可被静默丢弃。** 文件/位置：`src/server/ssl-asset-migration.ts:180-207`。触发条件：旧表中同一 `web_entry_id` 关联多个 endpoint；旧 schema 只以 `(endpoint_id, web_entry_id)` 为主键，允许该数据。实际后果：迁移用 `seenEntries` 保留第一条并跳过其余条目，校验又比较 `COUNT(DISTINCT web_entry_id)`，因此会写 marker 并静默丢掉关联。期望行为：按冻结合同校验旧/新 junction 总数，遇到一入口多端点时停止激活并报告全部冲突行 ID。建议修复边界：仅修改 Phase 1 migration helper 与双库 fixture，不改变“一入口一个活动端点”Schema。验证方法：SQLite/MariaDB 分别构造重复入口关联，断言迁移失败、无 marker、旧表未变、新表数据回滚且错误含冲突 ID。
  2. **`G2-P1-002`：marker 早退无法承接旧版本回滚后的变更。** 文件/位置：`src/server/ssl-asset-migration.ts:58-64,198-236`。触发条件：新版本已写 marker，随后回退旧二进制并新增/更新 endpoint、探测结果或 junction，再升级回当前版本。实际后果：`migrationApplied()` 仅校验 checksum 后直接返回，运行时切换到陈旧 `ssl_*` 真相，旧版本期间的变更不可见；现有校验也未覆盖每个合法指纹映射、唯一键和按工作空间计数。期望行为：回滚再前滚可安全重放/对账，只有完整校验后才激活。建议修复边界：在 Phase 1 migration 中增加可并发安全的幂等 upsert/对账策略或明确版本化再前滚迁移，并补齐合同列出的逐映射/工作空间校验；不得删旧表。验证方法：SQLite/MariaDB 跑“迁移→模拟旧版本只写旧表→重启新版本”和部分回填 fixture，断言新旧一致、ID 不变、无静默遗漏。
  3. **`G2-P1-003`：失败的旧探测被错误记为当前资产和最近成功。** 文件/位置：`src/server/ssl-asset-migration.ts:128-172`。触发条件：旧 endpoint 当前 `probe_status != 'ok'`，但保留了上次证书指纹/有效期，且 `probed_at` 是最近失败时间。实际后果：代码仍设置 `certificate_id`，并因三元表达式两条 fingerprint 分支都返回 `row.probed_at`，把失败尝试写成 `last_success_at`；与“失败/未探测迁移为 `certificate_id=NULL`、仅成功行回填最近成功”合同不符。期望行为：严格按状态迁移资产关系和成功时间，不能伪造成功时间。建议修复边界：只调整 migration 映射并保留旧表数据。验证方法：双库增加 `never/connect_failed/timeout/ok` fixture，逐项断言 `certificate_id`、`last_success_at` 和 marker/回滚行为。
  4. **`G2-P1-004`：endpoint 创建/改身份没有原子维护证书状态。** 文件/位置：`src/server/tls-certificates.ts:424-509`。触发条件 A：以 `observeEnabled=false` 创建端点；触发条件 B：编辑已有端点的 host/port/SNI/SSH，或显式解绑 SSH。实际后果：A 在创建事务提交后才用第二个事务禁用，第二步失败会遗留启用端点；B 保留旧 `certificate_id/probe_status/hostname_match`，新目标可继续显示旧证书为健康，显式解绑还保留旧 `ssh_bind_key` 并破坏未绑定身份唯一语义。期望行为：单次 CRUD 在一个事务内双写；身份变化时原子清理/失效旧探测状态，显式解绑使用空 bind key，仅 FK 删除保留旧 bind key。建议修复边界：只修改 endpoint 领域写入与兼容旧表双写。验证方法：双库注入第二侧写失败验证整体回滚，并通过路由测试覆盖禁用创建、改 host/SNI、显式解绑、唯一冲突和重新探测。
  5. **`G2-P1-005`：自动清理 Web 入口 endpoint 留下幽灵活动告警。** 文件/位置：`src/server/tls-certificates.ts:550-560`。触发条件：删除/改为 HTTP/解绑最后一个关联 Web 入口，且自动生成、未自定义的 endpoint 存在活动 TLS 告警。实际后果：helper 直接删除新旧 endpoint，却没有调用 `recoverEndpointAlerts()`；`monitor_alerts` 和 `monitor_alert_states` 留下指向不存在 endpoint 的活动状态。期望行为：所有 endpoint 删除路径都在同一事务恢复告警、删除状态并双写删除 endpoint。建议修复边界：复用现有删除生命周期 helper，不删除证书资产或真实 Web 入口。验证方法：双库/API fixture 创建活动告警后执行解绑和删除 Web 入口，断言告警 recovered、state 清空、证书成为 orphan、Web 入口按请求保留/删除。
  6. **`G2-P1-006`：证书列表没有按合同在 DB 分页，详情在 1000 项后误报 404。** 文件/位置：`src/server/tls-certificates.ts:865-981`。触发条件：工作空间证书较多，尤其目标资产在排序后的第 1001 项以后。实际后果：列表先把工作空间全部证书/endpoint 拉入内存再过滤排序切片，违反默认 50/最大 100 且 DB 过滤排序的性能合同；`getWorkspaceCertificate()` 又复用 `pageSize:1000` 列表，导致合法资产的 GET/DELETE/probe 误报 404。期望行为：列表在 DB 中做作用域、过滤、排序、count 和分页；详情按 workspace + ID 直接查并加载该资产全部关联。建议修复边界：仅重写 certificates 查询层，不改变冻结 DTO/API。验证方法：双库使用超过 1000 项 fixture 验证分页边界、总数、过滤/排序、详情/删除可达性，并记录固定数量查询以排除 N+1。
  7. **`G2-P1-007`：全局批量探测吞掉全部失败并显示成功。** 文件/位置：`src/client/components/credentials/CertificateCenter.vue:102-112`。触发条件：任一资产探测遇到 429、SSH/数据库错误或请求失败。实际后果：每个错误都被 `.catch(() => undefined)` 丢弃，最终总是提示“批量重新探测已完成”，没有成功/失败目标数、进度或重试入口；全失败也显示成功。期望行为：按批准规格展示队列进度与逐目标/汇总的部分成功结果，不绕过 60 秒限制。建议修复边界：只修改 Phase 1 证书中心批量状态与现有 API 适配，不引入 Phase 2 operation 模型。验证方法：组件行为测试模拟全成功、部分失败、全失败、429 和重复点击，断言进度、提示、按钮状态与最终刷新。
  8. **`G2-P2-001`：失败探测没有立即标记保留快照为 stale。** 文件/位置：`src/shared/tls-certificates.ts:282-293`。触发条件：端点最近成功后下一次探测失败，且距最近成功不足两个重试周期。实际后果：`tlsEndpointIsStale()` 返回 `false`；API 虽为 error，但 retained certificate snapshot 未按合同同时标记 stale。期望行为：失败后保留资产并立即标明快照陈旧，成功探测才清除该失败陈旧状态。建议修复边界：调整共享状态派生函数，不改数据库模型。验证方法：纯函数和 API/badge 行为测试覆盖 success→failure→success、无历史成功和超时。
  9. **`G2-P2-002`：必需行为测试与独立 MySQL CI 证据不完整。** 文件/位置：`tests/certificate-center-ui.test.ts:1-33`、`tests/ssl-asset-migration.test.ts:30-88`、`tests/ssl-asset-mysql.test.ts:11-121`、仓库 CI 配置缺失。触发条件：上述迁移/CRUD/失败/交互回归发生。实际后果：UI 新测只读取源码并匹配字符串；MySQL 新测只迁移一行并比较行数，未执行运行时 CRUD、junction、唯一冲突、级联和事务回滚；仓库没有独立 MySQL job，因此当前 735 个通过测试仍无法证明冻结验收矩阵。期望行为：新逻辑以渲染/交互和双数据库真实行为测试为主，CI 中 MySQL job 不以 skip 代替。建议修复边界：只补 Phase 1 测试/CI，不改 Phase 2/3。验证方法：新增测试先能捕获 `G2-P1-001`～`G2-P2-001`，修复后 SQLite 与 MariaDB job、typecheck、全量测试、build 全部通过。
- 已知风险：除上述问题外，旧 TLS 双写清理、Phase 2/3、Electron Gate 4 竞态仍按冻结合同延期，不得混入本轮修正。
- 下一位负责人：Grok / Phase 1 修正；完成后将状态改回 `REVIEW_REQUIRED` 并重新交 Codex Gate 2。
- 下一阶段允许修改范围：仅修复 `G2-P1-001`～`G2-P2-002` 所需的 Phase 1 migration、TLS/API、证书中心和测试/CI 文件；更新本状态记录。
- 下一阶段禁止修改内容：Phase 2 服务维护瘦身/operation run、Phase 3 监控大盘/NOC、删除旧 `tls_*` 表、修改/纳管未跟踪监控草稿、操作或合并 `main`。
