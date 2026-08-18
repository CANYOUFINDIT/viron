import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

export type MonitorInstallTaskStatus = "pending" | "running" | "success" | "error";
export type MonitorInstallTaskPhase =
  | "queued"
  | "preflight"
  | "package_validation"
  | "ssh_connect"
  | "staging"
  | "upload"
  | "remote_install"
  | "reconnect"
  | "initial_collect"
  | "persist"
  | "complete";

export interface MonitorInstallTaskLog {
  at: string;
  kind: "progress" | "output";
  message: string;
}

interface MonitorInstallTask {
  id: string;
  environmentId: string;
  connectionId: string;
  connectionName: string;
  installPath: string;
  actorUserId: string;
  status: MonitorInstallTaskStatus;
  phase: MonitorInstallTaskPhase;
  progress: number;
  currentMessage: string;
  logs: MonitorInstallTaskLog[];
  error: string;
  result: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type PublicMonitorInstallTask = Omit<MonitorInstallTask, "actorUserId">;

export interface MonitorInstallTaskReporter {
  progress(phase: MonitorInstallTaskPhase, progress: number, message: string): Promise<void>;
  output(value: string): Promise<void>;
}

export class MonitorInstallTaskConflictError extends Error {
  constructor(public readonly task: PublicMonitorInstallTask | null) {
    super("当前主机已有监控安装任务正在执行");
  }
}

const taskLogLimit = 300;
const taskRetentionMs = 30 * 24 * 60 * 60 * 1000;

export function sanitizeMonitorInstallOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, "[已隐藏私钥]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [已隐藏]")
    .replace(/\b(password|passwd|token|secret|authorization|api[_-]?key)(\s*[:=]\s*)([^\s,;]+)/gi, "$1$2[已隐藏]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, "$1[已隐藏]@")
    .trim();
}

function parseLogs(value: unknown): MonitorInstallTaskLog[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MonitorInstallTaskLog => Boolean(
      item && typeof item === "object"
      && typeof item.at === "string"
      && (item.kind === "progress" || item.kind === "output")
      && typeof item.message === "string",
    )).slice(-taskLogLimit);
  } catch {
    return [];
  }
}

function parseResult(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function publicTask(task: MonitorInstallTask): PublicMonitorInstallTask {
  const { actorUserId: _actorUserId, ...visible } = task;
  return visible;
}

export class MonitorInstallTaskManager {
  private readonly activeConnections = new Set<string>();
  private readonly activeRuns = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly app: FastifyInstance) {}

  async initialize(): Promise<void> {
    const now = new Date().toISOString();
    await this.app.db.prepare(`
      UPDATE monitor_install_tasks
      SET status = 'error', current_message = 'Viron 重启导致安装任务中断',
        error_message = 'Viron 重启导致安装任务中断', completed_at = ?, updated_at = ?
      WHERE status IN ('pending', 'running')
    `).run(now, now);
    await this.app.db.prepare("DELETE FROM monitor_install_tasks WHERE completed_at IS NOT NULL AND completed_at < ?")
      .run(new Date(Date.now() - taskRetentionMs).toISOString());
  }

  async latest(connectionId: string): Promise<PublicMonitorInstallTask | null> {
    const row = await this.app.db.prepare(`
      SELECT * FROM monitor_install_tasks WHERE ssh_connection_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(connectionId) as Record<string, unknown> | undefined;
    return row ? publicTask(this.fromRow(row)) : null;
  }

  async start(
    input: { environmentId: string; connectionId: string; connectionName: string; installPath: string; actorUserId: string },
    runner: (reporter: MonitorInstallTaskReporter) => Promise<Record<string, unknown>>,
  ): Promise<PublicMonitorInstallTask> {
    if (this.closing) throw new Error("Viron 服务正在停止，不能启动新的安装任务");
    if (this.activeConnections.has(input.connectionId)) {
      const existing = await this.latest(input.connectionId);
      throw new MonitorInstallTaskConflictError(existing);
    }
    this.activeConnections.add(input.connectionId);
    try {
      const existing = await this.app.db.prepare(`
        SELECT * FROM monitor_install_tasks
        WHERE ssh_connection_id = ? AND status IN ('pending', 'running')
        ORDER BY created_at DESC LIMIT 1
      `).get(input.connectionId) as Record<string, unknown> | undefined;
      if (existing) throw new MonitorInstallTaskConflictError(publicTask(this.fromRow(existing)));

      const now = new Date().toISOString();
      const task: MonitorInstallTask = {
        id: randomUUID(),
        environmentId: input.environmentId,
        connectionId: input.connectionId,
        connectionName: input.connectionName,
        installPath: input.installPath,
        actorUserId: input.actorUserId,
        status: "pending",
        phase: "queued",
        progress: 0,
        currentMessage: "等待开始安装监控服务",
        logs: [{ at: now, kind: "progress", message: "安装任务已创建" }],
        error: "",
        result: {},
        createdAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      };
      await this.persist(task, true);
      const run = this.run(task, runner)
        .catch((error) => this.app.log.error({ err: error, taskId: task.id }, "monitor installation task persistence failed"))
        .finally(() => {
          this.activeConnections.delete(input.connectionId);
          this.activeRuns.delete(run);
        });
      this.activeRuns.add(run);
      return publicTask(task);
    } catch (error) {
      this.activeConnections.delete(input.connectionId);
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.activeRuns]);
  }

  private async run(task: MonitorInstallTask, runner: (reporter: MonitorInstallTaskReporter) => Promise<Record<string, unknown>>): Promise<void> {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.updatedAt = task.startedAt;
    await this.persist(task);
    const reporter: MonitorInstallTaskReporter = {
      progress: async (phase, progress, message) => {
        task.phase = phase;
        task.progress = Math.max(task.progress, Math.min(99, Math.trunc(progress)));
        task.currentMessage = sanitizeMonitorInstallOutput(message).slice(0, 1000);
        this.appendLog(task, "progress", task.currentMessage);
        await this.persist(task);
      },
      output: async (value) => {
        const sanitized = sanitizeMonitorInstallOutput(value);
        for (const line of sanitized.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(-100)) {
          this.appendLog(task, "output", line.slice(0, 1000));
        }
        await this.persist(task);
      },
    };
    try {
      task.result = await runner(reporter);
      task.status = "success";
      task.phase = "complete";
      task.progress = 100;
      task.currentMessage = "监控服务安装完成";
      this.appendLog(task, "progress", task.currentMessage);
    } catch (error) {
      const message = sanitizeMonitorInstallOutput(error instanceof Error ? error.message : "监控服务安装失败").slice(0, 4000);
      task.status = "error";
      task.currentMessage = message;
      task.error = message;
      this.appendLog(task, "progress", `安装失败：${message}`);
    }
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    await this.persist(task);
  }

  private appendLog(task: MonitorInstallTask, kind: MonitorInstallTaskLog["kind"], message: string): void {
    if (!message) return;
    task.logs.push({ at: new Date().toISOString(), kind, message });
    if (task.logs.length > taskLogLimit) task.logs.splice(0, task.logs.length - taskLogLimit);
  }

  private async persist(task: MonitorInstallTask, insert = false): Promise<void> {
    task.updatedAt = new Date().toISOString();
    if (insert) {
      await this.app.db.prepare(`
        INSERT INTO monitor_install_tasks (
          id, environment_id, ssh_connection_id, connection_name, install_path, actor_user_id,
          status, phase, progress, current_message, logs_json, error_message, result_json,
          created_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id, task.environmentId, task.connectionId, task.connectionName, task.installPath, task.actorUserId,
        task.status, task.phase, task.progress, task.currentMessage, JSON.stringify(task.logs), task.error,
        JSON.stringify(task.result), task.createdAt, task.startedAt, task.completedAt, task.updatedAt,
      );
      return;
    }
    await this.app.db.prepare(`
      UPDATE monitor_install_tasks
      SET status = ?, phase = ?, progress = ?, current_message = ?, logs_json = ?, error_message = ?,
        result_json = ?, started_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      task.status, task.phase, task.progress, task.currentMessage, JSON.stringify(task.logs), task.error,
      JSON.stringify(task.result), task.startedAt, task.completedAt, task.updatedAt, task.id,
    );
  }

  private fromRow(row: Record<string, unknown>): MonitorInstallTask {
    return {
      id: String(row.id),
      environmentId: String(row.environment_id),
      connectionId: String(row.ssh_connection_id),
      connectionName: String(row.connection_name),
      installPath: String(row.install_path),
      actorUserId: String(row.actor_user_id ?? ""),
      status: String(row.status) as MonitorInstallTaskStatus,
      phase: String(row.phase) as MonitorInstallTaskPhase,
      progress: Number(row.progress),
      currentMessage: String(row.current_message),
      logs: parseLogs(row.logs_json),
      error: String(row.error_message),
      result: parseResult(row.result_json),
      createdAt: String(row.created_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      updatedAt: String(row.updated_at),
    };
  }
}
