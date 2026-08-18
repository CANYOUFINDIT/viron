import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ClientChannel } from "ssh2";
import type { WebSocket } from "ws";
import {
  buildSshLogTailCommand,
  MAX_ENVIRONMENT_LOG_FILES,
  MAX_ENVIRONMENT_LOG_LINES,
  MIN_ENVIRONMENT_LOG_LINES,
  parseStoredLogFilePaths,
  quotePosixShellArg,
} from "../../shared/environment-log.js";
import { connectSsh, type ConnectedSsh } from "./connector.js";
import { normalizeSshLoginScript } from "./options.js";
import type { AuthenticatedUser } from "../access-control.js";

interface LogStreamTicket {
  streamId: string;
  ownerId: string;
  expiresAt: number;
}

interface EnvironmentLogRecord {
  id: string;
  environmentId: string;
  sshConnectionId: string;
  name: string;
  filePaths: string[];
  connectionName: string;
  host: string;
}

interface ManagedLogStream {
  id: string;
  ownerId: string;
  executionScope: string | null;
  log: EnvironmentLogRecord;
  connected: ConnectedSsh;
  channel: ClientChannel;
  sockets: Set<WebSocket>;
  createdAt: string;
  lastActivityAt: number;
  initialLines: number;
  outputBuffer: Array<{ type: "output" | "stderr"; data: string }>;
  outputBufferBytes: number;
  closed: boolean;
}

export interface PublicSshLogStream {
  id: string;
  logId: string;
  logName: string;
  filePath: string;
  filePaths: string[];
  initialLines: number;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
}

const OUTPUT_BUFFER_LIMIT = 256 * 1024;
const TICKET_TTL_MS = 30_000;
const MAX_PLATFORM_STREAMS = 10;
const MAX_OWNER_STREAMS = 3;

export { buildSshLogTailCommand, quotePosixShellArg };

function sshErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/authentication/i.test(value)) return "SSH 认证失败，请检查用户名和凭据";
  if (/timed out/i.test(value)) return "SSH 连接超时";
  if (/ECONNREFUSED/i.test(value)) return "SSH 端口拒绝连接";
  if (/ENOTFOUND|EAI_AGAIN/i.test(value)) return "无法解析 SSH 主机地址";
  if (/Host key/i.test(value)) return "SSH 主机指纹不匹配";
  return value;
}

export class SshLogStreamManager {
  private readonly streams = new Map<string, ManagedLogStream>();
  private readonly tickets = new Map<string, LogStreamTicket>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly app: FastifyInstance) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 15_000);
    this.cleanupTimer.unref();
  }

  async create(user: AuthenticatedUser, logId: string, initialLines: number, executionScope: string | null = null): Promise<{ stream: PublicSshLogStream; ticket: string }> {
    const ownerId = user.id;
    if (this.streams.size >= MAX_PLATFORM_STREAMS) throw new Error(`实时日志已达到 ${MAX_PLATFORM_STREAMS} 个平台并发上限`);
    const ownerCount = [...this.streams.values()].filter((stream) => stream.ownerId === ownerId && !stream.closed).length;
    if (ownerCount >= MAX_OWNER_STREAMS) throw new Error(`每个用户最多同时查看 ${MAX_OWNER_STREAMS} 个实时日志`);

    const row = await this.app.db.prepare(`
      SELECT l.id, l.environment_id, l.ssh_connection_id, l.name, l.file_path, l.file_paths_json,
        s.name AS connection_name, s.host, s.source_deleted,
        EXISTS (
          SELECT 1 FROM ssh_connection_environments ce
          WHERE ce.connection_id = s.id AND ce.environment_id = l.environment_id
        ) AS connection_available
      FROM environment_logs l
      JOIN ssh_connections s ON s.id = l.ssh_connection_id
      WHERE l.id = ?
    `).get(logId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("日志配置不存在");
    if (!Boolean(row.connection_available) || Boolean(row.source_deleted)) {
      throw new Error("SSH 连接已不可用或已移出当前环境");
    }
    const log: EnvironmentLogRecord = {
      id: String(row.id),
      environmentId: String(row.environment_id),
      sshConnectionId: String(row.ssh_connection_id),
      name: String(row.name),
      filePaths: parseStoredLogFilePaths(row.file_paths_json, row.file_path),
      connectionName: String(row.connection_name),
      host: String(row.host),
    };

    const id = randomUUID();
    await this.app.activeConnections.reserve({
      id,
      user,
      type: "logs",
      resourceId: logId,
      originEnvironmentId: log.environmentId,
      executionScope,
    });
    let connected: ConnectedSsh | undefined;
    try {
      connected = await connectSsh(this.app, log.sshConnectionId);
      const tailCommand = buildSshLogTailCommand(log.filePaths, initialLines);
      const loginScript = connected.connection.options.loginScript ?? "";
      const useLoginScript = connected.connection.options.loginScriptEnabled === true && Boolean(loginScript.trim());
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const onChannel = (error: Error | undefined, createdChannel: ClientChannel) => {
          if (error) reject(error);
          else resolve(createdChannel);
        };
        if (useLoginScript) {
          connected!.client.shell({
            term: connected!.connection.options.terminalType ?? "xterm-256color",
            cols: 120,
            rows: 40,
          }, onChannel);
        } else {
          connected!.client.exec(tailCommand, onChannel);
        }
      });
      const stream: ManagedLogStream = {
        id,
        ownerId,
        executionScope,
        log,
        connected,
        channel,
        sockets: new Set(),
        createdAt: new Date().toISOString(),
        lastActivityAt: Date.now(),
        initialLines,
        outputBuffer: [],
        outputBufferBytes: 0,
        closed: false,
      };
      this.streams.set(id, stream);
      this.app.activeConnections.activate(id, (reason) => { this.close(id, reason); });
      channel.on("data", (chunk: Buffer | string) => this.onOutput(stream, "output", chunk));
      channel.stderr.on("data", (chunk: Buffer | string) => this.onOutput(stream, "stderr", chunk));
      channel.once("close", (code: number | undefined, signal: string | undefined) => {
        const reason = code && code !== 0
          ? `tail 已退出（状态码 ${code}${signal ? `，信号 ${signal}` : ""}）`
          : "远程 tail 已结束";
        this.close(id, reason);
      });
      connected.client.once("error", (error) => this.close(id, sshErrorMessage(error)));
      connected.client.once("end", () => this.close(id, "SSH 连接已结束"));
      if (useLoginScript) {
        channel.write(normalizeSshLoginScript(loginScript));
        channel.write(`${tailCommand}\n`);
      }
      return { stream: this.publicStream(stream), ticket: this.issueTicket(id, ownerId) };
    } catch (error) {
      this.app.activeConnections.release(id);
      connected?.close();
      throw new Error(sshErrorMessage(error));
    }
  }

  list(ownerId: string, executionScope: string | null = null): PublicSshLogStream[] {
    return [...this.streams.values()]
      .filter((stream) => stream.ownerId === ownerId && stream.executionScope === executionScope && !stream.closed)
      .map((stream) => this.publicStream(stream));
  }

  activeCount(ownerId: string, executionScope: string | null): number {
    return [...this.streams.values()].filter((stream) => stream.ownerId === ownerId && stream.executionScope === executionScope && !stream.closed).length;
  }

  attach(ticket: string, socket: WebSocket): void {
    const ticketData = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!ticketData || ticketData.expiresAt < Date.now()) {
      socket.close(4001, "日志票据无效或已过期");
      return;
    }
    const stream = this.streams.get(ticketData.streamId);
    if (!stream || stream.closed || stream.ownerId !== ticketData.ownerId) {
      socket.close(4004, "实时日志不存在");
      return;
    }
    stream.sockets.add(socket);
    stream.lastActivityAt = Date.now();
    this.app.activeConnections.touch(stream.id);
    socket.send(JSON.stringify({ type: "ready", stream: this.publicStream(stream) }));
    for (const item of stream.outputBuffer) socket.send(JSON.stringify(item));
    socket.once("close", () => {
      stream.sockets.delete(socket);
    });
    socket.once("error", () => {
      stream.sockets.delete(socket);
    });
  }

  close(streamId: string, reason = "用户停止查看日志"): boolean {
    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) return false;
    stream.closed = true;
    this.broadcast(stream, { type: "closed", reason });
    for (const socket of stream.sockets) socket.close(1000, reason.slice(0, 120));
    stream.sockets.clear();
    stream.channel.end();
    stream.connected.close();
    this.streams.delete(streamId);
    this.app.activeConnections.release(streamId);
    return true;
  }

  closeAll(): void {
    clearInterval(this.cleanupTimer);
    for (const id of [...this.streams.keys()]) this.close(id, "Viron 服务正在停止");
    this.tickets.clear();
  }

  closeOwner(ownerId: string, reason = "用户访问已失效", executionScope?: string | null): void {
    for (const stream of this.streams.values()) {
      if (stream.ownerId === ownerId && (executionScope === undefined || stream.executionScope === executionScope)) this.close(stream.id, reason);
    }
  }

  private publicStream(stream: ManagedLogStream): PublicSshLogStream {
    return {
      id: stream.id,
      logId: stream.log.id,
      logName: stream.log.name,
      filePath: stream.log.filePaths[0] ?? "",
      filePaths: stream.log.filePaths,
      initialLines: stream.initialLines,
      connectionId: stream.log.sshConnectionId,
      connectionName: stream.log.connectionName,
      host: stream.log.host,
      createdAt: stream.createdAt,
    };
  }

  private issueTicket(streamId: string, ownerId: string): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { streamId, ownerId, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  private onOutput(stream: ManagedLogStream, type: "output" | "stderr", chunk: Buffer | string): void {
    if (stream.closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    stream.lastActivityAt = Date.now();
    this.app.activeConnections.recordTraffic(stream.id, { receivedBytes: Buffer.byteLength(data) }, stream.lastActivityAt);
    const item = { type, data } as const;
    stream.outputBuffer.push(item);
    stream.outputBufferBytes += Buffer.byteLength(data);
    while (stream.outputBufferBytes > OUTPUT_BUFFER_LIMIT && stream.outputBuffer.length > 1) {
      const removed = stream.outputBuffer.shift();
      if (removed) stream.outputBufferBytes -= Buffer.byteLength(removed.data);
    }
    this.broadcast(stream, item);
  }

  private broadcast(stream: ManagedLogStream, message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const socket of stream.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ticket, value] of this.tickets) {
      if (value.expiresAt < now) this.tickets.delete(ticket);
    }
  }
}
