import type { FastifyInstance } from "fastify";
import { Cron } from "croner";
import { syncSecureCrtSource } from "./sync.js";
import { syncScriptSource } from "./script-sync.js";

export function cronExpressionError(expression: string): string | null {
  if (!expression.trim()) return "启用定时同步时必须填写 Cron 表达式";
  try {
    const probe = new Cron(expression, { paused: true });
    if (!probe.nextRun()) return "Cron 表达式没有可执行的下次时间";
    probe.stop();
    return null;
  } catch {
    return "Cron 表达式无效";
  }
}

export class ConnectionSourceScheduler {
  private readonly jobs = new Map<string, Cron>();

  constructor(private readonly app: FastifyInstance) {}

  async start(): Promise<void> {
    await this.refresh();
  }

  async refresh(sourceId?: string): Promise<void> {
    if (sourceId) this.stop(sourceId);
    else this.close();
    const rows = await this.app.db.prepare(`
      SELECT id, type, schedule_expression FROM connection_sources
      WHERE type IN ('securecrt_sync', 'script_sync') AND schedule_enabled = 1
      ${sourceId ? "AND id = ?" : ""}
    `).all(...(sourceId ? [sourceId] : [])) as Array<{ id: string; type: "securecrt_sync" | "script_sync"; schedule_expression: string | null }>;
    for (const row of rows) {
      const expression = row.schedule_expression?.trim() ?? "";
      if (cronExpressionError(expression)) continue;
      const job = new Cron(expression, {
        name: `viron-source-${row.id}`,
        protect: true,
        unref: true,
        catch: (error) => this.app.log.error({ err: error, sourceId: row.id }, "Scheduled connection source sync failed"),
      }, async () => {
        if (row.type === "script_sync") await syncScriptSource(this.app, row.id, undefined, "schedule");
        else await syncSecureCrtSource(this.app, row.id);
      });
      this.jobs.set(row.id, job);
    }
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
}
