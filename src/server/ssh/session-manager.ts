import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ClientChannel } from "ssh2";
import type { RawData, WebSocket } from "ws";
import type { AuthenticatedUser, WorkspaceType } from "../access-control.js";
import { writeAudit } from "../audit.js";
import { agentSshContextSnapshot, summarizeAgentSshOutput } from "../../shared/agent-ssh-context.js";
import { normalizeAgentSshCommand, type AgentSshContextSnapshot, type AgentSshDiagnosticResult } from "../../shared/agent.js";
import { sshCommandRiskLevel } from "../../shared/ssh-command-risk.js";
import { connectSsh, type ConnectedSsh } from "./connector.js";
import { executeSshCommandOnConnection, SshCommandAbortedError } from "./command.js";
import { normalizeSshLoginScript } from "./options.js";
import { auditRetentionCutoff } from "../audit-query.js";

interface SessionTicket {
  sessionId: string;
  ownerId: string;
  expiresAt: number;
}

interface ManagedSession {
  id: string;
  ownerId: string;
  executionScope: string | null;
  workspaceType: WorkspaceType;
  workspaceId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
  lastActivityAt: number;
  connected: ConnectedSsh;
  shell: ClientChannel;
  sockets: Set<WebSocket>;
  outputBuffer: Buffer;
  closed: boolean;
  recordingId: string;
  recordingPath: string;
  recording: WriteStream;
  recordingStartedAt: number;
  recordingBytes: number;
}

export interface PublicSshSession {
  id: string;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
  attached: boolean;
}

const OUTPUT_BUFFER_LIMIT = 512 * 1024;

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/authentication/i.test(value)) return "SSH 认证失败，请检查用户名和凭据";
  if (/timed out/i.test(value)) return "SSH 连接超时";
  if (/ECONNREFUSED/i.test(value)) return "SSH 端口拒绝连接";
  if (/ENOTFOUND|EAI_AGAIN/i.test(value)) return "无法解析 SSH 主机地址";
  if (/Host key/i.test(value)) return "SSH 主机指纹不匹配";
  return value;
}

export class SshSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly agentDiagnostics = new Map<string, { sessionId: string; ownerId: string; executionScope: string | null; controller: AbortController }>();
  private readonly cancelledAgentDiagnostics = new Map<string, { sessionId: string; ownerId: string; executionScope: string | null; expiresAt: number }>();
  private readonly tickets = new Map<string, SessionTicket>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly app: FastifyInstance) {
    mkdirSync(join(app.config.dataDir, "recordings"), { recursive: true });
    this.cleanupTimer = setInterval(() => {
      void this.cleanup().catch((error) => this.app.log.error({ err: error }, "SSH session cleanup failed"));
    }, 60_000);
    this.cleanupTimer.unref();
  }

  async initialize(): Promise<void> {
    await this.app.db.prepare("UPDATE ssh_terminal_recordings SET status = 'interrupted', ended_at = ?, close_reason = 'Viron 服务非正常中断' WHERE status = 'recording'").run(new Date().toISOString());
    await this.purgeRecordings();
    await this.purgeHistoryAndEvents();
  }

  async create(user: AuthenticatedUser, connectionId: string, cols: number, rows: number, executionScope: string | null = null, originEnvironmentId?: string): Promise<{ session: PublicSshSession; ticket: string }> {
    if (this.sessions.size >= 20) throw new Error("SSH 会话已达到 20 个并发上限");
    const id = randomUUID();
    await this.app.activeConnections.reserve({ id, user, type: "ssh", resourceId: connectionId, originEnvironmentId, executionScope });
    let connected: ConnectedSsh | undefined;
    try {
      const current = await connectSsh(this.app, connectionId);
      connected = current;
      const shell = await new Promise<ClientChannel>((resolve, reject) => {
        current.client.shell({
          term: current.connection.options.terminalType ?? "xterm-256color",
          cols,
          rows,
        }, (error, channel) => {
          if (error) reject(error);
          else resolve(channel);
        });
      });
      const recordingId = randomUUID();
      const recordingPath = join(this.app.config.dataDir, "recordings", `${recordingId}.cast`);
      const recording = createWriteStream(recordingPath, { flags: "wx", mode: 0o600 });
      recording.on("error", (error) => this.app.log.error({ error, sessionId: id }, "terminal recording write failed"));
      const recordingStartedAt = Date.now();
      const header = `${JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(recordingStartedAt / 1000), env: { TERM: current.connection.options.terminalType ?? "xterm-256color", SHELL: "ssh" } })}\n`;
      recording.write(header);
      const session: ManagedSession = {
        id,
        ownerId: user.id,
        executionScope,
        workspaceType: user.workspace.type,
        workspaceId: user.workspace.id,
        connectionId,
        connectionName: current.connection.name,
        host: current.connection.host,
        createdAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        connected: current,
        shell,
        sockets: new Set(),
        outputBuffer: Buffer.alloc(0),
        closed: false,
        recordingId,
        recordingPath,
        recording,
        recordingStartedAt,
        recordingBytes: Buffer.byteLength(header),
      };
      this.sessions.set(id, session);
      this.app.activeConnections.activate(id, (reason) => this.close(id, reason));
      await this.app.db.prepare(`
        INSERT INTO ssh_terminal_recordings (
          id, owner_user_id, session_id, connection_id, connection_name, host, recording_path, status, close_reason, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', '', ?)
      `).run(recordingId, user.id, id, connectionId, current.connection.name, current.connection.host, recordingPath, session.createdAt);
      shell.on("data", (chunk: Buffer | string) => this.onOutput(session, chunk));
      shell.stderr.on("data", (chunk: Buffer | string) => this.onOutput(session, chunk));
      shell.once("close", () => { void this.close(id, "远程 Shell 已关闭"); });
      current.client.once("error", (error) => { void this.close(id, errorMessage(error)); });
      current.client.once("end", () => { void this.close(id, "SSH 连接已结束"); });
      const loginScript = current.connection.options.loginScript ?? "";
      if (current.connection.options.loginScriptEnabled && loginScript.trim()) {
        shell.write(normalizeSshLoginScript(loginScript));
      }
      return { session: this.publicSession(session), ticket: this.issueTicket(id, user.id) };
    } catch (error) {
      this.app.activeConnections.release(id);
      connected?.close();
      throw error;
    }
  }

  list(ownerId: string, executionScope: string | null = null): PublicSshSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId && session.executionScope === executionScope && !session.closed)
      .map((session) => this.publicSession(session));
  }

  activeCount(ownerId: string, executionScope: string | null): number {
    return [...this.sessions.values()].filter((session) => session.ownerId === ownerId && session.executionScope === executionScope && !session.closed).length;
  }

  agentTarget(sessionId: string, user: AuthenticatedUser, executionScope: string | null): PublicSshSession {
    return this.publicSession(this.sessionForAgent(sessionId, user, executionScope));
  }

  agentContext(sessionId: string, user: AuthenticatedUser, executionScope: string | null): AgentSshContextSnapshot {
    const session = this.sessionForAgent(sessionId, user, executionScope);
    return agentSshContextSnapshot({
      sessionId: session.id,
      connectionId: session.connectionId,
      connectionName: session.connectionName,
      host: session.host,
      output: session.outputBuffer,
      executionTarget: "server-forwarded",
    });
  }

  async agentDiagnostic(
    executionId: string,
    sessionId: string,
    command: string,
    user: AuthenticatedUser,
    executionScope: string | null,
    options?: { allowWrite?: boolean },
  ): Promise<AgentSshDiagnosticResult> {
    const session = this.sessionForAgent(sessionId, user, executionScope);
    const normalizedCommand = normalizeAgentSshCommand(command);
    if (!options?.allowWrite && sshCommandRiskLevel(normalizedCommand) !== "low") throw new Error("SSH 诊断执行只允许可证明为只读的命令");
    if (options?.allowWrite && sshCommandRiskLevel(normalizedCommand) === "low") throw new Error("可证明为只读的 SSH 命令请使用只读诊断，不要使用写执行");
    if (this.agentDiagnostics.has(executionId)) throw new Error("SSH 诊断执行 ID 已存在");
    const cancelled = this.cancelledAgentDiagnostics.get(executionId);
    if (cancelled) {
      if (cancelled.sessionId === sessionId && cancelled.ownerId === user.id && cancelled.executionScope === executionScope) {
        this.cancelledAgentDiagnostics.delete(executionId);
        throw new SshCommandAbortedError();
      }
      throw new Error("SSH 诊断执行 ID 已存在");
    }
    const controller = new AbortController();
    const active = { sessionId, ownerId: user.id, executionScope, controller };
    this.agentDiagnostics.set(executionId, active);
    session.lastActivityAt = Date.now();
    this.app.activeConnections.touch(session.id);
    try {
      const result = await executeSshCommandOnConnection(session.connected, normalizedCommand, {
        timeoutMs: 30_000,
        maxBytes: 128 * 1024,
        signal: controller.signal,
      });
      const stdout = summarizeAgentSshOutput(result.stdout, { maxBytes: 64 * 1024, maxLines: 500 });
      const stderr = summarizeAgentSshOutput(result.stderr, { maxBytes: 64 * 1024, maxLines: 500 });
      return {
        executionId,
        sessionId,
        connectionId: session.connectionId,
        connectionName: session.connectionName,
        host: session.host,
        executionTarget: "server-forwarded",
        command: normalizedCommand,
        stdout: stdout.output,
        stderr: stderr.output,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        truncated: result.truncated || stdout.truncated || stderr.truncated,
        redactionCount: stdout.redactionCount + stderr.redactionCount,
      };
    } finally {
      if (this.agentDiagnostics.get(executionId) === active) this.agentDiagnostics.delete(executionId);
    }
  }

  cancelAgentDiagnostic(executionId: string, sessionId: string, user: AuthenticatedUser, executionScope: string | null): { stopped: boolean } {
    this.sessionForAgent(sessionId, user, executionScope);
    const active = this.agentDiagnostics.get(executionId);
    if (active && active.sessionId === sessionId && active.ownerId === user.id && active.executionScope === executionScope) {
      active.controller.abort();
      return { stopped: true };
    }
    this.cancelledAgentDiagnostics.set(executionId, {
      sessionId,
      ownerId: user.id,
      executionScope,
      expiresAt: Date.now() + 2 * 60_000,
    });
    return { stopped: true };
  }

  ticket(sessionId: string, ownerId: string, executionScope: string | null = null): string {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || session.ownerId !== ownerId || session.executionScope !== executionScope) throw new Error("SSH 会话不存在或已经结束");
    return this.issueTicket(sessionId, ownerId);
  }

  attach(ticket: string, socket: WebSocket): void {
    const ticketData = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!ticketData || ticketData.expiresAt < Date.now()) {
      socket.close(4001, "终端票据无效或已过期");
      return;
    }
    const session = this.sessions.get(ticketData.sessionId);
    if (!session || session.closed || session.ownerId !== ticketData.ownerId) {
      socket.close(4004, "SSH 会话不存在");
      return;
    }
    session.sockets.add(socket);
    session.lastActivityAt = Date.now();
    this.app.activeConnections.touch(session.id);
    socket.send(JSON.stringify({ type: "ready", session: this.publicSession(session) }));
    if (session.outputBuffer.length) socket.send(session.outputBuffer, { binary: true });
    socket.on("message", (raw: RawData, isBinary: boolean) => this.onMessage(session, socket, raw, isBinary));
    socket.once("close", () => session.sockets.delete(socket));
    socket.once("error", () => session.sockets.delete(socket));
  }

  async close(sessionId: string, reason = "用户关闭终端"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    for (const diagnostic of this.agentDiagnostics.values()) {
      if (diagnostic.sessionId === sessionId) diagnostic.controller.abort();
    }
    this.broadcast(session, { type: "closed", reason });
    for (const socket of session.sockets) socket.close(1000, reason.slice(0, 120));
    session.sockets.clear();
    session.shell.end();
    session.connected.close();
    session.recording.end();
    await this.app.db.prepare(`
      UPDATE ssh_terminal_recordings SET status = 'completed', size_bytes = ?, ended_at = ?, close_reason = ?
      WHERE id = ?
    `).run(session.recordingBytes, new Date().toISOString(), reason, session.recordingId);
    this.sessions.delete(sessionId);
    this.app.activeConnections.release(sessionId);
    await writeAudit(this.app.db, {
      action: "ssh.session_closed",
      resourceType: "ssh_connection",
      resourceId: session.connectionId,
      summary: `关闭 SSH 会话 ${session.connectionName}`,
      details: { sessionId, reason, startedAt: session.createdAt },
      actorUserId: session.ownerId,
      workspaceType: session.workspaceType,
      workspaceId: session.workspaceId,
    });
  }

  async closeAll(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, "Viron 服务正在停止")));
  }

  async closeOwner(ownerId: string, reason = "用户访问已失效", executionScope?: string | null): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId && (executionScope === undefined || session.executionScope === executionScope))
      .map((session) => this.close(session.id, reason)));
  }

  private publicSession(session: ManagedSession): PublicSshSession {
    return {
      id: session.id,
      connectionId: session.connectionId,
      connectionName: session.connectionName,
      host: session.host,
      createdAt: session.createdAt,
      attached: session.sockets.size > 0,
    };
  }

  private sessionForAgent(sessionId: string, user: AuthenticatedUser, executionScope: string | null): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed
      || session.ownerId !== user.id
      || session.executionScope !== executionScope
      || session.workspaceType !== user.workspace.type
      || session.workspaceId !== user.workspace.id) {
      throw new Error("SSH 会话不存在或已经结束");
    }
    return session;
  }

  private issueTicket(sessionId: string, ownerId: string): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { sessionId, ownerId, expiresAt: Date.now() + 30_000 });
    return ticket;
  }

  private onOutput(session: ManagedSession, chunk: Buffer | string): void {
    if (session.closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    session.lastActivityAt = Date.now();
    this.app.activeConnections.recordTraffic(session.id, { receivedBytes: data.byteLength }, session.lastActivityAt);
    const buffered = Buffer.concat([session.outputBuffer, data]);
    session.outputBuffer = buffered.length > OUTPUT_BUFFER_LIMIT
      ? buffered.subarray(buffered.length - OUTPUT_BUFFER_LIMIT)
      : buffered;
    const elapsed = Math.max(0, (Date.now() - session.recordingStartedAt) / 1000);
    const event = `${JSON.stringify([Number(elapsed.toFixed(6)), "o", data.toString("utf8")])}\n`;
    session.recordingBytes += Buffer.byteLength(event);
    session.recording.write(event);
    this.broadcastBinary(session, data);
  }

  private onMessage(session: ManagedSession, socket: WebSocket, raw: RawData, isBinary: boolean): void {
    session.lastActivityAt = Date.now();
    this.app.activeConnections.touch(session.id);
    if (isBinary) {
      const data = this.toBuffer(raw);
      this.app.activeConnections.recordTraffic(session.id, { sentBytes: data.byteLength }, session.lastActivityAt);
      session.shell.write(data);
      return;
    }
    try {
      const message = JSON.parse(this.toBuffer(raw).toString("utf8")) as { type?: string; data?: string; cols?: number; rows?: number };
      if (message.type === "input" && typeof message.data === "string") {
        this.app.activeConnections.recordTraffic(session.id, { sentBytes: Buffer.byteLength(message.data) }, session.lastActivityAt);
        session.shell.write(message.data);
      } else if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        const cols = Math.max(20, Math.min(500, Number(message.cols)));
        const rows = Math.max(5, Math.min(300, Number(message.rows)));
        session.shell.setWindow(rows, cols, 0, 0);
      } else if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "终端消息格式不正确" }));
    }
  }

  private broadcast(session: ManagedSession, message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const socket of session.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private broadcastBinary(session: ManagedSession, data: Buffer): void {
    for (const socket of session.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
    }
  }

  private toBuffer(raw: RawData): Buffer {
    if (Buffer.isBuffer(raw)) return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw);
    return Buffer.from(raw);
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt < now) this.tickets.delete(ticket);
    }
    for (const [executionId, value] of this.cancelledAgentDiagnostics) {
      if (value.expiresAt < now) this.cancelledAgentDiagnostics.delete(executionId);
    }
    await this.purgeRecordings();
    await this.purgeHistoryAndEvents(now);
  }

  private async purgeHistoryAndEvents(now = Date.now()): Promise<void> {
    const cutoff = auditRetentionCutoff(this.app.config.auditRetentionDays, now);
    await this.app.db.prepare("DELETE FROM database_query_history WHERE created_at < ?").run(cutoff);
    await this.app.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(cutoff);
  }

  private async purgeRecordings(): Promise<void> {
    const cutoff = new Date(Date.now() - this.app.config.auditRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const expired = await this.app.db.prepare("SELECT id, recording_path FROM ssh_terminal_recordings WHERE status != 'recording' AND COALESCE(ended_at, started_at) < ?").all(cutoff) as Array<{ id: string; recording_path: string }>;
    const remove = this.app.db.transaction(async () => {
      for (const item of expired) {
        try { unlinkSync(item.recording_path); } catch { /* Missing files can still be removed from metadata. */ }
        await this.app.db.prepare("DELETE FROM ssh_terminal_recordings WHERE id = ?").run(item.id);
      }
    });
    await remove();
  }
}
