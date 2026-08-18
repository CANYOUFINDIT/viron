import type { EnvmanDatabase } from "./database.js";
import type { WorkspaceType } from "./access-control.js";

export type EnvironmentConnectionType = "ssh" | "database" | "redis";

export interface ConnectionEnvironment {
  id: string;
  name: string;
}

const tables = {
  ssh: {
    connections: "ssh_connections",
    environments: "ssh_connection_environments",
  },
  database: {
    connections: "database_connections",
    environments: "database_connection_environments",
  },
  redis: {
    connections: "redis_connections",
    environments: "redis_connection_environments",
  },
} as const;

export function normalizeEnvironmentIds(environmentIds: string[] | undefined, environmentId?: string | null): string[] {
  return [...new Set(environmentIds ?? (environmentId ? [environmentId] : []))];
}

export async function environmentsExist(db: EnvmanDatabase, environmentIds: string[], workspace: [WorkspaceType, string]): Promise<boolean> {
  if (!environmentIds.length) return true;
  const placeholders = environmentIds.map(() => "?").join(",");
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM environments WHERE id IN (${placeholders}) AND workspace_type = ? AND workspace_id = ?`).get(...environmentIds, ...workspace) as { count: number };
  return Number(row.count) === environmentIds.length;
}

export async function replaceConnectionEnvironments(
  db: EnvmanDatabase,
  type: EnvironmentConnectionType,
  connectionId: string,
  environmentIds: string[],
): Promise<boolean> {
  const table = tables[type];
  const existing = await db.prepare(`SELECT id FROM ${table.connections} WHERE id = ?`).get(connectionId);
  if (!existing) return false;
  const existingSshOrders = type === "ssh"
    ? await db.prepare("SELECT environment_id, maintenance_sort_order FROM ssh_connection_environments WHERE connection_id = ?").all(connectionId) as Array<{ environment_id: string; maintenance_sort_order: number | string }>
    : [];
  const sshOrderByEnvironment = new Map(existingSshOrders.map((item) => [item.environment_id, Number(item.maintenance_sort_order)]));
  await db.prepare(`DELETE FROM ${table.environments} WHERE connection_id = ?`).run(connectionId);
  for (const environmentId of environmentIds) {
    if (type === "ssh") {
      const existingOrder = sshOrderByEnvironment.get(environmentId);
      const nextOrder = existingOrder ?? Number((await db.prepare(`
        SELECT COALESCE(MAX(maintenance_sort_order), -1) + 1 AS next_sort_order
        FROM ssh_connection_environments WHERE environment_id = ?
      `).get(environmentId) as { next_sort_order: number | string }).next_sort_order);
      await db.prepare("INSERT INTO ssh_connection_environments (connection_id, environment_id, maintenance_sort_order) VALUES (?, ?, ?)")
        .run(connectionId, environmentId, nextOrder);
    } else {
      await db.prepare(`INSERT INTO ${table.environments} (connection_id, environment_id) VALUES (?, ?)`).run(connectionId, environmentId);
    }
  }
  await db.prepare(`UPDATE ${table.connections} SET environment_id = ? WHERE id = ?`).run(environmentIds[0] ?? null, connectionId);
  return true;
}

export async function addConnectionEnvironment(
  db: EnvmanDatabase,
  type: EnvironmentConnectionType,
  connectionId: string,
  environmentId: string | null,
): Promise<void> {
  if (!environmentId) return;
  const table = tables[type];
  if (type === "ssh") {
    const nextOrder = await db.prepare(`
      SELECT COALESCE(MAX(maintenance_sort_order), -1) + 1 AS next_sort_order
      FROM ssh_connection_environments WHERE environment_id = ?
    `).get(environmentId) as { next_sort_order: number | string };
    await db.prepare("INSERT OR IGNORE INTO ssh_connection_environments (connection_id, environment_id, maintenance_sort_order) VALUES (?, ?, ?)")
      .run(connectionId, environmentId, Number(nextOrder.next_sort_order));
  } else {
    await db.prepare(`INSERT OR IGNORE INTO ${table.environments} (connection_id, environment_id) VALUES (?, ?)`).run(connectionId, environmentId);
  }
  await db.prepare(`UPDATE ${table.connections} SET environment_id = COALESCE(environment_id, ?) WHERE id = ?`).run(environmentId, connectionId);
}

export async function connectionEnvironmentMap(db: EnvmanDatabase, type: EnvironmentConnectionType, workspace: [WorkspaceType, string]): Promise<Map<string, ConnectionEnvironment[]>> {
  const rows = await db.prepare(`
    SELECT ce.connection_id, e.id, e.name
    FROM ${tables[type].environments} ce
    JOIN environments e ON e.id = ce.environment_id
    WHERE e.workspace_type = ? AND e.workspace_id = ?
    ORDER BY e.name, e.id
  `).all(...workspace) as Array<{ connection_id: string; id: string; name: string }>;
  const result = new Map<string, ConnectionEnvironment[]>();
  for (const row of rows) result.set(row.connection_id, [...(result.get(row.connection_id) ?? []), { id: row.id, name: row.name }]);
  return result;
}
