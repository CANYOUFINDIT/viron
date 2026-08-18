import type { EnvmanDatabase } from "./database-client.js";

interface ExistingReference { id: string }

export async function refreshPendingExistingConnections(db: EnvmanDatabase): Promise<void> {
  const batches = await db.prepare(`
    SELECT b.id, b.summary_json, s.type AS source_type
    FROM connection_import_batches b
    JOIN connection_sources s ON s.id = b.source_id
    WHERE b.status = 'preview'
  `).all() as Array<{ id: string; summary_json: string; source_type: string }>;
  const sshExists = db.prepare("SELECT 1 FROM ssh_connections WHERE id = ?");
  const databaseExists = db.prepare("SELECT 1 FROM database_connections WHERE id = ?");
  const updateItem = db.prepare("UPDATE connection_import_items SET status = ?, conflict_json = ? WHERE id = ?");
  const now = new Date().toISOString();

  const refresh = db.transaction(async () => {
    for (const batch of batches) {
      const items = await db.prepare("SELECT id, connection_type, status, conflict_json FROM connection_import_items WHERE batch_id = ? AND status = 'conflict'").all(batch.id) as Array<{ id: string; connection_type: "ssh" | "database"; status: string; conflict_json: string }>;
      for (const item of items) {
        const existing: ExistingReference[] = [];
        for (const reference of JSON.parse(item.conflict_json) as ExistingReference[]) {
          if (await (item.connection_type === "ssh" ? sshExists.get(reference.id) : databaseExists.get(reference.id))) existing.push(reference);
        }
        await updateItem.run(existing.length ? "conflict" : batch.source_type === "securecrt_sync" ? "skipped" : "new", JSON.stringify(existing), item.id);
      }

      const counts = await db.prepare("SELECT status, COUNT(*) AS count FROM connection_import_items WHERE batch_id = ? GROUP BY status").all(batch.id) as Array<{ status: string; count: number }>;
      const count = (status: string) => Number(counts.find((item) => item.status === status)?.count ?? 0);
      const summary = JSON.parse(batch.summary_json) as Record<string, number>;
      summary.conflict = count("conflict");
      summary.new = count("new");
      if (batch.source_type === "securecrt_sync" && summary.conflict === 0) {
        await db.prepare("UPDATE connection_import_batches SET status = 'cancelled', summary_json = ?, completed_at = ? WHERE id = ?").run(JSON.stringify(summary), now, batch.id);
      } else {
        await db.prepare("UPDATE connection_import_batches SET summary_json = ? WHERE id = ?").run(JSON.stringify(summary), batch.id);
      }
    }
  });
  await refresh();
}
