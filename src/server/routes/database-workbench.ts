import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { FieldPacket, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { filterAsync } from "../async-utils.js";
import { canAccessConnection, canManageWorkspace } from "../access-control.js";
import { executionScope } from "../execution-scope.js";
import { connectDatabase, type DatabaseConnectionClient } from "../database-workbench/connector.js";
import { parseCreateTableConstraints } from "../../shared/database-table-design.js";
import { buildTableDataClauses, parseTableDataQueryRules } from "../../shared/database-table-data.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { auditLikePattern, auditRetentionCutoff, parseAuditListQuery, type AuditListQuery } from "../audit-query.js";
import { assertMcpReadOnlySql } from "../../shared/mcp-policy.js";

const querySchema = z.object({
  sql: z.string().trim().min(1).max(2 * 1024 * 1024),
  database: z.string().trim().max(255).default(""),
  continueOnError: z.boolean().default(false),
});
const readBatchSchema = z.object({
  queries: z.array(z.object({
    sql: z.string().trim().min(1).max(1024 * 1024),
    database: z.string().trim().max(255).default(""),
  })).min(1).max(20),
});
const databaseBatchMaxResponseBytes = 2 * 1024 * 1024;

function safeBatchRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== "object") return { value: row };
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    typeof value === "bigint" ? value.toString()
      : Buffer.isBuffer(value) ? `0x${value.toString("hex")}`
        : value instanceof Date ? value.toISOString() : value]));
}

const favoriteSchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().trim().max(255).default(""),
  name: z.string().trim().min(1).max(160),
  sql: z.string().trim().min(1).max(2 * 1024 * 1024),
});

const savedQuerySchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(160),
  sql: z.string().max(2 * 1024 * 1024),
});

const tableProfileFilterSchema = z.object({
  column: z.string().trim().min(1).max(255),
  operator: z.enum(["contains", "eq", "ne", "gt", "gte", "lt", "lte", "isNull", "isNotNull"]),
  value: z.string().max(16 * 1024).default(""),
  enabled: z.boolean().default(true),
});

const tableProfileSortSchema = z.object({
  column: z.string().trim().min(1).max(255),
  direction: z.enum(["asc", "desc"]),
  enabled: z.boolean().default(true),
});

const tableProfileConfigSchema = z.object({
  filters: z.array(tableProfileFilterSchema).max(20).optional(),
  sorts: z.array(tableProfileSortSchema).max(20).optional(),
  filter: z.object({
    column: z.string().trim().min(1).max(255),
    operator: z.enum(["contains", "eq", "ne", "gt", "gte", "lt", "lte", "isNull", "isNotNull"]),
    value: z.string().max(16 * 1024).default(""),
  }).nullable().optional(),
  sort: z.object({
    column: z.string().trim().min(1).max(255),
    direction: z.enum(["asc", "desc"]),
  }).nullable().optional(),
  columns: z.array(z.object({
    name: z.string().trim().min(1).max(255),
    visible: z.boolean(),
    width: z.number().int().min(40).max(4000),
  })).max(2000).default([]),
  pageSize: z.number().int().min(20).max(500).default(100),
  viewMode: z.enum(["grid", "form"]).default("grid"),
}).transform(({ filters, sorts, filter, sort, ...config }) => ({
  filters: filters ?? (filter ? [{ ...filter, enabled: true }] : []),
  sorts: sorts ?? (sort ? [{ ...sort, enabled: true }] : []),
  ...config,
}));

const tableProfileSchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().trim().min(1).max(64),
  table: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  config: tableProfileConfigSchema,
});

const objectFavoriteSchema = z.object({
  connectionId: z.string().uuid(),
  targetType: z.enum(["database", "table"]),
  database: z.string().trim().min(1).max(255),
  table: z.string().trim().max(255).default(""),
}).refine((value) => value.targetType === "database" || Boolean(value.table), {
  message: "收藏数据表时必须指定表名",
  path: ["table"],
});

const objectGroupSchema = z.object({
  connectionId: z.string().uuid(),
  database: z.string().trim().min(1).max(255),
  category: z.enum(["tables", "views", "functions", "events", "queries", "backups"]),
  name: z.string().trim().min(1).max(160),
});

const objectGroupMemberSchema = z.object({
  objectName: z.string().trim().min(1).max(255),
  objectSource: z.string().trim().max(32).default(""),
});

const tableChangesSchema = z.object({
  database: z.string().trim().min(1).max(255),
  table: z.string().trim().min(1).max(255),
  changes: z.array(z.object({
    type: z.enum(["insert", "update", "delete"]),
    values: z.record(z.string(), z.unknown()).default({}),
    key: z.record(z.string(), z.unknown()).default({}),
  })).min(1).max(500),
});

type ObjectCategory = "tables" | "views" | "procedures" | "functions" | "triggers" | "events";

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function errorMessage(error: unknown): string {
  const value = error as { code?: string; message?: string; sqlMessage?: string };
  if (value.code === "ER_ACCESS_DENIED_ERROR") return "数据库认证失败，请检查用户名和密码";
  if (value.code === "ECONNREFUSED") return "数据库端口拒绝连接";
  if (value.code === "ETIMEDOUT") return "数据库连接超时";
  return value.sqlMessage || value.message || String(error);
}

function columnValue(row: RowDataPacket, ...names: string[]): unknown {
  for (const name of names) {
    if (name in row) return row[name];
  }
  return undefined;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createStatement(rows: RowDataPacket[]): string {
  const row = rows[0];
  return row ? String(Object.entries(row).find(([key]) => key.toLowerCase().includes("create"))?.[1] ?? "") : "";
}

function sqlStringValue(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1).replaceAll("''", "'").replaceAll("\\\\", "\\");
  }
  return trimmed;
}

function ddlToken(ddl: string, name: string): string {
  return ddl.match(new RegExp(`\\b${name}\\s*=\\s*([A-Za-z0-9_$-]+)`, "i"))?.[1]?.toUpperCase() ?? "";
}

function ddlNumber(ddl: string, name: string): number | null {
  const value = ddl.match(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`, "i"))?.[1];
  return value === undefined ? null : Number(value);
}

function ddlBoolean(ddl: string, name: string): boolean | null {
  const value = ddl.match(new RegExp(`\\b${name}\\s*=\\s*([01])`, "i"))?.[1];
  return value === undefined ? null : value === "1";
}

function ddlString(ddl: string, name: string): string {
  const value = ddl.match(new RegExp(`\\b${name}\\s*=\\s*('(?:''|[^'])*'|"(?:""|[^"])*"|[^\\s]+)`, "i"))?.[1];
  return sqlStringValue(value);
}

function columnDefinition(ddl: string, column: string): string {
  return ddl.match(new RegExp("^\\s*`" + regexEscape(column) + "`\\s+.*?(?:,)?$", "mi"))?.[0] ?? "";
}

function primaryKeyLength(ddl: string, column: string): string {
  const primary = ddl.match(/^\s*PRIMARY KEY\s*\((.+)\)(?:\s+USING\s+[A-Za-z0-9_]+)?\s*,?\s*$/im)?.[1] ?? "";
  return primary.match(new RegExp("`" + regexEscape(column) + "`\\s*\\((\\d+)\\)", "i"))?.[1] ?? "";
}

function indexDefinition(ddl: string, name: string): string {
  return ddl.match(new RegExp("^\\s*(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?KEY\\s+`" + regexEscape(name) + "`\\s+.*?(?:,)?$", "mi"))?.[0] ?? "";
}

async function tableColumnsFromConnection(connection: DatabaseConnectionClient, database: string, table: string) {
  const [rows] = await connection.query<RowDataPacket[]>(`
    SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
      COLUMN_KEY, EXTRA, COLUMN_COMMENT, ORDINAL_POSITION
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION
  `, [database, table]);
  return rows.map((row) => ({
    name: String(row.COLUMN_NAME),
    columnType: String(row.COLUMN_TYPE),
    dataType: String(row.DATA_TYPE),
    nullable: row.IS_NULLABLE === "YES",
    defaultValue: row.COLUMN_DEFAULT,
    primary: row.COLUMN_KEY === "PRI",
    unique: row.COLUMN_KEY === "UNI",
    autoIncrement: String(row.EXTRA).includes("auto_increment"),
    comment: String(row.COLUMN_COMMENT ?? ""),
  }));
}

async function tableColumns(app: FastifyInstance, connectionId: string, database: string, table: string) {
  const connected = await connectDatabase(app, connectionId, database);
  try {
    return await tableColumnsFromConnection(connected.connection, database, table);
  } finally {
    await connected.close();
  }
}

export async function registerDatabaseWorkbenchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/database-connections/")) return;
    const connectionId = (request.params as { id?: string }).id;
    if (connectionId && !await canAccessConnection(app.db, request.admin!, "database", connectionId)) {
      await reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
      return;
    }
    if (connectionId) app.activeConnections.touchResource(request.admin!.id, "database", connectionId, executionScope(request));
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    if (!request.url.startsWith("/api/v1/database-connections/")) return payload;
    const connectionId = (request.params as { id?: string }).id;
    if (!connectionId || !request.admin) return payload;
    const sentBytes = request.body == null ? 0 : Buffer.byteLength(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
    const receivedBytes = typeof payload === "string"
      ? Buffer.byteLength(payload)
      : Buffer.isBuffer(payload) ? payload.byteLength : 0;
    app.activeConnections.recordResourceTraffic(
      request.admin.id,
      "database",
      connectionId,
      { sentBytes, receivedBytes },
      executionScope(request),
    );
    return payload;
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/test", async (request, reply) => {
    const started = Date.now();
    try {
      const connected = await connectDatabase(app, request.params.id);
      try {
        const [rows] = await connected.connection.query<RowDataPacket[]>("SELECT VERSION() AS version, CONNECTION_ID() AS connectionId");
        const latencyMs = Date.now() - started;
        await writeAudit(app.db, { action: "database.connection_tested", resourceType: "database_connection", resourceId: request.params.id, summary: `数据库连接测试成功 ${connected.record.name}`, details: { latencyMs, version: rows[0]?.version }, request });
        return { ok: true, latencyMs, version: String(rows[0]?.version ?? ""), connectionId: String(rows[0]?.connectionId ?? "") };
      } finally {
        await connected.close();
      }
    } catch (error) {
      const message = errorMessage(error);
      await writeAudit(app.db, { action: "database.connection_test_failed", resourceType: "database_connection", resourceId: request.params.id, summary: "数据库连接测试失败", details: { message }, request });
      return reply.code(502).send({ error: "DATABASE_CONNECTION_FAILED", message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/database-connections/:id/schemas", async (request, reply) => {
    try {
      const connected = await connectDatabase(app, request.params.id);
      try {
        const [rows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset,
            DEFAULT_COLLATION_NAME AS collation
          FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME
        `);
        return { items: rows.map((row) => ({ name: String(row.name), charset: String(row.charset), collation: String(row.collation) })) };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_SCHEMA_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string; category?: ObjectCategory };
  }>("/api/v1/database-connections/:id/objects", async (request, reply) => {
    const database = request.query.database?.trim();
    const category = request.query.category;
    if (!database || !category || !["tables", "views", "procedures", "functions", "triggers", "events"].includes(category)) {
      return reply.code(400).send({ error: "INVALID_OBJECT_QUERY", message: "请选择数据库和对象分类" });
    }
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        let sql = "";
        let values: unknown[] = [database];
        if (category === "tables" || category === "views") {
          sql = `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, DATA_LENGTH + INDEX_LENGTH AS dataSize,
            ENGINE AS engine, CREATE_TIME AS createdAt, UPDATE_TIME AS updatedAt,
            TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ? ORDER BY TABLE_NAME`;
          values = [database, category === "tables" ? "BASE TABLE" : "VIEW"];
        } else if (category === "procedures" || category === "functions") {
          sql = `SELECT ROUTINE_NAME AS name, CREATED AS createdAt, LAST_ALTERED AS updatedAt, ROUTINE_COMMENT AS comment
            FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME`;
          values = [database, category === "procedures" ? "PROCEDURE" : "FUNCTION"];
        } else if (category === "triggers") {
          sql = `SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, EVENT_OBJECT_TABLE AS tableName,
            ACTION_TIMING AS timing, CREATED AS createdAt FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`;
        } else {
          sql = `SELECT EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS eventType, INTERVAL_VALUE AS intervalValue,
            INTERVAL_FIELD AS intervalField, CREATED AS createdAt FROM information_schema.EVENTS
            WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`;
        }
        const [rows] = await connected.connection.query<RowDataPacket[]>(sql, values);
        return { items: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]))) };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_OBJECTS_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string };
  }>("/api/v1/database-connections/:id/completion-metadata", async (request, reply) => {
    const database = request.query.database?.trim();
    if (!database) return reply.code(400).send({ error: "INVALID_COMPLETION_DATABASE", message: "请选择数据库" });
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        const [tableRows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME
        `, [database]);
        const objectTypes = new Map(tableRows.map((row) => [String(row.TABLE_NAME), String(row.TABLE_TYPE) === "VIEW" ? "view" as const : "table" as const]));
        const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, ORDINAL_POSITION
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `, [database]);
        const objects = new Map<string, { name: string; type: "table" | "view"; columns: Array<{ name: string; dataType: string; columnType: string }> }>();
        for (const row of columnRows) {
          const name = String(row.TABLE_NAME);
          const object = objects.get(name) ?? { name, type: objectTypes.get(name) ?? "table", columns: [] };
          object.columns.push({ name: String(row.COLUMN_NAME), dataType: String(row.DATA_TYPE), columnType: String(row.COLUMN_TYPE) });
          objects.set(name, object);
        }
        const [routineRows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
          WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME
        `, [database]);
        return {
          database,
          objects: [...objects.values()],
          routines: routineRows.map((row) => ({ name: String(row.ROUTINE_NAME), type: String(row.ROUTINE_TYPE).toUpperCase() === "PROCEDURE" ? "procedure" : "function" })),
        };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_COMPLETION_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string; name?: string; type?: string };
  }>("/api/v1/database-connections/:id/ddl", async (request, reply) => {
    const database = request.query.database?.trim();
    const name = request.query.name?.trim();
    const type = request.query.type;
    const showTypes: Record<string, string> = {
      table: "TABLE",
      view: "VIEW",
      procedure: "PROCEDURE",
      function: "FUNCTION",
      trigger: "TRIGGER",
      event: "EVENT",
    };
    if (!database || !name || !type || !showTypes[type]) {
      return reply.code(400).send({ error: "INVALID_DDL_QUERY", message: "数据库对象参数不完整" });
    }
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        const [rows] = await connected.connection.query<RowDataPacket[]>(
          `SHOW CREATE ${showTypes[type]} ${identifier(database)}.${identifier(name)}`,
        );
        const row = rows[0];
        const ddl = row
          ? Object.entries(row).find(([key, value]) => key.toLowerCase().includes("create") && typeof value === "string")?.[1]
          : undefined;
        return { ddl: String(ddl ?? "") };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_DDL_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string; table?: string };
  }>("/api/v1/database-connections/:id/table-design", async (request, reply) => {
    const database = request.query.database?.trim();
    const table = request.query.table?.trim();
    if (!database || !table) return reply.code(400).send({ error: "INVALID_TABLE", message: "请选择数据表" });
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        const [createRows] = await connected.connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${identifier(database)}.${identifier(table)}`);
        const createDdl = createStatement(createRows);
        const [columnRows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA,
            COLUMN_COMMENT, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
            DATETIME_PRECISION, GENERATION_EXPRESSION, CHARACTER_SET_NAME, COLLATION_NAME, ORDINAL_POSITION
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
        `, [database, table]);
        if (!columnRows.length) return reply.code(404).send({ error: "TABLE_NOT_FOUND", message: "数据表不存在" });

        const fields = columnRows.map((row) => {
          const dataType = String(row.DATA_TYPE).toUpperCase();
          const columnType = String(row.COLUMN_TYPE);
          const extra = String(row.EXTRA ?? "");
          let length = "";
          let decimals = "";
          if (["VARCHAR", "CHAR", "BINARY", "VARBINARY", "BIT"].includes(dataType)) length = String(row.CHARACTER_MAXIMUM_LENGTH ?? columnType.match(/\((\d+)\)/)?.[1] ?? "");
          else if (["DECIMAL", "DOUBLE", "FLOAT"].includes(dataType)) {
            length = String(row.NUMERIC_PRECISION ?? "");
            decimals = String(row.NUMERIC_SCALE ?? "");
          } else if (["DATETIME", "TIMESTAMP", "TIME"].includes(dataType) && row.DATETIME_PRECISION !== null) length = String(row.DATETIME_PRECISION);
          else if (["ENUM", "SET"].includes(dataType)) length = columnType.replace(/^[^(]+\(|\)$/g, "");
          const defaultValue = row.COLUMN_DEFAULT;
          const defaultGenerated = /DEFAULT_GENERATED/i.test(extra);
          const generated = Boolean(String(row.GENERATION_EXPRESSION ?? "").trim()) || /VIRTUAL GENERATED|STORED GENERATED/i.test(extra);
          const onUpdateExpression = extra.match(/on update\s+(.+?)(?:\s+DEFAULT_GENERATED)?$/i)?.[1] ?? "";
          const definition = columnDefinition(createDdl, String(row.COLUMN_NAME));
          return {
            originalName: String(row.COLUMN_NAME),
            name: String(row.COLUMN_NAME),
            type: dataType,
            length,
            decimals,
            notNull: row.IS_NULLABLE === "NO",
            primaryKey: row.COLUMN_KEY === "PRI",
            unsigned: /\bunsigned\b/i.test(columnType),
            zerofill: /\bzerofill\b/i.test(columnType) || /\bZEROFILL\b/i.test(definition),
            charset: String(row.CHARACTER_SET_NAME ?? ""),
            collation: String(row.COLLATION_NAME ?? ""),
            binary: /\bBINARY\b/i.test(definition),
            columnFormat: (definition.match(/\bCOLUMN_FORMAT\s+(DEFAULT|FIXED|DYNAMIC)\b/i)?.[1] ?? "").toUpperCase(),
            storage: (definition.match(/\bSTORAGE\s+(DEFAULT|DISK|MEMORY)\b/i)?.[1] ?? "").toUpperCase(),
            keyLength: primaryKeyLength(createDdl, String(row.COLUMN_NAME)),
            autoIncrement: /auto_increment/i.test(extra),
            defaultKind: generated ? "none" : defaultValue === null ? (row.IS_NULLABLE === "YES" ? "null" : "none") : defaultGenerated || /^(?:CURRENT_|LOCALTIME|LOCALTIMESTAMP)/i.test(String(defaultValue)) ? "expression" : "value",
            defaultValue: defaultValue === null ? "" : String(defaultValue),
            comment: String(row.COLUMN_COMMENT ?? ""),
            generated,
            generatedExpression: String(row.GENERATION_EXPRESSION ?? ""),
            generatedStored: /STORED GENERATED/i.test(extra),
            onUpdateExpression,
          };
        });

        const [indexRows] = await connected.connection.query<RowDataPacket[]>(`SHOW INDEX FROM ${identifier(database)}.${identifier(table)}`);
        const indexGroups = new Map<string, RowDataPacket[]>();
        for (const row of indexRows) {
          const name = String(columnValue(row, "Key_name", "KEY_NAME") ?? "");
          if (!name || name === "PRIMARY") continue;
          const group = indexGroups.get(name) ?? [];
          group.push(row);
          indexGroups.set(name, group);
        }
        const indexes = [...indexGroups.entries()].map(([name, rows]) => {
          rows.sort((left, right) => Number(columnValue(left, "Seq_in_index", "SEQ_IN_INDEX") ?? 0) - Number(columnValue(right, "Seq_in_index", "SEQ_IN_INDEX") ?? 0));
          const first = rows[0];
          const indexType = String(columnValue(first, "Index_type", "INDEX_TYPE") ?? "BTREE").toUpperCase();
          const nonUnique = Number(columnValue(first, "Non_unique", "NON_UNIQUE") ?? 1);
          const definition = indexDefinition(createDdl, name);
          const indexKeyBlockSize = definition.match(/\bKEY_BLOCK_SIZE\s*=\s*(\d+)/i)?.[1];
          return {
            originalName: name,
            name,
            type: indexType === "FULLTEXT" ? "FULLTEXT" : nonUnique === 0 ? "UNIQUE" : "INDEX",
            columns: rows.map((row) => String(columnValue(row, "Column_name", "COLUMN_NAME") ?? "")).filter(Boolean),
            columnSettings: Object.fromEntries(rows.flatMap((row) => {
              const column = String(columnValue(row, "Column_name", "COLUMN_NAME") ?? "");
              if (!column) return [];
              return [[column, {
                length: String(columnValue(row, "Sub_part", "SUB_PART") ?? ""),
                order: String(columnValue(row, "Collation", "COLLATION") ?? "") === "D" ? "DESC" : String(columnValue(row, "Collation", "COLLATION") ?? "") === "A" ? "ASC" : "",
              }]];
            })),
            method: indexType === "HASH" ? "HASH" : "BTREE",
            comment: String(columnValue(first, "Index_comment", "INDEX_COMMENT") ?? ""),
            collation: String(columnValue(first, "Collation", "COLLATION") ?? "") === "D" ? "DESC" : "",
            cardinality: String(columnValue(first, "Cardinality", "CARDINALITY") ?? ""),
            packed: !["", "NULL", "NO", "0"].includes(String(columnValue(first, "Packed", "PACKED") ?? "").toUpperCase()),
            keyBlockSize: indexKeyBlockSize ? Number(indexKeyBlockSize) : null,
            parser: definition.match(/\bWITH\s+PARSER\s+`?([^`\s]+)`?/i)?.[1] ?? "",
            invisible: String(columnValue(first, "Visible", "VISIBLE") ?? "YES").toUpperCase() === "NO" || /\bINVISIBLE\b/i.test(definition),
          };
        });

        const parsedConstraints = parseCreateTableConstraints(createDdl, database);
        let foreignKeys = parsedConstraints.foreignKeys;
        if (!parsedConstraints.foreignKeysComplete) {
          const [foreignKeyRows] = await connected.connection.query<RowDataPacket[]>(`
            SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
              k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION, r.UPDATE_RULE, r.DELETE_RULE
            FROM information_schema.KEY_COLUMN_USAGE k
            JOIN information_schema.REFERENTIAL_CONSTRAINTS r
              ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION
          `, [database, table]);
          const foreignKeyGroups = new Map<string, RowDataPacket[]>();
          for (const row of foreignKeyRows) {
            const name = String(row.CONSTRAINT_NAME);
            const group = foreignKeyGroups.get(name) ?? [];
            group.push(row);
            foreignKeyGroups.set(name, group);
          }
          foreignKeys = [...foreignKeyGroups.entries()].map(([name, rows]) => ({
            originalName: name,
            name,
            columns: rows.map((row) => String(row.COLUMN_NAME)),
            referencedDatabase: String(rows[0].REFERENCED_TABLE_SCHEMA ?? database),
            referencedTable: String(rows[0].REFERENCED_TABLE_NAME),
            referencedColumns: rows.map((row) => String(row.REFERENCED_COLUMN_NAME)),
            onDelete: String(rows[0].DELETE_RULE ?? "RESTRICT") as "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION",
            onUpdate: String(rows[0].UPDATE_RULE ?? "RESTRICT") as "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION",
          }));
        }

        let checks: Array<{ originalName: string; name: string; expression: string }> = parsedConstraints.checks;
        if (!parsedConstraints.checksComplete) {
          try {
            const [checkRows] = await connected.connection.query<RowDataPacket[]>(`
              SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
              FROM information_schema.TABLE_CONSTRAINTS tc
              JOIN information_schema.CHECK_CONSTRAINTS cc
                ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
              WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
              ORDER BY tc.CONSTRAINT_NAME
            `, [database, table]);
            checks = checkRows.map((row) => ({ originalName: String(row.CONSTRAINT_NAME), name: String(row.CONSTRAINT_NAME), expression: String(row.CHECK_CLAUSE ?? "") }));
          } catch {
            checks = [];
          }
        }

        const [triggerRows] = await connected.connection.query<RowDataPacket[]>(`
          SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
          FROM information_schema.TRIGGERS
          WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
          ORDER BY TRIGGER_NAME
        `, [database, table]);
        const triggers = triggerRows.map((row) => ({
          originalName: String(row.TRIGGER_NAME),
          name: String(row.TRIGGER_NAME),
          timing: String(row.ACTION_TIMING),
          event: String(row.EVENT_MANIPULATION),
          statement: String(row.ACTION_STATEMENT ?? ""),
        }));

        const [statusRows] = await connected.connection.query<RowDataPacket[]>(`SHOW TABLE STATUS FROM ${identifier(database)} LIKE ?`, [table]);
        const status = statusRows[0] ?? {} as RowDataPacket;
        const createOptions = `${String(columnValue(status, "Create_options", "CREATE_OPTIONS") ?? "")} ${createDdl}`;
        const keyBlockSize = createOptions.match(/key_block_size=(\d+)/i)?.[1];
        const partition = createDdl.match(/\bPARTITION BY\s+([\s\S]+)$/i)?.[1]
          ?.replace(/\/\*![0-9]+\s*/g, "")
          .replace(/\*\/$/, "")
          .trim() ?? "";
        const unionTables = createDdl.match(/\bUNION\s*=\s*\(([^)]*)\)/i)?.[1]?.trim() ?? "";
        return {
          design: {
            database,
            tableName: table,
            fields,
            indexes,
            foreignKeys,
            checks,
            triggers,
            options: {
              engine: String(columnValue(status, "Engine", "ENGINE") ?? "InnoDB"),
              charset: String(columnValue(status, "Collation", "COLLATION") ?? "utf8mb4").split("_")[0],
              collation: String(columnValue(status, "Collation", "COLLATION") ?? ""),
              rowFormat: String(columnValue(status, "Row_format", "ROW_FORMAT") ?? "").toUpperCase(),
              autoIncrement: columnValue(status, "Auto_increment", "AUTO_INCREMENT") === null ? null : Number(columnValue(status, "Auto_increment", "AUTO_INCREMENT")),
              tablespace: createDdl.match(/\bTABLESPACE\s+`?([^`\s]+)`?/i)?.[1] ?? "",
              minRows: Number(columnValue(status, "Min_rows", "MIN_ROWS") ?? 0) || null,
              averageRowLength: Number(columnValue(status, "Avg_row_length", "AVG_ROW_LENGTH") ?? 0) || null,
              keyBlockSize: keyBlockSize ? Number(keyBlockSize) : null,
              maxRows: Number(columnValue(status, "Max_rows", "MAX_ROWS") ?? 0) || null,
              partition,
              dataDirectory: ddlString(createDdl, "DATA\\s+DIRECTORY"),
              indexDirectory: ddlString(createDdl, "INDEX\\s+DIRECTORY"),
              delayKeyWrite: ddlBoolean(createOptions, "DELAY_KEY_WRITE"),
              packKeys: ddlToken(createOptions, "PACK_KEYS"),
              checksum: ddlBoolean(createOptions, "CHECKSUM"),
              pageChecksum: ddlBoolean(createOptions, "PAGE_CHECKSUM"),
              connection: ddlString(createDdl, "CONNECTION"),
              encryption: ddlString(createDdl, "ENCRYPTION").toUpperCase(),
              unionTables,
              insertMethod: ddlToken(createDdl, "INSERT_METHOD"),
              statsPersistent: ddlToken(createOptions, "STATS_PERSISTENT"),
              statsAutoRecalc: ddlToken(createOptions, "STATS_AUTO_RECALC"),
              statsSamplePages: ddlNumber(createOptions, "STATS_SAMPLE_PAGES"),
              transactional: ddlBoolean(createOptions, "TRANSACTIONAL"),
            },
            comment: String(columnValue(status, "Comment", "COMMENT") ?? ""),
          },
        };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "TABLE_DESIGN_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string; table?: string; page?: string; pageSize?: string; filters?: string; sorts?: string; sort?: string; direction?: string; filterColumn?: string; filterOperator?: string; filterValue?: string };
  }>("/api/v1/database-connections/:id/table-data", async (request, reply) => {
    const database = request.query.database?.trim();
    const table = request.query.table?.trim();
    if (!database || !table) return reply.code(400).send({ error: "INVALID_TABLE", message: "请选择数据表" });
    const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
    const pageSize = Math.max(20, Math.min(500, Number.parseInt(request.query.pageSize ?? "100", 10) || 100));
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        const columns = await tableColumnsFromConnection(connected.connection, database, table);
        if (!columns.length) return reply.code(404).send({ error: "TABLE_NOT_FOUND", message: "数据表不存在" });
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query)) if (value !== undefined) queryParams.set(key, value);
        const rules = parseTableDataQueryRules(queryParams, columns.map((column) => column.name));
        const clauses = buildTableDataClauses(rules.filters, rules.sorts, columns[0].name);
        const [countRows] = await connected.connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${identifier(database)}.${identifier(table)}${clauses.where}`, clauses.params);
        const [rows] = await connected.connection.query<RowDataPacket[]>(
          `SELECT * FROM ${identifier(database)}.${identifier(table)}${clauses.where}${clauses.orderBy} LIMIT ? OFFSET ?`,
          [...clauses.params, pageSize, (page - 1) * pageSize],
        );
        return {
          columns,
          primaryKey: columns.filter((column) => column.primary).map((column) => column.name),
          page,
          pageSize,
          total: Number(countRows[0]?.total ?? 0),
          rows,
        };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "TABLE_DATA_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { database?: string; table?: string; column?: string; q?: string; limit?: string };
  }>("/api/v1/database-connections/:id/table-data/suggestions", async (request, reply) => {
    const database = request.query.database?.trim();
    const table = request.query.table?.trim();
    const requestedColumn = request.query.column?.trim();
    if (!database || !table || !requestedColumn) return reply.code(400).send({ error: "INVALID_TABLE_SUGGESTION", message: "请选择筛选字段" });
    const limit = Math.max(10, Math.min(100, Number.parseInt(request.query.limit ?? "50", 10) || 50));
    const search = request.query.q?.trim().slice(0, 500) ?? "";
    try {
      const connected = await connectDatabase(app, request.params.id, database);
      try {
        const columns = await tableColumnsFromConnection(connected.connection, database, table);
        const column = columns.find((candidate) => candidate.name === requestedColumn)?.name;
        if (!column) return reply.code(404).send({ error: "TABLE_COLUMN_NOT_FOUND", message: "筛选字段不存在" });
        const expression = `CAST(${identifier(column)} AS CHAR)`;
        const searchSql = search ? ` AND ${expression} LIKE ?` : "";
        const params = search ? [`%${search}%`, limit] : [limit];
        const [rows] = await connected.connection.query<RowDataPacket[]>(
          `SELECT DISTINCT ${expression} AS value FROM ${identifier(database)}.${identifier(table)} WHERE ${identifier(column)} IS NOT NULL${searchSql} ORDER BY value LIMIT ?`,
          params,
        );
        return { items: rows.map((row) => String(row.value ?? "")) };
      } finally {
        await connected.close();
      }
    } catch (error) {
      return reply.code(502).send({ error: "TABLE_SUGGESTIONS_FAILED", message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/table-data/changes", async (request, reply) => {
    const body = parseBody(tableChangesSchema, request.body, reply);
    if (!body) return;
    try {
      const columns = await tableColumns(app, request.params.id, body.database, body.table);
      const allowed = new Set(columns.map((column) => column.name));
      const primary = columns.filter((column) => column.primary).map((column) => column.name);
      if (!columns.length) return reply.code(404).send({ error: "TABLE_NOT_FOUND", message: "数据表不存在" });
      if (body.changes.some((change) => change.type !== "insert") && !primary.length) {
        return reply.code(400).send({ error: "PRIMARY_KEY_REQUIRED", message: "没有主键的数据表不能直接修改或删除" });
      }
      const connected = await connectDatabase(app, request.params.id, body.database);
      let changed = 0;
      try {
        await connected.connection.beginTransaction();
        for (const change of body.changes) {
          const values = Object.entries(change.values).filter(([key]) => allowed.has(key));
          if (change.type === "insert") {
            if (!values.length) continue;
            const sql = `INSERT INTO ${identifier(body.database)}.${identifier(body.table)} (${values.map(([key]) => identifier(key)).join(",")}) VALUES (${values.map(() => "?").join(",")})`;
            const [result] = await connected.connection.query(sql, values.map(([, value]) => value));
            changed += Number((result as { affectedRows?: number }).affectedRows ?? 0);
          } else {
            const keys = primary.map((key) => [key, change.key[key]] as const);
            if (keys.some(([, value]) => value === undefined)) throw new Error("修改数据缺少完整主键");
            const where = keys.map(([key]) => `${identifier(key)} <=> ?`).join(" AND ");
            if (change.type === "delete") {
              const [result] = await connected.connection.query(`DELETE FROM ${identifier(body.database)}.${identifier(body.table)} WHERE ${where} LIMIT 1`, keys.map(([, value]) => value));
              changed += Number((result as { affectedRows?: number }).affectedRows ?? 0);
            } else {
              if (!values.length) continue;
              const set = values.map(([key]) => `${identifier(key)} = ?`).join(",");
              const [result] = await connected.connection.query(
                `UPDATE ${identifier(body.database)}.${identifier(body.table)} SET ${set} WHERE ${where} LIMIT 1`,
                [...values.map(([, value]) => value), ...keys.map(([, value]) => value)],
              );
              changed += Number((result as { affectedRows?: number }).affectedRows ?? 0);
            }
          }
        }
        await connected.connection.commit();
      } catch (error) {
        await connected.connection.rollback();
        throw error;
      } finally {
        await connected.close();
      }
      await writeAudit(app.db, { action: "database.table_data_changed", resourceType: "database_connection", resourceId: request.params.id, summary: `提交数据表变更 ${body.database}.${body.table}`, details: { changed, operations: body.changes.length }, request });
      return { changed };
    } catch (error) {
      return reply.code(502).send({ error: "TABLE_CHANGE_FAILED", message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/queries", async (request, reply) => {
    const body = parseBody(querySchema, request.body, reply);
    if (!body || !request.admin) return;
    try {
      const job = await app.databaseQueries.create(
        request.admin,
        request.params.id,
        body.sql,
        body.database,
        executionScope(request),
        body.continueOnError,
      );
      return reply.code(202).send({ job });
    } catch (error) {
      return reply.code(429).send({ error: "QUERY_START_FAILED", message: error instanceof Error ? error.message : "无法开始查询" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/queries/batch", async (request, reply) => {
    const body = parseBody(readBatchSchema, request.body, reply);
    if (!body) return;
    let queries: Array<{ sql: string; database: string }>;
    try {
      queries = body.queries.map((query) => ({ ...query, sql: assertMcpReadOnlySql(query.sql) }));
    } catch (error) {
      return reply.code(400).send({ error: "DATABASE_BATCH_NOT_READ_ONLY", message: error instanceof Error ? error.message : "批量查询只允许只读 SQL" });
    }
    const started = Date.now();
    const items = [];
    let responseBytes = 0;
    const connections = new Map<string, Awaited<ReturnType<typeof connectDatabase>>>();
    try {
      for (let index = 0; index < queries.length; index += 1) {
        const queryStarted = Date.now();
        const database = queries[index].database;
        let connected = connections.get(database);
        try {
          if (!connected) {
            connected = await connectDatabase(app, request.params.id, database || undefined);
            connections.set(database, connected);
          }
          const [rows, fields] = await connected.connection.query<RowDataPacket[]>(queries[index].sql);
          const safeRows = Array.isArray(rows) ? rows.slice(0, 500).map(safeBatchRow) : [];
          const item = {
            index, ok: true, database,
            columns: (fields as FieldPacket[] | undefined ?? []).map((field) => ({ name: field.name, table: field.table, type: field.type ?? 0 })),
            rows: safeRows, rowCount: safeRows.length, truncated: Array.isArray(rows) && rows.length > safeRows.length,
            durationMs: Date.now() - queryStarted,
          };
          const itemBytes = Buffer.byteLength(JSON.stringify(item));
          if (responseBytes + itemBytes > databaseBatchMaxResponseBytes) {
            items.push({ index, ok: false, database, error: "批量数据库响应累计超过 2 MiB 限制", durationMs: Date.now() - queryStarted });
            break;
          }
          responseBytes += itemBytes;
          items.push(item);
        } catch (error) {
          if (connected) {
            connections.delete(database);
            await connected.close();
          }
          items.push({ index, ok: false, database, error: errorMessage(error), durationMs: Date.now() - queryStarted });
        }
      }
    } finally {
      await Promise.all([...connections.values()].map((connected) => connected.close()));
    }
    await writeAudit(app.db, {
      action: "mcp.database_queries_read_batch",
      resourceType: "database_connection",
      resourceId: request.params.id,
      summary: `MCP 批量执行 ${queries.length} 条数据库只读查询`,
      details: { queryCount: queries.length, failedCount: items.filter((item) => !item.ok).length, responseBytes, durationMs: Date.now() - started },
      request,
    });
    return { items, responseBytes, durationMs: Date.now() - started, reusedConnection: queries.length > new Set(queries.map((query) => query.database)).size };
  });

  app.get<{ Params: { id: string } }>("/api/v1/database-queries/:id", async (request, reply) => {
    const job = app.databaseQueries.get(request.params.id, request.admin!.id, executionScope(request));
    if (!job || !await canAccessConnection(app.db, request.admin!, "database", job.connectionId)) {
      return reply.code(404).send({ error: "QUERY_NOT_FOUND", message: "查询任务不存在或已过期" });
    }
    return { job };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-queries/:id", async (request, reply) => {
    const job = app.databaseQueries.get(request.params.id, request.admin!.id, executionScope(request));
    if (!job || !await canAccessConnection(app.db, request.admin!, "database", job.connectionId)) {
      return reply.code(404).send({ error: "QUERY_NOT_FOUND", message: "查询任务不存在或已过期" });
    }
    if (!app.databaseQueries.cancel(request.params.id, request.admin!.id, executionScope(request))) {
      return reply.code(409).send({ error: "QUERY_NOT_RUNNING", message: "查询已经结束或不存在" });
    }
    return reply.code(204).send();
  });

  app.get<{ Querystring: AuditListQuery & { connectionId?: string; status?: string } }>("/api/v1/database-query-history", async (request) => {
    const query = parseAuditListQuery(request.query, 500);
    const showOrganizationRecords = request.admin!.workspace.type === "organization" && canManageWorkspace(request);
    const filters: string[] = ["c.workspace_type = ?", "c.workspace_id = ?", "h.created_at >= ?"];
    const values: unknown[] = [request.admin!.workspace.type, request.admin!.workspace.id, auditRetentionCutoff(app.config.auditRetentionDays)];
    if (!showOrganizationRecords) { filters.push("h.owner_user_id = ?"); values.push(request.admin!.id); }
    if (query.actorUserId) { filters.push("h.owner_user_id = ?"); values.push(query.actorUserId); }
    if (request.query.connectionId) {
      if (!await canAccessConnection(app.db, request.admin!, "database", request.query.connectionId)) return { items: [] };
      filters.push("h.connection_id = ?"); values.push(request.query.connectionId);
    }
    if (request.query.status) { filters.push("h.status = ?"); values.push(request.query.status); }
    if (query.keyword) {
      filters.push("(c.name LIKE ? ESCAPE '!' OR h.database_name LIKE ? ESCAPE '!' OR h.status LIKE ? ESCAPE '!')");
      const pattern = auditLikePattern(query.keyword);
      values.push(pattern, pattern, pattern);
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const rows = await app.db.prepare(`
      SELECT h.*, c.name AS connection_name, u.username AS owner_username FROM database_query_history h
      LEFT JOIN database_connections c ON c.id = h.connection_id
      LEFT JOIN admin_users u ON u.id = h.owner_user_id
      ${where} ORDER BY h.created_at DESC LIMIT ? OFFSET ?
    `).all(...values, query.pageSize + 1, query.offset) as Record<string, unknown>[];
    const hasMore = rows.length > query.pageSize;
    const items = (await filterAsync(rows.slice(0, query.pageSize), (row) => Boolean(row.connection_id) && canAccessConnection(app.db, request.admin!, "database", String(row.connection_id))))
      .map((row) => ({ id: row.id, actor: row.owner_user_id && row.owner_username ? { id: row.owner_user_id, username: row.owner_username } : null, connectionId: row.connection_id, connectionName: row.connection_name, database: row.database_name, sql: row.sql_text, status: row.status, durationMs: Number(row.duration_ms), rowCount: Number(row.row_count), error: row.error_message, createdAt: row.created_at }));
    return { items, page: query.page, pageSize: query.pageSize, hasMore, retentionDays: app.config.auditRetentionDays };
  });

  app.get("/api/v1/database-object-favorites", async (request) => {
    const rows = await app.db.prepare(`
      SELECT f.*, c.name AS connection_name, c.engine, c.host, c.port,
        (SELECT environment_id FROM database_connection_environments ce WHERE ce.connection_id = c.id ORDER BY environment_id LIMIT 1) AS environment_id
      FROM database_object_favorites f
      JOIN database_connections c ON c.id = f.connection_id
      WHERE f.owner_user_id = ?
      ORDER BY f.updated_at DESC
    `).all(request.admin!.id) as Record<string, unknown>[];
    return {
      items: (await filterAsync(rows, (row) => canAccessConnection(app.db, request.admin!, "database", String(row.connection_id)))).map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        connectionName: row.connection_name,
        environmentId: row.environment_id,
        engine: row.engine,
        host: row.host,
        port: Number(row.port),
        targetType: row.target_type,
        database: row.database_name,
        table: row.table_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  });

  app.post("/api/v1/database-object-favorites", async (request, reply) => {
    const body = parseBody(objectFavoriteSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const connection = await app.db.prepare("SELECT name FROM database_connections WHERE id = ?").get(body.connectionId) as { name: string };
    const table = body.targetType === "table" ? body.table : "";
    const existing = await app.db.prepare(`
      SELECT id FROM database_object_favorites
      WHERE owner_user_id = ? AND connection_id = ? AND target_type = ? AND database_name = ? AND table_name = ?
    `).get(request.admin.id, body.connectionId, body.targetType, body.database, table) as { id: string } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      await app.db.prepare("UPDATE database_object_favorites SET updated_at = ? WHERE id = ?").run(now, existing.id);
      return { id: existing.id, created: false };
    }
    const id = randomUUID();
    await app.db.prepare(`
      INSERT INTO database_object_favorites (
        id, owner_user_id, connection_id, target_type, database_name, table_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, request.admin.id, body.connectionId, body.targetType, body.database, table, now, now);
    await writeAudit(app.db, {
      action: "database.object_favorite_created",
      resourceType: "database_connection",
      resourceId: body.connectionId,
      summary: body.targetType === "table"
        ? `收藏数据表 ${connection.name}/${body.database}.${table}`
        : `收藏数据库 ${connection.name}/${body.database}`,
      request,
    });
    return reply.code(201).send({ id, created: true });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-object-favorites/:id", async (request, reply) => {
    const favorite = await app.db.prepare(`
      SELECT id, connection_id, target_type, database_name, table_name
      FROM database_object_favorites WHERE id = ? AND owner_user_id = ?
    `).get(request.params.id, request.admin!.id) as
      | { id: string; connection_id: string; target_type: "database" | "table"; database_name: string; table_name: string }
      | undefined;
    if (!favorite) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库收藏不存在" });
    if (!await canAccessConnection(app.db, request.admin!, "database", favorite.connection_id)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库收藏不存在" });
    await app.db.prepare("DELETE FROM database_object_favorites WHERE id = ?").run(favorite.id);
    await writeAudit(app.db, {
      action: "database.object_favorite_deleted",
      resourceType: "database_connection",
      resourceId: favorite.connection_id,
      summary: favorite.target_type === "table"
        ? `取消收藏数据表 ${favorite.database_name}.${favorite.table_name}`
        : `取消收藏数据库 ${favorite.database_name}`,
      request,
    });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { connectionId?: string; database?: string; table?: string } }>("/api/v1/database-table-profiles", async (request, reply) => {
    const connectionId = request.query.connectionId?.trim();
    const database = request.query.database?.trim();
    const table = request.query.table?.trim();
    if (!connectionId || !database || !table) return reply.code(400).send({ error: "INVALID_TABLE_PROFILE_QUERY", message: "请选择连接和数据表" });
    if (!await canAccessConnection(app.db, request.admin!, "database", connectionId)) return { items: [] };
    const rows = await app.db.prepare(`
      SELECT * FROM database_table_profiles
      WHERE owner_user_id = ? AND connection_id = ? AND database_name = ? AND table_name = ?
      ORDER BY name
    `).all(request.admin!.id, connectionId, database, table) as Record<string, unknown>[];
    return {
      items: rows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        database: row.database_name,
        table: row.table_name,
        name: row.name,
        config: tableProfileConfigSchema.parse(JSON.parse(String(row.config_json))),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        accessedAt: row.accessed_at,
      })),
    };
  });

  app.post("/api/v1/database-table-profiles", async (request, reply) => {
    const body = parseBody(tableProfileSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        INSERT INTO database_table_profiles (
          id, owner_user_id, connection_id, database_name, table_name, name, config_json, created_at, updated_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, request.admin.id, body.connectionId, body.database, body.table, body.name, JSON.stringify(body.config), now, now, now);
    } catch {
      return reply.code(409).send({ error: "TABLE_PROFILE_NAME_CONFLICT", message: `表配置文件“${body.name}”已存在` });
    }
    await writeAudit(app.db, { action: "database.table_profile_created", resourceType: "database_connection", resourceId: body.connectionId, summary: `保存表配置文件 ${body.database}.${body.table}/${body.name}`, request });
    return reply.code(201).send({ id, createdAt: now, updatedAt: now, accessedAt: now });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-table-profiles/:id", async (request, reply) => {
    const body = parseBody(tableProfileSchema, request.body, reply);
    if (!body || !request.admin) return;
    const existing = await app.db.prepare("SELECT connection_id FROM database_table_profiles WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin.id) as { connection_id: string } | undefined;
    if (!existing || !await canAccessConnection(app.db, request.admin, "database", existing.connection_id) || !await canAccessConnection(app.db, request.admin, "database", body.connectionId)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "表配置文件不存在" });
    }
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        UPDATE database_table_profiles
        SET connection_id = ?, database_name = ?, table_name = ?, name = ?, config_json = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ?
      `).run(body.connectionId, body.database, body.table, body.name, JSON.stringify(body.config), now, request.params.id, request.admin.id);
    } catch {
      return reply.code(409).send({ error: "TABLE_PROFILE_NAME_CONFLICT", message: `表配置文件“${body.name}”已存在` });
    }
    await writeAudit(app.db, { action: "database.table_profile_updated", resourceType: "database_connection", resourceId: body.connectionId, summary: `更新表配置文件 ${body.database}.${body.table}/${body.name}`, request });
    return { ok: true, updatedAt: now };
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-table-profiles/:id/access", async (request, reply) => {
    const profile = await app.db.prepare("SELECT connection_id FROM database_table_profiles WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as { connection_id: string } | undefined;
    if (!profile || !await canAccessConnection(app.db, request.admin!, "database", profile.connection_id)) return reply.code(404).send({ error: "NOT_FOUND", message: "表配置文件不存在" });
    const accessedAt = new Date().toISOString();
    await app.db.prepare("UPDATE database_table_profiles SET accessed_at = ? WHERE id = ?").run(accessedAt, request.params.id);
    return { ok: true, accessedAt };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-table-profiles/:id", async (request, reply) => {
    const profile = await app.db.prepare("SELECT connection_id, database_name, table_name, name FROM database_table_profiles WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as { connection_id: string; database_name: string; table_name: string; name: string } | undefined;
    if (!profile || !await canAccessConnection(app.db, request.admin!, "database", profile.connection_id)) return reply.code(404).send({ error: "NOT_FOUND", message: "表配置文件不存在" });
    await app.db.prepare("DELETE FROM database_table_profiles WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, { action: "database.table_profile_deleted", resourceType: "database_connection", resourceId: profile.connection_id, summary: `删除表配置文件 ${profile.database_name}.${profile.table_name}/${profile.name}`, request });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { connectionId?: string; database?: string; category?: string } }>("/api/v1/database-object-groups", async (request) => {
    const filters = ["g.owner_user_id = ?"];
    const values: unknown[] = [request.admin!.id];
    if (request.query.connectionId) {
      if (!await canAccessConnection(app.db, request.admin!, "database", request.query.connectionId)) return { items: [] };
      filters.push("g.connection_id = ?");
      values.push(request.query.connectionId);
    }
    if (request.query.database) { filters.push("g.database_name = ?"); values.push(request.query.database); }
    if (request.query.category) { filters.push("g.category = ?"); values.push(request.query.category); }
    const groups = await app.db.prepare(`
      SELECT g.* FROM database_object_groups g
      WHERE ${filters.join(" AND ")} ORDER BY g.database_name, g.category, g.name
    `).all(...values) as Record<string, unknown>[];
    const result = [];
    for (const group of groups) {
      const members = await app.db.prepare("SELECT object_name, object_source FROM database_object_group_members WHERE group_id = ? ORDER BY object_name")
        .all(group.id) as Array<{ object_name: string; object_source: string }>;
      result.push({ id: group.id, connectionId: group.connection_id, database: group.database_name, category: group.category, name: group.name, members: members.map((member) => ({ objectName: member.object_name, objectSource: member.object_source })), createdAt: group.created_at, updatedAt: group.updated_at });
    }
    return { items: result };
  });

  app.post("/api/v1/database-object-groups", async (request, reply) => {
    const body = parseBody(objectGroupSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      await app.db.prepare("INSERT INTO database_object_groups (id, owner_user_id, connection_id, database_name, category, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, request.admin.id, body.connectionId, body.database, body.category, body.name, now, now);
      return reply.code(201).send({ id });
    } catch {
      return reply.code(409).send({ error: "OBJECT_GROUP_CONFLICT", message: `对象组“${body.name}”已存在` });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/v1/database-object-groups/:id", async (request, reply) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(160) }), request.body, reply);
    if (!body) return;
    try {
      const result = await app.db.prepare("UPDATE database_object_groups SET name = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?")
        .run(body.name, new Date().toISOString(), request.params.id, request.admin!.id);
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "对象组不存在" });
      return { ok: true };
    } catch {
      return reply.code(409).send({ error: "OBJECT_GROUP_CONFLICT", message: `对象组“${body.name}”已存在` });
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-object-groups/:id/members", async (request, reply) => {
    const body = parseBody(objectGroupMemberSchema, request.body, reply);
    if (!body) return;
    const group = await app.db.prepare("SELECT id, connection_id, database_name, category FROM database_object_groups WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as
      | { id: string; connection_id: string; database_name: string; category: string }
      | undefined;
    if (!group) return reply.code(404).send({ error: "NOT_FOUND", message: "对象组不存在" });
    const now = new Date().toISOString();
    await app.db.prepare(`
      DELETE FROM database_object_group_members
      WHERE object_name = ? AND object_source = ? AND group_id IN (
        SELECT id FROM database_object_groups
        WHERE owner_user_id = ? AND connection_id = ? AND database_name = ? AND category = ?
      )
    `).run(body.objectName, body.objectSource, request.admin!.id, group.connection_id, group.database_name, group.category);
    await app.db.prepare("INSERT INTO database_object_group_members (group_id, object_name, object_source, created_at) VALUES (?, ?, ?, ?)")
      .run(request.params.id, body.objectName, body.objectSource, now);
    await app.db.prepare("UPDATE database_object_groups SET updated_at = ? WHERE id = ?").run(now, request.params.id);
    return reply.code(201).send({ ok: true });
  });

  app.delete<{ Params: { id: string }; Querystring: { objectName?: string; objectSource?: string } }>("/api/v1/database-object-groups/:id/members", async (request, reply) => {
    if (!request.query.objectName) return reply.code(400).send({ error: "INVALID_OBJECT_GROUP_MEMBER", message: "请选择数据库对象" });
    const group = await app.db.prepare("SELECT id FROM database_object_groups WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id);
    if (!group) return reply.code(404).send({ error: "NOT_FOUND", message: "对象组不存在" });
    await app.db.prepare("DELETE FROM database_object_group_members WHERE group_id = ? AND object_name = ? AND object_source = ?")
      .run(request.params.id, request.query.objectName, request.query.objectSource || "");
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-object-groups/:id", async (request, reply) => {
    const result = await app.db.prepare("DELETE FROM database_object_groups WHERE id = ? AND owner_user_id = ?").run(request.params.id, request.admin!.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "对象组不存在" });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { connectionId?: string; database?: string } }>("/api/v1/database-saved-queries", async (request) => {
    const filters = ["q.owner_user_id = ?"];
    const values: unknown[] = [request.admin!.id];
    if (request.query.connectionId) {
      if (!await canAccessConnection(app.db, request.admin!, "database", request.query.connectionId)) return { items: [] };
      filters.push("q.connection_id = ?");
      values.push(request.query.connectionId);
    }
    if (request.query.database) {
      filters.push("q.database_name = ?");
      values.push(request.query.database);
    }
    const rows = await app.db.prepare(`
      SELECT q.*, u.username AS owner_name
      FROM database_saved_queries q
      JOIN admin_users u ON u.id = q.owner_user_id
      WHERE ${filters.join(" AND ")}
      ORDER BY q.name
    `).all(...values) as Record<string, unknown>[];
    const visibleRows = await filterAsync(rows, (row) => canAccessConnection(app.db, request.admin!, "database", String(row.connection_id)));
    return {
      items: visibleRows.map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        database: row.database_name,
        name: row.name,
        sql: row.sql_text,
        ownerName: row.owner_name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        accessedAt: row.accessed_at,
      })),
    };
  });

  app.post("/api/v1/database-saved-queries", async (request, reply) => {
    const body = parseBody(savedQuerySchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const duplicate = await app.db.prepare(`
      SELECT id FROM database_saved_queries
      WHERE owner_user_id = ? AND connection_id = ? AND database_name = ? AND name = ?
    `).get(request.admin.id, body.connectionId, body.database, body.name);
    if (duplicate) return reply.code(409).send({ error: "QUERY_NAME_CONFLICT", message: `查询“${body.name}”已存在` });
    const id = randomUUID();
    const now = new Date().toISOString();
    await app.db.prepare(`
      INSERT INTO database_saved_queries (
        id, owner_user_id, connection_id, database_name, name, sql_text, created_at, updated_at, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, request.admin.id, body.connectionId, body.database, body.name, body.sql, now, now, now);
    await writeAudit(app.db, { action: "database.saved_query_created", resourceType: "database_connection", resourceId: body.connectionId, summary: `保存查询 ${body.database}/${body.name}`, request });
    return reply.code(201).send({ id, createdAt: now, updatedAt: now, accessedAt: now });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-saved-queries/:id", async (request, reply) => {
    const body = parseBody(savedQuerySchema, request.body, reply);
    if (!body || !request.admin) return;
    const existing = await app.db.prepare("SELECT id FROM database_saved_queries WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin.id);
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "保存查询不存在" });
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const duplicate = await app.db.prepare(`
      SELECT id FROM database_saved_queries
      WHERE owner_user_id = ? AND connection_id = ? AND database_name = ? AND name = ? AND id <> ?
    `).get(request.admin.id, body.connectionId, body.database, body.name, request.params.id);
    if (duplicate) return reply.code(409).send({ error: "QUERY_NAME_CONFLICT", message: `查询“${body.name}”已存在` });
    const now = new Date().toISOString();
    await app.db.prepare(`
      UPDATE database_saved_queries
      SET connection_id = ?, database_name = ?, name = ?, sql_text = ?, updated_at = ?
      WHERE id = ? AND owner_user_id = ?
    `).run(body.connectionId, body.database, body.name, body.sql, now, request.params.id, request.admin.id);
    await writeAudit(app.db, { action: "database.saved_query_updated", resourceType: "database_connection", resourceId: body.connectionId, summary: `保存查询 ${body.database}/${body.name}`, request });
    return { ok: true, updatedAt: now };
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-saved-queries/:id/access", async (request, reply) => {
    const query = await app.db.prepare("SELECT connection_id FROM database_saved_queries WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as { connection_id: string } | undefined;
    if (!query || !await canAccessConnection(app.db, request.admin!, "database", query.connection_id)) return reply.code(404).send({ error: "NOT_FOUND", message: "保存查询不存在" });
    const accessedAt = new Date().toISOString();
    await app.db.prepare("UPDATE database_saved_queries SET accessed_at = ? WHERE id = ?").run(accessedAt, request.params.id);
    return { ok: true, accessedAt };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-saved-queries/:id", async (request, reply) => {
    const query = await app.db.prepare("SELECT connection_id, database_name, name FROM database_saved_queries WHERE id = ? AND owner_user_id = ?").get(request.params.id, request.admin!.id) as { connection_id: string; database_name: string; name: string } | undefined;
    if (!query || !await canAccessConnection(app.db, request.admin!, "database", query.connection_id)) return reply.code(404).send({ error: "NOT_FOUND", message: "保存查询不存在" });
    await app.db.prepare("DELETE FROM database_saved_queries WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, { action: "database.saved_query_deleted", resourceType: "database_connection", resourceId: query.connection_id, summary: `删除查询 ${query.database_name}/${query.name}`, request });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { connectionId?: string } }>("/api/v1/database-query-favorites", async (request) => {
    const rows = request.query.connectionId
      ? await app.db.prepare("SELECT * FROM database_query_favorites WHERE owner_user_id = ? AND connection_id = ? ORDER BY updated_at DESC").all(request.admin!.id, request.query.connectionId)
      : await app.db.prepare("SELECT * FROM database_query_favorites WHERE owner_user_id = ? ORDER BY updated_at DESC").all(request.admin!.id);
    const visibleRows = await filterAsync(rows as Record<string, unknown>[], (row) => canAccessConnection(app.db, request.admin!, "database", String(row.connection_id)));
    return { items: visibleRows.map((row) => ({ id: row.id, connectionId: row.connection_id, database: row.database_name, name: row.name, sql: row.sql_text, createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.post("/api/v1/database-query-favorites", async (request, reply) => {
    const body = parseBody(favoriteSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const id = randomUUID();
    const now = new Date().toISOString();
    await app.db.prepare("INSERT INTO database_query_favorites (id, owner_user_id, connection_id, database_name, name, sql_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, request.admin.id, body.connectionId, body.database, body.name, body.sql, now, now);
    await writeAudit(app.db, { action: "database.favorite_created", resourceType: "database_connection", resourceId: body.connectionId, summary: `收藏 SQL ${body.name}`, request });
    return reply.code(201).send({ id });
  });

  app.put<{ Params: { id: string } }>("/api/v1/database-query-favorites/:id", async (request, reply) => {
    const body = parseBody(favoriteSchema, request.body, reply);
    if (!body || !request.admin) return;
    if (!await canAccessConnection(app.db, request.admin, "database", body.connectionId)) return reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
    const result = await app.db.prepare("UPDATE database_query_favorites SET connection_id = ?, database_name = ?, name = ?, sql_text = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?").run(body.connectionId, body.database, body.name, body.sql, new Date().toISOString(), request.params.id, request.admin.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "SQL 收藏不存在" });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/database-query-favorites/:id", async (request, reply) => {
    const result = await app.db.prepare("DELETE FROM database_query_favorites WHERE id = ? AND owner_user_id = ?").run(request.params.id, request.admin!.id);
    if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "SQL 收藏不存在" });
    return reply.code(204).send();
  });
}
