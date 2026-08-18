import "dotenv/config";
import argon2 from "argon2";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "../database.js";
import { initializeMasterKey } from "../master-key.js";
import { passwordPolicyError } from "../password-policy.js";

const targetUsername = process.argv[2];
const initialPassword = process.argv[3];
const sourceUsername = process.argv[4];

if (!targetUsername || !initialPassword) {
  console.error("Usage: npm run user:migrate -- <target-username> <initial-password> [source-platform-admin]");
  process.exit(1);
}

const config = loadConfig();
const passwordError = passwordPolicyError(initialPassword, config.allowWeakPasswords);
if (passwordError) throw new Error(passwordError);
const db = await openDatabase(config);
await initializeMasterKey(config, db);
const source = await db.prepare("SELECT id, username FROM admin_users WHERE username = ? COLLATE NOCASE AND is_platform_admin = 1").get(sourceUsername ?? config.adminUsername) as { id: string; username: string } | undefined;
if (!source) {
  await db.close();
  throw new Error(`Source platform administrator not found: ${sourceUsername ?? config.adminUsername}`);
}
const sourceUser = source;

let target = await db.prepare("SELECT id, username FROM admin_users WHERE username = ? COLLATE NOCASE").get(targetUsername) as { id: string; username: string } | undefined;
if (target?.id === sourceUser.id) {
  await db.close();
  throw new Error("Source and target users must be different");
}
const now = new Date().toISOString();
const passwordHash = await argon2.hash(initialPassword, { type: argon2.argon2id });
if (!target) {
  target = { id: crypto.randomUUID(), username: targetUsername };
  await db.prepare(`
    INSERT INTO admin_users (id, username, password_hash, is_platform_admin, status, created_at, updated_at)
    VALUES (?, ?, ?, 0, 'active', ?, ?)
  `).run(target.id, target.username, passwordHash, now, now);
} else {
  await db.prepare("UPDATE admin_users SET password_hash = ?, status = 'active', updated_at = ? WHERE id = ?")
    .run(passwordHash, now, target.id);
}

const resourceTables = [
  "environment_groups",
  "environments",
  "connection_sources",
  "connection_groups",
  "ssh_connections",
  "database_connections",
  "redis_connections",
  "connection_import_batches",
];
const transfer = db.transaction(async () => {
  for (const table of resourceTables) {
    await db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_type = 'personal' AND workspace_id = ?`).run(target!.id, sourceUser.id);
  }
  for (const table of ["web_account_views", "environment_preferences", "database_query_history", "database_query_favorites", "database_saved_queries", "database_table_profiles", "database_automation_jobs", "database_models", "database_code_snippets", "database_bi_workspaces", "database_object_groups", "database_object_favorites", "database_connection_preferences", "ssh_command_favorites", "database_tasks", "ssh_terminal_recordings"]) {
    await db.prepare(`UPDATE ${table} SET owner_user_id = ? WHERE owner_user_id = ?`).run(target!.id, sourceUser.id);
  }
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target!.id);
});
await transfer();
await db.close();

function moveUserDirectory(root: string): void {
  const sourceDirectory = join(config.dataDir, root, sourceUser.id);
  if (!existsSync(sourceDirectory)) return;
  const targetDirectory = join(config.dataDir, root, target!.id);
  mkdirSync(targetDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory)) {
    const destination = join(targetDirectory, entry);
    if (existsSync(destination)) throw new Error(`Migration target already exists: ${destination}`);
    renameSync(join(sourceDirectory, entry), destination);
  }
  rmSync(sourceDirectory, { recursive: true, force: true });
}

for (const root of ["web-profiles", "web-downloads", "web-uploads"]) moveUserDirectory(root);
console.log(`Migrated personal workspace from ${sourceUser.username} to ${target.username}.`);
