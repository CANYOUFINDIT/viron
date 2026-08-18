import { translate as tr } from "./i18n.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { connectSshClient } from "../shared/ssh-client.js";
import { IdleResourcePool } from "../shared/idle-resource-pool.js";
import { normalizeAgentSshCommand, type AgentSshContextSnapshot, type AgentSshDiagnosticResult } from "../shared/agent.js";
import { sshCommandRiskLevel } from "../shared/ssh-command-risk.js";
import type { DesktopSshConnection, DesktopSshCredential } from "./device-identity.js";
import { agentSshContextSnapshot, summarizeAgentSshOutput } from "./agent-ssh-context.js";

export interface DesktopSshContext {
  endpoint: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
}

export interface DesktopSshSessionState {
  id: string;
  connectionId: string;
  connectionName: string;
  host: string;
  createdAt: string;
  attached: boolean;
}

export type DesktopSshSessionEvent =
  | { sessionId: string; type: "ready"; session: DesktopSshSessionState }
  | { sessionId: string; type: "output"; data: Uint8Array }
  | { sessionId: string; type: "closed"; reason: string }
  | { sessionId: string; type: "error"; message: string };

export interface DesktopSshRecording {
  id: string;
  sessionId: string;
  connectionId: string;
  connectionName: string;
  host: string;
  status: "recording" | "completed" | "interrupted";
  sizeBytes: number;
  startedAt: string;
  endedAt?: string;
  closeReason: string;
  source: "desktop";
}

export interface ConnectedDesktopSsh {
  client: Client;
  jumpClient?: Client;
  connection: Omit<DesktopSshConnection, "credential">;
  close(): void;
}

export type DesktopSshCredentialLoader = (connectionId: string) => Promise<{
  context: DesktopSshContext;
  credential: DesktopSshCredential;
}>;

export interface DesktopSshConnectionLease {
  context: DesktopSshContext;
  connected: ConnectedDesktopSsh;
  reused: boolean;
}

export interface DesktopSshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
}

interface DesktopSshCommandOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export class DesktopSshCommandAbortedError extends Error {
  readonly code = "SSH_COMMAND_ABORTED";

  constructor() {
    super(tr("SSH 诊断命令已取消"));
    this.name = "DesktopSshCommandAbortedError";
  }
}

interface SessionTicket {
  sessionId: string;
  contextKey: string;
  expiresAt: number;
}

interface StoredRecording extends DesktopSshRecording, DesktopSshContext {
  path: string;
}

interface ManagedSession {
  state: DesktopSshSessionState;
  context: DesktopSshContext;
  connected: ConnectedDesktopSsh;
  shell: ClientChannel;
  outputBuffer: Buffer;
  attached: boolean;
  closed: boolean;
  lastActivityAt: number;
  recording: StoredRecording;
  recordingStream: WriteStream;
  recordingStartedAt: number;
}

const OUTPUT_BUFFER_LIMIT = 512 * 1024;
const SESSION_LIMIT = 20;

export function desktopSshErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/authentication/i.test(value)) return tr("SSH 认证失败，请检查用户名和凭据");
  if (/timed out/i.test(value)) return tr("SSH 连接超时");
  if (/ECONNREFUSED/i.test(value)) return tr("SSH 端口拒绝连接");
  if (/ENOTFOUND|EAI_AGAIN/i.test(value)) return tr("无法解析 SSH 主机地址");
  if (/Host key/i.test(value)) return tr("SSH 主机指纹不匹配");
  return value;
}

function contextKey(context: DesktopSshContext): string {
  return `${context.endpoint}\0${context.userId}\0${context.workspaceType}\0${context.workspaceId}`;
}

function hostVerifier(expected: string | undefined): ConnectConfig["hostVerifier"] {
  if (!expected) return undefined;
  const normalizedExpected = expected.replace(/^SHA256:/i, "").replace(/=+$/, "");
  return (key: Buffer) => createHash("sha256").update(key).digest("base64").replace(/=+$/, "") === normalizedExpected;
}

function connectConfig(connection: DesktopSshConnection, sock?: Readable): ConnectConfig {
  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    readyTimeout: 15_000,
    keepaliveInterval: Math.max(0, Number(connection.options.keepAliveSeconds ?? 30)) * 1000,
    keepaliveCountMax: 3,
    hostVerifier: hostVerifier(connection.options.hostKeySha256),
    sock,
  };
  if (connection.authType === "privateKey") {
    if (!connection.credential.privateKey) throw new Error(tr("该连接没有保存私钥"));
    config.privateKey = connection.credential.privateKey;
    if (connection.credential.passphrase) config.passphrase = connection.credential.passphrase;
  } else {
    if (!connection.credential.password) throw new Error(tr("该连接没有保存密码"));
    config.password = connection.credential.password;
    if (connection.authType === "keyboardInteractive") config.tryKeyboard = true;
  }
  return config;
}

function connectClient(connection: DesktopSshConnection, sock?: Readable): Promise<Client> {
  const keyboardInteractivePassword = connection.authType === "keyboardInteractive"
    ? connection.credential.password
    : undefined;
  return connectSshClient(new Client(), connectConfig(connection, sock), keyboardInteractivePassword);
}

function connectionMetadata(connection: DesktopSshConnection): Omit<DesktopSshConnection, "credential"> {
  const { credential: _credential, ...metadata } = connection;
  return metadata;
}

function forward(client: Client, host: string, port: number): Promise<Readable> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

async function createConnectedDesktopSsh(credential: DesktopSshCredential): Promise<ConnectedDesktopSsh> {
  const connection = credential.connection;
  if (!credential.jumpConnection) {
    const client = await connectClient(connection);
    return { client, connection: connectionMetadata(connection), close: () => client.end() };
  }
  const jump = credential.jumpConnection;
  if (jump.jumpConnectionId) throw new Error(tr("只支持单级跳板机"));
  const jumpClient = await connectClient(jump);
  try {
    const stream = await forward(jumpClient, connection.host, connection.port);
    const client = await connectClient(connection, stream);
    return {
      client,
      jumpClient,
      connection: connectionMetadata(connection),
      close: () => {
        client.end();
        jumpClient.end();
      },
    };
  } catch (error) {
    jumpClient.end();
    throw error;
  }
}

interface PooledDesktopSsh {
  connected: ConnectedDesktopSsh;
  usable: boolean;
}

const desktopSshPool = new IdleResourcePool<PooledDesktopSsh>({
  maxIdlePerKey: 2,
  usable: (resource) => resource.usable,
  dispose: (resource) => resource.connected.close(),
});

function desktopSshFingerprint(credential: DesktopSshCredential): string {
  return createHash("sha256").update(JSON.stringify(credential)).digest("hex");
}

async function leaseDesktopSsh(key: string, create: () => Promise<ConnectedDesktopSsh>): Promise<{
  connected: ConnectedDesktopSsh;
  reused: boolean;
}> {
  const lease = await desktopSshPool.acquire(key, async () => {
    const connected = await create();
    const resource: PooledDesktopSsh = { connected, usable: true };
    connected.client.once("close", () => { resource.usable = false; });
    connected.client.once("error", () => { resource.usable = false; });
    connected.jumpClient?.once("close", () => { resource.usable = false; });
    connected.jumpClient?.once("error", () => { resource.usable = false; });
    return resource;
  });
  return {
    connected: {
      ...lease.resource.connected,
      close: () => { void lease.release(); },
    },
    reused: lease.reused,
  };
}

export async function connectDesktopSsh(credential: DesktopSshCredential): Promise<ConnectedDesktopSsh> {
  const key = `${credential.connection.connectionId}\0${desktopSshFingerprint(credential)}`;
  return (await leaseDesktopSsh(key, () => createConnectedDesktopSsh(credential))).connected;
}

export async function connectDesktopSshConnection(
  connectionId: string,
  expectedContext: DesktopSshContext,
  loadCredential: DesktopSshCredentialLoader,
): Promise<DesktopSshConnectionLease> {
  const key = `${connectionId}\0runtime\0${contextKey(expectedContext)}`;
  const leased = await leaseDesktopSsh(key, async () => {
    const loaded = await loadCredential(connectionId);
    if (contextKey(loaded.context) !== contextKey(expectedContext)) {
      throw new Error(tr("SSH 连接所属用户或工作空间已经切换"));
    }
    return createConnectedDesktopSsh(loaded.credential);
  });
  return { context: expectedContext, ...leased };
}

export async function closeDesktopSshConnectionPool(connectionId?: string): Promise<void> {
  await desktopSshPool.invalidate(connectionId ? (key) => key.startsWith(`${connectionId}\0`) : undefined);
}

export async function executeDesktopSshCommand(
  credential: DesktopSshCredential,
  command: string,
  options: DesktopSshCommandOptions = {},
): Promise<DesktopSshCommandResult> {
  const connected = await connectDesktopSsh(credential);
  try {
    return await executeDesktopSshCommandOnConnection(connected, command, options);
  } finally {
    connected.close();
  }
}

export async function executeDesktopSshCommandOnConnection(
  connected: ConnectedDesktopSsh,
  command: string,
  options: DesktopSshCommandOptions = {},
): Promise<DesktopSshCommandResult> {
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const maxBytes = Math.max(1_024, Math.min(2 * 1024 * 1024, options.maxBytes ?? 512 * 1024));
  const started = Date.now();
  return new Promise<DesktopSshCommandResult>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      channel?.close();
      rejectOnce(new DesktopSshCommandAbortedError());
    };
    const timer = setTimeout(() => {
      channel?.close();
      rejectOnce(new Error(tr("SSH 命令执行超过 {{0}} ms", [timeoutMs])));
    }, timeoutMs);
    timer.unref();
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    connected.client.exec(command, (error, openedChannel) => {
      if (settled) {
        openedChannel?.close();
        return;
      }
      if (error) {
        rejectOnce(error);
        return;
      }
      channel = openedChannel;
      const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = Math.max(0, maxBytes - stdout.length - stderr.length);
        if (source.length > remaining) truncated = true;
        const bounded = source.subarray(0, remaining);
        if (target === "stdout") stdout = Buffer.concat([stdout, bounded]);
        else stderr = Buffer.concat([stderr, bounded]);
        if (!remaining) channel?.close();
      };
      channel.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      channel.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      channel.once("error", (channelError: Error) => rejectOnce(channelError));
      channel.once("close", (exitCode: number | undefined, signal: string | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode: exitCode ?? null, signal: signal ?? null, durationMs: Date.now() - started, truncated });
      });
    });
  });
}

export function openDesktopSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolve(sftp));
  });
}

function normalizedLoginScript(script: string): string {
  const normalized = script.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export class DesktopSshRuntime {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly agentDiagnostics = new Map<string, { sessionId: string; contextKey: string; controller: AbortController }>();
  private readonly tickets = new Map<string, SessionTicket>();
  private readonly recordings = new Map<string, StoredRecording>();
  private readonly indexPath: string;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly recordingsDirectory: string,
    private readonly emit: (event: DesktopSshSessionEvent) => void,
    private idleMinutes = 30,
  ) {
    mkdirSync(recordingsDirectory, { recursive: true });
    this.indexPath = join(recordingsDirectory, "index.json");
    this.loadRecordings();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  async create(
    context: DesktopSshContext,
    credential: DesktopSshCredential,
    cols: number,
    rows: number,
  ): Promise<{ session: DesktopSshSessionState; ticket: string }> {
    if (this.sessions.size >= SESSION_LIMIT) throw new Error(tr("SSH 会话已达到 {{0}} 个并发上限", [SESSION_LIMIT]));
    const connected = await connectDesktopSsh(credential);
    try {
      const shell = await new Promise<ClientChannel>((resolve, reject) => {
        connected.client.shell({
          term: connected.connection.options.terminalType ?? "xterm-256color",
          cols: Math.max(20, Math.min(500, Math.round(cols))),
          rows: Math.max(5, Math.min(300, Math.round(rows))),
        }, (error, channel) => error ? reject(error) : resolve(channel));
      });
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const state: DesktopSshSessionState = {
        id,
        connectionId: connected.connection.connectionId,
        connectionName: connected.connection.name,
        host: connected.connection.host,
        createdAt,
        attached: false,
      };
      const recordingId = randomUUID();
      const path = join(this.recordingsDirectory, `${recordingId}.cast`);
      const recordingStream = createWriteStream(path, { flags: "wx", mode: 0o600 });
      recordingStream.on("error", (error) => this.emit({ sessionId: id, type: "error", message: tr("终端录像写入失败：{{0}}", [error.message]) }));
      const recordingStartedAt = Date.now();
      const header = `${JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(recordingStartedAt / 1000), env: { TERM: connected.connection.options.terminalType ?? "xterm-256color", SHELL: "ssh" } })}\n`;
      recordingStream.write(header);
      const recording: StoredRecording = {
        id: recordingId,
        sessionId: id,
        connectionId: connected.connection.connectionId,
        connectionName: connected.connection.name,
        host: connected.connection.host,
        status: "recording",
        sizeBytes: Buffer.byteLength(header),
        startedAt: createdAt,
        closeReason: "",
        source: "desktop",
        path,
        ...context,
      };
      const managed: ManagedSession = {
        state,
        context,
        connected,
        shell,
        outputBuffer: Buffer.alloc(0),
        attached: false,
        closed: false,
        lastActivityAt: Date.now(),
        recording,
        recordingStream,
        recordingStartedAt,
      };
      this.sessions.set(id, managed);
      this.recordings.set(recordingId, recording);
      this.saveRecordings();
      shell.on("data", (chunk: Buffer | string) => this.onOutput(managed, chunk));
      shell.stderr.on("data", (chunk: Buffer | string) => this.onOutput(managed, chunk));
      shell.once("close", () => { void this.close(id, tr("远程 Shell 已关闭")); });
      connected.client.once("error", (error) => { void this.close(id, desktopSshErrorMessage(error)); });
      connected.client.once("end", () => { void this.close(id, tr("SSH 连接已结束")); });
      const loginScript = connected.connection.options.loginScript ?? "";
      if (connected.connection.options.loginScriptEnabled && loginScript.trim()) shell.write(normalizedLoginScript(loginScript));
      return { session: state, ticket: this.issueTicket(managed) };
    } catch (error) {
      connected.close();
      throw error;
    }
  }

  list(context: DesktopSshContext): DesktopSshSessionState[] {
    const key = contextKey(context);
    return [...this.sessions.values()]
      .filter((session) => !session.closed && contextKey(session.context) === key)
      .map((session) => ({ ...session.state, attached: session.attached }));
  }

  setIdleMinutes(value: number): void {
    if (Number.isInteger(value) && value > 0) this.idleMinutes = value;
  }

  activity(sessionId: string): number | null {
    const session = this.sessions.get(sessionId);
    return session && !session.closed ? session.lastActivityAt : null;
  }

  agentContext(sessionId: string, context: DesktopSshContext): AgentSshContextSnapshot {
    const session = this.sessionForContext(sessionId, context);
    return agentSshContextSnapshot({
      sessionId: session.state.id,
      connectionId: session.state.connectionId,
      connectionName: session.state.connectionName,
      host: session.state.host,
      output: session.outputBuffer,
      executionTarget: "desktop-local",
    });
  }

  async agentDiagnostic(
    executionId: string,
    sessionId: string,
    command: string,
    context: DesktopSshContext,
    options?: { allowWrite?: boolean },
  ): Promise<AgentSshDiagnosticResult> {
    const session = this.sessionForContext(sessionId, context);
    const normalizedCommand = normalizeAgentSshCommand(command);
    if (!options?.allowWrite && sshCommandRiskLevel(normalizedCommand) !== "low") throw new Error(tr("SSH 诊断执行只允许可证明为只读的命令"));
    if (options?.allowWrite && sshCommandRiskLevel(normalizedCommand) === "low") throw new Error(tr("可证明为只读的 SSH 命令请使用只读诊断，不要使用写执行"));
    if (this.agentDiagnostics.has(executionId)) throw new Error(tr("SSH 诊断执行 ID 已存在"));
    const controller = new AbortController();
    const active = { sessionId, contextKey: contextKey(context), controller };
    this.agentDiagnostics.set(executionId, active);
    session.lastActivityAt = Date.now();
    try {
      const result = await executeDesktopSshCommandOnConnection(session.connected, normalizedCommand, {
        timeoutMs: 30_000,
        maxBytes: 128 * 1024,
        signal: controller.signal,
      });
      const stdout = summarizeAgentSshOutput(result.stdout, { maxBytes: 64 * 1024, maxLines: 500 });
      const stderr = summarizeAgentSshOutput(result.stderr, { maxBytes: 64 * 1024, maxLines: 500 });
      return {
        executionId,
        sessionId,
        connectionId: session.state.connectionId,
        connectionName: session.state.connectionName,
        host: session.state.host,
        executionTarget: "desktop-local",
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

  cancelAgentDiagnostic(executionId: string, context: DesktopSshContext): { stopped: boolean } {
    const active = this.agentDiagnostics.get(executionId);
    if (!active || active.contextKey !== contextKey(context)) return { stopped: false };
    active.controller.abort();
    return { stopped: true };
  }

  ticket(sessionId: string, context: DesktopSshContext): string {
    const session = this.sessionForContext(sessionId, context);
    return this.issueTicket(session);
  }

  attach(sessionId: string, ticket: string, context: DesktopSshContext): { session: DesktopSshSessionState; output: string } {
    const session = this.sessionForContext(sessionId, context);
    const issued = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!issued || issued.sessionId !== sessionId || issued.contextKey !== contextKey(context) || issued.expiresAt <= Date.now()) {
      throw new Error(tr("终端票据无效或已过期"));
    }
    session.attached = true;
    session.state.attached = true;
    session.lastActivityAt = Date.now();
    return { session: { ...session.state }, output: session.outputBuffer.toString("base64") };
  }

  detach(sessionId: string, context: DesktopSshContext): void {
    const session = this.sessions.get(sessionId);
    if (!session || contextKey(session.context) !== contextKey(context)) return;
    session.attached = false;
    session.state.attached = false;
  }

  input(sessionId: string, context: DesktopSshContext, data: string | Uint8Array): Promise<void> {
    const session = this.sessionForContext(sessionId, context);
    session.lastActivityAt = Date.now();
    return new Promise((resolve, reject) => {
      session.shell.write(typeof data === "string" ? data : Buffer.from(data), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  resize(sessionId: string, context: DesktopSshContext, cols: number, rows: number): void {
    const session = this.sessionForContext(sessionId, context);
    const width = Math.max(20, Math.min(500, Math.round(cols)));
    const height = Math.max(5, Math.min(300, Math.round(rows)));
    session.lastActivityAt = Date.now();
    session.shell.setWindow(height, width, 0, 0);
  }

  async close(sessionId: string, reason = tr("用户关闭终端")): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    for (const active of this.agentDiagnostics.values()) {
      if (active.sessionId === sessionId) active.controller.abort();
    }
    this.emit({ sessionId, type: "closed", reason });
    session.shell.end();
    session.connected.close();
    session.recordingStream.end();
    session.recording.status = "completed";
    session.recording.endedAt = new Date().toISOString();
    session.recording.closeReason = reason;
    try { session.recording.sizeBytes = statSync(session.recording.path).size; } catch { /* Keep the observed byte count. */ }
    this.sessions.delete(sessionId);
    for (const [ticket, value] of this.tickets) if (value.sessionId === sessionId) this.tickets.delete(ticket);
    this.saveRecordings();
  }

  async closeContext(context: DesktopSshContext, reason: string): Promise<void> {
    const key = contextKey(context);
    await Promise.all([...this.sessions.values()]
      .filter((session) => contextKey(session.context) === key)
      .map((session) => this.close(session.state.id, reason)));
  }

  async closeConnection(connectionId: string, reason: string): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter((session) => session.state.connectionId === connectionId)
      .map((session) => this.close(session.state.id, reason)));
  }

  async closeAllSessions(reason: string): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, reason)));
  }

  async closeAll(reason = tr("Viron App 正在退出")): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.closeAllSessions(reason);
  }

  listRecordings(context: DesktopSshContext): DesktopSshRecording[] {
    const key = contextKey(context);
    return [...this.recordings.values()]
      .filter((recording) => contextKey(recording) === key)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((recording) => {
        let sizeBytes = recording.sizeBytes;
        try { sizeBytes = statSync(recording.path).size; } catch { /* Missing files stay visible for diagnosis. */ }
        return {
          id: recording.id,
          sessionId: recording.sessionId,
          connectionId: recording.connectionId,
          connectionName: recording.connectionName,
          host: recording.host,
          status: recording.status,
          sizeBytes,
          startedAt: recording.startedAt,
          endedAt: recording.endedAt,
          closeReason: recording.closeReason,
          source: "desktop" as const,
        };
      });
  }

  recordingFile(recordingId: string, context: DesktopSshContext): { path: string; filename: string } {
    const recording = this.recordings.get(recordingId);
    if (!recording || contextKey(recording) !== contextKey(context) || !existsSync(recording.path)) throw new Error(tr("终端录像不存在"));
    return { path: recording.path, filename: `${recording.connectionName}-${recording.id}.cast` };
  }

  deleteRecording(recordingId: string, context: DesktopSshContext): void {
    const recording = this.recordings.get(recordingId);
    if (!recording || contextKey(recording) !== contextKey(context)) throw new Error(tr("终端录像不存在"));
    if (recording.status === "recording") throw new Error(tr("活动会话的录像不能删除"));
    try { unlinkSync(recording.path); } catch { /* Removing stale metadata is still valid. */ }
    this.recordings.delete(recordingId);
    this.saveRecordings();
  }

  private sessionForContext(sessionId: string, context: DesktopSshContext): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed || contextKey(session.context) !== contextKey(context)) throw new Error(tr("SSH 会话不存在或已经结束"));
    return session;
  }

  private issueTicket(session: ManagedSession): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { sessionId: session.state.id, contextKey: contextKey(session.context), expiresAt: Date.now() + 30_000 });
    return ticket;
  }

  private onOutput(session: ManagedSession, chunk: Buffer | string): void {
    if (session.closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    session.lastActivityAt = Date.now();
    const buffered = Buffer.concat([session.outputBuffer, data]);
    session.outputBuffer = buffered.length > OUTPUT_BUFFER_LIMIT ? buffered.subarray(buffered.length - OUTPUT_BUFFER_LIMIT) : buffered;
    const elapsed = Math.max(0, (Date.now() - session.recordingStartedAt) / 1000);
    const event = `${JSON.stringify([Number(elapsed.toFixed(6)), "o", data.toString("utf8")])}\n`;
    session.recording.sizeBytes += Buffer.byteLength(event);
    session.recordingStream.write(event);
    if (session.attached) this.emit({ sessionId: session.state.id, type: "output", data: new Uint8Array(data) });
  }

  private loadRecordings(): void {
    try {
      const items = JSON.parse(readFileSync(this.indexPath, "utf8")) as StoredRecording[];
      const now = new Date().toISOString();
      for (const recording of items) {
        if (recording.status === "recording") {
          recording.status = "interrupted";
          recording.endedAt = now;
          recording.closeReason = tr("Viron App 非正常中断");
        }
        this.recordings.set(recording.id, recording);
      }
      this.saveRecordings();
    } catch {
      // The first launch has no recording index.
    }
  }

  private saveRecordings(): void {
    writeFileSync(this.indexPath, `${JSON.stringify([...this.recordings.values()], null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.idleMinutes * 60_000;
    for (const session of this.sessions.values()) {
      if (session.lastActivityAt < cutoff) void this.close(session.state.id, tr("空闲超过 {{0}} 分钟", [this.idleMinutes]));
    }
    for (const [ticket, value] of this.tickets) if (value.expiresAt <= Date.now()) this.tickets.delete(ticket);
  }
}
