import "dotenv/config";
import argon2 from "argon2";
import { loadConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/database.js";
import { initializeMasterKey } from "../src/server/master-key.js";
import { passwordPolicyError } from "../src/server/password-policy.js";

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error("Usage: npm run admin:reset -- <username> <new-password>");
  process.exit(1);
}

const config = loadConfig();
const passwordError = passwordPolicyError(password, config.allowWeakPasswords);
if (passwordError) throw new Error(passwordError);
const db = await openDatabase(config);
await initializeMasterKey(config, db);
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
const result = await db.prepare(`
  UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE username = ?
`).run(passwordHash, new Date().toISOString(), username);

if (!result.changes) {
  console.error(`User not found: ${username}`);
  process.exitCode = 1;
} else {
  await db.prepare(`DELETE FROM sessions WHERE user_id = (SELECT id FROM admin_users WHERE username = ?)`)
    .run(username);
  console.log(`Password reset for user: ${username}`);
}
await db.close();
