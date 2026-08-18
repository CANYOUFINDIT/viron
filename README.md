<p align="center"><img src="design/logo/viron-logo.svg" alt="Viron" width="180" /></p>

# Viron

Viron 是以环境为中心的 Web 运维工作台。它统一保存 Web 页面与多账号、SSH 主机、MySQL/MariaDB 和 Redis 连接，并在浏览器与桌面 App 中提供真实 SSH/SFTP、数据库和 Redis 维护能力。

产品品牌和环境变量命名统一使用 Viron；旧 `ENVMAN_*` 环境变量不再兼容，启动时会给出对应的 `VIRON_*` 新名称。为避免破坏已有实例，浏览器存储键、Cookie 和 `/data/envman.db` 等持久化标识仍保留原值。

这是一套可运行的产品实现，不是 HTML 原型。完整范围、架构、安全边界、数据模型和逐项验收标准见 [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md)。

面向使用者、组织管理员和平台管理员的完整功能说明与操作步骤见 [Viron 0.1.6 全功能介绍与操作手册](./docs/USER-GUIDE.md)。

## 已实现能力

除单独标明的 macOS App 条目外，下列 Web、SSH、SFTP、日志、数据库和 Redis 执行能力均指普通 Web 客户端通过中心服务执行；macOS App 的当前范围以本节最后一项为准。

- 平台用户自主注册和登录；设置页固定以“个人信息”“外观与语言”开头，个人信息展示当前账号的用户名、平台角色、账号 ID 和注册时间，并集中提供修改密码与退出登录。Viron 支持中文和英文，尚未保存语言偏好时由系统首选语言决定默认值（`zh-*` 使用中文，其他语言使用英文），之后按当前浏览器或桌面 App 本地保存，并同步切换共享界面、组件文案和桌面原生菜单。“外观与语言”还提供默认关闭、按当前设备保存的连接质量悬浮面板：常态分段展示本机到 Viron、Viron 到最近活动目标的延迟以及最近 5 秒真实业务上下行吞吐，展开后可切换本人其他活动目标、查看抖动与失败率，并手工测试本机到 Viron 的 256 KiB 上下行和刷新目标 TCP 延迟；探测不会在目标机写文件或执行命令。桌面 App 使用独立透明原生层承载该面板，避免被内嵌目标 Web 页面遮挡，普通 Web 使用相同面板样式与语义。桌面 App 额外提供快捷键设置，可录制、清除、恢复和保存搜索、新建、关闭当前页签、保存/提交、刷新及执行等业务快捷键；`Cmd/Ctrl+Shift+W` 固定关闭窗口。平台管理员仍可创建、停用账号和重置密码。
- 普通 Web 的侧栏提供“下载客户端”入口，登录用户可以查看当前服务 `DATA_DIR/installers` 根目录中与服务端版本一致、平台和架构可识别的非空 macOS `.dmg` 与 Windows `.exe` 安装包，并按平台、版本、架构和文件大小选择下载；同一目录也是 App 登录前自动更新的唯一安装包来源，其他版本、未知架构、其他扩展名、嵌套目录和空文件不会被公开。
- 个人与多组织工作空间、同时受有效期和名额限制且可维护的组织邀请链接、成员邀请人追溯、组织管理员/成员、层级项目组与项目组成员，以及环境组、环境和连接的成员/项目组授权；所有资源访问由服务端按当前工作空间校验。
- 工作空间级 SSH 密钥管理：个人空间所有者与组织管理员可以导入外部私钥、生成 ED25519/RSA 密钥对、复制或导出公钥、显式确认后导出私钥，并让多条 SSH 连接引用同一密钥。普通组织成员看不到密钥管理入口和接口，只能通过已获授权的连接使用组织密钥；旧版内嵌私钥连接继续兼容并可逐条迁移。
- 一层可选环境组；环境组和组内环境卡片支持拖动排序，环境也可拖到其他组或未分组；组织成员可为环境设置仅自己可见、跨客户端同步的别称，卡片 Tab 优先显示别称而地址栏保留共享原名；有组/无组环境及 Web 入口、多登录账号完整维护。
- 环境详情的 Web、SSH、日志、数据库、Redis 和服务维护工作区使用统一尺寸；切换页签、菜单、路由或进入其他业务页面时保留已打开的工作区和交互内容，返回后继续操作。当前工作空间中每个已经建立 Web、SSH/SFTP、日志、数据库或 Redis 真实连接的非前台环境都会以 16:9 最后可见画面进入全局画中画叠层；多个环境默认重叠，鼠标悬浮或点击叠层时沿固定左边线纵向展开，切换后叠层锚点保持不动，点击任一缩略图按该环境最后访问的工作区和保留现场精确返回。缩略图内部不可操作，按住卡片任意非按钮区域即可移动并吸附整个叠层，关闭按钮会确认后关闭该环境的全部活动连接；最后一条连接关闭、过期或失去权限后对应环境自动消失。普通 Web 使用页面内画中画层，macOS/Windows App 使用不会激活或夺取主窗口焦点的独立透明原生子窗口，并保持在内嵌目标 Web 页面上方。环境沉浸模式以可折叠树替代顶部页签，折叠把手可拖动并吸附到左、右或顶部边缘，鼠标悬浮时自动展开、移出面板后自动收起；Web 入口按“网站 → 登录账号”展开，SSH、日志、数据库、Redis 和服务维护保持一级入口。服务维护入口分别显示服务数和已监控宿主机数。
- 服务维护以业务服务为中心关联多台 SSH 机器上的部署节点，工作空间所有者或组织管理员可以在当前环境内拖动服务清单和 SSH 宿主机清单排序，也可以通过上移、下移菜单精确调整；该顺序由工作空间共享且不改变 SSH 连接在其他页面的排列。服务可从 `viron-monitor` 扫描到的 systemd、Docker、Podman、Supervisor、Kubernetes 和普通进程候选中选择纳管，也可手工登记；宿主机工作区用页签切换监控与服务发现，发现页支持搜索，并按 systemd、Docker、Kubernetes 和状态筛选，进入时默认选中第一个有候选的类型；选中 Kubernetes 后可继续按 context/namespace/资源类型筛选并管理扫描 context。Kubernetes 先在目标机发现 kubeconfig/context 的非敏感元数据，用户选中 context 后再由目标机本地扫描 Deployment、StatefulSet 和 DaemonSet。页面支持经现有 SSH/跳板链路一键预检、安装或更新 Linux `amd64/arm64` 监控服务；常驻采集以 root 运行以读取 root/普通用户 kubeconfig 和容器运行时，普通 Viron SSH 用户只通过 `viron-monitor` 组限制的本地 Unix Socket 请求固定的一次采集，不获得任意 root 命令能力，Viron 也不保存 root 密码。首次安装或旧节点迁移仍需 root 登录或免密 sudo，同版本但缺少当前采集能力标识的旧节点也会明确提示更新。安装期间以可关闭、可恢复的弹窗展示真实步骤、耗时和脱敏详细日志，失败后从完整预检重新安装。页面无感刷新服务/节点状态，并提供宿主机 CPU 分项、内存与 Swap、负载、磁盘容量与 I/O、网络吞吐与错误、PSI、温度、运行时间及部署节点 CPU、内存、运行时间和重启次数趋势。CPU、内存和磁盘 I/O 使用固定区间 Top 5 加“其他进程”的堆叠组成图，悬浮展示该采样点真实 Top 5；采集只保存 PID、进程名、可执行文件 basename、运行用户和资源数值，不保存完整命令行、参数或环境变量。中心同时计算平均、P95、峰值、变化方向，并标记 CPU 饱和、I/O 等待、阻塞型高负载、内存压力、活跃换页、磁盘 I/O 压力和网络错误区间。环境级告警可以独立配置宿主机离线、CPU、内存、磁盘使用率、温度、磁盘挂载变化和部署节点状态；拉取失败、监控程序缺失、协议异常或采集样本持续未更新都会进入宿主机离线判定。磁盘以设备和挂载路径建立静默基线，新增、消失和恢复均连续确认两次，并通过站内、macOS/Windows 原生通知及已授权 Web 系统通知提示；排除磁盘和虚拟文件系统不参与判断。页面还提供关联日志直达、标准启动/停止/重启动作，以及可配置名称、图标和 Shell 正文的服务级、节点级功能按钮。节点端使用 SQLite/WAL 保留最近 30 天数据，中心按连接独立游标自动拉取且不删除节点数据；用户可以显式清理目标机本地缓冲，中心已入库数据不受影响。目标机不需要向 Viron 回连或开放新端口。
- 侧栏持续显示“当前连接数/单用户最大连接数”，并进入统一的当前连接页。普通用户查看和关闭自己的 Web、SSH、日志、SFTP、数据库与 Redis 逻辑会话，平台管理员可以查看和关闭全部用户连接；用户额度跨设备、客户端、执行模式和工作空间累计，达到上限后拒绝新连接且不抢占已有资源。
- Web 多账号工作区：选中入口和账号后先显示待访问状态；前台环境稳定约 1.5 秒后，Viron 只静默预热当前默认选中的一个账号页面，用户首次点击即可直接使用。预热仅在页面可见且未启用省流模式时发生，不扩展到第二个账号；用户尚未操作页面就切换工作区、离开环境或隐藏应用时，立即关闭该预热页面并释放活动连接。用户也可以直接双击页面空白处、点击“访问页面”或地址栏中的“新建”立即建立连接。每个账号使用独立持久化 Chrome Profile，同一账号的弹窗、子页面和用户主动创建的空白标签页共享该 Profile，不同账号之间保持隔离。地址栏的新建按钮始终可用，未访问时点击会建立当前账号 View 并创建空白页；同一账号存在多个页面时，入口与账号 Tab 下显示同风格的第三行页面 Tab，页面可直接切换、关闭，并可从标签栏末尾继续新建。全屏或沉浸模式会自动附着同账号 View 并保留多页面标签；支持自动填充、上传下载和登录态恢复，已访问账号在环境详情内持续保留，隐藏时暂停画面流，切回立即恢复。
- SSH/数据库/Redis 手工连接、基于现有配置创建独立副本、单连接关联多个环境、统一资源池、待分配队列和批量关联；资源池连接组支持逐组或一键展开折叠，并通过“数据处理”入口进入连接同步、个人资源向组织复制与授权和 SSH/数据库/Redis 批量巡检。Redis 是独立资源类型，可直接授权给组织成员或项目组，密码与 TLS 私钥不会返回列表或 Renderer。
- SecureCRT INI/Session/ZIP 导入、SFTP 同步源、Cron 定时同步、Password V2 解密和跨来源冲突处理。
- Navicat 15–17 NCX/XML/ZIP 导入、V2 密码解密、TCP、SSH Tunnel、SSL/TLS 和 Navicat `ntunnel_mysql.php` HTTP Tunnel。
- `ssh2` 真实终端、密码/工作空间密钥/旧版内嵌私钥/keyboard-interactive/单级跳板机、多会话、单窗/左右/上下/四宫格、拖拽调节和刷新恢复。
- SSH 登录脚本、按用户与连接隔离的本地命令历史、服务端命令收藏及输入建议；本地历史在断开或重连后继续保留，仅在清理浏览器站点数据或手工清空时删除，收藏不受浏览器缓存清理影响；建议优先匹配命令前缀，支持鼠标或方向键选择并用 `Enter`/`Tab` 回填，历史与收藏回填均不自动执行。
- SSH 终端完成文本选择后自动复制；桌面 App 通过系统剪贴板可靠复制，并支持右键直接粘贴，普通 Web 不提供右键粘贴，继续使用 xterm 的 `Ctrl/Cmd+V` 键盘路径。复制或粘贴失败时会明确提示。
- 基于 ZMODEM 的浏览器 `rz`/`sz` 文件传输。
- SSH 工作台内置右侧抽屉式双栏 SFTP 文件传输：从终端工具栏打开后保留左侧服务器列表，并始终露出一部分 SSH 终端；每次打开时左栏一次性沿用最近操作的 SSH 会话和已识别的当前绝对路径，路径不可访问时回退根目录，打开后不再跟随终端 `cd`。左右栏可独立切换 SSH 主机，通过面包屑浏览或双击手动输入路径，并使用筛选与“操作”菜单管理文件。环境内优先推荐当前环境连接，同时允许选择当前工作空间内其他有权访问且网络可达的 SSH 连接。文件列表支持 `Command/Ctrl` 独立多选和 `Shift` 连选；已选文件或目录可以拖到另一栏当前目录或指定目录，Finder/资源管理器也可以向任一远程栏拖入多项，桌面 App 还可把远程多项原生拖出。传输先递归预检，零冲突直接后台执行；同名目录静默合并，只有同名文件或文件/目录类型冲突才弹窗，并可逐项跳过、覆盖、取消或“应用全部”。保留上传、下载、创建目录、重命名、删除、chmod、进度、取消和失败重试；普通 Web 由中心服务中转，macOS App 由本机同时直连两端；两端均生成 asciinema 格式终端录像。
- 环境日志查看器：每个配置可通过指定 SSH 连接对 1–10 个绝对路径执行受控的多文件 `tail -n <1–5000> -F`；启用 SSH 登录脚本时先在交互式通道执行脚本，再从脚本进入的目标环境启动 `tail`；默认行数上限为每个文件最近 200 行，用户可在双击启动前调整，同一上限也控制当前屏幕展示窗口；最多 3 路日志流且切换配置不会断开后台跟踪，支持日志级别与关键字段高亮、关键字过滤、区分大小写、上文/下文/上下文行数、当前屏幕日志下载、侧栏折叠和宽度拖拽、独立停止/重连、`Ctrl+C` 快速停止当前日志流、`Enter` 快速重新连接、清屏和自动滚动。
- MySQL/MariaDB 使用彼此独立的连接列表、数据库对象列表和主工作区，并沿用 Navicat 的对象页签与操作命名；连接行单击只选中，双击或回车才建立连接，主动关闭后清除连接与对象选中状态。数据库/数据表收藏单击后自动连接，在对象列表中展开并定位目标，数据表收藏直接打开数据页。对象树按 Navicat 显示“表、视图、函数、事件、查询、备份”，每级使用独立展开箭头，其中存储过程与函数统一归入“函数”，查询展开后按数据库显示 SQL 收藏，备份展开后显示该数据库的任务及进度；数据库、分类和具体对象均提供 Navicat 顺序的右键菜单，右键同时选中目标，具体对象才启用打开、设计、删除、复制、重命名等对象操作，转储、维护和分组使用可键盘访问的子菜单。现有 DDL、导入导出、备份恢复、数据库查找和任务能力直接从菜单进入；`Cmd/Ctrl+F` 在对象页聚焦当前列表搜索，在数据库节点上下文打开跨分类对象查找，在未选择数据库时聚焦连接搜索。新建表使用字段、索引、外键、触发器、检查、选项、注释和 SQL 预览组成的可视化设计器并通过 `Cmd/Ctrl+S` 保存；已有对象仍可查看和编辑 DDL。权限管理、打印、模型设计、对象分组和外部编辑器等不在当前产品边界内的入口保留为带原因的禁用项。对象页继续提供打开、DDL 设计、新建、删除、导入、导出、刷新、详细信息和 ER 图表视图，纯图标操作悬浮显示名称。SQL 继续使用 Monaco 多页签并支持补全、格式化、执行、EXPLAIN、取消、历史和收藏。
- Tabulator 数据网格、分页/排序/筛选、列显隐、网格/表单视图、主键保护的批量增删改、提交/回滚、CSV/XLSX/SQL 导出和 CSV/XLSX 导入；所有数据列默认随横向滚动，不固定首列。
- SQL 备份/恢复和 Navicat 风格的跨数据源数据库操作：数据传输保留一次性结构/数据复制；数据同步先按主键比较表，再独立控制目标记录的插入、更新和删除，每张表在独立事务中提交；结构同步先比较并选择表列、主键、索引、外键、检查约束、字符集/表选项、视图、函数/存储过程、触发器和事件，执行前显示将应用到目标数据库的 SQL，并标记删除或替换操作。分区和表达式索引等暂不能安全生成差异 SQL 的对象会显示为“需处理”，不会自动执行。
- Redis Standalone 工作台：TCP、TLS、复用已有 SSH 连接的 SSH Tunnel、ACL 用户名/密码、逻辑库和可信执行端只读策略；连接列表、逻辑库切换、安全 SCAN 浏览与分隔符分组、String/Hash/List/Set/Sorted Set/Stream 常用维护、二进制 UTF-8/JSON/Hex/Base64 查看与输入、COPY/RENAME/UNLINK/TTL/PERSIST、Monaco 受控命令、INFO 和 Slow Log。工作台明确显示只读状态、连接/扫描错误、键空间摘要和执行结果，未知、高危、脚本、管理、订阅和无界读取命令默认拒绝并审计；界面最多保留 10,000 个扫描键，单响应限制 2 MiB。
- AES-256-GCM 凭据加密、自动托管主密钥、可选 SQLite WAL 或 MySQL/MariaDB 元数据库、操作审计，以及密码保护的跨实例迁移。组织管理员可在操作事件、终端录像和 SQL 历史中查看当前组织各成员的操作；普通成员只看到本人记录。三个页签默认保留近 30 天数据，支持按用户和非敏感关键字组合过滤及分批加载，不以固定条数截断可查询总量；操作事件展示成员、资源、来源 IP、人工/MCP/系统来源标签和最多三项非敏感详情摘要，并可按来源过滤。无法可靠判断来源的旧记录明确标记为“历史未知”。
- 中文、英文以及浅色、深色和明亮三种高密度运维 UI；语言和主题选择只保存在当前浏览器或桌面 App 本地，不区分登录账号。语言切换会自动刷新共享界面，主题切换不刷新页面或销毁活动工作区。明亮主题只保留最外侧用户菜单栏为深色，连接列表、资源树、终端、实时日志、数据库、Redis、SFTP、历史面板及业务弹窗等其余产品界面统一使用浅色背景；侧栏、顶部栏和内容区继续使用同一视口坐标的连续工程网格，桌面和平板布局可用。
- Viron MCP：Web 与桌面 App 都在“设置 → MCP”展示服务端开关状态、连接信息和当前账号的客户端；服务端由 `VIRON_MCP_ENABLED` 控制且默认关闭。桌面 App 另提供默认关闭、按设备持久化的本机 MCP 开关，开启后才启动 `viron-mcp` 使用的 Unix Domain Socket 或 Windows Named Pipe Broker。Codex 可以读取当前账号有权访问的工作空间、环境、连接、文档和知识库，并调用 Web、SSH/SFTP、日志、数据库、Redis、连接巡检、导入导出、备份恢复和数据处理能力；账号安全、权限控制和秘密读取/导出始终排除。写入和外部执行使用短时单次 Operation 由 Viron 再确认，连接密码、私钥、Cookie、Token 和 TLS 私钥不会进入 MCP 参数、状态页或结果。
- macOS App：安装包内置完整静态界面，通过主进程验证 Viron Endpoint、协商 API 协议，并按 Endpoint 隔离持久 Session Cookie；本机 Web、SSH/SFTP、环境日志、MySQL/MariaDB、Redis 和连接巡检复用普通 Web 工作台交互，但目标流量由当前 Mac 直接发出。Redis 密码、TLS 私钥和 SSH Tunnel 凭据通过绑定设备与资源版本且 60 秒有效的一次性 AES-GCM 信封进入主进程，不跨 preload；本机 Redis 执行和巡检结果使用设备私钥签名回传中心，失败不回退到服务端。

## Docker Compose 部署

要求 Docker 24+ 和 Docker Compose v2。

1. 准备配置：

   ```bash
   cp .env.example .env
   ```

2. 修改 `.env`，至少替换首次启动管理员密码。`HOST` 表示宿主机对外绑定地址，`127.0.0.1` 只允许本机访问，局域网或公网入口使用 `0.0.0.0`；`PORT` 同时作为宿主机和容器服务端口。生产环境保持 `ALLOW_WEAK_PASSWORDS=false`；只有本地开发需要使用临时弱密码时才设为 `true`。直接使用 HTTP 时保持 `COOKIE_SECURE=false`；只有在 HTTPS 反向代理后面部署时才设为 `true`。

   元数据库默认使用 `DATA_DIR/envman.db`：

   ```dotenv
   DATABASE_DRIVER=sqlite
   ```

   也可以改用已有的 MySQL 8+/MariaDB 10.6+ 数据库：

   ```dotenv
   DATABASE_DRIVER=mysql
   DATABASE_HOST=127.0.0.1
   DATABASE_PORT=3306
   DATABASE_NAME=viron
   DATABASE_USERNAME=viron
   DATABASE_PASSWORD=replace-with-strong-password
   DATABASE_POOL_SIZE=10
   ```

   目标数据库必须事先创建，账号需要建表、索引及读写权限。应用会在启动时幂等创建当前版本的表结构。Docker 中的 `127.0.0.1` 和 `localhost` 会自动指向宿主机；远程地址、域名和 Compose 服务名原样使用。

   桌面客户端版本与服务端使用根目录 `package.json` 中同一个 SemVer。Web 手工下载与 App 登录前自动更新共同扫描 `DATA_DIR/installers/`，不再分别配置安装包路径。源码默认目录为 `./data/installers/`；Compose 会把宿主机的 `DATA_DIR` 挂载为容器内 `/data`，因此安装包位于容器内 `/data/installers/`。

   文件名使用 `Viron-<version>-<platform>-<architecture>-...`。服务只发布版本与当前服务端完全一致、平台可由 `.dmg/.exe` 识别、架构包含 `arm64`、`x64`、`x86` 或 `universal`、位于目录根层且非空的普通文件；同一平台和架构存在多项时稳定选择最近更新的一项。Web 页面可见的每个包都会同时进入自动更新，macOS `arm64/x64` 与 Windows `x86/x64/arm64` 优先使用精确架构，缺少精确包时回退到同平台 Universal 包。目录内容在每次请求时重新读取，无需重启服务；旧版本或无法识别的文件可以保留，但不会对用户公开。

3. 选择一个服务端版本构建并启动：

   ```bash
   # Lite：供桌面客户端连接，不含浏览器客户端静态资源和 Chromium
   docker compose -f docker-compose.lite.yml up -d --build

   # Full：同时支持桌面客户端和浏览器客户端，内置 Chromium
   docker compose -f docker-compose.full.yml up -d --build
   ```

   两个 Compose 文件都会启动对外的 `viron` 主服务和不发布端口的 `script-runner`。Lite 使用 `viron-server-lite:0.1.6`，保留桌面客户端 API、SSH/SFTP/日志/数据库/Redis 服务端转发以及目标网站本机直连所需的凭据接口，但不提供浏览器客户端和目标网站服务端转发。Full 使用 `viron-server-full:0.1.6`，在同一 Origin 提供静态页面、API、WebSocket 和全部服务端转发能力；Chromium 只在用户双击页面空白处或点击“访问页面”后按需启动。Runner 使用 `viron-script-runner:0.1.6`，只通过 Unix Socket 接收隔离脚本任务，不挂载 Viron 数据目录或主密钥。

   Compose 默认把各目标的 BuildKit 缓存持久化到 `.tmp/docker-build-cache/compose/`。Full 的 Chromium 与字体运行时层独立于应用源码；第一次构建或显式刷新需要安装系统依赖，之后修改源码不会重新执行该安装层。需要强制刷新依赖时先执行 `docker compose -f docker-compose.full.yml build --no-cache`，Lite 使用对应 Compose 文件。可用 `VIRON_DOCKER_CACHE_DIR` 调整缓存目录，并用 `VIRON_DOCKER_REGISTRY_MIRROR`、`VIRON_APT_MIRROR`、`VIRON_APT_SECURITY_MIRROR` 覆盖默认镜像源。

4. 桌面客户端的 Viron Endpoint 与 Full 的浏览器地址都是 `http://服务器地址:<PORT>`；未修改时为 `http://127.0.0.1:8080`。健康检查为同一 Origin 的 `GET /healthz`，能力接口通过 `clientAccess.web` 和 `serverForwarding.web` 区分两个版本。无需登录的 `GET /api/v1/version` 返回当前服务端版本、API 协议版本，以及统一安装包目录中 macOS `arm64/x64`、Windows `x86/x64/arm64` 的下载状态；安装包下载接口同样无需登录，以便 App 在登录前升级。

`DATA_DIR` 始终表示宿主机数据目录，Compose 自动挂载到容器 `/data`。容器以非 root 用户运行；首次启动会生成 `DATA_DIR/master-key` 并以 `0600` 权限保存。删除或重建容器不会改变主密钥；已有加密数据但密钥文件缺失、不可读或不匹配时，Viron 会拒绝启动。

升级仍使用旧版 `./secrets/master_key` 的实例时，应在切换前停止服务并执行 `cp ./secrets/master_key ./data/master-key && chmod 600 ./data/master-key`。需要由外部密钥管理系统托管时，使用 `VIRON_MASTER_KEY` 或 `VIRON_MASTER_KEY_FILE`；任何 `ENVMAN_*` 环境变量都会使启动失败，不会被静默忽略。

## 使用离线镜像

发布目录中的单架构压缩包必须与当前 `package.json` 版本一致，才能与当前 Compose 文件一起使用。根据目标 Linux 主机选择 `amd64` 或 `arm64`：

```bash
VERSION="$(node -p "require('./package.json').version")"
test -f "release/viron-server-${VERSION}-linux-amd64.tar.gz"
docker load -i "release/viron-server-${VERSION}-linux-amd64.tar.gz"
# ARM64 主机改用 release/viron-server-${VERSION}-linux-arm64.tar.gz
docker compose -f docker-compose.full.yml up -d --no-build
# Lite 部署改用 docker-compose.lite.yml
```

每个架构的离线包都包含同一发布版本的 Lite、Full 与 Script Runner 三个镜像，导入后无需访问镜像仓库。旧版本离线包不能与当前 Compose 标签混用；当前版本文件不存在时必须先按发布流程构建并导出服务镜像。

## 用户密码重置

本地开发：

```bash
npm run admin:reset -- admin 'new-password'
```

容器内：

```bash
docker compose -f docker-compose.full.yml exec viron node dist/server/cli/reset-admin-password.js admin 'new-password'
```

重置后该用户的现有会话会全部失效。`ALLOW_WEAK_PASSWORDS=false` 时，平台用户密码至少需要 10 个字符，并包含大写字母、小写字母、数字、特殊字符中的至少 3 类；该规则覆盖首次管理员、注册、平台建号、改密、重置和迁移 CLI。设为 `true` 时只拒绝空密码，已有密码不会在切换配置时自动失效。

`ADMIN_PASSWORD` 只用于数据库中还没有管理员的首次启动。平台初始化后修改 `.env` 不会覆盖现有密码，必须使用页面或上述 CLI 重置。

## 工作空间与现有实例迁移

- 每个用户都有独立的个人工作台，并可加入多个组织；左侧栏的工作空间选择器决定当前资源范围和新建资源归属。
- “组织与用户”页面只列出当前账号已加入的组织，并提供独立的“创建新组织”和“通过邀请链接加入”入口；创建组织不要求先切换到个人工作台。受邀用户可以在 Web 或 macOS App 中粘贴完整邀请链接，进入同一邀请确认页面。
- 组织管理员在“组织与用户”页面通过弹窗组合选择 1 小时、24 小时、7 天或 30 天有效期，以及 1、3、5、10、不限或 1–10000 的自定义可加入人数，并可指定一个项目组。页面持续列出已创建链接的创建者、目标项目组、到期时间、状态、已用和剩余名额，以及通过每条链接加入组织或项目组的用户和使用时间；支持重新复制、手工撤销和删除列表记录。删除记录采用审计保留的软删除，会立即使链接失效但不影响已经加入的用户。有效期结束、名额耗尽、撤销或删除后，服务端拒绝继续加入。受邀者已有平台账号或自主注册后登录，访问链接确认邀请人与组织并主动加入；新成员默认是普通成员，成员目录记录其邀请人，指定项目组时自动归组。已经属于组织但尚未进入目标项目组的成员也可以使用该链接归组。目标项目组被删除后，未使用的链接降级为仅加入组织。
- “组织与用户”以组织架构树为主体：组织下可创建任意层级项目组，项目组下展示直属成员，未归组成员直接展示在组织节点下；成员可以同时属于多个项目组。点击组织、项目组或成员可查看基本信息、归属关系和有效资源授权，并在对应项目组或成员节点一次多选同类型资源维护授权。普通成员的最终权限是个人直授、所属项目组及其祖先项目组授权的并集，不能查看明文凭据或修改组织资源配置。
- 平台管理员负责平台账号，但不会仅凭平台身份获得其他用户个人资源或组织资源访问权。
- 组织管理员可以在“连接资源池 → 数据处理 → 连接复制”中多选自己的个人连接、环境或环境组，预览并排除 Web 账号、日志等子资源，处理组织同类资源的“新建副本/复用”冲突，选择项目或成员授权后原子提交。跳板机、数据库 SSH Tunnel 和日志依赖会自动补齐，同一连接关联多个环境时只生成一份组织副本；密码与私钥在服务端重新加密，浏览器 Profile、Cookie、终端历史和 SQL 历史不复制，后续修改互不联动。

旧的单管理员实例需要在停止 Viron 服务后，把既有个人资源迁给指定普通用户。命令会在目标用户不存在时创建账号，已存在时将其启用并重置为本次指定密码，然后幂等迁移资源归属、收藏、任务、录像和本地 Web Profile；密码只通过本次命令传入：

```bash
./scripts/dev-service.sh stop
npm run user:migrate -- operator 'controlled-initial-password' admin
./scripts/dev-service.sh start
```

容器部署应先停止自动重启并运行一次性 CLI，再恢复服务：

```bash
docker compose -f docker-compose.full.yml stop viron
docker compose -f docker-compose.full.yml run --rm viron node dist/server/cli/migrate-user-system.js operator 'controlled-initial-password' admin
docker compose -f docker-compose.full.yml up -d viron
```

全新实例不要执行该命令，也不会自动创建 `operator`。

## 从 SQLite 迁移到 MySQL/MariaDB

先停止 Viron，保留 `DATA_DIR/envman.db`，再把 `.env` 的 `DATABASE_DRIVER` 和 MySQL 连接项配置完整后执行：

```bash
./scripts/dev-service.sh stop
npm run database:migrate:mysql
./scripts/dev-service.sh start
```

迁移命令会创建目标表结构，但要求全部业务表为空；目标已有任意业务数据时会直接拒绝，不会覆盖。复制在单一事务中完成，并逐表比较 SQLite/MySQL 行数、检查源 SQLite 外键和目标 MySQL 外键孤儿。验证完成前不要删除 SQLite 文件；迁移成功后它作为人工回退副本保留，运行中的 MySQL 模式不会继续写入该文件。

## 跨实例迁移与基础设施备份

- 平台管理员可以在设置页设置至少 12 个字符的迁移密码并导出迁移包。SQLite 使用一致性快照，MySQL/MariaDB 在事务中生成同构的可移植快照；迁移包同时包含终端录像和数据库备份。
- 来源主密钥使用 `scrypt` 派生密钥和 AES-256-GCM 加密后进入迁移包，不会裸明文落盘。目标实例导入时只在内存解开来源密钥，并用自己的主密钥重新加密全部凭据；迁移密码不会保存。
- 导入经过格式、数据库完整性、外键、迁移密码和重放校验，暂存成功后需要重启 Viron。SQLite 原子替换数据库文件，MySQL/MariaDB 在事务中替换平台表；两种模式都会先保留恢复前数据库副本。
- 迁移包用于实例间搬迁，不能替代基础设施备份。仍应备份完整 `./data`；MySQL/MariaDB 还应使用数据库服务自身的备份和时间点恢复能力。忘记迁移密码后无法使用对应迁移包。

## 脚本同步、SecureCRT 与 Navicat

- “连接来源与同步”支持新建脚本同步源。个人空间所有者和组织管理员可以保存 `/bin/sh` 脚本、选择同名资源“直接忽略”或“无条件覆盖”，并手动执行或使用 Cron 定时执行。
- 脚本在独立受限 Runner 容器中运行，通过标准输出返回版本化 JSON；Viron 自动写入当前空间的环境组、环境、Web 入口与账号、SSH 密钥、SSH/数据库/Redis 连接及连接组、数据库配置档和环境日志。
- 每轮同步自动提交或整批回滚，只生成不含凭据的审阅报告。空间已有但脚本未返回的资源只记录为“空间额外”，不会自动删除。
- 完整格式、安全边界与示例见 [脚本资源同步](docs/SCRIPT-SYNC.md)。

- SecureCRT 本机常见的 `Config/Sessions`（主机信息）和 `Config.personal/Sessions`（密码）会按 `/Sessions/` 后的相对路径合并。
- SFTP 同步源可配置多个远端目录、密码/私钥、SecureCRT 配置口令和 Cron 表达式。
- 跨来源同协议/主机/端口/用户名的连接进入冲突队列，不会静默重复或自动覆盖。
- Navicat HTTP Tunnel 直接兼容 `ntunnel_mysql.php` 二进制协议，可配置 HTTP Basic Auth 和 HTTPS 证书校验。

### 将 SecureCRT“同步链接”脚本接入 Viron

这里的“原脚本”特指旧 SecureCRT 同步链接：SecureCRT 同步源仍不会执行它，也不会运行其中的 `sshpass`、`scp` 或 `rsync`。需要执行脚本并返回完整资源目录时，请改用“脚本同步”类型；其脚本只在隔离 Runner 中运行。

进入“连接资源池 → 数据处理 → 连接同步 → 新建同步源”，按以下关系填写：

| 原脚本信息 | Viron 字段 |
| --- | --- |
| SSH/SCP 目标主机 | 同步主机、SSH 端口 |
| `user@host:path` 中的用户 | SSH 用户名 |
| SSH 密码或私钥 | 认证方式及对应凭据 |
| 一个或多个远端会话目录 | 远端会话目录，每行一个 |
| SecureCRT 配置口令 | 配置口令；未设置则留空 |
| 原按钮的执行频率 | 手动立即同步，或可选 Cron；默认关闭定时同步 |

保存后点击“立即同步”。首次同步完成后：

1. 新连接进入待分配资源池，不会擅自归属环境。
2. 同协议、主机、端口和用户名的跨来源重复项进入冲突队列，由管理员确认保留、覆盖或合并。
3. 无法解密的 SecureCRT 密码会标记“凭据需要补录”，连接信息仍可保留。
4. 在同步源的“目录映射”中把来源路径前缀绑定到环境；以后同步的新连接会自动关联，已有明确环境关联不会被覆盖。
5. 删除同步源只解除来源关系，已经导入的连接会保留为手工连接。

## 本地开发与验证

要求 Node.js 22+。

首次准备本地环境：

```bash
npm ci --cache .npm-cache
test -f .env || cp .env.example .env
```

同一份 `.env` 可用于源码和 Docker。源码模式通过 `WEB_CLIENT_ENABLED` 决定是否启动浏览器客户端开发服务：

```dotenv
HOST=127.0.0.1
PORT=8080
DATA_DIR=./data
DATABASE_DRIVER=sqlite
WEB_CLIENT_ENABLED=true
VIRON_MCP_ENABLED=false
VIRON_MONITOR_PACKAGE_DIR=./dist/monitor
VIRON_MONITOR_PULL_INTERVAL_SECONDS=60
```

`WEB_CLIENT_ENABLED=false` 时 `npm run dev` 和开发服务脚本只启动 API；`true` 时同时启动 Vite。远程 MCP 默认关闭；只有明确设置 `VIRON_MCP_ENABLED=true` 才注册 `/mcp`，关闭时桌面 App 的本机 MCP 和相关受控 API 仍可使用。`VIRON_MONITOR_PACKAGE_DIR` 指向包含 `linux-amd64`、`linux-arm64` 子目录的监控安装包根目录，源码模式默认使用 `dist/monitor`，官方服务镜像已内置到 `/app/monitor`。`VIRON_MONITOR_PULL_INTERVAL_SECONDS` 是尚未在页面保存策略时的后台采集频率默认值；平台管理员可在“设置 → 运行策略”中以 10–3600 秒动态调整，无需重启。`NODE_ENV` 由源码命令或 Docker 镜像自动设置，不需要写入 `.env`。同时设置本地管理员账号和密码。主密钥会自动保存到 `DATA_DIR/master-key`；已有 `.env` 或数据目录时必须保留。

推荐通过项目脚本管理开发服务：

```bash
./scripts/dev-service.sh start
./scripts/dev-service.sh status
./scripts/dev-service.sh logs
./scripts/dev-service.sh restart
./scripts/dev-service.sh stop
```

在 macOS 上，该脚本通过当前登录用户的 `launchd` 服务托管开发进程；其他系统使用项目内 PID 和日志文件管理后台进程。
启动与重启默认等待 API 健康检查最多 60 秒；远程数据库或冷启动环境需要更长时间时，可以通过 `DEV_SERVICE_HEALTH_TIMEOUT_SECONDS` 调整。

启用浏览器客户端时访问 `http://<HOST>:5173`，API 健康检查默认为 `http://127.0.0.1:8080/healthz`；修改 `PORT` 后 API 和 Vite 代理共同使用新端口。API 与 Vite 都遵循 `HOST`：`127.0.0.1` 只允许本机访问，`0.0.0.0` 允许同一网络中的设备访问。浏览器客户端的业务请求始终使用当前页面同源代理，不会回落到访问设备自身的 `localhost`。

不需要后台服务时也可以在当前终端直接运行：

```bash
npm run dev
```

## Codex 与 MCP 接入

Viron 提供远程和本机两种 MCP 入口，工具名称、参数、权限、确认和结果语义一致。Web 与桌面 App 都可以在“设置 → MCP”查看服务端状态和连接地址；只有桌面 App 额外显示本机开关、STDIO 启动器、Broker 地址和本机客户端。远程入口固定在中心服务执行；本机入口复用 Viron App 当前登录的 Endpoint、用户、工作空间和“本机直连/服务端转发”设置，执行失败不会自动切换网络出口。本机审批在该页面按设备选择，远程审批在“设置 → API Key”按个人 Key 选择，均支持请求批准、替我审批和完全访问权限。

完整架构、安全边界、当前完成度和续接验收步骤见 [Viron MCP 架构、能力与验收](./docs/MCP.md)。

远程接入要求服务管理员先设置 `VIRON_MCP_ENABLED=true` 并重启 Viron，再由用户在“设置 → API Key”创建个人 API Key。平台 API Key 不能访问普通用户业务资源。把 Key 放入 Codex 进程可读取的环境变量后添加 Streamable HTTP Server：

```bash
export VIRON_MCP_API_KEY='viron_personal_...'
codex mcp add viron-remote \
  --url 'https://viron.example.com/mcp' \
  --bearer-token-env-var VIRON_MCP_API_KEY
```

本机接入不依赖服务端远程 MCP 开关，但要求 Viron App 已启动、登录并停留在要使用的工作空间，而且用户已经在“设置 → MCP”手工开启本机 MCP。升级安装不会自动开启。macOS 安装包内的 STDIO 启动器路径为：

```bash
codex mcp add viron-local -- '/Applications/Viron.app/Contents/MacOS/viron-mcp'
```

开发包可以把命令路径替换为 `dist/macos/Viron-darwin-<arch>/Viron.app/Contents/MacOS/viron-mcp`。Windows 安装包根目录提供 `viron-mcp.cmd`。可以通过 `codex mcp list` 检查配置是否已启用。

MCP 固定只暴露 11 个网关工具，不在初始化时把全部业务 Schema 注入 Codex。先用 `viron_domains_list` 获取能力大纲，再用 `viron_operations_search` 按 SSH、数据库、Redis、Web 等领域检索操作；搜索结果的输入字段摘要足够时直接调用对应执行器，只有参数不明确时才用 `viron_operation_schema` 读取单个完整 Schema。`viron_read`、`viron_change`、`viron_risk`、`viron_secure` 分别执行只读、普通变更、风险和凭据安全操作，`viron_operation_status`、`viron_operation_purpose`、`viron_operation_cancel` 管理短时单次 Operation。

创建或更新 SSH、数据库、Redis、Web 账号、数据库连接配置档、SSH 密钥和连接来源时，Codex 只提交非敏感配置。远程 MCP 返回绑定当前用户和工作空间的安全页面地址，用户必须在已登录的 Viron 页面输入秘密；本机 MCP 由 Viron App 自动打开沙箱化安全窗口。风险操作是否再次确认由当前 Viron 审批模式决定：只有真正需要人工确认的 Operation 才先返回 `awaiting_purpose`，要求 Agent 用 `operationId + 8–80 字执行意图` 调用 `viron_operation_purpose`；补充后才展示审批页面。低风险查询和自动放行 Operation 不生成、不传输 purpose，不增加逐命令说明步骤。Codex 自身的工具批准不能代替 Viron 授权。

SSH 查询命令不触发 Viron 审批：`tail`、`grep`、`journalctl`、`systemctl status`、`kubectl get/logs` 等可证明为只读的命令及其只读管道会直接执行。修改状态、写文件重定向或无法确认只读语义的命令仍创建风险确认 Operation。

Codex 的工具批准和 Viron 业务审批是两层独立设置。Codex 可在对应 `mcp_servers.<id>` 下设置 `default_tools_approval_mode = "prompt" | "auto" | "approve"`；Viron 设置页会给出与三档审批模式对应的推荐值。Viron 选择“完全访问权限”后风险 Operation 自动执行，但凭据安全输入、权限校验、审计和明确禁止的账号安全/秘密导出能力仍保持生效。

## 桌面 App 构建与安装

当前桌面版本要求 macOS 12 Monterey 或更高版本，支持 Apple Silicon `arm64` 和 Intel `x64`。构建当前 Mac 对应架构、指定架构或两个架构：

```bash
./scripts/package-macos.sh
./scripts/package-macos.sh --arch=arm64
./scripts/package-macos.sh --arch=x64
./scripts/package-macos.sh --all
```

该入口会先通过 `package-lock.json` 和项目内 `.npm-cache` 执行 `npm ci`，再进入现有构建、签名与安装包验证流程，适合依赖刚有变更或本机 `node_modules` 不完整的情况。以下 npm 命令调用同一入口：

```bash
npm run package:macos
npm run package:macos:arm64
npm run package:macos:intel
npm run package:macos:all
```

脚本会构建 Electron 主进程和完整本地前端，把桌面主进程运行依赖一同写入离线 App，在 `dist/macos/Viron-darwin-<arch>/` 生成 `.app`，并在 `release/` 生成 `Viron-<version>-macos-<arch>-self-signed.dmg`。打包过程把 `LSMinimumSystemVersion` 固定为 `12.0.0`，并逐个校验 App 内 Mach-O、动态库和原生 Node 模块包含目标 CPU 架构，同时检查 Electron 主程序与 Framework 的部署目标不高于 macOS 12.7.6。DMG 使用标准拖拽安装窗口，挂载后会并排显示 `Viron.app` 和指向 `/Applications` 的“应用程序”入口。首次构建会在当前开发用户的 `~/Library/Application Support/Viron Development/macos-signing/` 中创建专用钥匙串和 `Viron Local Development` 自签名 Code Signing 身份；后续构建复用同一身份，保证覆盖安装和产物校验使用一致的代码签名。该构建钥匙串与 App 运行数据隔离，Viron 运行时不会访问它；签名私钥只留在构建 Mac 的专用钥匙串中，不进入仓库或安装包。

自签名包用于本机开发和受控内部分发，没有 Apple 公证，也不会被其他 Mac 自动信任。安装时打开 DMG，按窗口引导把 Viron 拖到“应用程序”；首次打开若被 Gatekeeper 拦截，应在 Finder 中右键选择“打开”，或在“系统设置 → 隐私与安全性”中明确批准。面向外部用户发布仍需 Developer ID 和公证。

同一台 Mac 也可以生成 Windows x86、x64、arm64 NSIS 安装包：

```bash
npm run package:windows:x86
npm run package:windows:x64
npm run package:windows:arm64
npm run package:windows:all
```

脚本会复用完整桌面静态界面和主进程运行时，在 `dist/windows/<arch>/` 生成解包目录，并在 `release/` 生成 `Viron-<version>-windows-<x86|x64|arm64>-unsigned-setup.exe`。打包会排除 SSH 的可选宿主机原生加速模块，严格检查包内 `Viron.exe` 的目标 PE 架构、外层文件为 NSIS 安装器，并确认 `app.asar` 包含桌面入口、preload、Renderer、SSH、数据库、Redis 和导入导出运行依赖。NSIS 启动壳固定为 PE32 x86，不代表包内 App 架构。安装包未进行 Windows 代码签名，可能触发 SmartScreen；在 macOS 上只能完成跨平台构建和结构校验，x86、x64、arm64 都必须在对应的真实 Windows 环境完成启动、安装、登录、安全存储、Web、SSH/SFTP、日志、数据库和 Redis 验收后，才能声明正式运行支持。

完整发布使用独立脚本；不传版本时使用当前 `package.json` 版本，传入新版本时会永久同步 `package.json`、`package-lock.json`、Compose 镜像标签和版本化文档：

```bash
./scripts/package-release.sh
./scripts/package-release.sh 0.1.6
# 等价 npm 入口：npm run package:release -- 0.1.6
```

脚本依次完成类型检查、完整测试、生产构建、5 个客户端安装包，以及 `linux/amd64`、`linux/arm64` 两个服务镜像离线包。每个服务包都包含 `viron-server-lite`、`viron-server-full`、`viron-script-runner` 三个同版本镜像；脚本检查镜像架构与内嵌版本，最后重建 `release/SHA256SUMS`。为避免共享 `dist` 和 Docker 标签互相覆盖，所有目标顺序执行而不是并行构建。

根目录 `package.json` 是服务端、普通 Web、macOS 与 Windows 的唯一产品版本来源。App 每次启动或切换 Endpoint 后查询版本；服务端版本高于当前 App 且当前平台安装包可用时，系统原生弹窗提供“下载并安装/稍后”。确认后会打开独立更新窗口，显示 App 图标、实时字节进度和系统级进度；下载阶段可通过按钮或关闭窗口取消并清理临时文件，进入校验与安装后锁定关闭并持续显示当前状态。下载长度校验通过后执行安装：macOS 先校验并挂载 DMG，在 App 仍位于前台时完成系统授权（仅当目标目录不可写时），再退出旧进程并替换**当前正在运行的** `.app`；从只读安装盘启动时回退到 `/Applications/Viron.app`。Windows 以 NSIS `/S` 覆盖当前可执行文件所在目录，并按前三段版本号验收。App 保持单实例；安装完成前重新打开会提示等待并避免清掉临时安装文件。失败时写入 `update-install.log`、展示原因并重新打开可用的旧版本。低于或等于当前 App 的服务端版本不会触发降级安装。

App 登录页接受 HTTP 或 HTTPS Origin，包括回环地址、局域网地址和域名。macOS 可以直接启动 App 并填写实际 API 端口：

```bash
dist/macos/Viron-darwin-<arm64|x64>/Viron.app/Contents/MacOS/Viron
```

App 不替用户决定是否使用 HTTPS；只校验地址是 HTTP(S) Origin，并实际请求健康与能力接口确认对端是兼容的 Viron 服务。带路径、查询参数、Fragment 或内嵌凭据的值不是 Origin，仍会作为地址格式错误拒绝。App 不保存登录明文密码，最近一次成功 Endpoint 与每个 Endpoint 的 Cookie 容器分别持久化。

中心服务与 App 协商到 API 协议 v2 且声明 `desktopLocal.web=true` 时，环境 Web 入口会使用 App 内的本机 Chromium 账号浏览区。选中入口和账号后先显示待访问状态；前台环境稳定约 1.5 秒后，Renderer 只允许主进程静默预热当前默认账号，未发生用户交互就切走时立即关闭本机页面并释放中心登记，其他账号仍保持未访问。用户双击页面空白处、点击“访问页面”或地址栏中的“新建”可以跳过等待并立即创建页面。每个 Endpoint、Viron 用户和 Web 登录账号拥有独立持久 Profile；App Renderer 只能提交账号 ID 和视图操作，设备私钥及解封后的账号密码只存在于主进程，界面不提供明文密码查看或复制。macOS 运行时不访问系统钥匙串：Chromium 使用无钥匙串后端，设备私钥和 Viron Agent API Key 使用 App 数据目录中的安装级随机密钥进行 AES-256-GCM 加密，密钥文件权限限制为当前系统用户。拒绝读取旧版钥匙串密文时，设备身份会自动重建，旧版 Agent API Key 需要重新填写一次，原有 Chromium 登录态也可能需要重新登录。目标网站的 HTTP(S) 弹窗会作为同一账号下的独立页面打开；同一账号的页面共享 Profile，并在页面数大于 1 时通过入口与账号 Tab 下的第三行页面 Tab 切换和关闭，每个账号最多同时保留 8 个页面。弹窗和手工新建页面不会自动填充密码；用户明确点击钥匙按钮时，可以在入口原始 Origin 的当前活动页重新识别和填充。目标网页的原生右键菜单按点击上下文提供后退、前进、重新加载、链接在同账号新标签页打开、复制链接，以及输入或选区的撤销、重做、剪切、复制、粘贴和全选；“检查元素”由主进程为当前页面打开分离的 Chromium DevTools 并定位到点击位置，不向 Renderer 暴露 `webContentsId`、调试协议或任意页面执行接口。DevTools 可以读取和修改当前账号页面的 DOM、网络与存储，只应在用户确认有权调试目标网站时使用，页面关闭后对应调试会话一并销毁。网站文件输入直接使用 Chromium 原生文件选择器，下载由系统保存对话框确认落盘；工具栏可清除当前账号的 Cookie、缓存和本地存储后重新登录，也可在当前 App 窗口进入或退出聚焦模式。Renderer 的对话框、下拉菜单等浮层显示时，原生账号页面会临时隐藏并在浮层关闭后恢复，避免原生视图覆盖 App 控件。编辑账号会刷新主进程中的凭据但保留登录态，编辑入口会保留 Profile 并重开入口；正常关闭账号浏览区或 App 会先持久化 Cookie 和本地存储，删除账号、入口或环境则会关闭对应页面并清理本机 Profile。

协商到 API 协议 v2 且中心同时声明 `desktopLocal.ssh=true`、`desktopLocal.sftp=true` 时，App 开放与普通 Web 共用的 SSH 工作台和 SFTP 抽屉。主进程按当前 Session 与工作空间重新取得连接配置和一次性 SSH 凭据信封，完成密码、私钥/口令、keyboard-interactive 或单级跳板认证后只向 Renderer 暴露会话 ID、有限输出缓冲和受限输入/Resize/文件操作；明文 SSH 凭据不跨 preload。每个 App 实例最多保留 20 个 SSH 会话和 3 个跨主机传输任务，Endpoint、用户、工作空间、连接配置或登录状态变化时关闭受影响连接；中心临时不可达时已经建立的本机终端和传输可以继续，新连接仍需重新授权。终端输出在 App 用户数据目录保存为本机 asciinema 录像，并与服务端历史一起显示在“审计 → 终端录像”。

中心同时声明 `desktopLocal.logs=true` 时，环境日志继续使用与普通 Web 一致的配置列表、行数上限、关键字过滤、高亮、当前屏幕下载、清屏、停止和重新连接交互，但 SSH 与受控多文件 `tail` 由 App 主进程在当前 Mac 执行。Renderer 只提交环境、日志配置 ID 和 1–5,000 行上限；主进程从中心重新读取有权访问的最新配置、取得对应 SSH 一次性凭据信封，并固定生成 `tail -n <1–5000> -F -- <1–10 个绝对路径>`。每个 App 最多同时保留 3 路日志流；Endpoint、用户、工作空间、SSH 连接或日志配置变化时关闭受影响流，已经建立的流在中心暂时不可达时可以继续，新流仍需重新授权。

中心同时声明 `desktopLocal.database=true` 时，App 开放与普通 Web 共用的数据库工作台。Renderer 只提交数据库连接 ID、SQL、对象参数、表数据变更或用户选择的导入文件，主进程重新取得最新数据库一次性凭据信封并从当前 Mac 建立 TCP、SSL/TLS、SSH Tunnel 或 Navicat HTTP Tunnel 连接；密码、客户端证书、私钥及 Tunnel 凭据不跨 preload。查询、取消、对象树、DDL、表数据编辑、三种格式导出、CSV/XLSX 导入、SQL 备份恢复和跨连接迁移均在本机执行，系统保存对话框决定导出位置；查询历史和操作审计幂等回传中心。本机任务索引和备份文件按 App 用户数据目录保存，App 重启会把未完成任务标记为中断，不恢复活动数据库连接。macOS 对私网数据库返回 `EHOSTUNREACH` 时，界面将其标记为可能的本地网络权限异常，保留技术错误并提供“系统设置 → 隐私与安全性 → 本地网络”的打开入口；公网不可达和其他连接错误继续显示原错误分类。

中心同时声明 `desktopLocal.redis=true` 时，App 开放与普通 Web 共用的 Redis 工作台。Renderer 只提交连接 ID、逻辑库、SCAN 参数或结构化命令；主进程按操作取得绑定当前设备、用户、工作空间、Endpoint、目标地址和连接版本的一次性 Redis/TLS/SSH Tunnel 凭据信封，在本机执行后用设备签名回传审计。本机与服务端复用命令策略、二进制响应和资源上限，任何本机失败都不会切换网络出口。

中心同时声明 `desktopLocal.inspection=true` 时，“连接工具 → 连接巡检”使用 App 主进程本机执行。Renderer 只提交最多 500 个 SSH/数据库/Redis 连接 ID；主进程重新读取当前工作空间中有权访问的连接元数据，按连接重新取得一次性凭据信封，以最多 5 并发完成 SSH 认证、数据库 `SELECT 1` 或 Redis `PING`，不会调用普通 Web 的服务端巡检接口。每条结果只向界面返回连接元数据、状态、耗时和错误摘要，不返回凭据或连接选项；整批结果通过设备 RSA-PSS-SHA256 签名报告回传中心，中心验证用户、工作空间、设备状态、60 秒有效期和操作 ID 后幂等更新最近巡检状态与审计。

macOS App 的“设置 → 连接与执行”按当前设备与 Endpoint 保存全局连接模式，默认“本机直连”，也可以切换为“服务端转发”。切换前 App 查询当前执行实例的活动 Web、SSH、SFTP、日志、数据库和 Redis 请求；存在活动资源时先列出数量并要求确认，释放失败则不切换。服务端转发请求和实时通道携带随机执行实例标识，服务端只列出、复用和关闭当前 App 实例创建的运行资源，不影响同一用户的普通 Web 或其他 App。转发模式下 SSH、SFTP、日志、数据库、Redis 和连接巡检严格服从中心声明的分项能力，未启用的分项显示不可用且不回退本机；Web 账号是明确例外，中心未启用 Web 代理时继续使用本机 Chromium。

Web 账号页面默认使用服务端执行模式。macOS 会自动发现标准路径下的 Google Chrome；其他系统可配置：

```bash
export WEB_SESSION_EXECUTOR=server
export WEB_BROWSER_EXECUTABLE=/path/to/chrome-or-chromium
export CONNECTION_IDLE_MINUTES=30
export USER_CONNECTION_LIMIT=30
export WEB_VIEW_TOTAL_LIMIT=8
```

`CONNECTION_IDLE_MINUTES` 按单个连接的实际收发数据活动计算，缺省为 30 分钟；`USER_CONNECTION_LIMIT` 是同一用户所有连接类型的全局上限，缺省为 30。Web 后台请求、SSH 输入与输出、日志新增、SFTP 传输和数据库操作都会刷新对应连接的活动时间。SSH 终端因空闲超时或网络异常断开后，聚焦终端并按 Enter 会重新建立会话，该次 Enter 不会作为远端输入发送。`WEB_VIEW_TOTAL_LIMIT` 继续限制单个服务实例可同时运行的 Chromium 总量。

完整验证：

```bash
npm run typecheck
npm test
npm audit
npm run build
npm run build:desktop
VIRON_MYSQL_TEST=1 npx vitest run tests/mysql.integration.test.ts --reporter=verbose
VIRON_DESKTOP_SSH_TEST=1 npx vitest run tests/desktop-local-ssh.integration.test.ts
VIRON_DESKTOP_LOG_TEST=1 npx vitest run tests/desktop-local-log.integration.test.ts --reporter=verbose
VIRON_DESKTOP_DATABASE_TEST=1 npx vitest run tests/desktop-local-database.integration.test.ts --reporter=verbose
VIRON_DESKTOP_INSPECTION_TEST=1 npx vitest run tests/desktop-local-inspection.integration.test.ts --reporter=verbose
```

真实 MariaDB 集成测试默认连接 `127.0.0.1:13306`，用户名 `root`，密码 `envman-integration-test`。更完整的产品边界和实现约束见 [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md)，尚未实现的方向见 [docs/ROADMAP.md](./docs/ROADMAP.md)。

## 主要持久化路径

```text
/data/envman.db                    # SQLite 模式及迁移后的人工回退副本
/data/master-key                   # 自动生成的实例主密钥，权限 0600
/data/recordings/
/data/web-profiles/
/data/web-downloads/
/data/backups/database/
/data/exports/
/data/uploads/
/data/restore-pending/
/data/migration-history/
```

## 已知边界

- 已支持平台用户、组织、项目、资源授权，以及组织管理员把自己的个人资源复制为组织独立副本；暂不支持 SSO、LDAP/OIDC、MFA、自定义用户组、跨组织共享、个人/组织副本持续同步或审批流。
- 只支持 MySQL/MariaDB；不支持 PostgreSQL、Oracle 或 SQL Server。
- 元数据库支持 SQLite 和 MySQL/MariaDB；两种模式都支持可移植迁移包，但 MySQL/MariaDB 的日常备份和时间点恢复仍由数据库基础设施负责。
- Web 自动填充只处理入口原始 Origin 上能够可靠识别的普通登录表单；手工新建页和弹窗需由用户点击钥匙按钮后在同一 Origin 的当前页触发。验证码、MFA、跨域 SSO、WebAuthn、DRM、摄像头及复杂跨域 iframe 不保证兼容。
- 普通 Web 只使用服务端执行；macOS App 默认本机直连，也可按设备与 Endpoint 主动切换为服务端转发。SSH、SFTP、日志、数据库和 Redis 不在执行失败后自动更换网络出口。App 的安全边界有意不提供 Web、SSH、数据库或 Redis 明文凭据查看、复制，不作为普通 Web 的功能对齐项。
- Lite 服务端不包含 Chromium，因此 App 即使选择服务端转发，Web 账号仍由本机直连；Full 服务端包含 Chromium，并支持浏览器客户端及 App 的目标网站服务端转发。SSH、SFTP、日志、数据库和 Redis 的服务端转发在两个版本中都可用。
- 不开放通用 SSH 本地/远程/动态端口转发；数据库 SSH Tunnel 仅在服务进程内部使用。
- Navicat HTTP Tunnel 依赖目标 Web 服务器已有兼容的 `ntunnel_mysql.php`，其连接是请求级的；批量事务受该协议本身限制。
- 桌面和平板是主要操作端；手机只建议查看基础信息，不建议终端分屏或数据编辑。

## 许可

Viron 以 [Apache License 2.0](./LICENSE) 发布。版权归个人作者所有。第三方组件及其许可证见 [NOTICE](./NOTICE) 和 [monitor/THIRD_PARTY_NOTICES.md](./monitor/THIRD_PARTY_NOTICES.md)。

Navicat 是 PremiumSoft CyberTech Ltd. 的商标。SecureCRT 是 VanDyke Software, Inc. 的商标。Viron 与这些产品没有从属或合作关系，仅提供独立实现的连接导入和协议兼容。
