import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  McpApiResponse,
  VironMcpBackend,
  VironMcpBrokerDescriptor,
  VironMcpBrokerRequest,
  VironMcpBrokerResponse,
} from "../shared/mcp-protocol.js";
import { registerVironMcpTools } from "../shared/mcp-tools.js";
import { defaultVironMcpDescriptorPath } from "./mcp-path.js";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 130_000;

function timeoutSetting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 50 ? value : fallback;
}

const CONNECT_TIMEOUT_MS = timeoutSetting("VIRON_MCP_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS = timeoutSetting("VIRON_MCP_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS);

class DesktopBrokerBackend implements VironMcpBackend {
  private socket: Socket | null = null;
  private buffer = "";
  private authenticated = false;
  private brokerToken = "";
  private readonly intentionalDisconnects = new WeakSet<Socket>();
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private readonly clientInfo: () => { name: string; version: string } | undefined,
    private readonly onBrokerDisconnect: () => void,
  ) {}

  async invoke(toolName: string, arguments_: Record<string, unknown>): Promise<McpApiResponse> {
    await this.connect();
    return await this.request({ id: randomUUID(), type: "invoke", toolName, arguments: arguments_ }) as McpApiResponse;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async refreshClientInfo(): Promise<void> {
    const clientInfo = this.clientInfo();
    if (!clientInfo || !this.socket || this.socket.destroyed || !this.authenticated) return;
    await this.request({
      id: randomUUID(),
      type: "hello",
      token: this.brokerToken,
      protocolVersion: 1,
      clientInfo,
    }, CONNECT_TIMEOUT_MS);
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.intentionalDisconnects.add(this.socket);
      this.socket.end();
    }
    this.failPending(new Error("Viron MCP STDIO 正在关闭"));
    this.socket = null;
    this.buffer = "";
    this.authenticated = false;
    this.brokerToken = "";
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.authenticated) return;
    await this.close();
    const descriptorPath = defaultVironMcpDescriptorPath();
    let descriptor: VironMcpBrokerDescriptor;
    try {
      descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as VironMcpBrokerDescriptor;
    } catch {
      throw new Error(`Viron App 未运行或 MCP Broker 不可用：${descriptorPath}`);
    }
    if (descriptor.protocolVersion !== 1 || !descriptor.address || !descriptor.token) throw new Error("Viron MCP Broker 描述文件无效");
    this.brokerToken = descriptor.token;
    const socket = net.createConnection(descriptor.address);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.once("close", () => {
      const shouldExit = this.socket === socket && this.authenticated && !this.intentionalDisconnects.has(socket);
      if (this.socket === socket) {
        this.socket = null;
        this.authenticated = false;
      }
      this.failPending(new Error("Viron App MCP Broker 已断开"));
      if (shouldExit) this.onBrokerDisconnect();
    });
    socket.once("error", (error) => this.failPending(error));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`连接 Viron MCP Broker 超时（${CONNECT_TIMEOUT_MS} ms）`);
        this.intentionalDisconnects.add(socket);
        socket.destroy(error);
        reject(error);
      }, CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const clientInfo = this.clientInfo();
    await this.request({
      id: randomUUID(),
      type: "hello",
      token: descriptor.token,
      protocolVersion: 1,
      ...(clientInfo ? { clientInfo } : {}),
    }, CONNECT_TIMEOUT_MS);
    this.authenticated = true;
  }

  private request(request: VironMcpBrokerRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("Viron App MCP Broker 未连接"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(request.id)) return;
        const error = new Error(`Viron MCP Broker 请求超时（${timeoutMs} ms）`);
        reject(error);
        this.intentionalDisconnects.add(socket);
        socket.destroy(error);
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timeout });
      socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(request.id);
        if (pending) clearTimeout(pending.timeout);
        this.pending.delete(request.id);
        reject(error);
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.buffer = "";
      if (this.socket) {
        this.intentionalDisconnects.add(this.socket);
        this.socket.destroy(new Error("Viron MCP Broker 响应超过 16 MiB 限制"));
      }
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let response: VironMcpBrokerResponse;
    try {
      response = JSON.parse(line) as VironMcpBrokerResponse;
    } catch {
      if (this.socket) {
        this.intentionalDisconnects.add(this.socket);
        this.socket.destroy(new Error("Viron MCP Broker 返回了无效 JSON"));
      }
      return;
    }
    if (!response.ok && response.error.code === "BROKER_SHUTDOWN") {
      this.onBrokerDisconnect();
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error.message));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function packageVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return manifest.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let server: McpServer;
const backend = new DesktopBrokerBackend(
  () => server.server.getClientVersion(),
  () => { void server.close().finally(() => process.exit(0)); },
);
server = new McpServer({ name: "viron", version: await packageVersion() }, {
  instructions: "Start with viron_context and viron_domains_list. Use viron_operations_search for the relevant domain; call viron_operation_schema only when inputSummary is insufficient, then invoke the gateway matching the returned mode. This local MCP uses the running Viron App, signed-in Endpoint, current user, current workspace, and selected execution mode. It never returns saved secrets or silently falls back between local and server execution.",
});
registerVironMcpTools(server, backend);
const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 20 * 1024 * 1024 });
transport.onerror = (error) => process.stderr.write(`Viron MCP STDIO error: ${error.message}\n`);
transport.onclose = () => { void backend.close(); };
server.server.oninitialized = () => {
  void backend.refreshClientInfo().catch((error) => {
    process.stderr.write(`Viron MCP client handshake failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
};

try {
  await backend.start();
  await server.connect(transport);
} catch (error) {
  process.stderr.write(`Viron MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await backend.close();
  process.exit(1);
}

const shutdown = () => {
  void backend.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
