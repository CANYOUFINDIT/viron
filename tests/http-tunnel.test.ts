import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { parseNavicatTunnelResponse } from "../src/server/database-workbench/http-tunnel.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function uint16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function block(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([content.length]), content]);
}

function tunnelRows(fields: Array<{ name: string; type: number; value: string }>): Buffer {
  return Buffer.concat([
    uint32(1111), uint16(202), uint32(0), Buffer.alloc(6),
    uint32(0), uint32(0), uint32(0), uint32(fields.length), uint32(1), Buffer.alloc(12),
    ...fields.flatMap((field) => [block(field.name), block(""), uint32(field.type), uint32(0), uint32(255)]),
    ...fields.map((field) => block(field.value)),
    Buffer.from([0]),
  ]);
}

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 13),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

describe("Navicat-compatible HTTP Tunnel", () => {
  it("parses the ntunnel binary result format", () => {
    const results = parseNavicatTunnelResponse(tunnelRows([
      { name: "message", type: 253, value: "hello" },
      { name: "count", type: 3, value: "42" },
    ]));
    expect(results).toHaveLength(1);
    expect(results[0].rows).toEqual([{ message: "hello", count: 42 }]);
  });

  it("tests a database connection through an ntunnel endpoint with encrypted Basic Auth", async () => {
    let receivedAuthorization = "";
    let receivedSql = "";
    const tunnel = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedAuthorization = String(request.headers.authorization ?? "");
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        receivedSql = Buffer.from(form.getAll("q[]")[0], "base64").toString("utf8");
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(tunnelRows([
          { name: "version", type: 253, value: "11.4.0-MariaDB" },
          { name: "connectionId", type: 3, value: "7" },
        ]));
      });
    });
    await new Promise<void>((resolve) => tunnel.listen(0, "127.0.0.1", resolve));
    const address = tunnel.address();
    if (!address || typeof address === "string") throw new Error("Test tunnel did not start");

    const directory = mkdtempSync(join(tmpdir(), "envman-http-tunnel-test-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies,
      payload: {
        name: "Tunnel DB",
        engine: "mariadb",
        host: "db.internal",
        port: 3306,
        username: "db-admin",
        credential: { password: "db-secret", httpTunnelUsername: "web-user", httpTunnelPassword: "web-secret" },
        defaultDatabase: "ops",
        connectionMode: "httpTunnel",
        options: { httpTunnelUrl: `http://127.0.0.1:${address.port}/ntunnel_mysql.php`, httpTunnelRejectUnauthorized: true },
      },
    });
    expect(created.statusCode).toBe(201);
    const tested = await app.inject({ method: "POST", url: `/api/v1/database-connections/${created.json().id}/test`, cookies });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json().version).toBe("11.4.0-MariaDB");
    expect(receivedSql).toContain("SELECT VERSION()");
    expect(receivedAuthorization).toBe(`Basic ${Buffer.from("web-user:web-secret").toString("base64")}`);
    const encrypted = (await db.prepare("SELECT credential_ciphertext FROM database_connections WHERE id = ?").get(created.json().id) as { credential_ciphertext: string }).credential_ciphertext;
    expect(encrypted).not.toContain("web-secret");

    await app.close();
    await new Promise<void>((resolve, reject) => tunnel.close((error) => error ? reject(error) : resolve()));
  });
});
