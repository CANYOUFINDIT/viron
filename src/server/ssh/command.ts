import type { ClientChannel } from "ssh2";
import type { FastifyInstance } from "fastify";
import { connectSsh, type ConnectedSsh } from "./connector.js";

export interface SshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  truncated: boolean;
}

export class SshCommandAbortedError extends Error {
  readonly code = "SSH_COMMAND_ABORTED";

  constructor() {
    super("SSH 诊断命令已取消");
    this.name = "SshCommandAbortedError";
  }
}

const maxSshCommandOutputBytes = 16 * 1024 * 1024;

export async function executeSshCommand(
  app: FastifyInstance,
  connectionId: string,
  command: string,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SshCommandResult> {
  const connected = await connectSsh(app, connectionId);
  try {
    return await executeSshCommandOnConnection(connected, command, options);
  } finally {
    connected.close();
  }
}

export async function executeSshCommandOnConnection(
  connected: ConnectedSsh,
  command: string,
  options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SshCommandResult> {
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const maxBytes = Math.max(1_024, Math.min(maxSshCommandOutputBytes, options.maxBytes ?? 512 * 1024));
  const started = Date.now();
  return new Promise<SshCommandResult>((resolve, reject) => {
      let channel: ClientChannel | undefined;
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
        rejectOnce(new SshCommandAbortedError());
      };
      const timer = setTimeout(() => {
        channel?.close();
        rejectOnce(new Error(`SSH 命令执行超过 ${timeoutMs} ms`));
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
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let truncated = false;
        const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
          const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const total = stdout.length + stderr.length;
          const remaining = Math.max(0, maxBytes - total);
          const exceedsLimit = source.length > remaining;
          if (exceedsLimit) truncated = true;
          const bounded = source.subarray(0, remaining);
          if (target === "stdout") stdout = Buffer.concat([stdout, bounded]);
          else stderr = Buffer.concat([stderr, bounded]);
          if (!remaining || exceedsLimit) channel?.close();
        };
        openedChannel.on("data", (chunk: Buffer | string) => append("stdout", chunk));
        openedChannel.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
        openedChannel.once("error", (channelError: Error) => rejectOnce(channelError));
        openedChannel.once("close", (exitCode: number | undefined, signal: string | undefined) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            exitCode: exitCode ?? null,
            signal: signal ?? null,
            durationMs: Date.now() - started,
            truncated,
          });
        });
      });
    });
}

export async function executeSshScript(
  app: FastifyInstance,
  connectionId: string,
  script: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SshCommandResult> {
  const connected = await connectSsh(app, connectionId);
  try {
    const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 120_000));
    const maxBytes = Math.max(1_024, Math.min(maxSshCommandOutputBytes, options.maxBytes ?? 1024 * 1024));
    const started = Date.now();
    return await new Promise<SshCommandResult>((resolve, reject) => {
      connected.client.exec("/bin/sh -s", (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let truncated = false;
        let settled = false;
        const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
          const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = Math.max(0, maxBytes - stdout.length - stderr.length);
          if (source.length > remaining) truncated = true;
          const bounded = source.subarray(0, remaining);
          if (target === "stdout") stdout = Buffer.concat([stdout, bounded]);
          else stderr = Buffer.concat([stderr, bounded]);
          if (!remaining || source.length > remaining) channel.close();
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          channel.close();
          reject(new Error(`SSH 脚本执行超过 ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref();
        channel.on("data", (chunk: Buffer | string) => append("stdout", chunk));
        channel.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
        channel.once("error", (channelError: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(channelError);
        });
        channel.once("close", (exitCode: number | undefined, signal: string | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
            exitCode: exitCode ?? null,
            signal: signal ?? null,
            durationMs: Date.now() - started,
            truncated,
          });
        });
        channel.end(script.endsWith("\n") ? script : `${script}\n`);
      });
    });
  } finally {
    connected.close();
  }
}
