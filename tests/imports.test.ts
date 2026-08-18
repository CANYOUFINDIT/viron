import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";
import { decryptNavicatV2Password, decryptSecureCrtPassword, parseConnectionImport, parseSecureCrtFiles } from "../src/server/imports/parsers.js";

const secureCrtCiphertext = "03:7f59810d05b03f8e49b96e091dad49cb474c2e8435a5dbe53fc5d1e7aa228a8df8938cb01a7dd0c72cc361595ef5c2b675d8b2a64663776b95b065fec9b0fc36f168ffe3ae6fdedc3e1897389609536f";
const navicatCiphertext = "B75D320B6211468D63EB3B67C9E85933";
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
    masterKey: Buffer.alloc(32, 19),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

function multipart(boundary: string, fields: Record<string, string>, filename: string, content: string): Buffer {
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

describe("connection import adapters", () => {
  it("decrypts verified SecureCRT V2 and Navicat V2 vectors", () => {
    expect(decryptSecureCrtPassword(secureCrtCiphertext)).toBe("Hypersine");
    expect(decryptNavicatV2Password(navicatCiphertext)).toBe("This is a test");
  });

  it("parses SecureCRT and Navicat connection exports", async () => {
    const secureCrt = await parseConnectionImport("securecrt", "Production.ini", Buffer.from([
      '\uFEFFD:"Session Password Saved"=00000001',
      'S:"Protocol Name"=SSH2',
      'S:"Hostname"=server.example.test',
      'D:"[SSH2] Port"=00000016',
      'S:"Username"=operator',
      `S:"Password V2"=${secureCrtCiphertext}`,
    ].join("\r\n")));
    expect(secureCrt).toHaveLength(1);
    expect(secureCrt[0]).toMatchObject({ type: "ssh", host: "server.example.test", port: 22, username: "operator" });
    expect(secureCrt[0].credential.password).toBe("Hypersine");

    const navicat = await parseConnectionImport("navicat", "connections.ncx", Buffer.from(
      `<Connections><Connection ConnType="MYSQL" ConnectionName="Primary" Host="db.example.test" Port="3306" UserName="dbadmin" Password="${navicatCiphertext}" Database="app" /></Connections>`,
    ));
    expect(navicat).toHaveLength(1);
    expect(navicat[0]).toMatchObject({ type: "database", engine: "mysql", host: "db.example.test", username: "dbadmin" });
    expect(navicat[0].credential.password).toBe("This is a test");
  });

  it("merges SecureCRT Config and Config.personal sessions by relative path", () => {
    const sessions = parseSecureCrtFiles([
      {
        path: "Config/Sessions/生产/App.ini",
        content: Buffer.from(['S:"Protocol Name"=SSH2', 'S:"Hostname"=app.example.test', 'D:"[SSH2] Port"=00000016', 'S:"Username"=operator'].join("\r\n")),
      },
      {
        path: "Config.personal/Sessions/生产/App.ini",
        content: Buffer.from(`S:"Password V2"=${secureCrtCiphertext}`),
      },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ host: "app.example.test", username: "operator", sourcePath: "生产/App.ini", groupPath: ["生产"] });
    expect(sessions[0].credential.password).toBe("Hypersine");
  });

  it("preserves a synchronized SecureCRT root and nested folders as a connection group", () => {
    const sessions = parseSecureCrtFiles([{
      path: "生产/电信/数据库/App.ini",
      sourcePath: "/var/www/crt/生产/电信/数据库/App.ini",
      content: Buffer.from(['S:"Protocol Name"=SSH2', 'S:"Hostname"=app.example.test', 'S:"Username"=operator'].join("\r\n")),
    }]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      importKey: "生产/电信/数据库/App.ini",
      sourcePath: "/var/www/crt/生产/电信/数据库/App.ini",
      groupPath: ["生产", "电信", "数据库"],
      name: "App",
    });
  });

  it("preserves Navicat nested folders as connection groups", async () => {
    const navicat = await parseConnectionImport("navicat", "connections.ncx", Buffer.from(
      `<Groups><Group Name="生产"><Group Name="电信"><Connection ConnType="MYSQL" ConnectionName="Primary" Host="db.example.test" Port="3306" UserName="dbadmin" /></Group></Group></Groups>`,
    ));
    expect(navicat).toHaveLength(1);
    expect(navicat[0]).toMatchObject({ type: "database", groupPath: ["生产", "电信"], sourcePath: "connections.ncx/生产/电信/Primary" });
  });

  it("previews and confirms an encrypted SecureCRT import", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-import-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const ini = [
      'S:"Protocol Name"=SSH2',
      'S:"Hostname"=import.example.test',
      'D:"[SSH2] Port"=00000016',
      'S:"Username"=operator',
      `S:"Password V2"=${secureCrtCiphertext}`,
    ].join("\r\n");
    const boundary = "envman-test-boundary";
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/connection-imports/preview",
      cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, { type: "securecrt", passphrase: "" }, "Imported.ini", ini),
    });
    expect(preview.statusCode).toBe(201);
    const batch = preview.json().batch as { id: string; items: Array<{ id: string; status: string; hasCredential: boolean }> };
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({ status: "new", hasCredential: true });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/connection-imports/${batch.id}/confirm`,
      cookies,
      payload: { decisions: [{ itemId: batch.items[0].id, action: "import" }] },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().imported).toBe(1);
    const stored = await db.prepare("SELECT credential_ciphertext FROM ssh_connections WHERE host = ?").get("import.example.test") as { credential_ciphertext: string };
    expect(stored.credential_ciphertext).toMatch(/^v1:/);
    expect(stored.credential_ciphertext).not.toContain("Hypersine");
    await app.close();
  });

  it("reports TLS-only Navicat imports as containing credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-navicat-tls-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const boundary = "envman-navicat-tls-boundary";
    const xml = `<Connections><Connection ConnType="MYSQL" ConnectionName="TLS Only" Host="db.example.test" Port="3306" UserName="dbadmin" SSL="true" SSL_CA="ca.pem" SSL_CERT="client.pem" SSL_KEY="client-key.pem" /></Connections>`;
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/connection-imports/preview",
      cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, { type: "navicat" }, "connections.ncx", xml),
    });
    expect(preview.statusCode).toBe(201);
    const batch = preview.json().batch as { id: string; items: Array<{ id: string; hasCredential: boolean }> };
    expect(batch.items[0]?.hasCredential).toBe(true);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/connection-imports/${batch.id}/confirm`,
      cookies,
      payload: { decisions: [{ itemId: batch.items[0].id, action: "import" }] },
    });
    expect(confirmed.statusCode).toBe(200);
    const stored = await db.prepare("SELECT credential_ciphertext, options_json FROM database_connections WHERE name = ?").get("TLS Only") as { credential_ciphertext: string; options_json: string };
    expect(JSON.parse(app.secrets.decrypt(stored.credential_ciphertext))).toMatchObject({
      tlsCa: "ca.pem",
      tlsCertificate: "client.pem",
      tlsPrivateKey: "client-key.pem",
    });
    expect(stored.options_json).not.toContain("ca.pem");
    expect(stored.options_json).not.toContain("client-key.pem");
    await app.close();
  });

  it("creates an independent connection group from a Navicat classification", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-navicat-group-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const boundary = "envman-navicat-group-boundary";
    const xml = `<Connections><Connection ConnType="MYSQL" ConnectionName="Primary" Group="生产/电信" Host="db.example.test" Port="3306" UserName="dbadmin" /></Connections>`;
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/connection-imports/preview",
      cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, { type: "navicat" }, "connections.ncx", xml),
    });
    expect(preview.statusCode).toBe(201);
    const item = preview.json().batch.items[0] as { id: string };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/connection-imports/${preview.json().batch.id}/confirm`,
      cookies,
      payload: { decisions: [{ itemId: item.id, action: "import" }] },
    });
    expect(confirmed.statusCode).toBe(200);
    const stored = await db.prepare(`
      SELECT g.type, g.path, d.environment_id
      FROM database_connections d JOIN connection_groups g ON g.id = d.connection_group_id
    `).get() as { type: string; path: string; environment_id: string | null };
    expect(stored).toEqual({ type: "database", path: "生产/电信", environment_id: null });
    await app.close();
  });

  it("reuses an existing SSH connection for an imported Navicat tunnel", async () => {
    const directory = mkdtempSync(join(tmpdir(), "envman-navicat-reuse-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const existingSsh = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-connections",
      cookies,
      payload: { name: "Existing Tunnel", host: "jump.example.test", port: 22, username: "operator", authType: "password", credential: { password: "existing-secret" } },
    });
    const existingSshId = existingSsh.json().id as string;
    const boundary = "envman-navicat-reuse-boundary";
    const xml = `<Connections><Connection ConnType="MYSQL" ConnectionName="Tunnel DB" Host="localhost" Port="3306" UserName="dbadmin" SSH="true" SSH_Host="jump.example.test" SSH_Port="22" SSH_UserName="operator" /></Connections>`;
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/connection-imports/preview",
      cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, { type: "navicat" }, "tunnel.ncx", xml),
    });
    expect(preview.statusCode).toBe(201);
    const batch = preview.json().batch as { id: string; items: Array<{ id: string; type: "ssh" | "database"; status: string }> };
    const sshItem = batch.items.find((item) => item.type === "ssh")!;
    const databaseItem = batch.items.find((item) => item.type === "database")!;
    expect(sshItem.status).toBe("conflict");
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/connection-imports/${batch.id}/confirm`,
      cookies,
      payload: { decisions: [{ itemId: sshItem.id, action: "reuse", targetId: existingSshId }, { itemId: databaseItem.id, action: "import" }] },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ imported: 1, reused: 1, skipped: 0 });
    expect((await db.prepare("SELECT COUNT(*) AS count FROM ssh_connections").get() as { count: number }).count).toBe(1);
    const database = await db.prepare("SELECT options_json FROM database_connections").get() as { options_json: string };
    expect(JSON.parse(database.options_json).sshConnectionId).toBe(existingSshId);
    await app.close();
  });
});
