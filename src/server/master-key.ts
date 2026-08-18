import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import { createSecretBox } from "./crypto.js";
import type { EnvmanDatabase } from "./database-client.js";

export const ENCRYPTED_COLUMNS = [
  ["organization_invitation_policies", "token_ciphertext"],
  ["web_credentials", "password_ciphertext"],
  ["connection_sources", "config_ciphertext"],
  ["ssh_keys", "private_key_ciphertext"],
  ["ssh_connections", "credential_ciphertext"],
  ["database_connections", "credential_ciphertext"],
  ["redis_connections", "credential_ciphertext"],
  ["connection_import_items", "payload_ciphertext"],
] as const;

async function firstEncryptedValue(db: EnvmanDatabase): Promise<string | undefined> {
  for (const [table, column] of ENCRYPTED_COLUMNS) {
    const row = await db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`)
      .get<{ value: string }>();
    if (row?.value) return row.value;
  }
  return undefined;
}

function decodeMasterKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error("Viron managed master key must be exactly 32 bytes encoded as base64.");
  return key;
}

async function readManagedKey(path: string): Promise<Buffer> {
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`Viron managed master key permissions are too broad: ${path}. Set mode 0600.`);
  }
  return decodeMasterKey(await readFile(path, "utf8"));
}

function assertDecrypts(ciphertext: string | undefined, key: Buffer): void {
  if (!ciphertext) return;
  try {
    createSecretBox(key).decrypt(ciphertext);
  } catch (error) {
    throw new Error("Viron master key does not match the encrypted data in this instance.", { cause: error });
  }
}

export async function initializeMasterKey(config: AppConfig, db: EnvmanDatabase): Promise<void> {
  const encryptedValue = await firstEncryptedValue(db);
  if (!config.masterKeyNeedsPersistence) {
    assertDecrypts(encryptedValue, config.masterKey);
    return;
  }

  if (encryptedValue) {
    throw new Error(
      "Viron managed master key is missing, but this instance already contains encrypted data. Restore the original key or import a password-protected migration package.",
    );
  }
  if (!config.masterKeyFile) throw new Error("Viron managed master key path is not configured.");

  await mkdir(dirname(config.masterKeyFile), { recursive: true });
  try {
    const handle = await open(config.masterKeyFile, "wx", 0o600);
    try {
      await handle.writeFile(`${config.masterKey.toString("base64")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    config.masterKey = await readManagedKey(config.masterKeyFile);
  }
  config.masterKeyNeedsPersistence = false;
}
