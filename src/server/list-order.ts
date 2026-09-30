import type { EnvmanDatabase } from "./database-client.js";
import { nextManualSortOrder } from "../shared/tab-order.js";

type WorkspaceKey = readonly [string, string];

function sshGroupFilter(connectionGroupId: string | null): { sql: string; params: unknown[] } {
  if (connectionGroupId) return { sql: "connection_group_id = ?", params: [connectionGroupId] };
  return { sql: "connection_group_id IS NULL", params: [] };
}

export async function nextSshConnectionSortOrder(
  db: EnvmanDatabase,
  workspace: WorkspaceKey,
  connectionGroupId: string | null,
  excludeId?: string,
): Promise<number> {
  const group = sshGroupFilter(connectionGroupId);
  const params = [...workspace, ...group.params];
  const excludeSql = excludeId ? " AND id <> ?" : "";
  if (excludeId) params.push(excludeId);
  const rows = await db.prepare(`
    SELECT sort_order FROM ssh_connections
    WHERE workspace_type = ? AND workspace_id = ? AND ${group.sql}${excludeSql}
  `).all<{ sort_order: number | string }>(...params);
  return nextManualSortOrder(rows.map((row) => Number(row.sort_order)));
}

export async function orderedSshConnectionIds(
  db: EnvmanDatabase,
  workspace: WorkspaceKey,
  connectionGroupId: string | null,
): Promise<string[]> {
  const group = sshGroupFilter(connectionGroupId);
  const rows = await db.prepare(`
    SELECT id FROM ssh_connections
    WHERE workspace_type = ? AND workspace_id = ? AND ${group.sql}
    ORDER BY sort_order ASC, updated_at DESC, name ASC, id ASC
  `).all<{ id: string }>(...workspace, ...group.params);
  return rows.map((row) => row.id);
}

export async function nextEnvironmentLogSortOrder(db: EnvmanDatabase, environmentId: string): Promise<number> {
  const rows = await db.prepare("SELECT sort_order FROM environment_logs WHERE environment_id = ?")
    .all<{ sort_order: number | string }>(environmentId);
  return nextManualSortOrder(rows.map((row) => Number(row.sort_order)));
}
