import { randomUUID } from "node:crypto";
import { basename, dirname, extname, posix } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import yauzl from "yauzl";
import yazl from "yazl";
import { z } from "zod";
import { canAccessEnvironment, canManageWorkspace, getWorkspaceAccess, type AuthenticatedUser } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { isUniqueConstraintError } from "../database-errors.js";
import { parseBody } from "../validation.js";
import { requireAdmin } from "./auth.js";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 2_000;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const KNOWLEDGE_ASSET_SCHEME = "knowledge-asset://";
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const ALLOWED_IMAGE_MIMES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));

const createNodeSchema = z.object({
  type: z.enum(["folder", "document"]),
  name: z.string().trim().min(1).max(160),
  parentId: z.string().uuid().nullable().default(null),
});
const updateNodeSchema = z.object({
  name: z.string().trim().min(1).max(160),
  parentId: z.string().uuid().nullable(),
});
const saveContentSchema = z.object({
  content: z.string().max(MAX_DOCUMENT_BYTES),
  revision: z.number().int().positive(),
});
const grantSchema = z.object({
  granteeType: z.enum(["user", "project"]),
  granteeId: z.string().uuid(),
});
const environmentTagsSchema = z.object({
  add: z.array(z.string().uuid()).max(100).default([]),
  remove: z.array(z.string().uuid()).max(100).default([]),
});
const associateDocumentsSchema = z.object({
  nodeIds: z.array(z.string().uuid()).min(1).max(100),
});

type KnowledgeNodeType = "folder" | "document";
type KnowledgeNodeRow = {
  id: string;
  workspace_type: "personal" | "organization";
  workspace_id: string;
  environment_id: string | null;
  parent_id: string | null;
  type: KnowledgeNodeType;
  name: string;
  content: string;
  revision: number | string;
  created_by_user_id: string | null;
  created_by_username?: string | null;
  created_at: string;
  updated_at: string;
};
type KnowledgeAssetRow = {
  id: string;
  document_id: string;
  filename: string;
  mime_type: string;
  data_base64: string;
  size_bytes: number | string;
  created_at: string;
};
type ImportedFile = { path: string; content: Buffer | null; directory: boolean };
type EnvironmentTag = { id: string; name: string };
type KnowledgeContext = {
  allRows: KnowledgeNodeRow[];
  rows: KnowledgeNodeRow[];
  permissions: Awaited<ReturnType<typeof permissionsForNodes>>;
  environments: EnvironmentTag[];
  directEnvironmentIds: Map<string, Set<string>>;
  effectiveEnvironmentIds: Map<string, Set<string>>;
  contextOnlyIds: Set<string>;
  environmentRootId: string | null;
};

function normalizeNodeName(type: KnowledgeNodeType, rawName: string): string {
  let name = rawName.trim();
  if (!name || name === "." || name === ".." || /[\0\r\n/\\]/.test(name)) throw new Error("名称不能包含路径分隔符或控制字符");
  if (type === "document") name = name.replace(/\.md$/i, "") + ".md";
  if (name.length > 160) throw new Error("名称不能超过 160 个字符");
  return name;
}

function safeArchiveName(name: string): string {
  return name.replace(/[\0\r\n/\\]/g, "-").trim() || "未命名";
}

function publicAsset(asset: KnowledgeAssetRow, includeData = true) {
  const metadata = {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mime_type,
    sizeBytes: Number(asset.size_bytes),
    createdAt: asset.created_at,
  };
  return includeData ? {
    ...metadata,
    dataBase64: asset.data_base64,
    dataUrl: `data:${asset.mime_type};base64,${asset.data_base64}`,
  } : metadata;
}

async function workspaceNodeRows(app: FastifyInstance, user: AuthenticatedUser): Promise<KnowledgeNodeRow[]> {
  return app.db.prepare(`
    SELECT n.*, u.username AS created_by_username
    FROM knowledge_nodes n
    LEFT JOIN admin_users u ON u.id = n.created_by_user_id
    WHERE n.workspace_type = ? AND n.workspace_id = ?
    ORDER BY n.type, n.name COLLATE NOCASE
  `).all(user.workspace.type, user.workspace.id) as Promise<KnowledgeNodeRow[]>;
}

async function nodeById(app: FastifyInstance, nodeId: string): Promise<KnowledgeNodeRow | undefined> {
  return app.db.prepare(`
    SELECT n.*, u.username AS created_by_username
    FROM knowledge_nodes n
    LEFT JOIN admin_users u ON u.id = n.created_by_user_id
    WHERE n.id = ?
  `).get(nodeId) as Promise<KnowledgeNodeRow | undefined>;
}

function nodeBelongsToWorkspace(node: KnowledgeNodeRow | undefined, user: AuthenticatedUser): node is KnowledgeNodeRow {
  return Boolean(node && node.workspace_type === user.workspace.type && node.workspace_id === user.workspace.id);
}

async function accessibleEnvironments(app: FastifyInstance, user: AuthenticatedUser): Promise<EnvironmentTag[]> {
  const rows = await app.db.prepare(`
    SELECT id, name FROM environments
    WHERE workspace_type = ? AND workspace_id = ?
    ORDER BY name COLLATE NOCASE, id
  `).all(user.workspace.type, user.workspace.id) as EnvironmentTag[];
  const access = await getWorkspaceAccess(app.db, user);
  return access.canManage ? rows : rows.filter((environment) => access.environmentIds.has(environment.id));
}

async function effectiveProjectIds(app: FastifyInstance, organizationId: string, userId: string): Promise<Set<string>> {
  const rows = await app.db.prepare(`
    SELECT p.id, p.parent_id, CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END AS is_member
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    WHERE p.organization_id = ?
  `).all(userId, organizationId) as Array<{ id: string; parent_id: string | null; is_member: number | string }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = new Set<string>();
  for (const row of rows) {
    if (!Number(row.is_member)) continue;
    let current: typeof row | undefined = row;
    while (current && !result.has(current.id)) {
      result.add(current.id);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
  }
  return result;
}

async function grantedNodeIds(app: FastifyInstance, user: AuthenticatedUser, organizationId: string): Promise<Set<string>> {
  const projectIds = await effectiveProjectIds(app, organizationId, user.id);
  const filters = ["(g.grantee_type = 'user' AND g.grantee_id = ?)"];
  const params: unknown[] = [organizationId, user.id];
  if (projectIds.size) {
    filters.push(`(g.grantee_type = 'project' AND g.grantee_id IN (${[...projectIds].map(() => "?").join(",")}))`);
    params.push(...projectIds);
  }
  const rows = await app.db.prepare(`
    SELECT g.node_id FROM knowledge_node_grants g
    WHERE g.organization_id = ? AND (${filters.join(" OR ")})
  `).all(...params) as Array<{ node_id: string }>;
  return new Set(rows.map((row) => row.node_id));
}

function hasGrantedAncestor(node: KnowledgeNodeRow, byId: Map<string, KnowledgeNodeRow>, grants: Set<string>): boolean {
  let current: KnowledgeNodeRow | undefined = node;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (grants.has(current.id)) return true;
    visited.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return false;
}

async function permissionsForNodes(app: FastifyInstance, user: AuthenticatedUser, rows: KnowledgeNodeRow[]) {
  const canManage = user.workspace.role === "owner" || user.workspace.role === "admin";
  const organizationId = user.workspace.type === "organization" ? user.workspace.id : null;
  const grants = !canManage && organizationId ? await grantedNodeIds(app, user, organizationId) : new Set<string>();
  const byId = new Map(rows.map((node) => [node.id, node]));
  return {
    canManage,
    byId,
    canEdit(node: KnowledgeNodeRow) {
      return canManage
        || (node.type === "document" && node.created_by_user_id === user.id)
        || hasGrantedAncestor(node, byId, grants);
    },
  };
}

async function knowledgeContext(app: FastifyInstance, user: AuthenticatedUser, environmentId?: string): Promise<KnowledgeContext> {
  const allRows = await workspaceNodeRows(app, user);
  const permissions = await permissionsForNodes(app, user, allRows);
  const environments = await accessibleEnvironments(app, user);
  const associations = allRows.length
    ? await app.db.prepare(`
      SELECT ke.node_id, ke.environment_id
      FROM knowledge_node_environments ke
      JOIN environments e ON e.id = ke.environment_id
      WHERE e.workspace_type = ? AND e.workspace_id = ?
    `).all(user.workspace.type, user.workspace.id) as Array<{ node_id: string; environment_id: string }>
    : [];
  const directEnvironmentIds = new Map<string, Set<string>>();
  for (const association of associations) {
    const ids = directEnvironmentIds.get(association.node_id) ?? new Set<string>();
    ids.add(association.environment_id);
    directEnvironmentIds.set(association.node_id, ids);
  }
  const effectiveEnvironmentIds = new Map<string, Set<string>>();
  const effectiveFor = (node: KnowledgeNodeRow, visiting = new Set<string>()): Set<string> => {
    const cached = effectiveEnvironmentIds.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id)) return new Set(directEnvironmentIds.get(node.id) ?? []);
    visiting.add(node.id);
    const result = new Set(directEnvironmentIds.get(node.id) ?? []);
    const parent = node.parent_id ? permissions.byId.get(node.parent_id) : undefined;
    if (parent?.type === "folder") for (const id of effectiveFor(parent, visiting)) result.add(id);
    visiting.delete(node.id);
    effectiveEnvironmentIds.set(node.id, result);
    return result;
  };
  for (const row of allRows) effectiveFor(row);

  const contextOnlyIds = new Set<string>();
  if (!environmentId) {
    return { allRows, rows: allRows, permissions, environments, directEnvironmentIds, effectiveEnvironmentIds, contextOnlyIds, environmentRootId: null };
  }
  const environment = environments.find((item) => item.id === environmentId);
  const legacyRootCandidates = allRows.filter((row) => row.type === "folder"
    && row.parent_id === null
    && directEnvironmentIds.get(row.id)?.has(environmentId));
  const environmentRoot = allRows.find((row) => row.type === "folder"
    && row.parent_id === null
    && row.environment_id === environmentId)
    ?? legacyRootCandidates.find((row) => row.created_by_user_id === null
      && (row.name === environment?.name || row.name.startsWith(`${environment?.name} (`)))
    ?? (legacyRootCandidates.length === 1 && legacyRootCandidates[0].created_by_user_id === null ? legacyRootCandidates[0] : undefined);
  const environmentRootId = environmentRoot?.id ?? null;
  const includedIds = new Set(allRows.filter((row) => effectiveEnvironmentIds.get(row.id)?.has(environmentId)).map((row) => row.id));
  for (const row of allRows) {
    if (!includedIds.has(row.id)) continue;
    let parentId = row.parent_id;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      if (!includedIds.has(parentId)) contextOnlyIds.add(parentId);
      includedIds.add(parentId);
      parentId = permissions.byId.get(parentId)?.parent_id ?? null;
    }
  }
  return {
    allRows,
    rows: allRows.filter((row) => includedIds.has(row.id)),
    permissions,
    environments,
    directEnvironmentIds,
    effectiveEnvironmentIds,
    contextOnlyIds,
    environmentRootId,
  };
}

async function accessibleKnowledge(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, environmentId?: string) {
  if (environmentId && !await canAccessEnvironment(app.db, request.admin!, environmentId)) {
    void reply.code(404).send({ error: "NOT_FOUND", message: "环境不存在" });
    return null;
  }
  return knowledgeContext(app, request.admin!, environmentId);
}

async function editableNode(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, nodeId: string, type?: KnowledgeNodeType) {
  const node = await nodeById(app, nodeId);
  if (!nodeBelongsToWorkspace(node, request.admin!) || (type && node.type !== type)) {
    void reply.code(404).send({ error: "NOT_FOUND", message: type === "document" ? "文档不存在" : "知识库节点不存在" });
    return null;
  }
  const rows = await workspaceNodeRows(app, request.admin!);
  const permissions = await permissionsForNodes(app, request.admin!, rows);
  if (!permissions.canEdit(node)) {
    void reply.code(403).send({ error: "KNOWLEDGE_EDIT_REQUIRED", message: "你没有该内容的编辑权限" });
    return null;
  }
  return { node, rows, permissions };
}

function mapNode(node: KnowledgeNodeRow, context: KnowledgeContext) {
  const visibleEnvironmentIds = new Set(context.environments.map((environment) => environment.id));
  return {
    id: node.id,
    parentId: node.parent_id === context.environmentRootId ? null : node.parent_id,
    storageParentId: node.parent_id,
    type: node.type,
    name: node.name,
    revision: Number(node.revision),
    createdBy: node.created_by_user_id ? { id: node.created_by_user_id, username: node.created_by_username ?? "未知用户" } : null,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
    canEdit: context.permissions.canEdit(node),
    canDelete: context.permissions.canEdit(node),
    canManagePermissions: context.permissions.canManage && node.workspace_type === "organization",
    directEnvironmentIds: [...(context.directEnvironmentIds.get(node.id) ?? [])].filter((id) => visibleEnvironmentIds.has(id)),
    effectiveEnvironmentIds: [...(context.effectiveEnvironmentIds.get(node.id) ?? [])].filter((id) => visibleEnvironmentIds.has(id)),
    isContextOnly: context.contextOnlyIds.has(node.id),
  };
}

async function uniqueNodeName(app: FastifyInstance, user: AuthenticatedUser, parentId: string | null, type: KnowledgeNodeType, requestedName: string) {
  const normalized = normalizeNodeName(type, requestedName);
  const extension = type === "document" ? ".md" : "";
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  for (let sequence = 1; sequence <= 10_000; sequence += 1) {
    const candidate = sequence === 1 ? normalized : `${stem} (${sequence})${extension}`;
    const duplicate = await app.db.prepare(`
      SELECT 1 FROM knowledge_nodes
      WHERE workspace_type = ? AND workspace_id = ? AND parent_key = ? AND name = ? COLLATE NOCASE
    `).get(user.workspace.type, user.workspace.id, parentId ?? "", candidate);
    if (!duplicate) return candidate;
  }
  throw new Error("无法生成不重复的名称");
}

async function ensureEnvironmentRoot(app: FastifyInstance, user: AuthenticatedUser, environmentId: string): Promise<string> {
  const current = await knowledgeContext(app, user, environmentId);
  if (current.environmentRootId) return current.environmentRootId;
  const environment = current.environments.find((item) => item.id === environmentId);
  if (!environment) throw new Error("环境不存在");

  const id = environmentId;
  const now = new Date().toISOString();
  const name = await uniqueNodeName(app, user, null, "folder", environment.name || "未命名环境");
  try {
    await app.db.transaction(async () => {
      await app.db.prepare(`
        INSERT INTO knowledge_nodes (
          id, workspace_type, workspace_id, environment_id, parent_id, parent_key, type, name, content,
          revision, created_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, '', 'folder', ?, '', 1, NULL, ?, ?)
      `).run(id, user.workspace.type, user.workspace.id, environmentId, name, now, now);
      await app.db.prepare(`
        INSERT INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
        VALUES (?, ?, ?, ?)
      `).run(id, environmentId, user.id, now);
    })();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const concurrent = await knowledgeContext(app, user, environmentId);
      if (concurrent.environmentRootId) return concurrent.environmentRootId;
    }
    throw error;
  }
  return id;
}

function descendantIds(rows: KnowledgeNodeRow[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parent_id && ids.has(row.parent_id) && !ids.has(row.id)) {
        ids.add(row.id);
        changed = true;
      }
    }
  }
  return ids;
}

function imageMime(filename: string, declaredMime?: string): string | null {
  const extensionMime = IMAGE_MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? null;
  if (!extensionMime) return null;
  const declared = declaredMime?.toLowerCase();
  if (declared && ALLOWED_IMAGE_MIMES.has(declared) && declared !== extensionMime) return null;
  return extensionMime;
}

function detectedImageMime(content: Buffer): string | null {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 6 && ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function insertAsset(
  app: FastifyInstance,
  documentId: string,
  filename: string,
  mimeType: string,
  content: Buffer,
  creatorId: string,
): Promise<KnowledgeAssetRow> {
  if (content.length > MAX_IMAGE_BYTES) throw new Error("单张图片不能超过 30 MB");
  const requestedMime = imageMime(filename, mimeType);
  const allowedMime = detectedImageMime(content);
  if (!requestedMime || !allowedMime || requestedMime !== allowedMime) throw new Error("仅支持真实的 PNG、JPEG、GIF 和 WebP 图片");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const safeFilename = safeArchiveName(basename(filename)).slice(0, 255);
  await app.db.prepare(`
    INSERT INTO knowledge_assets (id, document_id, filename, mime_type, data_base64, size_bytes, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, documentId, safeFilename, allowedMime, content.toString("base64"), content.length, creatorId, createdAt);
  return { id, document_id: documentId, filename: safeFilename, mime_type: allowedMime, data_base64: content.toString("base64"), size_bytes: content.length, created_at: createdAt };
}

async function assetsForDocument(app: FastifyInstance, documentId: string): Promise<KnowledgeAssetRow[]> {
  return app.db.prepare("SELECT * FROM knowledge_assets WHERE document_id = ? ORDER BY created_at, id").all(documentId) as Promise<KnowledgeAssetRow[]>;
}

async function extractInlineImages(app: FastifyInstance, documentId: string, content: string, creatorId: string): Promise<string> {
  const pattern = /!\[([^\]]*)\]\((data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+))\)/gi;
  let output = "";
  let offset = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    output += content.slice(offset, index);
    const bytes = Buffer.from(match[4].replace(/\s/g, ""), "base64");
    const extension = match[3].toLowerCase() === "image/jpeg" ? "jpg" : match[3].split("/")[1];
    const asset = await insertAsset(app, documentId, `image-${randomUUID().slice(0, 8)}.${extension}`, match[3], bytes, creatorId);
    output += `![${match[1]}](${KNOWLEDGE_ASSET_SCHEME}${asset.id})`;
    offset = index + match[0].length;
  }
  return output + content.slice(offset);
}

function unzipKnowledge(buffer: Buffer): Promise<ImportedFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("无法打开 ZIP 文件"));
      const files: ImportedFile[] = [];
      let totalBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("entry", (entry) => {
        if (settled) return;
        const path = entry.fileName.replace(/\\/g, "/");
        if (path.startsWith("/") || path.split("/").includes("..")) return fail(new Error("ZIP 中包含不安全路径"));
        if (files.length >= MAX_ARCHIVE_FILES) return fail(new Error(`ZIP 文件数量不能超过 ${MAX_ARCHIVE_FILES}`));
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_ARCHIVE_BYTES) return fail(new Error("ZIP 解压后不能超过 512 MB"));
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) return fail(new Error("ZIP 文件压缩比异常"));
        if (path.endsWith("/")) {
          files.push({ path: posix.normalize(path), content: null, directory: true });
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error("无法读取 ZIP 条目"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", fail);
          stream.once("end", () => {
            files.push({ path: posix.normalize(path), content: Buffer.concat(chunks), directory: false });
            zip.readEntry();
          });
        });
      });
      zip.once("error", fail);
      zip.once("end", () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });
      zip.readEntry();
    });
  });
}

function markdownImageMatches(content: string) {
  return [...content.matchAll(/!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)];
}

async function importArchiveDocument(
  app: FastifyInstance,
  documentId: string,
  documentPath: string,
  content: string,
  filesByPath: Map<string, Buffer>,
  creatorId: string,
) {
  let output = "";
  let offset = 0;
  for (const match of markdownImageMatches(content)) {
    const rawUrl = match[2] || match[3] || "";
    if (/^(?:https?:|data:|knowledge-asset:)/i.test(rawUrl)) continue;
    let decoded = rawUrl;
    try { decoded = decodeURIComponent(rawUrl); } catch { /* Keep the original path. */ }
    const resolved = posix.normalize(posix.join(dirname(documentPath), decoded));
    const image = filesByPath.get(resolved);
    const mime = imageMime(resolved);
    if (!image || !mime) continue;
    const asset = await insertAsset(app, documentId, basename(resolved), mime, image, creatorId);
    const index = match.index ?? 0;
    output += content.slice(offset, index);
    output += `![${match[1]}](${KNOWLEDGE_ASSET_SCHEME}${asset.id})`;
    offset = index + match[0].length;
  }
  output += content.slice(offset);
  return extractInlineImages(app, documentId, output, creatorId);
}

async function createNode(
  app: FastifyInstance,
  user: AuthenticatedUser,
  parentId: string | null,
  type: KnowledgeNodeType,
  requestedName: string,
  creatorId: string,
  environmentId?: string,
  content = "",
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const name = await uniqueNodeName(app, user, parentId, type, requestedName);
  await app.db.prepare(`
    INSERT INTO knowledge_nodes (
      id, workspace_type, workspace_id, environment_id, parent_id, parent_key, type, name, content,
      revision, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, user.workspace.type, user.workspace.id, parentId, parentId ?? "", type, name, content, creatorId, now, now);
  if (environmentId) {
    try {
      await app.db.prepare(`
        INSERT INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
        VALUES (?, ?, ?, ?)
      `).run(id, environmentId, creatorId, now);
    } catch (error) {
      await app.db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(id);
      throw error;
    }
  }
  return { id, name, now };
}

function replaceAssetReferencesWithDataUris(content: string, assets: KnowledgeAssetRow[]) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return content.replace(/knowledge-asset:\/\/([0-9a-f-]{36})/gi, (match, id: string) => {
    const asset = byId.get(id);
    return asset ? `data:${asset.mime_type};base64,${asset.data_base64}` : match;
  });
}

async function zipForNodes(app: FastifyInstance, rows: KnowledgeNodeRow[], rootPrefix = "") {
  const zip = new yazl.ZipFile();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pathById = new Map<string, string>();
  const nodePath = (node: KnowledgeNodeRow): string => {
    const cached = pathById.get(node.id);
    if (cached) return cached;
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    const path = posix.join(parent ? nodePath(parent) : rootPrefix, safeArchiveName(node.name));
    pathById.set(node.id, path);
    return path;
  };
  for (const folder of rows.filter((row) => row.type === "folder")) zip.addEmptyDirectory(`${nodePath(folder)}/`);
  for (const document of rows.filter((row) => row.type === "document")) {
    const assets = await assetsForDocument(app, document.id);
    let content = document.content;
    const usedNames = new Set<string>();
    for (const asset of assets) {
      const original = safeArchiveName(asset.filename);
      const extension = extname(original);
      const stem = extension ? original.slice(0, -extension.length) : original;
      let filename = original;
      let sequence = 2;
      while (usedNames.has(filename.toLocaleLowerCase())) filename = `${stem} (${sequence++})${extension}`;
      usedNames.add(filename.toLocaleLowerCase());
      const documentDirectory = dirname(nodePath(document));
      const assetPath = posix.join(documentDirectory, "assets", basename(document.name, ".md"), filename);
      const relativePath = posix.relative(documentDirectory, assetPath);
      content = content.replaceAll(`${KNOWLEDGE_ASSET_SCHEME}${asset.id}`, encodeURI(relativePath));
      zip.addBuffer(Buffer.from(asset.data_base64, "base64"), assetPath, { mode: 0o600 });
    }
    zip.addBuffer(Buffer.from(content, "utf8"), nodePath(document), { mode: 0o600 });
  }
  zip.end();
  return zip;
}

function sendDownload(reply: FastifyReply, contentType: string, filename: string, payload: Buffer | NodeJS.ReadableStream) {
  reply.header("Content-Type", contentType);
  reply.header("Content-Disposition", `attachment; filename="knowledge-export${extname(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return reply.send(payload);
}

async function requireKnowledgeManager(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, node: KnowledgeNodeRow) {
  if (!nodeBelongsToWorkspace(node, request.admin!)) {
    void reply.code(404).send({ error: "NOT_FOUND", message: "知识库节点不存在" });
    return null;
  }
  if (node.workspace_type !== "organization" || !canManageWorkspace(request)) {
    void reply.code(403).send({ error: "ORGANIZATION_ADMIN_REQUIRED", message: "只有组织管理员可以管理知识库授权" });
    return null;
  }
  return { workspace_id: node.workspace_id };
}

function knowledgeResponse(context: KnowledgeContext) {
  return {
    items: context.rows.filter((node) => node.id !== context.environmentRootId).map((node) => mapNode(node, context)),
    environments: context.environments,
    canManage: context.permissions.canManage,
    canCreateDocument: true,
    canCreateRootFolder: context.permissions.canManage,
    imageLimitBytes: MAX_IMAGE_BYTES,
    environmentRootId: context.environmentRootId,
  };
}

async function createKnowledgeNode(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  environmentId?: string,
) {
  let context = await accessibleKnowledge(app, request, reply, environmentId);
  if (!context) return;
  const body = parseBody(createNodeSchema, request.body, reply);
  if (!body) return;
  if (environmentId && !context.environmentRootId) {
    await ensureEnvironmentRoot(app, request.admin!, environmentId);
    context = await knowledgeContext(app, request.admin!, environmentId);
  }
  const visibleIds = new Set(context.rows.map((node) => node.id));
  const parentId = body.parentId ?? context.environmentRootId;
  const parent = parentId ? context.permissions.byId.get(parentId) : null;
  if (parentId && (!parent || parent.type !== "folder" || !visibleIds.has(parent.id))) {
    return reply.code(400).send({ error: "INVALID_PARENT", message: "目标文件夹不存在" });
  }
  if (body.type === "folder") {
    const canCreateFolder = parent ? context.permissions.canEdit(parent) : context.permissions.canManage;
    if (!canCreateFolder) return reply.code(403).send({ error: "KNOWLEDGE_EDIT_REQUIRED", message: "你没有在此位置创建文件夹的权限" });
  }
  try {
    const created = await createNode(app, request.admin!, parentId, body.type, body.name, request.admin!.id, environmentId);
    await writeAudit(app.db, { action: `knowledge.${body.type}_created`, resourceType: `knowledge_${body.type}`, resourceId: created.id, summary: `创建${body.type === "folder" ? "文件夹" : "文档"} ${created.name}`, request });
    return reply.code(201).send({ id: created.id, name: created.name });
  } catch (error) {
    if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "KNOWLEDGE_NAME_EXISTS", message: "同一文件夹下已存在同名内容" });
    return reply.code(400).send({ error: "INVALID_KNOWLEDGE_NODE", message: error instanceof Error ? error.message : "创建失败" });
  }
}

export async function registerKnowledgeBaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/v1/knowledge", async (request) => knowledgeResponse(await knowledgeContext(app, request.admin!)));

  app.get<{ Params: { environmentId: string } }>("/api/v1/environments/:environmentId/knowledge", async (request, reply) => {
    let result = await accessibleKnowledge(app, request, reply, request.params.environmentId);
    if (!result) return;
    if (!result.environmentRootId) {
      await ensureEnvironmentRoot(app, request.admin!, request.params.environmentId);
      result = await knowledgeContext(app, request.admin!, request.params.environmentId);
    }
    return knowledgeResponse(result);
  });

  app.get<{ Params: { id: string }; Querystring: { includeAssetData?: string } }>("/api/v1/knowledge-documents/:id", async (request, reply) => {
    const node = await nodeById(app, request.params.id);
    if (!nodeBelongsToWorkspace(node, request.admin!) || node.type !== "document") {
      return reply.code(404).send({ error: "NOT_FOUND", message: "文档不存在" });
    }
    const context = await knowledgeContext(app, request.admin!);
    const includeAssetData = request.query.includeAssetData !== "false";
    return {
      item: { ...mapNode(node, context), content: node.content },
      assets: (await assetsForDocument(app, node.id)).map((asset) => publicAsset(asset, includeAssetData)),
    };
  });

  app.post("/api/v1/knowledge/nodes", async (request, reply) => createKnowledgeNode(app, request, reply));

  app.post<{ Params: { environmentId: string } }>("/api/v1/environments/:environmentId/knowledge/nodes", async (request, reply) => {
    return createKnowledgeNode(app, request, reply, request.params.environmentId);
  });

  app.put<{ Params: { id: string } }>("/api/v1/knowledge-nodes/:id", async (request, reply) => {
    const editable = await editableNode(app, request, reply, request.params.id);
    if (!editable) return;
    const body = parseBody(updateNodeSchema, request.body, reply);
    if (!body) return;
    const parent = body.parentId ? editable.permissions.byId.get(body.parentId) : null;
    if (body.parentId && (!parent || parent.type !== "folder")) return reply.code(400).send({ error: "INVALID_PARENT", message: "目标文件夹不存在" });
    if (editable.node.type === "folder") {
      if (body.parentId && descendantIds(editable.rows, editable.node.id).has(body.parentId)) {
        return reply.code(400).send({ error: "KNOWLEDGE_CYCLE", message: "文件夹不能移动到自身或子文件夹中" });
      }
      const canEditTarget = parent ? editable.permissions.canEdit(parent) : editable.permissions.canManage;
      if (!canEditTarget) return reply.code(403).send({ error: "KNOWLEDGE_EDIT_REQUIRED", message: "你没有修改目标文件夹结构的权限" });
    }
    let name: string;
    try { name = normalizeNodeName(editable.node.type, body.name); }
    catch (error) { return reply.code(400).send({ error: "INVALID_NAME", message: (error as Error).message }); }
    const duplicate = await app.db.prepare(`
      SELECT 1 FROM knowledge_nodes
      WHERE workspace_type = ? AND workspace_id = ? AND parent_key = ? AND name = ? COLLATE NOCASE AND id != ?
    `).get(editable.node.workspace_type, editable.node.workspace_id, body.parentId ?? "", name, editable.node.id);
    if (duplicate) return reply.code(409).send({ error: "KNOWLEDGE_NAME_EXISTS", message: "同一文件夹下已存在同名内容" });
    const now = new Date().toISOString();
    try {
      await app.db.prepare(`
        UPDATE knowledge_nodes SET parent_id = ?, parent_key = ?, name = ?, revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(body.parentId, body.parentId ?? "", name, now, editable.node.id);
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "KNOWLEDGE_NAME_EXISTS", message: "同一文件夹下已存在同名内容" });
      throw error;
    }
    await writeAudit(app.db, { action: "knowledge.node_updated", resourceType: `knowledge_${editable.node.type}`, resourceId: editable.node.id, summary: `更新知识库节点 ${name}`, request });
    return { ok: true, name, revision: Number(editable.node.revision) + 1, updatedAt: now };
  });

  app.patch<{ Params: { id: string } }>("/api/v1/knowledge-nodes/:id/environments", async (request, reply) => {
    const editable = await editableNode(app, request, reply, request.params.id);
    if (!editable) return;
    const body = parseBody(environmentTagsSchema, request.body, reply);
    if (!body) return;
    const add = new Set(body.add);
    const remove = new Set(body.remove);
    if ([...add].some((id) => remove.has(id))) {
      return reply.code(400).send({ error: "INVALID_ENVIRONMENT_TAGS", message: "同一环境不能同时关联和取消关联" });
    }
    const changedIds = [...new Set([...add, ...remove])];
    const environments = await accessibleEnvironments(app, request.admin!);
    const accessibleIds = new Set(environments.map((environment) => environment.id));
    if (changedIds.some((id) => !accessibleIds.has(id))) {
      return reply.code(403).send({ error: "ENVIRONMENT_ACCESS_REQUIRED", message: "修改标签需要对应环境的访问权限" });
    }
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      for (const environmentId of remove) {
        await app.db.prepare("DELETE FROM knowledge_node_environments WHERE node_id = ? AND environment_id = ?").run(editable.node.id, environmentId);
      }
      for (const environmentId of add) {
        await app.db.prepare(`
          INSERT OR IGNORE INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
          VALUES (?, ?, ?, ?)
        `).run(editable.node.id, environmentId, request.admin!.id, now);
      }
    })();
    await writeAudit(app.db, {
      action: "knowledge.environment_tags_updated",
      resourceType: `knowledge_${editable.node.type}`,
      resourceId: editable.node.id,
      summary: `更新知识库环境标签 ${editable.node.name}`,
      details: { add: [...add], remove: [...remove] },
      request,
    });
    const directRows = await app.db.prepare("SELECT environment_id FROM knowledge_node_environments WHERE node_id = ? ORDER BY environment_id").all(editable.node.id) as Array<{ environment_id: string }>;
    return { directEnvironmentIds: directRows.map((row) => row.environment_id).filter((id) => accessibleIds.has(id)) };
  });

  app.get<{ Params: { environmentId: string } }>("/api/v1/environments/:environmentId/knowledge/association-candidates", async (request, reply) => {
    const context = await accessibleKnowledge(app, request, reply, request.params.environmentId);
    if (!context) return;
    const pathFor = (node: KnowledgeNodeRow) => {
      const parts = [node.name];
      const visited = new Set([node.id]);
      let parent = node.parent_id ? context.permissions.byId.get(node.parent_id) : undefined;
      while (parent && !visited.has(parent.id)) {
        parts.unshift(parent.name);
        visited.add(parent.id);
        parent = parent.parent_id ? context.permissions.byId.get(parent.parent_id) : undefined;
      }
      return parts.join(" / ");
    };
    const items = context.allRows
      .filter((node) => node.type === "document"
        && context.permissions.canEdit(node)
        && !context.effectiveEnvironmentIds.get(node.id)?.has(request.params.environmentId))
      .map((node) => ({ ...mapNode(node, context), path: pathFor(node) }));
    return { items };
  });

  app.post<{ Params: { environmentId: string } }>("/api/v1/environments/:environmentId/knowledge/associations", async (request, reply) => {
    const context = await accessibleKnowledge(app, request, reply, request.params.environmentId);
    if (!context) return;
    const body = parseBody(associateDocumentsSchema, request.body, reply);
    if (!body) return;
    const uniqueNodeIds = [...new Set(body.nodeIds)];
    const nodes = uniqueNodeIds.map((id) => context.permissions.byId.get(id));
    if (nodes.some((node) => !node || node.type !== "document" || !context.permissions.canEdit(node))) {
      return reply.code(403).send({ error: "KNOWLEDGE_EDIT_REQUIRED", message: "只能关联你有权编辑的文档" });
    }
    if (nodes.some((node) => node && context.effectiveEnvironmentIds.get(node.id)?.has(request.params.environmentId))) {
      return reply.code(409).send({ error: "KNOWLEDGE_ALREADY_VISIBLE", message: "所选文档中包含已在当前环境展示的内容" });
    }
    const now = new Date().toISOString();
    await app.db.transaction(async () => {
      for (const nodeId of uniqueNodeIds) {
        await app.db.prepare(`
          INSERT INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
          VALUES (?, ?, ?, ?)
        `).run(nodeId, request.params.environmentId, request.admin!.id, now);
      }
    })();
    await writeAudit(app.db, {
      action: "knowledge.documents_associated",
      resourceType: "knowledge_base",
      resourceId: request.params.environmentId,
      summary: `关联 ${uniqueNodeIds.length} 篇知识库文档到环境`,
      details: { nodeIds: uniqueNodeIds },
      request,
    });
    return reply.code(201).send({ associated: uniqueNodeIds.length });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/knowledge-nodes/:id", async (request, reply) => {
    const editable = await editableNode(app, request, reply, request.params.id);
    if (!editable) return;
    const deletedIds = descendantIds(editable.rows, editable.node.id);
    const documentCount = editable.rows.filter((row) => deletedIds.has(row.id) && row.type === "document").length;
    const folderCount = editable.rows.filter((row) => deletedIds.has(row.id) && row.type === "folder").length;
    await app.db.prepare("DELETE FROM knowledge_nodes WHERE id = ?").run(editable.node.id);
    await writeAudit(app.db, {
      action: "knowledge.node_deleted",
      resourceType: `knowledge_${editable.node.type}`,
      resourceId: editable.node.id,
      summary: `删除知识库节点 ${editable.node.name}`,
      details: { documentCount, folderCount },
      request,
    });
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string } }>("/api/v1/knowledge-documents/:id/content", { bodyLimit: MAX_DOCUMENT_BYTES + 1024 }, async (request, reply) => {
    const editable = await editableNode(app, request, reply, request.params.id, "document");
    if (!editable) return;
    const body = parseBody(saveContentSchema, request.body, reply);
    if (!body) return;
    if (Number(editable.node.revision) !== body.revision) {
      return reply.code(409).send({ error: "KNOWLEDGE_CONFLICT", message: "文档已被其他用户修改，请重新加载后再保存", revision: Number(editable.node.revision), updatedAt: editable.node.updated_at });
    }
    if (editable.node.content === body.content) return { revision: body.revision, updatedAt: editable.node.updated_at };
    const now = new Date().toISOString();
    const saved = await app.db.prepare(`
      UPDATE knowledge_nodes SET content = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(body.content, now, editable.node.id, body.revision);
    if (!saved.changes) {
      const latest = await nodeById(app, editable.node.id);
      return reply.code(409).send({ error: "KNOWLEDGE_CONFLICT", message: "文档已被其他用户修改，请重新加载后再保存", revision: Number(latest?.revision ?? body.revision), updatedAt: latest?.updated_at });
    }
    return { revision: body.revision + 1, updatedAt: now };
  });

  app.post<{ Params: { id: string } }>("/api/v1/knowledge-documents/:id/assets", async (request, reply) => {
    const editable = await editableNode(app, request, reply, request.params.id, "document");
    if (!editable) return;
    let filename = "";
    let mimeType = "";
    let content: Buffer | null = null;
    try {
      for await (const part of request.parts({ limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 2 } })) {
        if (part.type !== "file") continue;
        filename = part.filename;
        mimeType = part.mimetype;
        content = await part.toBuffer();
      }
    } catch (error) {
      return reply.code(413).send({ error: "IMAGE_TOO_LARGE", message: "单张图片不能超过 30 MB" });
    }
    if (!content || !filename) return reply.code(400).send({ error: "FILE_REQUIRED", message: "请选择图片" });
    try {
      const asset = await insertAsset(app, editable.node.id, filename, mimeType, content, request.admin!.id);
      return reply.code(201).send({ asset: publicAsset(asset), markdown: `![${asset.filename}](${KNOWLEDGE_ASSET_SCHEME}${asset.id})` });
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_IMAGE", message: error instanceof Error ? error.message : "图片上传失败" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/knowledge-assets/:id", async (request, reply) => {
    const asset = await app.db.prepare("SELECT * FROM knowledge_assets WHERE id = ?").get(request.params.id) as KnowledgeAssetRow | undefined;
    if (!asset) return reply.code(404).send({ error: "NOT_FOUND", message: "图片不存在" });
    const editable = await editableNode(app, request, reply, asset.document_id, "document");
    if (!editable) return;
    await app.db.prepare("DELETE FROM knowledge_assets WHERE id = ?").run(asset.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/v1/knowledge-nodes/:id/grants", async (request, reply) => {
    const node = await nodeById(app, request.params.id);
    if (!node || !await requireKnowledgeManager(app, request, reply, node)) return;
    const items = await app.db.prepare(`
      SELECT g.*, COALESCE(u.username, p.name) AS grantee_name
      FROM knowledge_node_grants g
      LEFT JOIN admin_users u ON g.grantee_type = 'user' AND u.id = g.grantee_id
      LEFT JOIN projects p ON g.grantee_type = 'project' AND p.id = g.grantee_id
      WHERE g.node_id = ? ORDER BY g.created_at DESC
    `).all(node.id) as Record<string, unknown>[];
    return { items: items.map((item) => ({ id: item.id, granteeType: item.grantee_type, granteeId: item.grantee_id, granteeName: item.grantee_name, createdAt: item.created_at })) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/knowledge-nodes/:id/grants", async (request, reply) => {
    const node = await nodeById(app, request.params.id);
    if (!node) return reply.code(404).send({ error: "NOT_FOUND", message: "知识库节点不存在" });
    const environment = await requireKnowledgeManager(app, request, reply, node);
    if (!environment) return;
    const body = parseBody(grantSchema, request.body, reply);
    if (!body) return;
    const validGrantee = body.granteeType === "user"
      ? await app.db.prepare("SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ?").get(environment.workspace_id, body.granteeId)
      : await app.db.prepare("SELECT 1 FROM projects WHERE organization_id = ? AND id = ?").get(environment.workspace_id, body.granteeId);
    if (!validGrantee) return reply.code(400).send({ error: "INVALID_GRANTEE", message: "授权对象不属于当前组织" });
    const id = randomUUID();
    try {
      await app.db.prepare(`
        INSERT INTO knowledge_node_grants (id, organization_id, node_id, grantee_type, grantee_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, environment.workspace_id, node.id, body.granteeType, body.granteeId, request.admin!.id, new Date().toISOString());
    } catch (error) {
      if (isUniqueConstraintError(error)) return reply.code(409).send({ error: "GRANT_EXISTS", message: "该编辑授权已存在" });
      throw error;
    }
    await writeAudit(app.db, { action: "knowledge.edit_granted", resourceType: `knowledge_${node.type}`, resourceId: node.id, summary: `分配知识库编辑权限 ${node.name}`, details: body, request });
    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/knowledge-grants/:id", async (request, reply) => {
    const grant = await app.db.prepare(`
      SELECT g.*, n.type, n.name FROM knowledge_node_grants g
      JOIN knowledge_nodes n ON n.id = g.node_id WHERE g.id = ?
    `).get(request.params.id) as (Record<string, unknown> & { node_id: string; type: KnowledgeNodeType; name: string }) | undefined;
    if (!grant) return reply.code(404).send({ error: "NOT_FOUND", message: "授权不存在" });
    const node = await nodeById(app, grant.node_id);
    if (!node || !await requireKnowledgeManager(app, request, reply, node)) return;
    await app.db.prepare("DELETE FROM knowledge_node_grants WHERE id = ?").run(request.params.id);
    await writeAudit(app.db, { action: "knowledge.edit_revoked", resourceType: `knowledge_${grant.type}`, resourceId: grant.node_id, summary: `撤销知识库编辑权限 ${grant.name}`, request });
    return reply.code(204).send();
  });

  const handleKnowledgeImport = async (request: FastifyRequest, reply: FastifyReply, environmentId?: string) => {
    let result = await accessibleKnowledge(app, request, reply, environmentId);
    if (!result) return;
    let parentId: string | null = null;
    let filename = "";
    let content: Buffer | null = null;
    try {
      for await (const part of request.parts({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 2 } })) {
        if (part.type === "file") {
          filename = part.filename;
          content = await part.toBuffer();
        } else if (part.fieldname === "parentId") parentId = String(part.value || "") || null;
      }
    } catch {
      return reply.code(413).send({ error: "IMPORT_TOO_LARGE", message: "导入文件不能超过 250 MB" });
    }
    if (!content || !filename) return reply.code(400).send({ error: "FILE_REQUIRED", message: "请选择 Markdown 或 ZIP 文件" });
    const extension = extname(filename).toLowerCase();
    if (extension !== ".md" && extension !== ".zip") return reply.code(400).send({ error: "INVALID_IMPORT", message: "仅支持 .md 和 .zip 文件" });
    if (environmentId && !result.environmentRootId) {
      await ensureEnvironmentRoot(app, request.admin!, environmentId);
      result = await knowledgeContext(app, request.admin!, environmentId);
    }
    parentId ??= result.environmentRootId;
    const visibleIds = new Set(result.rows.map((node) => node.id));
    const parent = parentId ? result.permissions.byId.get(parentId) : null;
    if (parentId && (!parent || parent.type !== "folder" || !visibleIds.has(parent.id))) return reply.code(400).send({ error: "INVALID_PARENT", message: "目标文件夹不存在" });
    if (extension === ".zip" && !(parent ? result.permissions.canEdit(parent) : result.permissions.canManage)) {
      return reply.code(403).send({ error: "KNOWLEDGE_EDIT_REQUIRED", message: "导入 ZIP 目录结构需要目标文件夹编辑权限" });
    }
    try {
      const imported = await app.db.transaction(async () => {
        if (extension === ".md") {
          const created = await createNode(app, request.admin!, parentId, "document", filename, request.admin!.id, environmentId);
          const markdown = await extractInlineImages(app, created.id, content.toString("utf8"), request.admin!.id);
          await app.db.prepare("UPDATE knowledge_nodes SET content = ? WHERE id = ?").run(markdown, created.id);
          return { documents: 1, folders: 0, firstDocumentId: created.id };
        }
        const files = await unzipKnowledge(content);
        const markdownFiles = files.filter((file): file is ImportedFile & { content: Buffer } => (
          !file.directory && extname(file.path).toLowerCase() === ".md" && Boolean(file.content)
        ));
        if (!markdownFiles.length) throw new Error("ZIP 中没有 Markdown 文档");
        const fileBuffers = new Map(files.filter((file): file is ImportedFile & { content: Buffer } => Boolean(file.content)).map((file) => [file.path, file.content]));
        const directoryPaths = new Set(files.filter((file) => file.directory).map((file) => file.path.replace(/\/$/, "")));
        for (const file of markdownFiles) {
          let current = dirname(file.path);
          while (current && current !== ".") {
            directoryPaths.add(current);
            current = dirname(current);
          }
        }
        const folderIds = new Map<string, string>();
        let folderCount = 0;
        for (const path of [...directoryPaths].filter(Boolean).sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
          const parentPath = dirname(path);
          const folderParentId = parentPath === "." ? parentId : folderIds.get(parentPath) ?? parentId;
          const created = await createNode(app, request.admin!, folderParentId, "folder", basename(path), request.admin!.id, environmentId);
          folderIds.set(path, created.id);
          folderCount += 1;
        }
        let firstDocumentId = "";
        for (const file of markdownFiles) {
          const documentParentPath = dirname(file.path);
          const documentParentId = documentParentPath === "." ? parentId : folderIds.get(documentParentPath) ?? parentId;
          const created = await createNode(app, request.admin!, documentParentId, "document", basename(file.path), request.admin!.id, environmentId);
          const markdown = await importArchiveDocument(app, created.id, file.path, file.content.toString("utf8"), fileBuffers, request.admin!.id);
          await app.db.prepare("UPDATE knowledge_nodes SET content = ? WHERE id = ?").run(markdown, created.id);
          if (!firstDocumentId) firstDocumentId = created.id;
        }
        return { documents: markdownFiles.length, folders: folderCount, firstDocumentId };
      })();
      await writeAudit(app.db, { action: "knowledge.imported", resourceType: "knowledge_base", resourceId: environmentId ?? request.admin!.workspace.id, summary: `导入知识库文件 ${filename}`, details: imported, request });
      return reply.code(201).send(imported);
    } catch (error) {
      return reply.code(400).send({ error: "KNOWLEDGE_IMPORT_FAILED", message: error instanceof Error ? error.message : "知识库导入失败" });
    }
  };

  app.post("/api/v1/knowledge/import", async (request, reply) => handleKnowledgeImport(request, reply));
  app.post<{ Params: { environmentId: string } }>("/api/v1/environments/:environmentId/knowledge/import", async (request, reply) => (
    handleKnowledgeImport(request, reply, request.params.environmentId)
  ));

  app.get<{ Params: { id: string } }>("/api/v1/knowledge-nodes/:id/export", async (request, reply) => {
    const node = await nodeById(app, request.params.id);
    if (!nodeBelongsToWorkspace(node, request.admin!)) return reply.code(404).send({ error: "NOT_FOUND", message: "知识库节点不存在" });
    const rows = await workspaceNodeRows(app, request.admin!);
    if (node.type === "document") {
      const content = replaceAssetReferencesWithDataUris(node.content, await assetsForDocument(app, node.id));
      return sendDownload(reply, "text/markdown; charset=utf-8", node.name, Buffer.from(content, "utf8"));
    }
    const ids = descendantIds(rows, node.id);
    const selected = rows.filter((row) => ids.has(row.id));
    const zip = await zipForNodes(app, selected);
    return sendDownload(reply, "application/zip", `${node.name}.zip`, zip.outputStream);
  });

  app.get("/api/v1/knowledge/export", async (request, reply) => {
    const context = await knowledgeContext(app, request.admin!);
    const zip = await zipForNodes(app, context.rows);
    return sendDownload(reply, "application/zip", "知识库.zip", zip.outputStream);
  });

  app.get<{ Params: { environmentId: string } }>("/api/v1/environments/:environmentId/knowledge/export", async (request, reply) => {
    const result = await accessibleKnowledge(app, request, reply, request.params.environmentId);
    if (!result) return;
    const environment = await app.db.prepare("SELECT name FROM environments WHERE id = ?").get(request.params.environmentId) as { name: string } | undefined;
    const zip = await zipForNodes(app, result.rows.filter((node) => node.id !== result.environmentRootId));
    return sendDownload(reply, "application/zip", `${safeArchiveName(environment?.name ?? "知识库")}-知识库.zip`, zip.outputStream);
  });
}
