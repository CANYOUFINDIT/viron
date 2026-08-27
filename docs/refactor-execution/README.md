# Viron 服务维护、监控大盘与凭据中心重构执行手册

## 1. 用途

本目录把总体方案拆成可以分别交给 Gemini、Grok 和 Codex 执行的任务书。原始产品方案见：

- `docs/SERVICE-MAINTENANCE-AND-MONITORING-REFACTOR.md`

模型分工固定如下：

| 角色 | 负责人 | 核心职责 |
| --- | --- | --- |
| 产品体验负责人 | Antigravity 中的 Gemini | 信息架构、UI/UX、交互状态、视觉验收 |
| 主力实现负责人 | Grok | 现状审计、主要代码实现、测试和普通缺陷修复 |
| 技术与质量负责人 | Codex | 技术合同、风险审查、阶段质量闸门、少量关键修复和最终发布验收 |
| 产品决策人 | 用户 | 批准设计与重大取舍，决定是否进入下一阶段 |

Codex 额度最少，因此不承担大面积铺码和日常样式调整。Grok 应完成约 80%～90% 的代码；Codex 只在技术合同、数据库/安全风险、服务操作安全和最终发布时介入。

## 2. 可直接交给 Agent 的任务书

将下列文件的完整内容交给对应 Agent：

1. Gemini：`docs/refactor-execution/GEMINI-UIUX-AGENT.md`
2. Grok：`docs/refactor-execution/GROK-IMPLEMENTATION-AGENT.md`
3. Codex：`docs/refactor-execution/CODEX-ARCHITECTURE-QA-AGENT.md`

共享事实文件：

- `STATUS.md`：阶段状态、写锁、提交和交接记录。
- `CURRENT-STATE-AUDIT.md`：Grok 填写的现状审计。
- `UIUX-SPEC.md`：Gemini 填写的交互与视觉规格。
- `TECH-CONTRACT.md`：Codex 冻结的技术合同。
- `ACCEPTANCE.md`：阶段验收标准和最终发布标准。

## 3. 强制执行顺序

```text
Phase 0A：Grok 只读审计并处理当前基线说明
                     ┐
                     ├─ 可并行，均不得修改生产代码
Phase 0B：Gemini 完成整体 IA 与 Phase 1 详细设计
                     ┘
          ↓
Gate 0：用户批准产品方向
          ↓
Gate 1：Codex 冻结 TECH-CONTRACT.md 与 ACCEPTANCE.md
          ↓
Phase 1：Grok 实现密钥与证书中心及 Web 入口联动
          ↓
Gate 2：Codex 审查；Grok 修复；Codex 复核
          ↓
Phase 2：Grok 瘦身服务维护
          ↓
Phase 3：同一 Grok 会话继续实现监控大盘与 NOC 模式
          ↓
Gemini 基于运行截图对 Phase 2+3 做整体视觉/交互验收
          ↓
Grok 集中修复 Gemini 验收问题
          ↓
Gate 3+4：Codex 合并审查 Phase 2+3、全量回归、最终验收和安装包验证
```

用户已于 2026-08-27 15:22 CST 明确批准本次执行流程例外：取消 Phase 2 与 Phase 3 之间的独立 Gate 3，不改变 `TECH-CONTRACT.md` 的技术边界和两个 Phase 各自的验收项。Grok 必须先完成 Phase 2 的内部自验再继续 Phase 3，并用独立 commit 保留阶段边界；最终由 Codex 对两个阶段实施合并 Gate 3+4。Gate 2 之前的历史流程和结论不受影响。

## 4. 单写者规则

本项目要求所有开发都在 `dev` 分支，不默认创建功能分支。因此采用单写者机制：

1. 任意时刻只有一个 Agent 可以修改仓库。
2. Agent 开始前必须查看 `STATUS.md` 的“当前写锁”。
3. 取得写锁后，把负责人、阶段和开始时间写入 `STATUS.md`。
4. 完成提交和推送后释放写锁，并填写交接记录。
5. Gemini 可以与 Grok 并行思考，但两者不能并行写仓库；Gemini 的规格写入安排在 Grok 编码窗口之外。
6. Codex 审查期间，Grok 必须停止写入。
7. 禁止两个模型同时运行格式化、代码生成、迁移或打包命令。

## 5. Git 与构建规则

所有 Agent 必须先阅读仓库根目录的 `AGENTS.md`。关键要求：

- 只在 `dev` 开发，不创建主题分支，除非用户明确要求。
- 工作区干净时才允许执行 `git pull --ff-only origin dev`。
- 不覆盖、不清理来源不明的用户改动。
- 每个完整任务批次完成后提交到 `dev` 并推送 `origin/dev`；只有批次修改了代码时才执行 `npm run package:current-os`，纯文档性改动不重新打包。
- 不提交 `private/`、密钥、`.env`、本地数据或 `release/`。
- 禁止直接操作 `main`。

不要把“修改一个按钮”定义为单独任务批次。一个批次应当是 Phase 0A、0B、Gate 1、Phase 1、Gate 2 等可独立验收的完整单元。Phase 0A、0B、只修改文档的 Gate 1 或只读审查不打包；包含代码修改的批次才打包。

## 6. 当前已知基线

编写本执行手册时：

- 当前分支：`dev`。
- `dev` 与 `origin/dev` 同步。
- 检查时的源代码提交：`cf31e32f27d53f14a89c71deed1e414e933089b5`。
- 存在未跟踪文件：`src/client/components/EnvironmentMonitoringDashboard.vue`。
- 该文件约 865 行，必须先确认归属和有效性，禁止直接覆盖或删除。
- 已存在服务维护、TLS 探测、证书与 Web 入口关联、主机监控、部署监控、监控历史和告警等部分实现，本项目不是从零开发。

首次实施前，Grok 必须在 `CURRENT-STATE-AUDIT.md` 中更新真实基线；后续一律以 `STATUS.md` 记录的提交为准。

## 7. 用户实际操作方法

每次只做以下四步：

1. 查看 `STATUS.md`，确认下一位 Agent 和当前阶段。
2. 把对应 Agent 任务书完整交给该 Agent，并要求其执行 `STATUS.md` 中当前阶段。
3. Agent 完成后，检查其是否填写 commit、测试结果、打包结果、风险和下一位负责人。
4. 当前合并批次中，Grok 完成 Phase 2+3 后直接交 Gemini；Gemini 验收后交 Grok 集中修复，最后交 Codex 合并执行 Gate 3+4。

若 Agent 请求改变已经冻结的数据模型、API 或产品方向，停止当前任务，由用户决定是否退回 Gemini 或 Codex 重新开决策记录。不要让实现 Agent 私自扩大范围。

### 可直接发送的启动语

首次交给 Grok：

```text
请打开并完整执行 docs/refactor-execution/GROK-IMPLEMENTATION-AGENT.md。
当前只执行 STATUS.md 指定的 Phase 0A，不得提前实施后续阶段。
完成后按任务书更新共享文档、提交、推送并交接；本阶段只有文档改动，不需要打包。
```

首次交给 Gemini：

```text
请打开并完整执行 docs/refactor-execution/GEMINI-UIUX-AGENT.md。
当前执行 STATUS.md 指定的 Phase 0B，不修改生产代码。
完成后按任务书更新共享文档、提交、推送并交接；纯设计文档改动不需要打包。
```

交给 Codex：

```text
请打开并完整执行 docs/refactor-execution/CODEX-ARCHITECTURE-QA-AGENT.md。
根据 STATUS.md 自动判断当前 Gate，只处理该 Gate，不提前实施后续阶段。
完成后给出 PASSED、CHANGES_REQUIRED 或 BLOCKED 的明确结论并完成交接。
```

当前合并批次交给 Grok：

```text
请打开并完整执行 docs/refactor-execution/GROK-IMPLEMENTATION-AGENT.md。
根据 STATUS.md 执行用户已批准的 Phase 2+3 合并批次：先完成并内部自验 Phase 2，再在同一会话继续 Phase 3；两个阶段分别提交，但中间不交 Codex Gate 3。
完成 Phase 2+3 全量验证、当前系统打包和运行截图后，更新 STATUS.md、推送 origin/dev，并交给 Gemini 做整体 UI/UX 验收。不得超出 TECH-CONTRACT.md 对 Phase 2/3 的允许范围。
```
