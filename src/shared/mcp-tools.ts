import { createHash } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listMcpBusinessOperations, MCP_BUSINESS_OPERATION_MODES, resolveMcpBusinessOperation } from "./mcp-business-operations.js";
import {
  VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH,
  VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH,
  type McpApiRequest,
  type McpApiResponse,
  type VironMcpBackend,
} from "./mcp-protocol.js";
import {
  assertMcpReadOnlyRedisCommand,
  assertMcpReadOnlySql,
  assertMcpApiRequestAllowed,
  assertMcpRedisWriteCommand,
  assertMcpWriteSql,
} from "./mcp-policy.js";
import { sshCommandRiskLevel } from "./ssh-command-risk.js";

const MAX_TOOL_TEXT = 512 * 1024;
const MAX_TOOL_STRUCTURED_BYTES = 12 * 1024 * 1024;
const MAX_TOOL_STRUCTURED_PREVIEW = 64 * 1024;
const workspaceSchema = z.string().regex(/^(personal|organization:[0-9a-f-]{36})$/i)
  .describe("目标 Viron 工作空间：personal 或 organization:<UUID>");
const uuidSchema = z.string().uuid();
const operationPurposeSchema = z.string().trim()
  .min(VIRON_MCP_OPERATION_PURPOSE_MIN_LENGTH)
  .max(VIRON_MCP_OPERATION_PURPOSE_MAX_LENGTH)
  .regex(/^[^\r\n]+$/, "执行意图必须是一句话")
  .describe("8–80 字的一句话，说明本次操作的业务目标和执行原因；不要重复命令或参数");
const connectionItemSchema = z.object({ type: z.enum(["ssh", "database", "redis"]), id: uuidSchema });
const redisArgumentSchema = z.union([z.string().max(256 * 1024), z.object({ base64: z.string().max(512 * 1024) })]);
const tableFilterSchema = z.object({
  column: z.string().trim().min(1).max(255),
  operator: z.enum(["contains", "eq", "ne", "gt", "gte", "lt", "lte", "isNull", "isNotNull"]),
  value: z.string().max(16 * 1024).default(""),
  enabled: z.boolean().default(true),
});
const tableSortSchema = z.object({
  column: z.string().trim().min(1).max(255),
  direction: z.enum(["asc", "desc"]),
  enabled: z.boolean().default(true),
});

const sshOptionsSchema = z.object({
  terminalType: z.string().trim().min(1).max(80).default("xterm-256color"),
  keepAliveSeconds: z.number().int().min(0).max(600).default(30),
  encoding: z.string().trim().min(1).max(40).default("utf-8"),
  hostKeySha256: z.string().trim().max(160).default(""),
  loginScriptEnabled: z.boolean().default(false),
  loginScript: z.string().max(64 * 1024).default(""),
});
const sshConnectionConfigSchema = z.object({
  environmentId: uuidSchema.nullable().optional(),
  environmentIds: z.array(uuidSchema).max(100).optional(),
  connectionGroupId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(1).max(160),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(255),
  authType: z.enum(["password", "privateKey", "keyboardInteractive"]).default("password"),
  sshKeyId: uuidSchema.nullable().optional(),
  jumpConnectionId: uuidSchema.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  options: sshOptionsSchema.default({
    terminalType: "xterm-256color",
    keepAliveSeconds: 30,
    encoding: "utf-8",
    hostKeySha256: "",
    loginScriptEnabled: false,
    loginScript: "",
  }),
});
const databaseOptionsSchema = z.object({
  charset: z.string().trim().max(80).default("utf8mb4"),
  timezone: z.string().trim().max(80).default("local"),
  connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
  sshConnectionId: uuidSchema.nullable().optional(),
  ssl: z.object({
    enabled: z.boolean().default(false),
    rejectUnauthorized: z.boolean().default(true),
  }).default({ enabled: false, rejectUnauthorized: true }),
  httpTunnelUrl: z.union([z.literal(""), z.string().url()]).default(""),
  httpTunnelRejectUnauthorized: z.boolean().default(true),
  activeProfileId: uuidSchema.nullable().optional(),
});
const databaseConnectionConfigSchema = z.object({
  environmentId: uuidSchema.nullable().optional(),
  environmentIds: z.array(uuidSchema).max(100).optional(),
  connectionGroupId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(1).max(160),
  engine: z.enum(["mysql", "mariadb"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  defaultDatabase: z.string().trim().max(255).default(""),
  connectionMode: z.enum(["tcp", "sshTunnel", "httpTunnel"]).default("tcp"),
  options: databaseOptionsSchema.default({
    charset: "utf8mb4",
    timezone: "local",
    connectTimeoutMs: 10000,
    ssl: { enabled: false, rejectUnauthorized: true },
    httpTunnelUrl: "",
    httpTunnelRejectUnauthorized: true,
  }),
});
const databaseConnectionProfileConfigSchema = z.object({
  profileName: z.string().trim().min(1).max(160),
  engine: z.enum(["mysql", "mariadb"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  defaultDatabase: z.string().trim().max(255).default(""),
  connectionMode: z.enum(["tcp", "sshTunnel", "httpTunnel"]).default("tcp"),
  options: databaseOptionsSchema.omit({ activeProfileId: true }).default({
    charset: "utf8mb4",
    timezone: "local",
    connectTimeoutMs: 10000,
    ssl: { enabled: false, rejectUnauthorized: true },
    httpTunnelUrl: "",
    httpTunnelRejectUnauthorized: true,
  }),
});
const redisOptionsSchema = z.object({
  connectTimeoutMs: z.number().int().min(1000).max(120000).default(10000),
  keySeparator: z.string().max(16).default(":"),
  readOnly: z.boolean().default(false),
  sshConnectionId: uuidSchema.nullable().optional(),
  tls: z.object({
    enabled: z.boolean().default(false),
    rejectUnauthorized: z.boolean().default(true),
    serverName: z.string().trim().max(255).default(""),
  }).default({ enabled: false, rejectUnauthorized: true, serverName: "" }),
});
const redisConnectionConfigSchema = z.object({
  environmentId: uuidSchema.nullable().optional(),
  environmentIds: z.array(uuidSchema).max(100).optional(),
  connectionGroupId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(1).max(160),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(6379),
  username: z.string().trim().max(255).default(""),
  defaultDatabase: z.number().int().min(0).max(1023).default(0),
  connectionMode: z.enum(["tcp", "sshTunnel"]).default("tcp"),
  options: redisOptionsSchema.default({
    connectTimeoutMs: 10000,
    keySeparator: ":",
    readOnly: false,
    tls: { enabled: false, rejectUnauthorized: true, serverName: "" },
  }),
});
const environmentGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1d8a74"),
});
const environmentInputSchema = z.object({
  groupId: uuidSchema.nullable().optional(),
  name: z.string().trim().min(1).max(120),
  shortName: z.string().trim().max(12).default(""),
  description: z.string().trim().max(2000).default(""),
  status: z.enum(["active", "maintenance", "error", "disabled"]).default("active"),
  owner: z.string().trim().max(120).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
const knowledgeNodeInputSchema = z.object({
  type: z.enum(["folder", "document"]),
  name: z.string().trim().min(1).max(240),
  parentId: uuidSchema.nullable().default(null),
});
const webEntryInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().url().max(2048),
  description: z.string().trim().max(1000).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
const environmentLogInputSchema = z.object({
  sshConnectionId: uuidSchema,
  name: z.string().trim().max(120).default(""),
  filePaths: z.array(z.string().trim().min(1).max(1024).refine((value) => value.startsWith("/"), "日志路径必须是绝对路径")).min(1).max(20),
});
const sshFavoriteInputSchema = z.object({
  connectionId: uuidSchema,
  command: z.string().max(256 * 1024),
  cwd: z.string().max(4096).default(""),
});
const savedQueryInputSchema = z.object({
  connectionId: uuidSchema,
  database: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(160),
  sql: z.string().max(2 * 1024 * 1024),
});
const connectionSourceConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(255),
  authType: z.enum(["password", "privateKey"]).default("password"),
  remotePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(20),
  scheduleEnabled: z.boolean().default(false),
  scheduleExpression: z.string().trim().max(120).default(""),
});

function operationApiRequest(workspace: string | undefined, action: string, arguments_: Record<string, unknown>): McpApiRequest {
  return { method: "POST", path: "/api/v1/mcp/operations", workspace, body: { action, arguments: arguments_ } };
}

function textFor(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_TOOL_TEXT) return text;
  return `${text.slice(0, MAX_TOOL_TEXT)}\n...结果已在 ${MAX_TOOL_TEXT} 字符处截断，请缩小查询范围。`;
}

function toolResult(response: McpApiResponse) {
  const result = { status: response.status, data: response.data };
  const serialized = JSON.stringify(result, null, 2);
  const structuredResult = Buffer.byteLength(serialized) <= MAX_TOOL_STRUCTURED_BYTES
    ? result
    : {
        status: response.status,
        data: {
          error: "MCP_RESULT_TOO_LARGE",
          message: "Viron MCP 结果超过 12 MiB 限制，请缩小查询范围或分批读取。",
          truncated: true,
          originalBytes: Buffer.byteLength(serialized),
          preview: serialized.slice(0, MAX_TOOL_STRUCTURED_PREVIEW),
        },
      };
  const text = response.status >= 400
    ? (serialized.length <= MAX_TOOL_TEXT ? serialized : `${serialized.slice(0, MAX_TOOL_TEXT)}\n...错误结果已在 ${MAX_TOOL_TEXT} 字符处截断。`)
    : `Viron 调用成功（HTTP ${response.status}），完整结果见 structuredContent.result。`;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { result: structuredResult },
    ...(response.status >= 400 ? { isError: true } : {}),
  };
}

async function invoke(backend: VironMcpBackend, toolName: string, arguments_: Record<string, unknown>) {
  try {
    return toolResult(await backend.invoke(toolName, arguments_));
  } catch (error) {
    const result = { status: 500, data: { error: "MCP_TOOL_FAILED", message: error instanceof Error ? error.message : String(error) } };
    return {
      content: [{ type: "text" as const, text: textFor(result) }],
      structuredContent: { result },
      isError: true,
    };
  }
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const executionReadAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const cancelAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const secureMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const confirmedWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const LEGACY_INITIAL_MCP_TOOL_NAMES = [
  "viron_capabilities_get",
  "viron_context_get",
  "viron_workspaces_list",
  "viron_dashboard_get",
  "viron_environment_groups_list",
  "viron_environments_list",
  "viron_environment_get",
  "viron_connection_groups_list",
  "viron_connections_list",
  "viron_knowledge_list",
  "viron_knowledge_document_read",
  "viron_environment_web_entries_list",
  "viron_environment_logs_list",
  "viron_audit_events_list",
  "viron_business_operations_list",
] as const;

const LEGACY_MCP_READ_EXECUTION_TOOL_NAMES = [
  "viron_web_credentials_list",
  "viron_active_connections_list",
  "viron_connections_inspect",
  "viron_database_connection_test",
  "viron_database_schemas_list",
  "viron_database_objects_list",
  "viron_database_ddl_read",
  "viron_database_table_data_read",
  "viron_database_query_read_start",
  "viron_database_queries_read_batch",
  "viron_database_query_get",
  "viron_database_query_cancel",
  "viron_database_query_history_list",
  "viron_database_tasks_list",
  "viron_database_task_get",
  "viron_redis_connection_test",
  "viron_redis_info_get",
  "viron_redis_keys_scan",
  "viron_redis_command_read",
  "viron_redis_commands_read_batch",
  "viron_ssh_commands_read_batch",
  "viron_sftp_directory_list",
  "viron_sftp_transfers_list",
  "viron_sftp_transfer_preview",
  "viron_environment_log_snapshot",
  "viron_web_page_snapshot",
  "viron_business_read",
] as const;

const LEGACY_MCP_OPERATION_TOOL_NAMES = [
  "viron_operation_get",
  "viron_operation_purpose_provide",
  "viron_operation_cancel",
  "viron_ssh_connection_secure_create",
  "viron_ssh_connection_secure_update",
  "viron_database_connection_secure_create",
  "viron_database_connection_secure_update",
  "viron_database_connection_profile_secure_create",
  "viron_database_connection_profile_secure_update",
  "viron_redis_connection_secure_create",
  "viron_redis_connection_secure_update",
  "viron_web_credential_secure_create",
  "viron_web_credential_secure_update",
  "viron_ssh_key_secure_import",
  "viron_ssh_key_secure_generate",
  "viron_connection_source_secure_create",
  "viron_connection_source_secure_update",
  "viron_connection_import_secure_preview",
  "viron_ssh_command_request",
  "viron_database_write_request",
  "viron_redis_write_request",
  "viron_sftp_mkdir_request",
  "viron_sftp_rename_request",
  "viron_sftp_chmod_request",
  "viron_sftp_delete_request",
  "viron_sftp_transfer_request",
  "viron_web_action_request",
  "viron_business_risk_request",
] as const;

const LEGACY_MCP_CONFIGURATION_TOOL_NAMES = [
  "viron_environment_group_create",
  "viron_environment_group_update",
  "viron_environment_group_delete",
  "viron_environment_groups_reorder",
  "viron_environment_create",
  "viron_environment_update",
  "viron_environment_delete",
  "viron_environments_reorder",
  "viron_environment_alias_update",
  "viron_connection_group_create",
  "viron_connection_group_delete",
  "viron_connections_assign",
  "viron_connections_bulk_delete",
  "viron_knowledge_node_create",
  "viron_knowledge_node_update",
  "viron_knowledge_node_delete",
  "viron_knowledge_node_environments_update",
  "viron_knowledge_documents_associate",
  "viron_knowledge_document_content_update",
  "viron_web_entry_create",
  "viron_web_entry_update",
  "viron_web_entry_delete",
  "viron_web_entries_reorder",
  "viron_web_credential_delete",
  "viron_web_credentials_reorder",
  "viron_environment_log_create",
  "viron_environment_log_update",
  "viron_environment_log_delete",
  "viron_active_connection_close",
  "viron_ssh_command_favorites_list",
  "viron_ssh_command_favorite_create",
  "viron_ssh_command_favorite_delete",
  "viron_database_saved_queries_list",
  "viron_database_saved_query_create",
  "viron_database_saved_query_update",
  "viron_database_saved_query_delete",
  "viron_business_change",
] as const;

const LEGACY_VIRON_MCP_TOOL_NAMES = [
  ...LEGACY_INITIAL_MCP_TOOL_NAMES,
  ...LEGACY_MCP_READ_EXECUTION_TOOL_NAMES,
  ...LEGACY_MCP_OPERATION_TOOL_NAMES,
  ...LEGACY_MCP_CONFIGURATION_TOOL_NAMES,
] as const;

export const VIRON_MCP_TOOL_NAMES = [
  "viron_context",
  "viron_domains_list",
  "viron_operations_search",
  "viron_operation_schema",
  "viron_read",
  "viron_change",
  "viron_risk",
  "viron_secure",
  "viron_operation_status",
  "viron_operation_purpose",
  "viron_operation_cancel",
] as const;

export const VIRON_MCP_CATALOG_VERSION = 2;

function resolveVironMcpApiRequestUnchecked(toolName: string, rawArguments: Record<string, unknown>): McpApiRequest {
  switch (toolName) {
    case "viron_capabilities_get":
      z.object({}).parse(rawArguments);
      return { path: "/api/v1/capabilities" };
    case "viron_context_get":
    case "viron_workspaces_list": {
      const { workspace } = z.object({ workspace: workspaceSchema.optional() }).parse(rawArguments);
      return { path: "/api/v1/auth/me", workspace };
    }
    case "viron_dashboard_get": {
      const { workspace } = z.object({ workspace: workspaceSchema.optional() }).parse(rawArguments);
      return { path: "/api/v1/dashboard", workspace };
    }
    case "viron_environment_groups_list": {
      const { workspace } = z.object({ workspace: workspaceSchema.optional() }).parse(rawArguments);
      return { path: "/api/v1/environment-groups", workspace };
    }
    case "viron_environments_list": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        query: z.string().trim().max(200).optional(),
        status: z.enum(["active", "maintenance", "error", "disabled"]).optional(),
        groupId: z.union([uuidSchema, z.literal("ungrouped")]).optional(),
      }).parse(rawArguments);
      return { path: "/api/v1/environments", workspace: input.workspace, query: { q: input.query, status: input.status, groupId: input.groupId } };
    }
    case "viron_environment_get": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/environments/${input.environmentId}`, workspace: input.workspace };
    }
    case "viron_connection_groups_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), type: z.enum(["ssh", "database", "redis"]).optional() }).parse(rawArguments);
      return { path: "/api/v1/connection-groups", workspace: input.workspace, query: { type: input.type } };
    }
    case "viron_connections_list": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        type: z.enum(["all", "ssh", "database", "redis"]).default("all"),
        assignment: z.enum(["all", "assigned", "unassigned"]).default("all"),
        environmentId: uuidSchema.optional(),
        query: z.string().trim().max(200).optional(),
        includeProfiles: z.boolean().default(false),
      }).parse(rawArguments);
      return {
        path: "/api/v1/connections",
        workspace: input.workspace,
        query: { type: input.type, assignment: input.assignment, environmentId: input.environmentId, q: input.query, includeProfiles: input.includeProfiles },
      };
    }
    case "viron_knowledge_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema.optional() }).parse(rawArguments);
      return { path: input.environmentId ? `/api/v1/environments/${input.environmentId}/knowledge` : "/api/v1/knowledge", workspace: input.workspace };
    }
    case "viron_knowledge_document_read":
    case "__resource_knowledge_document": {
      const input = z.object({ workspace: workspaceSchema.optional(), documentId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/knowledge-documents/${input.documentId}`, workspace: input.workspace, query: { includeAssetData: false } };
    }
    case "viron_environment_web_entries_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/environments/${input.environmentId}/web-entries`, workspace: input.workspace };
    }
    case "viron_environment_logs_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/environments/${input.environmentId}/logs`, workspace: input.workspace };
    }
    case "viron_audit_events_list": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
        keyword: z.string().trim().max(200).optional(),
        actorUserId: uuidSchema.optional(),
      }).parse(rawArguments);
      return { path: "/api/v1/audit-events", workspace: input.workspace, query: { page: input.page, pageSize: input.pageSize, keyword: input.keyword, actorUserId: input.actorUserId } };
    }
    case "viron_business_operations_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), mode: z.enum(MCP_BUSINESS_OPERATION_MODES).optional() }).parse(rawArguments);
      return { path: "/api/v1/mcp/business-operations", workspace: input.workspace, query: { mode: input.mode } };
    }
    case "viron_business_read": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        operation: z.string().trim().min(1).max(160),
        input: z.record(z.string(), z.unknown()).default({}),
      }).parse(rawArguments);
      return resolveMcpBusinessOperation("read", input.operation, input.input, input.workspace).request;
    }
    case "viron_web_credentials_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), webEntryId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/web-entries/${input.webEntryId}/credentials`, workspace: input.workspace };
    }
    case "viron_active_connections_list": {
      const input = z.object({ workspace: workspaceSchema.optional() }).parse(rawArguments);
      return { path: "/api/v1/active-connections", workspace: input.workspace };
    }
    case "viron_connections_inspect": {
      const input = z.object({ workspace: workspaceSchema.optional(), items: z.array(connectionItemSchema).min(1).max(500) }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/connections/inspect", workspace: input.workspace, body: { items: input.items } };
    }
    case "viron_database_connection_test": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/database-connections/${input.connectionId}/test`, workspace: input.workspace };
    }
    case "viron_database_schemas_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/database-connections/${input.connectionId}/schemas`, workspace: input.workspace };
    }
    case "viron_database_objects_list": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().min(1).max(255),
        category: z.enum(["tables", "views", "procedures", "functions", "triggers", "events"]),
      }).parse(rawArguments);
      return { path: `/api/v1/database-connections/${input.connectionId}/objects`, workspace: input.workspace, query: { database: input.database, category: input.category } };
    }
    case "viron_database_ddl_read": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().min(1).max(255),
        name: z.string().trim().min(1).max(255), type: z.enum(["table", "view", "procedure", "function", "trigger", "event"]),
      }).parse(rawArguments);
      return { path: `/api/v1/database-connections/${input.connectionId}/ddl`, workspace: input.workspace, query: { database: input.database, name: input.name, type: input.type } };
    }
    case "viron_database_table_data_read": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().min(1).max(255),
        table: z.string().trim().min(1).max(255), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(20).max(500).default(100),
        filters: z.array(tableFilterSchema).max(20).default([]), sorts: z.array(tableSortSchema).max(20).default([]),
      }).parse(rawArguments);
      return {
        path: `/api/v1/database-connections/${input.connectionId}/table-data`, workspace: input.workspace,
        query: { database: input.database, table: input.table, page: input.page, pageSize: input.pageSize, filters: JSON.stringify(input.filters), sorts: JSON.stringify(input.sorts) },
      };
    }
    case "viron_database_query_read_start": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().max(255).default(""), sql: z.string(),
      }).parse(rawArguments);
      return {
        method: "POST", path: `/api/v1/database-connections/${input.connectionId}/queries`, workspace: input.workspace,
        body: { database: input.database, sql: assertMcpReadOnlySql(input.sql), continueOnError: false },
      };
    }
    case "viron_database_queries_read_batch": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema,
        queries: z.array(z.object({ database: z.string().trim().max(255).default(""), sql: z.string().trim().min(1).max(1024 * 1024) })).min(1).max(20),
      }).parse(rawArguments);
      return {
        method: "POST", path: `/api/v1/database-connections/${input.connectionId}/queries/batch`, workspace: input.workspace,
        body: { queries: input.queries.map((query) => ({ ...query, sql: assertMcpReadOnlySql(query.sql) })) },
      };
    }
    case "viron_database_query_get": {
      const input = z.object({ workspace: workspaceSchema.optional(), queryId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/database-queries/${input.queryId}`, workspace: input.workspace };
    }
    case "viron_database_query_cancel": {
      const input = z.object({ workspace: workspaceSchema.optional(), queryId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/database-queries/${input.queryId}`, workspace: input.workspace };
    }
    case "viron_database_query_history_list": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema.optional(), status: z.enum(["pending", "running", "success", "error", "cancelled"]).optional(),
        page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50), keyword: z.string().trim().max(200).optional(),
      }).parse(rawArguments);
      return { path: "/api/v1/database-query-history", workspace: input.workspace, query: { connectionId: input.connectionId, status: input.status, page: input.page, pageSize: input.pageSize, keyword: input.keyword } };
    }
    case "viron_database_tasks_list": {
      const input = z.object({ workspace: workspaceSchema.optional() }).parse(rawArguments);
      return { path: "/api/v1/database-tasks", workspace: input.workspace };
    }
    case "viron_database_task_get": {
      const input = z.object({ workspace: workspaceSchema.optional(), taskId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/database-tasks/${input.taskId}`, workspace: input.workspace };
    }
    case "viron_redis_connection_test": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/redis-connections/${input.connectionId}/test`, workspace: input.workspace };
    }
    case "viron_redis_info_get": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional() }).parse(rawArguments);
      return { path: `/api/v1/redis-connections/${input.connectionId}/info`, workspace: input.workspace, query: { database: input.database } };
    }
    case "viron_redis_keys_scan": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(), cursor: z.string().regex(/^\d+$/).default("0"),
        pattern: z.string().max(1024).default("*"), count: z.number().int().min(10).max(1000).default(200), type: z.enum(["string", "hash", "list", "set", "zset", "stream"]).optional(),
      }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/redis-connections/${input.connectionId}/scan`, workspace: input.workspace, body: { database: input.database, cursor: input.cursor, pattern: input.pattern, count: input.count, type: input.type } };
    }
    case "viron_redis_command_read": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(), command: z.string(), args: z.array(redisArgumentSchema).default([]),
      }).parse(rawArguments);
      const command = assertMcpReadOnlyRedisCommand(input.command, input.args);
      return { method: "POST", path: `/api/v1/redis-connections/${input.connectionId}/command`, workspace: input.workspace, body: { database: input.database, ...command } };
    }
    case "viron_redis_commands_read_batch": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema,
        commands: z.array(z.object({ database: z.number().int().min(0).max(1023).optional(), command: z.string(), args: z.array(redisArgumentSchema).max(256).default([]) })).min(1).max(20),
      }).parse(rawArguments);
      return {
        method: "POST", path: `/api/v1/redis-connections/${input.connectionId}/commands/batch`, workspace: input.workspace,
        body: { commands: input.commands.map((item) => ({ database: item.database, ...assertMcpReadOnlyRedisCommand(item.command, item.args) })) },
      };
    }
    case "viron_ssh_commands_read_batch": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema,
        commands: z.array(z.string().trim().min(1).max(256 * 1024)).min(1).max(20),
        timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
        maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
      }).parse(rawArguments);
      if (input.commands.some((command) => sshCommandRiskLevel(command) !== "low")) throw new Error("SSH 批量读取只允许可证明为只读的命令");
      return { method: "POST", path: `/api/v1/mcp/ssh-connections/${input.connectionId}/commands`, workspace: input.workspace, body: { commands: input.commands, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes } };
    }
    case "viron_sftp_directory_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096).default("/") }).parse(rawArguments);
      return { path: `/api/v1/ssh-connections/${input.connectionId}/sftp`, workspace: input.workspace, query: { path: input.path } };
    }
    case "viron_sftp_transfers_list": {
      const input = z.object({ workspace: workspaceSchema.optional() }).parse(rawArguments);
      return { path: "/api/v1/sftp-transfers", workspace: input.workspace };
    }
    case "viron_sftp_transfer_preview": {
      const input = z.object({
        workspace: workspaceSchema.optional(), sourceConnectionId: uuidSchema, targetConnectionId: uuidSchema,
        sourcePath: z.string().min(1).max(4096), targetDirectory: z.string().min(1).max(4096),
      }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/sftp-transfers/preview", workspace: input.workspace, body: { sourceConnectionId: input.sourceConnectionId, targetConnectionId: input.targetConnectionId, sourcePath: input.sourcePath, targetDirectory: input.targetDirectory } };
    }
    case "viron_environment_log_snapshot": {
      const input = z.object({
        workspace: workspaceSchema.optional(), logId: uuidSchema, initialLines: z.number().int().min(1).max(5000).default(200), maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
      }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/mcp/environment-logs/${input.logId}/snapshot`, workspace: input.workspace, body: { initialLines: input.initialLines, maxBytes: input.maxBytes } };
    }
    case "viron_web_page_snapshot": {
      const input = z.object({
        workspace: workspaceSchema.optional(), credentialId: uuidSchema, width: z.number().int().min(320).max(1920).default(1280),
        height: z.number().int().min(240).max(1200).default(720), maxTextChars: z.number().int().min(1000).max(200_000).default(50_000),
      }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/mcp/web-credentials/${input.credentialId}/snapshot`, workspace: input.workspace, body: { width: input.width, height: input.height, maxTextChars: input.maxTextChars } };
    }
    case "viron_environment_group_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), group: environmentGroupInputSchema }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/environment-groups", workspace: input.workspace, body: input.group };
    }
    case "viron_environment_group_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), groupId: uuidSchema, group: environmentGroupInputSchema }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/environment-groups/${input.groupId}`, workspace: input.workspace, body: input.group };
    }
    case "viron_environment_group_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), groupId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/environment-groups/${input.groupId}`, workspace: input.workspace };
    }
    case "viron_environment_groups_reorder": {
      const input = z.object({ workspace: workspaceSchema.optional(), orderedIds: z.array(uuidSchema).max(1000) }).parse(rawArguments);
      return { method: "PUT", path: "/api/v1/environment-groups/order", workspace: input.workspace, body: { orderedIds: input.orderedIds } };
    }
    case "viron_environment_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), environment: environmentInputSchema }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/environments", workspace: input.workspace, body: input.environment };
    }
    case "viron_environment_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema, environment: environmentInputSchema }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/environments/${input.environmentId}`, workspace: input.workspace, body: input.environment };
    }
    case "viron_environment_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/environments/${input.environmentId}`, workspace: input.workspace };
    }
    case "viron_environments_reorder": {
      const input = z.object({ workspace: workspaceSchema.optional(), items: z.array(z.object({ id: uuidSchema, groupId: uuidSchema.nullable() })).max(1000) }).parse(rawArguments);
      return { method: "PUT", path: "/api/v1/environments/order", workspace: input.workspace, body: { items: input.items } };
    }
    case "viron_environment_alias_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema, alias: z.string().trim().max(120) }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/environments/${input.environmentId}/preferences`, workspace: input.workspace, body: { alias: input.alias } };
    }
    case "viron_connection_group_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), type: z.enum(["ssh", "database", "redis"]), parentId: uuidSchema.nullable().optional(), name: z.string().trim().min(1).max(80) }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/connection-groups", workspace: input.workspace, body: { type: input.type, parentId: input.parentId, name: input.name } };
    }
    case "viron_connection_group_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), groupId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/connection-groups/${input.groupId}`, workspace: input.workspace };
    }
    case "viron_connections_assign": {
      const input = z.object({ workspace: workspaceSchema.optional(), items: z.array(connectionItemSchema).min(1).max(500), environmentIds: z.array(uuidSchema).max(100).default([]) }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/connections/assign", workspace: input.workspace, body: { items: input.items, environmentIds: input.environmentIds } };
    }
    case "viron_connections_bulk_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), items: z.array(connectionItemSchema).min(1).max(500) }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/connections/bulk-delete", workspace: input.workspace, body: { items: input.items } };
    }
    case "viron_knowledge_node_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema.optional(), node: knowledgeNodeInputSchema }).parse(rawArguments);
      return { method: "POST", path: input.environmentId ? `/api/v1/environments/${input.environmentId}/knowledge/nodes` : "/api/v1/knowledge/nodes", workspace: input.workspace, body: input.node };
    }
    case "viron_knowledge_node_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), nodeId: uuidSchema, name: z.string().trim().min(1).max(240), parentId: uuidSchema.nullable().default(null) }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/knowledge-nodes/${input.nodeId}`, workspace: input.workspace, body: { name: input.name, parentId: input.parentId } };
    }
    case "viron_knowledge_node_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), nodeId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/knowledge-nodes/${input.nodeId}`, workspace: input.workspace };
    }
    case "viron_knowledge_node_environments_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), nodeId: uuidSchema, add: z.array(uuidSchema).max(1000).default([]), remove: z.array(uuidSchema).max(1000).default([]) }).parse(rawArguments);
      return { method: "PATCH", path: `/api/v1/knowledge-nodes/${input.nodeId}/environments`, workspace: input.workspace, body: { add: input.add, remove: input.remove } };
    }
    case "viron_knowledge_documents_associate": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema, nodeIds: z.array(uuidSchema).min(1).max(1000) }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/environments/${input.environmentId}/knowledge/associations`, workspace: input.workspace, body: { nodeIds: input.nodeIds } };
    }
    case "viron_knowledge_document_content_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), documentId: uuidSchema, content: z.string().max(2 * 1024 * 1024), revision: z.number().int().min(1) }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/knowledge-documents/${input.documentId}/content`, workspace: input.workspace, body: { content: input.content, revision: input.revision } };
    }
    case "viron_web_entry_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema, entry: webEntryInputSchema }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/environments/${input.environmentId}/web-entries`, workspace: input.workspace, body: input.entry };
    }
    case "viron_web_entry_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), entryId: uuidSchema, entry: webEntryInputSchema }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/web-entries/${input.entryId}`, workspace: input.workspace, body: input.entry };
    }
    case "viron_web_entry_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), entryId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/web-entries/${input.entryId}`, workspace: input.workspace };
    }
    case "viron_web_entries_reorder": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema, orderedIds: z.array(uuidSchema).max(200) }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/environments/${input.environmentId}/web-entries/order`, workspace: input.workspace, body: { orderedIds: input.orderedIds } };
    }
    case "viron_web_credential_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), credentialId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/web-credentials/${input.credentialId}`, workspace: input.workspace };
    }
    case "viron_web_credentials_reorder": {
      const input = z.object({ workspace: workspaceSchema.optional(), webEntryId: uuidSchema, orderedIds: z.array(uuidSchema).max(200) }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/web-entries/${input.webEntryId}/credentials/order`, workspace: input.workspace, body: { orderedIds: input.orderedIds } };
    }
    case "viron_environment_log_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), environmentId: uuidSchema, log: environmentLogInputSchema }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/environments/${input.environmentId}/logs`, workspace: input.workspace, body: input.log };
    }
    case "viron_environment_log_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), logId: uuidSchema, log: environmentLogInputSchema }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/environment-logs/${input.logId}`, workspace: input.workspace, body: input.log };
    }
    case "viron_environment_log_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), logId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/environment-logs/${input.logId}`, workspace: input.workspace };
    }
    case "viron_active_connection_close": {
      const input = z.object({ workspace: workspaceSchema.optional(), activeConnectionId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/active-connections/${input.activeConnectionId}`, workspace: input.workspace };
    }
    case "viron_ssh_command_favorites_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema }).parse(rawArguments);
      return { path: "/api/v1/ssh-command-favorites", workspace: input.workspace, query: { connectionId: input.connectionId } };
    }
    case "viron_ssh_command_favorite_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), favorite: sshFavoriteInputSchema }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/ssh-command-favorites", workspace: input.workspace, body: input.favorite };
    }
    case "viron_ssh_command_favorite_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), favoriteId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/ssh-command-favorites/${input.favoriteId}`, workspace: input.workspace };
    }
    case "viron_database_saved_queries_list": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema.optional(), database: z.string().trim().max(255).optional() }).parse(rawArguments);
      return { path: "/api/v1/database-saved-queries", workspace: input.workspace, query: { connectionId: input.connectionId, database: input.database } };
    }
    case "viron_database_saved_query_create": {
      const input = z.object({ workspace: workspaceSchema.optional(), query: savedQueryInputSchema }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/database-saved-queries", workspace: input.workspace, body: input.query };
    }
    case "viron_database_saved_query_update": {
      const input = z.object({ workspace: workspaceSchema.optional(), queryId: uuidSchema, query: savedQueryInputSchema }).parse(rawArguments);
      return { method: "PUT", path: `/api/v1/database-saved-queries/${input.queryId}`, workspace: input.workspace, body: input.query };
    }
    case "viron_database_saved_query_delete": {
      const input = z.object({ workspace: workspaceSchema.optional(), queryId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/database-saved-queries/${input.queryId}`, workspace: input.workspace };
    }
    case "viron_business_change": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        operation: z.string().trim().min(1).max(160),
        input: z.record(z.string(), z.unknown()).default({}),
      }).parse(rawArguments);
      return resolveMcpBusinessOperation("change", input.operation, input.input, input.workspace).request;
    }
    case "viron_operation_get": {
      const input = z.object({ workspace: workspaceSchema.optional(), operationId: uuidSchema }).parse(rawArguments);
      return { path: `/api/v1/mcp/operations/${input.operationId}`, workspace: input.workspace };
    }
    case "viron_operation_purpose_provide": {
      const input = z.object({ workspace: workspaceSchema.optional(), operationId: uuidSchema, purpose: operationPurposeSchema }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/mcp/operations/${input.operationId}/purpose`, workspace: input.workspace, body: { purpose: input.purpose } };
    }
    case "viron_operation_cancel": {
      const input = z.object({ workspace: workspaceSchema.optional(), operationId: uuidSchema }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/mcp/operations/${input.operationId}`, workspace: input.workspace };
    }
    case "viron_ssh_connection_secure_create":
    case "viron_ssh_connection_secure_update": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        connectionId: toolName.endsWith("_update") ? uuidSchema : uuidSchema.optional(),
        config: sshConnectionConfigSchema,
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        config: input.config,
      });
    }
    case "viron_database_connection_secure_create":
    case "viron_database_connection_secure_update": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        connectionId: toolName.endsWith("_update") ? uuidSchema : uuidSchema.optional(),
        config: databaseConnectionConfigSchema,
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        config: input.config,
      });
    }
    case "viron_database_connection_profile_secure_create":
    case "viron_database_connection_profile_secure_update": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        connectionId: uuidSchema,
        profileId: toolName.endsWith("_update") ? uuidSchema : uuidSchema.optional(),
        config: databaseConnectionProfileConfigSchema,
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        connectionId: input.connectionId,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        config: input.config,
      });
    }
    case "viron_redis_connection_secure_create":
    case "viron_redis_connection_secure_update": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        connectionId: toolName.endsWith("_update") ? uuidSchema : uuidSchema.optional(),
        config: redisConnectionConfigSchema,
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        config: input.config,
      });
    }
    case "viron_web_credential_secure_create": {
      const input = z.object({
        workspace: workspaceSchema.optional(), webEntryId: uuidSchema, username: z.string().trim().min(1).max(256),
        note: z.string().trim().max(1000).default(""), customFields: z.record(z.string(), z.string()).default({}),
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        webEntryId: input.webEntryId, username: input.username, note: input.note, customFields: input.customFields,
      });
    }
    case "viron_web_credential_secure_update": {
      const input = z.object({
        workspace: workspaceSchema.optional(), credentialId: uuidSchema, username: z.string().trim().min(1).max(256),
        note: z.string().trim().max(1000).default(""), customFields: z.record(z.string(), z.string()).default({}),
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        credentialId: input.credentialId, username: input.username, note: input.note, customFields: input.customFields,
      });
    }
    case "viron_ssh_key_secure_import": {
      const input = z.object({ workspace: workspaceSchema.optional(), name: z.string().trim().min(1).max(160) }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { name: input.name });
    }
    case "viron_ssh_key_secure_generate": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        name: z.string().trim().min(1).max(160),
        algorithm: z.enum(["ed25519", "rsa3072", "rsa4096"]).default("ed25519"),
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { name: input.name, algorithm: input.algorithm });
    }
    case "viron_connection_source_secure_create":
    case "viron_connection_source_secure_update": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        sourceId: toolName.endsWith("_update") ? uuidSchema : uuidSchema.optional(),
        config: connectionSourceConfigSchema,
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        config: input.config,
      });
    }
    case "viron_connection_import_secure_preview": {
      const input = z.object({ workspace: workspaceSchema.optional(), type: z.enum(["securecrt", "navicat"]) }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { type: input.type });
    }
    case "viron_ssh_command_request": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, command: z.string().trim().min(1).max(256 * 1024),
        timeoutMs: z.number().int().min(1000).max(120_000).default(30_000), maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { connectionId: input.connectionId, command: input.command, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes });
    }
    case "viron_database_write_request": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().max(255).default(""), sql: z.string().min(1).max(1024 * 1024),
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { connectionId: input.connectionId, database: input.database, sql: assertMcpWriteSql(input.sql) });
    }
    case "viron_redis_write_request": {
      const input = z.object({
        workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(), command: z.string(), args: z.array(redisArgumentSchema).max(256).default([]),
      }).parse(rawArguments);
      const command = assertMcpRedisWriteCommand(input.command, input.args);
      return operationApiRequest(input.workspace, toolName, { connectionId: input.connectionId, database: input.database, ...command });
    }
    case "viron_sftp_mkdir_request":
    case "viron_sftp_delete_request": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096) }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { connectionId: input.connectionId, path: input.path });
    }
    case "viron_sftp_rename_request": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096), newPath: z.string().min(1).max(4096) }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { connectionId: input.connectionId, path: input.path, newPath: input.newPath });
    }
    case "viron_sftp_chmod_request": {
      const input = z.object({ workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096), mode: z.string().regex(/^[0-7]{3,4}$/) }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, { connectionId: input.connectionId, path: input.path, mode: input.mode });
    }
    case "viron_sftp_transfer_request": {
      const input = z.object({
        workspace: workspaceSchema.optional(), sourceConnectionId: uuidSchema, targetConnectionId: uuidSchema,
        sourcePath: z.string().min(1).max(4096), targetDirectory: z.string().min(1).max(4096), conflict: z.enum(["overwrite", "skip"]),
      }).parse(rawArguments);
      return operationApiRequest(input.workspace, toolName, {
        sourceConnectionId: input.sourceConnectionId, targetConnectionId: input.targetConnectionId,
        sourcePath: input.sourcePath, targetDirectory: input.targetDirectory, conflict: input.conflict,
      });
    }
    case "viron_web_action_request": {
      const input = z.object({
        workspace: workspaceSchema.optional(), credentialId: uuidSchema, action: z.enum(["click", "fill", "select", "submit"]),
        elementIndex: z.number().int().min(0).max(199), value: z.string().max(256 * 1024).optional(), expectedName: z.string().trim().max(500).optional(),
      }).parse(rawArguments);
      if (["fill", "select"].includes(input.action) && input.value === undefined) throw new Error(`${input.action} 操作必须提供 value`);
      return operationApiRequest(input.workspace, toolName, {
        credentialId: input.credentialId, action: input.action, elementIndex: input.elementIndex,
        ...(input.value === undefined ? {} : { value: input.value }), ...(input.expectedName ? { expectedName: input.expectedName } : {}),
      });
    }
    case "viron_business_risk_request": {
      const input = z.object({
        workspace: workspaceSchema.optional(),
        operation: z.string().trim().min(1).max(160),
        input: z.record(z.string(), z.unknown()).default({}),
      }).parse(rawArguments);
      resolveMcpBusinessOperation("risk", input.operation, input.input, input.workspace);
      return operationApiRequest(input.workspace, toolName, { operation: input.operation, input: input.input });
    }
    case "__resource_current_context":
      z.object({}).parse(rawArguments);
      return { path: "/api/v1/auth/me" };
    default:
      throw new Error(`Viron MCP 工具未注册或已被禁止：${toolName}`);
  }
}

export function resolveVironMcpApiRequest(toolName: string, rawArguments: Record<string, unknown>): McpApiRequest {
  return assertMcpApiRequestAllowed(resolveVironMcpApiRequestUnchecked(toolName, rawArguments));
}

function resolveVironMcpApprovedRequestUnchecked(toolName: string, rawArguments: Record<string, unknown>): McpApiRequest {
  switch (toolName) {
    case "viron_ssh_command_request": {
      const input = z.object({ connectionId: uuidSchema, command: z.string().trim().min(1).max(256 * 1024), timeoutMs: z.number().int().min(1000).max(120_000), maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024) }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/mcp/ssh-connections/${input.connectionId}/command`, body: { command: input.command, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes } };
    }
    case "viron_database_write_request": {
      const input = z.object({ connectionId: uuidSchema, database: z.string().trim().max(255).default(""), sql: z.string() }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/database-connections/${input.connectionId}/queries`, body: { database: input.database, sql: assertMcpWriteSql(input.sql), continueOnError: false } };
    }
    case "viron_redis_write_request": {
      const input = z.object({ connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(), command: z.string(), args: z.array(redisArgumentSchema).max(256).default([]) }).parse(rawArguments);
      const command = assertMcpRedisWriteCommand(input.command, input.args);
      return { method: "POST", path: `/api/v1/redis-connections/${input.connectionId}/command`, body: { database: input.database, ...command } };
    }
    case "viron_sftp_mkdir_request": {
      const input = z.object({ connectionId: uuidSchema, path: z.string().min(1).max(4096) }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/ssh-connections/${input.connectionId}/sftp/mkdir`, body: { path: input.path } };
    }
    case "viron_sftp_rename_request": {
      const input = z.object({ connectionId: uuidSchema, path: z.string().min(1).max(4096), newPath: z.string().min(1).max(4096) }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/ssh-connections/${input.connectionId}/sftp/rename`, body: { path: input.path, newPath: input.newPath } };
    }
    case "viron_sftp_chmod_request": {
      const input = z.object({ connectionId: uuidSchema, path: z.string().min(1).max(4096), mode: z.string().regex(/^[0-7]{3,4}$/) }).parse(rawArguments);
      return { method: "POST", path: `/api/v1/ssh-connections/${input.connectionId}/sftp/chmod`, body: { path: input.path, mode: input.mode } };
    }
    case "viron_sftp_delete_request": {
      const input = z.object({ connectionId: uuidSchema, path: z.string().min(1).max(4096) }).parse(rawArguments);
      return { method: "DELETE", path: `/api/v1/ssh-connections/${input.connectionId}/sftp`, body: { path: input.path } };
    }
    case "viron_sftp_transfer_request": {
      const input = z.object({ sourceConnectionId: uuidSchema, targetConnectionId: uuidSchema, sourcePath: z.string().min(1).max(4096), targetDirectory: z.string().min(1).max(4096), conflict: z.enum(["overwrite", "skip"]) }).parse(rawArguments);
      return { method: "POST", path: "/api/v1/sftp-transfers", body: input };
    }
    case "viron_web_action_request": {
      const input = z.object({ credentialId: uuidSchema, action: z.enum(["click", "fill", "select", "submit"]), elementIndex: z.number().int().min(0).max(199), value: z.string().max(256 * 1024).optional(), expectedName: z.string().trim().max(500).optional() }).parse(rawArguments);
      if (["fill", "select"].includes(input.action) && input.value === undefined) throw new Error(`${input.action} 操作必须提供 value`);
      return { method: "POST", path: `/api/v1/mcp/web-credentials/${input.credentialId}/action`, body: input };
    }
    case "viron_business_risk_request": {
      const input = z.object({
        operation: z.string().trim().min(1).max(160),
        input: z.record(z.string(), z.unknown()).default({}),
      }).parse(rawArguments);
      return resolveMcpBusinessOperation("risk", input.operation, input.input).request;
    }
    default:
      throw new Error(`Viron MCP 操作不支持确认后执行：${toolName}`);
  }
}

export function resolveVironMcpApprovedRequest(toolName: string, rawArguments: Record<string, unknown>): McpApiRequest {
  return assertMcpApiRequestAllowed(resolveVironMcpApprovedRequestUnchecked(toolName, rawArguments));
}

type McpToolConfig = {
  title: string;
  description: string;
  inputSchema?: Record<string, z.ZodType>;
};

type McpAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type LegacyMcpToolDefinition = {
  config: McpToolConfig;
  annotations: McpAnnotations;
};

type VironMcpOperationMode = "read" | "change" | "risk" | "secure";
type VironMcpRiskLevel = "low" | "medium" | "high";
type VironMcpExecution = "service" | "current-mode";

type VironMcpCatalogOperation = {
  id: string;
  source: "specialized" | "business";
  domain: string;
  title: string;
  description: string;
  mode: VironMcpOperationMode;
  riskLevel: VironMcpRiskLevel;
  execution: VironMcpExecution;
  inputSchema: Record<string, unknown>;
  inputSummary: string[];
  schemaHash: string;
};

const replacedLegacyToolNames = new Set([
  "viron_business_operations_list",
  "viron_business_read",
  "viron_business_change",
  "viron_business_risk_request",
  "viron_operation_get",
  "viron_operation_purpose_provide",
  "viron_operation_cancel",
]);

const secureLegacyToolNames = new Set([
  "viron_ssh_connection_secure_create",
  "viron_ssh_connection_secure_update",
  "viron_database_connection_secure_create",
  "viron_database_connection_secure_update",
  "viron_database_connection_profile_secure_create",
  "viron_database_connection_profile_secure_update",
  "viron_redis_connection_secure_create",
  "viron_redis_connection_secure_update",
  "viron_web_credential_secure_create",
  "viron_web_credential_secure_update",
  "viron_ssh_key_secure_import",
  "viron_ssh_key_secure_generate",
  "viron_connection_source_secure_create",
  "viron_connection_source_secure_update",
  "viron_connection_import_secure_preview",
]);

const riskLegacyToolNames = new Set([
  "viron_ssh_command_request",
  "viron_database_write_request",
  "viron_redis_write_request",
  "viron_sftp_mkdir_request",
  "viron_sftp_rename_request",
  "viron_sftp_chmod_request",
  "viron_sftp_delete_request",
  "viron_sftp_transfer_request",
  "viron_web_action_request",
]);

const domainDescriptions: Record<string, string> = {
  system: "Viron 服务能力和运行信息。",
  workspace: "当前身份、工作空间和工作空间总览。",
  environment: "环境、环境组、别名和排序。",
  connections: "SSH、数据库和 Redis 连接目录、分组、来源、巡检和活动连接。",
  knowledge: "知识库目录、文档、内容、关联和导入导出。",
  audit: "审计事件和审计筛选信息。",
  ssh: "SSH 命令、密钥、收藏、SFTP、主机间传输和环境日志。",
  database: "数据库连接、Schema、DDL、查询、表数据、备份、同步、导入导出和数据处理。",
  redis: "Redis 连接、INFO、键扫描和受控命令。",
  web: "Web 入口、凭据安全输入、语义快照和受控页面操作。",
};

function normalizeCatalogDomain(domain: string): string {
  return domain === "sftp" ? "ssh" : domain;
}

function legacyToolDomain(name: string): string {
  if (name === "viron_capabilities_get") return "system";
  if (/^viron_(context|workspaces|dashboard)/.test(name)) return "workspace";
  if (/^viron_(environment_log_snapshot|environment_logs_|ssh_|sftp_)/.test(name)) return "ssh";
  if (/^viron_database_/.test(name)) return "database";
  if (/^viron_redis_/.test(name)) return "redis";
  if (/^viron_web_/.test(name)) return "web";
  if (/^viron_knowledge_/.test(name)) return "knowledge";
  if (/^viron_audit_/.test(name)) return "audit";
  if (/^viron_environments?_/.test(name)) return "environment";
  if (/^viron_(connection|connections|active_connection)/.test(name)) return "connections";
  return "system";
}

function legacyToolMode(name: string, annotations: McpAnnotations): VironMcpOperationMode {
  if (annotations.readOnlyHint) return "read";
  if (secureLegacyToolNames.has(name)) return "secure";
  if (riskLegacyToolNames.has(name)) return "risk";
  return "change";
}

function operationRiskLevel(mode: VironMcpOperationMode, annotations?: McpAnnotations): VironMcpRiskLevel {
  if (mode === "read") return "low";
  if (mode === "risk" || mode === "secure" || annotations?.destructiveHint) return "high";
  return "medium";
}

function normalizeOperationInputSchema(rawSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = structuredClone(rawSchema);
  const properties = schema.properties && typeof schema.properties === "object"
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  delete properties.workspace;
  schema.properties = properties;
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((name): name is string => {
      if (typeof name !== "string" || name === "workspace") return false;
      const property = properties[name];
      return !(property && typeof property === "object" && "default" in property);
    });
    if (required.length) schema.required = required;
    else delete schema.required;
  }
  return schema;
}

function schemaForLegacyTool(definition: LegacyMcpToolDefinition): Record<string, unknown> {
  return normalizeOperationInputSchema(z.toJSONSchema(z.object(definition.config.inputSchema ?? {})) as Record<string, unknown>);
}

function inputSummaryForSchema(schema: Record<string, unknown>): string[] {
  const properties = schema.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties as Record<string, unknown>)
    : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  return properties.map((name) => required.has(name) ? name : `${name}?`);
}

function operationSchemaHash(schema: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16);
}

function buildOperationCatalog(definitions: Map<string, LegacyMcpToolDefinition>): VironMcpCatalogOperation[] {
  const specialized = [...definitions.entries()]
    .filter(([name]) => !replacedLegacyToolNames.has(name))
    .map(([id, definition]): VironMcpCatalogOperation => {
      const inputSchema = schemaForLegacyTool(definition);
      const mode = legacyToolMode(id, definition.annotations);
      return {
        id,
        source: "specialized",
        domain: legacyToolDomain(id),
        title: definition.config.title,
        description: definition.config.description,
        mode,
        riskLevel: operationRiskLevel(mode, definition.annotations),
        execution: definition.annotations.openWorldHint ? "current-mode" : "service",
        inputSchema,
        inputSummary: inputSummaryForSchema(inputSchema),
        schemaHash: operationSchemaHash(inputSchema),
      };
    });
  const business = listMcpBusinessOperations().map((operation): VironMcpCatalogOperation => {
    const inputSchema = normalizeOperationInputSchema(operation.inputSchema as Record<string, unknown>);
    return {
      id: operation.id,
      source: "business",
      domain: normalizeCatalogDomain(operation.domain),
      title: operation.title,
      description: operation.description,
      mode: operation.mode,
      riskLevel: operation.riskLevel,
      execution: operation.execution,
      inputSchema,
      inputSummary: inputSummaryForSchema(inputSchema),
      schemaHash: operationSchemaHash(inputSchema),
    };
  });
  const catalog = [...specialized, ...business].sort((left, right) => left.id.localeCompare(right.id));
  const duplicate = catalog.find((operation, index) => catalog.findIndex((candidate) => candidate.id === operation.id) !== index);
  if (duplicate) throw new Error(`Viron MCP operation ID 重复：${duplicate.id}`);
  if (definitions.size !== LEGACY_VIRON_MCP_TOOL_NAMES.length) {
    throw new Error(`Viron MCP 内部工具定义数量不一致：${definitions.size}/${LEGACY_VIRON_MCP_TOOL_NAMES.length}`);
  }
  return catalog;
}

function compactCatalogOperation(operation: VironMcpCatalogOperation) {
  return {
    id: operation.id,
    domain: operation.domain,
    title: operation.title,
    description: operation.description,
    mode: operation.mode,
    riskLevel: operation.riskLevel,
    execution: operation.execution,
    inputSummary: operation.inputSummary,
    schemaHash: operation.schemaHash,
  };
}

function catalogSearchTerms(query: string, domain?: string): string[] {
  if (!query) return [];
  const normalized = query.toLocaleLowerCase();
  return [...new Set([normalized, ...normalized.split(/[\s._-]+/).filter((term) => term.length > 1)])]
    .filter((term) => term !== domain);
}

function catalogSearchScore(operation: VironMcpCatalogOperation, terms: string[]): number {
  if (!terms.length) return 0;
  const id = operation.id.toLocaleLowerCase();
  const title = operation.title.toLocaleLowerCase();
  const description = operation.description.toLocaleLowerCase();
  const inputs = operation.inputSummary.join(" ").toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    if (id === term) score += 1000;
    if (id.startsWith(term)) score += 300;
    else if (id.includes(term)) score += 180;
    if (title.includes(term)) score += 220;
    if (description.includes(term)) score += 100;
    if (operation.domain.includes(term)) score += 80;
    if (inputs.includes(term)) score += 40;
  }
  return score;
}

function catalogToolResult(status: number, data: unknown) {
  return toolResult({ status, headers: { "content-type": "application/json" }, data });
}

function operationInvocationInput(rawArguments: Record<string, unknown>) {
  return z.object({
    workspace: workspaceSchema.optional(),
    operation: z.string().trim().min(1).max(160),
    input: z.record(z.string(), z.unknown()).default({}),
    schemaHash: z.string().regex(/^[0-9a-f]{16}$/i).optional(),
  }).parse(rawArguments);
}

function registerCompactVironMcpTools(
  server: McpServer,
  backend: VironMcpBackend,
  definitions: Map<string, LegacyMcpToolDefinition>,
): void {
  type ToolResult = Awaited<ReturnType<typeof invoke>>;
  type RegisterTool = (
    name: string,
    config: McpToolConfig & { annotations: McpAnnotations },
    callback: (arguments_?: Record<string, unknown>) => Promise<ToolResult>,
  ) => unknown;
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  const catalog = buildOperationCatalog(definitions);
  const operationById = new Map(catalog.map((operation) => [operation.id, operation]));
  const expose = (
    name: typeof VIRON_MCP_TOOL_NAMES[number],
    config: McpToolConfig,
    annotations: McpAnnotations,
    callback: (arguments_: Record<string, unknown>) => Promise<ToolResult>,
  ) => register(name, { ...config, annotations }, (arguments_ = {}) => callback(arguments_));

  expose("viron_context", {
    title: "获取当前 Viron 上下文",
    description: "返回当前 MCP 用户、工作空间和可访问工作空间。开始 Viron 任务时优先调用。",
    inputSchema: { workspace: workspaceSchema.optional() },
  }, readAnnotations, (arguments_) => invoke(backend, "viron_context_get", arguments_));

  expose("viron_domains_list", {
    title: "列出 Viron 能力领域",
    description: "返回精简能力大纲和各领域操作数量，不返回任何操作 JSON Schema。先选领域，再搜索操作。",
  }, readAnnotations, async () => {
    const domains = [...new Set(catalog.map((operation) => operation.domain))].sort().map((domain) => {
      const operations = catalog.filter((operation) => operation.domain === domain);
      return {
        domain,
        description: domainDescriptions[domain] ?? `${domain} 领域操作。`,
        operationCount: operations.length,
        modes: Object.fromEntries(["read", "change", "risk", "secure"].map((mode) => [
          mode,
          operations.filter((operation) => operation.mode === mode).length,
        ])),
      };
    });
    return catalogToolResult(200, { catalogVersion: VIRON_MCP_CATALOG_VERSION, operationCount: catalog.length, domains });
  });

  expose("viron_operations_search", {
    title: "搜索 Viron 操作",
    description: "按领域、关键词和模式检索操作摘要，不返回完整 Schema。结果包含输入字段摘要；只有参数不明确时再查询单个 Schema。",
    inputSchema: {
      domain: z.string().trim().min(1).max(80).optional(),
      query: z.string().trim().max(200).default(""),
      mode: z.enum(["read", "change", "risk", "secure"]).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(20).default(10),
    },
  }, readAnnotations, async (arguments_) => {
    const input = z.object({
      domain: z.string().trim().min(1).max(80).optional(),
      query: z.string().trim().max(200).default(""),
      mode: z.enum(["read", "change", "risk", "secure"]).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(20).default(10),
    }).parse(arguments_);
    const domain = input.domain ? normalizeCatalogDomain(input.domain.toLocaleLowerCase()) : undefined;
    const searchTerms = catalogSearchTerms(input.query, domain);
    const ranked = catalog
      .map((operation) => ({ operation, score: catalogSearchScore(operation, searchTerms) }))
      .filter(({ operation, score }) => (!domain || operation.domain === domain) && (!input.mode || operation.mode === input.mode) && (!searchTerms.length || score > 0))
      .sort((left, right) => right.score - left.score || left.operation.id.localeCompare(right.operation.id));
    const items = ranked.slice(input.offset, input.offset + input.limit).map(({ operation }) => compactCatalogOperation(operation));
    return catalogToolResult(200, {
      catalogVersion: VIRON_MCP_CATALOG_VERSION,
      total: ranked.length,
      offset: input.offset,
      nextOffset: input.offset + items.length < ranked.length ? input.offset + items.length : null,
      items,
    });
  });

  expose("viron_operation_schema", {
    title: "读取单个 Viron 操作 Schema",
    description: "只返回一个操作的完整 JSON Schema。搜索摘要的 inputSummary 已足够时不要调用，以减少延迟和 token。",
    inputSchema: { operation: z.string().trim().min(1).max(160) },
  }, readAnnotations, async (arguments_) => {
    const { operation: id } = z.object({ operation: z.string().trim().min(1).max(160) }).parse(arguments_);
    const operation = operationById.get(id);
    if (!operation) return catalogToolResult(404, { error: "MCP_OPERATION_NOT_FOUND", message: `Viron MCP 操作不存在：${id}` });
    return catalogToolResult(200, { catalogVersion: VIRON_MCP_CATALOG_VERSION, operation });
  });

  const execute = async (mode: VironMcpOperationMode, arguments_: Record<string, unknown>) => {
    const input = operationInvocationInput(arguments_);
    const operation = operationById.get(input.operation);
    if (!operation) return catalogToolResult(404, { error: "MCP_OPERATION_NOT_FOUND", message: `Viron MCP 操作不存在：${input.operation}` });
    if (operation.mode !== mode) {
      return catalogToolResult(400, {
        error: "MCP_OPERATION_MODE_MISMATCH",
        message: `${input.operation} 必须通过 viron_${operation.mode} 调用`,
        expectedMode: operation.mode,
      });
    }
    if (input.schemaHash && input.schemaHash !== operation.schemaHash) {
      return catalogToolResult(409, {
        error: "MCP_OPERATION_SCHEMA_CHANGED",
        message: "操作 Schema 已变化，请重新查询 viron_operation_schema。",
        schemaHash: operation.schemaHash,
      });
    }
    if (operation.source === "business") {
      const dispatcher = mode === "read"
        ? "viron_business_read"
        : mode === "change"
          ? "viron_business_change"
          : "viron_business_risk_request";
      return invoke(backend, dispatcher, { workspace: input.workspace, operation: operation.id, input: input.input });
    }
    return invoke(backend, operation.id, { ...input.input, ...(input.workspace ? { workspace: input.workspace } : {}) });
  };

  const invocationSchema = {
    workspace: workspaceSchema.optional(),
    operation: z.string().trim().min(1).max(160),
    input: z.record(z.string(), z.unknown()).default({}),
    schemaHash: z.string().regex(/^[0-9a-f]{16}$/i).optional(),
  };
  expose("viron_read", {
    title: "执行 Viron 只读操作",
    description: "执行搜索结果中 mode=read 的操作。input 必须符合该 operation 的 Schema；服务端仍执行权限、范围和结果限制。",
    inputSchema: invocationSchema,
  }, executionReadAnnotations, (arguments_) => execute("read", arguments_));
  expose("viron_change", {
    title: "执行 Viron 配置变更",
    description: "执行搜索结果中 mode=change 的普通业务变更。服务端继续执行权限、白名单、审计和数据校验。",
    inputSchema: invocationSchema,
  }, secureMutationAnnotations, (arguments_) => execute("change", arguments_));
  expose("viron_risk", {
    title: "请求执行 Viron 风险操作",
    description: "执行搜索结果中 mode=risk 的外部或高风险操作，按 Viron 审批策略创建或自动消费一次性 Operation。",
    inputSchema: invocationSchema,
  }, confirmedWriteAnnotations, (arguments_) => execute("risk", arguments_));
  expose("viron_secure", {
    title: "创建 Viron 凭据安全操作",
    description: "执行搜索结果中 mode=secure 的连接、密钥或凭据新增更新。秘密只能在 Viron 安全页面或 App 安全窗口输入。",
    inputSchema: invocationSchema,
  }, secureMutationAnnotations, (arguments_) => execute("secure", arguments_));

  expose("viron_operation_status", {
    title: "读取 Viron Operation 状态",
    description: "读取风险或凭据安全 Operation 的状态和脱敏结果。",
    inputSchema: { workspace: workspaceSchema.optional(), operationId: uuidSchema },
  }, readAnnotations, (arguments_) => invoke(backend, "viron_operation_get", arguments_));
  expose("viron_operation_purpose", {
    title: "补充 Viron Operation 执行意图",
    description: "仅在 Operation 返回 awaiting_purpose 时调用，提交一句业务目标和原因后再由 Viron 处理审批。",
    inputSchema: { workspace: workspaceSchema.optional(), operationId: uuidSchema, purpose: operationPurposeSchema },
  }, secureMutationAnnotations, (arguments_) => invoke(backend, "viron_operation_purpose_provide", arguments_));
  expose("viron_operation_cancel", {
    title: "取消 Viron Operation",
    description: "取消仍在等待用户输入、等待确认或等待本机执行的 Operation。",
    inputSchema: { workspace: workspaceSchema.optional(), operationId: uuidSchema },
  }, cancelAnnotations, (arguments_) => invoke(backend, "viron_operation_cancel", arguments_));
}

export function registerVironMcpTools(server: McpServer, backend: VironMcpBackend): void {
  const definitions = new Map<string, LegacyMcpToolDefinition>();
  const registerTool = (
    name: string,
    config: McpToolConfig,
    annotations: McpAnnotations,
  ) => definitions.set(name, { config, annotations });
  const registerReadTool = (
    name: string,
    config: McpToolConfig,
  ) => registerTool(name, config, readAnnotations);

  registerReadTool("viron_capabilities_get", {
    title: "获取 Viron 能力",
    description: "返回当前 Viron 服务版本、客户端能力和可用执行方式。",
  });
  registerReadTool("viron_context_get", {
    title: "获取当前 Viron 身份上下文",
    description: "返回当前 MCP 用户、目标工作空间和该用户可以访问的工作空间。",
    inputSchema: { workspace: workspaceSchema.optional() },
  });
  registerReadTool("viron_workspaces_list", {
    title: "列出 Viron 工作空间",
    description: "列出当前 MCP 用户可以访问的个人和组织工作空间。",
  });
  registerReadTool("viron_dashboard_get", {
    title: "读取 Viron 工作空间总览",
    description: "读取指定工作空间的环境、连接、待分配和异常数量。",
    inputSchema: { workspace: workspaceSchema.optional() },
  });
  registerReadTool("viron_environment_groups_list", {
    title: "列出环境组",
    description: "列出指定 Viron 工作空间中当前用户可访问的环境组。",
    inputSchema: { workspace: workspaceSchema.optional() },
  });
  registerReadTool("viron_environments_list", {
    title: "列出环境",
    description: "按名称、状态或环境组筛选当前用户可访问的 Viron 环境。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      query: z.string().trim().max(200).optional(),
      status: z.enum(["active", "maintenance", "error", "disabled"]).optional(),
      groupId: z.union([uuidSchema, z.literal("ungrouped")]).optional(),
    },
  });
  registerReadTool("viron_environment_get", {
    title: "读取环境详情",
    description: "读取一个 Viron 环境的元数据和资源数量。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema },
  });
  registerReadTool("viron_connection_groups_list", {
    title: "列出连接组",
    description: "列出 SSH、数据库或 Redis 连接组。",
    inputSchema: { workspace: workspaceSchema.optional(), type: z.enum(["ssh", "database", "redis"]).optional() },
  });
  registerReadTool("viron_connections_list", {
    title: "列出连接",
    description: "列出当前用户可访问的 SSH、数据库和 Redis 连接；只返回非敏感元数据和凭据存在标记。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      type: z.enum(["all", "ssh", "database", "redis"]).default("all"),
      assignment: z.enum(["all", "assigned", "unassigned"]).default("all"),
      environmentId: uuidSchema.optional(),
      query: z.string().trim().max(200).optional(),
      includeProfiles: z.boolean().default(false),
    },
  });
  registerReadTool("viron_knowledge_list", {
    title: "列出知识库",
    description: "列出工作空间或指定环境可访问的 Viron 知识库目录与文档。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema.optional() },
  });
  registerReadTool("viron_knowledge_document_read", {
    title: "读取知识库文档",
    description: "读取一个有权访问的 Viron Markdown 文档及其元数据。",
    inputSchema: { workspace: workspaceSchema.optional(), documentId: uuidSchema },
  });
  registerReadTool("viron_environment_web_entries_list", {
    title: "列出环境 Web 入口",
    description: "列出环境中的 Web 入口及账号非敏感元数据，不返回密码或 Cookie。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema },
  });
  registerReadTool("viron_environment_logs_list", {
    title: "列出环境日志配置",
    description: "列出指定环境中当前用户可访问的日志配置。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema },
  });
  registerReadTool("viron_audit_events_list", {
    title: "列出 Viron 审计事件",
    description: "分页读取当前用户有权查看的脱敏审计事件。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
      keyword: z.string().trim().max(200).optional(),
      actorUserId: uuidSchema.optional(),
    },
  });
  registerReadTool("viron_business_operations_list", {
    title: "列出 Viron 长尾业务操作",
    description: "列出专用工具之外可调用的白名单业务操作、输入字段、权限、模式和风险等级；账号安全、权限控制和秘密导出不会出现。",
    inputSchema: { workspace: workspaceSchema.optional(), mode: z.enum(MCP_BUSINESS_OPERATION_MODES).optional() },
  });

  registerReadTool("viron_web_credentials_list", {
    title: "列出 Web 登录账号",
    description: "列出指定 Web 入口的账号非敏感元数据；不返回密码、Cookie 或 Token。",
    inputSchema: { workspace: workspaceSchema.optional(), webEntryId: uuidSchema },
  });
  registerReadTool("viron_active_connections_list", {
    title: "列出活动连接",
    description: "列出当前用户可查看的活动 Web、SSH、SFTP、日志、数据库和 Redis 执行实例。",
    inputSchema: { workspace: workspaceSchema.optional() },
  });
  registerTool("viron_connections_inspect", {
    title: "巡检连接",
    description: "使用 Viron 保存的凭据并发测试指定 SSH、数据库或 Redis 连接，只返回可用性、延迟和脱敏错误。",
    inputSchema: { workspace: workspaceSchema.optional(), items: z.array(connectionItemSchema).min(1).max(500) },
  }, executionReadAnnotations);
  registerTool("viron_database_connection_test", {
    title: "测试数据库连接",
    description: "连接数据库并返回版本、连接 ID 和延迟，不返回连接密码。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema },
  }, executionReadAnnotations);
  registerTool("viron_database_schemas_list", {
    title: "列出数据库 Schema",
    description: "列出指定数据库连接可访问的 Schema、字符集和排序规则。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema },
  }, executionReadAnnotations);
  registerTool("viron_database_objects_list", {
    title: "列出数据库对象",
    description: "列出表、视图、存储过程、函数、触发器或事件。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().min(1).max(255),
      category: z.enum(["tables", "views", "procedures", "functions", "triggers", "events"]),
    },
  }, executionReadAnnotations);
  registerTool("viron_database_ddl_read", {
    title: "读取数据库对象 DDL",
    description: "读取一个数据库对象的 SHOW CREATE 结果。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().min(1).max(255),
      name: z.string().trim().min(1).max(255), type: z.enum(["table", "view", "procedure", "function", "trigger", "event"]),
    },
  }, executionReadAnnotations);
  registerTool("viron_database_table_data_read", {
    title: "分页读取数据表",
    description: "使用受限分页、筛选和排序读取数据表，单页最多 500 行。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255),
      page: z.number().int().min(1).default(1), pageSize: z.number().int().min(20).max(500).default(100), filters: z.array(tableFilterSchema).max(20).default([]), sorts: z.array(tableSortSchema).max(20).default([]),
    },
  }, executionReadAnnotations);
  registerTool("viron_database_query_read_start", {
    title: "执行只读 SQL",
    description: "启动一条 SELECT 或 EXPLAIN SELECT；拒绝多语句、文件写入和锁副作用。使用查询 ID 轮询结果。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().max(255).default(""), sql: z.string().min(1).max(1024 * 1024) },
  }, executionReadAnnotations);
  registerTool("viron_database_queries_read_batch", {
    title: "批量执行数据库只读查询",
    description: "在同一连接上顺序执行最多 20 条只读 SQL，复用短时数据库连接并返回每条查询的受限结果。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema,
      queries: z.array(z.object({ database: z.string().trim().max(255).default(""), sql: z.string().trim().min(1).max(1024 * 1024) })).min(1).max(20),
    },
  }, executionReadAnnotations);
  registerReadTool("viron_database_query_get", {
    title: "读取数据库查询结果",
    description: "按查询 ID 读取状态、耗时和受限结果集。",
    inputSchema: { workspace: workspaceSchema.optional(), queryId: uuidSchema },
  });
  registerTool("viron_database_query_cancel", {
    title: "取消数据库查询",
    description: "取消当前 MCP 执行实例中仍在运行的数据库查询。",
    inputSchema: { workspace: workspaceSchema.optional(), queryId: uuidSchema },
  }, cancelAnnotations);
  registerReadTool("viron_database_query_history_list", {
    title: "列出数据库查询历史",
    description: "分页读取当前用户有权查看的数据库查询历史。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema.optional(), status: z.enum(["pending", "running", "success", "error", "cancelled"]).optional(),
      page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50), keyword: z.string().trim().max(200).optional(),
    },
  });
  registerReadTool("viron_database_tasks_list", {
    title: "列出数据库后台任务",
    description: "列出备份、恢复、同步、迁移和导入任务。",
    inputSchema: { workspace: workspaceSchema.optional() },
  });
  registerReadTool("viron_database_task_get", {
    title: "读取数据库后台任务",
    description: "按任务 ID 读取状态、进度和脱敏错误。",
    inputSchema: { workspace: workspaceSchema.optional(), taskId: uuidSchema },
  });
  registerTool("viron_redis_connection_test", {
    title: "测试 Redis 连接",
    description: "连接 Redis 并执行 PING/INFO server，返回版本、模式和延迟。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema },
  }, executionReadAnnotations);
  registerTool("viron_redis_info_get", {
    title: "读取 Redis INFO",
    description: "读取指定 Redis 数据库的 INFO 结构化信息。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional() },
  }, executionReadAnnotations);
  registerTool("viron_redis_keys_scan", {
    title: "扫描 Redis 键",
    description: "使用 SCAN 游标、模式、类型和数量限制浏览 Redis 键空间。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(), cursor: z.string().regex(/^\d+$/).default("0"),
      pattern: z.string().max(1024).default("*"), count: z.number().int().min(10).max(1000).default(200), type: z.enum(["string", "hash", "list", "set", "zset", "stream"]).optional(),
    },
  }, executionReadAnnotations);
  registerTool("viron_redis_command_read", {
    title: "执行 Redis 只读命令",
    description: "执行策略允许且有明确边界的 Redis 只读命令；写命令、管理命令和无界读取会被拒绝。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(), command: z.string().trim().min(1).max(64), args: z.array(redisArgumentSchema).max(256).default([]),
    },
  }, executionReadAnnotations);
  registerTool("viron_redis_commands_read_batch", {
    title: "批量执行 Redis 只读命令",
    description: "在同一 Redis 连接上顺序执行最多 20 条有界只读命令，复用短时连接并分别返回结果。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema,
      commands: z.array(z.object({ database: z.number().int().min(0).max(1023).optional(), command: z.string().trim().min(1).max(64), args: z.array(redisArgumentSchema).max(256).default([]) })).min(1).max(20),
    },
  }, executionReadAnnotations);
  registerTool("viron_ssh_commands_read_batch", {
    title: "批量执行 SSH 只读命令",
    description: "在同一 SSH 连接上顺序执行最多 20 条可证明为只读的命令，避免重复握手；任一命令无法证明只读时整体拒绝。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema,
      commands: z.array(z.string().trim().min(1).max(256 * 1024)).min(1).max(20),
      timeoutMs: z.number().int().min(1000).max(120_000).default(30_000), maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
    },
  }, executionReadAnnotations);
  registerTool("viron_sftp_directory_list", {
    title: "浏览 SFTP 目录",
    description: "读取指定 SSH 连接上的远程目录条目、类型、大小、权限和修改时间。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096).default("/") },
  }, executionReadAnnotations);
  registerReadTool("viron_sftp_transfers_list", {
    title: "列出 SFTP 传输任务",
    description: "列出当前工作空间的主机间 SFTP 传输任务和进度。",
    inputSchema: { workspace: workspaceSchema.optional() },
  });
  registerTool("viron_sftp_transfer_preview", {
    title: "预览 SFTP 主机间传输",
    description: "检查源路径、目标路径、文件数、总大小和冲突情况，不执行复制。",
    inputSchema: {
      workspace: workspaceSchema.optional(), sourceConnectionId: uuidSchema, targetConnectionId: uuidSchema,
      sourcePath: z.string().min(1).max(4096), targetDirectory: z.string().min(1).max(4096),
    },
  }, executionReadAnnotations);
  registerTool("viron_environment_log_snapshot", {
    title: "读取环境日志快照",
    description: "通过关联的 SSH 连接读取一个环境日志配置的最近若干行，输出和字节数均受限。",
    inputSchema: {
      workspace: workspaceSchema.optional(), logId: uuidSchema, initialLines: z.number().int().min(1).max(5000).default(200), maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
    },
  }, executionReadAnnotations);
  registerTool("viron_web_page_snapshot", {
    title: "读取 Web 页面语义快照",
    description: "使用 Viron Web Runtime 打开已保存账号页面，返回页面标题、URL、可见文本和交互元素摘要；不返回密码、Cookie 或原始 CDP。",
    inputSchema: {
      workspace: workspaceSchema.optional(), credentialId: uuidSchema, width: z.number().int().min(320).max(1920).default(1280),
      height: z.number().int().min(240).max(1200).default(720), maxTextChars: z.number().int().min(1000).max(200_000).default(50_000),
    },
  }, executionReadAnnotations);
  registerTool("viron_business_read", {
    title: "执行 Viron 长尾只读操作",
    description: "执行 viron_business_operations_list 中 mode=read 的白名单业务读取。先查目录，再按 operation 和 input 调用。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      operation: z.string().trim().min(1).max(160),
      input: z.record(z.string(), z.unknown()).default({}),
    },
  }, executionReadAnnotations);

  registerTool("viron_operation_get", {
    title: "读取 Viron 操作状态",
    description: "读取安全凭据或风险确认 Operation 的状态和脱敏结果。状态为 awaiting_purpose 时，先调用 viron_operation_purpose_provide。",
    inputSchema: { workspace: workspaceSchema.optional(), operationId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_operation_purpose_provide", {
    title: "补充 Viron 审批意图",
    description: "仅在风险 Operation 返回 awaiting_purpose 时调用。只提交 Operation ID 和一句简短的业务目标、执行原因；提交后 Viron 才向用户展示审批页面。",
    inputSchema: { workspace: workspaceSchema.optional(), operationId: uuidSchema, purpose: operationPurposeSchema },
  }, secureMutationAnnotations);
  registerTool("viron_operation_cancel", {
    title: "取消 Viron 操作",
    description: "取消仍在等待用户输入、等待确认或等待本机执行的 Operation。",
    inputSchema: { workspace: workspaceSchema.optional(), operationId: uuidSchema },
  }, cancelAnnotations);

  registerTool("viron_ssh_connection_secure_create", {
    title: "安全创建 SSH 连接",
    description: "创建短时单次安全输入 Operation。Codex 只提交非敏感连接配置，用户在 Viron 页面或 App 安全窗口输入密码、私钥和口令。",
    inputSchema: { workspace: workspaceSchema.optional(), config: sshConnectionConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_ssh_connection_secure_update", {
    title: "安全更新 SSH 连接",
    description: "更新 SSH 非敏感配置，并由用户在 Viron 安全界面输入需要替换的密码、私钥或口令；留空的秘密保持不变。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, config: sshConnectionConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_database_connection_secure_create", {
    title: "安全创建数据库连接",
    description: "创建数据库连接 Operation；数据库密码和 HTTP Tunnel 凭据只在 Viron 安全界面输入，不经过 MCP。",
    inputSchema: { workspace: workspaceSchema.optional(), config: databaseConnectionConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_database_connection_secure_update", {
    title: "安全更新数据库连接",
    description: "更新数据库非敏感配置，并由用户在 Viron 安全界面输入需要替换的数据库或 HTTP Tunnel 凭据。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, config: databaseConnectionConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_database_connection_profile_secure_create", {
    title: "安全创建数据库连接配置档",
    description: "为数据库连接创建独立配置档。Codex 只提交非敏感参数；用户可在 Viron 安全界面补充独立密码、HTTP Tunnel 或 TLS 凭据，留空时沿用主配置凭据。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, config: databaseConnectionProfileConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_database_connection_profile_secure_update", {
    title: "安全更新数据库连接配置档",
    description: "更新数据库连接配置档的非敏感参数，并由用户在 Viron 安全界面输入需要替换的密码、HTTP Tunnel 或 TLS 凭据；留空保持不变。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, profileId: uuidSchema, config: databaseConnectionProfileConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_redis_connection_secure_create", {
    title: "安全创建 Redis 连接",
    description: "创建 Redis 连接 Operation；密码、TLS 私钥和相关口令只在 Viron 安全界面输入。",
    inputSchema: { workspace: workspaceSchema.optional(), config: redisConnectionConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_redis_connection_secure_update", {
    title: "安全更新 Redis 连接",
    description: "更新 Redis 非敏感配置，并由用户在 Viron 安全界面输入需要替换的密码或 TLS 凭据。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, config: redisConnectionConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_web_credential_secure_create", {
    title: "安全创建 Web 登录账号",
    description: "创建 Web 登录账号 Operation。Codex 提供账号非敏感元数据，用户在 Viron 安全界面输入密码。",
    inputSchema: {
      workspace: workspaceSchema.optional(), webEntryId: uuidSchema, username: z.string().trim().min(1).max(256),
      note: z.string().trim().max(1000).default(""), customFields: z.record(z.string(), z.string()).default({}),
    },
  }, secureMutationAnnotations);
  registerTool("viron_web_credential_secure_update", {
    title: "安全更新 Web 登录账号",
    description: "更新 Web 登录账号元数据，并由用户在 Viron 安全界面选择是否替换密码。",
    inputSchema: {
      workspace: workspaceSchema.optional(), credentialId: uuidSchema, username: z.string().trim().min(1).max(256),
      note: z.string().trim().max(1000).default(""), customFields: z.record(z.string(), z.string()).default({}),
    },
  }, secureMutationAnnotations);
  registerTool("viron_ssh_key_secure_import", {
    title: "安全导入 SSH 私钥",
    description: "创建安全输入 Operation。Codex 只提供密钥名称，用户在 Viron 安全界面粘贴私钥和口令；私钥不进入 MCP。",
    inputSchema: { workspace: workspaceSchema.optional(), name: z.string().trim().min(1).max(160) },
  }, secureMutationAnnotations);
  registerTool("viron_ssh_key_secure_generate", {
    title: "安全生成 SSH 密钥",
    description: "创建安全输入 Operation，在 Viron 内生成并保存 SSH 密钥；可选口令只在 Viron 安全界面输入，私钥不返回 MCP。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      name: z.string().trim().min(1).max(160),
      algorithm: z.enum(["ed25519", "rsa3072", "rsa4096"]).default("ed25519"),
    },
  }, secureMutationAnnotations);
  registerTool("viron_connection_source_secure_create", {
    title: "安全创建 SecureCRT 同步源",
    description: "创建 SecureCRT 同步源 Operation；SSH 密码、私钥和配置口令只在 Viron 安全界面输入。",
    inputSchema: { workspace: workspaceSchema.optional(), config: connectionSourceConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_connection_source_secure_update", {
    title: "安全更新 SecureCRT 同步源",
    description: "更新 SecureCRT 同步源非敏感配置，并由用户在 Viron 安全界面输入需要替换的秘密；留空保持不变。",
    inputSchema: { workspace: workspaceSchema.optional(), sourceId: uuidSchema, config: connectionSourceConfigSchema },
  }, secureMutationAnnotations);
  registerTool("viron_connection_import_secure_preview", {
    title: "安全预览连接文件导入",
    description: "创建安全文件 Operation。用户在 Viron 安全界面选择 SecureCRT 或 Navicat 文件并输入可选口令，文件和口令不经过 Codex。",
    inputSchema: { workspace: workspaceSchema.optional(), type: z.enum(["securecrt", "navicat"]) },
  }, secureMutationAnnotations);

  registerTool("viron_ssh_command_request", {
    title: "申请执行 SSH 命令",
    description: "创建 SSH 执行 Operation。可证明为只读的查询命令自动执行；修改状态或无法确认只读语义的命令需按 Viron 审批策略确认。命令使用当前服务端转发或 App 本机模式执行，不会静默回退。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, command: z.string().trim().min(1).max(256 * 1024),
      timeoutMs: z.number().int().min(1000).max(120_000).default(30_000), maxBytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(512 * 1024),
    },
  }, confirmedWriteAnnotations);
  registerTool("viron_database_write_request", {
    title: "申请执行数据库写 SQL",
    description: "为单条受控 DML 或 Schema 变更创建 Viron 风险确认 Operation；账号安全、文件和服务管理 SQL 会被拒绝。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.string().trim().max(255).default(""), sql: z.string().min(1).max(1024 * 1024) },
  }, confirmedWriteAnnotations);
  registerTool("viron_redis_write_request", {
    title: "申请执行 Redis 写命令",
    description: "为策略允许且有资源边界的 Redis 写命令创建 Viron 风险确认 Operation。管理命令和未知命令会被拒绝。",
    inputSchema: {
      workspace: workspaceSchema.optional(), connectionId: uuidSchema, database: z.number().int().min(0).max(1023).optional(),
      command: z.string().trim().min(1).max(64), args: z.array(redisArgumentSchema).max(256).default([]),
    },
  }, confirmedWriteAnnotations);
  registerTool("viron_sftp_mkdir_request", {
    title: "申请创建 SFTP 目录",
    description: "创建用户确认 Operation，确认后在指定 SSH 连接上创建目录。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096) },
  }, confirmedWriteAnnotations);
  registerTool("viron_sftp_rename_request", {
    title: "申请重命名 SFTP 路径",
    description: "创建用户确认 Operation，确认后重命名远程文件或目录。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096), newPath: z.string().min(1).max(4096) },
  }, confirmedWriteAnnotations);
  registerTool("viron_sftp_chmod_request", {
    title: "申请修改 SFTP 权限",
    description: "创建用户确认 Operation，确认后修改远程路径的八进制权限。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096), mode: z.string().regex(/^[0-7]{3,4}$/) },
  }, confirmedWriteAnnotations);
  registerTool("viron_sftp_delete_request", {
    title: "申请删除 SFTP 路径",
    description: "创建高风险确认 Operation，确认后删除远程文件或空目录；禁止删除根目录。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema, path: z.string().min(1).max(4096) },
  }, confirmedWriteAnnotations);
  registerTool("viron_sftp_transfer_request", {
    title: "申请 SFTP 主机间传输",
    description: "创建用户确认 Operation，确认后按覆盖或跳过策略启动主机间传输。建议先调用预览工具。",
    inputSchema: {
      workspace: workspaceSchema.optional(), sourceConnectionId: uuidSchema, targetConnectionId: uuidSchema,
      sourcePath: z.string().min(1).max(4096), targetDirectory: z.string().min(1).max(4096), conflict: z.enum(["overwrite", "skip"]),
    },
  }, confirmedWriteAnnotations);
  registerTool("viron_web_action_request", {
    title: "申请操作 Web 页面",
    description: "基于最近语义快照中的交互元素序号创建 Viron 确认 Operation；只支持点击、填写、选择和提交，不开放任意脚本或 CDP。",
    inputSchema: {
      workspace: workspaceSchema.optional(), credentialId: uuidSchema, action: z.enum(["click", "fill", "select", "submit"]),
      elementIndex: z.number().int().min(0).max(199), value: z.string().max(256 * 1024).optional(), expectedName: z.string().trim().max(500).optional(),
    },
  }, confirmedWriteAnnotations);
  registerTool("viron_business_risk_request", {
    title: "请求执行 Viron 长尾风险操作",
    description: "为 mode=risk 的白名单业务动作创建一次性 Viron 确认 Operation；确认后按当前服务端或 App 本机执行模式执行。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      operation: z.string().trim().min(1).max(160),
      input: z.record(z.string(), z.unknown()).default({}),
    },
  }, confirmedWriteAnnotations);

  registerTool("viron_environment_group_create", {
    title: "创建环境组",
    description: "在目标工作空间创建环境组。",
    inputSchema: { workspace: workspaceSchema.optional(), group: environmentGroupInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_environment_group_update", {
    title: "更新环境组",
    description: "更新环境组名称、说明和颜色。",
    inputSchema: { workspace: workspaceSchema.optional(), groupId: uuidSchema, group: environmentGroupInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_environment_group_delete", {
    title: "删除环境组",
    description: "删除环境组；组内环境会变为未分组，相关运行时按 Viron 规则回收。",
    inputSchema: { workspace: workspaceSchema.optional(), groupId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_environment_groups_reorder", {
    title: "调整环境组顺序",
    description: "使用包含全部环境组 ID 的列表更新排序。",
    inputSchema: { workspace: workspaceSchema.optional(), orderedIds: z.array(uuidSchema).max(1000) },
  }, secureMutationAnnotations);
  registerTool("viron_environment_create", {
    title: "创建环境",
    description: "创建一个 Viron 环境。",
    inputSchema: { workspace: workspaceSchema.optional(), environment: environmentInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_environment_update", {
    title: "更新环境",
    description: "更新环境元数据、状态、标签和所属环境组。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema, environment: environmentInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_environment_delete", {
    title: "删除环境",
    description: "删除环境及其 Web 入口、日志配置和环境关联；共享连接本身不会因此自动删除。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_environments_reorder", {
    title: "调整环境顺序与分组",
    description: "使用包含全部环境的列表调整顺序，并可同时移动到其他环境组。",
    inputSchema: { workspace: workspaceSchema.optional(), items: z.array(z.object({ id: uuidSchema, groupId: uuidSchema.nullable() })).max(1000) },
  }, secureMutationAnnotations);
  registerTool("viron_environment_alias_update", {
    title: "更新环境别称",
    description: "更新当前用户在组织工作空间看到的环境别称；空字符串用于清除。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema, alias: z.string().trim().max(120) },
  }, secureMutationAnnotations);
  registerTool("viron_connection_group_create", {
    title: "创建连接组",
    description: "创建 SSH、数据库或 Redis 连接组。",
    inputSchema: { workspace: workspaceSchema.optional(), type: z.enum(["ssh", "database", "redis"]), parentId: uuidSchema.nullable().optional(), name: z.string().trim().min(1).max(80) },
  }, secureMutationAnnotations);
  registerTool("viron_connection_group_delete", {
    title: "删除连接组",
    description: "删除连接组；组内连接保留并解除该分组。",
    inputSchema: { workspace: workspaceSchema.optional(), groupId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_connections_assign", {
    title: "分配连接到环境",
    description: "批量设置 SSH、数据库和 Redis 连接关联的环境；空 environmentIds 用于取消环境关联。",
    inputSchema: { workspace: workspaceSchema.optional(), items: z.array(connectionItemSchema).min(1).max(500), environmentIds: z.array(uuidSchema).max(100).default([]) },
  }, secureMutationAnnotations);
  registerTool("viron_connections_bulk_delete", {
    title: "批量删除连接",
    description: "批量删除 SSH、数据库和 Redis 连接配置及其运行时。保存的秘密不会返回。",
    inputSchema: { workspace: workspaceSchema.optional(), items: z.array(connectionItemSchema).min(1).max(500) },
  }, confirmedWriteAnnotations);
  registerTool("viron_knowledge_node_create", {
    title: "创建知识库节点",
    description: "在工作空间或指定环境的知识库创建文件夹或 Markdown 文档。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema.optional(), node: knowledgeNodeInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_knowledge_node_update", {
    title: "更新知识库节点",
    description: "重命名或移动知识库文件夹或文档。",
    inputSchema: { workspace: workspaceSchema.optional(), nodeId: uuidSchema, name: z.string().trim().min(1).max(240), parentId: uuidSchema.nullable().default(null) },
  }, secureMutationAnnotations);
  registerTool("viron_knowledge_node_delete", {
    title: "删除知识库节点",
    description: "删除知识库文档或整个文件夹子树。",
    inputSchema: { workspace: workspaceSchema.optional(), nodeId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_knowledge_node_environments_update", {
    title: "更新知识库环境标签",
    description: "为知识库节点新增或移除直接环境关联。",
    inputSchema: { workspace: workspaceSchema.optional(), nodeId: uuidSchema, add: z.array(uuidSchema).max(1000).default([]), remove: z.array(uuidSchema).max(1000).default([]) },
  }, secureMutationAnnotations);
  registerTool("viron_knowledge_documents_associate", {
    title: "关联知识文档到环境",
    description: "把当前有权编辑且尚未展示的文档关联到指定环境。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema, nodeIds: z.array(uuidSchema).min(1).max(1000) },
  }, secureMutationAnnotations);
  registerTool("viron_knowledge_document_content_update", {
    title: "保存知识库文档",
    description: "按 revision 乐观锁保存 Markdown 内容；冲突时必须重新读取。",
    inputSchema: { workspace: workspaceSchema.optional(), documentId: uuidSchema, content: z.string().max(2 * 1024 * 1024), revision: z.number().int().min(1) },
  }, secureMutationAnnotations);
  registerTool("viron_web_entry_create", {
    title: "创建 Web 入口",
    description: "在环境中创建 Web 入口，不包含登录密码。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema, entry: webEntryInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_web_entry_update", {
    title: "更新 Web 入口",
    description: "更新 Web 入口名称、URL、说明和标签，并回收受影响的页面 Runtime。",
    inputSchema: { workspace: workspaceSchema.optional(), entryId: uuidSchema, entry: webEntryInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_web_entry_delete", {
    title: "删除 Web 入口",
    description: "删除 Web 入口、其登录账号及页面状态。",
    inputSchema: { workspace: workspaceSchema.optional(), entryId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_web_entries_reorder", {
    title: "调整 Web 入口顺序",
    description: "使用包含环境全部 Web 入口 ID 的列表更新排序。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema, orderedIds: z.array(uuidSchema).max(200) },
  }, secureMutationAnnotations);
  registerTool("viron_web_credential_delete", {
    title: "删除 Web 登录账号",
    description: "删除 Web 登录账号及其 Cookie、页面配置和运行时；不返回密码。",
    inputSchema: { workspace: workspaceSchema.optional(), credentialId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_web_credentials_reorder", {
    title: "调整 Web 登录账号顺序",
    description: "使用包含入口全部账号 ID 的列表更新排序。",
    inputSchema: { workspace: workspaceSchema.optional(), webEntryId: uuidSchema, orderedIds: z.array(uuidSchema).max(200) },
  }, secureMutationAnnotations);
  registerTool("viron_environment_log_create", {
    title: "创建环境日志配置",
    description: "绑定环境中的 SSH 连接和一个或多个绝对日志路径。",
    inputSchema: { workspace: workspaceSchema.optional(), environmentId: uuidSchema, log: environmentLogInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_environment_log_update", {
    title: "更新环境日志配置",
    description: "更新日志名称、SSH 连接和日志文件路径。",
    inputSchema: { workspace: workspaceSchema.optional(), logId: uuidSchema, log: environmentLogInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_environment_log_delete", {
    title: "删除环境日志配置",
    description: "删除日志配置并停止受影响的日志 Runtime。",
    inputSchema: { workspace: workspaceSchema.optional(), logId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_active_connection_close", {
    title: "关闭活动连接",
    description: "关闭当前用户可管理的活动 Web、SSH、SFTP、日志、数据库或 Redis Runtime。",
    inputSchema: { workspace: workspaceSchema.optional(), activeConnectionId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerReadTool("viron_ssh_command_favorites_list", {
    title: "列出 SSH 命令收藏",
    description: "列出指定 SSH 连接的非敏感命令收藏。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema },
  });
  registerTool("viron_ssh_command_favorite_create", {
    title: "收藏 SSH 命令",
    description: "保存非敏感 SSH 命令和工作目录；Viron 会拒绝疑似包含秘密的命令。",
    inputSchema: { workspace: workspaceSchema.optional(), favorite: sshFavoriteInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_ssh_command_favorite_delete", {
    title: "删除 SSH 命令收藏",
    description: "删除当前用户的一条 SSH 命令收藏。",
    inputSchema: { workspace: workspaceSchema.optional(), favoriteId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerReadTool("viron_database_saved_queries_list", {
    title: "列出数据库保存查询",
    description: "按连接或 Schema 列出当前用户保存的 SQL 查询。",
    inputSchema: { workspace: workspaceSchema.optional(), connectionId: uuidSchema.optional(), database: z.string().trim().max(255).optional() },
  });
  registerTool("viron_database_saved_query_create", {
    title: "创建数据库保存查询",
    description: "保存一条 SQL 查询定义，不执行 SQL。",
    inputSchema: { workspace: workspaceSchema.optional(), query: savedQueryInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_database_saved_query_update", {
    title: "更新数据库保存查询",
    description: "更新保存查询的连接、Schema、名称和 SQL。",
    inputSchema: { workspace: workspaceSchema.optional(), queryId: uuidSchema, query: savedQueryInputSchema },
  }, secureMutationAnnotations);
  registerTool("viron_database_saved_query_delete", {
    title: "删除数据库保存查询",
    description: "删除当前用户的一条保存查询。",
    inputSchema: { workspace: workspaceSchema.optional(), queryId: uuidSchema },
  }, confirmedWriteAnnotations);
  registerTool("viron_business_change", {
    title: "执行 Viron 长尾配置变更",
    description: "执行 viron_business_operations_list 中 mode=change 的白名单业务配置变更；权限仍由 Viron 服务端校验。",
    inputSchema: {
      workspace: workspaceSchema.optional(),
      operation: z.string().trim().min(1).max(160),
      input: z.record(z.string(), z.unknown()).default({}),
    },
  }, confirmedWriteAnnotations);

  registerCompactVironMcpTools(server, backend, definitions);

  server.registerResource("viron-current-context", "viron://current/context", {
    title: "当前 Viron 身份上下文",
    description: "当前 MCP 用户、工作空间与可访问工作空间。",
    mimeType: "application/json",
  }, async (uri) => {
    const response = await backend.invoke("__resource_current_context", {});
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: textFor(response.data) }] };
  });

  server.registerResource("viron-knowledge-document", new ResourceTemplate("viron://knowledge/{documentId}", { list: undefined }), {
    title: "Viron 知识库文档",
    description: "按文档 UUID 读取当前工作空间中的 Markdown 文档。",
    mimeType: "text/markdown",
  }, async (uri, variables) => {
    const documentId = String(variables.documentId ?? "");
    if (!uuidSchema.safeParse(documentId).success) throw new Error("知识库文档 ID 无效");
    const response = await backend.invoke("__resource_knowledge_document", { documentId });
    if (response.status >= 400) throw new Error(textFor(response.data));
    const data = response.data as { item?: { content?: string } };
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: data.item?.content ?? "" }] };
  });
}

export interface VironMcpCompactToolDefinition {
  name: typeof VIRON_MCP_TOOL_NAMES[number];
  title: string;
  description: string;
}

export interface VironMcpCompactGateway {
  tools: VironMcpCompactToolDefinition[];
  invoke(name: typeof VIRON_MCP_TOOL_NAMES[number], arguments_?: Record<string, unknown>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: { result?: unknown };
    isError?: boolean;
  }>;
}

export function createVironMcpCompactGateway(backend: VironMcpBackend): VironMcpCompactGateway {
  type CapturedCallback = (arguments_?: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: { result?: unknown };
    isError?: boolean;
  }>;
  const callbacks = new Map<string, CapturedCallback>();
  const tools: VironMcpCompactToolDefinition[] = [];
  const collector = {
    registerTool(name: string, config: { title?: string; description?: string }, callback: CapturedCallback) {
      if (VIRON_MCP_TOOL_NAMES.includes(name as typeof VIRON_MCP_TOOL_NAMES[number])) {
        callbacks.set(name, callback);
        tools.push({
          name: name as typeof VIRON_MCP_TOOL_NAMES[number],
          title: config.title ?? name,
          description: config.description ?? "",
        });
      }
      return {};
    },
    registerResource() { return {}; },
  };
  registerVironMcpTools(collector as unknown as McpServer, backend);
  return {
    tools,
    async invoke(name, arguments_ = {}) {
      const callback = callbacks.get(name);
      if (!callback) throw new Error(`Viron MCP 紧凑工具未注册：${name}`);
      return callback(arguments_);
    },
  };
}
