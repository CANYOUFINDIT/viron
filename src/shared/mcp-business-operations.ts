import { z } from "zod";
import type { McpApiRequest } from "./mcp-protocol.js";

export type McpBusinessOperationMode = "read" | "change" | "risk";
export type McpBusinessRiskLevel = "low" | "medium" | "high";

interface McpBusinessOperationDefinition {
  id: string;
  domain: string;
  title: string;
  description: string;
  mode: McpBusinessOperationMode;
  riskLevel: McpBusinessRiskLevel;
  permission: string;
  execution: "service" | "current-mode";
  inputSchema: z.ZodType<Record<string, unknown>>;
  inputSummary: string[];
  resolve(input: Record<string, unknown>): McpApiRequest;
}

const uuid = z.string().uuid();
const optionalUuid = uuid.nullable().optional();
const jsonRecord = z.record(z.string(), z.unknown());
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const fileBase64 = z.string().min(1).max(12 * 1024 * 1024).refine((value) => {
  try {
    return Buffer.from(value, "base64").length <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}, `文件解码后不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB`);

const tableFilter = z.object({
  column: z.string().trim().min(1).max(255),
  operator: z.enum(["contains", "eq", "ne", "gt", "gte", "lt", "lte", "isNull", "isNotNull"]),
  value: z.string().max(16 * 1024).default(""),
  enabled: z.boolean().default(true),
});
const tableSort = z.object({
  column: z.string().trim().min(1).max(255),
  direction: z.enum(["asc", "desc"]),
  enabled: z.boolean().default(true),
});
const tableProfileConfig = z.object({
  filters: z.array(tableFilter).max(20).default([]),
  sorts: z.array(tableSort).max(20).default([]),
  columns: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    visible: z.boolean(),
    width: z.number().int().min(40).max(4000),
  })).max(2000).default([]),
  pageSize: z.number().int().min(20).max(500).default(100),
  viewMode: z.enum(["grid", "form"]).default("grid"),
});
const tableProfile = z.object({
  connectionId: uuid,
  database: z.string().trim().min(1).max(64),
  table: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  config: tableProfileConfig,
});
const queryArtifact = z.object({
  connectionId: uuid,
  database: z.string().trim().max(255).default(""),
  name: z.string().trim().min(1).max(160),
  sql: z.string().trim().min(1).max(2 * 1024 * 1024),
});
const automationWork = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["query", "backup", "transfer", "dataSync", "structureSync", "dataDictionary", "export", "import", "dataGeneration", "model"]),
  name: z.string().trim().min(1).max(255),
  config: jsonRecord.default({}),
});
const automation = z.object({
  connectionId: uuid,
  database: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(160),
  works: z.array(automationWork).max(500),
  advanced: jsonRecord.default({}),
  scheduleCron: z.string().trim().max(255).default(""),
  scheduleEnabled: z.boolean().default(false),
});
const model = z.object({
  connectionId: optionalUuid.default(null),
  database: z.string().trim().max(255).default(""),
  name: z.string().trim().min(1).max(160),
  modelType: z.enum(["physical", "logical", "conceptual"]),
  databaseEngine: z.string().trim().min(1).max(64).default("MySQL"),
  databaseVersion: z.string().trim().min(1).max(32).default("8.1"),
  model: jsonRecord,
});
const biWorkspace = z.object({
  connectionId: optionalUuid.default(null),
  name: z.string().trim().min(1).max(160),
  document: jsonRecord,
});
const syncOptions = z.object({
  mode: z.enum(["data", "structure"]),
  sourceDatabase: z.string().trim().min(1).max(255),
  targetConnectionId: uuid,
  targetDatabase: z.string().trim().min(1).max(255),
  data: z.object({
    insert: z.boolean().default(true),
    update: z.boolean().default(true),
    delete: z.boolean().default(true),
  }).default({ insert: true, update: true, delete: true }),
  structure: z.object({
    compareTables: z.boolean().default(true),
    comparePrimaryKeys: z.boolean().default(true),
    compareForeignKeys: z.boolean().default(true),
    compareIndexes: z.boolean().default(true),
    compareChecks: z.boolean().default(true),
    compareCharsets: z.boolean().default(true),
    compareAutoIncrement: z.boolean().default(false),
    compareTableOptions: z.boolean().default(true),
    compareViews: z.boolean().default(true),
    compareRoutines: z.boolean().default(true),
    compareTriggers: z.boolean().default(true),
    compareEvents: z.boolean().default(true),
    compareDefiners: z.boolean().default(false),
    dropExtra: z.boolean().default(false),
  }).default({
    compareTables: true,
    comparePrimaryKeys: true,
    compareForeignKeys: true,
    compareIndexes: true,
    compareChecks: true,
    compareCharsets: true,
    compareAutoIncrement: false,
    compareTableOptions: true,
    compareViews: true,
    compareRoutines: true,
    compareTriggers: true,
    compareEvents: true,
    compareDefiners: false,
    dropExtra: false,
  }),
});
const connectionCopySelection = z.object({
  environmentGroupIds: z.array(uuid).max(1000).default([]),
  environmentIds: z.array(uuid).max(1000).default([]),
  sshConnectionIds: z.array(uuid).max(1000).default([]),
  databaseConnectionIds: z.array(uuid).max(1000).default([]),
  webEntryIds: z.array(uuid).max(1000).default([]),
  webCredentialIds: z.array(uuid).max(1000).default([]),
  logIds: z.array(uuid).max(1000).default([]),
}).refine((value) => Object.values(value).some((items) => items.length), "请至少选择一项个人资源");

const currentModeOperationIds = new Set([
  "database_completion_metadata_get",
  "database_table_design_get",
  "database_table_suggestions_list",
  "database_sync_preview",
  "database_table_export",
  "database_task_output_read",
  "database_task_cancel",
  "ssh_recordings_list",
  "ssh_recording_read",
  "ssh_recording_delete",
  "sftp_download",
  "sftp_transfer_cancel",
  "web_session_reset",
  "database_table_changes",
  "database_table_import",
  "database_backup_start",
  "database_restore_upload",
  "database_sync_start",
  "database_transfer_start",
  "sftp_upload",
  "sftp_transfer_retry",
  "web_file_upload",
  "web_page_control",
]);

function definition(
  value: Omit<McpBusinessOperationDefinition, "permission" | "execution"> & { permission?: string; execution?: "service" | "current-mode" },
): McpBusinessOperationDefinition {
  return {
    permission: value.mode === "read" ? "沿用目标资源读取权限" : "沿用目标资源写入或管理权限",
    execution: currentModeOperationIds.has(value.id) ? "current-mode" : "service",
    ...value,
  };
}

function fileForm(fields: Record<string, string>, fieldName: string, filename: string, contentType: string, contentBase64: string): NonNullable<McpApiRequest["form"]> {
  return { fields, files: [{ fieldName, filename, contentType, contentBase64 }] };
}

const operations: McpBusinessOperationDefinition[] = [
  definition({ id: "audit_actors_list", domain: "audit", title: "列出审计操作者", description: "列出当前工作空间中可用于审计筛选的操作者 ID 和用户名。", mode: "read", riskLevel: "low", inputSchema: z.object({}), inputSummary: [], resolve: () => ({ path: "/api/v1/audit-actors" }) }),
  definition({ id: "database_completion_metadata_get", domain: "database", title: "读取 SQL 补全元数据", description: "读取数据库、表和字段的 SQL 补全元数据。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().max(255).default("") }), inputSummary: ["connectionId", "database?"], resolve: (input) => ({ path: `/api/v1/database-connections/${input.connectionId}/completion-metadata`, query: { database: String(input.database ?? "") } }) }),
  definition({ id: "database_table_design_get", domain: "database", title: "读取数据表设计", description: "读取字段、索引、外键、检查、触发器和表选项。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255) }), inputSummary: ["connectionId", "database", "table"], resolve: (input) => ({ path: `/api/v1/database-connections/${input.connectionId}/table-design`, query: { database: String(input.database), table: String(input.table) } }) }),
  definition({ id: "database_table_suggestions_list", domain: "database", title: "读取字段筛选建议", description: "读取数据表字段的有界 DISTINCT 筛选值。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255), column: z.string().trim().min(1).max(255), query: z.string().trim().max(500).default(""), limit: z.number().int().min(10).max(100).default(50) }), inputSummary: ["connectionId", "database", "table", "column", "query?", "limit?"], resolve: (input) => ({ path: `/api/v1/database-connections/${input.connectionId}/table-data/suggestions`, query: { database: String(input.database), table: String(input.table), column: String(input.column), q: String(input.query ?? ""), limit: Number(input.limit) } }) }),
  definition({ id: "database_sync_preview", domain: "database", title: "预览数据库同步", description: "比较源库和目标库，返回可选择的同步差异。", mode: "read", riskLevel: "medium", inputSchema: z.object({ connectionId: uuid }).extend(syncOptions.shape), inputSummary: ["connectionId", "mode", "sourceDatabase", "targetConnectionId", "targetDatabase", "data", "structure"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/sync-preview`, body: { mode: input.mode, sourceDatabase: input.sourceDatabase, targetConnectionId: input.targetConnectionId, targetDatabase: input.targetDatabase, data: input.data, structure: input.structure } }) }),
  definition({ id: "database_table_export", domain: "database", title: "导出数据表", description: "导出 CSV、XLSX 或 SQL；二进制结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255), format: z.enum(["csv", "xlsx", "sql"]).default("csv"), includeData: z.boolean().default(true) }), inputSummary: ["connectionId", "database", "table", "format?", "includeData?"], resolve: (input) => ({ path: `/api/v1/database-connections/${input.connectionId}/table-export`, query: { database: String(input.database), table: String(input.table), format: String(input.format), includeData: Boolean(input.includeData) } }) }),
  definition({ id: "database_task_output_read", domain: "database", title: "读取数据库任务输出", description: "读取备份或任务输出文件；二进制结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ taskId: uuid }), inputSummary: ["taskId"], resolve: (input) => ({ path: `/api/v1/database-tasks/${input.taskId}/download` }) }),
  definition({ id: "database_task_cancel", domain: "database", title: "取消数据库任务", description: "取消当前 MCP 执行范围内仍在运行的数据库任务。", mode: "change", riskLevel: "low", inputSchema: z.object({ taskId: uuid }), inputSummary: ["taskId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-tasks/${input.taskId}` }) }),
  definition({ id: "database_backup_rename", domain: "database", title: "重命名数据库备份", description: "重命名已完成的备份。", mode: "change", riskLevel: "low", inputSchema: z.object({ backupId: uuid, name: z.string().trim().min(1).max(160) }), inputSummary: ["backupId", "name"], resolve: (input) => ({ method: "PATCH", path: `/api/v1/database-backups/${input.backupId}`, body: { name: input.name } }) }),
  definition({ id: "database_backup_duplicate", domain: "database", title: "复制数据库备份", description: "复制已完成的备份并指定新名称。", mode: "change", riskLevel: "low", inputSchema: z.object({ backupId: uuid, name: z.string().trim().min(1).max(160) }), inputSummary: ["backupId", "name"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-backups/${input.backupId}/duplicate`, body: { name: input.name } }) }),
  definition({ id: "database_backup_delete", domain: "database", title: "删除数据库备份", description: "删除一个未运行的备份及其输出。", mode: "change", riskLevel: "high", inputSchema: z.object({ backupId: uuid }), inputSummary: ["backupId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-backups/${input.backupId}` }) }),
  definition({ id: "database_object_favorites_list", domain: "database", title: "列出数据库对象收藏", description: "列出数据库和数据表收藏。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid.optional() }), inputSummary: ["connectionId?"], resolve: (input) => ({ path: "/api/v1/database-object-favorites", query: { connectionId: input.connectionId as string | undefined } }) }),
  definition({ id: "database_object_favorite_create", domain: "database", title: "创建数据库对象收藏", description: "收藏数据库或数据表。", mode: "change", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, targetType: z.enum(["database", "table"]), database: z.string().trim().min(1).max(255), table: z.string().trim().max(255).default("") }), inputSummary: ["connectionId", "targetType", "database", "table?"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-object-favorites", body: input }) }),
  definition({ id: "database_object_favorite_delete", domain: "database", title: "删除数据库对象收藏", description: "删除一个数据库或数据表收藏。", mode: "change", riskLevel: "low", inputSchema: z.object({ favoriteId: uuid }), inputSummary: ["favoriteId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-object-favorites/${input.favoriteId}` }) }),
  definition({ id: "database_table_profiles_list", domain: "database", title: "列出数据表配置", description: "列出筛选、排序、列宽和视图配置。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255) }), inputSummary: ["connectionId", "database", "table"], resolve: (input) => ({ path: "/api/v1/database-table-profiles", query: { connectionId: String(input.connectionId), database: String(input.database), table: String(input.table) } }) }),
  definition({ id: "database_table_profile_create", domain: "database", title: "创建数据表配置", description: "保存数据表筛选、排序、列宽和视图配置。", mode: "change", riskLevel: "low", inputSchema: tableProfile, inputSummary: ["connectionId", "database", "table", "name", "config"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-table-profiles", body: input }) }),
  definition({ id: "database_table_profile_update", domain: "database", title: "更新数据表配置", description: "更新一个数据表配置。", mode: "change", riskLevel: "low", inputSchema: z.object({ profileId: uuid, profile: tableProfile }), inputSummary: ["profileId", "profile"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-table-profiles/${input.profileId}`, body: input.profile }) }),
  definition({ id: "database_table_profile_delete", domain: "database", title: "删除数据表配置", description: "删除一个数据表配置。", mode: "change", riskLevel: "low", inputSchema: z.object({ profileId: uuid }), inputSummary: ["profileId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-table-profiles/${input.profileId}` }) }),
  definition({ id: "database_object_groups_list", domain: "database", title: "列出数据库对象组", description: "列出数据库对象分组及成员。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid.optional(), database: z.string().trim().max(255).optional(), category: z.enum(["tables", "views", "functions", "events", "queries", "backups"]).optional() }), inputSummary: ["connectionId?", "database?", "category?"], resolve: (input) => ({ path: "/api/v1/database-object-groups", query: { connectionId: input.connectionId as string | undefined, database: input.database as string | undefined, category: input.category as string | undefined } }) }),
  definition({ id: "database_object_group_create", domain: "database", title: "创建数据库对象组", description: "创建一个数据库对象分组。", mode: "change", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), category: z.enum(["tables", "views", "functions", "events", "queries", "backups"]), name: z.string().trim().min(1).max(160) }), inputSummary: ["connectionId", "database", "category", "name"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-object-groups", body: input }) }),
  definition({ id: "database_object_group_update", domain: "database", title: "重命名数据库对象组", description: "更新数据库对象组名称。", mode: "change", riskLevel: "low", inputSchema: z.object({ groupId: uuid, name: z.string().trim().min(1).max(160) }), inputSummary: ["groupId", "name"], resolve: (input) => ({ method: "PATCH", path: `/api/v1/database-object-groups/${input.groupId}`, body: { name: input.name } }) }),
  definition({ id: "database_object_group_member_add", domain: "database", title: "添加数据库对象组成员", description: "把数据库对象加入分组。", mode: "change", riskLevel: "low", inputSchema: z.object({ groupId: uuid, objectName: z.string().trim().min(1).max(255), objectSource: z.string().trim().max(32).default("") }), inputSummary: ["groupId", "objectName", "objectSource?"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-object-groups/${input.groupId}/members`, body: { objectName: input.objectName, objectSource: input.objectSource } }) }),
  definition({ id: "database_object_group_member_remove", domain: "database", title: "移除数据库对象组成员", description: "从数据库对象组移除一个对象。", mode: "change", riskLevel: "low", inputSchema: z.object({ groupId: uuid, objectName: z.string().trim().min(1).max(255), objectSource: z.string().trim().max(32).default("") }), inputSummary: ["groupId", "objectName", "objectSource?"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-object-groups/${input.groupId}/members`, query: { objectName: String(input.objectName), objectSource: String(input.objectSource ?? "") } }) }),
  definition({ id: "database_object_group_delete", domain: "database", title: "删除数据库对象组", description: "删除数据库对象组，不删除数据库对象。", mode: "change", riskLevel: "low", inputSchema: z.object({ groupId: uuid }), inputSummary: ["groupId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-object-groups/${input.groupId}` }) }),
  definition({ id: "database_query_favorites_list", domain: "database", title: "列出 SQL 收藏", description: "列出当前用户的 SQL 收藏。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid.optional() }), inputSummary: ["connectionId?"], resolve: (input) => ({ path: "/api/v1/database-query-favorites", query: { connectionId: input.connectionId as string | undefined } }) }),
  definition({ id: "database_query_favorite_create", domain: "database", title: "创建 SQL 收藏", description: "创建一个 SQL 收藏。", mode: "change", riskLevel: "low", inputSchema: queryArtifact, inputSummary: ["connectionId", "database", "name", "sql"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-query-favorites", body: input }) }),
  definition({ id: "database_query_favorite_update", domain: "database", title: "更新 SQL 收藏", description: "更新一个 SQL 收藏。", mode: "change", riskLevel: "low", inputSchema: z.object({ favoriteId: uuid, favorite: queryArtifact }), inputSummary: ["favoriteId", "favorite"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-query-favorites/${input.favoriteId}`, body: input.favorite }) }),
  definition({ id: "database_query_favorite_delete", domain: "database", title: "删除 SQL 收藏", description: "删除一个 SQL 收藏。", mode: "change", riskLevel: "low", inputSchema: z.object({ favoriteId: uuid }), inputSummary: ["favoriteId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-query-favorites/${input.favoriteId}` }) }),
  definition({ id: "database_automations_list", domain: "database", title: "列出数据库批处理", description: "列出数据库批处理、调度和最近状态。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid.optional() }), inputSummary: ["connectionId?"], resolve: (input) => ({ path: "/api/v1/database-automations", query: { connectionId: input.connectionId as string | undefined } }) }),
  definition({ id: "database_automation_output_read", domain: "database", title: "读取数据库批处理输出", description: "读取批处理工作输出；二进制结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ automationId: uuid, workId: z.string().min(1).max(128) }), inputSummary: ["automationId", "workId"], resolve: (input) => ({ path: `/api/v1/database-automations/${input.automationId}/outputs/${encodeURIComponent(String(input.workId))}` }) }),
  definition({ id: "database_automation_create", domain: "database", title: "创建数据库批处理", description: "创建数据库批处理和可选 Cron 调度。", mode: "change", riskLevel: "medium", inputSchema: automation, inputSummary: ["connectionId", "database", "name", "works", "advanced", "scheduleCron", "scheduleEnabled"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-automations", body: input }) }),
  definition({ id: "database_automation_update", domain: "database", title: "更新数据库批处理", description: "更新数据库批处理和调度。", mode: "change", riskLevel: "medium", inputSchema: z.object({ automationId: uuid, automation }), inputSummary: ["automationId", "automation"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-automations/${input.automationId}`, body: input.automation }) }),
  definition({ id: "database_automation_schedule_clear", domain: "database", title: "清除数据库批处理调度", description: "停用并清除一个批处理的 Cron 调度。", mode: "change", riskLevel: "low", inputSchema: z.object({ automationId: uuid }), inputSummary: ["automationId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-automations/${input.automationId}/schedule` }) }),
  definition({ id: "database_automation_delete", domain: "database", title: "删除数据库批处理", description: "删除一个数据库批处理。", mode: "change", riskLevel: "medium", inputSchema: z.object({ automationId: uuid }), inputSummary: ["automationId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-automations/${input.automationId}` }) }),
  definition({ id: "database_models_list", domain: "database", title: "列出数据库模型", description: "列出物理、逻辑和概念数据库模型。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid.optional() }), inputSummary: ["connectionId?"], resolve: (input) => ({ path: "/api/v1/database-models", query: { connectionId: input.connectionId as string | undefined } }) }),
  definition({ id: "database_model_create", domain: "database", title: "创建数据库模型", description: "创建数据库模型文档。", mode: "change", riskLevel: "low", inputSchema: model, inputSummary: ["connectionId?", "database", "name", "modelType", "databaseEngine", "databaseVersion", "model"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-models", body: input }) }),
  definition({ id: "database_model_update", domain: "database", title: "更新数据库模型", description: "更新数据库模型文档。", mode: "change", riskLevel: "low", inputSchema: z.object({ modelId: uuid, model }), inputSummary: ["modelId", "model"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-models/${input.modelId}`, body: input.model }) }),
  definition({ id: "database_model_access", domain: "database", title: "标记数据库模型访问", description: "更新数据库模型最近访问时间。", mode: "change", riskLevel: "low", inputSchema: z.object({ modelId: uuid }), inputSummary: ["modelId"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-models/${input.modelId}/access` }) }),
  definition({ id: "database_model_delete", domain: "database", title: "删除数据库模型", description: "删除一个数据库模型文档。", mode: "change", riskLevel: "medium", inputSchema: z.object({ modelId: uuid }), inputSummary: ["modelId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-models/${input.modelId}` }) }),
  definition({ id: "database_code_snippets_list", domain: "database", title: "列出 SQL 代码段", description: "列出当前工作空间的 SQL 代码段。", mode: "read", riskLevel: "low", inputSchema: z.object({}), inputSummary: [], resolve: () => ({ path: "/api/v1/database-code-snippets" }) }),
  definition({ id: "database_code_snippet_create", domain: "database", title: "创建 SQL 代码段", description: "创建一个 SQL 代码段。", mode: "change", riskLevel: "low", inputSchema: z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(500).default(""), sql: z.string().min(1).max(2 * 1024 * 1024) }), inputSummary: ["name", "description?", "sql"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-code-snippets", body: input }) }),
  definition({ id: "database_code_snippet_update", domain: "database", title: "更新 SQL 代码段", description: "更新一个 SQL 代码段。", mode: "change", riskLevel: "low", inputSchema: z.object({ snippetId: uuid, name: z.string().trim().min(1).max(160), description: z.string().trim().max(500).default(""), sql: z.string().min(1).max(2 * 1024 * 1024) }), inputSummary: ["snippetId", "name", "description?", "sql"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-code-snippets/${input.snippetId}`, body: { name: input.name, description: input.description, sql: input.sql } }) }),
  definition({ id: "database_code_snippet_delete", domain: "database", title: "删除 SQL 代码段", description: "删除一个 SQL 代码段。", mode: "change", riskLevel: "low", inputSchema: z.object({ snippetId: uuid }), inputSummary: ["snippetId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-code-snippets/${input.snippetId}` }) }),
  definition({ id: "database_bi_workspaces_list", domain: "database", title: "列出 BI 工作区", description: "列出数据库 BI 工作区文档。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid.optional() }), inputSummary: ["connectionId?"], resolve: (input) => ({ path: "/api/v1/database-bi-workspaces", query: { connectionId: input.connectionId as string | undefined } }) }),
  definition({ id: "database_bi_workspace_create", domain: "database", title: "创建 BI 工作区", description: "创建数据库 BI 工作区文档。", mode: "change", riskLevel: "low", inputSchema: biWorkspace, inputSummary: ["connectionId?", "name", "document"], resolve: (input) => ({ method: "POST", path: "/api/v1/database-bi-workspaces", body: input }) }),
  definition({ id: "database_bi_workspace_update", domain: "database", title: "更新 BI 工作区", description: "更新数据库 BI 工作区文档。", mode: "change", riskLevel: "low", inputSchema: z.object({ workspaceId: uuid, workspace: biWorkspace }), inputSummary: ["workspaceId", "workspace"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-bi-workspaces/${input.workspaceId}`, body: input.workspace }) }),
  definition({ id: "database_bi_workspace_access", domain: "database", title: "标记 BI 工作区访问", description: "更新 BI 工作区最近访问时间。", mode: "change", riskLevel: "low", inputSchema: z.object({ workspaceId: uuid }), inputSummary: ["workspaceId"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-bi-workspaces/${input.workspaceId}/access` }) }),
  definition({ id: "database_bi_workspace_delete", domain: "database", title: "删除 BI 工作区", description: "删除一个 BI 工作区文档。", mode: "change", riskLevel: "medium", inputSchema: z.object({ workspaceId: uuid }), inputSummary: ["workspaceId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-bi-workspaces/${input.workspaceId}` }) }),
  definition({ id: "database_connection_profile_duplicate", domain: "connections", title: "复制数据库连接配置档", description: "复制数据库连接配置档。", mode: "change", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, profileId: uuid, profileName: z.string().trim().min(1).max(160) }), inputSummary: ["connectionId", "profileId", "profileName"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/profiles/${input.profileId}/duplicate`, body: { profileName: input.profileName } }) }),
  definition({ id: "database_connection_profile_activate", domain: "connections", title: "启用数据库连接配置档", description: "设置数据库连接当前活动配置档。", mode: "change", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, profileId: uuid.nullable() }), inputSummary: ["connectionId", "profileId"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-connections/${input.connectionId}/profiles/active`, body: { profileId: input.profileId } }) }),
  definition({ id: "database_connection_profile_delete", domain: "connections", title: "删除数据库连接配置档", description: "删除数据库连接配置档。", mode: "change", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, profileId: uuid }), inputSummary: ["connectionId", "profileId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/database-connections/${input.connectionId}/profiles/${input.profileId}` }) }),
  definition({ id: "database_connection_preferences_update", domain: "connections", title: "更新数据库连接偏好", description: "更新数据库连接星标和颜色。", mode: "change", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, starred: z.boolean().optional(), color: z.union([z.literal(""), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).optional() }).refine((value) => value.starred !== undefined || value.color !== undefined, "请至少修改一个连接偏好"), inputSummary: ["connectionId", "starred?", "color?"], resolve: (input) => ({ method: "PUT", path: `/api/v1/database-connections/${input.connectionId}/preferences`, body: { starred: input.starred, color: input.color } }) }),
  definition({ id: "ssh_keys_list", domain: "ssh", title: "列出 SSH 密钥", description: "列出 SSH 密钥的名称、算法、公钥、指纹和引用数，不返回私钥。", mode: "read", riskLevel: "low", inputSchema: z.object({}), inputSummary: [], permission: "工作空间管理员", resolve: () => ({ path: "/api/v1/ssh-keys" }) }),
  definition({ id: "ssh_key_public_read", domain: "ssh", title: "读取 SSH 公钥", description: "读取一个 SSH 密钥的公钥，不允许读取私钥。", mode: "read", riskLevel: "low", inputSchema: z.object({ keyId: uuid }), inputSummary: ["keyId"], permission: "工作空间管理员", resolve: (input) => ({ path: `/api/v1/ssh-keys/${input.keyId}/export`, query: { part: "public" } }) }),
  definition({ id: "ssh_key_rename", domain: "ssh", title: "重命名 SSH 密钥", description: "更新 SSH 密钥名称。", mode: "change", riskLevel: "low", inputSchema: z.object({ keyId: uuid, name: z.string().trim().min(1).max(160) }), inputSummary: ["keyId", "name"], permission: "工作空间管理员", resolve: (input) => ({ method: "PUT", path: `/api/v1/ssh-keys/${input.keyId}`, body: { name: input.name } }) }),
  definition({ id: "ssh_key_delete", domain: "ssh", title: "删除 SSH 密钥", description: "删除未被连接引用的 SSH 密钥。", mode: "change", riskLevel: "high", inputSchema: z.object({ keyId: uuid }), inputSummary: ["keyId"], permission: "工作空间管理员", resolve: (input) => ({ method: "DELETE", path: `/api/v1/ssh-keys/${input.keyId}` }) }),
  definition({ id: "ssh_recordings_list", domain: "ssh", title: "列出 SSH 终端录像", description: "分页列出有权查看的终端录像元数据。", mode: "read", riskLevel: "low", inputSchema: z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50), keyword: z.string().trim().max(200).optional(), actorUserId: uuid.optional() }), inputSummary: ["page?", "pageSize?", "keyword?", "actorUserId?"], resolve: (input) => ({ path: "/api/v1/ssh-recordings", query: { page: Number(input.page), pageSize: Number(input.pageSize), keyword: input.keyword as string | undefined, actorUserId: input.actorUserId as string | undefined } }) }),
  definition({ id: "ssh_recording_read", domain: "ssh", title: "读取 SSH 终端录像", description: "读取 asciinema 录像；结果由 MCP 以文本或 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ recordingId: uuid }), inputSummary: ["recordingId"], resolve: (input) => ({ path: `/api/v1/ssh-recordings/${input.recordingId}/download` }) }),
  definition({ id: "ssh_recording_delete", domain: "ssh", title: "删除 SSH 终端录像", description: "删除当前用户的非活动终端录像。", mode: "change", riskLevel: "medium", inputSchema: z.object({ recordingId: uuid }), inputSummary: ["recordingId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/ssh-recordings/${input.recordingId}` }) }),
  definition({ id: "connection_copy_catalog", domain: "connections", title: "读取个人资源复制目录", description: "读取可复制到当前组织的个人环境和连接资源目录。", mode: "read", riskLevel: "low", inputSchema: z.object({}), inputSummary: [], permission: "当前组织管理员", resolve: () => ({ path: "/api/v1/connection-copy/catalog" }) }),
  definition({ id: "connection_copy_preview", domain: "connections", title: "预览个人资源复制", description: "预览依赖、冲突和秘密数量，不复制资源。", mode: "read", riskLevel: "medium", inputSchema: z.object({ selection: connectionCopySelection }), inputSummary: ["selection"], permission: "当前组织管理员", resolve: (input) => ({ method: "POST", path: "/api/v1/connection-copy/preview", body: input }) }),
  definition({ id: "connection_sources_list", domain: "connections", title: "列出连接来源", description: "列出 SecureCRT、脚本和导入来源的脱敏配置。", mode: "read", riskLevel: "low", inputSchema: z.object({}), inputSummary: [], permission: "工作空间管理员", resolve: () => ({ path: "/api/v1/connection-sources" }) }),
  definition({ id: "connection_source_runs_list", domain: "connections", title: "列出连接来源同步记录", description: "列出连接来源最近同步记录。", mode: "read", riskLevel: "low", inputSchema: z.object({ sourceId: uuid }), inputSummary: ["sourceId"], permission: "工作空间管理员", resolve: (input) => ({ path: `/api/v1/connection-sources/${input.sourceId}/runs` }) }),
  definition({ id: "connection_source_run_get", domain: "connections", title: "读取连接来源同步报告", description: "读取一次来源同步的完整脱敏报告。", mode: "read", riskLevel: "low", inputSchema: z.object({ runId: uuid }), inputSummary: ["runId"], permission: "工作空间管理员", resolve: (input) => ({ path: `/api/v1/connection-source-runs/${input.runId}` }) }),
  definition({ id: "connection_source_mappings_list", domain: "connections", title: "列出来源目录映射", description: "列出来源路径到环境的映射。", mode: "read", riskLevel: "low", inputSchema: z.object({ sourceId: uuid }), inputSummary: ["sourceId"], permission: "工作空间管理员", resolve: (input) => ({ path: `/api/v1/connection-sources/${input.sourceId}/mappings` }) }),
  definition({ id: "connection_source_script_create", domain: "connections", title: "创建脚本连接来源", description: "创建隔离执行的脚本来源和可选调度。", mode: "change", riskLevel: "medium", inputSchema: z.object({ name: z.string().trim().min(1).max(160), script: z.string().trim().min(1).max(256 * 1024), conflictStrategy: z.enum(["overwrite", "ignore"]).default("ignore"), scheduleEnabled: z.boolean().default(false), scheduleExpression: z.string().trim().max(120).default("") }), inputSummary: ["name", "script", "conflictStrategy?", "scheduleEnabled?", "scheduleExpression?"], permission: "工作空间管理员", resolve: (input) => ({ method: "POST", path: "/api/v1/connection-sources/script", body: input }) }),
  definition({ id: "connection_source_script_update", domain: "connections", title: "更新脚本连接来源", description: "更新隔离执行的脚本来源和调度。", mode: "change", riskLevel: "medium", inputSchema: z.object({ sourceId: uuid, name: z.string().trim().min(1).max(160), script: z.string().trim().min(1).max(256 * 1024), conflictStrategy: z.enum(["overwrite", "ignore"]).default("ignore"), scheduleEnabled: z.boolean().default(false), scheduleExpression: z.string().trim().max(120).default("") }), inputSummary: ["sourceId", "name", "script", "conflictStrategy?", "scheduleEnabled?", "scheduleExpression?"], permission: "工作空间管理员", resolve: (input) => ({ method: "PUT", path: `/api/v1/connection-sources/${input.sourceId}/script`, body: { name: input.name, script: input.script, conflictStrategy: input.conflictStrategy, scheduleEnabled: input.scheduleEnabled, scheduleExpression: input.scheduleExpression } }) }),
  definition({ id: "connection_source_schedule_update", domain: "connections", title: "更新连接来源定时同步", description: "启用、关闭或修改脚本与 SecureCRT 同步源的定时自动执行。", mode: "change", riskLevel: "medium", inputSchema: z.object({ sourceId: uuid, scheduleEnabled: z.boolean(), scheduleExpression: z.string().trim().max(120).default("") }), inputSummary: ["sourceId", "scheduleEnabled", "scheduleExpression?"], permission: "工作空间管理员", resolve: (input) => ({ method: "PUT", path: `/api/v1/connection-sources/${input.sourceId}/schedule`, body: { scheduleEnabled: input.scheduleEnabled, scheduleExpression: input.scheduleExpression } }) }),
  definition({ id: "connection_source_delete", domain: "connections", title: "删除连接来源", description: "删除连接来源配置；现有连接保留。", mode: "change", riskLevel: "medium", inputSchema: z.object({ sourceId: uuid }), inputSummary: ["sourceId"], permission: "工作空间管理员", resolve: (input) => ({ method: "DELETE", path: `/api/v1/connection-sources/${input.sourceId}` }) }),
  definition({ id: "connection_source_mapping_create", domain: "connections", title: "创建来源目录映射", description: "创建来源路径到环境的映射并关联未分配连接。", mode: "change", riskLevel: "low", inputSchema: z.object({ sourceId: uuid, sourcePathPrefix: z.string().trim().min(1).max(4096), environmentId: uuid }), inputSummary: ["sourceId", "sourcePathPrefix", "environmentId"], permission: "工作空间管理员", resolve: (input) => ({ method: "POST", path: `/api/v1/connection-sources/${input.sourceId}/mappings`, body: { sourcePathPrefix: input.sourcePathPrefix, environmentId: input.environmentId } }) }),
  definition({ id: "connection_source_mapping_delete", domain: "connections", title: "删除来源目录映射", description: "删除来源目录映射。", mode: "change", riskLevel: "low", inputSchema: z.object({ sourceId: uuid, mappingId: uuid }), inputSummary: ["sourceId", "mappingId"], permission: "工作空间管理员", resolve: (input) => ({ method: "DELETE", path: `/api/v1/connection-sources/${input.sourceId}/mappings/${input.mappingId}` }) }),
  definition({ id: "connection_import_get", domain: "connections", title: "读取连接导入批次", description: "读取导入批次、冲突和处理状态，不返回导入秘密。", mode: "read", riskLevel: "low", inputSchema: z.object({ batchId: uuid }), inputSummary: ["batchId"], permission: "工作空间管理员", resolve: (input) => ({ path: `/api/v1/connection-imports/${input.batchId}` }) }),
  definition({ id: "connection_import_cancel", domain: "connections", title: "取消连接导入批次", description: "取消尚未确认的连接导入批次。", mode: "change", riskLevel: "low", inputSchema: z.object({ batchId: uuid }), inputSummary: ["batchId"], permission: "工作空间管理员", resolve: (input) => ({ method: "DELETE", path: `/api/v1/connection-imports/${input.batchId}` }) }),
  definition({ id: "knowledge_association_candidates", domain: "knowledge", title: "列出知识库关联候选", description: "列出可关联到环境的知识库文档。", mode: "read", riskLevel: "low", inputSchema: z.object({ environmentId: uuid }), inputSummary: ["environmentId"], resolve: (input) => ({ path: `/api/v1/environments/${input.environmentId}/knowledge/association-candidates` }) }),
  definition({ id: "knowledge_node_export", domain: "knowledge", title: "导出知识库节点", description: "导出 Markdown 文档或 ZIP 目录；二进制结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ nodeId: uuid }), inputSummary: ["nodeId"], resolve: (input) => ({ path: `/api/v1/knowledge-nodes/${input.nodeId}/export` }) }),
  definition({ id: "knowledge_workspace_export", domain: "knowledge", title: "导出工作空间知识库", description: "导出整个工作空间知识库 ZIP；结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({}), inputSummary: [], resolve: () => ({ path: "/api/v1/knowledge/export" }) }),
  definition({ id: "knowledge_environment_export", domain: "knowledge", title: "导出环境知识库", description: "导出环境可见知识库 ZIP；结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ environmentId: uuid }), inputSummary: ["environmentId"], resolve: (input) => ({ path: `/api/v1/environments/${input.environmentId}/knowledge/export` }) }),
  definition({ id: "knowledge_asset_upload", domain: "knowledge", title: "上传知识库图片", description: "向文档上传图片并返回资源引用，单文件最多 8 MiB。", mode: "change", riskLevel: "low", inputSchema: z.object({ documentId: uuid, filename: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(160), contentBase64: fileBase64 }), inputSummary: ["documentId", "filename", "contentType", "contentBase64"], resolve: (input) => ({ method: "POST", path: `/api/v1/knowledge-documents/${input.documentId}/assets`, form: fileForm({}, "file", String(input.filename), String(input.contentType), String(input.contentBase64)) }) }),
  definition({ id: "knowledge_asset_delete", domain: "knowledge", title: "删除知识库图片", description: "删除一个知识库图片资源。", mode: "change", riskLevel: "medium", inputSchema: z.object({ assetId: uuid }), inputSummary: ["assetId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/knowledge-assets/${input.assetId}` }) }),
  definition({ id: "knowledge_import", domain: "knowledge", title: "导入知识库文件", description: "导入 Markdown 或 ZIP 到工作空间或环境，单文件最多 8 MiB。", mode: "change", riskLevel: "medium", inputSchema: z.object({ environmentId: uuid.optional(), parentId: optionalUuid, filename: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(160).default("application/octet-stream"), contentBase64: fileBase64 }), inputSummary: ["environmentId?", "parentId?", "filename", "contentType?", "contentBase64"], resolve: (input) => ({ method: "POST", path: input.environmentId ? `/api/v1/environments/${input.environmentId}/knowledge/import` : "/api/v1/knowledge/import", form: fileForm({ parentId: String(input.parentId ?? "") }, "file", String(input.filename), String(input.contentType), String(input.contentBase64)) }) }),
  definition({ id: "sftp_download", domain: "sftp", title: "下载 SFTP 文件", description: "读取一个远程文件；二进制结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ connectionId: uuid, path: z.string().min(1).max(4096) }), inputSummary: ["connectionId", "path"], resolve: (input) => ({ path: `/api/v1/ssh-connections/${input.connectionId}/sftp/download`, query: { path: String(input.path) } }) }),
  definition({ id: "sftp_transfer_cancel", domain: "sftp", title: "取消 SFTP 传输", description: "取消当前 MCP 执行范围内仍在运行的主机间传输。", mode: "change", riskLevel: "low", inputSchema: z.object({ transferId: uuid }), inputSummary: ["transferId"], resolve: (input) => ({ method: "DELETE", path: `/api/v1/sftp-transfers/${input.transferId}` }) }),
  definition({ id: "web_download", domain: "web", title: "读取 Web 下载文件", description: "读取 Web 页面产生的下载文件；二进制结果由 MCP 以 Base64 返回。", mode: "read", riskLevel: "low", inputSchema: z.object({ downloadId: uuid }), inputSummary: ["downloadId"], resolve: (input) => ({ path: `/api/v1/web-view-downloads/${input.downloadId}` }) }),
  definition({ id: "web_session_reset", domain: "web", title: "重置 Web 登录状态", description: "清除指定 Web 账号的持久登录状态并关闭当前页面实例。", mode: "change", riskLevel: "high", inputSchema: z.object({ credentialId: uuid }), inputSummary: ["credentialId"], resolve: (input) => ({ method: "POST", path: `/api/v1/web-credentials/${input.credentialId}/view/reset` }) }),

  definition({ id: "database_table_changes", domain: "database", title: "提交数据表结构化变更", description: "按主键保护提交最多 500 个插入、更新或删除。", mode: "risk", riskLevel: "high", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255), changes: z.array(z.object({ type: z.enum(["insert", "update", "delete"]), values: jsonRecord.default({}), key: jsonRecord.default({}) })).min(1).max(500) }), inputSummary: ["connectionId", "database", "table", "changes"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/table-data/changes`, body: { database: input.database, table: input.table, changes: input.changes } }) }),
  definition({ id: "database_table_import", domain: "database", title: "导入数据表文件", description: "导入 CSV 或 XLSX 到数据表，单文件最多 8 MiB。", mode: "risk", riskLevel: "high", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), table: z.string().trim().min(1).max(255), mode: z.enum(["append", "replace"]).default("append"), filename: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(160).default("application/octet-stream"), contentBase64: fileBase64 }), inputSummary: ["connectionId", "database", "table", "mode", "filename", "contentBase64"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/table-import`, form: fileForm({ database: String(input.database), table: String(input.table), mode: String(input.mode) }, "file", String(input.filename), String(input.contentType), String(input.contentBase64)) }) }),
  definition({ id: "database_backup_start", domain: "database", title: "启动数据库备份", description: "启动数据库结构或完整 SQL 备份任务。", mode: "risk", riskLevel: "medium", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), includeData: z.boolean().default(true) }), inputSummary: ["connectionId", "database", "includeData?"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/backup`, body: { database: input.database, includeData: input.includeData } }) }),
  definition({ id: "database_restore_upload", domain: "database", title: "上传 SQL 并恢复数据库", description: "上传 SQL 文件并启动恢复任务，单文件最多 8 MiB。", mode: "risk", riskLevel: "high", inputSchema: z.object({ connectionId: uuid, database: z.string().trim().min(1).max(255), filename: z.string().trim().min(1).max(255).refine((value) => value.toLowerCase().endsWith(".sql"), "文件名必须以 .sql 结尾"), contentBase64: fileBase64 }), inputSummary: ["connectionId", "database", "filename", "contentBase64"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/restore`, form: fileForm({ database: String(input.database) }, "file", String(input.filename), "application/sql", String(input.contentBase64)) }) }),
  definition({ id: "database_backup_restore", domain: "database", title: "从已有备份恢复数据库", description: "从 Viron 已完成备份启动恢复任务。", mode: "risk", riskLevel: "high", inputSchema: z.object({ backupId: uuid, database: z.string().trim().max(255).optional() }), inputSummary: ["backupId", "database?"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-backups/${input.backupId}/restore`, body: { database: input.database } }) }),
  definition({ id: "database_sync_start", domain: "database", title: "启动数据库同步", description: "按预览选择启动数据或结构同步。", mode: "risk", riskLevel: "high", inputSchema: z.object({ connectionId: uuid, selectedItems: z.array(z.string().trim().min(1).max(1000)).min(1).max(10_000) }).extend(syncOptions.shape), inputSummary: ["connectionId", "mode", "sourceDatabase", "targetConnectionId", "targetDatabase", "selectedItems", "data", "structure"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/sync`, body: { mode: input.mode, sourceDatabase: input.sourceDatabase, targetConnectionId: input.targetConnectionId, targetDatabase: input.targetDatabase, selectedItems: input.selectedItems, data: input.data, structure: input.structure } }) }),
  definition({ id: "database_transfer_start", domain: "database", title: "启动数据库传输", description: "在两个数据库连接之间传输结构、数据和对象。", mode: "risk", riskLevel: "high", inputSchema: z.object({ connectionId: uuid, sourceDatabase: z.string().trim().min(1).max(255), targetConnectionId: uuid, targetDatabase: z.string().trim().min(1).max(255), includeStructure: z.boolean().default(true), includeData: z.boolean().default(true), includeObjects: z.boolean().default(true), dropExisting: z.boolean().default(false), tables: z.array(z.string().trim().min(1).max(255)).max(5000).optional() }), inputSummary: ["connectionId", "sourceDatabase", "targetConnectionId", "targetDatabase", "includeStructure", "includeData", "includeObjects", "dropExisting", "tables?"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-connections/${input.connectionId}/transfer`, body: { sourceDatabase: input.sourceDatabase, targetConnectionId: input.targetConnectionId, targetDatabase: input.targetDatabase, includeStructure: input.includeStructure, includeData: input.includeData, includeObjects: input.includeObjects, dropExisting: input.dropExisting, tables: input.tables } }) }),
  definition({ id: "database_automation_run", domain: "database", title: "运行数据库批处理", description: "立即执行一个数据库批处理。", mode: "risk", riskLevel: "high", inputSchema: z.object({ automationId: uuid }), inputSummary: ["automationId"], resolve: (input) => ({ method: "POST", path: `/api/v1/database-automations/${input.automationId}/run` }) }),
  definition({ id: "sftp_upload", domain: "sftp", title: "上传 SFTP 文件", description: "向远程目录上传文件，单文件最多 8 MiB。", mode: "risk", riskLevel: "high", inputSchema: z.object({ connectionId: uuid, directory: z.string().min(1).max(4096), filename: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(160).default("application/octet-stream"), contentBase64: fileBase64 }), inputSummary: ["connectionId", "directory", "filename", "contentBase64"], resolve: (input) => ({ method: "POST", path: `/api/v1/ssh-connections/${input.connectionId}/sftp/upload`, query: { path: String(input.directory) }, form: fileForm({}, "file", String(input.filename), String(input.contentType), String(input.contentBase64)) }) }),
  definition({ id: "sftp_transfer_retry", domain: "sftp", title: "重试 SFTP 传输", description: "重试失败或已取消的主机间传输。", mode: "risk", riskLevel: "high", inputSchema: z.object({ transferId: uuid }), inputSummary: ["transferId"], resolve: (input) => ({ method: "POST", path: `/api/v1/sftp-transfers/${input.transferId}/retry` }) }),
  definition({ id: "connection_source_sync", domain: "connections", title: "立即同步连接来源", description: "立即运行连接来源并应用新增、覆盖或冲突预览。", mode: "risk", riskLevel: "high", inputSchema: z.object({ sourceId: uuid }), inputSummary: ["sourceId"], permission: "工作空间管理员", resolve: (input) => ({ method: "POST", path: `/api/v1/connection-sources/${input.sourceId}/sync` }) }),
  definition({ id: "connection_import_confirm", domain: "connections", title: "确认连接导入", description: "按已选择的冲突决策导入、复用、覆盖或跳过连接。", mode: "risk", riskLevel: "high", inputSchema: z.object({ batchId: uuid, decisions: z.array(z.object({ itemId: uuid, action: z.enum(["import", "keep", "overwrite", "reuse", "skip"]), targetId: uuid.optional() })).max(5000) }), inputSummary: ["batchId", "decisions"], permission: "工作空间管理员", resolve: (input) => ({ method: "POST", path: `/api/v1/connection-imports/${input.batchId}/confirm`, body: { decisions: input.decisions } }) }),
  definition({ id: "connection_copy_execute", domain: "connections", title: "复制个人资源到组织", description: "把个人资源复制到当前组织；MCP 不允许同时分配成员或项目授权。", mode: "risk", riskLevel: "high", inputSchema: z.object({ selection: connectionCopySelection, reuse: z.record(z.string(), uuid).default({}) }), inputSummary: ["selection", "reuse"], permission: "当前组织管理员", resolve: (input) => ({ method: "POST", path: "/api/v1/connection-copy", body: { selection: input.selection, reuse: input.reuse, grantees: [] } }) }),
  definition({ id: "web_file_upload", domain: "web", title: "向 Web 页面上传文件", description: "把文件交给页面当前等待中的文件选择器，单文件最多 8 MiB。", mode: "risk", riskLevel: "high", inputSchema: z.object({ credentialId: uuid, filename: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(160).default("application/octet-stream"), contentBase64: fileBase64 }), inputSummary: ["credentialId", "filename", "contentBase64"], resolve: (input) => ({ method: "POST", path: `/api/v1/web-credentials/${input.credentialId}/view/upload`, form: fileForm({}, "file", String(input.filename), String(input.contentType), String(input.contentBase64)) }) }),
  definition({ id: "web_page_control", domain: "web", title: "控制 Web 页面导航", description: "导航到 HTTP(S) URL，或对当前页面后退、前进和刷新。", mode: "risk", riskLevel: "high", inputSchema: z.object({ credentialId: uuid, action: z.enum(["navigate", "back", "forward", "reload"]), url: z.string().url().max(2048).optional() }).refine((value) => value.action !== "navigate" || Boolean(value.url), { message: "导航操作必须提供 URL", path: ["url"] }), inputSummary: ["credentialId", "action", "url?"], resolve: (input) => ({ method: "POST", path: `/api/v1/mcp/web-credentials/${input.credentialId}/control`, body: { action: input.action, url: input.url } }) }),
];

const operationById = new Map(operations.map((operation) => [operation.id, operation]));

export function listMcpBusinessOperations(mode?: McpBusinessOperationMode) {
  return operations
    .filter((operation) => !mode || operation.mode === mode)
    .map(({ inputSchema, resolve: _resolve, ...operation }) => ({
      ...operation,
      inputSchema: z.toJSONSchema(inputSchema),
    }));
}

export function resolveMcpBusinessOperation(
  mode: McpBusinessOperationMode,
  operationId: unknown,
  rawInput: unknown,
  workspace?: string,
): { operation: ReturnType<typeof listMcpBusinessOperations>[number]; request: McpApiRequest } {
  if (typeof operationId !== "string") throw new Error("业务操作 ID 无效");
  const definition = operationById.get(operationId);
  if (!definition || definition.mode !== mode) throw new Error(`MCP ${mode} 操作不存在或不属于该模式：${operationId}`);
  const input = definition.inputSchema.parse(rawInput ?? {});
  const request = definition.resolve(input);
  request.workspace = workspace;
  const { inputSchema, resolve: _resolve, ...operation } = definition;
  return { operation: { ...operation, inputSchema: z.toJSONSchema(inputSchema) }, request };
}

export const MCP_BUSINESS_OPERATION_MODES = ["read", "change", "risk"] as const;
