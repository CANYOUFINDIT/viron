import type { FastifyInstance } from "fastify";
import { Cron } from "croner";
import {
  cronExpressionError,
  isConnectionSourceScheduleOverdue,
} from "../../shared/connection-source-schedule.js";
import { syncSecureCrtSource } from "./sync.js";
import { syncScriptSource } from "./script-sync.js";

export { cronExpressionError, isConnectionSourceScheduleOverdue, nextCronRun } from "../../shared/connection-source-schedule.js";

type SchedulableSourceType = "securecrt_sync" | "script_sync";

interface ScheduledSourceRow {
  id: string;
  type: SchedulableSourceType;
  schedule_expression: string | null;
  last_synced_at: string | null;
}

export class ConnectionSourceScheduler {
  private readonly jobs = new Map<string, Cron>();
  private readonly runningCatchUp = new Set<string>();

  constructor(private readonly app: FastifyInstance) {}

  async start(): Promise<void> {
    const rows = await this.refresh();
    for (const row of rows) {
      const expression = row.schedule_expression?.trim() ?? "";
      if (!isConnectionSourceScheduleOverdue(expression, row.last_synced_at)) continue;
      void this.runCatchUp(row);
    }
  }

  async refresh(sourceId?: string): Promise<ScheduledSourceRow[]> {
    if (sourceId) this.stop(sourceId);
    else this.close();
    const rows = await this.app.db.prepare(`
      SELECT id, type, schedule_expression, last_synced_at FROM connection_sources
      WHERE type IN ('securecrt_sync', 'script_sync') AND schedule_enabled = 1
      ${sourceId ? "AND id = ?" : ""}
    `).all(...(sourceId ? [sourceId] : [])) as ScheduledSourceRow[];
    for (const row of rows) {
      const expression = row.schedule_expression?.trim() ?? "";
      if (cronExpressionError(expression)) continue;
      const job = new Cron(expression, {
        name: `viron-source-${row.id}`,
        protect: true,
        unref: true,
        catch: (error) => this.app.log.error({ err: error, sourceId: row.id }, "Scheduled connection source sync failed"),
      }, async () => {
        await this.run(row.id, row.type);
      });
      this.jobs.set(row.id, job);
    }
    return rows;
  }

  nextRun(sourceId: string): Date | null {
    return this.jobs.get(sourceId)?.nextRun() ?? null;
  }

  stop(sourceId: string): void {
    this.jobs.get(sourceId)?.stop();
    this.jobs.delete(sourceId);
  }

  close(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  private async runCatchUp(row: ScheduledSourceRow): Promise<void> {
    if (this.runningCatchUp.has(row.id)) return;
    this.runningCatchUp.add(row.id);
    try {
      await this.run(row.id, row.type);
    } catch (error) {
      this.app.log.error({ err: error, sourceId: row.id }, "Scheduled connection source catch-up failed");
    } finally {
      this.runningCatchUp.delete(row.id);
    }
  }

  private async run(sourceId: string, type: SchedulableSourceType): Promise<void> {
    if (type === "script_sync") await syncScriptSource(this.app, sourceId, undefined, "schedule");
    else await syncSecureCrtSource(this.app, sourceId);
  }
}
