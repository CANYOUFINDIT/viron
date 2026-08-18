import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { canAccessEnvironment, canManageWorkspace, getWorkspaceAccess, workspaceParams, workspaceWhere } from "../access-control.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";
import { revokeWorkspaceRuntime } from "../user-runtime.js";

const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1d8a74"),
});

const environmentSchema = z.object({
  groupId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  shortName: z.string().trim().max(12).default(""),
  description: z.string().trim().max(2000).default(""),
  status: z.enum(["active", "maintenance", "error", "disabled"]).default("active"),
  owner: z.string().trim().max(120).default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

const groupOrderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).max(1000).refine((ids) => new Set(ids).size === ids.length, "环境组不能重复"),
});

const environmentOrderSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    groupId: z.string().uuid().nullable(),
  })).max(1000).refine((items) => new Set(items.map((item) => item.id)).size === items.length, "环境不能重复"),
});

const environmentPreferenceSchema = z.object({
  alias: z.string().trim().max(120).optional(),
  favorite: z.boolean().optional(),
}).refine((preference) => preference.alias !== undefined || preference.favorite !== undefined, "至少需要提供一项环境偏好");

function mapEnvironment(row: Record<string, unknown>) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    name: row.name,
    alias: row.alias_name ?? "",
    favorite: Boolean(Number(row.is_favorite ?? 0)),
    shortName: row.short_name,
    description: row.description,
    status: row.status,
    owner: row.owner,
    tags: JSON.parse(String(row.tags_json ?? "[]")),
    webCount: Number(row.web_count ?? 0),
    sshCount: Number(row.ssh_count ?? 0),
    databaseCount: Number(row.database_count ?? 0),
    redisCount: Number(row.redis_count ?? 0),
    logCount: Number(row.log_count ?? 0),
    knowledgeDocumentCount: Number(row.knowledge_document_count ?? 0),
    serviceCount: Number(row.service_count ?? 0),
    monitorHostCount: Number(row.monitor_host_count ?? 0),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireWorkspaceManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "当前工作空间只有管理员可以修改资源" });
  return false;
}

function addIdFilter(filters: string[], params: unknown[], column: string, ids: Set<string>): void {
  if (!ids.size) filters.push("1 = 0");
  else {
    filters.push(`${column} IN (${[...ids].map(() => "?").join(",")})`);
    params.push(...ids);
  }
}

async function applyKnowledgeDocumentCounts(app: FastifyInstance, rows: Record<string, unknown>[]): Promise<void> {
  const environmentIds = rows.map((row) => String(row.id));
  if (!environmentIds.length) return;
  const placeholders = environmentIds.map(() => "?").join(",");
  const counts = await app.db.prepare(`
    WITH RECURSIVE effective_knowledge_nodes(node_id, environment_id) AS (
      SELECT ke.node_id, ke.environment_id
      FROM knowledge_node_environments ke
      WHERE ke.environment_id IN (${placeholders})
      UNION
      SELECT child.id, effective.environment_id
      FROM effective_knowledge_nodes effective
      JOIN knowledge_nodes parent ON parent.id = effective.node_id AND parent.type = 'folder'
      JOIN knowledge_nodes child ON child.parent_id = parent.id
    )
    SELECT effective.environment_id, COUNT(DISTINCT effective.node_id) AS document_count
    FROM effective_knowledge_nodes effective
    JOIN knowledge_nodes node ON node.id = effective.node_id AND node.type = 'document'
    GROUP BY effective.environment_id
  `).all(...environmentIds) as Array<{ environment_id: string; document_count: number | string }>;
  const countByEnvironment = new Map(counts.map((count) => [count.environment_id, Number(count.document_count)]));
  for (const row of rows) row.knowledge_document_count = countByEnvironment.get(String(row.id)) ?? 0;
}

export async function registerEnvironmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/api/v1/")) await requireAdmin(request, reply);
  });

  app.get("/api/v1/dashboard", async (request) => {
    const access = await getWorkspaceAccess(app.db, request.admin!);
    if (!access.canManage) {
      const unassignedSsh = (await Promise.all([...access.sshConnectionIds].map(async (id) => !await app.db.prepare("SELECT 1 FROM ssh_connection_environments WHERE connection_id = ?").get(id)))).filter(Boolean).length;
      const unassignedDatabase = (await Promise.all([...access.databaseConnectionIds].map(async (id) => !await app.db.prepare("SELECT 1 FROM database_connection_environments WHERE connection_id = ?").get(id)))).filter(Boolean).length;
      const unassignedRedis = (await Promise.all([...access.redisConnectionIds].map(async (id) => !await app.db.prepare("SELECT 1 FROM redis_connection_environments WHERE connection_id = ?").get(id)))).filter(Boolean).length;
      const errors = (await Promise.all([...access.environmentIds].map(async (id) => Boolean(await app.db.prepare("SELECT 1 FROM environments WHERE id = ? AND status = 'error'").get(id))))).filter(Boolean).length;
      return { counts: { environments: access.environmentIds.size, ssh_connections: access.sshConnectionIds.size, database_connections: access.databaseConnectionIds.size, redis_connections: access.redisConnectionIds.size, unassigned: unassignedSsh + unassignedDatabase + unassignedRedis, errors } };
    }
    const workspace = workspaceParams(request);
    const counts = await app.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM environments WHERE ${workspaceWhere()}) AS environments,
        (SELECT COUNT(*) FROM ssh_connections WHERE ${workspaceWhere()}) AS ssh_connections,
        (SELECT COUNT(*) FROM database_connections WHERE ${workspaceWhere()}) AS database_connections,
        (SELECT COUNT(*) FROM redis_connections WHERE ${workspaceWhere()}) AS redis_connections,
        (SELECT COUNT(*) FROM ssh_connections s WHERE ${workspaceWhere("s")} AND NOT EXISTS (SELECT 1 FROM ssh_connection_environments se WHERE se.connection_id = s.id)) +
          (SELECT COUNT(*) FROM database_connections d WHERE ${workspaceWhere("d")} AND NOT EXISTS (SELECT 1 FROM database_connection_environments de WHERE de.connection_id = d.id)) +
          (SELECT COUNT(*) FROM redis_connections r WHERE ${workspaceWhere("r")} AND NOT EXISTS (SELECT 1 FROM redis_connection_environments re WHERE re.connection_id = r.id)) AS unassigned,
        (SELECT COUNT(*) FROM environments WHERE ${workspaceWhere()} AND status = 'error') AS errors
    `).get(...workspace, ...workspace, ...workspace, ...workspace, ...workspace, ...workspace, ...workspace, ...workspace);
    return { counts };
  });

  app.get("/api/v1/environment-groups", async (request) => {
    const access = await getWorkspaceAccess(app.db, request.admin!);
    const groupRows = await app.db.prepare(`
      SELECT g.*, COUNT(e.id) AS environment_count
      FROM environment_groups g
      LEFT JOIN environments e ON e.group_id = g.id
      WHERE ${workspaceWhere("g")}
      GROUP BY g.id
      ORDER BY g.sort_order, g.name
    `).all(...workspaceParams(request)) as Record<string, unknown>[];
    const visibleRows = groupRows.filter((row) => access.canManage || access.environmentGroupIds.has(String(row.id)));
    const rows = await Promise.all(visibleRows.map(async (item) => {
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        color: item.color,
        environmentCount: access.canManage
          ? Number(item.environment_count)
          : (await Promise.all([...access.environmentIds].map(async (id) => Boolean(await app.db.prepare("SELECT 1 FROM environments WHERE id = ? AND group_id = ?").get(id, item.id))))).filter(Boolean).length,
      };
    }));
    return { items: rows };
  });

  app.post("/api/v1/environment-groups", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(groupSchema, request.body, reply);
    if (!body) return;
    const id = randomUUID();
    const now = new Date().toISOString();
    const nextOrder = await app.db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
      FROM environment_groups WHERE ${workspaceWhere()}
    `).get(...workspaceParams(request)) as { next_sort_order: number | string };
    try {
      await app.db.prepare(`
        INSERT INTO environment_groups (id, workspace_type, workspace_id, name, description, color, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, ...workspaceParams(request), body.name, body.description, body.color, Number(nextOrder.next_sort_order), now, now);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: "DUPLICATE_GROUP", message: "环境组名称已存在" });
      }
      throw error;
    }
    await writeAudit(app.db, {
      action: "environment_group.created",
      resourceType: "environment_group",
      resourceId: id,
      summary: `创建环境组 ${body.name}`,
      request,
    });
    return reply.code(201).send({ id });
  });

  app.put("/api/v1/environment-groups/order", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(groupOrderSchema, request.body, reply);
    if (!body) return;
    const rows = await app.db.prepare(`SELECT id FROM environment_groups WHERE ${workspaceWhere()}`).all(...workspaceParams(request)) as Array<{ id: string }>;
    const currentIds = new Set(rows.map((row) => row.id));
    if (body.orderedIds.length !== currentIds.size || body.orderedIds.some((id) => !currentIds.has(id))) {
      return reply.code(400).send({ error: "INVALID_GROUP_ORDER", message: "环境组排序必须包含当前工作空间的全部环境组" });
    }
    await app.db.transaction(async () => {
      for (const [index, id] of body.orderedIds.entries()) {
        await app.db.prepare(`UPDATE environment_groups SET sort_order = ? WHERE id = ? AND ${workspaceWhere()}`)
          .run(index, id, ...workspaceParams(request));
      }
    })();
    await writeAudit(app.db, {
      action: "environment_group.reordered",
      resourceType: "environment_group",
      summary: "调整环境组顺序",
      details: { orderedIds: body.orderedIds },
      request,
    });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/v1/environment-groups/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(groupSchema, request.body, reply);
    if (!body) return;
    try {
      const result = await app.db.prepare(`UPDATE environment_groups SET name = ?, description = ?, color = ?, updated_at = ? WHERE id = ? AND ${workspaceWhere()}`)
        .run(body.name, body.description, body.color, new Date().toISOString(), request.params.id, ...workspaceParams(request));
      if (!result.changes) return reply.code(404).send({ error: "NOT_FOUND", message: "环境组不存在" });
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "DUPLICATE_GROUP", message: "环境组名称已存在" });
      throw error;
    }
    await writeAudit(app.db, { action: "environment_group.updated", resourceType: "environment_group", resourceId: request.params.id, summary: `更新环境组 ${body.name}`, request });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/environment-groups/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const group = await app.db.prepare(`SELECT name FROM environment_groups WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as
      | { name: string }
      | undefined;
    if (!group) return reply.code(404).send({ error: "NOT_FOUND", message: "环境组不存在" });
    await app.db.prepare(`DELETE FROM environment_groups WHERE id = ? AND ${workspaceWhere()}`).run(request.params.id, ...workspaceParams(request));
    await app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'environment_group' AND resource_id = ?").run(request.params.id);
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "environment_group.deleted",
      resourceType: "environment_group",
      resourceId: request.params.id,
      summary: `删除环境组 ${group.name}`,
      request,
    });
    return reply.code(204).send();
  });

  app.get<{ Querystring: { q?: string; status?: string; groupId?: string } }>(
    "/api/v1/environments",
    async (request) => {
      const filters: string[] = [workspaceWhere("e")];
      const params: unknown[] = [...workspaceParams(request)];
      const access = await getWorkspaceAccess(app.db, request.admin!);
      if (!access.canManage) addIdFilter(filters, params, "e.id", access.environmentIds);
      if (request.query.q?.trim()) {
        filters.push("(e.name LIKE ? OR pref.alias_name LIKE ? OR e.owner LIKE ? OR e.tags_json LIKE ?)");
        const q = `%${request.query.q.trim()}%`;
        params.push(q, q, q, q);
      }
      if (request.query.status) {
        filters.push("e.status = ?");
        params.push(request.query.status);
      }
      if (request.query.groupId === "ungrouped") {
        filters.push("e.group_id IS NULL");
      } else if (request.query.groupId) {
        filters.push("e.group_id = ?");
        params.push(request.query.groupId);
      }
      const where = `WHERE ${filters.join(" AND ")}`;
      const rows = await app.db.prepare(`
        SELECT e.*, g.name AS group_name, pref.alias_name, pref.is_favorite,
          (SELECT COUNT(*) FROM web_entries w WHERE w.environment_id = e.id) AS web_count,
          (SELECT COUNT(*) FROM ssh_connection_environments s WHERE s.environment_id = e.id) AS ssh_count,
          (SELECT COUNT(*) FROM database_connection_environments d WHERE d.environment_id = e.id) AS database_count,
          (SELECT COUNT(*) FROM redis_connection_environments r WHERE r.environment_id = e.id) AS redis_count,
          (SELECT COUNT(*) FROM environment_logs l WHERE l.environment_id = e.id) AS log_count,
          (SELECT COUNT(*) FROM services sv WHERE sv.environment_id = e.id) AS service_count,
          (SELECT COUNT(DISTINCT NULLIF(mh.agent_id, ''))
              + COUNT(DISTINCT CASE WHEN NULLIF(mh.agent_id, '') IS NULL AND mh.install_managed = 1 THEN mh.ssh_connection_id END)
            FROM ssh_connection_environments sm
            JOIN monitor_hosts mh ON mh.ssh_connection_id = sm.connection_id
            WHERE sm.environment_id = e.id AND (NULLIF(mh.agent_id, '') IS NOT NULL OR mh.install_managed = 1)) AS monitor_host_count,
          (SELECT COUNT(*) FROM knowledge_nodes k WHERE k.environment_id = e.id AND k.type = 'document') AS knowledge_document_count
        FROM environments e
        LEFT JOIN environment_groups g ON g.id = e.group_id
        LEFT JOIN environment_preferences pref ON pref.environment_id = e.id AND pref.owner_user_id = ?
        ${where}
        ORDER BY CASE WHEN e.group_id IS NULL THEN 1 ELSE 0 END, g.sort_order, g.name, e.sort_order, e.name
      `).all(request.admin!.id, ...params) as Record<string, unknown>[];
      await applyKnowledgeDocumentCounts(app, rows);
      return { items: rows.map(mapEnvironment) };
    },
  );

  app.put<{ Params: { id: string } }>("/api/v1/environments/:id/preferences", async (request, reply) => {
    const body = parseBody(environmentPreferenceSchema, request.body, reply);
    if (!body) return;
    if (body.alias !== undefined && request.admin!.workspace.type !== "organization") {
      return reply.code(400).send({ error: "ORGANIZATION_WORKSPACE_REQUIRED", message: "环境别称仅适用于组织工作空间" });
    }
    if (!await canAccessEnvironment(app.db, request.admin!, request.params.id)) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
    }
    const current = await app.db.prepare("SELECT alias_name, is_favorite FROM environment_preferences WHERE owner_user_id = ? AND environment_id = ?")
      .get(request.admin!.id, request.params.id) as { alias_name: string; is_favorite: number | boolean } | undefined;
    const alias = body.alias ?? current?.alias_name ?? "";
    const favorite = body.favorite ?? Boolean(Number(current?.is_favorite ?? 0));
    if (!alias && !favorite) {
      await app.db.prepare("DELETE FROM environment_preferences WHERE owner_user_id = ? AND environment_id = ?")
        .run(request.admin!.id, request.params.id);
    } else {
      const now = new Date().toISOString();
      if (current) {
        await app.db.prepare("UPDATE environment_preferences SET alias_name = ?, is_favorite = ?, updated_at = ? WHERE owner_user_id = ? AND environment_id = ?")
          .run(alias, favorite ? 1 : 0, now, request.admin!.id, request.params.id);
      } else {
        await app.db.prepare("INSERT INTO environment_preferences (owner_user_id, environment_id, alias_name, is_favorite, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(request.admin!.id, request.params.id, alias, favorite ? 1 : 0, now);
      }
    }
    return {
      ...(body.alias !== undefined ? { alias } : {}),
      ...(body.favorite !== undefined ? { favorite } : {}),
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/environments/:id", async (request, reply) => {
    if (!await canAccessEnvironment(app.db, request.admin!, request.params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
    const row = await app.db.prepare(`
      SELECT e.*, g.name AS group_name, pref.is_favorite,
        (SELECT COUNT(*) FROM web_entries w WHERE w.environment_id = e.id) AS web_count,
        (SELECT COUNT(*) FROM ssh_connection_environments s WHERE s.environment_id = e.id) AS ssh_count,
        (SELECT COUNT(*) FROM database_connection_environments d WHERE d.environment_id = e.id) AS database_count,
        (SELECT COUNT(*) FROM redis_connection_environments r WHERE r.environment_id = e.id) AS redis_count,
        (SELECT COUNT(*) FROM environment_logs l WHERE l.environment_id = e.id) AS log_count,
        (SELECT COUNT(*) FROM services sv WHERE sv.environment_id = e.id) AS service_count,
        (SELECT COUNT(DISTINCT NULLIF(mh.agent_id, ''))
            + COUNT(DISTINCT CASE WHEN NULLIF(mh.agent_id, '') IS NULL AND mh.install_managed = 1 THEN mh.ssh_connection_id END)
          FROM ssh_connection_environments sm
          JOIN monitor_hosts mh ON mh.ssh_connection_id = sm.connection_id
          WHERE sm.environment_id = e.id AND (NULLIF(mh.agent_id, '') IS NOT NULL OR mh.install_managed = 1)) AS monitor_host_count,
        (SELECT COUNT(*) FROM knowledge_nodes k WHERE k.environment_id = e.id AND k.type = 'document') AS knowledge_document_count
      FROM environments e
      LEFT JOIN environment_groups g ON g.id = e.group_id
      LEFT JOIN environment_preferences pref ON pref.environment_id = e.id AND pref.owner_user_id = ?
      WHERE e.id = ?
    `).get(request.admin!.id, request.params.id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
    await applyKnowledgeDocumentCounts(app, [row]);
    return { item: mapEnvironment(row) };
  });

  app.post("/api/v1/environments", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(environmentSchema, request.body, reply);
    if (!body) return;
    if (body.groupId && !await app.db.prepare(`SELECT 1 FROM environment_groups WHERE id = ? AND ${workspaceWhere()}`).get(body.groupId, ...workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_GROUP", message: "环境组不属于当前工作空间" });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const groupFilter = body.groupId ? "group_id = ?" : "group_id IS NULL";
    const nextOrder = await app.db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
      FROM environments WHERE ${workspaceWhere()} AND ${groupFilter}
    `).get(...workspaceParams(request), ...(body.groupId ? [body.groupId] : [])) as { next_sort_order: number | string };
    await app.db.prepare(`
      INSERT INTO environments (
        id, workspace_type, workspace_id, group_id, sort_order, name, short_name, description, status, owner, tags_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      ...workspaceParams(request),
      body.groupId ?? null,
      Number(nextOrder.next_sort_order),
      body.name,
      body.shortName,
      body.description,
      body.status,
      body.owner,
      JSON.stringify(body.tags),
      now,
      now,
    );
    await writeAudit(app.db, {
      action: "environment.created",
      resourceType: "environment",
      resourceId: id,
      summary: `创建环境 ${body.name}`,
      request,
    });
    return reply.code(201).send({ id });
  });

  app.put("/api/v1/environments/order", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(environmentOrderSchema, request.body, reply);
    if (!body) return;
    const [environmentRows, groupRows] = await Promise.all([
      app.db.prepare(`SELECT id, group_id FROM environments WHERE ${workspaceWhere()}`).all(...workspaceParams(request)) as Promise<Array<{ id: string; group_id: string | null }>>,
      app.db.prepare(`SELECT id FROM environment_groups WHERE ${workspaceWhere()}`).all(...workspaceParams(request)) as Promise<Array<{ id: string }>>,
    ]);
    const environmentsById = new Map(environmentRows.map((row) => [row.id, row]));
    const groupIds = new Set(groupRows.map((row) => row.id));
    if (body.items.length !== environmentsById.size || body.items.some((item) => !environmentsById.has(item.id))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT_ORDER", message: "环境排序必须包含当前工作空间的全部环境" });
    }
    if (body.items.some((item) => item.groupId && !groupIds.has(item.groupId))) {
      return reply.code(400).send({ error: "INVALID_GROUP", message: "环境组不属于当前工作空间" });
    }

    const nextOrderByGroup = new Map<string | null, number>();
    const movedBetweenGroups = body.items.filter((item) => environmentsById.get(item.id)?.group_id !== item.groupId).length;
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      for (const item of body.items) {
        const sortOrder = nextOrderByGroup.get(item.groupId) ?? 0;
        nextOrderByGroup.set(item.groupId, sortOrder + 1);
        if (environmentsById.get(item.id)?.group_id !== item.groupId) {
          await app.db.prepare(`UPDATE environments SET group_id = ?, sort_order = ?, updated_at = ? WHERE id = ? AND ${workspaceWhere()}`)
            .run(item.groupId, sortOrder, now, item.id, ...workspaceParams(request));
        } else {
          await app.db.prepare(`UPDATE environments SET sort_order = ? WHERE id = ? AND ${workspaceWhere()}`)
            .run(sortOrder, item.id, ...workspaceParams(request));
        }
      }
    })();
    if (movedBetweenGroups) await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "environment.reordered",
      resourceType: "environment",
      summary: movedBetweenGroups ? "调整环境顺序与分组" : "调整环境顺序",
      details: { environmentCount: body.items.length, movedBetweenGroups },
      request,
    });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/v1/environments/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const body = parseBody(environmentSchema, request.body, reply);
    if (!body) return;
    const existing = await app.db.prepare(`SELECT group_id, sort_order FROM environments WHERE id = ? AND ${workspaceWhere()}`)
      .get(request.params.id, ...workspaceParams(request)) as { group_id: string | null; sort_order: number | string } | undefined;
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
    if (body.groupId && !await app.db.prepare(`SELECT 1 FROM environment_groups WHERE id = ? AND ${workspaceWhere()}`).get(body.groupId, ...workspaceParams(request))) {
      return reply.code(400).send({ error: "INVALID_GROUP", message: "环境组不属于当前工作空间" });
    }
    let sortOrder = Number(existing.sort_order);
    if (existing.group_id !== (body.groupId ?? null)) {
      const groupFilter = body.groupId ? "group_id = ?" : "group_id IS NULL";
      const nextOrder = await app.db.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
        FROM environments WHERE ${workspaceWhere()} AND ${groupFilter}
      `).get(...workspaceParams(request), ...(body.groupId ? [body.groupId] : [])) as { next_sort_order: number | string };
      sortOrder = Number(nextOrder.next_sort_order);
    }
    await app.db.prepare(`
      UPDATE environments
      SET group_id = ?, sort_order = ?, name = ?, short_name = ?, description = ?, status = ?, owner = ?, tags_json = ?, updated_at = ?
      WHERE id = ? AND ${workspaceWhere()}
    `).run(
      body.groupId ?? null,
      sortOrder,
      body.name,
      body.shortName,
      body.description,
      body.status,
      body.owner,
      JSON.stringify(body.tags),
      new Date().toISOString(),
      request.params.id,
      ...workspaceParams(request),
    );
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "environment.updated",
      resourceType: "environment",
      resourceId: request.params.id,
      summary: `更新环境 ${body.name}`,
      request,
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/environments/:id", async (request, reply) => {
    if (!requireWorkspaceManager(request, reply)) return;
    const environment = await app.db.prepare(`SELECT name FROM environments WHERE id = ? AND ${workspaceWhere()}`).get(request.params.id, ...workspaceParams(request)) as
      | { name: string }
      | undefined;
    if (!environment) return reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
    const credentials = await app.db.prepare(`
      SELECT c.id FROM web_credentials c
      JOIN web_entries w ON w.id = c.web_entry_id
      WHERE w.environment_id = ?
    `).all(request.params.id) as Array<{ id: string }>;
    await Promise.all(credentials.map((credential) => app.webAccountViews.purgeCredential(credential.id)));
    await app.db.transaction(async () => {
      await app.db.prepare("DELETE FROM environments WHERE id = ?").run(request.params.id);
      await app.db.prepare(`
        UPDATE ssh_connections SET environment_id = (
          SELECT environment_id FROM ssh_connection_environments ce WHERE ce.connection_id = ssh_connections.id ORDER BY environment_id LIMIT 1
        ) WHERE environment_id IS NULL AND ${workspaceWhere()};
      `).run(...workspaceParams(request));
      await app.db.prepare(`
        UPDATE database_connections SET environment_id = (
          SELECT environment_id FROM database_connection_environments ce WHERE ce.connection_id = database_connections.id ORDER BY environment_id LIMIT 1
        ) WHERE environment_id IS NULL AND ${workspaceWhere()};
      `).run(...workspaceParams(request));
      await app.db.prepare(`
        UPDATE redis_connections SET environment_id = (
          SELECT environment_id FROM redis_connection_environments ce WHERE ce.connection_id = redis_connections.id ORDER BY environment_id LIMIT 1
        ) WHERE environment_id IS NULL AND ${workspaceWhere()};
      `).run(...workspaceParams(request));
      await app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'environment' AND resource_id = ?").run(request.params.id);
    })();
    await revokeWorkspaceRuntime(app, request.admin!.workspace);
    await writeAudit(app.db, {
      action: "environment.deleted",
      resourceType: "environment",
      resourceId: request.params.id,
      summary: `删除环境 ${environment.name}`,
      request,
    });
    return reply.code(204).send();
  });
}
