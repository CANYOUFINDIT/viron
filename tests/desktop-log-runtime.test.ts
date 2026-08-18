import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopSshConnection, DesktopSshCredential } from "../src/desktop/device-identity.js";
import { DesktopLogRuntime, type DesktopLogStreamEvent } from "../src/desktop/log-runtime.js";
import { closeDesktopSshConnectionPool, type DesktopSshContext } from "../src/desktop/ssh-runtime.js";
import { buildSshLogTailCommand } from "../src/shared/environment-log.js";

interface LogSshFixture {
  port: number;
  commands: string[];
  shellInputs: string[];
  close(): Promise<void>;
}

const fixtures: LogSshFixture[] = [];

afterEach(async () => {
  await closeDesktopSshConnectionPool();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function startLogSshFixture(): Promise<LogSshFixture> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const commands: string[] = [];
  const shellInputs: string[] = [];
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (authentication) => {
      if (authentication.method === "password" && authentication.username === "operator" && authentication.password === "desktop-log-secret") authentication.accept();
      else authentication.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          const stream = acceptExec();
          const encoded = Buffer.from("第一行\n", "utf8");
          stream.write(encoded.subarray(0, 2));
          setTimeout(() => stream.write(encoded.subarray(2)), 10);
          setTimeout(() => stream.stderr.write("warning line\n"), 20);
        });
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          let input = "";
          stream.on("data", (chunk: Buffer | string) => {
            input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
            shellInputs[0] = input;
            if (input.includes("tail -n ")) stream.write("shell log line\n");
          });
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const fixture = {
    port: (server.address() as AddressInfo).port,
    commands,
    shellInputs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  fixtures.push(fixture);
  return fixture;
}

const context: DesktopSshContext = {
  endpoint: "http://127.0.0.1:8080",
  userId: "desktop-log-user",
  workspaceType: "personal",
  workspaceId: "desktop-log-user",
};

function credential(connectionId: string, port: number, loginScript = ""): DesktopSshCredential {
  const connection: DesktopSshConnection = {
    connectionId,
    name: connectionId,
    host: "127.0.0.1",
    port,
    username: "operator",
    authType: "password",
    credential: { password: "desktop-log-secret" },
    jumpConnectionId: null,
    options: {
      terminalType: "xterm-256color",
      keepAliveSeconds: 0,
      loginScriptEnabled: Boolean(loginScript),
      loginScript,
    },
    connectionUpdatedAt: new Date().toISOString(),
  };
  return { connection, jumpConnection: null };
}

function waitForEvent(events: DesktopLogStreamEvent[], predicate: (event: DesktopLogStreamEvent) => boolean, timeoutMs = 5000): Promise<DesktopLogStreamEvent> {
  const current = events.find(predicate);
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const event = events.find(predicate);
      if (event) {
        clearInterval(timer);
        resolve(event);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待桌面日志事件超时：${JSON.stringify(events)}`));
      }
    }, 10);
  });
}

describe("desktop log runtime", () => {
  it("streams trusted multi-file tail output from the Mac and preserves split UTF-8 data", async () => {
    const fixture = await startLogSshFixture();
    const events: DesktopLogStreamEvent[] = [];
    const runtime = new DesktopLogRuntime(
      async (connectionId) => ({ context, credential: credential(connectionId, fixture.port) }),
      async () => context,
      (event) => events.push(event),
    );
    const filePaths = ["/var/log/app.log", "/var/log/error.log"];
    const opened = await runtime.create({ logId: "log-1", logName: "应用日志", sshConnectionId: "ssh-1", filePaths, initialLines: 300 });

    expect(fixture.commands).toEqual([buildSshLogTailCommand(filePaths, 300)]);
    await waitForEvent(events, (event) => event.type === "output" && event.data.includes("第一行"));
    await waitForEvent(events, (event) => event.type === "stderr" && event.data.includes("warning line"));
    expect(runtime.close(opened.stream.id, context)).toBe(true);
    await waitForEvent(events, (event) => event.type === "closed" && event.streamId === opened.stream.id);
    runtime.closeAll();
  });

  it("runs login scripts before tail and enforces the per-App stream limit", async () => {
    const fixture = await startLogSshFixture();
    const events: DesktopLogStreamEvent[] = [];
    const loginScript = "kubectl exec -it -n apps app-pod -- sh";
    const runtime = new DesktopLogRuntime(
      async (connectionId) => ({ context, credential: credential(connectionId, fixture.port, loginScript) }),
      async () => context,
      (event) => events.push(event),
    );
    const filePaths = ["/opt/viron/logs/app.log"];
    const streams = [];
    for (let index = 0; index < 3; index += 1) {
      streams.push(await runtime.create({ logId: `log-${index}`, logName: `日志 ${index}`, sshConnectionId: `ssh-${index}`, filePaths, initialLines: 200 }));
    }
    await waitForEvent(events, (event) => event.type === "output" && event.data.includes("shell log line"));
    expect(fixture.shellInputs[0]).toContain(`${loginScript}\n${buildSshLogTailCommand(filePaths, 200)}\n`);
    await expect(runtime.create({ logId: "log-4", logName: "日志 4", sshConnectionId: "ssh-4", filePaths, initialLines: 200 })).rejects.toThrow("最多同时查看 3 个实时日志");
    for (const stream of streams) runtime.close(stream.stream.id, context);
    runtime.closeAll();
  });
});
