import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "./product-info.js";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  databaseDriver?: "sqlite" | "mysql";
  databaseHost?: string;
  databasePort?: number;
  databaseName?: string;
  databaseUsername?: string;
  databasePassword?: string;
  databasePoolSize?: number;
  masterKey: Buffer;
  masterKeyFile?: string;
  masterKeyNeedsPersistence?: boolean;
  adminUsername: string;
  adminPassword: string;
  allowWeakPasswords?: boolean;
  sessionTtlHours: number;
  terminalIdleMinutes: number;
  connectionIdleMinutes?: number;
  userConnectionLimit?: number;
  auditRetentionDays: number;
  monitorPullIntervalSeconds?: number;
  serverEdition?: "source" | "lite" | "full";
  webClientEnabled?: boolean;
  mcpEnabled?: boolean;
  webSessionExecutor?: "server";
  webBrowserExecutable?: string;
  webViewIdleMinutes?: number;
  webViewPerUserLimit?: number;
  webViewTotalLimit?: number;
  cookieSecure?: boolean;
  scriptRunnerSocket?: string;
  scriptRunnerImage?: string;
  monitorPackageDir?: string;
}

const LEGACY_ENV_PREFIX = "ENVMAN_";
const SERVER_EDITION_FILE = fileURLToPath(new URL("./server-edition", import.meta.url));

function assertNoLegacyEnvironment(): void {
  const legacy = Object.keys(process.env).filter((key) => key.startsWith(LEGACY_ENV_PREFIX)).sort();
  if (!legacy.length) return;
  const replacements = legacy.map((key) => `${key}→VIRON_${key.slice(LEGACY_ENV_PREFIX.length)}`);
  throw new Error(`Legacy EnvMan environment variables are not supported: ${replacements.join(", ")}`);
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be either "true" or "false".`);
}

function serverEdition(): "source" | "lite" | "full" {
  const value = (existsSync(SERVER_EDITION_FILE)
    ? readFileSync(SERVER_EDITION_FILE, "utf8")
    : process.env.VIRON_SERVER_EDITION)?.trim().toLowerCase();
  if (!value) return "source";
  if (value === "lite" || value === "full") return value;
  throw new Error('VIRON_SERVER_EDITION must be either "lite" or "full" when set by a server image.');
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function decodeMasterKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("Viron master key must be exactly 32 bytes encoded as base64.");
  }
  return key;
}

function readMasterKey(dataDir: string, edition: "source" | "lite" | "full"): Pick<AppConfig, "masterKey" | "masterKeyFile" | "masterKeyNeedsPersistence"> {
  const inlineKey = process.env.VIRON_MASTER_KEY?.trim();
  if (inlineKey) return { masterKey: decodeMasterKey(inlineKey) };

  const configuredFile = process.env.VIRON_MASTER_KEY_FILE?.trim();
  const legacySecretFile = "/run/secrets/viron_master_key";
  const containerConfiguredFile = "/run/secrets/viron_configured_master_key";
  const externalFile = configuredFile
    ? edition === "source" ? resolve(configuredFile) : containerConfiguredFile
    : existsSync(legacySecretFile) ? legacySecretFile : undefined;
  if (externalFile) {
    try {
      return { masterKey: decodeMasterKey(readFileSync(externalFile, "utf8").trim()) };
    } catch (error) {
      throw new Error(`Viron master key file cannot be read: ${externalFile}`, { cause: error });
    }
  }

  const managedFile = join(dataDir, "master-key");
  try {
    const info = statSync(managedFile);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`Viron managed master key permissions are too broad: ${managedFile}. Set mode 0600.`);
    }
    return { masterKey: decodeMasterKey(readFileSync(managedFile, "utf8").trim()), masterKeyFile: managedFile };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { masterKey: randomBytes(32), masterKeyFile: managedFile, masterKeyNeedsPersistence: true };
  }
}

export function loadConfig(): AppConfig {
  assertNoLegacyEnvironment();
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppConfig["nodeEnv"];
  const dataDir = resolve(process.env.DATA_DIR ?? "./data");
  const edition = serverEdition();
  const masterKey = readMasterKey(dataDir, edition);
  const configuredDatabaseHost = process.env.DATABASE_HOST?.trim() || "127.0.0.1";
  const databaseHost = edition !== "source" && ["127.0.0.1", "localhost", "::1"].includes(configuredDatabaseHost.toLowerCase())
    ? "host.docker.internal"
    : configuredDatabaseHost;
  const databaseDriver = process.env.DATABASE_DRIVER?.trim().toLowerCase() || "sqlite";
  if (databaseDriver !== "sqlite" && databaseDriver !== "mysql") {
    throw new Error('DATABASE_DRIVER must be either "sqlite" or "mysql".');
  }
  const webSessionExecutor = process.env.WEB_SESSION_EXECUTOR?.trim().toLowerCase() || "server";
  if (webSessionExecutor !== "server") {
    throw new Error('WEB_SESSION_EXECUTOR currently supports only "server".');
  }

  return {
    nodeEnv,
    host: process.env.HOST ?? "0.0.0.0",
    port: positiveInteger(process.env.PORT, 8080),
    dataDir,
    databasePath: resolve(dataDir, "envman.db"),
    databaseDriver,
    databaseHost,
    databasePort: positiveInteger(process.env.DATABASE_PORT, 3306),
    databaseName: process.env.DATABASE_NAME?.trim() || "viron",
    databaseUsername: process.env.DATABASE_USERNAME?.trim() || "viron",
    databasePassword: process.env.DATABASE_PASSWORD ?? "",
    databasePoolSize: positiveInteger(process.env.DATABASE_POOL_SIZE, 10),
    ...masterKey,
    adminUsername: process.env.ADMIN_USERNAME?.trim() || "admin",
    adminPassword: process.env.ADMIN_PASSWORD ?? "",
    allowWeakPasswords: process.env.ALLOW_WEAK_PASSWORDS?.trim().toLowerCase() === "true",
    sessionTtlHours: positiveInteger(process.env.SESSION_TTL_HOURS, 45 * 24),
    terminalIdleMinutes: positiveInteger(process.env.CONNECTION_IDLE_MINUTES ?? process.env.TERMINAL_IDLE_MINUTES, 30),
    connectionIdleMinutes: positiveInteger(process.env.CONNECTION_IDLE_MINUTES ?? process.env.TERMINAL_IDLE_MINUTES, 30),
    userConnectionLimit: positiveInteger(process.env.USER_CONNECTION_LIMIT, 30),
    auditRetentionDays: positiveInteger(process.env.AUDIT_RETENTION_DAYS, 30),
    monitorPullIntervalSeconds: Math.min(3600, Math.max(10, positiveInteger(process.env.VIRON_MONITOR_PULL_INTERVAL_SECONDS, 60))),
    serverEdition: edition,
    webClientEnabled: edition === "full" || (edition === "source" && booleanValue("WEB_CLIENT_ENABLED", true)),
    mcpEnabled: booleanValue("VIRON_MCP_ENABLED", false),
    webSessionExecutor,
    webBrowserExecutable: process.env.WEB_BROWSER_EXECUTABLE?.trim() || undefined,
    webViewIdleMinutes: positiveInteger(process.env.CONNECTION_IDLE_MINUTES ?? process.env.WEB_VIEW_IDLE_MINUTES, 30),
    webViewPerUserLimit: positiveInteger(process.env.USER_CONNECTION_LIMIT ?? process.env.WEB_VIEW_PER_USER_LIMIT, 30),
    webViewTotalLimit: positiveInteger(process.env.WEB_VIEW_TOTAL_LIMIT, 8),
    cookieSecure: process.env.COOKIE_SECURE?.trim().toLowerCase() === "true",
    scriptRunnerSocket: process.env.SCRIPT_RUNNER_SOCKET?.trim()
      ? resolve(process.env.SCRIPT_RUNNER_SOCKET)
      : edition === "source" ? undefined : "/run/viron-script-runner/runner.sock",
    scriptRunnerImage: process.env.SCRIPT_RUNNER_IMAGE?.trim() || `viron-script-runner:${PRODUCT_VERSION}`,
    monitorPackageDir: process.env.VIRON_MONITOR_PACKAGE_DIR?.trim()
      ? resolve(process.env.VIRON_MONITOR_PACKAGE_DIR)
      : edition === "source" ? resolve("./dist/monitor") : "/app/monitor",
  };
}
