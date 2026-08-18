import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { issueApiKey } from "../src/server/api-keys.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { createSecretBox } from "../src/server/crypto.js";
import { assertMcpApiRequestAllowed } from "../src/shared/mcp-policy.js";
import { resolveVironMcpApiRequest, VIRON_MCP_TOOL_NAMES } from "../src/shared/mcp-tools.js";

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
    databasePath: join(directory, "viron.db"),
    masterKey: Buffer.alloc(32, 41),
    adminUsername: "admin",
    adminPassword: "Admin-password-123",
    allowWeakPasswords: false,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
    mcpEnabled: true,
  };
}

function multipart(boundary: string, fields: Record<string, string>, filename: string, content: string): Buffer {
  const chunks = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name=${JSON.stringify(name)}\r\n\r\n${value}\r\n`);
  chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename=${JSON.stringify(filename)}\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

function callOperation(
  client: Client,
  gateway: "viron_read" | "viron_change" | "viron_risk" | "viron_secure",
  operation: string,
  input: Record<string, unknown> = {},
) {
  return client.callTool({ name: gateway, arguments: { operation, input } });
}

describe("Viron MCP", () => {
  it("keeps status visible while omitting the remote transport when disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-disabled-"));
    directories.push(directory);
    const config = { ...configFor(directory), mcpEnabled: false };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "status", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const headers = { authorization: `Bearer ${key.apiKey}` };
    const status = await app.inject({ method: "GET", url: "/api/v1/mcp/status", headers });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ enabled: false, path: "/mcp", toolCount: VIRON_MCP_TOOL_NAMES.length, sessions: [] });
    const capabilities = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(capabilities.json()).toMatchObject({ mcp: { server: { enabled: false, path: "/mcp" } } });
    const remote = await app.inject({ method: "POST", url: "/mcp", headers, payload: {} });
    expect(remote.statusCode).toBe(404);
    await app.close();
  });

  it("exposes authenticated workspace, environment, connection, and knowledge tools without account-security tools", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "codex", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const headers = { authorization: `Bearer ${key.apiKey}` };

    const environment = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      headers,
      payload: { name: "MCP Acceptance", shortName: "MCP", status: "active" },
    });
    expect(environment.statusCode).toBe(201);
    const environmentId = environment.json().id as string;
    const unreachableDatabase = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      headers,
      payload: {
        name: "MCP async audit",
        engine: "mysql",
        host: "127.0.0.1",
        port: 1,
        username: "operator",
        credential: { password: "unused" },
        defaultDatabase: "audit",
      },
    });
    expect(unreachableDatabase.statusCode).toBe(201);
    const unreachableDatabaseId = unreachableDatabase.json().id as string;
    const document = await app.inject({
      method: "POST",
      url: "/api/v1/knowledge/nodes",
      headers,
      payload: { type: "document", name: "MCP notes", parentId: null },
    });
    expect(document.statusCode).toBe(201);
    const documentId = document.json().id as string;
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/knowledge-documents/${documentId}/content`,
      headers,
      payload: { content: "# MCP acceptance\n\nViron knowledge is available.", revision: 1 },
    });
    expect(saved.statusCode).toBe(200);
    const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const asset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await db.prepare(`
      INSERT INTO knowledge_assets (id, document_id, filename, mime_type, data_base64, size_bytes, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(assetId, documentId, "mcp.png", "image/png", asset.toString("base64"), asset.length, admin.id, new Date().toISOString());

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers },
    });
    const client = new Client({ name: "viron-mcp-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const status = await app.inject({ method: "GET", url: "/api/v1/mcp/status", headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        enabled: true,
        transport: "streamable-http",
        authentication: "personal-api-key",
        toolCount: VIRON_MCP_TOOL_NAMES.length,
        sessions: [expect.objectContaining({ clientName: "viron-mcp-test", clientVersion: "1.0.0" })],
      });
      const capabilities = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
      expect(capabilities.json()).toMatchObject({ mcp: { server: { enabled: true, path: "/mcp" } } });
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(new Set(names)).toEqual(new Set(VIRON_MCP_TOOL_NAMES));
      expect(names).toContain("viron_operations_search");
      expect(names).toContain("viron_operation_schema");
      expect(names).toContain("viron_read");
      expect(names.some((name) => /password|api_key|session|member|grant/i.test(name))).toBe(false);
      expect(JSON.stringify(tools.tools).length).toBeLessThan(20_000);

      const domains = await client.callTool({ name: "viron_domains_list", arguments: {} });
      expect(domains.structuredContent).toMatchObject({
        result: {
          status: 200,
          data: {
            catalogVersion: 2,
            operationCount: expect.any(Number),
            domains: expect.arrayContaining([expect.objectContaining({ domain: "ssh" }), expect.objectContaining({ domain: "database" })]),
          },
        },
      });
      const sshCatalog = await client.callTool({
        name: "viron_operations_search",
        arguments: { domain: "ssh", query: "ssh command", limit: 20 },
      });
      const sshItems = (sshCatalog.structuredContent as { result: { data: { items: Array<{ id: string; domain: string }> } } }).result.data.items;
      expect(sshItems).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "viron_ssh_command_request", domain: "ssh" }),
        expect.objectContaining({ id: "viron_ssh_command_favorites_list", domain: "ssh" }),
      ]));
      expect(sshItems.some((item) => item.id === "ssh_keys_list")).toBe(false);
      expect(sshItems.some((item) => item.id.includes("database"))).toBe(false);
      const sshSchema = await client.callTool({ name: "viron_operation_schema", arguments: { operation: "viron_ssh_command_request" } });
      expect(sshSchema.structuredContent).toMatchObject({
        result: {
          status: 200,
          data: {
            catalogVersion: 2,
            operation: {
              id: "viron_ssh_command_request",
              mode: "risk",
              inputSchema: { properties: { connectionId: expect.any(Object), command: expect.any(Object) } },
            },
          },
        },
      });
      const wrongMode = await callOperation(client, "viron_change", "viron_environments_list");
      expect(wrongMode).toMatchObject({ isError: true, structuredContent: { result: { status: 400, data: { error: "MCP_OPERATION_MODE_MISMATCH" } } } });
      const staleSchema = await client.callTool({
        name: "viron_read",
        arguments: { operation: "viron_environments_list", input: {}, schemaHash: "0000000000000000" },
      });
      expect(staleSchema).toMatchObject({ isError: true, structuredContent: { result: { status: 409, data: { error: "MCP_OPERATION_SCHEMA_CHANGED" } } } });

      const snippet = await callOperation(client, "viron_change", "database_code_snippet_create", { name: "MCP snippet", description: "catalog test", sql: "SELECT 1" });
      expect(snippet.structuredContent).toMatchObject({ result: { status: 201, data: { item: { name: "MCP snippet", sql: "SELECT 1" } } } });
      const snippets = await callOperation(client, "viron_read", "database_code_snippets_list");
      expect(snippets.structuredContent).toMatchObject({ result: { status: 200, data: { items: [expect.objectContaining({ name: "MCP snippet" })] } } });

      const mcpEnvironment = await callOperation(client, "viron_change", "viron_environment_create", {
        environment: { name: "Created through MCP", shortName: "MCP Audit", status: "active" },
      });
      const mcpEnvironmentId = (mcpEnvironment.structuredContent as { result: { data: { id: string } } }).result.data.id;
      expect(await db.prepare("SELECT source FROM audit_events WHERE action = 'environment.created' AND resource_id = ?").get(environmentId)).toEqual({ source: "manual" });
      expect(await db.prepare("SELECT source FROM audit_events WHERE action = 'environment.created' AND resource_id = ?").get(mcpEnvironmentId)).toEqual({ source: "mcp" });
      const mcpAudit = await app.inject({ method: "GET", url: "/api/v1/audit-events?source=mcp", headers });
      expect(mcpAudit.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ resourceId: mcpEnvironmentId, source: "mcp" })]));
      expect(mcpAudit.json().items.every((item: { source: string }) => item.source === "mcp")).toBe(true);

      const asyncQuery = await callOperation(client, "viron_read", "viron_database_query_read_start", {
        connectionId: unreachableDatabaseId,
        database: "audit",
        sql: "SELECT 1",
      });
      expect(asyncQuery.structuredContent).toMatchObject({ result: { status: 202, data: { job: { connectionId: unreachableDatabaseId } } } });
      let asyncAudit: { source: string } | undefined;
      for (let attempt = 0; attempt < 100 && !asyncAudit; attempt += 1) {
        asyncAudit = await db.prepare(`
          SELECT source FROM audit_events
          WHERE action = 'database.query_failed' AND resource_id = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(unreachableDatabaseId) as { source: string } | undefined;
        if (!asyncAudit) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(asyncAudit).toEqual({ source: "mcp" });

      const environments = await callOperation(client, "viron_read", "viron_environments_list");
      expect(environments.isError).not.toBe(true);
      expect(environments.structuredContent).toMatchObject({
        result: { status: 200, data: { items: expect.arrayContaining([expect.objectContaining({ id: environmentId, name: "MCP Acceptance" })]) } },
      });

      const knowledge = await callOperation(client, "viron_read", "viron_knowledge_document_read", { documentId });
      expect(knowledge.structuredContent).toMatchObject({
        result: {
          status: 200,
          data: {
            item: expect.objectContaining({ id: documentId, content: expect.stringContaining("Viron knowledge") }),
            assets: [expect.objectContaining({ id: assetId, filename: "mcp.png", sizeBytes: asset.length })],
          },
        },
      });
      const knowledgeAsset = (knowledge.structuredContent as { result: { data: { assets: Array<Record<string, unknown>> } } }).result.data.assets[0];
      expect(knowledgeAsset).not.toHaveProperty("dataBase64");
      expect(knowledgeAsset).not.toHaveProperty("dataUrl");

      const context = await client.readResource({ uri: "viron://current/context" });
      expect(context.contents[0]).toMatchObject({ uri: "viron://current/context", mimeType: "application/json" });
      expect("text" in context.contents[0] ? context.contents[0].text : "").toContain("admin");
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("requires a personal Viron API key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-auth-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "unauthenticated", version: "1" } },
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("API_KEY_REQUIRED");
    await app.close();
  });

  it("applies full access per remote API key while keeping credential entry interactive", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-remote-approval-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "remote-full-access", admin.id, "never");
    const app = await buildApp({ config, db, logger: false });
    const headers = { authorization: `Bearer ${key.apiKey}` };

    const automatic = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      headers,
      payload: {
        action: "viron_business_risk_request",
        arguments: {
          operation: "database_automation_run",
          input: { automationId: crypto.randomUUID() },
        },
      },
    });
    expect(automatic.statusCode).toBe(201);
    expect(automatic.json()).toMatchObject({ status: "failed", riskLevel: "high" });

    const credential = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      headers,
      payload: {
        action: "viron_ssh_connection_secure_create",
        arguments: {
          config: { name: "Remote secure SSH", host: "127.0.0.1", port: 22, username: "root", authType: "password" },
        },
      },
    });
    expect(credential.statusCode).toBe(201);
    expect(credential.json()).toMatchObject({ status: "pending", kind: "credential" });
    await app.close();
  });

  it("enforces the account-security and secret-export denylist for every resolved request", () => {
    expect(() => assertMcpApiRequestAllowed({ path: "/api/v1/api-keys" })).toThrow("账号安全");
    expect(() => assertMcpApiRequestAllowed({ path: "/api/v1/organizations/00000000-0000-4000-8000-000000000000/members" })).toThrow("权限控制");
    expect(() => assertMcpApiRequestAllowed({ path: "/api/v1/ssh-keys/00000000-0000-4000-8000-000000000000/export", query: { part: "private" } })).toThrow("SSH 私钥");
    expect(assertMcpApiRequestAllowed({ path: "/api/v1/ssh-keys/00000000-0000-4000-8000-000000000000/export", query: { part: "public" } })).toBeTruthy();
  });

  it("maps the on-demand approval purpose tool without repeating the original operation arguments", () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    expect(resolveVironMcpApiRequest("viron_operation_purpose_provide", {
      workspace: "personal",
      operationId,
      purpose: "排查发布后服务异常并确认是否需要回滚",
    })).toEqual({
      method: "POST",
      path: `/api/v1/mcp/operations/${operationId}/purpose`,
      workspace: "personal",
      body: { purpose: "排查发布后服务异常并确认是否需要回滚" },
    });
    expect(() => resolveVironMcpApiRequest("viron_operation_purpose_provide", {
      operationId,
      purpose: "太短",
    })).toThrow();
  });

  it("maps bounded read batches and rejects write-capable batch inputs before dispatch", () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    expect(resolveVironMcpApiRequest("viron_ssh_commands_read_batch", {
      connectionId,
      commands: ["uname -a", "kubectl get pods -A"],
      timeoutMs: 30_000,
      maxBytes: 64 * 1024,
    })).toMatchObject({
      method: "POST",
      path: `/api/v1/mcp/ssh-connections/${connectionId}/commands`,
      body: { commands: ["uname -a", "kubectl get pods -A"], timeoutMs: 30_000, maxBytes: 64 * 1024 },
    });
    expect(() => resolveVironMcpApiRequest("viron_ssh_commands_read_batch", {
      connectionId,
      commands: ["rm -f /tmp/viron-test"],
    })).toThrow("只读");

    expect(resolveVironMcpApiRequest("viron_database_queries_read_batch", {
      connectionId,
      queries: [{ database: "operations", sql: "SELECT 1" }],
    })).toMatchObject({
      method: "POST",
      path: `/api/v1/database-connections/${connectionId}/queries/batch`,
    });
    expect(() => resolveVironMcpApiRequest("viron_database_queries_read_batch", {
      connectionId,
      queries: [{ database: "operations", sql: "UPDATE jobs SET state = 'done'" }],
    })).toThrow("只允许");

    expect(resolveVironMcpApiRequest("viron_redis_commands_read_batch", {
      connectionId,
      commands: [{ command: "GET", args: ["status"] }],
    })).toMatchObject({
      method: "POST",
      path: `/api/v1/redis-connections/${connectionId}/commands/batch`,
    });
    expect(() => resolveVironMcpApiRequest("viron_redis_commands_read_batch", {
      connectionId,
      commands: [{ command: "SET", args: ["status", "done"] }],
    })).toThrow("写命令");
  });

  it("collects connection secrets only through a Viron session-bound single-use page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-secret-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "codex-secure", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key.apiKey}` } },
    });
    const client = new Client({ name: "viron-mcp-secret-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const created = await callOperation(client, "viron_secure", "viron_ssh_connection_secure_create", {
          config: {
            name: "Secure SSH",
            host: "10.0.0.15",
            port: 22,
            username: "root",
            authType: "password",
          },
      });
      expect(created.isError).not.toBe(true);
      const result = (created.structuredContent as { result: { data: { operationId: string; status: string; actionUrl: string } } }).result.data;
      expect(result.status).toBe("pending");
      expect(result.actionUrl).toBe(`${address}/mcp/operations/${result.operationId}`);
      expect(JSON.stringify(created)).not.toContain("secure-password-value");

      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: config.adminUsername, password: config.adminPassword },
      });
      const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
      const page = await app.inject({ method: "GET", url: `/mcp/operations/${result.operationId}`, cookies });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("安全创建 SSH 连接");
      expect(page.body).not.toContain("secure-password-value");

      const apiKeyPage = await app.inject({
        method: "GET",
        url: `/mcp/operations/${result.operationId}`,
        headers: { authorization: `Bearer ${key.apiKey}` },
      });
      expect(apiKeyPage.statusCode).toBe(403);

      const submitted = await app.inject({
        method: "POST",
        url: `/mcp/operations/${result.operationId}/submit`,
        cookies,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ password: "secure-password-value" }).toString(),
      });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.body).toContain("操作已完成");
      expect(submitted.body).not.toContain("secure-password-value");

      const connection = await db.prepare("SELECT id, credential_ciphertext FROM ssh_connections WHERE name = ?").get("Secure SSH") as { id: string; credential_ciphertext: string };
      expect(connection.id).toBeTruthy();
      expect(connection.credential_ciphertext).not.toContain("secure-password-value");
      expect(JSON.parse(app.secrets.decrypt(connection.credential_ciphertext))).toMatchObject({ password: "secure-password-value" });
      const auditRows = await db.prepare("SELECT source, summary, details_json FROM audit_events WHERE resource_id = ? OR resource_id = ?").all(connection.id, result.operationId) as Array<{ source: string; summary: string; details_json: string }>;
      expect(auditRows.length).toBeGreaterThan(0);
      expect(auditRows.every((row) => row.source === "mcp")).toBe(true);
      expect(JSON.stringify(auditRows)).not.toContain("secure-password-value");

      const status = await client.callTool({ name: "viron_operation_status", arguments: { operationId: result.operationId } });
      expect(status.structuredContent).toMatchObject({ result: { status: 200, data: { status: "completed", result: { status: 201, data: { id: connection.id } } } } });
      expect(JSON.stringify(status)).not.toContain("secure-password-value");
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("generates workspace SSH keys through the Viron safety page without returning the passphrase or private key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-ssh-key-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "codex-key-create", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key.apiKey}` } },
    });
    const client = new Client({ name: "viron-mcp-key-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const created = await callOperation(client, "viron_secure", "viron_ssh_key_secure_generate", { name: "MCP generated key", algorithm: "ed25519" });
      const operation = (created.structuredContent as { result: { data: { operationId: string } } }).result.data;
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
      const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
      const page = await app.inject({ method: "GET", url: `/mcp/operations/${operation.operationId}`, cookies });
      expect(page.body).toContain("安全生成 SSH 密钥");
      expect(page.body).toContain("新密钥口令");
      const submitted = await app.inject({
        method: "POST",
        url: `/mcp/operations/${operation.operationId}/submit`,
        cookies,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ passphrase: "mcp-key-passphrase" }).toString(),
      });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.body).toContain("操作已完成");
      expect(submitted.body).not.toContain("mcp-key-passphrase");
      const stored = await db.prepare("SELECT id, private_key_ciphertext FROM ssh_keys WHERE name = ?").get("MCP generated key") as { id: string; private_key_ciphertext: string };
      expect(stored.private_key_ciphertext).toMatch(/^v1:/);
      const status = await client.callTool({ name: "viron_operation_status", arguments: { operationId: operation.operationId } });
      expect(status.structuredContent).toMatchObject({ result: { status: 200, data: { status: "completed", result: { status: 201, data: { id: stored.id } } } } });
      expect(JSON.stringify(status)).not.toMatch(/mcp-key-passphrase|PRIVATE KEY/);
      const audit = await db.prepare("SELECT details_json FROM audit_events WHERE resource_id = ? OR resource_id = ?").all(stored.id, operation.operationId) as Array<{ details_json: string }>;
      expect(JSON.stringify(audit)).not.toMatch(/mcp-key-passphrase|PRIVATE KEY/);
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("stores database TLS material only in encrypted credentials and secures profile create and update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-database-secret-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "codex-database-secret", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key.apiKey}` } },
    });
    const client = new Client({ name: "viron-mcp-database-secret-test", version: "1.0.0" });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
    const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
    const configInput = {
      name: "Secure database",
      engine: "mysql" as const,
      host: "db.example.test",
      port: 3306,
      username: "operator",
      defaultDatabase: "app",
      connectionMode: "tcp" as const,
      options: {
        charset: "utf8mb4",
        timezone: "local",
        connectTimeoutMs: 10_000,
        ssl: { enabled: true, rejectUnauthorized: true },
        httpTunnelUrl: "",
        httpTunnelRejectUnauthorized: true,
      },
    };
    try {
      await client.connect(transport);
      const created = await callOperation(client, "viron_secure", "viron_database_connection_secure_create", { config: configInput });
      const createOperation = (created.structuredContent as { result: { data: { operationId: string } } }).result.data;
      const submitted = await app.inject({
        method: "POST",
        url: `/mcp/operations/${createOperation.operationId}/submit`,
        cookies,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({
          password: "database-password",
          tlsCa: "database-ca",
          tlsCertificate: "database-certificate",
          tlsPrivateKey: "database-private-key",
          tlsPassphrase: "database-tls-passphrase",
        }).toString(),
      });
      expect(submitted.body).toContain("操作已完成");
      expect(submitted.body).not.toMatch(/database-password|database-private-key|database-tls-passphrase/);

      const root = await db.prepare("SELECT id, credential_ciphertext, options_json FROM database_connections WHERE name = ?").get("Secure database") as {
        id: string;
        credential_ciphertext: string;
        options_json: string;
      };
      expect(root.options_json).not.toMatch(/database-ca|database-certificate|database-private-key|database-tls-passphrase/);
      expect(JSON.parse(root.options_json).ssl).toEqual({ enabled: true, rejectUnauthorized: true });
      expect(JSON.parse(app.secrets.decrypt(root.credential_ciphertext))).toMatchObject({
        password: "database-password",
        tlsCa: "database-ca",
        tlsCertificate: "database-certificate",
        tlsPrivateKey: "database-private-key",
        tlsPassphrase: "database-tls-passphrase",
      });

      const listed = await callOperation(client, "viron_read", "viron_connections_list", { type: "database", includeProfiles: true });
      expect(JSON.stringify(listed)).not.toMatch(/database-password|database-ca|database-certificate|database-private-key|database-tls-passphrase/);
      expect(listed.structuredContent).toMatchObject({
        result: { data: { items: [expect.objectContaining({ id: root.id, hasPassword: true, hasTlsCa: true, hasTlsPrivateKey: true })] } },
      });

      const profileConfig = {
        profileName: "Read replica",
        engine: "mysql" as const,
        host: "replica.example.test",
        port: 3306,
        username: "reader",
        defaultDatabase: "app",
        connectionMode: "tcp" as const,
        options: configInput.options,
      };
      const profileCreated = await callOperation(client, "viron_secure", "viron_database_connection_profile_secure_create", { connectionId: root.id, config: profileConfig });
      const profileCreateOperation = (profileCreated.structuredContent as { result: { data: { operationId: string } } }).result.data;
      const profileSubmitted = await app.inject({
        method: "POST",
        url: `/mcp/operations/${profileCreateOperation.operationId}/submit`,
        cookies,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ tlsPrivateKey: "profile-private-key" }).toString(),
      });
      expect(profileSubmitted.body).toContain("操作已完成");
      const profile = await db.prepare("SELECT id, credential_ciphertext, options_json FROM database_connections WHERE profile_parent_id = ?").get(root.id) as {
        id: string;
        credential_ciphertext: string;
        options_json: string;
      };
      expect(JSON.parse(app.secrets.decrypt(profile.credential_ciphertext))).toMatchObject({
        password: "database-password",
        tlsCa: "database-ca",
        tlsPrivateKey: "profile-private-key",
      });
      expect(profile.options_json).not.toContain("profile-private-key");

      const profileUpdated = await callOperation(client, "viron_secure", "viron_database_connection_profile_secure_update", {
        connectionId: root.id,
        profileId: profile.id,
        config: { ...profileConfig, host: "replica-2.example.test" },
      });
      const profileUpdateOperation = (profileUpdated.structuredContent as { result: { data: { operationId: string } } }).result.data;
      const profileUpdateSubmitted = await app.inject({
        method: "POST",
        url: `/mcp/operations/${profileUpdateOperation.operationId}/submit`,
        cookies,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "",
      });
      expect(profileUpdateSubmitted.body).toContain("操作已完成");
      const updatedProfile = await db.prepare("SELECT host, credential_ciphertext FROM database_connections WHERE id = ?").get(profile.id) as { host: string; credential_ciphertext: string };
      expect(updatedProfile.host).toBe("replica-2.example.test");
      expect(JSON.parse(app.secrets.decrypt(updatedProfile.credential_ciphertext))).toMatchObject({ tlsPrivateKey: "profile-private-key" });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("migrates legacy database TLS options into encrypted credentials at service startup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-database-migration-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const secrets = createSecretBox(config.masterKey);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO database_connections (
        id, workspace_type, workspace_id, name, engine, host, port, username, credential_ciphertext,
        default_database, connection_mode, options_json, created_at, updated_at
      ) VALUES (?, 'personal', ?, ?, 'mysql', 'legacy.example.test', 3306, 'operator', ?, '', 'tcp', ?, ?, ?)
    `).run(
      id,
      admin.id,
      "Legacy TLS",
      secrets.encrypt(JSON.stringify({ password: "legacy-password" })),
      JSON.stringify({ ssl: { enabled: true, rejectUnauthorized: true, ca: "legacy-ca", privateKey: "legacy-private-key", passphrase: "legacy-passphrase" } }),
      now,
      now,
    );
    const app = await buildApp({ config, db, logger: false });
    try {
      const migrated = await db.prepare("SELECT credential_ciphertext, options_json FROM database_connections WHERE id = ?").get(id) as { credential_ciphertext: string; options_json: string };
      expect(JSON.parse(migrated.options_json).ssl).toEqual({ enabled: true, rejectUnauthorized: true });
      expect(JSON.parse(app.secrets.decrypt(migrated.credential_ciphertext))).toMatchObject({
        password: "legacy-password",
        tlsCa: "legacy-ca",
        tlsPrivateKey: "legacy-private-key",
        tlsPassphrase: "legacy-passphrase",
      });
    } finally {
      await app.close();
    }
  });

  it("accepts connection import files only through the session-bound multipart safety page", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-import-operation-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "codex-import", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key.apiKey}` } } });
    const client = new Client({ name: "viron-mcp-import-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const created = await callOperation(client, "viron_secure", "viron_connection_import_secure_preview", { type: "navicat" });
      const operation = (created.structuredContent as { result: { data: { operationId: string } } }).result.data;
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
      const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
      const boundary = "viron-mcp-import-boundary";
      const xml = '<Connections><Connection ConnType="MYSQL" ConnectionName="MCP imported" Host="db-import.example.test" Port="3306" UserName="operator" /></Connections>';
      const submitted = await app.inject({
        method: "POST",
        url: `/mcp/operations/${operation.operationId}/submit`,
        cookies,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, { passphrase: "" }, "connections.ncx", xml),
      });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.body).toContain("操作已完成");
      expect(submitted.body).not.toContain(xml);
      const status = await client.callTool({ name: "viron_operation_status", arguments: { operationId: operation.operationId } });
      expect(status.structuredContent).toMatchObject({
        result: { status: 200, data: { status: "completed", result: { status: 201, data: { batch: { filename: "connections.ncx", items: [expect.objectContaining({ name: "MCP imported" })] } } } } },
      });
      expect(JSON.stringify(status)).not.toContain(xml);
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("validates, executes, and audits MCP Web page controls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-web-control-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: config.adminUsername, password: config.adminPassword } });
    const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "MCP Web control" } });
    const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Console", url: "https://example.com" } });
    const credential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies, payload: { username: "operator", password: "web-secret", note: "", customFields: {} } });
    const calls: unknown[] = [];
    app.webAccountViews.semanticControl = async (user, credentialId, input, scope) => {
      calls.push({ userId: user.id, credentialId, input, scope });
      return {
        view: { id: "view-1", credentialId, entryId: entry.json().id, entryName: "Console", username: "operator", url: input.url ?? "https://example.com", title: "Controlled", connected: true, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), viewport: { width: 1280, height: 720 } },
        action: input.action,
        url: input.url ?? "https://example.com",
        title: "Controlled",
      };
    };
    const invalid = await app.inject({ method: "POST", url: `/api/v1/mcp/web-credentials/${credential.json().id}/control`, cookies, payload: { action: "navigate" } });
    expect(invalid.statusCode).toBe(400);
    const scope = crypto.randomUUID();
    const controlled = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/web-credentials/${credential.json().id}/control`,
      cookies,
      headers: { "x-viron-execution-scope": scope },
      payload: { action: "navigate", url: "https://example.com/next" },
    });
    expect(controlled.statusCode).toBe(200);
    expect(controlled.json()).toMatchObject({ action: "navigate", url: "https://example.com/next", title: "Controlled" });
    expect(calls).toEqual([expect.objectContaining({ credentialId: credential.json().id, input: { action: "navigate", url: "https://example.com/next" }, scope })]);
    const audit = await db.prepare("SELECT action, details_json FROM audit_events WHERE resource_id = ? AND action = ?").get(credential.json().id, "mcp.web_control_executed") as { action: string; details_json: string };
    expect(audit.action).toBe("mcp.web_control_executed");
    expect(JSON.parse(audit.details_json)).toMatchObject({ action: "navigate", url: "https://example.com/next" });
    await app.close();
  });

  it("requires Viron confirmation and a one-time App lease before desktop execution can complete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-confirm-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: config.adminUsername, password: config.adminPassword },
    });
    const cookies = Object.fromEntries(login.cookies.map((cookie) => [cookie.name, cookie.value]));
    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: { name: "Desktop SSH", host: "127.0.0.1", port: 22, username: "root", authType: "password", credential: { password: "desktop-secret" } },
    });
    expect(connection.statusCode).toBe(201);
    const connectionId = connection.json().id as string;
    const scope = crypto.randomUUID();
    const operation = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: { "x-viron-execution-mode": "local", "x-viron-execution-scope": scope, "x-viron-mcp-origin": "http://localhost:5173" },
      payload: {
        action: "viron_ssh_command_request",
        arguments: { connectionId, command: "touch /tmp/desktop-confirmed", timeoutMs: 30_000, maxBytes: 64 * 1024 },
      },
    });
    expect(operation.statusCode).toBe(201);
    const publicOperation = operation.json() as {
      operationId: string;
      status: string;
      purpose: string | null;
      actionUrl: string | null;
      nextAction: { tool: string; arguments: { operationId: string; workspace: string }; purposeMinLength: number; purposeMaxLength: number };
    };
    const lease = operation.headers["x-viron-mcp-desktop-lease"]?.toString();
    expect(publicOperation).toMatchObject({
      status: "awaiting_purpose",
      purpose: null,
      actionUrl: null,
      nextAction: {
        tool: "viron_operation_purpose_provide",
        arguments: { operationId: publicOperation.operationId, workspace: "personal" },
        purposeMinLength: 8,
        purposeMaxLength: 80,
      },
    });
    expect(lease).toBeTruthy();
    expect(operation.body).not.toContain(String(lease));

    const waitingPage = await app.inject({ method: "GET", url: `/mcp/operations/${publicOperation.operationId}`, cookies });
    expect(waitingPage.body).toContain("正在等待 Agent 补充执行意图");
    expect(waitingPage.body).not.toContain("确认执行</button>");

    const invalidPurpose = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/operations/${publicOperation.operationId}/purpose`,
      cookies,
      payload: { purpose: "太短" },
    });
    expect(invalidPurpose.statusCode).toBe(400);

    const purpose = "验证桌面 SSH 写操作的审批链路与一次性执行租约";
    const purposeProvided = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/operations/${publicOperation.operationId}/purpose`,
      cookies,
      payload: { purpose },
    });
    expect(purposeProvided.statusCode).toBe(200);
    expect(purposeProvided.json()).toMatchObject({
      status: "pending",
      purpose,
      actionUrl: `http://localhost:5173/mcp/operations/${publicOperation.operationId}`,
    });
    expect(purposeProvided.json().nextAction).toBeUndefined();

    const repeatedPurpose = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/operations/${publicOperation.operationId}/purpose`,
      cookies,
      payload: { purpose: "尝试覆盖已经提交的 Agent 执行意图说明" },
    });
    expect(repeatedPurpose.statusCode).toBe(409);

    const approvalPage = await app.inject({ method: "GET", url: `/mcp/operations/${publicOperation.operationId}`, cookies });
    expect(approvalPage.body).toContain("AGENT 提供的执行意图");
    expect(approvalPage.body).toContain(purpose);
    expect(approvalPage.body).toContain("请仍以实际操作内容为准");
    expect(approvalPage.body).toContain("待执行命令");
    expect(approvalPage.body).toContain("touch /tmp/desktop-confirmed");
    expect(approvalPage.body).not.toContain("我已核对目标、参数和影响范围");

    const purposeAudit = await db.prepare("SELECT details_json FROM audit_events WHERE resource_id = ? AND action = ?").get(publicOperation.operationId, "mcp.operation_purpose_provided") as { details_json: string };
    expect(JSON.parse(purposeAudit.details_json)).toMatchObject({ purpose, action: "viron_ssh_command_request", executionTarget: "desktop" });

    const approved = await app.inject({
      method: "POST",
      url: `/mcp/operations/${publicOperation.operationId}/submit`,
      cookies,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(approved.body).toContain("已确认");
    const approvedStatus = await app.inject({ method: "GET", url: `/api/v1/mcp/operations/${publicOperation.operationId}`, cookies });
    expect(approvedStatus.json().status).toBe("approved");

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/operations/${publicOperation.operationId}/desktop-result`,
      cookies,
      payload: { lease, response: { status: 200, headers: { "content-type": "application/json" }, data: { stdout: "desktop-confirmed", exitCode: 0 } } },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: "completed", result: { status: 200, data: { stdout: "desktop-confirmed" } } });
    expect(completed.body).not.toContain(String(lease));

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/mcp/operations/${publicOperation.operationId}/desktop-result`,
      cookies,
      payload: { lease, response: { status: 200, headers: {}, data: { duplicated: true } } },
    });
    expect(replay.statusCode).toBe(409);

    const automaticSsh = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: {
        "x-viron-execution-mode": "local",
        "x-viron-execution-scope": scope,
        "x-viron-mcp-origin": "http://localhost:5173",
        "x-viron-mcp-approval-mode": "always",
      },
      payload: {
        action: "viron_ssh_command_request",
        arguments: { connectionId, command: "tail -n 500 -- /var/log/viron.log", timeoutMs: 30_000, maxBytes: 64 * 1024 },
      },
    });
    expect(automaticSsh.statusCode).toBe(201);
    expect(automaticSsh.json()).toMatchObject({ status: "approved", riskLevel: "low", purpose: null });
    expect(automaticSsh.json().nextAction).toBeUndefined();
    expect(automaticSsh.headers["x-viron-mcp-desktop-lease"]).toBeTruthy();

    const automaticMedium = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: {
        "x-viron-execution-mode": "local",
        "x-viron-execution-scope": scope,
        "x-viron-mcp-origin": "http://localhost:5173",
        "x-viron-mcp-approval-mode": "high-risk",
      },
      payload: {
        action: "viron_sftp_mkdir_request",
        arguments: { connectionId, path: "/tmp/viron-mcp-approval-test" },
      },
    });
    expect(automaticMedium.statusCode).toBe(201);
    expect(automaticMedium.json()).toMatchObject({ status: "approved", riskLevel: "medium", purpose: null });
    expect(automaticMedium.json().nextAction).toBeUndefined();

    const guardedHighRisk = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: {
        "x-viron-execution-mode": "local",
        "x-viron-execution-scope": scope,
        "x-viron-mcp-origin": "http://localhost:5173",
        "x-viron-mcp-approval-mode": "high-risk",
      },
      payload: {
        action: "viron_ssh_command_request",
        arguments: { connectionId, command: "touch /tmp/guarded-high-risk", timeoutMs: 30_000, maxBytes: 64 * 1024 },
      },
    });
    expect(guardedHighRisk.statusCode).toBe(201);
    expect(guardedHighRisk.json()).toMatchObject({
      status: "awaiting_purpose",
      riskLevel: "high",
      purpose: null,
      actionUrl: null,
      nextAction: { tool: "viron_operation_purpose_provide" },
    });

    const automaticServerForward = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: {
        "x-viron-execution-mode": "server",
        "x-viron-execution-scope": scope,
        "x-viron-mcp-approval-mode": "never",
      },
      payload: {
        action: "viron_business_risk_request",
        arguments: {
          operation: "database_automation_run",
          input: { automationId: crypto.randomUUID() },
        },
      },
    });
    expect(automaticServerForward.statusCode).toBe(201);
    expect(automaticServerForward.json()).toMatchObject({ status: "failed", riskLevel: "high" });
    expect(automaticServerForward.headers["x-viron-mcp-desktop-lease"]).toBeUndefined();

    for (const response of [automaticSsh, automaticMedium, guardedHighRisk, automaticServerForward]) {
      await app.inject({ method: "DELETE", url: `/api/v1/mcp/operations/${response.json().operationId}`, cookies });
    }

    const database = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        name: "Desktop database",
        engine: "mysql",
        host: "127.0.0.1",
        port: 3306,
        username: "operator",
        credential: { password: "database-secret" },
        defaultDatabase: "ops",
        connectionMode: "tcp",
      },
    });
    expect(database.statusCode).toBe(201);
    const localBackup = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: { "x-viron-execution-mode": "local", "x-viron-execution-scope": crypto.randomUUID() },
      payload: {
        action: "viron_business_risk_request",
        arguments: { operation: "database_backup_start", input: { connectionId: database.json().id, database: "ops", includeData: true } },
      },
    });
    expect(localBackup.statusCode).toBe(201);
    expect(localBackup.headers["x-viron-mcp-desktop-lease"]).toBeTruthy();

    const source = await app.inject({
      method: "POST",
      url: "/api/v1/connection-sources/script",
      cookies,
      payload: { name: "Server inventory", script: "console.log(JSON.stringify({ environments: [] }))", conflictStrategy: "ignore", scheduleEnabled: false, scheduleExpression: "" },
    });
    expect(source.statusCode).toBe(201);
    const serverSync = await app.inject({
      method: "POST",
      url: "/api/v1/mcp/operations",
      cookies,
      headers: { "x-viron-execution-mode": "local", "x-viron-execution-scope": crypto.randomUUID() },
      payload: {
        action: "viron_business_risk_request",
        arguments: { operation: "connection_source_sync", input: { sourceId: source.json().id } },
      },
    });
    expect(serverSync.statusCode).toBe(201);
    expect(serverSync.headers["x-viron-mcp-desktop-lease"]).toBeUndefined();
    await app.close();
  });

  it("provides core environment, knowledge, Web entry, and connection-organization mutations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-crud-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = ?").get(config.adminUsername) as { id: string };
    const key = await issueApiKey(db, "personal", admin.id, "codex-crud", admin.id);
    const app = await buildApp({ config, db, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "viron-mcp-crud-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key.apiKey}` } },
    });
    const dataFor = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.structuredContent as { result: { status: number; data: Record<string, unknown> } }).result;
    try {
      await client.connect(transport);
      const group = dataFor(await callOperation(client, "viron_change", "viron_environment_group_create", {
        group: { name: "MCP Group", description: "managed by MCP", color: "#19705f" },
      }));
      expect(group.status).toBe(201);
      const groupId = group.data.id as string;
      const environment = dataFor(await callOperation(client, "viron_change", "viron_environment_create", {
        environment: { groupId, name: "MCP Environment", shortName: "MCP", status: "active", tags: ["agent"] },
      }));
      expect(environment.status).toBe(201);
      const environmentId = environment.data.id as string;

      const connectionGroup = dataFor(await callOperation(client, "viron_change", "viron_connection_group_create", { type: "ssh", name: "Managed" }));
      expect(connectionGroup.status).toBe(201);

      const document = dataFor(await callOperation(client, "viron_change", "viron_knowledge_node_create", {
        environmentId,
        node: { type: "document", name: "Runbook", parentId: null },
      }));
      expect(document.status).toBe(201);
      const documentId = document.data.id as string;
      const saved = dataFor(await callOperation(client, "viron_change", "viron_knowledge_document_content_update", {
        documentId,
        revision: 1,
        content: "# Runbook\n\nManaged by Viron MCP.",
      }));
      expect(saved.status).toBe(200);
      expect(saved.data.revision).toBe(2);

      const webEntry = dataFor(await callOperation(client, "viron_change", "viron_web_entry_create", {
        environmentId,
        entry: { name: "Console", url: "https://example.com", description: "MCP test", tags: ["console"] },
      }));
      expect(webEntry.status).toBe(201);
      const listed = dataFor(await callOperation(client, "viron_read", "viron_environment_web_entries_list", { environmentId }));
      expect(listed.data).toMatchObject({ items: [expect.objectContaining({ id: webEntry.data.id, name: "Console" })] });

      const deletedEnvironment = dataFor(await callOperation(client, "viron_change", "viron_environment_delete", { environmentId }));
      expect(deletedEnvironment.status).toBe(204);
      const deletedConnectionGroup = dataFor(await callOperation(client, "viron_change", "viron_connection_group_delete", { groupId: connectionGroup.data.id }));
      expect(deletedConnectionGroup.status).toBe(204);
      const deletedGroup = dataFor(await callOperation(client, "viron_change", "viron_environment_group_delete", { groupId }));
      expect(deletedGroup.status).toBe(204);
    } finally {
      await client.close();
      await app.close();
    }
  });
});
