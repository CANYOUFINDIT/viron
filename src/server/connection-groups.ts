import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WorkspaceType } from "./access-control.js";

export type ConnectionType = "ssh" | "database" | "redis";

export function normalizeGroupPath(parts: string[]): string[] {
  return parts
    .flatMap((part) => part.split(/[\\/]+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function ensureConnectionGroup(app: FastifyInstance, type: ConnectionType, rawPath: string[], workspace: [WorkspaceType, string]): Promise<string | null> {
  const parts = normalizeGroupPath(rawPath);
  if (!parts.length) return null;
  let parentId: string | null = null;
  let path = "";
  const now = new Date().toISOString();
  for (const name of parts) {
    path = path ? `${path}/${name}` : name;
    const existing = await app.db.prepare("SELECT id FROM connection_groups WHERE type = ? AND path = ? AND workspace_type = ? AND workspace_id = ?").get(type, path, ...workspace) as { id: string } | undefined;
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const id = randomUUID();
    await app.db.prepare(`
      INSERT INTO connection_groups (id, workspace_type, workspace_id, type, parent_id, name, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, ...workspace, type, parentId, name, path, now, now);
    parentId = id;
  }
  return parentId;
}

export async function connectionGroupExists(app: FastifyInstance, id: string | null | undefined, type: ConnectionType, workspace: [WorkspaceType, string]): Promise<boolean> {
  if (!id) return true;
  return Boolean(await app.db.prepare("SELECT id FROM connection_groups WHERE id = ? AND type = ? AND workspace_type = ? AND workspace_id = ?").get(id, type, ...workspace));
}

export async function resolveConnectionGroupId(
  app: FastifyInstance,
  type: ConnectionType,
  environmentId: string | null | undefined,
  requestedGroupId: string | null | undefined,
  workspace: [WorkspaceType, string],
  existingGroupId: string | null = null,
): Promise<string | null> {
  if (requestedGroupId) return requestedGroupId;
  if (requestedGroupId === undefined && existingGroupId) return existingGroupId;
  if (!environmentId) return requestedGroupId === undefined ? existingGroupId : null;
  const environmentGroup = await app.db.prepare(`
    SELECT g.name
    FROM environments e
    JOIN environment_groups g ON g.id = e.group_id
    WHERE e.id = ?
  `).get(environmentId) as { name: string } | undefined;
  return environmentGroup ? await ensureConnectionGroup(app, type, [environmentGroup.name], workspace) : null;
}
