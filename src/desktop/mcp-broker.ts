import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import { join } from "node:path";
import type {
  VironMcpBrokerDescriptor,
  VironMcpBrokerRequest,
  VironMcpBrokerResponse,
} from "../shared/mcp-protocol.js";
import type { DesktopMcpClientInfo } from "../shared/mcp-settings.js";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_PREVIEW = 64 * 1024;
const DEFAULT_INVOKE_TIMEOUT_MS = 125_000;

function brokerAddress(userDataDirectory: string, token: string): { transport: "unix" | "pipe"; address: string } {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(`${userDataDirectory}\0${token}`).digest("hex").slice(0, 24);
    return { transport: "pipe", address: `\\\\.\\pipe\\viron-mcp-${id}` };
  }
  return { transport: "unix", address: join(userDataDirectory, "viron-mcp.sock") };
}

function responseLine(response: VironMcpBrokerResponse): string {
  return `${JSON.stringify(response)}\n`;
}

function boundedResponseLine(response: VironMcpBrokerResponse): string {
  const line = responseLine(response);
  const originalBytes = Buffer.byteLength(line);
  if (originalBytes <= MAX_MESSAGE_BYTES) return line;
  return responseLine({
    id: response.id,
    ok: true,
    result: {
      status: 413,
      headers: {},
      data: {
        error: "MCP_RESULT_TOO_LARGE",
        message: "Viron MCP Broker 响应超过 16 MiB 限制，请缩小查询范围或分批读取。",
        truncated: true,
        originalBytes,
        preview: line.slice(0, MAX_RESULT_PREVIEW),
      },
    },
  });
}

export class DesktopMcpBroker {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Map<Socket, DesktopMcpClientInfo>();
  private descriptor: VironMcpBrokerDescriptor | null = null;

  constructor(
    private readonly userDataDirectory: string,
    private readonly appVersion: string,
    private readonly invoke: (toolName: string, arguments_: Record<string, unknown>) => Promise<unknown>,
    private readonly invokeTimeoutMs = DEFAULT_INVOKE_TIMEOUT_MS,
  ) {}

  get descriptorPath(): string {
    return join(this.userDataDirectory, "viron-mcp.json");
  }

  status(): { running: boolean; transport: "unix" | "pipe"; address: string | null; clients: DesktopMcpClientInfo[] } {
    return {
      running: Boolean(this.descriptor),
      transport: process.platform === "win32" ? "pipe" : "unix",
      address: this.descriptor?.address ?? null,
      clients: [...this.clients.values()].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt)),
    };
  }

  async start(): Promise<VironMcpBrokerDescriptor> {
    if (this.descriptor) return this.descriptor;
    await mkdir(this.userDataDirectory, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    const endpoint = brokerAddress(this.userDataDirectory, token);
    if (endpoint.transport === "unix") await rm(endpoint.address, { force: true });
    const server = net.createServer((socket) => this.accept(socket, token));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint.address);
    });
    if (endpoint.transport === "unix") await chmod(endpoint.address, 0o600);
    const descriptor: VironMcpBrokerDescriptor = {
      protocolVersion: 1,
      transport: endpoint.transport,
      address: endpoint.address,
      token,
      pid: process.pid,
      appVersion: this.appVersion,
      updatedAt: new Date().toISOString(),
    };
    const temporaryPath = `${this.descriptorPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.descriptorPath);
    await chmod(this.descriptorPath, 0o600);
    this.descriptor = descriptor;
    return descriptor;
  }

  async close(): Promise<void> {
    const descriptor = this.descriptor;
    this.descriptor = null;
    for (const socket of this.sockets) {
      if (this.clients.has(socket)) {
        socket.end(responseLine({
          id: "broker-shutdown",
          ok: false,
          error: { code: "BROKER_SHUTDOWN", message: "Viron App 本机 MCP 已关闭" },
        }));
      } else socket.destroy();
    }
    this.sockets.clear();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(this.descriptorPath, { force: true });
    if (descriptor?.transport === "unix") await rm(descriptor.address, { force: true });
  }

  private accept(socket: Socket, token: string): void {
    this.sockets.add(socket);
    let authenticated = false;
    let buffer = "";
    let messageQueue = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("Viron MCP Broker 消息超过 16 MiB 限制"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          messageQueue = messageQueue.then(async () => {
            const result = await this.handleLine(socket, line, token, authenticated);
            authenticated ||= result.authenticated;
          }).catch((error) => {
            socket.destroy(error instanceof Error ? error : new Error(String(error)));
          });
        }
        newline = buffer.indexOf("\n");
      }
    });
    const cleanup = () => {
      this.sockets.delete(socket);
      this.clients.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  }

  private async handleLine(socket: Socket, line: string, token: string, authenticated: boolean): Promise<{ authenticated: boolean }> {
    let request: VironMcpBrokerRequest;
    try {
      request = JSON.parse(line) as VironMcpBrokerRequest;
    } catch {
      socket.write(responseLine({ id: "invalid", ok: false, error: { code: "INVALID_JSON", message: "Broker 请求不是有效 JSON" } }));
      return { authenticated };
    }
    if (!request || typeof request.id !== "string" || typeof request.type !== "string") {
      socket.write(responseLine({ id: "invalid", ok: false, error: { code: "INVALID_REQUEST", message: "Broker 请求格式无效" } }));
      return { authenticated };
    }
    if (request.type === "hello") {
      const valid = request.protocolVersion === 1 && request.token === token;
      socket.write(responseLine(valid
        ? { id: request.id, ok: true, result: { protocolVersion: 1, appVersion: this.appVersion } }
        : { id: request.id, ok: false, error: { code: "BROKER_AUTH_FAILED", message: "Viron App 实例握手失败" } }));
      if (valid) {
        const now = new Date().toISOString();
        this.clients.set(socket, {
          id: randomUUID(),
          clientName: typeof request.clientInfo?.name === "string" && request.clientInfo.name.trim()
            ? request.clientInfo.name.trim().slice(0, 120)
            : "未知客户端",
          clientVersion: typeof request.clientInfo?.version === "string" ? request.clientInfo.version.trim().slice(0, 80) : "",
          connectedAt: now,
          lastActivityAt: now,
        });
      } else socket.end();
      return { authenticated: valid };
    }
    if (!authenticated) {
      socket.write(responseLine({ id: request.id, ok: false, error: { code: "BROKER_AUTH_REQUIRED", message: "请先完成 Viron App 实例握手" } }));
      return { authenticated };
    }
    if (request.type !== "invoke" || typeof request.toolName !== "string" || !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) {
      socket.write(responseLine({ id: request.id, ok: false, error: { code: "INVALID_INVOKE", message: "MCP 工具调用格式无效" } }));
      return { authenticated };
    }
    try {
      const client = this.clients.get(socket);
      if (client) client.lastActivityAt = new Date().toISOString();
      const result = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Viron MCP Broker 调用超时（${this.invokeTimeoutMs} ms）`)),
          this.invokeTimeoutMs,
        );
        void this.invoke(request.toolName, request.arguments).then(
          (value) => { clearTimeout(timeout); resolve(value); },
          (error) => { clearTimeout(timeout); reject(error); },
        );
      });
      socket.write(boundedResponseLine({ id: request.id, ok: true, result }));
    } catch (error) {
      socket.write(responseLine({
        id: request.id,
        ok: false,
        error: { code: "MCP_INVOKE_FAILED", message: error instanceof Error ? error.message : String(error) },
      }));
    }
    return { authenticated };
  }
}
