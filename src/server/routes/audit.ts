import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./auth.js";
import { canManageWorkspace } from "../access-control.js";
import { auditLikePattern, auditRetentionCutoff, parseAuditListQuery, type AuditListQuery } from "../audit-query.js";

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: AuditListQuery }>(
    "/api/v1/audit-events",
    { preHandler: requireAdmin },
    async (request) => {
      const query = parseAuditListQuery(request.query);
      const manager = canManageWorkspace(request);
      const filters = ["e.workspace_type = ?", "e.workspace_id = ?", "e.created_at >= ?"];
      const values: unknown[] = [request.admin!.workspace.type, request.admin!.workspace.id, auditRetentionCutoff(app.config.auditRetentionDays)];
      if (!manager) { filters.push("e.actor_user_id = ?"); values.push(request.admin!.id); }
      if (query.actorUserId) { filters.push("e.actor_user_id = ?"); values.push(query.actorUserId); }
      if (query.source) { filters.push("e.source = ?"); values.push(query.source); }
      if (query.keyword) {
        filters.push("(e.summary LIKE ? ESCAPE '!' OR e.action LIKE ? ESCAPE '!' OR e.resource_type LIKE ? ESCAPE '!')");
        const pattern = auditLikePattern(query.keyword);
        values.push(pattern, pattern, pattern);
      }
      const where = `WHERE ${filters.join(" AND ")}`;
      const items = (await app.db.prepare(`
        SELECT e.id, e.actor_user_id, u.username AS actor_username, e.source, e.action, e.resource_type,
          e.resource_id, e.summary, e.details_json, e.ip_address, e.created_at
        FROM audit_events e
        LEFT JOIN admin_users u ON u.id = e.actor_user_id
        ${where}
        ORDER BY e.created_at DESC
        LIMIT ? OFFSET ?
      `).all(...values, query.pageSize + 1, query.offset)).map((row) => {
        const item = row as Record<string, unknown>;
        return {
          id: item.id,
          actor: item.actor_user_id && item.actor_username
            ? { id: item.actor_user_id, username: item.actor_username }
            : null,
          source: item.source,
          action: item.action,
          resourceType: item.resource_type,
          resourceId: item.resource_id,
          summary: item.summary,
          details: JSON.parse(String(item.details_json ?? "{}")),
          ipAddress: item.ip_address,
          createdAt: item.created_at,
        };
      });
      const hasMore = items.length > query.pageSize;
      if (hasMore) items.pop();
      return { items, page: query.page, pageSize: query.pageSize, hasMore, retentionDays: app.config.auditRetentionDays };
    },
  );

  app.get("/api/v1/audit-actors", { preHandler: requireAdmin }, async (request) => {
    const user = request.admin!;
    if (user.workspace.type !== "organization" || !canManageWorkspace(request)) {
      return { items: [{ id: request.admin!.id, username: request.admin!.username }] };
    }
    const cutoff = auditRetentionCutoff(app.config.auditRetentionDays);
    const rows = await app.db.prepare(`
      SELECT DISTINCT u.id, u.username
      FROM admin_users u
      JOIN (
        SELECT user_id FROM organization_members WHERE organization_id = ?
        UNION
        SELECT actor_user_id AS user_id FROM audit_events
        WHERE workspace_type = 'organization' AND workspace_id = ? AND created_at >= ?
        UNION
        SELECT r.owner_user_id AS user_id FROM ssh_terminal_recordings r
        JOIN ssh_connections c ON c.id = r.connection_id
        WHERE c.workspace_type = 'organization' AND c.workspace_id = ? AND r.started_at >= ?
        UNION
        SELECT h.owner_user_id AS user_id FROM database_query_history h
        JOIN database_connections c ON c.id = h.connection_id
        WHERE c.workspace_type = 'organization' AND c.workspace_id = ? AND h.created_at >= ?
      ) actors ON actors.user_id = u.id
      ORDER BY u.username COLLATE NOCASE
    `).all(user.workspace.id, user.workspace.id, cutoff, user.workspace.id, cutoff, user.workspace.id, cutoff) as Array<{ id: string; username: string }>;
    return { items: rows };
  });
}
