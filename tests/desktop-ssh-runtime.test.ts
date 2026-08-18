import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { Server, type ConnectionInfo, type SFTPStream } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopSshConnection, DesktopSshCredential } from "../src/desktop/device-identity.js";
import { DESKTOP_LOCAL_SFTP_CONNECTION_ID, DesktopSftpRuntime } from "../src/desktop/sftp-runtime.js";
import { closeDesktopSshConnectionPool, connectDesktopSsh, connectDesktopSshConnection, DesktopSshRuntime, type DesktopSshContext, type DesktopSshSessionEvent } from "../src/desktop/ssh-runtime.js";

const directories: string[] = [];
const fixtures: SshFixture[] = [];
const SFTP_STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, FAILURE: 4 } as const;
const SFTP_OPEN = { READ: 0x00000001, WRITE: 0x00000002, APPEND: 0x00000004, TRUNC: 0x00000010 } as const;

afterEach(async () => {
  await closeDesktopSshConnectionPool();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface SshFixture {
  port: number;
  close(): Promise<void>;
}

interface OpenHandle {
  type: "file" | "directory";
  fd?: number;
  entries?: string[];
  offset: number;
  path: string;
}

function attributes(path: string, followSymlink = false) {
  const stats = followSymlink ? statSync(path) : lstatSync(path);
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function installSftpServer(sftp: SFTPStream, root: string, readdirPermissionOnly = false) {
  const handles = new Map<number, OpenHandle>();
  let nextHandle = 1;
  const localPath = (remote: string) => {
    const normalized = posix.resolve("/", remote);
    const local = resolve(root, `.${normalized}`);
    if (local !== root && !local.startsWith(`${root}${sep}`)) throw new Error("path escaped fixture root");
    return local;
  };
  const handleBuffer = (id: number) => {
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id);
    return handle;
  };
  const openHandle = (handle: Buffer) => handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined;
  const fail = (requestId: number, error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    sftp.status(requestId, code === "ENOENT" ? SFTP_STATUS.NO_SUCH_FILE : SFTP_STATUS.FAILURE);
  };

  sftp.on("REALPATH", (requestId, remote) => {
    const normalized = posix.resolve("/", remote);
    sftp.name(requestId, [{ filename: normalized, longname: normalized, attrs: existsSync(localPath(normalized)) ? attributes(localPath(normalized)) : {} }]);
  });
  const sendStats = (requestId: number, remote: string, followSymlink: boolean) => {
    try { sftp.attrs(requestId, attributes(localPath(remote), followSymlink)); } catch (error) { fail(requestId, error); }
  };
  sftp.on("STAT", (requestId, remote) => sendStats(requestId, remote, true));
  sftp.on("LSTAT", (requestId, remote) => sendStats(requestId, remote, false));
  sftp.on("OPENDIR", (requestId, remote) => {
    try {
      const path = localPath(remote);
      const id = nextHandle++;
      handles.set(id, { type: "directory", entries: readdirSync(path), offset: 0, path });
      sftp.handle(requestId, handleBuffer(id));
    } catch (error) { fail(requestId, error); }
  });
  sftp.on("READDIR", (requestId, rawHandle) => {
    const handle = openHandle(rawHandle);
    if (!handle || handle.type !== "directory") return sftp.status(requestId, SFTP_STATUS.FAILURE);
    const names = handle.entries ?? [];
    if (handle.offset >= names.length) return sftp.status(requestId, SFTP_STATUS.EOF);
    const batch = names.slice(handle.offset, handle.offset + 64);
    handle.offset += batch.length;
    sftp.name(requestId, batch.map((filename) => {
      const attrs = attributes(join(handle.path, filename));
      if (readdirPermissionOnly) attrs.mode &= 0o7777;
      return { filename, longname: filename, attrs };
    }));
  });
  sftp.on("OPEN", (requestId, remote, flags, attrs) => {
    try {
      const path = localPath(remote);
      mkdirSync(resolve(path, ".."), { recursive: true });
      const writing = Boolean(flags & SFTP_OPEN.WRITE);
      const reading = Boolean(flags & SFTP_OPEN.READ);
      const append = Boolean(flags & SFTP_OPEN.APPEND);
      const truncate = Boolean(flags & SFTP_OPEN.TRUNC);
      const flag = writing
        ? append ? "a+" : truncate || !existsSync(path) ? "w+" : "r+"
        : reading ? "r" : "r";
      const fd = openSync(path, flag, attrs.mode ?? 0o640);
      const id = nextHandle++;
      handles.set(id, { type: "file", fd, offset: 0, path });
      sftp.handle(requestId, handleBuffer(id));
    } catch (error) { fail(requestId, error); }
  });
  sftp.on("READ", (requestId, rawHandle, offset, length) => {
    const handle = openHandle(rawHandle);
    if (handle?.fd === undefined || handle.type !== "file") return sftp.status(requestId, SFTP_STATUS.FAILURE);
    try {
      const buffer = Buffer.alloc(length);
      const bytes = readSync(handle.fd, buffer, 0, length, offset);
      if (!bytes) sftp.status(requestId, SFTP_STATUS.EOF);
      else sftp.data(requestId, buffer.subarray(0, bytes));
    } catch (error) { fail(requestId, error); }
  });
  sftp.on("WRITE", (requestId, rawHandle, offset, data) => {
    const handle = openHandle(rawHandle);
    if (handle?.fd === undefined || handle.type !== "file") return sftp.status(requestId, SFTP_STATUS.FAILURE);
    try {
      writeSync(handle.fd, data, 0, data.length, offset);
      sftp.status(requestId, SFTP_STATUS.OK);
    } catch (error) { fail(requestId, error); }
  });
  sftp.on("CLOSE", (requestId, rawHandle) => {
    const id = rawHandle.length === 4 ? rawHandle.readUInt32BE(0) : -1;
    const handle = handles.get(id);
    if (!handle) return sftp.status(requestId, SFTP_STATUS.FAILURE);
    try {
      if (handle.fd !== undefined) closeSync(handle.fd);
      handles.delete(id);
      sftp.status(requestId, SFTP_STATUS.OK);
    } catch (error) { fail(requestId, error); }
  });
  sftp.on("MKDIR", (requestId, remote, attrs) => {
    try { mkdirSync(localPath(remote), { mode: attrs.mode ?? 0o755 }); sftp.status(requestId, SFTP_STATUS.OK); } catch (error) { fail(requestId, error); }
  });
  sftp.on("RENAME", (requestId, oldRemote, newRemote) => {
    try { renameSync(localPath(oldRemote), localPath(newRemote)); sftp.status(requestId, SFTP_STATUS.OK); } catch (error) { fail(requestId, error); }
  });
  sftp.on("SETSTAT", (requestId, remote, attrs) => {
    try { if (attrs.mode !== undefined) chmodSync(localPath(remote), attrs.mode); sftp.status(requestId, SFTP_STATUS.OK); } catch (error) { fail(requestId, error); }
  });
  sftp.on("REMOVE", (requestId, remote) => {
    try { unlinkSync(localPath(remote)); sftp.status(requestId, SFTP_STATUS.OK); } catch (error) { fail(requestId, error); }
  });
  sftp.on("RMDIR", (requestId, remote) => {
    try { rmdirSync(localPath(remote)); sftp.status(requestId, SFTP_STATUS.OK); } catch (error) { fail(requestId, error); }
  });
}

async function startSshFixture(root: string, forwarding = false, readdirPermissionOnly = false, shellReadDelayMs = 0): Promise<SshFixture> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const sockets = new Set<Socket>();
  const server = new Server({ hostKeys: [privateKey] }, (client, info: ConnectionInfo) => {
    void info;
    client.on("authentication", (context) => {
      if (context.username !== "operator") return context.reject();
      if (context.method === "password" && context.password === "desktop-secret") context.accept();
      else if (context.method === "keyboard-interactive") {
        context.prompt([{ prompt: "Password: ", echo: false }], (answers) => answers[0] === "desktop-secret" ? context.accept() : context.reject());
      } else if (context.method === "publickey") context.accept();
      else context.reject(["password", "keyboard-interactive", "publickey"]);
    });
    client.on("ready", () => {
      if (forwarding) client.on("tcpip", (accept, reject, details) => {
        const stream = accept();
        if (!stream) return reject();
        const target = createConnection(details.destPort, details.destIP);
        sockets.add(target);
        target.once("connect", () => {
          stream.pipe(target).pipe(stream);
        });
        target.once("close", () => sockets.delete(target));
        target.once("error", () => stream.destroy());
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("window-change", (acceptWindow) => acceptWindow?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("DESKTOP-SSH-READY\r\n");
          if (shellReadDelayMs) setTimeout(() => stream.on("data", () => undefined), shellReadDelayMs);
          else stream.on("data", (chunk: Buffer) => stream.write(Buffer.concat([Buffer.from("ECHO:"), chunk])));
        });
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          if (info.command === "tail -f /var/log/viron.log") {
            stream.write("waiting for logs\n");
            const timer = setTimeout(() => { stream.exit(0); stream.end(); }, 5_000);
            stream.once("close", () => clearTimeout(timer));
            return;
          }
          stream.write(`command=${info.command}\ntoken=diagnostic-secret\nservice active\n`);
          stream.stderr.write("warning password=stderr-secret\n");
          stream.exit(0);
          stream.end();
        });
        session.on("sftp", (acceptSftp) => installSftpServer(acceptSftp(), root, readdirPermissionOnly));
      });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const fixture = {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

const context: DesktopSshContext = {
  endpoint: "http://127.0.0.1:8081",
  userId: "user-1",
  workspaceType: "personal",
  workspaceId: "user-1",
};

function sshConnection(id: string, port: number, authType: DesktopSshConnection["authType"] = "password"): DesktopSshConnection {
  const privateKey = authType === "privateKey" ? generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  }).privateKey : undefined;
  return {
    connectionId: id,
    name: id,
    host: "127.0.0.1",
    port,
    username: "operator",
    authType,
    credential: authType === "privateKey" ? { privateKey } : { password: "desktop-secret" },
    jumpConnectionId: null,
    options: { terminalType: "xterm-256color", keepAliveSeconds: 0, loginScriptEnabled: false, loginScript: "" },
    connectionUpdatedAt: new Date().toISOString(),
  };
}

function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const started = Date.now();
    const inspect = () => {
      const value = read();
      if (predicate(value)) resolveValue(value);
      else if (Date.now() - started >= timeoutMs) reject(new Error("等待桌面 SSH 测试状态超时"));
      else setTimeout(inspect, 20);
    };
    inspect();
  });
}

describe("desktop SSH runtime", () => {
  it("reuses a transport before loading another credential envelope and invalidates it by connection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-ssh-pool-"));
    directories.push(directory);
    const fixture = await startSshFixture(directory);
    let loads = 0;
    const loadCredential = async (connectionId: string) => {
      loads += 1;
      return { context, credential: { connection: sshConnection(connectionId, fixture.port), jumpConnection: null } };
    };

    const first = await connectDesktopSshConnection("pooled", context, loadCredential);
    expect(first.reused).toBe(false);
    first.connected.close();
    const second = await connectDesktopSshConnection("pooled", context, loadCredential);
    expect(second.reused).toBe(true);
    second.connected.close();
    expect(loads).toBe(1);

    await closeDesktopSshConnectionPool("pooled");
    const third = await connectDesktopSshConnection("pooled", context, loadCredential);
    expect(third.reused).toBe(false);
    third.connected.close();
    expect(loads).toBe(2);
  });

  it("supports all auth modes, a jump host, terminal transport, login scripts, resize, and local recordings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-ssh-runtime-"));
    directories.push(directory);
    const targetRoot = join(directory, "target");
    const jumpRoot = join(directory, "jump");
    mkdirSync(targetRoot, { recursive: true });
    mkdirSync(jumpRoot, { recursive: true });
    const target = await startSshFixture(targetRoot);
    const jump = await startSshFixture(jumpRoot, true);

    for (const authType of ["password", "keyboardInteractive", "privateKey"] as const) {
      const connected = await connectDesktopSsh({ connection: sshConnection(`auth-${authType}`, target.port, authType), jumpConnection: null });
      expect(connected.connection).not.toHaveProperty("credential");
      connected.close();
    }
    const throughJump = sshConnection("through-jump", target.port);
    throughJump.jumpConnectionId = "jump";
    const jumped = await connectDesktopSsh({ connection: throughJump, jumpConnection: sshConnection("jump", jump.port) });
    expect(jumped.jumpClient).toBeTruthy();
    jumped.close();

    const events: DesktopSshSessionEvent[] = [];
    const recordingsDirectory = join(directory, "recordings");
    const runtime = new DesktopSshRuntime(recordingsDirectory, (event) => events.push(event), 30);
    const connection = sshConnection("terminal", target.port);
    connection.options.loginScriptEnabled = true;
    connection.options.loginScript = "echo LOGIN-SCRIPT";
    const opened = await runtime.create(context, { connection, jumpConnection: null }, 100, 30);
    const attached = runtime.attach(opened.session.id, opened.ticket, context);
    runtime.resize(opened.session.id, context, 132, 40);
    await runtime.input(opened.session.id, context, "hello\n");
    await runtime.input(opened.session.id, context, Uint8Array.from([0, 24, 255, 15, 128]));
    const output = await waitFor(
      () => Buffer.concat([
        Buffer.from(attached.output, "base64"),
        ...events.filter((event): event is Extract<DesktopSshSessionEvent, { type: "output" }> => event.type === "output").map((event) => Buffer.from(event.data)),
      ]),
      (value) => value.includes(Buffer.from("ECHO:hello")) && value.includes(Buffer.from([0, 24, 255, 15, 128])),
    );
    expect(output.toString("utf8")).toContain("DESKTOP-SSH-READY");
    expect(output.toString("utf8")).toContain("LOGIN-SCRIPT");
    await runtime.input(opened.session.id, context, "token=runtime-secret\n");
    await waitFor(
      () => runtime.agentContext(opened.session.id, context),
      (value) => value.output.includes("token=[REDACTED]"),
    );
    const agentContext = runtime.agentContext(opened.session.id, context);
    expect(agentContext).toMatchObject({
      sessionId: opened.session.id,
      connectionId: "terminal",
      connectionName: "terminal",
      host: "127.0.0.1",
      executionTarget: "desktop-local",
    });
    expect(agentContext.output).not.toContain("runtime-secret");
    expect(() => runtime.agentContext(opened.session.id, { ...context, workspaceId: "other-workspace" })).toThrow("SSH 会话不存在");

    const diagnostic = await runtime.agentDiagnostic(randomUUID(), opened.session.id, "systemctl status viron", context);
    expect(diagnostic).toMatchObject({
      sessionId: opened.session.id,
      connectionId: "terminal",
      command: "systemctl status viron",
      executionTarget: "desktop-local",
      exitCode: 0,
      truncated: false,
      redactionCount: 2,
    });
    expect(diagnostic.stdout).toContain("service active");
    expect(diagnostic.stdout).not.toContain("diagnostic-secret");
    expect(diagnostic.stderr).not.toContain("stderr-secret");
    await expect(runtime.agentDiagnostic(randomUUID(), opened.session.id, "rm -rf /tmp/unsafe", context)).rejects.toThrow("只读");
    const writeDiagnostic = await runtime.agentDiagnostic(randomUUID(), opened.session.id, "rm -rf /tmp/unsafe", context, { allowWrite: true });
    expect(writeDiagnostic).toMatchObject({ command: "rm -rf /tmp/unsafe", executionTarget: "desktop-local" });
    await expect(runtime.agentDiagnostic(randomUUID(), opened.session.id, "pwd", { ...context, workspaceId: "other-workspace" })).rejects.toThrow("SSH 会话不存在");

    const cancelId = randomUUID();
    const pendingDiagnostic = runtime.agentDiagnostic(cancelId, opened.session.id, "tail -f /var/log/viron.log", context);
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    expect(runtime.cancelAgentDiagnostic(cancelId, context)).toEqual({ stopped: true });
    await expect(pendingDiagnostic).rejects.toMatchObject({ code: "SSH_COMMAND_ABORTED" });
    expect(runtime.cancelAgentDiagnostic(cancelId, context)).toEqual({ stopped: false });
    await runtime.close(opened.session.id, "测试完成");
    const recordings = runtime.listRecordings(context);
    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({ connectionId: "terminal", status: "completed", closeReason: "测试完成", source: "desktop" });
    expect(readFileSync(runtime.recordingFile(recordings[0].id, context).path, "utf8")).toContain("DESKTOP-SSH-READY");
    runtime.deleteRecording(recordings[0].id, context);
    expect(runtime.listRecordings(context)).toHaveLength(0);
    await runtime.closeAll();
  });

  it("waits for SSH channel backpressure before accepting more terminal input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-ssh-backpressure-"));
    directories.push(directory);
    const root = join(directory, "target");
    mkdirSync(root, { recursive: true });
    const fixture = await startSshFixture(root, false, false, 150);
    const runtime = new DesktopSshRuntime(join(directory, "recordings"), () => undefined, 30);
    const opened = await runtime.create(context, { connection: sshConnection("backpressure", fixture.port), jumpConnection: null }, 100, 30);
    runtime.attach(opened.session.id, opened.ticket, context);

    let completed = false;
    const write = runtime.input(opened.session.id, context, new Uint8Array(5 * 1024 * 1024))
      .then(() => { completed = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(completed).toBe(false);
    await write;
    expect(completed).toBe(true);

    await runtime.closeAll();
  });

  it("supports SFTP CRUD, chunked upload, download, recursive transfer, conflict handling, cancel, and retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-desktop-sftp-runtime-"));
    directories.push(directory);
    const leftRoot = join(directory, "left");
    const rightRoot = join(directory, "right");
    mkdirSync(join(leftRoot, "source", "nested"), { recursive: true });
    mkdirSync(join(rightRoot, "target"), { recursive: true });
    writeFileSync(join(leftRoot, "source", "nested", "seed.txt"), "seed contents");
    writeFileSync(join(leftRoot, "large.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
    symlinkSync("source", join(leftRoot, "source-link"), "dir");
    const leftFixture = await startSshFixture(leftRoot, false, true);
    const rightFixture = await startSshFixture(rightRoot);
    const credentials = new Map<string, DesktopSshCredential>([
      ["left", { connection: sshConnection("left", leftFixture.port), jumpConnection: null }],
      ["right", { connection: sshConnection("right", rightFixture.port), jumpConnection: null }],
    ]);
    const runtime = new DesktopSftpRuntime(async (connectionId) => {
      const credential = credentials.get(connectionId);
      if (!credential) throw new Error("fixture credential missing");
      return { context, credential };
    }, async () => context);

    const rootItems = (await runtime.list("left", "/")).items;
    expect(rootItems.map((item) => item.name)).toEqual(["source", "source-link", "large.bin"]);
    expect(rootItems.find((item) => item.name === "source")).toMatchObject({ type: "directory", targetType: null });
    expect(rootItems.find((item) => item.name === "source-link")).toMatchObject({ type: "symlink", targetType: "directory" });
    expect((await runtime.list("left", "/source-link")).items.map((item) => item.name)).toEqual(["nested"]);
    await runtime.mkdir("left", "/uploads");
    const upload = await runtime.startUpload("left", "/uploads", "uploaded.txt", context);
    await runtime.uploadChunk(upload.uploadId, context, Buffer.from("uploaded "));
    await runtime.uploadChunk(upload.uploadId, context, Buffer.from("contents"));
    await runtime.completeUpload(upload.uploadId, context);
    await runtime.rename("left", "/uploads/uploaded.txt", "/uploads/renamed.txt");
    await runtime.chmod("left", "/uploads/renamed.txt", "600");
    const uploads = await runtime.list("left", "/uploads");
    expect(uploads.items[0]).toMatchObject({ name: "renamed.txt", mode: "600", size: 17 });
    const downloaded = join(directory, "downloaded.txt");
    await runtime.downloadTo("left", "/uploads/renamed.txt", downloaded);
    expect(readFileSync(downloaded, "utf8")).toBe("uploaded contents");
    const dragDirectory = join(directory, "native-drag");
    const dragFiles = await runtime.materializeForNativeDrag("left", ["/source"], dragDirectory);
    expect(dragFiles).toMatchObject({ temporary: true, files: [join(dragDirectory, "source")] });
    expect(readFileSync(join(dragDirectory, "source", "nested", "seed.txt"), "utf8")).toBe("seed contents");

    const localRoot = join(directory, "local");
    mkdirSync(localRoot, { recursive: true });
    await runtime.mkdir(DESKTOP_LOCAL_SFTP_CONNECTION_ID, join(localRoot, "uploads"));
    const localUpload = await runtime.startUpload(DESKTOP_LOCAL_SFTP_CONNECTION_ID, join(localRoot, "uploads"), "local.txt", context);
    await runtime.uploadChunk(localUpload.uploadId, context, Buffer.from("local contents"));
    await runtime.completeUpload(localUpload.uploadId, context);
    expect((await runtime.list(DESKTOP_LOCAL_SFTP_CONNECTION_ID, join(localRoot, "uploads"))).items[0]).toMatchObject({ name: "local.txt", size: 14 });

    const preview = await runtime.preview({ sourceConnectionId: "left", targetConnectionId: "right", sourcePath: "/source", targetDirectory: "/target" });
    expect(preview).toMatchObject({ sourceType: "directory", targetPath: "/target/source", targetExists: false, totalFiles: 1 });
    const transfer = await runtime.create(context, { sourceConnectionId: "left", targetConnectionId: "right", sourcePath: "/source", targetDirectory: "/target", conflict: "overwrite" });
    const completed = await waitFor(
      () => runtime.listTransfers(context).find((task) => task.id === transfer.id),
      (task) => task?.status === "success",
    );
    expect(completed).toMatchObject({ status: "success", progress: 100, completedFiles: 1 });
    expect(readFileSync(join(rightRoot, "target", "source", "nested", "seed.txt"), "utf8")).toBe("seed contents");

    writeFileSync(join(leftRoot, "source", "nested", "seed.txt"), "updated seed");
    const batchPreview = await runtime.preview({ sourceConnectionId: "left", targetConnectionId: "right", sourcePaths: ["/source", "/large.bin"], targetDirectory: "/target" });
    expect(batchPreview).toMatchObject({ sourcePaths: ["/source", "/large.bin"], totalFiles: 2 });
    expect(batchPreview.conflicts).toEqual([{
      sourcePath: "/source/nested/seed.txt",
      targetPath: "/target/source/nested/seed.txt",
      sourceType: "file",
      targetType: "file",
    }]);
    const batch = await runtime.create(context, {
      sourceConnectionId: "left",
      targetConnectionId: "right",
      sourcePaths: ["/source", "/large.bin"],
      targetDirectory: "/target",
      conflict: "skip",
      conflictDecisions: { "/target/source/nested/seed.txt": "overwrite" },
    });
    const batchResult = await waitFor(
      () => runtime.listTransfers(context).find((task) => task.id === batch.id),
      (task) => task?.status === "success",
      10_000,
    );
    expect(batchResult).toMatchObject({ completedFiles: 2, skippedFiles: 0, sourcePaths: ["/source", "/large.bin"] });
    expect(readFileSync(join(rightRoot, "target", "source", "nested", "seed.txt"), "utf8")).toBe("updated seed");

    const skipped = await runtime.create(context, { sourceConnectionId: "left", targetConnectionId: "right", sourcePath: "/source", targetDirectory: "/target", conflict: "skip" });
    const skippedResult = await waitFor(
      () => runtime.listTransfers(context).find((task) => task.id === skipped.id),
      (task) => task?.status === "success",
    );
    expect(skippedResult?.skippedFiles).toBe(1);

    const sshToLocal = await runtime.create(context, { sourceConnectionId: "left", targetConnectionId: DESKTOP_LOCAL_SFTP_CONNECTION_ID, sourcePath: "/source", targetDirectory: localRoot, conflict: "overwrite" });
    await waitFor(
      () => runtime.listTransfers(context).find((task) => task.id === sshToLocal.id),
      (task) => task?.status === "success",
    );
    expect(readFileSync(join(localRoot, "source", "nested", "seed.txt"), "utf8")).toBe("updated seed");

    const localToSsh = await runtime.create(context, { sourceConnectionId: DESKTOP_LOCAL_SFTP_CONNECTION_ID, targetConnectionId: "right", sourcePath: join(localRoot, "uploads", "local.txt"), targetDirectory: "/target", conflict: "overwrite" });
    await waitFor(
      () => runtime.listTransfers(context).find((task) => task.id === localToSsh.id),
      (task) => task?.status === "success",
    );
    expect(readFileSync(join(rightRoot, "target", "local.txt"), "utf8")).toBe("local contents");

    const cancellable = await runtime.create(context, { sourceConnectionId: "left", targetConnectionId: "right", sourcePath: "/large.bin", targetDirectory: "/target", conflict: "overwrite" });
    runtime.cancelTransfer(cancellable.id, context);
    expect(runtime.listTransfers(context).find((task) => task.id === cancellable.id)?.status).toBe("cancelled");
    const retried = await runtime.retryTransfer(cancellable.id, context);
    await waitFor(
      () => runtime.listTransfers(context).find((task) => task.id === retried.id),
      (task) => task?.status === "success",
      10_000,
    );
    expect(readFileSync(join(rightRoot, "target", "large.bin"))).toEqual(Buffer.alloc(2 * 1024 * 1024, 7));

    await runtime.delete("left", "/uploads/renamed.txt");
    await runtime.delete("left", "/uploads");
    expect((await runtime.list("left", "/")).items.some((item) => item.name === "uploads")).toBe(false);
    await runtime.closeAll();
  }, 20_000);
});
