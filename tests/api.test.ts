import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { PRODUCT_VERSION } from "../src/server/product-info.js";

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
    masterKey: Buffer.alloc(32, 7),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("Viron API", () => {
  it("issues matching 45-day server and cookie expirations for a login", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-session-ttl-test-"));
    directories.push(directory);
    const config = { ...configFor(directory), sessionTtlHours: 45 * 24 };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: config.adminUsername, password: config.adminPassword },
    });
    const session = await db.prepare("SELECT created_at, expires_at FROM sessions").get() as { created_at: string; expires_at: string };

    expect(login.statusCode).toBe(200);
    expect(login.cookies.find((item) => item.name === "envman_session")?.maxAge).toBe(45 * 24 * 60 * 60);
    expect(Date.parse(session.expires_at) - Date.parse(session.created_at)).toBe(45 * 24 * 60 * 60 * 1000);
    await app.close();
  });

  it("does not force plain HTTP deployments to load assets over HTTPS", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-http-headers-test-"));
    directories.push(directory);
    const config = { ...configFor(directory), nodeEnv: "production" as const, cookieSecure: false };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    expect(response.headers["strict-transport-security"]).toBeUndefined();

    await app.close();
  });

  it("keeps HTTPS enforcement for secure-cookie deployments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-https-headers-test-"));
    directories.push(directory);
    const config = { ...configFor(directory), nodeEnv: "production" as const, cookieSecure: true };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.headers["content-security-policy"]).toContain("upgrade-insecure-requests");
    expect(response.headers["strict-transport-security"]).toBeDefined();

    await app.close();
  });

  it("advertises the product identity and compatible API protocol without authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      version: PRODUCT_VERSION,
      product: "viron",
      productVersion: PRODUCT_VERSION,
      apiProtocol: { min: 1, max: 2 },
      mcp: {
        server: {
          enabled: false,
          path: "/mcp",
          transport: "streamable-http",
          authentication: "personal-api-key",
        },
      },
    });

    const capabilities = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      product: "viron",
      clientAccess: { desktop: true, web: true },
      desktopLocal: { web: true, ssh: true, sftp: true, logs: true, database: true, redis: true, inspection: true },
      mcp: { server: { enabled: false, path: "/mcp" } },
      serverForwarding: { enabled: true, web: true, ssh: true, sftp: true, logs: true, database: true, redis: true },
    });

    await app.close();
  });

  it("publishes and downloads every current desktop installer from the shared catalog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-version-test-"));
    directories.push(directory);
    const installerDirectory = join(directory, "installers");
    mkdirSync(installerDirectory, { recursive: true });
    const files = {
      macosArm64: `Viron-${PRODUCT_VERSION}-macos-arm64-self-signed.dmg`,
      macosX64: `Viron-${PRODUCT_VERSION}-macos-x64-self-signed.dmg`,
      windowsX86: `Viron-${PRODUCT_VERSION}-windows-x86-unsigned-setup.exe`,
      windowsX64: `Viron-${PRODUCT_VERSION}-windows-x64-unsigned-setup.exe`,
      windowsArm64: `Viron-${PRODUCT_VERSION}-windows-arm64-unsigned-setup.exe`,
    };
    for (const [target, fileName] of Object.entries(files)) {
      writeFileSync(join(installerDirectory, fileName), `${target}-installer`);
    }
    writeFileSync(join(installerDirectory, "Viron-9.9.9-windows-x86-unsigned-setup.exe"), "future-installer");
    writeFileSync(join(installerDirectory, `Viron-${PRODUCT_VERSION}-windows-unknown.exe`), "unknown-installer");
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const version = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(version.statusCode).toBe(200);
    expect(version.headers["cache-control"]).toBe("no-store");
    expect(version.json()).toMatchObject({
      product: "viron",
      serverVersion: PRODUCT_VERSION,
      apiVersion: 2,
      apiProtocol: { min: 1, max: 2 },
      clients: {
        macos: {
          latestVersion: PRODUCT_VERSION,
          installers: {
            arm64: {
              available: true,
              version: PRODUCT_VERSION,
              downloadUrl: "/api/v1/desktop-installers/macos/arm64",
              fileName: files.macosArm64,
            },
            x64: {
              available: true,
              version: PRODUCT_VERSION,
              downloadUrl: "/api/v1/desktop-installers/macos/x64",
              fileName: files.macosX64,
            },
          },
        },
        windows: {
          latestVersion: PRODUCT_VERSION,
          installers: {
            x86: { available: true, version: PRODUCT_VERSION, fileName: files.windowsX86 },
            x64: { available: true, version: PRODUCT_VERSION, fileName: files.windowsX64 },
            arm64: { available: true, version: PRODUCT_VERSION, fileName: files.windowsArm64 },
          },
        },
      },
    });

    const download = await app.inject({ method: "GET", url: "/api/v1/desktop-installers/windows/x86" });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/vnd.microsoft.portable-executable");
    expect(download.headers["content-disposition"]).toContain(files.windowsX86);
    expect(download.rawPayload).toEqual(Buffer.from("windowsX86-installer"));

    rmSync(join(installerDirectory, files.windowsX86));
    const unavailable = await app.inject({ method: "GET", url: "/api/v1/desktop-installers/windows/x86" });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toMatchObject({ error: "DESKTOP_INSTALLER_NOT_AVAILABLE" });
    const refreshedVersion = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(refreshedVersion.json().clients.windows.installers.x86).toMatchObject({ available: false, version: null });

    const universal = `Viron-${PRODUCT_VERSION}-windows-universal-unsigned-setup.exe`;
    writeFileSync(join(installerDirectory, universal), "universal-windows-installer");
    const fallbackVersion = await app.inject({ method: "GET", url: "/api/v1/version" });
    expect(fallbackVersion.json().clients.windows.installers.x86).toMatchObject({
      available: true,
      version: PRODUCT_VERSION,
      fileName: universal,
      downloadUrl: "/api/v1/desktop-installers/windows/x86",
    });
    const fallbackDownload = await app.inject({ method: "GET", url: "/api/v1/desktop-installers/windows/x86" });
    expect(fallbackDownload.statusCode).toBe(200);
    expect(fallbackDownload.rawPayload).toEqual(Buffer.from("universal-windows-installer"));
    await app.close();
  });

  it("keeps the authenticated Web catalog identical to the automatic update source", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-client-installers-test-"));
    directories.push(directory);
    const installerDirectory = join(directory, "installers");
    mkdirSync(installerDirectory, { recursive: true });
    const macosArm64 = `Viron-${PRODUCT_VERSION}-macos-arm64-self-signed.dmg`;
    const macosX64 = `Viron-${PRODUCT_VERSION}-macos-x64-self-signed.dmg`;
    const windowsX86 = `Viron-${PRODUCT_VERSION}-windows-x86-unsigned-setup.exe`;
    writeFileSync(join(installerDirectory, macosArm64), "arm-macos-client");
    writeFileSync(join(installerDirectory, macosX64), "intel-macos-client");
    writeFileSync(join(installerDirectory, windowsX86), "windows-client");
    writeFileSync(join(installerDirectory, "Viron-0.0.1-macos-arm64-self-signed.dmg"), "old-macos-client");
    writeFileSync(join(installerDirectory, "Viron-macos-arm64-self-signed.dmg"), "unversioned-macos-client");
    writeFileSync(join(installerDirectory, `Viron-${PRODUCT_VERSION}-windows.exe`), "unknown-windows-client");
    writeFileSync(join(installerDirectory, "notes.txt"), "not-an-installer");
    writeFileSync(join(installerDirectory, "empty.dmg"), "");
    mkdirSync(join(installerDirectory, "nested"));
    writeFileSync(join(installerDirectory, "nested", "Viron-9.9.9-macos-x64.dmg"), "nested-client");

    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/client-installers" });
    expect(unauthenticated.statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const catalog = await app.inject({ method: "GET", url: "/api/v1/client-installers", cookies });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers["cache-control"]).toBe("no-store");
    expect(catalog.json()).toEqual({
      items: [
        {
          fileName: windowsX86,
          platform: "windows",
          architecture: "x86",
          version: PRODUCT_VERSION,
          size: 14,
          downloadUrl: `/api/v1/client-installers/${windowsX86}/download`,
        },
        {
          fileName: macosArm64,
          platform: "macos",
          architecture: "arm64",
          version: PRODUCT_VERSION,
          size: 16,
          downloadUrl: `/api/v1/client-installers/${macosArm64}/download`,
        },
        {
          fileName: macosX64,
          platform: "macos",
          architecture: "x64",
          version: PRODUCT_VERSION,
          size: 18,
          downloadUrl: `/api/v1/client-installers/${macosX64}/download`,
        },
      ],
    });

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/client-installers/${macosArm64}/download`,
      cookies,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/x-apple-diskimage");
    expect(download.headers["content-disposition"]).toContain(macosArm64);
    expect(download.rawPayload).toEqual(Buffer.from("arm-macos-client"));

    const automatic = await app.inject({ method: "GET", url: "/api/v1/desktop-installers/macos/arm64" });
    expect(automatic.statusCode).toBe(200);
    expect(automatic.rawPayload).toEqual(download.rawPayload);

    const wrongVersion = await app.inject({ method: "GET", url: "/api/v1/client-installers/Viron-0.0.1-macos-arm64-self-signed.dmg/download", cookies });
    expect(wrongVersion.statusCode).toBe(404);
    expect(wrongVersion.json()).toMatchObject({ error: "CLIENT_INSTALLER_NOT_FOUND" });

    const missing = await app.inject({ method: "GET", url: "/api/v1/client-installers/notes.txt/download", cookies });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "CLIENT_INSTALLER_NOT_FOUND" });
    await app.close();
  });

  it("disables only the browser client and target Web forwarding in Lite mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-lite-test-"));
    directories.push(directory);
    const config = { ...configFor(directory), webClientEnabled: false };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const capabilities = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(capabilities.json()).toMatchObject({
      clientAccess: { desktop: true, web: false },
      desktopLocal: { web: true, ssh: true, sftp: true, logs: true, database: true, redis: true, inspection: true },
      serverForwarding: { enabled: true, web: false, ssh: true, sftp: true, logs: true, database: true, redis: true },
    });
    const targetWebForwarding = await app.inject({ method: "POST", url: "/api/v1/web-credentials/missing/view" });
    expect(targetWebForwarding.statusCode).toBe(404);

    await app.close();
  });

  it("closes only the requesting App execution scope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-execution-scope-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookie = login.cookies.find((item) => item.name === "envman_session")!;
    const user = await db.prepare("SELECT id FROM admin_users WHERE username = 'admin'").get() as { id: string };
    const scope = crypto.randomUUID();
    const sshClose = vi.spyOn(app.sshSessions, "closeOwner");
    const webClose = vi.spyOn(app.webAccountViews, "closeOwner");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/execution-runtime/close",
      cookies: { envman_session: cookie.value },
      headers: { "x-viron-execution-scope": scope },
    });

    expect(response.statusCode).toBe(204);
    expect(sshClose).toHaveBeenCalledWith(user.id, "App 连接模式已切换", scope);
    expect(webClose).toHaveBeenCalledWith(user.id, "App 连接模式已切换", scope);
    await app.close();
  });

  it("counts only resources from the requesting App execution scope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-execution-activity-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookie = login.cookies.find((item) => item.name === "envman_session")!;
    const scope = crypto.randomUUID();
    const sshCount = vi.spyOn(app.sshSessions, "activeCount").mockReturnValue(2);
    const webCount = vi.spyOn(app.webAccountViews, "activeCount").mockReturnValue(1);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/execution-runtime",
      cookies: { envman_session: cookie.value },
      headers: { "x-viron-execution-scope": scope },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ counts: { web: 1, ssh: 2 }, total: 3 });
    expect(sshCount).toHaveBeenCalledWith(expect.any(String), scope);
    expect(webCount).toHaveBeenCalledWith(expect.any(String), scope);
    await app.close();
  });

  it("lists the current user's global connection quota and closes a selected connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-active-connections-api-test-"));
    directories.push(directory);
    const config = { ...configFor(directory), userConnectionLimit: 30, connectionIdleMinutes: 30 };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: config.adminPassword } });
    const cookie = login.cookies.find((item) => item.name === "envman_session")!;
    const row = await db.prepare("SELECT id, username FROM admin_users WHERE username = 'admin'").get() as { id: string; username: string };
    const closed = vi.fn();
    const item = await app.activeConnections.reserve({
      user: { id: row.id, username: row.username, isPlatformAdmin: true, workspace: { type: "personal", id: row.id, name: "个人工作台", role: "owner" } },
      type: "ssh",
      resourceId: crypto.randomUUID(),
    });
    app.activeConnections.activate(item.id, closed);

    const listed = await app.inject({ method: "GET", url: "/api/v1/active-connections", cookies: { envman_session: cookie.value } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ current: 1, limit: 30, idleMinutes: 30, items: [{ id: item.id, type: "ssh", originEnvironmentId: null, traffic: { sentBytesPerSecond: 0, receivedBytesPerSecond: 0 } }] });

    const qualityPing = await app.inject({ method: "GET", url: "/api/v1/connection-quality/ping", cookies: { envman_session: cookie.value } });
    expect(qualityPing.statusCode).toBe(200);
    expect(qualityPing.headers["cache-control"]).toBe("no-store");
    expect(qualityPing.json().serverAt).toEqual(expect.any(Number));

    const qualityDownload = await app.inject({ method: "GET", url: "/api/v1/connection-quality/download?bytes=1024", cookies: { envman_session: cookie.value } });
    expect(qualityDownload.statusCode).toBe(200);
    expect(qualityDownload.body).toHaveLength(1024);

    const qualityUpload = await app.inject({ method: "POST", url: "/api/v1/connection-quality/upload", cookies: { envman_session: cookie.value }, payload: { payload: "0".repeat(1024) } });
    expect(qualityUpload.statusCode).toBe(204);

    const settings = await app.inject({ method: "GET", url: "/api/v1/settings", cookies: { envman_session: cookie.value } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ item: { connectionIdleMinutes: 30, userConnectionLimit: 30, monitorPullIntervalSeconds: 60 } });
    const settingsUpdated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      cookies: { envman_session: cookie.value },
      payload: { auditRetentionDays: 30, monitorPullIntervalSeconds: 30 },
    });
    expect(settingsUpdated.statusCode).toBe(200);
    expect(config.monitorPullIntervalSeconds).toBe(30);

    const removed = await app.inject({ method: "DELETE", url: `/api/v1/active-connections/${item.id}`, cookies: { envman_session: cookie.value } });
    expect(removed.statusCode).toBe(204);
    expect(closed).toHaveBeenCalled();
    expect(app.activeConnections.activeCount(row.id)).toBe(0);
    await app.close();
  });

  it("migrates legacy SSH environment ownership and initializes tags", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const legacy = await openDatabase(config);
    legacy.exec("ALTER TABLE ssh_connections DROP COLUMN tags_json");
    const now = new Date().toISOString();
    const environmentId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    await legacy.prepare("INSERT INTO environments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(environmentId, "Legacy", now, now);
    await legacy.prepare(`
      INSERT INTO ssh_connections (id, environment_id, name, host, username, credential_ciphertext, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(connectionId, environmentId, "Legacy SSH", "10.0.0.1", "root", "legacy-ciphertext", now, now);
    await legacy.close();

    const migrated = await openDatabase(config);
    const association = await migrated.prepare("SELECT environment_id FROM ssh_connection_environments WHERE connection_id = ?").get(connectionId) as { environment_id: string };
    const connection = await migrated.prepare("SELECT tags_json FROM ssh_connections WHERE id = ?").get(connectionId) as { tags_json: string };
    expect(association.environment_id).toBe(environmentId);
    expect(JSON.parse(connection.tags_json)).toEqual([]);
    await migrated.close();
  });

  it("authenticates and persists an environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-password-123" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((item) => item.name === "envman_session");
    expect(cookie?.value).toBeTruthy();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      cookies: { envman_session: cookie!.value },
      payload: {
        name: "Integration Environment",
        shortName: "IT",
        status: "active",
        owner: "test",
        description: "stored in SQLite",
        tags: ["integration"],
      },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/environments",
      cookies: { envman_session: cookie!.value },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].name).toBe("Integration Environment");

    await app.close();
  });

  it("does not expose protected resources without a session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const response = await app.inject({ method: "GET", url: "/api/v1/environments" });
    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it("moves an environment between groups and back to ungrouped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-password-123" },
    });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const developmentGroup = await app.inject({
      method: "POST",
      url: "/api/v1/environment-groups",
      cookies,
      payload: { name: "Development", description: "", color: "#1d8a74" },
    });
    const productionGroup = await app.inject({
      method: "POST",
      url: "/api/v1/environment-groups",
      cookies,
      payload: { name: "Production", description: "", color: "#345f91" },
    });
    const developmentGroupId = developmentGroup.json().id as string;
    const productionGroupId = productionGroup.json().id as string;

    const environment = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      cookies,
      payload: { groupId: developmentGroupId, name: "Movable", shortName: "MOVE", status: "active", owner: "ops", description: "drag target", tags: ["drag"] },
    });
    const environmentId = environment.json().id as string;
    const moveToProduction = await app.inject({
      method: "PUT",
      url: `/api/v1/environments/${environmentId}`,
      cookies,
      payload: { groupId: productionGroupId, name: "Movable", shortName: "MOVE", status: "active", owner: "ops", description: "drag target", tags: ["drag"] },
    });
    expect(moveToProduction.statusCode).toBe(200);

    const groupedEnvironment = await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}`, cookies });
    expect(groupedEnvironment.json().item.groupId).toBe(productionGroupId);
    expect(groupedEnvironment.json().item.groupName).toBe("Production");
    const groupedCounts = await app.inject({ method: "GET", url: "/api/v1/environment-groups", cookies });
    expect(groupedCounts.json().items.find((item: { id: string }) => item.id === developmentGroupId).environmentCount).toBe(0);
    expect(groupedCounts.json().items.find((item: { id: string }) => item.id === productionGroupId).environmentCount).toBe(1);

    const moveToUngrouped = await app.inject({
      method: "PUT",
      url: `/api/v1/environments/${environmentId}`,
      cookies,
      payload: { groupId: null, name: "Movable", shortName: "MOVE", status: "active", owner: "ops", description: "drag target", tags: ["drag"] },
    });
    expect(moveToUngrouped.statusCode).toBe(200);
    const ungrouped = await app.inject({ method: "GET", url: "/api/v1/environments?groupId=ungrouped", cookies });
    expect(ungrouped.json().items.map((item: { id: string }) => item.id)).toContain(environmentId);

    await app.close();
  });

  it("persists environment group and card ordering", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-order-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };

    const groupIds: string[] = [];
    for (const name of ["Gamma", "Alpha", "Beta"]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/environment-groups", cookies, payload: { name, description: "", color: "#1d8a74" } });
      groupIds.push(response.json().id as string);
    }
    const orderedGroupIds = [groupIds[2], groupIds[0], groupIds[1]];
    const invalidGroupOrder = await app.inject({ method: "PUT", url: "/api/v1/environment-groups/order", cookies, payload: { orderedIds: orderedGroupIds.slice(0, 2) } });
    expect(invalidGroupOrder.statusCode).toBe(400);
    const reorderedGroups = await app.inject({ method: "PUT", url: "/api/v1/environment-groups/order", cookies, payload: { orderedIds: orderedGroupIds } });
    expect(reorderedGroups.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/environment-groups", cookies })).json().items.map((item: { id: string }) => item.id)).toEqual(orderedGroupIds);

    const environmentIds: string[] = [];
    for (const payload of [
      { groupId: groupIds[0], name: "First" },
      { groupId: groupIds[0], name: "Second" },
      { groupId: groupIds[1], name: "Third" },
      { groupId: null, name: "Fourth" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { ...payload, status: "active", tags: [] } });
      environmentIds.push(response.json().id as string);
    }
    const orderedEnvironments = [
      { id: environmentIds[1], groupId: groupIds[0] },
      { id: environmentIds[0], groupId: groupIds[0] },
      { id: environmentIds[3], groupId: groupIds[1] },
      { id: environmentIds[2], groupId: groupIds[1] },
    ];
    const invalidEnvironmentOrder = await app.inject({ method: "PUT", url: "/api/v1/environments/order", cookies, payload: { items: orderedEnvironments.slice(1) } });
    expect(invalidEnvironmentOrder.statusCode).toBe(400);
    const reorderedEnvironments = await app.inject({ method: "PUT", url: "/api/v1/environments/order", cookies, payload: { items: orderedEnvironments } });
    expect(reorderedEnvironments.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/environments?groupId=${groupIds[0]}`, cookies })).json().items.map((item: { id: string }) => item.id)).toEqual([environmentIds[1], environmentIds[0]]);
    expect((await app.inject({ method: "GET", url: `/api/v1/environments?groupId=${groupIds[1]}`, cookies })).json().items.map((item: { id: string }) => item.id)).toEqual([environmentIds[3], environmentIds[2]]);
    expect((await app.inject({ method: "GET", url: "/api/v1/environments?groupId=ungrouped", cookies })).json().items).toHaveLength(0);

    await app.close();

    const reopenedDb = await openDatabase(config);
    await ensureAdmin(reopenedDb, config);
    const reopenedApp = await buildApp({ config, db: reopenedDb, logger: false });
    const reopenedLogin = await reopenedApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const reopenedCookies = { envman_session: reopenedLogin.cookies.find((item) => item.name === "envman_session")!.value };
    expect((await reopenedApp.inject({ method: "GET", url: "/api/v1/environment-groups", cookies: reopenedCookies })).json().items.map((item: { id: string }) => item.id)).toEqual(orderedGroupIds);
    expect((await reopenedApp.inject({ method: "GET", url: `/api/v1/environments?groupId=${groupIds[1]}`, cookies: reopenedCookies })).json().items.map((item: { id: string }) => item.id)).toEqual([environmentIds[3], environmentIds[2]]);
    await reopenedApp.close();
  });

  it("persists Web entry and credential tab ordering", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-web-tab-order-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Web tabs", status: "active", tags: [] } });
    const environmentId = environment.json().id as string;

    const entryIds: string[] = [];
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/environments/${environmentId}/web-entries`,
        cookies,
        payload: { name, url: `https://${name.toLowerCase()}.example.com`, tags: [] },
      });
      entryIds.push(response.json().id as string);
    }
    const orderedEntryIds = [entryIds[2], entryIds[0], entryIds[1]];
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/environments/${environmentId}/web-entries/order`,
      cookies,
      payload: { orderedIds: orderedEntryIds.slice(1) },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/environments/${environmentId}/web-entries/order`,
      cookies,
      payload: { orderedIds: orderedEntryIds },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/web-entries`, cookies })).json().items.map((item: { id: string }) => item.id)).toEqual(orderedEntryIds);

    const credentialIds: string[] = [];
    for (const username of ["operator", "auditor", "admin"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/web-entries/${entryIds[0]}/credentials`,
        cookies,
        payload: { username, password: "web-secret", note: "", customFields: {} },
      });
      credentialIds.push(response.json().id as string);
    }
    const orderedCredentialIds = [credentialIds[1], credentialIds[2], credentialIds[0]];
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/web-entries/${entryIds[0]}/credentials/order`,
      cookies,
      payload: { orderedIds: [...orderedCredentialIds, "00000000-0000-4000-8000-000000000000"] },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/web-entries/${entryIds[0]}/credentials/order`,
      cookies,
      payload: { orderedIds: orderedCredentialIds },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/web-entries/${entryIds[0]}/credentials`, cookies })).json().items.map((item: { id: string }) => item.id)).toEqual(orderedCredentialIds);

    await app.close();
    const reopenedDb = await openDatabase(config);
    await ensureAdmin(reopenedDb, config);
    const reopenedApp = await buildApp({ config, db: reopenedDb, logger: false });
    const reopenedLogin = await reopenedApp.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const reopenedCookies = { envman_session: reopenedLogin.cookies.find((item) => item.name === "envman_session")!.value };
    expect((await reopenedApp.inject({ method: "GET", url: `/api/v1/environments/${environmentId}/web-entries`, cookies: reopenedCookies })).json().items.map((item: { id: string }) => item.id)).toEqual(orderedEntryIds);
    expect((await reopenedApp.inject({ method: "GET", url: `/api/v1/web-entries/${entryIds[0]}/credentials`, cookies: reopenedCookies })).json().items.map((item: { id: string }) => item.id)).toEqual(orderedCredentialIds);
    await reopenedApp.close();
  });

  it("creates encrypted connections, tags SSH hosts, and associates connections with multiple environments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "admin", password: "test-password-123" },
    });
    const sessionCookie = login.cookies.find((item) => item.name === "envman_session")!.value;
    const auth = { envman_session: sessionCookie };

    const environment = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      cookies: auth,
      payload: { name: "Production", status: "active", tags: [] },
    });
    const environmentId = environment.json().id as string;
    const secondaryEnvironment = await app.inject({
      method: "POST",
      url: "/api/v1/environments",
      cookies: auth,
      payload: { name: "Disaster Recovery", status: "maintenance", tags: ["dr"] },
    });
    const secondaryEnvironmentId = secondaryEnvironment.json().id as string;

    const ssh = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies: auth,
      payload: {
        name: "App Server",
        host: "10.0.0.8",
        port: 22,
        username: "deploy",
        authType: "password",
        tags: ["NACOS", "应用服务"],
        credential: { password: "plain-ssh-secret" },
        options: {
          terminalType: "xterm-256color",
          keepAliveSeconds: 30,
          encoding: "utf-8",
          hostKeySha256: "",
          loginScriptEnabled: true,
          loginScript: "cd /opt/app\nprintf 'ready\\n'",
        },
      },
    });
    expect(ssh.statusCode).toBe(201);
    const legacyStyleUpdate = await app.inject({
      method: "PUT",
      url: `/api/v1/ssh-connections/${ssh.json().id}`,
      cookies: auth,
      payload: {
        environmentId: null,
        name: "App Server",
        host: "10.0.0.8",
        port: 22,
        username: "deploy",
        authType: "password",
        jumpConnectionId: null,
      },
    });
    expect(legacyStyleUpdate.statusCode).toBe(200);
    const partialCredentialUpdate = await app.inject({
      method: "PUT",
      url: `/api/v1/ssh-connections/${ssh.json().id}`,
      cookies: auth,
      payload: {
        environmentId: null,
        name: "App Server",
        host: "10.0.0.8",
        port: 22,
        username: "deploy",
        authType: "password",
        jumpConnectionId: null,
        credential: { passphrase: "new-passphrase" },
      },
    });
    expect(partialCredentialUpdate.statusCode).toBe(200);

    const database = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies: auth,
      payload: {
        name: "Primary Database",
        engine: "mysql",
        host: "10.0.0.9",
        port: 3306,
        username: "envman",
        credential: { password: "plain-db-secret" },
      },
    });
    expect(database.statusCode).toBe(201);

    const stored = await db.prepare(`
      SELECT credential_ciphertext AS value FROM ssh_connections
      UNION ALL
      SELECT credential_ciphertext AS value FROM database_connections
    `).all() as Array<{ value: string }>;
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.value.startsWith("v1:"))).toBe(true);
    expect(stored.map((row) => row.value).join(" ")).not.toContain("plain-ssh-secret");
    expect(stored.map((row) => row.value).join(" ")).not.toContain("plain-db-secret");

    const unassigned = await app.inject({
      method: "GET",
      url: "/api/v1/connections?assignment=unassigned",
      cookies: auth,
    });
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json().items).toHaveLength(2);
    expect(unassigned.json().items.every((item: { password?: string }) => item.password === undefined)).toBe(true);

    const assigned = await app.inject({
      method: "POST",
      url: "/api/v1/connections/assign",
      cookies: auth,
      payload: {
        environmentIds: [environmentId, secondaryEnvironmentId],
        items: [
          { type: "ssh", id: ssh.json().id },
          { type: "database", id: database.json().id },
        ],
      },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().updated).toBe(2);

    const pool = await app.inject({ method: "GET", url: "/api/v1/connections", cookies: auth });
    expect(pool.json().items.every((item: { environmentIds: string[] }) => [environmentId, secondaryEnvironmentId].every((id) => item.environmentIds.includes(id)))).toBe(true);
    expect(pool.json().items.every((item: { environments: unknown[] }) => item.environments.length === 2)).toBe(true);
    expect(pool.json().items.find((item: { id: string }) => item.id === ssh.json().id).options).toMatchObject({
      loginScriptEnabled: true,
      loginScript: "cd /opt/app\nprintf 'ready\\n'",
    });
    expect(pool.json().items.find((item: { id: string }) => item.id === ssh.json().id)).toMatchObject({ hasPassword: true, hasPassphrase: true, tags: ["NACOS", "应用服务"] });

    const secondaryConnections = await app.inject({ method: "GET", url: `/api/v1/connections?environmentId=${secondaryEnvironmentId}`, cookies: auth });
    expect(secondaryConnections.json().items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([ssh.json().id, database.json().id]));
    const environmentSummary = await app.inject({ method: "GET", url: `/api/v1/environments/${secondaryEnvironmentId}`, cookies: auth });
    expect(environmentSummary.json().item).toMatchObject({ sshCount: 1, databaseCount: 1 });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/environments/${environmentId}`, cookies: auth })).statusCode).toBe(204);
    const remainingAssociations = await app.inject({ method: "GET", url: "/api/v1/connections", cookies: auth });
    expect(remainingAssociations.json().items.every((item: { environmentIds: string[] }) => item.environmentIds.length === 1 && item.environmentIds[0] === secondaryEnvironmentId)).toBe(true);

    const databaseFavorite = await app.inject({
      method: "POST",
      url: "/api/v1/database-object-favorites",
      cookies: auth,
      payload: { connectionId: database.json().id, targetType: "database", database: "envman" },
    });
    expect(databaseFavorite.statusCode).toBe(201);
    const tableFavorite = await app.inject({
      method: "POST",
      url: "/api/v1/database-object-favorites",
      cookies: auth,
      payload: { connectionId: database.json().id, targetType: "table", database: "envman", table: "audit_events" },
    });
    expect(tableFavorite.statusCode).toBe(201);
    const duplicateFavorite = await app.inject({
      method: "POST",
      url: "/api/v1/database-object-favorites",
      cookies: auth,
      payload: { connectionId: database.json().id, targetType: "table", database: "envman", table: "audit_events" },
    });
    expect(duplicateFavorite.statusCode).toBe(200);
    const favoriteList = await app.inject({ method: "GET", url: "/api/v1/database-object-favorites", cookies: auth });
    expect(favoriteList.json().items).toHaveLength(2);
    expect(favoriteList.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: "database", database: "envman", table: "" }),
      expect.objectContaining({ targetType: "table", database: "envman", table: "audit_events" }),
    ]));
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-object-favorites/${databaseFavorite.json().id}`, cookies: auth })).statusCode).toBe(204);

    const bulkDeleted = await app.inject({
      method: "POST",
      url: "/api/v1/connections/bulk-delete",
      cookies: auth,
      payload: { items: [{ type: "ssh", id: ssh.json().id }, { type: "database", id: database.json().id }] },
    });
    expect(bulkDeleted.statusCode).toBe(200);
    expect(bulkDeleted.json().deleted).toBe(2);
    const emptyPool = await app.inject({ method: "GET", url: "/api/v1/connections", cookies: auth });
    expect(emptyPool.json().items).toHaveLength(0);
    const emptyFavorites = await app.inject({ method: "GET", url: "/api/v1/database-object-favorites", cookies: auth });
    expect(emptyFavorites.json().items).toHaveLength(0);

    await app.close();
  });

  it("uses the environment group name as the default type-specific connection group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const group = await app.inject({ method: "POST", url: "/api/v1/environment-groups", cookies, payload: { name: "生产环境", description: "", color: "#1d8a74" } });
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { groupId: group.json().id, name: "生产一组", status: "active", tags: [] } });
    const environmentId = environment.json().id as string;

    const ssh = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: { environmentId, name: "应用服务器", host: "10.0.0.11", port: 22, username: "root", authType: "password", credential: { password: "secret" } },
    });
    expect(ssh.statusCode).toBe(201);
    const database = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: { name: "业务数据库", engine: "mysql", host: "10.0.0.12", port: 3306, username: "envman", credential: { password: "secret" } },
    });
    expect(database.statusCode).toBe(201);
    const assigned = await app.inject({
      method: "POST",
      url: "/api/v1/connections/assign",
      cookies,
      payload: { environmentId, items: [{ type: "database", id: database.json().id }] },
    });
    expect(assigned.statusCode).toBe(200);

    const customGroup = await app.inject({ method: "POST", url: "/api/v1/connection-groups", cookies, payload: { type: "ssh", name: "手工维护" } });
    const customSsh = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: { environmentId, connectionGroupId: customGroup.json().id, name: "手工分组服务器", host: "10.0.0.13", port: 22, username: "root", authType: "password", credential: { password: "secret" } },
    });
    expect(customSsh.statusCode).toBe(201);

    const pool = await app.inject({ method: "GET", url: "/api/v1/connections", cookies });
    expect(pool.json().items.find((item: { id: string }) => item.id === ssh.json().id)).toMatchObject({ connectionGroupPath: "生产环境" });
    expect(pool.json().items.find((item: { id: string }) => item.id === database.json().id)).toMatchObject({ environmentId, connectionGroupPath: "生产环境" });
    expect(pool.json().items.find((item: { id: string }) => item.id === customSsh.json().id)).toMatchObject({ connectionGroupPath: "手工维护" });
    const groups = await app.inject({ method: "GET", url: "/api/v1/connection-groups", cookies });
    expect(groups.json().items.filter((item: { path: string }) => item.path === "生产环境")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ssh" }),
      expect.objectContaining({ type: "database" }),
    ]));

    await app.close();
  });

  it("copies SSH and database connections without exposing stored credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };

    const sourceSsh = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: {
        name: "源 SSH",
        host: "10.0.0.20",
        port: 22,
        username: "root",
        authType: "password",
        credential: { password: "source-ssh-secret", passphrase: "source-passphrase" },
      },
    });
    const copiedSsh = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: {
        copyFromId: sourceSsh.json().id,
        name: "源 SSH 副本",
        host: "10.0.0.21",
        port: 2222,
        username: "operator",
        authType: "password",
      },
    });
    expect(copiedSsh.statusCode).toBe(201);

    const sourceDatabase = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        name: "源数据库",
        engine: "mysql",
        host: "10.0.0.30",
        port: 3306,
        username: "envman",
        credential: { password: "source-db-secret", httpTunnelUsername: "tunnel-user", httpTunnelPassword: "tunnel-secret" },
      },
    });
    const copiedDatabase = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        copyFromId: sourceDatabase.json().id,
        name: "源数据库副本",
        engine: "mariadb",
        host: "10.0.0.31",
        port: 3307,
        username: "reporter",
        credential: { password: "copy-db-secret" },
      },
    });
    expect(copiedDatabase.statusCode).toBe(201);

    const storedCredential = async (table: "ssh_connections" | "database_connections", id: string) => {
      const row = await db.prepare(`SELECT credential_ciphertext FROM ${table} WHERE id = ?`).get(id) as { credential_ciphertext: string };
      return { encrypted: row.credential_ciphertext, value: JSON.parse(app.secrets.decrypt(row.credential_ciphertext)) as Record<string, string> };
    };
    const sourceSshCredential = await storedCredential("ssh_connections", sourceSsh.json().id);
    const copiedSshCredential = await storedCredential("ssh_connections", copiedSsh.json().id);
    expect(copiedSshCredential.encrypted).not.toBe(sourceSshCredential.encrypted);
    expect(copiedSshCredential.value).toEqual(sourceSshCredential.value);
    const copiedDatabaseCredential = await storedCredential("database_connections", copiedDatabase.json().id);
    expect(copiedDatabaseCredential.value).toEqual({ password: "copy-db-secret", httpTunnelUsername: "tunnel-user", httpTunnelPassword: "tunnel-secret" });

    const list = await app.inject({ method: "GET", url: "/api/v1/connections", cookies });
    const copiedItems = list.json().items.filter((item: { id: string }) => [copiedSsh.json().id, copiedDatabase.json().id].includes(item.id));
    expect(copiedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: copiedSsh.json().id, name: "源 SSH 副本", host: "10.0.0.21", hasPassword: true }),
      expect.objectContaining({ id: copiedDatabase.json().id, name: "源数据库副本", host: "10.0.0.31", hasPassword: true, hasHttpTunnelAuth: true }),
    ]));
    expect(JSON.stringify(copiedItems)).not.toContain("source-ssh-secret");
    expect(JSON.stringify(copiedItems)).not.toContain("copy-db-secret");

    await app.close();
  });

  it("updates and deletes environment Web records without exposing credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Editable", status: "active", tags: [] } });
    const environmentId = environment.json().id as string;
    const updatedEnvironment = await app.inject({ method: "PUT", url: `/api/v1/environments/${environmentId}`, cookies, payload: { name: "Editable Production", shortName: "PROD", status: "maintenance", owner: "ops", tags: ["edited"] } });
    expect(updatedEnvironment.statusCode).toBe(200);

    const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environmentId}/web-entries`, cookies, payload: { name: "Console", url: "https://example.com", tags: [] } });
    const entryId = entry.json().id as string;
    expect((await app.inject({ method: "PUT", url: `/api/v1/web-entries/${entryId}`, cookies, payload: { name: "Admin Console", url: "https://example.com/admin", description: "updated", tags: ["admin"] } })).statusCode).toBe(200);
    const credential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${entryId}/credentials`, cookies, payload: { username: "operator", password: "web-secret", note: "first", customFields: {} } });
    const credentialId = credential.json().id as string;
    let uploadedPath = "";
    const uploadSpy = vi.spyOn(app.webAccountViews, "setUpload").mockImplementation(async (_ownerId, _credentialId, path) => {
      uploadedPath = path;
      expect(basename(path)).toBe("deployment plan.txt");
      expect(readFileSync(path, "utf8")).toBe("upload contents");
    });
    const boundary = "envman-upload-boundary";
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/web-credentials/${credentialId}/view/upload`,
      cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from([
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="deployment plan.txt"',
        "Content-Type: text/plain",
        "",
        "upload contents",
        `--${boundary}--`,
        "",
      ].join("\r\n")),
    });
    expect(upload.statusCode).toBe(200);
    expect(uploadedPath).not.toBe("");
    expect(existsSync(uploadedPath)).toBe(false);
    uploadSpy.mockRestore();
    const ownerId = login.json().user.id as string;
    const profileDirectory = join(directory, "web-profiles", ownerId, credentialId);
    mkdirSync(profileDirectory, { recursive: true });
    await db.prepare("INSERT INTO web_account_views (owner_user_id, credential_id, last_url, last_title, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(ownerId, credentialId, "https://example.com/dashboard", "Dashboard", new Date().toISOString());
    const resetView = await app.inject({ method: "POST", url: `/api/v1/web-credentials/${credentialId}/view/reset`, cookies });
    expect(resetView.statusCode).toBe(200);
    expect(existsSync(profileDirectory)).toBe(false);
    expect(await db.prepare("SELECT credential_id FROM web_account_views WHERE owner_user_id = ? AND credential_id = ?").get(ownerId, credentialId)).toBeUndefined();
    const closeViewSpy = vi.spyOn(app.webAccountViews, "closeCredential").mockResolvedValue(true);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/web-credentials/${credentialId}/view`, cookies })).statusCode).toBe(204);
    expect(closeViewSpy).toHaveBeenCalledWith(ownerId, credentialId, null, "页面预热已取消");
    closeViewSpy.mockRestore();
    const createViewSpy = vi.spyOn(app.webAccountViews, "create").mockResolvedValue({ view: {} as never, ticket: "preload-ticket", frame: "" });
    expect((await app.inject({
      method: "POST",
      url: `/api/v1/web-credentials/${credentialId}/view`,
      cookies,
      payload: { width: 900, height: 600, preload: true },
    })).statusCode).toBe(200);
    expect(createViewSpy).toHaveBeenCalledWith(expect.objectContaining({ id: ownerId }), credentialId, 900, 600, null, "entry", true);
    createViewSpy.mockRestore();
    expect((await app.inject({ method: "PUT", url: `/api/v1/web-credentials/${credentialId}`, cookies, payload: { username: "operator-updated", note: "changed", customFields: {} } })).statusCode).toBe(200);
    const revealed = await app.inject({ method: "POST", url: `/api/v1/web-credentials/${credentialId}/reveal`, cookies });
    expect(revealed.json().password).toBe("web-secret");
    const list = await app.inject({ method: "GET", url: `/api/v1/web-entries/${entryId}/credentials`, cookies });
    expect(list.body).not.toContain("web-secret");
    expect((await app.inject({ method: "DELETE", url: `/api/v1/web-credentials/${credentialId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/web-entries/${entryId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/environments/${environmentId}`, cookies })).statusCode).toBe(204);
    await app.close();
  });
});
