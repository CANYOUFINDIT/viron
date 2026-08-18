import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const directories: string[] = [];
const managedKeys = [
  "DATA_DIR",
  "DATABASE_HOST",
  "VIRON_SERVER_EDITION",
  "WEB_CLIENT_ENABLED",
  "VIRON_MCP_ENABLED",
  "CONNECTION_IDLE_MINUTES",
  "USER_CONNECTION_LIMIT",
  "SESSION_TTL_HOURS",
  "ENVMAN_MASTER_KEY",
] as const;
const saved = Object.fromEntries(managedKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of managedKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function freshDataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "viron-config-test-"));
  directories.push(directory);
  process.env.DATA_DIR = directory;
  return directory;
}

describe("runtime configuration", () => {
  it("keeps a login session valid for 45 days by default", () => {
    freshDataDirectory();
    delete process.env.SESSION_TTL_HOURS;
    expect(loadConfig().sessionTtlHours).toBe(45 * 24);
    process.env.SESSION_TTL_HOURS = "48";
    expect(loadConfig().sessionTtlHours).toBe(48);
  });

  it("keeps remote MCP disabled unless explicitly enabled", () => {
    freshDataDirectory();
    delete process.env.VIRON_MCP_ENABLED;
    expect(loadConfig().mcpEnabled).toBe(false);
    process.env.VIRON_MCP_ENABLED = "true";
    expect(loadConfig().mcpEnabled).toBe(true);
    process.env.VIRON_MCP_ENABLED = "invalid";
    expect(() => loadConfig()).toThrow("VIRON_MCP_ENABLED must be either");
  });

  it("rejects legacy EnvMan environment variables with the Viron replacement", () => {
    freshDataDirectory();
    process.env.ENVMAN_MASTER_KEY = "legacy";
    expect(() => loadConfig()).toThrow("ENVMAN_MASTER_KEY→VIRON_MASTER_KEY");
  });

  it("uses source Web configuration without rewriting loopback database hosts", () => {
    freshDataDirectory();
    delete process.env.VIRON_SERVER_EDITION;
    process.env.WEB_CLIENT_ENABLED = "false";
    process.env.DATABASE_HOST = "127.0.0.1";
    const config = loadConfig();
    expect(config).toMatchObject({
      serverEdition: "source",
      webClientEnabled: false,
      databaseHost: "127.0.0.1",
    });
  });

  it("uses the immutable image edition and maps Docker loopback to the host gateway", () => {
    freshDataDirectory();
    process.env.VIRON_SERVER_EDITION = "lite";
    process.env.WEB_CLIENT_ENABLED = "true";
    process.env.DATABASE_HOST = "localhost";
    expect(loadConfig()).toMatchObject({
      serverEdition: "lite",
      webClientEnabled: false,
      databaseHost: "host.docker.internal",
    });

    process.env.VIRON_SERVER_EDITION = "full";
    process.env.WEB_CLIENT_ENABLED = "false";
    expect(loadConfig()).toMatchObject({ serverEdition: "full", webClientEnabled: true });
  });

  it("loads the shared connection idle timeout and per-user limit", () => {
    freshDataDirectory();
    process.env.CONNECTION_IDLE_MINUTES = "45";
    process.env.USER_CONNECTION_LIMIT = "36";
    expect(loadConfig()).toMatchObject({
      connectionIdleMinutes: 45,
      terminalIdleMinutes: 45,
      webViewIdleMinutes: 45,
      userConnectionLimit: 36,
      webViewPerUserLimit: 36,
    });
  });
});
