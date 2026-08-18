import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 23),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

function multipart(boundary: string, fields: Record<string, string>, filename: string, mimeType: string, content: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  chunks.push(content);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function zipBuffer(files: Record<string, Buffer | string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    for (const [path, content] of Object.entries(files)) zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), path);
    zip.end();
  });
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value };
}

describe("environment knowledge base", () => {
  it("persists nested Markdown, creator rights, inherited project edit grants, conflicts, and Base64 images", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-knowledge-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const admin = await login(app, "admin", config.adminPassword);
      const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "writer", password: "Writer-password-123!" } });
      expect(registered.statusCode).toBe(201);
      const writer = await login(app, "writer", "Writer-password-123!");
      const writerId = (await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: writer })).json().user.id as string;

      const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: admin, payload: { name: "知识团队", description: "" } });
      const organizationId = organization.json().id as string;
      await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: admin, payload: { type: "organization", id: organizationId } });
      const invitation = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: admin, payload: { expiresInHours: 24, maxUses: 1 } });
      expect((await app.inject({ method: "POST", url: `/api/v1/organization-invitations/${invitation.json().token}/accept`, cookies: writer })).statusCode).toBe(201);
      await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: writer, payload: { type: "organization", id: organizationId } });

      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies: admin, payload: { name: "生产环境" } });
      const environmentId = environment.json().id as string;
      expect((await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: admin, payload: { granteeType: "user", granteeId: writerId, resourceType: "environment", resourceId: environmentId } })).statusCode).toBe(201);

      const folder = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/knowledge/nodes`, cookies: admin, payload: { type: "folder", name: "运行手册", parentId: null } });
      const folderId = folder.json().id as string;
      const environmentTree = (await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/knowledge`, cookies: admin })).json();
      expect(environmentTree.imageLimitBytes).toBe(30 * 1024 * 1024);
      expect(environmentTree.environmentRootId).toBe(environmentId);
      expect(environmentTree.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: folderId, parentId: null, storageParentId: environmentId }),
      ]));
      expect(environmentTree.items.some((item: { id: string }) => item.id === environmentTree.environmentRootId)).toBe(false);
      expect(await db.prepare("SELECT environment_id, type FROM knowledge_nodes WHERE id = ?").get(environmentTree.environmentRootId)).toEqual({
        environment_id: environmentId,
        type: "folder",
      });
      const adminDocument = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/knowledge/nodes`, cookies: admin, payload: { type: "document", name: "发布流程", parentId: folderId } });
      const adminDocumentId = adminDocument.json().id as string;

      expect((await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/knowledge/nodes`, cookies: writer, payload: { type: "folder", name: "无权目录", parentId: null } })).statusCode).toBe(403);
      const writerDocument = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/knowledge/nodes`, cookies: writer, payload: { type: "document", name: "我的记录", parentId: folderId } });
      expect(writerDocument.statusCode).toBe(201);
      const writerDocumentId = writerDocument.json().id as string;
      expect(writerDocument.json().name).toBe("我的记录.md");
      expect((await app.inject({ method: "PUT", url: `/api/v1/knowledge-documents/${writerDocumentId}/content`, cookies: writer, payload: { content: "# Writer", revision: 1 } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PUT", url: `/api/v1/knowledge-documents/${adminDocumentId}/content`, cookies: writer, payload: { content: "forbidden", revision: 1 } })).statusCode).toBe(403);

      const restrictedGlobalDocument = await app.inject({ method: "POST", url: "/api/v1/knowledge/nodes", cookies: admin, payload: { type: "document", name: "管理员文档", parentId: null } });
      const ownGlobalDocument = await app.inject({ method: "POST", url: "/api/v1/knowledge/nodes", cookies: writer, payload: { type: "document", name: "成员文档", parentId: null } });
      expect((await app.inject({ method: "GET", url: "/api/v1/knowledge", cookies: writer })).json().items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
        restrictedGlobalDocument.json().id,
        ownGlobalDocument.json().id,
      ]));
      const associationCandidates = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/knowledge/association-candidates`, cookies: writer });
      expect(associationCandidates.json().items.map((item: { id: string }) => item.id)).toEqual([ownGlobalDocument.json().id]);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/knowledge/associations`,
        cookies: writer,
        payload: { nodeIds: [restrictedGlobalDocument.json().id] },
      })).statusCode).toBe(403);

      const project = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/projects`, cookies: admin, payload: { name: "运维组", description: "", parentId: null } });
      const projectId = project.json().id as string;
      await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/projects/${projectId}/members`, cookies: admin, payload: { userId: writerId } });
      expect((await app.inject({ method: "POST", url: `/api/v1/knowledge-nodes/${folderId}/grants`, cookies: admin, payload: { granteeType: "project", granteeId: projectId } })).statusCode).toBe(201);

      const saved = await app.inject({ method: "PUT", url: `/api/v1/knowledge-documents/${adminDocumentId}/content`, cookies: writer, payload: { content: "# 发布\n\n安全执行。", revision: 1 } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().revision).toBe(2);
      const conflict = await app.inject({ method: "PUT", url: `/api/v1/knowledge-documents/${adminDocumentId}/content`, cookies: admin, payload: { content: "stale", revision: 1 } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: "KNOWLEDGE_CONFLICT", revision: 2 });

      const boundary = "knowledge-image-boundary";
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const uploaded = await app.inject({
        method: "POST",
        url: `/api/v1/knowledge-documents/${adminDocumentId}/assets`,
        cookies: writer,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, {}, "diagram.png", "image/png", image),
      });
      expect(uploaded.statusCode).toBe(201);
      expect(uploaded.json().asset).toMatchObject({ mimeType: "image/png", sizeBytes: image.length, dataBase64: image.toString("base64") });
      const svgBoundary = "knowledge-svg-boundary";
      const rejectedSvg = await app.inject({
        method: "POST",
        url: `/api/v1/knowledge-documents/${adminDocumentId}/assets`,
        cookies: writer,
        headers: { "content-type": `multipart/form-data; boundary=${svgBoundary}` },
        payload: multipart(svgBoundary, {}, "unsafe.svg", "image/svg+xml", Buffer.from("<svg><script>alert(1)</script></svg>")),
      });
      expect(rejectedSvg.statusCode).toBe(400);
      expect(rejectedSvg.json().error).toBe("INVALID_IMAGE");
      const markdown = `${uploaded.json().markdown}\n`;
      expect((await app.inject({ method: "PUT", url: `/api/v1/knowledge-documents/${adminDocumentId}/content`, cookies: writer, payload: { content: markdown, revision: 2 } })).statusCode).toBe(200);

      const detail = await app.inject({ method: "GET", url: `/api/v1/knowledge-documents/${adminDocumentId}`, cookies: writer });
      expect(detail.json().item).toMatchObject({ canEdit: true, revision: 3, content: markdown });
      expect(detail.json().assets[0].dataUrl).toBe(`data:image/png;base64,${image.toString("base64")}`);
      const metadataOnlyDetail = await app.inject({ method: "GET", url: `/api/v1/knowledge-documents/${adminDocumentId}?includeAssetData=false`, cookies: writer });
      expect(metadataOnlyDetail.json().assets[0]).toMatchObject({ filename: "diagram.png", mimeType: "image/png", sizeBytes: image.length });
      expect(metadataOnlyDetail.json().assets[0]).not.toHaveProperty("dataBase64");
      expect(metadataOnlyDetail.json().assets[0]).not.toHaveProperty("dataUrl");
      const exported = await app.inject({ method: "GET", url: `/api/v1/knowledge-nodes/${adminDocumentId}/export`, cookies: writer });
      expect(exported.statusCode).toBe(200);
      expect(exported.body).toContain("data:image/png;base64,");
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies: writer })).json().item.knowledgeDocumentCount).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("hides a migrated environment folder while preserving it as the storage parent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-knowledge-legacy-root-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const cookies = await login(app, "admin", config.adminPassword);
      const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "旧开发环境" } });
      const environmentId = environment.json().id as string;
      const rootId = randomUUID();
      const documentId = randomUUID();
      const now = new Date().toISOString();
      await db.transaction(async () => {
        await db.prepare(`
          INSERT INTO knowledge_nodes (
            id, workspace_type, workspace_id, environment_id, parent_id, parent_key, type, name, content,
            revision, created_by_user_id, created_at, updated_at
          ) VALUES (?, 'personal', ?, NULL, NULL, '', 'folder', '旧开发环境', '', 1, NULL, ?, ?)
        `).run(rootId, admin.id, now, now);
        await db.prepare(`
          INSERT INTO knowledge_nodes (
            id, workspace_type, workspace_id, environment_id, parent_id, parent_key, type, name, content,
            revision, created_by_user_id, created_at, updated_at
          ) VALUES (?, 'personal', ?, NULL, ?, ?, 'document', 'legacy.md', '# legacy', 1, ?, ?, ?)
        `).run(documentId, admin.id, rootId, rootId, admin.id, now, now);
        await db.prepare(`
          INSERT INTO knowledge_node_environments (node_id, environment_id, assigned_by_user_id, assigned_at)
          VALUES (?, ?, NULL, ?), (?, ?, NULL, ?)
        `).run(rootId, environmentId, now, documentId, environmentId, now);
      })();

      const tree = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/knowledge`, cookies });
      expect(tree.statusCode).toBe(200);
      expect(tree.json().environmentRootId).toBe(rootId);
      expect(tree.json().items).toEqual([
        expect.objectContaining({ id: documentId, parentId: null, storageParentId: rootId }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("imports Markdown and ZIP directory trees without overwriting sibling names and exports the knowledge base", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-knowledge-import-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const cookies = await login(app, "admin", config.adminPassword);
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "导入环境" } });
      const environmentId = environment.json().id as string;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const archive = await zipBuffer({
        "手册/README.md": "# 手册\n\n![拓扑](images/topology.png)",
        "手册/images/topology.png": png,
        "手册/子目录/check.md": "- [ ] 检查",
      });
      const zipBoundary = "knowledge-zip-boundary";
      const imported = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/knowledge/import`,
        cookies,
        headers: { "content-type": `multipart/form-data; boundary=${zipBoundary}` },
        payload: multipart(zipBoundary, { parentId: "" }, "knowledge.zip", "application/zip", archive),
      });
      expect(imported.statusCode).toBe(201);
      expect(imported.json()).toMatchObject({ documents: 2, folders: 2 });
      const firstDocumentId = imported.json().firstDocumentId as string;
      const document = await app.inject({ method: "GET", url: `/api/v1/knowledge-documents/${firstDocumentId}`, cookies });
      expect(document.json().item.content).toContain("knowledge-asset://");
      expect(document.json().assets[0].dataBase64).toBe(png.toString("base64"));

      const mdBoundary = "knowledge-md-boundary";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await app.inject({
          method: "POST",
          url: `/api/v1/environments/${environmentId}/knowledge/import`,
          cookies,
          headers: { "content-type": `multipart/form-data; boundary=${mdBoundary}${attempt}` },
          payload: multipart(`${mdBoundary}${attempt}`, { parentId: "" }, "notes.md", "text/markdown", Buffer.from("# notes")),
        })).statusCode).toBe(201);
      }
      const tree = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/knowledge`, cookies });
      expect(tree.json().items.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(["notes.md", "notes (2).md"]));
      expect(tree.json().items.some((item: { id: string }) => item.id === tree.json().environmentRootId)).toBe(false);
      expect(tree.json().items.filter((item: { name: string; parentId: string | null }) => item.name.startsWith("notes")).every((item: { parentId: string | null }) => item.parentId === null)).toBe(true);

      const exported = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/knowledge/export`, cookies });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["content-type"]).toContain("application/zip");
      expect(exported.rawPayload.subarray(0, 2).toString()).toBe("PK");
    } finally {
      await app.close();
    }
  });

  it("shares workspace documents through inherited environment tags and batch associations without deleting documents with environments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-workspace-knowledge-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const cookies = await login(app, "admin", config.adminPassword);
      const firstEnvironment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "生产环境" } });
      const secondEnvironment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "预发环境" } });
      const firstEnvironmentId = firstEnvironment.json().id as string;
      const secondEnvironmentId = secondEnvironment.json().id as string;

      const folder = await app.inject({ method: "POST", url: "/api/v1/knowledge/nodes", cookies, payload: { type: "folder", name: "发布手册", parentId: null } });
      const folderId = folder.json().id as string;
      const inheritedDocument = await app.inject({ method: "POST", url: "/api/v1/knowledge/nodes", cookies, payload: { type: "document", name: "生产发布", parentId: folderId } });
      const inheritedDocumentId = inheritedDocument.json().id as string;
      const unassignedDocument = await app.inject({ method: "POST", url: "/api/v1/knowledge/nodes", cookies, payload: { type: "document", name: "应急记录", parentId: folderId } });
      const unassignedDocumentId = unassignedDocument.json().id as string;

      expect((await app.inject({
        method: "PATCH",
        url: `/api/v1/knowledge-nodes/${folderId}/environments`,
        cookies,
        payload: { add: [firstEnvironmentId], remove: [] },
      })).statusCode).toBe(200);
      expect((await app.inject({
        method: "PATCH",
        url: `/api/v1/knowledge-nodes/${inheritedDocumentId}/environments`,
        cookies,
        payload: { add: [secondEnvironmentId], remove: [] },
      })).statusCode).toBe(200);

      const globalTree = await app.inject({ method: "GET", url: "/api/v1/knowledge", cookies });
      expect(globalTree.statusCode).toBe(200);
      expect(globalTree.json().items).toHaveLength(3);
      expect(globalTree.json().environments).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstEnvironmentId, name: "生产环境" }),
        expect.objectContaining({ id: secondEnvironmentId, name: "预发环境" }),
      ]));
      expect((await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: "isolated", password: "Isolated-password-123!" } })).statusCode).toBe(201);
      const isolated = await login(app, "isolated", "Isolated-password-123!");
      expect((await app.inject({ method: "GET", url: "/api/v1/knowledge", cookies: isolated })).json().items).toEqual([]);

      const firstTree = await app.inject({ method: "GET", url: `/api/v1/environments/${firstEnvironmentId}/knowledge`, cookies });
      expect(firstTree.json().items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([folderId, inheritedDocumentId, unassignedDocumentId]));
      expect(firstTree.json().items.find((item: { id: string }) => item.id === inheritedDocumentId)).toMatchObject({
        directEnvironmentIds: [secondEnvironmentId],
        effectiveEnvironmentIds: expect.arrayContaining([firstEnvironmentId, secondEnvironmentId]),
        isContextOnly: false,
      });

      const secondTree = await app.inject({ method: "GET", url: `/api/v1/environments/${secondEnvironmentId}/knowledge`, cookies });
      expect(secondTree.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: folderId, isContextOnly: true }),
        expect.objectContaining({ id: inheritedDocumentId, isContextOnly: false }),
      ]));
      expect(secondTree.json().items.some((item: { id: string }) => item.id === unassignedDocumentId)).toBe(false);

      const candidates = await app.inject({ method: "GET", url: `/api/v1/environments/${secondEnvironmentId}/knowledge/association-candidates`, cookies });
      expect(candidates.json().items).toEqual([expect.objectContaining({ id: unassignedDocumentId, path: "发布手册 / 应急记录.md" })]);
      expect((await app.inject({
        method: "POST",
        url: `/api/v1/environments/${secondEnvironmentId}/knowledge/associations`,
        cookies,
        payload: { nodeIds: [unassignedDocumentId] },
      })).statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: `/api/v1/environments/${secondEnvironmentId}`, cookies })).json().item.knowledgeDocumentCount).toBe(2);

      expect((await app.inject({ method: "DELETE", url: `/api/v1/environments/${firstEnvironmentId}`, cookies })).statusCode).toBe(204);
      const retainedDocument = await app.inject({ method: "GET", url: `/api/v1/knowledge-documents/${inheritedDocumentId}`, cookies });
      expect(retainedDocument.statusCode).toBe(200);
      expect(retainedDocument.json().item.effectiveEnvironmentIds).toEqual([secondEnvironmentId]);
    } finally {
      await app.close();
    }
  });

  it("migrates environment-owned trees into collision-safe workspace folders and environment associations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-legacy-knowledge-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const initialDb = await openDatabase(config);
    await ensureAdmin(initialDb, config);
    const admin = await initialDb.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const now = new Date().toISOString();
    for (const environmentId of [firstEnvironmentId, secondEnvironmentId]) {
      await initialDb.prepare(`
        INSERT INTO environments (
          id, workspace_type, workspace_id, group_id, sort_order, name, short_name, description,
          status, owner, tags_json, created_at, updated_at
        ) VALUES (?, 'personal', ?, NULL, 0, '生产环境', '', '', 'active', '', '[]', ?, ?)
      `).run(environmentId, admin.id, now, now);
    }
    await initialDb.close();

    const legacy = new Database(config.databasePath);
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      DROP TABLE knowledge_node_environments;
      DROP TABLE knowledge_assets;
      DROP TABLE knowledge_node_grants;
      DROP TABLE knowledge_nodes;
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        parent_key TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK(type IN ('folder','document')),
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
        created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(environment_id, parent_key, name COLLATE NOCASE)
      );
      CREATE TABLE knowledge_assets (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        data_base64 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_by_user_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
    `);
    const insertLegacyDocument = legacy.prepare(`
      INSERT INTO knowledge_nodes (
        id, environment_id, parent_id, parent_key, type, name, content, revision,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, NULL, '', 'document', 'README.md', '# legacy', 1, ?, ?, ?)
    `);
    const firstDocumentId = randomUUID();
    const secondDocumentId = randomUUID();
    insertLegacyDocument.run(firstDocumentId, firstEnvironmentId, admin.id, now, now);
    insertLegacyDocument.run(secondDocumentId, secondEnvironmentId, admin.id, now, now);
    const legacyAssetId = randomUUID();
    legacy.prepare(`
      INSERT INTO knowledge_assets (id, document_id, filename, mime_type, data_base64, size_bytes, created_by_user_id, created_at)
      VALUES (?, ?, 'pixel.png', 'image/png', 'iVBORw0KGgo=', 8, ?, ?)
    `).run(legacyAssetId, firstDocumentId, admin.id, now);
    legacy.close();

    const migratedDb = await openDatabase(config);
    await ensureAdmin(migratedDb, config);
    try {
      const nodes = await migratedDb.prepare(`
        SELECT id, environment_id, parent_id, type, name, workspace_type, workspace_id
        FROM knowledge_nodes ORDER BY type, name, id
      `).all() as Array<Record<string, unknown>>;
      expect(nodes.filter((node) => node.type === "folder").map((node) => node.name)).toEqual(["生产环境", "生产环境 (2)"]);
      expect(nodes.filter((node) => node.type === "document")).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: firstDocumentId, environment_id: null, workspace_type: "personal", workspace_id: admin.id }),
        expect.objectContaining({ id: secondDocumentId, environment_id: null, workspace_type: "personal", workspace_id: admin.id }),
      ]));
      expect(new Set(nodes.filter((node) => node.type === "document").map((node) => node.parent_id)).size).toBe(2);
      const associations = await migratedDb.prepare("SELECT node_id, environment_id FROM knowledge_node_environments").all() as Array<{ node_id: string; environment_id: string }>;
      expect(associations).toHaveLength(4);
      expect(associations).toEqual(expect.arrayContaining([
        { node_id: firstDocumentId, environment_id: firstEnvironmentId },
        { node_id: secondDocumentId, environment_id: secondEnvironmentId },
      ]));
      expect(await migratedDb.prepare("SELECT document_id, data_base64 FROM knowledge_assets WHERE id = ?").get(legacyAssetId)).toEqual({
        document_id: firstDocumentId,
        data_base64: "iVBORw0KGgo=",
      });
    } finally {
      await migratedDb.close();
    }
  });
});
