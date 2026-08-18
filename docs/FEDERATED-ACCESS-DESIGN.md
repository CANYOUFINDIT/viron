# Viron API Key 与 One-Agent 免密接入

状态：已实现

本文描述 Viron 当前的两级 API Key、平台供应接口、个人 API 鉴权和 One-Agent 免密进入 Viron 的约定。One-Agent 是首个接入方，但 Viron 的接口和数据模型不包含 One-Agent 专用字段。

## 1. 能力边界

Viron 提供两类凭据：

- 平台 API Key：只有 Viron 平台管理员能在设置页面创建、轮换和撤销。它用于受信任服务端创建普通账号、初始化组织和项目组、分配成员，以及为指定用户签发个人 API Key。
- 个人 API Key：由用户在设置页面自行维护，也可以由平台 API Key 为指定用户签发。它继承对应 Viron 用户的身份和权限，可以调用现有 Viron API，并可以换取短时单次免密登录票据。

平台 API Key 不对应某个自然人，不能直接作为普通用户访问工作空间资源。个人 API Key 不能提升用户的平台或组织权限。

## 2. 安全约束

- API Key 使用至少 32 字节密码学随机值，服务端只保存 SHA-256 摘要和可识别前缀。
- Key 明文只在创建或轮换成功后展示一次，列表接口永不返回明文。
- 所有 Key 均可撤销；轮换会先创建新 Key，再立即撤销旧 Key。
- 平台 Key 只能保存在受信任服务端的环境变量或密钥管理系统中，不得传给浏览器。
- One-Agent 持有的个人 Key 使用平台 Key 派生的 AES-GCM 密钥加密后落库。平台 Key 轮换导致旧密文不可解时，One-Agent 会撤销旧个人 Key 并重新签发。
- 浏览器免密跳转只接触 60 秒有效、单次消费的登录票据。票据通过顶层 POST 表单提交，不进入 URL、浏览器持久存储或普通日志。
- API Key、默认密码、登录票据和 Session Cookie 不写入审计详情。

## 3. 鉴权方式

平台和个人 API Key 都使用 Bearer 头：

```http
Authorization: Bearer <api-key>
```

个人 API Key 默认使用个人工作空间。调用普通 Viron API 时，可以通过以下请求头选择已经加入的组织工作空间：

```http
X-Viron-Workspace: organization:<organization-id>
```

服务端会重新校验组织成员关系，调用方不能通过请求头取得未授权工作空间。

## 4. Key 管理接口

以下接口使用 Viron Session：

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/api-keys` | 当前用户 | 列出个人 Key |
| `POST` | `/api/v1/api-keys` | 当前用户 | 创建个人 Key，明文只返回一次 |
| `POST` | `/api/v1/api-keys/:id/rotate` | Key 所有者 | 轮换个人 Key |
| `DELETE` | `/api/v1/api-keys/:id` | Key 所有者 | 撤销个人 Key |
| `GET` | `/api/v1/platform/api-keys` | 平台管理员 | 列出平台 Key |
| `POST` | `/api/v1/platform/api-keys` | 平台管理员 | 创建平台 Key，明文只返回一次 |
| `POST` | `/api/v1/platform/api-keys/:id/rotate` | 平台管理员 | 轮换平台 Key |
| `DELETE` | `/api/v1/platform/api-keys/:id` | 平台管理员 | 撤销平台 Key |

设置页面对个人 Key 和平台 Key 分区展示；普通用户看不到平台 Key 区域。

## 5. 平台供应接口

以下接口只接受平台 API Key，均可安全重试：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/platform/users/ensure` | 按用户名创建或复用普通用户；首次创建时接收初始密码 |
| `POST` | `/api/v1/platform/organizations/ensure` | 按名称创建或复用组织，并确保初始化用户是组织管理员 |
| `PUT` | `/api/v1/platform/organizations/:id/members/:userId` | 确保用户属于组织，并设置 `admin` 或 `member` |
| `POST` | `/api/v1/platform/organizations/:id/projects/ensure` | 在组织内按名称创建或复用项目组 |
| `PUT` | `/api/v1/platform/projects/:id/members/:userId` | 确保组织成员属于项目组 |
| `POST` | `/api/v1/platform/users/:id/api-keys` | 为指定用户签发个人 API Key |
| `DELETE` | `/api/v1/platform/users/:id/api-keys/:keyId` | 撤销指定用户的个人 API Key |

`users/ensure` 发现同名普通账号时不会覆盖密码或账号状态；同名账号是 Viron 平台管理员时返回冲突，外部系统不能复用平台管理员身份。新建账号固定为普通用户，密码在请求内只作为首次创建输入，Viron 立即使用 Argon2id 哈希后保存。

## 6. 个人 Key 免密登录

### 6.1 检查个人 Key

```http
GET /api/v1/api-key/self
Authorization: Bearer <personal-api-key>
```

该接口用于服务端确认缓存的个人 Key 是否仍有效。

### 6.2 创建一次性票据

```http
POST /api/v1/auth/api-key/tickets
Authorization: Bearer <personal-api-key>
Content-Type: application/json

{
  "organizationId": "<organization-id>",
  "redirectPath": "/"
}
```

响应：

```json
{
  "consumeAction": "https://viron.example.com/auth/api-key/consume",
  "ticket": "<opaque-ticket>",
  "expiresAt": "<RFC3339>"
}
```

同一个人 Key 创建新票据时，此前尚未消费的票据立即失效。

### 6.3 浏览器消费票据

```http
POST /auth/api-key/consume
Content-Type: application/x-www-form-urlencoded

ticket=<opaque-ticket>
```

Viron 在事务中校验票据、Key、用户和组织成员关系，原子标记票据已消费并创建自己的 Session，然后使用 `303` 跳转到内部路径。重复消费或过期票据返回 `410`。

## 7. One-Agent 启动配置

One-Agent 通过 Spring Boot 启动配置读取以下环境变量：

```yaml
one-agent:
  integrations:
    viron:
      enabled: ${ONE_AGENT_VIRON_ENABLED:false}
      endpoint: ${ONE_AGENT_VIRON_ENDPOINT:}
      platform-api-key: ${ONE_AGENT_VIRON_PLATFORM_API_KEY:}
      owner-username: ${ONE_AGENT_VIRON_OWNER_USERNAME:}
      organization-name: ${ONE_AGENT_VIRON_ORGANIZATION_NAME:}
      project-name: ${ONE_AGENT_VIRON_PROJECT_NAME:}
      default-password: ${ONE_AGENT_VIRON_DEFAULT_PASSWORD:}
```

- `owner-username` 是组织初始化管理员，不是所有 One-Agent 用户共用的登录账号。
- 当前 One-Agent 登录用户按自己的 One-Agent 用户名创建独立 Viron 账号。
- `default-password` 同时用于首次创建组织初始化管理员和当前用户。它必须满足 Viron 密码策略，不能写入仓库或日志。用户登录 Viron 后应修改初始密码。
- Endpoint、平台 Key、组织名、项目组名或默认密码发生变化后需要重启 One-Agent。

## 8. One-Agent 跳转流程

One-Agent 的“Viron”菜单位于“环境实例”之前。用户点击后，前端依次调用 One-Agent 自己的后端接口并展示状态：

1. 正在创建账号：创建或确认当前 One-Agent 用户对应的 Viron 账号。
2. 正在加入组织：创建或确认初始化管理员和目标组织，再把当前用户加入组织。
3. 正在分配项目组：创建或确认项目组，并把当前用户加入项目组。
4. 正在为用户创建 API Key：复用可用的加密个人 Key；不存在、已撤销或无法解密时重新签发。
5. One-Agent 后端使用个人 Key 换取一次性登录票据，前端通过隐藏 POST 表单进入 Viron。

即使调用方绕过前端步骤直接请求登录票据，One-Agent 后端仍会再次确认账号、组织和项目组关系，不依赖前端维持安全状态。

## 9. 数据模型

Viron 在 SQLite 和 MySQL 中维护等价表：

- `api_keys`：Key 类型、用户归属、名称、摘要、可见前缀、状态、创建者和最近使用时间。
- `api_key_login_tickets`：个人 Key、目标用户、工作空间、内部跳转路径、过期和消费时间。

One-Agent 维护：

- `oa_viron_user_credential`：One-Agent 用户、Viron 用户、个人 Key ID、个人 Key 密文和更新时间。

## 10. 当前非目标

- 不共享 One-Agent 与 Viron 的 Session、Cookie、密码哈希或用户表。
- 不允许 One-Agent 或浏览器直接写 Viron 数据库。
- 不把 One-Agent 管理员自动提升为 Viron 平台管理员。
- 不在浏览器保存平台或个人 API Key。
- 当前不实现 OIDC、SCIM、LDAP、mTLS 或完整 API Key Scope；需要更细权限时在两级 Key 模型上继续扩展。
