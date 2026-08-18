import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvmanDatabase } from "./database-client.js";
import { exportPortableSnapshot, replaceMysqlFromPortableSnapshot } from "./platform-migration.js";

interface PendingRestoreMarker {
  createdAt: string;
  snapshot: string;
  migrationId?: string;
}

function pendingRestore(dataDir: string): { pendingDir: string; marker: PendingRestoreMarker; snapshotPath: string } | undefined {
  const pendingDir = join(dataDir, "restore-pending");
  const markerPath = join(pendingDir, "restore.json");
  if (!existsSync(markerPath)) return undefined;
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as PendingRestoreMarker;
  const snapshotPath = join(pendingDir, marker.snapshot);
  if (!existsSync(snapshotPath)) throw new Error("Pending Viron restore is missing envman.db snapshot.");
  return { pendingDir, marker, snapshotPath };
}

function finishRestore(dataDir: string, pendingDir: string, marker: PendingRestoreMarker): void {
  for (const directory of ["recordings", "backups"]) {
    const source = join(pendingDir, directory);
    if (!existsSync(source)) continue;
    const destination = join(dataDir, directory);
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
  }
  writeFileSync(join(dataDir, "last-restore.json"), JSON.stringify({
    restoredAt: new Date().toISOString(),
    requestedAt: marker.createdAt,
    migrationId: marker.migrationId,
  }, null, 2), { mode: 0o600 });
  if (marker.migrationId) {
    mkdirSync(join(dataDir, "migration-history"), { recursive: true, mode: 0o700 });
    const historyPath = join(dataDir, "migration-history", `${marker.migrationId}.json`);
    writeFileSync(historyPath, JSON.stringify({ migrationId: marker.migrationId, status: "applied", appliedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  }
  rmSync(pendingDir, { recursive: true, force: true });
}

export function migrationWasImported(dataDir: string, migrationId: string): boolean {
  return existsSync(join(dataDir, "migration-history", `${migrationId}.json`));
}

export function recordMigrationStaged(dataDir: string, migrationId: string): void {
  const historyDir = join(dataDir, "migration-history");
  mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(historyDir, `${migrationId}.json`), JSON.stringify({
    migrationId,
    status: "staged",
    stagedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600, flag: "wx" });
}

export function applyPendingRestore(dataDir: string): void {
  const pending = pendingRestore(dataDir);
  if (!pending) return;
  const { pendingDir, marker, snapshotPath } = pending;
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, "envman.db");
  if (existsSync(databasePath)) {
    const safetyPath = join(dataDir, `envman-pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    copyFileSync(databasePath, safetyPath);
  }
  const stagedDatabase = join(dataDir, "envman.db.restore");
  copyFileSync(snapshotPath, stagedDatabase);
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(`${databasePath}${suffix}`); } catch { /* Sidecar may not exist. */ }
  }
  renameSync(stagedDatabase, databasePath);
  finishRestore(dataDir, pendingDir, marker);
}

export async function applyPendingMysqlRestore(dataDir: string, db: EnvmanDatabase): Promise<void> {
  const pending = pendingRestore(dataDir);
  if (!pending) return;
  const { pendingDir, marker, snapshotPath } = pending;
  mkdirSync(dataDir, { recursive: true });
  const safetyPath = join(dataDir, `envman-pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await exportPortableSnapshot(db, safetyPath);
  await replaceMysqlFromPortableSnapshot(snapshotPath, db);
  finishRestore(dataDir, pendingDir, marker);
}
