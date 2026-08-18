import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    masterKey: Buffer.alloc(32, 14),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function waitForAutomation(app: Awaited<ReturnType<typeof buildApp>>, id: string, cookies: Record<string, string>) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/v1/database-automations", cookies });
    const item = response.json().items.find((candidate: { id: string }) => candidate.id === id);
    if (item && item.status !== "running") return item;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for automation");
}

describe("database automation and model artifacts", () => {
  it("persists automation lifecycle, schedule state, manual runs, and model workspaces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-database-artifacts-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: { name: "Primary", engine: "mysql", host: "127.0.0.1", port: 3306, username: "root", credential: { password: "secret" } },
    });
    const connectionId = connection.json().id as string;

    const automation = await app.inject({
      method: "POST",
      url: "/api/v1/database-automations",
      cookies,
      payload: { connectionId, database: "billing", name: "Nightly", works: [], advanced: {}, scheduleCron: "0 2 * * *", scheduleEnabled: true },
    });
    expect(automation.statusCode).toBe(201);
    const automationId = automation.json().item.id as string;
    expect(automation.json().item).toMatchObject({ name: "Nightly", scheduleEnabled: true, status: "idle" });

    expect((await app.inject({ method: "POST", url: `/api/v1/database-automations/${automationId}/run`, cookies })).statusCode).toBe(202);
    expect(await waitForAutomation(app, automationId, cookies)).toMatchObject({ status: "success", lastRunAt: expect.any(String) });

    const updatedAutomation = await app.inject({
      method: "PUT",
      url: `/api/v1/database-automations/${automationId}`,
      cookies,
      payload: { connectionId, database: "analytics", name: "Nightly analytics", works: [], advanced: { retries: 1 }, scheduleCron: "30 3 * * *", scheduleEnabled: true },
    });
    expect(updatedAutomation.statusCode).toBe(200);
    expect(updatedAutomation.json().item).toMatchObject({ database: "analytics", name: "Nightly analytics", scheduleCron: "30 3 * * *" });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-automations/${automationId}/schedule`, cookies })).statusCode).toBe(204);

    const model = await app.inject({
      method: "POST",
      url: "/api/v1/database-models",
      cookies,
      payload: {
        connectionId,
        database: "billing",
        name: "Billing model",
        modelType: "physical",
        databaseEngine: "MySQL",
        databaseVersion: "8.1",
        model: { nodes: [{ id: "orders", kind: "table", name: "orders", x: 20, y: 20, fields: [] }], edges: [], settings: {} },
      },
    });
    expect(model.statusCode).toBe(201);
    const modelId = model.json().item.id as string;
    expect(model.json().item).toMatchObject({ name: "Billing model", ownerName: "admin", modelType: "physical" });

    const updatedModel = await app.inject({
      method: "PUT",
      url: `/api/v1/database-models/${modelId}`,
      cookies,
      payload: { connectionId, database: "billing", name: "Billing model v2", modelType: "logical", databaseEngine: "MySQL", databaseVersion: "8.0", model: { nodes: [], edges: [], settings: {} } },
    });
    expect(updatedModel.statusCode).toBe(200);
    expect(updatedModel.json().item).toMatchObject({ name: "Billing model v2", modelType: "logical", databaseVersion: "8.0" });
    expect((await app.inject({ method: "POST", url: `/api/v1/database-models/${modelId}/access`, cookies })).statusCode).toBe(200);

    const snippet = await app.inject({ method: "POST", url: "/api/v1/database-code-snippets", cookies, payload: { name: "Find invoices", description: "Billing lookup", sql: "SELECT * FROM invoices" } });
    expect(snippet.statusCode).toBe(201);
    const snippetId = snippet.json().item.id as string;
    expect((await app.inject({ method: "PUT", url: `/api/v1/database-code-snippets/${snippetId}`, cookies, payload: { name: "Find overdue invoices", description: "Billing lookup", sql: "SELECT * FROM invoices WHERE overdue = 1" } })).json().item).toMatchObject({ name: "Find overdue invoices" });
    expect((await app.inject({ method: "GET", url: "/api/v1/database-code-snippets", cookies })).json().items).toHaveLength(1);

    const bi = await app.inject({ method: "POST", url: "/api/v1/database-bi-workspaces", cookies, payload: { connectionId, name: "Billing BI", document: { theme: "system", dataSources: [], charts: [], dashboards: [] } } });
    expect(bi.statusCode).toBe(201);
    const biId = bi.json().item.id as string;
    expect(bi.json().item).toMatchObject({ name: "Billing BI", ownerName: "admin" });
    expect((await app.inject({ method: "PUT", url: `/api/v1/database-bi-workspaces/${biId}`, cookies, payload: { connectionId, name: "Billing BI v2", document: { theme: "dark", dataSources: [], charts: [], dashboards: [] } } })).json().item).toMatchObject({ name: "Billing BI v2", document: { theme: "dark" } });
    expect((await app.inject({ method: "POST", url: `/api/v1/database-bi-workspaces/${biId}/access`, cookies })).statusCode).toBe(200);

    const group = await app.inject({ method: "POST", url: "/api/v1/database-object-groups", cookies, payload: { connectionId, database: "billing", category: "tables", name: "Core" } });
    expect(group.statusCode).toBe(201);
    const groupId = group.json().id as string;
    const secondaryGroup = await app.inject({ method: "POST", url: "/api/v1/database-object-groups", cookies, payload: { connectionId, database: "billing", category: "tables", name: "Secondary" } });
    const secondaryGroupId = secondaryGroup.json().id as string;
    const analyticsGroup = await app.inject({ method: "POST", url: "/api/v1/database-object-groups", cookies, payload: { connectionId, database: "analytics", category: "tables", name: "Analytics" } });
    const analyticsGroupId = analyticsGroup.json().id as string;
    expect((await app.inject({ method: "POST", url: `/api/v1/database-object-groups/${groupId}/members`, cookies, payload: { objectName: "invoices", objectSource: "tables" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/database-object-groups/${analyticsGroupId}/members`, cookies, payload: { objectName: "invoices", objectSource: "tables" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/database-object-groups/${secondaryGroupId}/members`, cookies, payload: { objectName: "invoices", objectSource: "tables" } })).statusCode).toBe(201);
    const groupedObjects = (await app.inject({ method: "GET", url: `/api/v1/database-object-groups?connectionId=${connectionId}`, cookies })).json().items as Array<{ name: string; database: string; members: unknown[] }>;
    expect(groupedObjects.find((item) => item.name === "Core")?.members).toEqual([]);
    expect(groupedObjects.find((item) => item.name === "Secondary")?.members).toEqual([{ objectName: "invoices", objectSource: "tables" }]);
    expect(groupedObjects.find((item) => item.name === "Analytics")?.members).toEqual([{ objectName: "invoices", objectSource: "tables" }]);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-object-groups/${secondaryGroupId}/members?objectName=invoices&objectSource=tables`, cookies })).statusCode).toBe(204);

    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-object-groups/${groupId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-object-groups/${secondaryGroupId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-object-groups/${analyticsGroupId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-bi-workspaces/${biId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-code-snippets/${snippetId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-models/${modelId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-automations/${automationId}`, cookies })).statusCode).toBe(204);
    await app.close();
  });
});
