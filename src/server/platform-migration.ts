import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { createReadStream, renameSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import Database from "better-sqlite3";
import { SQLITE_SCHEMA } from "./sqlite-schema.js";
import type { EnvmanDatabase } from "./database-client.js";
import { createSecretBox } from "./crypto.js";
import { ENCRYPTED_COLUMNS } from "./master-key.js";

const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SNAPSHOT_PAGE_SIZE = 1_000;

interface MigrationKeyEnvelope {
  kdf: "scrypt";
  salt: string;
  cost: number;
  blockSize: number;
  parallelization: number;
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface PlatformMigrationManifest {
  product: "Viron";
  format: "platform-migration";
  version: 1;
  migrationId: string;
  createdAt: string;
  sourceDatabase: "sqlite" | "mysql";
  snapshotSha256: string;
  keyEnvelope: MigrationKeyEnvelope;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `\`${value}\``;
}

function migrationAad(migrationId: string, snapshotSha256: string): Buffer {
  return Buffer.from(`Viron platform migration v1\0${migrationId}\0${snapshotSha256}`, "utf8");
}

function deriveMigrationKey(password: string, envelope: Pick<MigrationKeyEnvelope, "salt" | "cost" | "blockSize" | "parallelization">): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(envelope.salt, "base64"), 32, {
      N: envelope.cost,
      r: envelope.blockSize,
      p: envelope.parallelization,
      maxmem: 128 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function createMigrationManifest(
  masterKey: Buffer,
  password: string,
  sourceDatabase: PlatformMigrationManifest["sourceDatabase"],
  snapshotSha256: string,
): Promise<PlatformMigrationManifest> {
  const migrationId = randomUUID();
  const salt = randomBytes(16);
  const envelopeParameters = {
    salt: salt.toString("base64"),
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
  };
  const wrappingKey = await deriveMigrationKey(password, envelopeParameters);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
    cipher.setAAD(migrationAad(migrationId, snapshotSha256));
    const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    return {
      product: "Viron",
      format: "platform-migration",
      version: 1,
      migrationId,
      createdAt: new Date().toISOString(),
      sourceDatabase,
      snapshotSha256,
      keyEnvelope: {
        kdf: "scrypt",
        ...envelopeParameters,
        cipher: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    };
  } finally {
    wrappingKey.fill(0);
  }
}

export async function openMigrationMasterKey(manifest: PlatformMigrationManifest, password: string): Promise<Buffer> {
  const envelope = manifest.keyEnvelope;
  if (
    manifest.product !== "Viron"
    || manifest.format !== "platform-migration"
    || manifest.version !== 1
    || !/^[0-9a-f-]{36}$/i.test(manifest.migrationId)
    || !envelope
    || !["sqlite", "mysql"].includes(manifest.sourceDatabase)
    || !/^[0-9a-f]{64}$/i.test(manifest.snapshotSha256)
    || envelope.kdf !== "scrypt"
    || envelope.cipher !== "aes-256-gcm"
    || envelope.cost !== SCRYPT_COST
    || envelope.blockSize !== SCRYPT_BLOCK_SIZE
    || envelope.parallelization !== SCRYPT_PARALLELIZATION
  ) {
    throw new Error("不支持的 Viron 迁移包格式");
  }

  const wrappingKey = await deriveMigrationKey(password, envelope);
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrappingKey, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(migrationAad(manifest.migrationId, manifest.snapshotSha256));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const key = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    if (key.length !== 32) throw new Error("迁移包中的主密钥长度无效");
    return key;
  } catch (error) {
    throw new Error("迁移密码错误或迁移包已损坏", { cause: error });
  } finally {
    wrappingKey.fill(0);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sqliteTables(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

function sqliteColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function sqlitePrimaryKeyColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string; pk: number }>)
    .filter((row) => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((row) => row.name);
}

export async function exportPortableSnapshot(db: EnvmanDatabase, destinationPath: string): Promise<void> {
  if (db.dialect === "sqlite") {
    await db.backup(destinationPath);
    await chmod(destinationPath, 0o600);
    return;
  }

  const snapshot = new Database(destinationPath);
  try {
    snapshot.pragma("foreign_keys = OFF");
    snapshot.exec(SQLITE_SCHEMA);
    const tables = sqliteTables(snapshot);
    await db.transaction(async () => {
      for (const table of tables) {
        const columns = sqliteColumns(snapshot, table);
        const orderColumns = sqlitePrimaryKeyColumns(snapshot, table);
        const insert = snapshot.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
        let offset = 0;
        while (true) {
          const orderBy = orderColumns.length ? ` ORDER BY ${orderColumns.map(identifier).join(", ")}` : "";
          const rows = await db.prepare(`SELECT ${columns.map(identifier).join(", ")} FROM ${identifier(table)}${orderBy} LIMIT ${SNAPSHOT_PAGE_SIZE} OFFSET ${offset}`)
            .all<Record<string, unknown>>();
          if (!rows.length) break;
          snapshot.transaction(() => {
            for (const row of rows) insert.run(...columns.map((column) => row[column] ?? null));
          })();
          offset += rows.length;
          if (rows.length < SNAPSHOT_PAGE_SIZE) break;
        }
      }
    })();
  } finally {
    snapshot.close();
  }
  await chmod(destinationPath, 0o600);
}

function normalizePortableSnapshot(snapshotPath: string): void {
  const normalizedPath = `${snapshotPath}.validated`;
  rmSync(normalizedPath, { force: true });
  const source = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  const normalized = new Database(normalizedPath);
  try {
    normalized.pragma("foreign_keys = OFF");
    normalized.exec(SQLITE_SCHEMA);
    normalized.transaction(() => {
      for (const table of sqliteTables(normalized)) {
        const columns = sqliteColumns(normalized, table);
        const sourceColumns = new Set(sqliteColumns(source, table));
        const missingColumns = columns.filter((column) => !sourceColumns.has(column));
        if (missingColumns.length) throw new Error(`迁移包数据库表 ${table} 缺少字段：${missingColumns.join(", ")}`);
        const insert = normalized.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
        for (const row of source.prepare(`SELECT ${columns.map(identifier).join(", ")} FROM ${identifier(table)}`).iterate() as Iterable<Record<string, unknown>>) {
          insert.run(...columns.map((column) => row[column] ?? null));
        }
      }
    })();
    const foreignKeyViolations = normalized.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length) throw new Error(`迁移包数据库包含 ${foreignKeyViolations.length} 个外键错误`);
  } finally {
    source.close();
    normalized.close();
  }
  renameSync(normalizedPath, snapshotPath);
}

export function rekeyPortableSnapshot(snapshotPath: string, sourceMasterKey: Buffer, targetMasterKey: Buffer): void {
  try {
    normalizePortableSnapshot(snapshotPath);
  } catch (error) {
    rmSync(`${snapshotPath}.validated`, { force: true });
    throw error;
  }
  const db = new Database(snapshotPath);
  try {
    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity[0]?.integrity_check !== "ok") throw new Error("迁移包数据库快照完整性检查失败");
    const sourceSecrets = createSecretBox(sourceMasterKey);
    const targetSecrets = createSecretBox(targetMasterKey);
    db.transaction(() => {
      for (const [table, column] of ENCRYPTED_COLUMNS) {
        const rows = db.prepare(`SELECT rowid AS row_id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
          .all() as Array<{ row_id: number; value: string }>;
        const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
        for (const row of rows) update.run(targetSecrets.encrypt(sourceSecrets.decrypt(row.value)), row.row_id);
      }
    })();
    const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length) throw new Error(`迁移包数据库包含 ${foreignKeyViolations.length} 个外键错误`);
  } finally {
    db.close();
  }
}

export async function replaceMysqlFromPortableSnapshot(snapshotPath: string, target: EnvmanDatabase): Promise<void> {
  if (target.dialect !== "mysql") throw new Error("Portable snapshot target must use the MySQL driver");
  const source = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const tables = sqliteTables(source);
    await target.transaction(async () => {
      await target.exec("SET FOREIGN_KEY_CHECKS = 0");
      try {
        for (const table of tables) await target.prepare(`DELETE FROM ${identifier(table)}`).run();
        for (const table of tables) {
          const columns = sqliteColumns(source, table);
          const insert = target.prepare(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
          for (const row of source.prepare(`SELECT ${columns.map(identifier).join(", ")} FROM ${identifier(table)}`).iterate() as Iterable<Record<string, unknown>>) {
            await insert.run(...columns.map((column) => row[column] ?? null));
          }
        }
      } finally {
        await target.exec("SET FOREIGN_KEY_CHECKS = 1");
      }
    })();
  } finally {
    source.close();
  }
}
