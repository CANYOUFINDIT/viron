import { translate as tr } from "./i18n.js";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import { buildSshLogSnapshotCommand, buildSshLogTailCommand } from "../shared/environment-log.js";
import type { DesktopSshCredential } from "./device-identity.js";
import {
  connectDesktopSshConnection,
  desktopSshErrorMessage,
  executeDesktopSshCommandOnConnection,
  type ConnectedDesktopSsh,
  type DesktopSshContext,
} from "./ssh-runtime.js";

export interface DesktopLogDefinition {
  logId: string;
  logName: string;
  sshConnectionId: string;
  filePaths: string[];
  initialLines: number;
}

export interface DesktopLogStreamState {
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

export type DesktopLogStreamEvent =
  | { streamId: string; logId: string; type: "ready"; stream: DesktopLogStreamState }
  | { streamId: string; logId: string; type: "output" | "stderr"; data: string }
  | { streamId: string; logId: string; type: "closed"; reason: string }
  | { streamId: string; logId: string; type: "error"; message: string };

interface ManagedDesktopLogStream {
  state: DesktopLogStreamState;
  context: DesktopSshContext;
  connected: ConnectedDesktopSsh;
  channel: ClientChannel;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  closed: boolean;
  lastActivityAt: number;
}

const DESKTOP_LOG_STREAM_LIMIT = 3;

function contextKey(context: DesktopSshContext): string {
  return `${context.endpoint}\0${context.userId}\0${context.workspaceType}\0${context.workspaceId}`;
}

function normalizedLoginScript(script: string): string {
  const normalized = script.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export class DesktopLogRuntime {
  private readonly streams = new Map<string, ManagedDesktopLogStream>();

  constructor(
    private readonly loadCredential: (connectionId: string) => Promise<{ context: DesktopSshContext; credential: DesktopSshCredential }>,
    private readonly currentContext: () => Promise<DesktopSshContext>,
    private readonly emit: (event: DesktopLogStreamEvent) => void,
  ) {}

  async create(definition: DesktopLogDefinition): Promise<{ stream: DesktopLogStreamState }> {
    if (this.streams.size >= DESKTOP_LOG_STREAM_LIMIT) {
      throw new Error(tr("桌面 App 最多同时查看 {{0}} 个实时日志", [DESKTOP_LOG_STREAM_LIMIT]));
    }
    const loaded = await connectDesktopSshConnection(definition.sshConnectionId, await this.currentContext(), this.loadCredential);
    const connected = loaded.connected;
    try {
      const command = buildSshLogTailCommand(definition.filePaths, definition.initialLines);
      const loginScript = connected.connection.options.loginScript ?? "";
      const useLoginScript = connected.connection.options.loginScriptEnabled === true && Boolean(loginScript.trim());
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const complete = (error: Error | undefined, createdChannel: ClientChannel) => error ? reject(error) : resolve(createdChannel);
        if (useLoginScript) {
          connected.client.shell({
            term: connected.connection.options.terminalType ?? "xterm-256color",
            cols: 120,
            rows: 40,
          }, complete);
        } else {
          connected.client.exec(command, complete);
        }
      });
      const id = randomUUID();
      const state: DesktopLogStreamState = {
        id,
        logId: definition.logId,
        logName: definition.logName,
        filePath: definition.filePaths[0] ?? "",
        filePaths: [...definition.filePaths],
        initialLines: definition.initialLines,
        connectionId: connected.connection.connectionId,
        connectionName: connected.connection.name,
        host: connected.connection.host,
        createdAt: new Date().toISOString(),
      };
      const managed: ManagedDesktopLogStream = {
        state,
        context: loaded.context,
        connected,
        channel,
        stdoutDecoder: new StringDecoder("utf8"),
        stderrDecoder: new StringDecoder("utf8"),
        closed: false,
        lastActivityAt: Date.now(),
      };
      this.streams.set(id, managed);
      channel.on("data", (chunk: Buffer | string) => this.onOutput(managed, "output", chunk));
      channel.stderr.on("data", (chunk: Buffer | string) => this.onOutput(managed, "stderr", chunk));
      channel.once("close", (code: number | undefined, signal: string | undefined) => {
        const reason = code && code !== 0
          ? tr("tail 已退出（状态码 {{0}}{{1}}）", [code, signal ? `，信号 ${signal}` : ""])
          : tr("远程 tail 已结束");
        this.close(id, undefined, reason);
      });
      connected.client.once("error", (error) => this.fail(managed, desktopSshErrorMessage(error)));
      connected.client.once("end", () => this.close(id, undefined, tr("SSH 连接已结束")));
      if (useLoginScript) {
        channel.write(normalizedLoginScript(loginScript));
        channel.write(`${command}\n`);
      }
      this.emit({ streamId: id, logId: state.logId, type: "ready", stream: state });
      return { stream: state };
    } catch (error) {
      connected.close();
      throw new Error(desktopSshErrorMessage(error));
    }
  }

  async snapshot(definition: DesktopLogDefinition, maxBytes: number): Promise<{
    logId: string;
    name: string;
    filePaths: string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    truncated: boolean;
  }> {
    const loaded = await connectDesktopSshConnection(definition.sshConnectionId, await this.currentContext(), this.loadCredential);
    try {
      const result = await executeDesktopSshCommandOnConnection(
        loaded.connected,
        buildSshLogSnapshotCommand(definition.filePaths, definition.initialLines),
        { timeoutMs: 30_000, maxBytes },
      );
      return { logId: definition.logId, name: definition.logName, filePaths: [...definition.filePaths], ...result };
    } finally {
      loaded.connected.close();
    }
  }

  close(streamId: string, context?: DesktopSshContext, reason = tr("用户停止查看日志")): boolean {
    const stream = this.streams.get(streamId);
    if (!stream || stream.closed) return false;
    if (context && contextKey(stream.context) !== contextKey(context)) throw new Error(tr("实时日志不存在或已经结束"));
    stream.closed = true;
    const stdoutTail = stream.stdoutDecoder.end();
    const stderrTail = stream.stderrDecoder.end();
    if (stdoutTail) this.emit({ streamId, logId: stream.state.logId, type: "output", data: stdoutTail });
    if (stderrTail) this.emit({ streamId, logId: stream.state.logId, type: "stderr", data: stderrTail });
    this.emit({ streamId, logId: stream.state.logId, type: "closed", reason });
    stream.channel.end();
    stream.connected.close();
    this.streams.delete(streamId);
    return true;
  }

  activeCount(): number {
    return this.streams.size;
  }

  activity(streamId: string): number | null {
    const stream = this.streams.get(streamId);
    return stream && !stream.closed ? stream.lastActivityAt : null;
  }

  closeLog(logId: string, reason: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.state.logId === logId) this.close(stream.state.id, undefined, reason);
    }
  }

  closeConnection(connectionId: string, reason: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.state.connectionId === connectionId) this.close(stream.state.id, undefined, reason);
    }
  }

  closeContext(context: DesktopSshContext, reason: string): void {
    const key = contextKey(context);
    for (const stream of [...this.streams.values()]) {
      if (contextKey(stream.context) === key) this.close(stream.state.id, undefined, reason);
    }
  }

  closeAll(reason = tr("Viron App 正在退出")): void {
    for (const streamId of [...this.streams.keys()]) this.close(streamId, undefined, reason);
  }

  private onOutput(stream: ManagedDesktopLogStream, type: "output" | "stderr", chunk: Buffer | string): void {
    if (stream.closed) return;
    const decoder = type === "output" ? stream.stdoutDecoder : stream.stderrDecoder;
    const data = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (data) {
      stream.lastActivityAt = Date.now();
      this.emit({ streamId: stream.state.id, logId: stream.state.logId, type, data });
    }
  }

  private fail(stream: ManagedDesktopLogStream, message: string): void {
    if (stream.closed) return;
    this.emit({ streamId: stream.state.id, logId: stream.state.logId, type: "error", message });
    this.close(stream.state.id, undefined, message);
  }
}
