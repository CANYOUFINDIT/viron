import type { FastifyInstance } from "fastify";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { canAccessConnection } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { connectDatabase, type DatabaseConnectionClient } from "../database-workbench/connector.js";
import { executionScope } from "../execution-scope.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

export const databasePrivilegeNames = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX",
  "REFERENCES", "CREATE VIEW", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE",
  "CREATE ROUTINE", "ALTER ROUTINE", "CREATE TEMPORARY TABLES", "LOCK TABLES",
] as const;

type DatabasePrivilege = typeof databasePrivilegeNames[number];

export interface ManagedGrantScope {
  database: string;
  privileges: DatabasePrivilege[];
  unmanagedPrivileges: string[];
  grantOption: boolean;
}

type GrantScopeType = "database" | "table" | "procedure" | "function";

interface ParsedGrantScope extends ManagedGrantScope {
  scopeType: GrantScopeType;
  objectName: string;
}

const userBaseSchema = z.object({
  password: z.string().max(4096).default(""),
  plugin: z.string().trim().max(128).regex(/^[A-Za-z0-9_$-]*$/).default(""),
  requireSsl: z.boolean().default(false),
  passwordExpire: z.enum(["default", "never", "interval"]).default("default"),
  passwordExpireDays: z.number().int().min(1).max(65535).default(90),
  maxQueries: z.number().int().min(0).max(4_294_967_295).default(0),
  maxUpdates: z.number().int().min(0).max(4_294_967_295).default(0),
  maxConnections: z.number().int().min(0).max(4_294_967_295).default(0),
  maxUserConnections: z.number().int().min(0).max(4_294_967_295).default(0),
});

const createUserSchema = userBaseSchema.extend({
  user: z.string().trim().min(1).max(128),
  host: z.string().trim().min(1).max(255).default("%"),
});

const updateUserSchema = userBaseSchema.extend({
  updatePassword: z.boolean().default(false),
});

const privilegeSchema = z.object({
  user: z.string().trim().min(1).max(128),
  host: z.string().trim().min(1).max(255),
  scopeType: z.enum(["database", "table", "procedure", "function"]).default("database"),
  database: z.string().trim().max(255).default(""),
  objectName: z.string().trim().max(255).default(""),
  privileges: z.array(z.enum(databasePrivilegeNames)).max(databasePrivilegeNames.length),
  grantOption: z.boolean().default(false),
});

function account(connection: DatabaseConnectionClient, user: string, host: string): string {
  return `${connection.escape(user)}@${connection.escape(host)}`;
}

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function errorMessage(error: unknown): string {
  const value = error as { sqlMessage?: string; message?: string };
  return value.sqlMessage || value.message || String(error);
}

function splitSqlList(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (character === "`" || character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function decodeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "*") return "*";
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) return trimmed.slice(1, -1).replaceAll("``", "`");
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replaceAll('""', '"');
  return trimmed;
}

function parseGrantScope(value: string): { scopeType: GrantScopeType; database: string; objectName: string } | null {
  const routine = value.trim().match(/^(PROCEDURE|FUNCTION)\s+(\*|`(?:``|[^`])*`|'(?:''|[^'])*'|"(?:""|[^"])*"|[^.]+)\.(\*|`(?:``|[^`])*`|'(?:''|[^'])*'|"(?:""|[^"])*"|.+)$/i);
  if (routine) return { scopeType: routine[1].toLowerCase() as "procedure" | "function", database: decodeIdentifier(routine[2]), objectName: decodeIdentifier(routine[3]) };
  const match = value.trim().match(/^(\*|`(?:``|[^`])*`|'(?:''|[^'])*'|"(?:""|[^"])*"|[^.]+)\.\*$/);
  if (match) {
    const database = decodeIdentifier(match[1]);
    return { scopeType: "database", database: database === "*" ? "" : database, objectName: "" };
  }
  const object = value.trim().match(/^(\*|`(?:``|[^`])*`|'(?:''|[^'])*'|"(?:""|[^"])*"|[^.]+)\.(\*|`(?:``|[^`])*`|'(?:''|[^'])*'|"(?:""|[^"])*"|.+)$/);
  if (!object) return null;
  return { scopeType: "table", database: decodeIdentifier(object[1]), objectName: decodeIdentifier(object[2]) };
}

export function parseManagedGrantScopes(grants: string[]): ManagedGrantScope[] {
  const managed = new Set<string>(databasePrivilegeNames);
  const scopes = new Map<string, { privileges: Set<DatabasePrivilege>; unmanagedPrivileges: Set<string>; grantOption: boolean }>();
  for (const grant of grants) {
    const match = grant.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
    if (!match) continue;
    const scope = parseGrantScope(match[2]);
    if (!scope || scope.scopeType !== "database") continue;
    const database = scope.database;
    const current = scopes.get(database) ?? { privileges: new Set<DatabasePrivilege>(), unmanagedPrivileges: new Set<string>(), grantOption: false };
    const rawPrivileges = splitSqlList(match[1]);
    if (rawPrivileges.some((value) => /^ALL(?:\s+PRIVILEGES)?$/i.test(value))) {
      databasePrivilegeNames.forEach((value) => current.privileges.add(value));
    } else {
      for (const value of rawPrivileges) {
        const normalized = value.trim().toUpperCase();
        if (normalized === "USAGE") continue;
        if (managed.has(normalized)) current.privileges.add(normalized as DatabasePrivilege);
        else current.unmanagedPrivileges.add(value.trim());
      }
    }
    current.grantOption ||= /\sWITH\s+GRANT\s+OPTION(?:\s|$)/i.test(grant);
    scopes.set(database, current);
  }
  return [...scopes.entries()].map(([database, value]) => ({
    database,
    privileges: databasePrivilegeNames.filter((privilege) => value.privileges.has(privilege)),
    unmanagedPrivileges: [...value.unmanagedPrivileges],
    grantOption: value.grantOption,
  }));
}

function managedGrantForScope(grants: string[], requested: { scopeType: GrantScopeType; database: string; objectName: string }): ParsedGrantScope {
  const managed = new Set<string>(databasePrivilegeNames);
  const privileges = new Set<DatabasePrivilege>();
  const unmanagedPrivileges = new Set<string>();
  let grantOption = false;
  for (const grant of grants) {
    const match = grant.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
    if (!match) continue;
    const scope = parseGrantScope(match[2]);
    if (!scope || scope.scopeType !== requested.scopeType || scope.database !== requested.database || scope.objectName !== requested.objectName) continue;
    const rawPrivileges = splitSqlList(match[1]);
    if (rawPrivileges.some((value) => /^ALL(?:\s+PRIVILEGES)?$/i.test(value))) databasePrivilegeNames.forEach((value) => privileges.add(value));
    else for (const value of rawPrivileges) {
      const normalized = value.trim().toUpperCase();
      if (normalized === "USAGE") continue;
      if (managed.has(normalized)) privileges.add(normalized as DatabasePrivilege);
      else unmanagedPrivileges.add(value.trim());
    }
    grantOption ||= /\sWITH\s+GRANT\s+OPTION(?:\s|$)/i.test(grant);
  }
  return {
    ...requested,
    privileges: databasePrivilegeNames.filter((privilege) => privileges.has(privilege)),
    unmanagedPrivileges: [...unmanagedPrivileges],
    grantOption,
  };
}

function privilegeScopeSql(scopeType: GrantScopeType, database: string, objectName: string): string {
  if (scopeType === "database") return database ? `${identifier(database)}.*` : "*.*";
  if (!database || !objectName) throw new Error("对象权限缺少数据库或对象名称");
  const object = `${identifier(database)}.${identifier(objectName)}`;
  return scopeType === "table" ? object : `${scopeType.toUpperCase()} ${object}`;
}

export function buildPrivilegeUpdateStatements(input: {
  identity: string;
  scopeType?: GrantScopeType;
  database: string;
  objectName?: string;
  current?: Pick<ManagedGrantScope, "privileges" | "grantOption">;
  privileges: DatabasePrivilege[];
  grantOption: boolean;
}): string[] {
  const currentPrivileges = new Set(input.current?.privileges ?? []);
  const desiredPrivileges = new Set(input.privileges);
  const removed = databasePrivilegeNames.filter((privilege) => currentPrivileges.has(privilege) && !desiredPrivileges.has(privilege));
  const added = databasePrivilegeNames.filter((privilege) => desiredPrivileges.has(privilege) && !currentPrivileges.has(privilege));
  const scope = privilegeScopeSql(input.scopeType ?? "database", input.database, input.objectName ?? "");
  const statements: string[] = [];
  if (removed.length) statements.push(`REVOKE ${removed.join(", ")} ON ${scope} FROM ${input.identity}`);
  if (input.current?.grantOption && !input.grantOption) statements.push(`REVOKE GRANT OPTION ON ${scope} FROM ${input.identity}`);
  if (added.length || (input.grantOption && !input.current?.grantOption)) {
    const privileges = input.grantOption ? input.privileges : added;
    if (privileges.length) statements.push(`GRANT ${privileges.join(", ")} ON ${scope} TO ${input.identity}${input.grantOption ? " WITH GRANT OPTION" : ""}`);
  }
  return statements;
}

export function userAuthenticationClause(engine: "mysql" | "mariadb", plugin: string, passwordSql: string): string {
  if (!plugin) return `IDENTIFIED BY ${passwordSql}`;
  return engine === "mariadb"
    ? `IDENTIFIED VIA ${identifier(plugin)} USING PASSWORD(${passwordSql})`
    : `IDENTIFIED WITH ${identifier(plugin)} BY ${passwordSql}`;
}

function userOptions(body: z.infer<typeof userBaseSchema>): string[] {
  const clauses = [
    body.requireSsl ? "REQUIRE SSL" : "REQUIRE NONE",
    `WITH MAX_QUERIES_PER_HOUR ${body.maxQueries} MAX_UPDATES_PER_HOUR ${body.maxUpdates} MAX_CONNECTIONS_PER_HOUR ${body.maxConnections} MAX_USER_CONNECTIONS ${body.maxUserConnections}`,
  ];
  if (body.passwordExpire === "never") clauses.push("PASSWORD EXPIRE NEVER");
  else if (body.passwordExpire === "interval") clauses.push(`PASSWORD EXPIRE INTERVAL ${body.passwordExpireDays} DAY`);
  else clauses.push("PASSWORD EXPIRE DEFAULT");
  return clauses;
}

async function listUsers(app: FastifyInstance, connectionId: string) {
  const connected = await connectDatabase(app, connectionId);
  try {
    const [rows] = await connected.connection.query<RowDataPacket[]>(`
      SELECT User AS user, Host AS host, plugin,
        COALESCE(password_expired, 'N') AS passwordExpired,
        COALESCE(max_questions, 0) AS maxQueries,
        COALESCE(max_updates, 0) AS maxUpdates,
        COALESCE(max_connections, 0) AS maxConnections,
        COALESCE(max_user_connections, 0) AS maxUserConnections,
        COALESCE(ssl_type, '') AS sslType, COALESCE(ssl_cipher, '') AS sslCipher,
        COALESCE(x509_issuer, '') AS issuer, COALESCE(x509_subject, '') AS subject
      FROM mysql.user ORDER BY User, Host
    `);
    return rows.map((row) => ({
      user: String(row.user), host: String(row.host), plugin: String(row.plugin ?? ""),
      passwordExpired: String(row.passwordExpired ?? "N") === "Y",
      maxQueries: Number(row.maxQueries ?? 0), maxUpdates: Number(row.maxUpdates ?? 0),
      maxConnections: Number(row.maxConnections ?? 0), maxUserConnections: Number(row.maxUserConnections ?? 0),
      sslType: String(row.sslType ?? ""), sslCipher: String(row.sslCipher ?? ""),
      issuer: String(row.issuer ?? ""), subject: String(row.subject ?? ""),
    }));
  } finally {
    await connected.close();
  }
}

export async function registerDatabaseAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);
  app.addHook("preHandler", async (request, reply) => {
    const connectionId = (request.params as { id?: string }).id;
    if (!connectionId || await canAccessConnection(app.db, request.admin!, "database", connectionId)) return;
    await reply.code(404).send({ error: "NOT_FOUND", message: "数据库连接不存在" });
  });

  app.get<{ Params: { id: string } }>("/api/v1/database-connections/:id/users", async (request, reply) => {
    try {
      return { items: await listUsers(app, request.params.id) };
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_USERS_FAILED", message: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { user?: string; host?: string } }>("/api/v1/database-connections/:id/user-grants", async (request, reply) => {
    if (!request.query.user || !request.query.host) return reply.code(400).send({ error: "INVALID_DATABASE_USER", message: "请选择数据库用户" });
    const connected = await connectDatabase(app, request.params.id);
    try {
      const [rows] = await connected.connection.query<RowDataPacket[]>(`SHOW GRANTS FOR ${account(connected.connection, request.query.user, request.query.host)}`);
      const grants = rows.flatMap((row) => Object.values(row).map(String));
      return { grants, scopes: parseManagedGrantScopes(grants) };
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_USER_GRANTS_FAILED", message: errorMessage(error) });
    } finally {
      await connected.close();
    }
  });

  app.get<{ Params: { id: string }; Querystring: { user?: string; host?: string; scopeType?: GrantScopeType; database?: string; objectName?: string } }>("/api/v1/database-connections/:id/user-object-privileges", async (request, reply) => {
    if (!request.query.user || !request.query.host || !request.query.database || !request.query.objectName || !request.query.scopeType || request.query.scopeType === "database") {
      return reply.code(400).send({ error: "INVALID_DATABASE_OBJECT_PRIVILEGE", message: "请选择数据库用户和对象" });
    }
    const connected = await connectDatabase(app, request.params.id);
    try {
      const [rows] = await connected.connection.query<RowDataPacket[]>(`SHOW GRANTS FOR ${account(connected.connection, request.query.user, request.query.host)}`);
      const grants = rows.flatMap((row) => Object.values(row).map(String));
      return { grant: managedGrantForScope(grants, { scopeType: request.query.scopeType, database: request.query.database, objectName: request.query.objectName }), grants };
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_OBJECT_PRIVILEGES_FAILED", message: errorMessage(error) });
    } finally {
      await connected.close();
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/users", async (request, reply) => {
    const body = parseBody(createUserSchema, request.body, reply);
    if (!body) return;
    const connected = await connectDatabase(app, request.params.id);
    try {
      const identity = account(connected.connection, body.user, body.host);
      const auth = userAuthenticationClause(connected.record.engine, body.plugin, connected.connection.escape(body.password));
      await connected.connection.query(`CREATE USER ${identity} ${auth} ${userOptions(body).join(" ")}`);
      await writeAudit(app.db, { action: "database.user_created", resourceType: "database_connection", resourceId: request.params.id, summary: `新建数据库用户 ${body.user}@${body.host}`, request });
      return reply.code(201).send({ ok: true });
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_USER_CREATE_FAILED", message: errorMessage(error) });
    } finally {
      await connected.close();
    }
  });

  app.put<{ Params: { id: string }; Querystring: { user?: string; host?: string } }>("/api/v1/database-connections/:id/users", async (request, reply) => {
    const body = parseBody(updateUserSchema, request.body, reply);
    if (!body || !request.query.user || !request.query.host) return reply.code(400).send({ error: "INVALID_DATABASE_USER", message: "请选择数据库用户" });
    const connected = await connectDatabase(app, request.params.id);
    try {
      const identity = account(connected.connection, request.query.user, request.query.host);
      const auth = body.updatePassword
        ? userAuthenticationClause(connected.record.engine, body.plugin, connected.connection.escape(body.password))
        : "";
      await connected.connection.query(`ALTER USER ${identity} ${auth} ${userOptions(body).join(" ")}`);
      await writeAudit(app.db, { action: "database.user_updated", resourceType: "database_connection", resourceId: request.params.id, summary: `编辑数据库用户 ${request.query.user}@${request.query.host}`, request });
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_USER_UPDATE_FAILED", message: errorMessage(error) });
    } finally {
      await connected.close();
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/database-connections/:id/user-privileges", async (request, reply) => {
    const body = parseBody(privilegeSchema, request.body, reply);
    if (!body) return;
    const connected = await connectDatabase(app, request.params.id);
    try {
      const identity = account(connected.connection, body.user, body.host);
      const [rows] = await connected.connection.query<RowDataPacket[]>(`SHOW GRANTS FOR ${identity}`);
      const current = body.scopeType === "database"
        ? parseManagedGrantScopes(rows.flatMap((row) => Object.values(row).map(String))).find((scope) => scope.database === body.database)
        : managedGrantForScope(rows.flatMap((row) => Object.values(row).map(String)), { scopeType: body.scopeType, database: body.database, objectName: body.objectName });
      const statements = buildPrivilegeUpdateStatements({ identity, scopeType: body.scopeType, database: body.database, objectName: body.objectName, current, privileges: body.privileges, grantOption: body.grantOption });
      for (const statement of statements) await connected.connection.query(statement);
      await writeAudit(app.db, { action: "database.user_privileges_updated", resourceType: "database_connection", resourceId: request.params.id, summary: `更新数据库用户权限 ${body.user}@${body.host}`, details: { scopeType: body.scopeType, database: body.database, objectName: body.objectName, privileges: body.privileges, grantOption: body.grantOption, statements: statements.length }, request });
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_USER_PRIVILEGES_FAILED", message: errorMessage(error) });
    } finally {
      await connected.close();
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { user?: string; host?: string } }>("/api/v1/database-connections/:id/users", async (request, reply) => {
    if (!request.query.user || !request.query.host) return reply.code(400).send({ error: "INVALID_DATABASE_USER", message: "请选择数据库用户" });
    const connected = await connectDatabase(app, request.params.id);
    try {
      await connected.connection.query(`DROP USER ${account(connected.connection, request.query.user, request.query.host)}`);
      await writeAudit(app.db, { action: "database.user_deleted", resourceType: "database_connection", resourceId: request.params.id, summary: `删除数据库用户 ${request.query.user}@${request.query.host}`, request });
      return reply.code(204).send();
    } catch (error) {
      return reply.code(502).send({ error: "DATABASE_USER_DELETE_FAILED", message: errorMessage(error) });
    } finally {
      await connected.close();
    }
  });
}
