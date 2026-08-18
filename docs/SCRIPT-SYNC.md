# 脚本资源同步

脚本同步让个人空间所有者或组织管理员维护一段 `/bin/sh` 脚本。脚本在独立 Runner 容器中执行，并通过标准输出返回 `schemaVersion: 1` JSON；Viron 校验完整输出后，在当前空间的单一事务中写入资源。

## 执行与安全边界

- 脚本只能由当前个人空间所有者或组织管理员创建、编辑和执行。
- Runner 不挂载 Viron 数据目录、数据库、主密钥或服务环境变量。它只与 Viron 共享 Unix Socket，并允许脚本访问网络和 DNS。
- 同一 Viron 进程内同一同步源禁止并发执行；Runner 串行执行全部任务。
- 单次执行限制为 60 秒、1 CPU、256 MiB 内存、128 个进程和 5 MiB 标准输出；标准错误最多在内存读取 1 MiB，且不会保存到报告。
- 脚本文本随同步源使用平台主密钥加密。原始标准输出、标准错误和明文凭据均不写入同步报告、审计详情或服务日志。

正式部署的 `docker-compose.full.yml` 与 `docker-compose.lite.yml` 会自动启动 `script-runner`，并通过 Docker named volume 共享 Unix Socket。源码开发服务在 Docker 可用时使用同一镜像为每轮同步创建一次性受限容器；如使用独立 Runner，可用 `SCRIPT_RUNNER_SOCKET` 指定 Unix Socket 路径，用 `SCRIPT_RUNNER_IMAGE` 覆盖源码模式的一次性容器镜像。

## 自动处理规则

同步源需要预先选择同名资源策略：

- `ignore`：同一匹配范围已有资源时保留 Viron 当前值。
- `overwrite`：无条件使用脚本输出覆盖所有明确的同名匹配项。

新资源总是自动创建。Viron 空间中存在、但本轮脚本没有返回的资源不会删除或禁用，只在报告中标为“空间额外”。脚本输出校验、依赖解析或任一写入失败时，本轮业务数据整批回滚，并生成失败报告。

环境组和环境的拖动排序属于 Viron 内维护的用户顺序，不受 `ignore` 或 `overwrite` 策略影响。同步命中已有环境组或环境时保留其当前位置；新环境组追加到当前空间的环境组末尾，新环境追加到目标环境组或“未分组”的末尾。同一轮新增多项时按对应 JSON 数组中的出现顺序依次追加。为兼容现有 `schemaVersion: 1` 脚本，`environmentGroups` 和 `environments` 中的 `sortOrder` 字段仍可提供，但同步会忽略这两个位置的值。

名称按大小写不敏感方式匹配。环境按“环境组 + 环境名”，Web 入口按“环境 + 名称”，Web 账号按“Web 入口 + 用户名”，连接组按“类型 + 完整路径”，数据库配置档按“数据库连接 + 配置档名称”，日志按“环境 + 名称”匹配；SSH 密钥和 SSH、数据库、Redis 连接按当前空间内名称匹配。

成功或失败的每轮执行都会保留审阅报告。成功报告只包含资源类型、名称、位置或端点、处理动作和同名匹配数量；连接凭据、Web 密码、私钥和原始脚本输出不会进入报告。

## 输出契约

标准输出必须只有一个 UTF-8 JSON 对象，不能在 JSON 前后输出日志。所有根数组均可省略，省略时视为空数组。

```json
{
  "schemaVersion": 1,
  "environmentGroups": [
    { "name": "生产", "description": "生产资源", "color": "#1d8a74" }
  ],
  "environments": [
    {
      "group": "生产",
      "name": "应用集群",
      "shortName": "PROD",
      "description": "主生产环境",
      "status": "active",
      "owner": "SRE",
      "tags": ["production"]
    }
  ],
  "webEntries": [
    {
      "environment": { "group": "生产", "name": "应用集群" },
      "name": "管理后台",
      "url": "https://admin.example.com",
      "description": "运营入口",
      "tags": ["admin"],
      "sortOrder": 0,
      "credentials": [
        {
          "username": "operator",
          "password": "plain-text-from-secret-store",
          "note": "运营账号",
          "customFields": { "tenant": "main" },
          "sortOrder": 0
        }
      ]
    }
  ],
  "connectionGroups": [
    { "type": "ssh", "path": "生产/应用", "sortOrder": 0 },
    { "type": "database", "path": "生产/数据", "sortOrder": 0 },
    { "type": "redis", "path": "生产/缓存", "sortOrder": 0 }
  ],
  "sshKeys": [
    { "name": "生产应用密钥", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...", "passphrase": "" }
  ],
  "sshConnections": [
    {
      "name": "应用节点 01",
      "environments": [{ "group": "生产", "name": "应用集群" }],
      "groupPath": "生产/应用",
      "host": "10.0.0.10",
      "port": 22,
      "username": "root",
      "authType": "privateKey",
      "keyName": "生产应用密钥",
      "jumpConnection": null,
      "credential": { "password": "", "privateKey": "", "passphrase": "" },
      "options": {
        "terminalType": "xterm-256color",
        "keepAliveSeconds": 30,
        "encoding": "utf-8",
        "hostKeySha256": "",
        "loginScriptEnabled": false,
        "loginScript": ""
      },
      "tags": ["application"]
    }
  ],
  "databaseConnections": [
    {
      "name": "应用数据库",
      "environments": [{ "group": "生产", "name": "应用集群" }],
      "groupPath": "生产/数据",
      "engine": "mysql",
      "host": "10.0.0.20",
      "port": 3306,
      "username": "app",
      "credential": { "password": "database-password" },
      "defaultDatabase": "app",
      "connectionMode": "sshTunnel",
      "sshConnection": "应用节点 01",
      "options": {
        "charset": "utf8mb4",
        "timezone": "local",
        "connectTimeoutMs": 10000,
        "ssl": { "enabled": false, "rejectUnauthorized": true },
        "httpTunnelUrl": "",
        "httpTunnelRejectUnauthorized": true
      },
      "profiles": [
        {
          "name": "只读账号",
          "engine": "mysql",
          "host": "10.0.0.20",
          "port": 3306,
          "username": "reader",
          "credential": { "password": "reader-password" },
          "defaultDatabase": "app",
          "connectionMode": "tcp",
          "sshConnection": null
        }
      ]
    }
  ],
  "redisConnections": [
    {
      "name": "应用缓存",
      "environments": [{ "group": "生产", "name": "应用集群" }],
      "groupPath": "生产/缓存",
      "host": "10.0.0.30",
      "port": 6379,
      "username": "app",
      "credential": {
        "password": "redis-password",
        "tlsCa": "",
        "tlsCertificate": "",
        "tlsPrivateKey": "",
        "tlsPassphrase": ""
      },
      "defaultDatabase": 0,
      "connectionMode": "sshTunnel",
      "sshConnection": "应用节点 01",
      "options": {
        "connectTimeoutMs": 10000,
        "keySeparator": ":",
        "readOnly": false,
        "tls": { "enabled": false, "rejectUnauthorized": true, "serverName": "" }
      }
    }
  ],
  "environmentLogs": [
    {
      "environment": { "group": "生产", "name": "应用集群" },
      "sshConnection": "应用节点 01",
      "name": "应用日志",
      "filePaths": ["/var/log/app/app.log", "/var/log/app/error.log"]
    }
  ]
}
```

环境引用统一使用 `{ "group": "环境组名或 null", "name": "环境名" }`。连接引用 SSH 密钥、跳板机和 Tunnel 时使用目标资源名称。依赖既可以由本轮输出创建，也可以引用当前空间已有资源；引用不存在或名称重复的输出会让整轮同步失败。

凭据可以明文出现在脚本标准输出中，Viron 会在事务写入时立即使用平台主密钥加密。脚本应避免把凭据写到标准错误、外部日志或其他文件中。
