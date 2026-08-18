import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopMcpBroker } from "../src/desktop/mcp-broker.js";
import { defaultVironMcpDescriptorPath } from "../src/desktop/mcp-path.js";
import type { VironMcpBrokerDescriptor, VironMcpBrokerResponse } from "../src/shared/mcp-protocol.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function exchange(address: string, messages: unknown[]): Promise<VironMcpBrokerResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const responses: VironMcpBrokerResponse[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) responses.push(JSON.parse(line) as VironMcpBrokerResponse);
        if (responses.length === messages.length) {
          socket.end();
          resolve(responses);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("connect", () => socket.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"));
  });
}

describe("desktop MCP broker", () => {
  it("requires the per-launch handshake and invokes only after authentication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-broker-"));
    directories.push(directory);
    const calls: Array<{ toolName: string; arguments: Record<string, unknown> }> = [];
    let observedClient: ReturnType<DesktopMcpBroker["status"]>["clients"][number] | undefined;
    const broker = new DesktopMcpBroker(directory, "1.2.3", async (toolName, arguments_) => {
      calls.push({ toolName, arguments: arguments_ });
      observedClient = broker.status().clients[0];
      return { status: 200, headers: {}, data: { ok: true } };
    });
    const descriptor = await broker.start();
    try {
      const stored = JSON.parse(readFileSync(broker.descriptorPath, "utf8")) as VironMcpBrokerDescriptor;
      expect(stored).toMatchObject({ protocolVersion: 1, appVersion: "1.2.3", address: descriptor.address });
      if (process.platform !== "win32") expect(statSync(broker.descriptorPath).mode & 0o777).toBe(0o600);
      const responses = await exchange(descriptor.address, [
        { id: "1", type: "invoke", toolName: "viron_context_get", arguments: {} },
        { id: "2", type: "hello", token: descriptor.token, protocolVersion: 1, clientInfo: { name: "Codex", version: "1.2.0" } },
        { id: "3", type: "invoke", toolName: "viron_context_get", arguments: {} },
      ]);
      expect(responses[0]).toMatchObject({ id: "1", ok: false, error: { code: "BROKER_AUTH_REQUIRED" } });
      expect(responses[1]).toMatchObject({ id: "2", ok: true });
      expect(responses[2]).toMatchObject({ id: "3", ok: true, result: { status: 200 } });
      expect(calls).toEqual([{ toolName: "viron_context_get", arguments: {} }]);
      expect(observedClient).toMatchObject({ clientName: "Codex", clientVersion: "1.2.0" });
      expect(broker.status()).toMatchObject({ running: true, transport: process.platform === "win32" ? "pipe" : "unix" });
    } finally {
      await broker.close();
    }
    expect(broker.status()).toMatchObject({ running: false, address: null, clients: [] });
  });

  it("resolves descriptor paths for packaged macOS and Windows clients", () => {
    expect(defaultVironMcpDescriptorPath("darwin", {}, "/Users/test")).toBe("/Users/test/Library/Application Support/Viron/viron-mcp.json");
    expect(defaultVironMcpDescriptorPath("win32", { APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "C:\\Users\\test"))
      .toBe("C:\\Users\\test\\AppData\\Roaming/Viron/viron-mcp.json");
    expect(defaultVironMcpDescriptorPath("darwin", { VIRON_MCP_DESCRIPTOR: "/tmp/custom.json" }, "/Users/test")).toBe("/tmp/custom.json");
  });

  it("serves the shared tools end to end through the STDIO client transport", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-stdio-"));
    directories.push(directory);
    const broker = new DesktopMcpBroker(directory, "1.2.3", async (toolName) => {
      if (toolName !== "viron_context_get" && toolName !== "__resource_current_context") throw new Error(`unexpected tool ${toolName}`);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        data: { user: { username: "desktop-user" }, workspace: { type: "personal" } },
      };
    });
    await broker.start();
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    environment.VIRON_MCP_DESCRIPTOR = broker.descriptorPath;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "desktop", "mcp-stdio.ts")],
      env: environment,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "viron-stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("viron_secure");
      expect(JSON.stringify(tools.tools).length).toBeLessThan(20_000);
      const context = await client.callTool({ name: "viron_context", arguments: {} });
      expect(context.structuredContent).toMatchObject({ result: { status: 200, data: { user: { username: "desktop-user" } } } });
      expect(context.content[0]).toMatchObject({ type: "text", text: expect.not.stringContaining("desktop-user") });
      expect(broker.status().clients).toEqual([
        expect.objectContaining({ clientName: "viron-stdio-test", clientVersion: "1.0.0" }),
      ]);
      const adapterPid = transport.pid;
      expect(adapterPid).not.toBeNull();
      await broker.close();
      await vi.waitFor(() => expect(() => process.kill(adapterPid!, 0)).toThrow(), { timeout: 2_000 });
    } finally {
      await client.close();
      await broker.close();
    }
  });

  it("fails STDIO startup before publishing tools when the Broker descriptor is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-missing-"));
    directories.push(directory);
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    environment.VIRON_MCP_DESCRIPTOR = join(directory, "missing.json");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "desktop", "mcp-stdio.ts")],
      env: environment,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "viron-stdio-missing-test", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => undefined);
  });

  it("bounds a stuck Broker invocation and continues with the next request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-timeout-"));
    directories.push(directory);
    let calls = 0;
    const broker = new DesktopMcpBroker(directory, "1.2.3", async () => {
      calls += 1;
      if (calls === 1) return await new Promise(() => undefined);
      return { status: 200, headers: {}, data: { recovered: true } };
    }, 50);
    const descriptor = await broker.start();
    try {
      const responses = await exchange(descriptor.address, [
        { id: "1", type: "hello", token: descriptor.token, protocolVersion: 1 },
        { id: "2", type: "invoke", toolName: "viron_context_get", arguments: {} },
        { id: "3", type: "invoke", toolName: "viron_context_get", arguments: {} },
      ]);
      expect(responses[1]).toMatchObject({ id: "2", ok: false, error: { code: "MCP_INVOKE_FAILED" } });
      expect(responses[1].ok ? "" : responses[1].error.message).toContain("调用超时");
      expect(responses[2]).toMatchObject({ id: "3", ok: true, result: { data: { recovered: true } } });
    } finally {
      await broker.close();
    }
  });

  it("bounds oversized broker responses and keeps later invocations usable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-broker-limit-"));
    directories.push(directory);
    let calls = 0;
    const broker = new DesktopMcpBroker(directory, "1.2.3", async () => {
      calls += 1;
      return calls === 1
        ? { status: 200, headers: {}, data: { value: "x".repeat(17 * 1024 * 1024) } }
        : { status: 200, headers: {}, data: { ok: true } };
    });
    const descriptor = await broker.start();
    try {
      const responses = await exchange(descriptor.address, [
        { id: "1", type: "hello", token: descriptor.token, protocolVersion: 1 },
        { id: "2", type: "invoke", toolName: "viron_context_get", arguments: {} },
        { id: "3", type: "invoke", toolName: "viron_context_get", arguments: {} },
      ]);
      expect(responses[1]).toMatchObject({
        id: "2",
        ok: true,
        result: { status: 413, data: { error: "MCP_RESULT_TOO_LARGE", truncated: true } },
      });
      expect(Buffer.byteLength(JSON.stringify(responses[1]))).toBeLessThan(100 * 1024);
      expect(responses[2]).toMatchObject({ id: "3", ok: true, result: { status: 200, data: { ok: true } } });
    } finally {
      await broker.close();
    }
  });

  it("recovers after an oversized response from a legacy broker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-legacy-limit-"));
    directories.push(directory);
    const address = join(directory, "broker.sock");
    let invocations = 0;
    const fakeBroker = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as { id: string; type: string };
          if (request.type === "hello") {
            socket.write(`${JSON.stringify({ id: request.id, ok: true, result: { protocolVersion: 1, appVersion: "1.2.3" } })}\n`);
          } else {
            invocations += 1;
            const result = invocations === 1
              ? { status: 200, headers: {}, data: { value: "x".repeat(17 * 1024 * 1024) } }
              : { status: 200, headers: {}, data: { recovered: true } };
            socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeBroker.once("error", reject);
      fakeBroker.listen(address, resolve);
    });
    writeFileSync(join(directory, "viron-mcp.json"), JSON.stringify({
      protocolVersion: 1,
      transport: "unix",
      address,
      token: "legacy-token",
      pid: process.pid,
      appVersion: "1.2.3",
      updatedAt: new Date().toISOString(),
    }));
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    environment.VIRON_MCP_DESCRIPTOR = join(directory, "viron-mcp.json");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "desktop", "mcp-stdio.ts")],
      env: environment,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "viron-stdio-recovery-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const oversized = await client.callTool({ name: "viron_context", arguments: {} });
      expect(oversized.structuredContent).toMatchObject({ result: { status: 500, data: { error: "MCP_TOOL_FAILED" } } });
      const recovered = await client.callTool({ name: "viron_context", arguments: {} });
      expect(recovered.structuredContent).toMatchObject({ result: { status: 200, data: { recovered: true } } });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => fakeBroker.close(() => resolve()));
    }
  }, 20_000);

  it("bounds oversized structured tool results while preserving a preview", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-mcp-result-limit-"));
    directories.push(directory);
    const broker = new DesktopMcpBroker(directory, "1.2.3", async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { value: "x".repeat(13 * 1024 * 1024) },
    }));
    await broker.start();
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    environment.VIRON_MCP_DESCRIPTOR = broker.descriptorPath;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "src", "desktop", "mcp-stdio.ts")],
      env: environment,
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "viron-stdio-limit-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "viron_context", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        result: {
          status: 200,
          data: { error: "MCP_RESULT_TOO_LARGE", truncated: true },
        },
      });
      expect(JSON.stringify(result.structuredContent).length).toBeLessThan(100 * 1024);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.content[0].type === "text" ? result.content[0].text.length : 0).toBeLessThan(600 * 1024);
    } finally {
      await client.close();
      await broker.close();
    }
  }, 15_000);
});
