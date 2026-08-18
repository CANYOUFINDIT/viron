# Viron MCP 架构、能力与验收

## 1. 目标与完成定义

Viron MCP 让 Codex 等外部 AI Agent 以当前 Viron 用户身份使用 Viron 业务能力。除账号安全、成员与授权控制、秘密读取或导出等明确例外外，用户可以在 Viron 中完成的业务操作，都应具有一致的 MCP 语义、权限、限制、确认、执行位置、结果和审计。

该目标不拆分只读版、执行版或其他阶段。只有远程与本机入口、资源发现、真实连接、读写操作、风险确认、凭据安全输入、生命周期、审计和真实目标验收全部闭环，才算完整交付。

MCP 明确排除以下能力：

- Viron 注册、登录、密码、Session、个人或平台 API Key 管理。
- 平台用户、组织成员、项目成员、资源授权和知识库授权管理。
- SSH 私钥、密码、Cookie、Token、TLS 私钥和其他秘密的读取、复制或导出。
- 桌面设备注册、一次性凭据信封、内部 Runtime 协议和任意 IPC/CDP/API 透传。
- 平台级备份恢复、服务配置、安装包管理和目标数据库账号权限管理。

## 2. 接入架构

Viron 主服务和桌面 App 继续作为唯一业务与可信执行边界，MCP 不建立第二套连接、凭据或权限实现。

```text
Codex ── Streamable HTTP /mcp ── Viron 主服务
                                     ├─ 用户、工作空间与权限
                                     ├─ 加密凭据与风险确认
                                     ├─ Web/SSH/SFTP/日志/数据库/Redis Runtime
                                     └─ 审计与生命周期

Codex ── STDIO viron-mcp ── Unix Socket / Named Pipe ── Viron App 主进程
                                                           ├─ 当前 Endpoint、用户与工作空间
                                                           ├─ 本机直连 Runtime
                                                           └─ 服务端转发桥
```

### 2.1 远程入口

- 主服务通过 `VIRON_MCP_ENABLED` 控制远程 MCP，默认关闭；只有设置为 `true` 并重启服务后才在 `/mcp` 注册 Stateful Streamable HTTP。
- 只接受绑定具体用户的个人 API Key；平台 API Key、登录 Cookie 和匿名请求不能初始化 MCP Session。
- MCP Session 绑定用户、API Key、工作空间请求和随机执行 Scope，远程入口固定由服务端执行。
- Web 与桌面 App 的“设置 → MCP”始终可读取服务端状态；开启时展示连接信息、能力数量和当前账号的 Session，不返回 API Key 或其他秘密。

### 2.2 本机入口

- 安装包内的 `viron-mcp` 是按需启动的 STDIO 适配器，不常驻、不保存业务状态或秘密。
- `viron-mcp` 读取当前系统用户可访问的 Broker 描述文件，通过随机 Token 与 Viron App 主进程握手。
- App 的本机 MCP 默认关闭并按设备持久化，新安装和升级后的首次使用都需要在“设置 → MCP”手工开启；关闭会断开 Broker 客户端并取消等待中的本机 Operation。
- App 的本机审批模式同样按设备持久化，可选择“请求批准”“替我审批”或“完全访问权限”。该设置由 App 通过受控请求头传给服务端，不写入中心用户配置。
- Broker 复用 App 当前已登录的 Endpoint、用户、工作空间和执行模式。App 未运行、未登录或正在切换上下文时必须明确失败。
- STDIO 适配器在发布工具前必须先读取 Broker 描述文件并完成实例握手；App 未运行或本机 MCP 未开启时直接启动失败，不得以仅能读取静态目录的状态伪装为可用。Broker 非预期断开后适配器立即退出，由客户端按新的 App 实例重新启动。
- “本机直连”使用 App 主进程中的 Web、SSH/SFTP、日志、数据库、Redis 和巡检 Runtime；“服务端转发”桥接到当前 Endpoint。执行失败不得静默切换网络出口。
- SSH/SFTP/日志、数据库和 Redis 在同一连接配置与执行上下文内复用已建立的传输，空闲 60 秒后关闭；Web 继续复用当前页面实例。连接池只持有已建立的传输，不额外缓存明文凭据。App 登出，Endpoint、工作空间或执行模式切换，连接配置更新或删除，以及设备授权失效时立即清理相关传输。
- App 打开风险确认页时通过 `X-Viron-MCP-Origin` 传递已验证 Endpoint；开发服务器把 `/mcp` 与 `/api` 代理到同一 API target，确保开发 Endpoint 的确认页仍由主服务处理。

## 3. 当前工具面

工具注册和业务目录分别以 `src/shared/mcp-tools.ts` 与 `src/shared/mcp-business-operations.ts` 为唯一代码事实来源。当前对 MCP 客户端固定暴露 11 个网关工具，内部目录包含 198 个可发现操作：100 个原专用操作和 98 个版本化白名单业务操作。目录按 `read`、`change`、`risk`、`secure` 分级，覆盖数据库、连接与数据处理、SSH/SFTP/日志、Web、知识库和审计。

客户端不再在初始化时接收全部操作 Schema：

- `viron_context` 返回当前用户和工作空间上下文。
- `viron_domains_list` 只返回领域大纲与操作数量。
- `viron_operations_search` 按领域、关键词和模式返回操作摘要、输入字段摘要与 Schema hash，每次最多 20 项。
- `viron_operation_schema` 只返回一个操作的完整 JSON Schema；输入字段摘要足够时无需调用。
- `viron_read`、`viron_change`、`viron_risk`、`viron_secure` 按操作模式调度，继续复用原权限、白名单、确认、执行 Runtime 和审计。
- `viron_operation_status`、`viron_operation_purpose`、`viron_operation_cancel` 管理短时单次 Operation 生命周期。

主要能力包括：

- 列出当前用户有权访问的个人与组织工作空间、环境组、环境、连接组和连接非敏感元数据。
- 读取和维护环境文档、知识库目录、Markdown 内容、图片、环境关联、导入与导出。
- 读取 Web 页面结构化快照，并经确认执行点击、填写、选择、提交、导航、上传、下载和登录状态重置。
- 执行 SSH 命令、SFTP 浏览与文件操作、主机间传输、环境日志快照和连接巡检；一次只读调用可以顺序执行最多 20 条可证明为低风险的 SSH 命令，并复用同一传输。
- 执行数据库连接测试、Schema/Object/DDL/表数据读取、只读查询、结构与数据维护、导入导出、备份恢复、传输、同步、批处理和相关配置管理；一次只读调用可以顺序执行最多 20 条 `SELECT` 或 `EXPLAIN SELECT`。
- 执行 Redis 连接测试、INFO、SCAN、受控读取命令和经确认的写命令；一次只读调用可以顺序执行最多 20 条有界读取命令。
- 管理连接来源、连接导入、连接复制、环境关联、收藏、配置档、任务和活动连接。

当前目录尚未覆盖 8 月新增的服务维护、主机监控与监控告警业务，包括服务与部署编排、脚本动作、监控安装和刷新、历史与诊断、Kubernetes 上下文、告警规则和告警状态；个人环境偏好目前只覆盖别名，不包含收藏状态；SFTP 具备单文件上传与主机间传输，但客户端新增的目录拖拽、批量上传预览与冲突处理还没有一等 MCP 操作。画中画、活动环境 Dock 和界面动效属于纯客户端呈现状态，不纳入 MCP 业务目录；App 内 Agent 诊断复用的 SSH 只读批量与高风险确认执行已经由现有网关覆盖，无需重复暴露一套 Agent 专用工具。

旧专用工具名和 `viron_business_*` 工具不再直接出现在 `tools/list` 中，只作为内部 operation ID 和服务端解析入口保留。执行器按目录模式拒绝错配调用；客户端传入 Schema hash 时，过期 Schema 会被拒绝并要求重新读取单个操作定义。

### 3.1 与内置 Viron Agent 的共用关系

目标是让 Viron MCP 与内置 Pi Agent 的通用工具面直接共用，而不是分别实现后再人工保持一致。当前核心调用链已共用，协议适配层尚未完全收口：

- 远程 MCP、本机 STDIO/Broker 和内置 Agent 都以 `src/shared/mcp-tools.ts` 与 `src/shared/mcp-business-operations.ts` 为通用网关调用和业务目录来源。桌面主进程调用 `createVironMcpCompactGateway`，把生成的同一组 11 个紧凑工具名称、标题、说明和调用回调交给 `DesktopAgentRuntime`；Pi 侧没有复制另一份业务操作目录或业务 Schema。
- 因此两类 Agent 已共用操作 ID、业务 Schema hash、`read`/`change`/`risk`/`secure` 模式、权限与工作空间复核、Operation、凭据安全输入、执行 Runtime、结果限制、错误语义、审计和生命周期回收。新增普通业务操作进入共享目录后，应同时对外部 MCP 与内置 Agent 可发现，不再单独增加 Agent 私有业务版本。
- 当前 `DesktopAgentRuntime` 仍通过 `gatewaySchemas()` 单独维护 11 个紧凑工具的 Pi 参数 Schema，并通过 `gatewayRisk()`维护网关模式到审批风险的映射。后续必须让共享紧凑网关定义直接携带可转换的参数 Schema 与风险元数据，删除这两处 Agent 私有映射；完成前状态为“核心链路共用，适配层待收口”。
- 内置 Agent 额外保留当前 SSH/数据库工作台专用工具，用于读取瞬时现场、绑定可见页签、填入命令/脚本/SQL，以及把执行与原始结果留在工作台。这些是交互适配器，不是第二套通用 Viron 工具；它们必须复用对应 Runtime、只读判定、审批、取消、脱敏、输出上限和审计。后续 Web、日志、Redis 等领域沿用同一原则。
- Chatbox、历史会话、悬浮按钮、快捷输入、页面布局和动效属于内置 App 的界面状态，不进入 MCP 业务目录。外部 MCP 不通过 Renderer/IPC/CDP/坐标模拟来获得这些能力。
- 验收时，同一共享操作必须在内置 Agent、远程 MCP 和本机 MCP 三条入口核对参数校验、Schema hash、工作空间、权限、风险、审批、执行位置、结果/错误边界、审计和回收；呈现方式可以不同，授权和执行语义不得不同。该跨入口一致性测试目前尚未形成完整门禁。

## 4. 凭据、确认与安全边界

- 工具解析先经过统一禁止策略，不能提交任意内部 URL、IPC、CDP method 或账号安全路径。
- 连接和 Web 账号结果只返回必要元数据与秘密存在标记，不返回密码、私钥、Cookie、Token、TLS 私钥或完整敏感连接串。
- 数据库密码、HTTP Tunnel 认证和 TLS 客户端材料统一保存在加密凭据中；服务启动会把旧版 `options_json` 中的 TLS 材料幂等迁移到加密存储。
- 新增或更新 SSH、数据库、Redis、Web 账号、数据库连接配置档、SSH 密钥和连接来源时，Codex 只提交非敏感配置。
- 远程 MCP 创建 10 分钟有效、绑定用户和工作空间的单次安全页面，由已登录的 Viron 页面直接接收秘密。
- 本机 MCP 由 App 打开同 Endpoint、同 Session 分区的沙箱化安全窗口，秘密不经过 Renderer、STDIO、工具参数、URL 或 Operation 结果。窗口允许关闭且不阻塞主窗口；Operation 完成、失败、取消或过期时自动关闭，用户主动关闭仍在等待的窗口会取消 Operation。
- Viron 提供三档业务审批模式：“请求批准”确认全部中、高风险 Operation；“替我审批”自动执行中风险 Operation，只确认高风险 Operation；“完全访问权限”自动执行全部风险 Operation。低风险查询不受审批模式影响，始终直接执行。远程模式按个人 API Key 保存，本机模式按设备保存；现有配置默认“请求批准”。
- 凭据安全输入不受三档业务审批影响，始终要求用户在安全页面或 App 安全窗口输入；账号安全、成员与授权控制、秘密读取或导出等禁止项也不会因“完全访问权限”开放。
- SSH 命令按实际语义分级：`tail`、`grep`、`journalctl`、`systemctl status`、`kubectl get/logs` 等可证明为只读的命令及其只读管道属于低风险并直接执行；修改状态、写文件重定向或无法确认只读语义的命令按高风险处理。需要人工确认的 SSH 命令、数据库或 Redis 写入、SFTP 修改与传输、Web 提交或导航、恢复、同步等动作创建后先进入 `awaiting_purpose`，此时不返回审批页地址；MCP 响应要求 Agent 仅用 `operationId` 和 8–80 字的一句话调用 `viron_operation_purpose`，说明业务目标与原因。补充后 Operation 转为 `pending` 并展示审批页，页面把 Agent 说明标为辅助信息，同时以真实命令或操作内容为审批依据。服务端确认后直接执行；本机确认后使用不可重放的一次性租约执行。无需确认的 Operation 不进入 purpose 流程，仍保留权限校验、Operation 状态和审计，由服务端或 App 当前执行模式自动消费。
- 三种批量读取会在网关解析和实际 Runtime 两层重新校验只读策略。SSH 批量结果与审计不回显命令正文；数据库与 SSH 批量输出累计限制为 2 MiB，Redis 批量响应累计限制为 2 MiB。写入、上传、删除和 Web 提交仍逐项创建确认与审计，不能混入批量读取。
- 远程 MCP、服务端 Operation 和 App 本机执行产生的操作事件都持久化 `source=mcp`。普通人工请求和后台系统任务分别写入 `manual` 与 `system`；升级前无法可靠归因的普通业务事件保留为 `unknown`，只有动作编码已经明确为 `mcp.*` 的旧事件会安全回填为 MCP。操作审计页面展示并支持按这些来源过滤。
- Codex 的工具批准是独立的客户端安全层，不会把批准结果传给 Viron。Codex 可在对应 `mcp_servers.<id>` 下设置 `default_tools_approval_mode = "prompt" | "auto" | "approve"`；Viron 设置页给出三档推荐映射，但最终是否弹出 Codex 自己的批准由 Codex 配置决定。
- App 退出、登出、Endpoint、工作空间或执行模式切换，MCP Session 断开，API Key 或设备撤销时，必须回收受影响的 Operation、Session、流和后台任务。
- 单个 MCP/Broker 消息上限为 16 MiB，工具文本最多 512 KiB，结构化结果最多 12 MiB；超限结果返回截断标记和预览。
- Broker 连接和握手固定使用 3 秒上限；普通调用在业务操作最大执行时间之外保留有限传输余量并设置 125/130 秒双层上限。超时会清理当前连接，不能无限等待或持续阻塞同一客户端的后续调用。
- 成功工具结果只在 `structuredContent.result` 保留完整数据，文本内容只返回状态提示，避免同一结果重复进入 Agent 上下文；错误结果继续保留可直接阅读的受限文本和结构化错误。
- 知识库文档读取返回 Markdown、图片引用和图片元数据，不在同一响应中重复内嵌图片 Base64；需要图片内容时使用 `knowledge_node_export` 分项读取受限导出结果。
- 桌面 Broker 在出站结果超过 16 MiB 时返回受限错误，不发送超限消息；STDIO 连接在对端超限后可以重新连接，后续无关工具调用不受污染。

## 5. 当前完成度

| 范围 | 当前状态 | 说明 |
| --- | --- | --- |
| 远程 Streamable HTTP 与个人 API Key | 已实现，自动化已覆盖 | 已覆盖初始化、工具枚举、资源读取、跨身份拒绝和 Session 生命周期 |
| 桌面 STDIO、Broker 与握手 | 已实现，自动化已覆盖 | 已覆盖 macOS Unix Socket、Windows Named Pipe 路径、本机工具转发、结果边界和上下文清理 |
| MCP 设置页、启停与审批策略 | 已实现，自动化与客户端验收已覆盖 | App 本机 MCP 默认关闭；本机审批按设备保存，远程审批按个人 API Key 保存，支持请求批准、替我审批和完全访问权限 |
| 精简工具面与业务操作目录 | 核心能力已实现，新增业务待补齐 | 固定暴露 11 个网关工具，按需发现 198 个内部操作；服务维护、主机监控、监控告警、个人环境收藏和 SFTP 目录批量流程尚未进入目录 |
| 内置 Agent 与 MCP 工具共用 | 核心调用链已共用，适配层待收口 | Pi Agent 直接消费与远程/本机 MCP 相同的 11 个紧凑工具调用回调和业务目录；仍需把 `gatewaySchemas()`、`gatewayRisk()`并入共享定义并补齐跨入口一致性门禁。SSH/数据库保留薄工作台适配器，Web/日志/Redis/知识库/服务维护仍需按同一原则补齐 |
| 连接复用与批量读取 | 已实现，自动化已覆盖 | 两种执行模式统一使用 60 秒空闲传输复用；SSH、数据库和 Redis 提供最多 20 项的受限只读批量操作，并覆盖失效、审计和输出边界 |
| 凭据安全输入与风险 Operation | 已实现，自动化已覆盖 | 已覆盖绑定、单次消费、过期、取消、桌面一次性租约和秘密不回传 |
| 数据库 TLS 加密与旧数据迁移 | 已实现，自动化已覆盖 | TLS CA、客户端证书、私钥和口令不再保存在普通连接选项中 |
| 类型检查、全量测试、生产构建和桌面构建 | 当前源码基线已通过 | 类型检查、全量自动化、生产构建和桌面构建通过 |
| macOS arm64 App 与 DMG | 已完成 | `dist` 只保留当前 arm64 App；0.1.6 App、`viron-mcp`、深度签名、启动烟测和 DMG 校验均通过 |
| 已安装 App | 已更新并运行 | `/Applications/Viron.app` 为 0.1.6 arm64，登录态、Endpoint 与本机 MCP 可用 |
| Codex 本机与远程配置 | 本机已配置 | 只保留可用的 `viron-local`；无有效个人 API Key 的 `viron-remote` 已移除，后续远程调用需先创建短时 Key 并在验收后撤销 |
| 当前账号真实资源读取 | 已完成核心读取 | 已验证工作空间、“开发环境”、连接、环境文档和知识库；含大图片文档只返回图片元数据，不再击穿 Broker |
| 真实 SSH 双模式验收 | 已完成 | 同一“开发环境”SSH 连接在本机直连和服务端转发下均返回预期 Linux 输出与退出码 0；确认页执行位置、审计和无静默回退均已核对 |
| 数据库与 Redis 真实读取 | 服务端完成，本机受网络限制 | 服务端转发可读取 MariaDB Schema 和 Redis INFO；本机直连分别为 macOS 局域网 `EHOSTUNREACH` 与连接关闭，未修改网络权限或凭据 |
| SFTP 真实读取 | 已完成 | 本机直连可浏览目标 SSH 连接的 `/tmp`，未创建、上传、改名或删除文件 |
| 环境日志真实读取 | App 实时流正常，MCP 快照存在轮转兼容缺口 | App 的两条实时日志使用 `tail -F` 且当前均连接正常；MCP 单次快照使用 `tail -n` 时报告文件不存在，说明活动流/日志轮转语义尚未对齐，不能据此判定 App 日志配置失效 |
| Web 语义快照 | 部分完成 | 本机与服务端均到达已配置开发 URL，但页面停留在 `loading` 且语义文本、交互元素为空，仍需定位页面就绪或登录状态 |
| 数据处理、导入导出、备份恢复与写操作 | 未做真实目标写入 | 自动化已覆盖；真实验收必须使用临时、可清理对象，并在执行前再次核对影响范围 |
| Windows 安装包与目标机验收 | 不在当前 macOS 默认范围 | 仅在明确要求 Windows 时生成默认 x86 安装包并在真实 Windows 上验收 |

## 6. 续接步骤

1. 把服务维护、主机监控与监控告警按 `read`、`change`、`risk` 分级加入业务目录，并补齐个人环境收藏和 SFTP 目录批量流程；不得把监控安装、脚本执行或服务启停降级为低风险操作。
2. 修复 macOS 对 Viron 的本地网络访问状态后，重新执行本机数据库与 Redis 连接测试；不得通过改凭据掩盖网络路径问题。
3. 对齐日志轮转场景下 App `tail -F` 与 MCP 单次 `tail -n` 的目标解析语义，再分别验证“开发环境”两条当前正常实时流的本机直连和服务端转发快照；不得把快照的文件不存在直接解释为 App 连接失败。
4. 定位 Web 快照停留在 `loading` 的原因，验证页面就绪、账号登录状态、非空语义文本和交互元素，并确认快照结束后活动连接被回收。
5. 如需继续远程 MCP 验收，创建短时个人 API Key，完成目标调用后立即撤销；不得复用已撤销的验收 Key。
6. 对数据库、Redis、SFTP、Web、连接巡检、导入导出、备份恢复和数据处理补充真实写入验收时，只使用自动过期或可立即清理的临时对象，并核对审计与清理结果。
7. 补充 App 退出、登出、Endpoint/工作空间切换、MCP 断开、Key/设备撤销和资源失权后的完整回收验收。
8. 继续开发后重新运行 `npm run typecheck`、`npm test`、`npm run build` 和 `npm run build:desktop`，并运行 MCP 聚焦测试：

   ```bash
   npx vitest run tests/mcp.test.ts tests/desktop-mcp-broker.test.ts tests/desktop-mcp-security.test.ts tests/vite-config.test.ts
   ```

9. 按当前机器架构重新打包、安装和验证 App；Windows x86 安装包只在明确要求或 Windows 目标机验收时生成。

## 7. 维护要求

- 新增、修改或删除 Viron 用户业务操作时，同步更新内部专用操作或白名单业务目录；账号安全例外必须显式登记，外部固定网关工具不得随业务数量膨胀。
- 紧凑网关定义必须同时提供外部 MCP 注册和 Pi `AgentTool` 转换所需的参数 Schema 与风险元数据；删除 `gatewaySchemas()`、`gatewayRisk()` 这类 Agent 私有映射后，新增通用业务操作还必须同时验证内置 Agent、远程 MCP 和本机 MCP 的目录可见性与执行语义。工作台专用适配器只能增加当前页签绑定和可见呈现，不能改变授权、审批、Runtime 或审计结论。
- Web、MCP 和桌面 App 必须复用同一权限、凭据、确认、执行 Runtime 和审计语义，不通过界面模拟实现能力对等。
- 远程 MCP 默认保持关闭，由 `VIRON_MCP_ENABLED` 显式开启；本机 MCP 开关独立、默认关闭，不得因服务端状态或版本升级自动开启。
- 网关工具数量、内部操作数量和业务目录数量变化时同步更新本文件，避免文档与代码事实不一致。
- 验收状态只描述当前有效结果；完成后直接替换旧状态，不追加按日期展开的执行历史。
