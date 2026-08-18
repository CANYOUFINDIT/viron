import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ensureAdmin, loadSavedSettings, openDatabase } from "./database.js";
import { initializeMasterKey } from "./master-key.js";
import { applyPendingMysqlRestore, applyPendingRestore } from "./platform-backup.js";
import { refreshPendingExistingConnections } from "./connection-existing.js";

const config = loadConfig();
if (config.databaseDriver !== "mysql") applyPendingRestore(config.dataDir);
const db = await openDatabase(config);
await initializeMasterKey(config, db);
if (config.databaseDriver === "mysql") {
  await applyPendingMysqlRestore(config.dataDir, db);
  await refreshPendingExistingConnections(db);
  await loadSavedSettings(db, config);
}
await ensureAdmin(db, config);

const app = await buildApp({ config, db });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
