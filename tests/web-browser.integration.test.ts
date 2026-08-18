import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const enabled = process.env.VIRON_WEB_BROWSER_TEST === "1";
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("测试服务器未返回端口"));
      else resolve(address.port);
    });
  });
}

function waitForLoggedView(socket: WebSocket, username: string): Promise<{ receivedFrame: boolean }> {
  return new Promise((resolve, reject) => {
    let receivedFrame = false;
    const observed: string[] = [];
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`${username} 自动登录超时: ${observed.slice(-12).join(" | ")}`));
    }, 30_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as { type: string; view?: { title: string; url: string }; message?: string };
      if (message.type === "frame") receivedFrame = true;
      if (message.type !== "frame") observed.push(`${message.type}:${message.view?.title ?? ""}:${message.view?.url ?? ""}:${message.message ?? ""}`);
      if (message.view?.title === `Logged ${username}`) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve({ receivedFrame });
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
}

function waitForMessage<T>(socket: WebSocket, description: string, predicate: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`${description}超时`));
    }, 20_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as T;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

describe.skipIf(!enabled)("server Web account views", () => {
  it("keeps three isolated accounts connected, resumes hidden views, and preserves login state after restart", async () => {
    const target = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/login") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const username = new URLSearchParams(body).get("username") || "unknown";
          response.writeHead(302, { Location: "/", "Set-Cookie": `account=${encodeURIComponent(username)}; Path=/; SameSite=Lax` });
          response.end();
        });
        return;
      }
      if (request.url === "/upload") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Upload fixture</title><input id="file" type="file" style="position:fixed;left:20px;top:20px;width:220px;height:60px"><script>file.addEventListener("change", () => { location.href = "/selected?name=" + encodeURIComponent(file.files[0].name); });</script>`);
        return;
      }
      if (request.url?.startsWith("/selected?")) {
        const filename = new URL(request.url, "http://127.0.0.1").searchParams.get("name") || "unknown";
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Selected ${filename}</title><h1>${filename}</h1>`);
        return;
      }
      if (request.url === "/download") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Download fixture</title><a href="/artifact.txt" download style="position:fixed;left:20px;top:20px;width:220px;height:60px;display:block">download</a>`);
        return;
      }
      if (request.url === "/mouse") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Mouse fixture</title><button onclick="location.href='/clicked'" style="position:fixed;left:20px;top:20px;width:220px;height:60px">click</button>`);
        return;
      }
      if (request.url === "/clicked") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Clicked fixture</title><h1>clicked</h1>`);
        return;
      }
      if (request.url === "/artifact.txt") {
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="artifact.txt"',
        });
        response.end("download contents");
        return;
      }
      if (request.url === "/local-storage-seed") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Storage seed</title><script>localStorage.setItem("persisted-account", "operator");location.replace("/local-storage-check")</script>`);
        return;
      }
      if (request.url === "/local-storage-check") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><title>Storage missing</title><script>const account=localStorage.getItem("persisted-account");if(account)document.title="Stored "+account</script>`);
        return;
      }
      const account = /(?:^|;\s*)account=([^;]+)/.exec(request.headers.cookie || "")?.[1];
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (account) {
        const username = decodeURIComponent(account);
        response.end(`<!doctype html><title>Logged ${username}</title><h1 data-account="${username}">${username}</h1>`);
      } else {
        response.end(`<!doctype html><title>Login</title><form method="post" action="/login"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button type="submit">登录</button></form>`);
      }
    });
    servers.push(target);
    const targetPort = await listen(target);
    const directory = mkdtempSync(join(tmpdir(), "envman-web-browser-test-"));
    directories.push(directory);
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "envman.db"),
      masterKey: Buffer.alloc(32, 11),
      adminUsername: "admin",
      adminPassword: "test-password-123",
      sessionTtlHours: 12,
      terminalIdleMinutes: 30,
      auditRetentionDays: 30,
      webSessionExecutor: "server",
      webBrowserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      webViewIdleMinutes: 1,
      webViewPerUserLimit: 8,
      webViewTotalLimit: 8,
    };

    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const appPort = (app.server.address() as { port: number }).port;
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
    const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
    const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Web test", status: "active", tags: [] } });
    const entry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Login fixture", url: `http://127.0.0.1:${targetPort}/`, tags: [] } });
    const credentials: Record<string, string> = {};
    const usernames = ["operator", "enduser", "auditor"];
    for (const username of usernames) {
      const credential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${entry.json().id}/credentials`, cookies, payload: { username, password: "secret", note: "", customFields: {} } });
      credentials[username] = credential.json().id;
    }

    const sockets: WebSocket[] = [];
    for (const username of usernames) {
      const request = { method: "POST" as const, url: `/api/v1/web-credentials/${credentials[username]}/view`, cookies, payload: { width: 900, height: 600 } };
      const primaryOpen = app.inject(request);
      if (username === "operator") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const concurrentOpen = await app.inject(request);
        expect(concurrentOpen.statusCode).toBe(200);
        expect(concurrentOpen.json().frame).toBeTypeOf("string");
        expect(concurrentOpen.json().frame.length).toBeGreaterThan(100);
        const concurrentSocket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/web-account-view?ticket=${concurrentOpen.json().ticket}`);
        const concurrentResult = waitForLoggedView(concurrentSocket, username);
        const opened = await primaryOpen;
        expect(opened.statusCode).toBe(200);
        expect(opened.json().frame.length).toBeGreaterThan(100);
        const socket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/web-account-view?ticket=${opened.json().ticket}`);
        sockets.push(socket);
        const [primaryResult, secondaryResult] = await Promise.all([waitForLoggedView(socket, username), concurrentResult]);
        expect(primaryResult.receivedFrame).toBe(true);
        expect(secondaryResult.receivedFrame).toBe(true);
        concurrentSocket.close();
        continue;
      }
      const opened = await primaryOpen;
      expect(opened.statusCode).toBe(200);
      expect(opened.json().frame.length).toBeGreaterThan(100);
      const socket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/web-account-view?ticket=${opened.json().ticket}`);
      sockets.push(socket);
      const result = await waitForLoggedView(socket, username);
      expect(result.receivedFrame).toBe(true);
    }

    const operatorSocket = sockets[0];
    operatorSocket.send(JSON.stringify({ type: "visibility", visible: false }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resumedFrame = waitForMessage<{ type: string }>(operatorSocket, "隐藏页面画面恢复", (message) => message.type === "frame");
    operatorSocket.send(JSON.stringify({ type: "visibility", visible: true }));
    await resumedFrame;

    const uploadPage = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "上传页加载", (message) => message.view?.title === "Upload fixture");
    operatorSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/upload` }));
    await uploadPage;
    const chooser = waitForMessage<{ type: string }>(operatorSocket, "文件选择", (message) => message.type === "fileChooser");
    operatorSocket.send(JSON.stringify({ type: "key", key: "Tab" }));
    operatorSocket.send(JSON.stringify({ type: "key", key: "Enter" }));
    await chooser;
    const selectedFile = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "文件名回显", (message) => message.view?.title === "Selected upload fixture.txt");
    const boundary = "envman-browser-upload-boundary";
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/web-credentials/${credentials.operator}/view/upload`,
      cookies,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from([
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="upload fixture.txt"',
        "Content-Type: text/plain",
        "",
        "upload contents",
        `--${boundary}--`,
        "",
      ].join("\r\n")),
    });
    expect(upload.statusCode).toBe(200);
    await selectedFile;

    const mousePage = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "鼠标测试页加载", (message) => message.view?.title === "Mouse fixture");
    operatorSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/mouse` }));
    await mousePage;
    const mouseClicked = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "鼠标点击", (message) => message.view?.title === "Clicked fixture");
    operatorSocket.send(JSON.stringify({ type: "mouse", action: "down", button: "left", clickCount: 1, x: 50, y: 40 }));
    operatorSocket.send(JSON.stringify({ type: "mouse", action: "up", button: "left", clickCount: 1, x: 50, y: 40 }));
    await mouseClicked;

    const downloadPage = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "下载页加载", (message) => message.view?.title === "Download fixture");
    operatorSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/download` }));
    await downloadPage;
    const downloadReady = waitForMessage<{ type: string; filename?: string; url?: string; message?: string }>(operatorSocket, "页面下载", (message) => message.type === "download" || message.type === "error");
    operatorSocket.send(JSON.stringify({ type: "key", key: "Tab" }));
    operatorSocket.send(JSON.stringify({ type: "key", key: "Enter" }));
    const download = await downloadReady;
    expect(download.type, download.message).toBe("download");
    expect(download.filename).toBe("artifact.txt");
    const downloaded = await app.inject({ method: "GET", url: download.url!, cookies });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("download contents");

    const accountPage = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "账号首页恢复", (message) => message.view?.title === "Logged operator");
    operatorSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/` }));
    await accountPage;

    const storageSeeded = waitForMessage<{ type: string; view?: { title: string } }>(operatorSocket, "本地存储写入", (message) => message.view?.title === "Stored operator");
    operatorSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/local-storage-seed` }));
    await storageSeeded;

    sockets.forEach((socket) => socket.close());
    await app.close();

    const restartedDb = await openDatabase(config);
    const restarted = await buildApp({ config, db: restartedDb, logger: false });
    await restarted.listen({ host: "127.0.0.1", port: 0 });
    const restartedPort = (restarted.server.address() as { port: number }).port;
    const reopened = await restarted.inject({ method: "POST", url: `/api/v1/web-credentials/${credentials.operator}/view`, cookies, payload: { width: 900, height: 600 } });
    expect(reopened.statusCode).toBe(200);
    const reopenedSocket = new WebSocket(`ws://127.0.0.1:${restartedPort}/ws/web-account-view?ticket=${reopened.json().ticket}`);
    const persistedStorage = waitForMessage<{ type: string; view?: { title: string } }>(reopenedSocket, "重启后本地存储恢复", (message) => message.view?.title === "Stored operator");
    const restartedFrame = waitForMessage<{ type: string }>(reopenedSocket, "重启后画面恢复", (message) => message.type === "frame");
    await persistedStorage;
    await restartedFrame;
    const persistedCookie = waitForMessage<{ type: string; view?: { title: string } }>(reopenedSocket, "重启后 Cookie 恢复", (message) => message.view?.title === "Logged operator");
    reopenedSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/` }));
    await persistedCookie;
    reopenedSocket.close();
    await restarted.close();
  }, 60_000);

  it("creates a blank page in the current account profile while keeping other accounts isolated", async () => {
    let isolatedEntryRequests = 0;
    const target = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/seed") {
        response.setHeader("Set-Cookie", "account=primary; Path=/; SameSite=Lax");
        response.end("<!doctype html><title>Seed session</title><h1>seed</h1>");
        return;
      }
      if (request.url === "/check") {
        const shared = /(?:^|;\s*)account=primary(?:;|$)/.test(request.headers.cookie || "");
        response.end(`<!doctype html><title>${shared ? "Shared primary session" : "Isolated session"}</title><h1>${shared ? "shared" : "isolated"}</h1>`);
        return;
      }
      if (request.url === "/empty") isolatedEntryRequests += 1;
      response.end("<!doctype html><title>Empty account</title><h1>empty</h1>");
    });
    servers.push(target);
    const targetPort = await listen(target);
    const directory = mkdtempSync(join(tmpdir(), "envman-web-pages-test-"));
    directories.push(directory);
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "envman.db"),
      masterKey: Buffer.alloc(32, 17),
      adminUsername: "admin",
      adminPassword: "test-password-123",
      sessionTtlHours: 12,
      terminalIdleMinutes: 30,
      auditRetentionDays: 30,
      webSessionExecutor: "server",
      webBrowserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      webViewIdleMinutes: 1,
      webViewPerUserLimit: 8,
      webViewTotalLimit: 8,
    };

    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const sockets: WebSocket[] = [];
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const appPort = (app.server.address() as { port: number }).port;
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "test-password-123" } });
      const cookies = { envman_session: login.cookies.find((item) => item.name === "envman_session")!.value };
      const environment = await app.inject({ method: "POST", url: "/api/v1/environments", cookies, payload: { name: "Page session test", status: "active", tags: [] } });
      const primaryEntry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Primary", url: `http://127.0.0.1:${targetPort}/seed`, tags: [] } });
      const isolatedEntry = await app.inject({ method: "POST", url: `/api/v1/environments/${environment.json().id}/web-entries`, cookies, payload: { name: "Isolated", url: `http://127.0.0.1:${targetPort}/empty`, tags: [] } });
      const primaryCredential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${primaryEntry.json().id}/credentials`, cookies, payload: { username: "primary", password: "secret", note: "", customFields: {} } });
      const isolatedCredential = await app.inject({ method: "POST", url: `/api/v1/web-entries/${isolatedEntry.json().id}/credentials`, cookies, payload: { username: "isolated", password: "secret", note: "", customFields: {} } });

      const primaryOpen = await app.inject({ method: "POST", url: `/api/v1/web-credentials/${primaryCredential.json().id}/view`, cookies, payload: { width: 900, height: 600 } });
      expect(primaryOpen.statusCode).toBe(200);
      const primarySocket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/web-account-view?ticket=${primaryOpen.json().ticket}`);
      sockets.push(primarySocket);
      await waitForMessage<{ type: string }>(primarySocket, "主账号页面连接", (message) => message.type === "ready");

      const blank = await app.inject({
        method: "POST",
        url: `/api/v1/web-credentials/${primaryCredential.json().id}/view`,
        cookies,
        payload: { width: 900, height: 600, initialPage: "blank" },
      });
      expect(blank.statusCode).toBe(200);
      expect(blank.json().view.pages).toHaveLength(2);
      expect(blank.json().view.pages.find((page: { active: boolean }) => page.active)).toMatchObject({ title: "新页面", url: "about:blank" });
      expect(blank.json().view.pages.find((page: { active: boolean }) => !page.active)).toMatchObject({ url: `http://127.0.0.1:${targetPort}/seed` });
      const reorderedPageIds = blank.json().view.pages.map((page: { id: string }) => page.id).reverse();
      const reorderedPages = waitForMessage<{ type: string; view?: { pages: Array<{ id: string }> } }>(primarySocket, "页面标签排序", (message) => (
        message.type === "state" && message.view?.pages.map((page) => page.id).join(",") === reorderedPageIds.join(",")
      ));
      primarySocket.send(JSON.stringify({ type: "reorderPages", orderedPageIds: reorderedPageIds }));
      await reorderedPages;

      const sharedSession = waitForMessage<{ type: string; view?: { title: string } }>(primarySocket, "同账号页面共享 Session", (message) => message.view?.title === "Shared primary session");
      primarySocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/check` }));
      await sharedSession;

      const isolatedOpen = await app.inject({ method: "POST", url: `/api/v1/web-credentials/${isolatedCredential.json().id}/view`, cookies, payload: { width: 900, height: 600, initialPage: "blank" } });
      expect(isolatedOpen.statusCode).toBe(200);
      expect(isolatedOpen.json().view.pages).toEqual([
        expect.objectContaining({ url: `http://127.0.0.1:${targetPort}/empty`, active: false }),
        expect.objectContaining({ title: "新页面", url: "about:blank", active: true }),
      ]);
      expect(isolatedEntryRequests).toBe(0);
      const isolatedSocket = new WebSocket(`ws://127.0.0.1:${appPort}/ws/web-account-view?ticket=${isolatedOpen.json().ticket}`);
      sockets.push(isolatedSocket);
      await waitForMessage<{ type: string }>(isolatedSocket, "隔离账号页面连接", (message) => message.type === "ready");
      const shorthandLoaded = waitForMessage<{ type: string; view?: { title: string; url: string } }>(isolatedSocket, "省略协议地址导航", (message) => (
        message.view?.title === "Isolated session" && message.view.url === `http://127.0.0.1:${targetPort}/check`
      ));
      isolatedSocket.send(JSON.stringify({ type: "navigate", url: `127.0.0.1:${targetPort}/check` }));
      await shorthandLoaded;
      expect(isolatedEntryRequests).toBe(0);
      const defaultPage = isolatedOpen.json().view.pages.find((page: { active: boolean }) => !page.active);
      const defaultLoaded = waitForMessage<{ type: string; view?: { title: string; url: string } }>(isolatedSocket, "默认入口页加载", (message) => (
        message.view?.title === "Empty account" && message.view.url === `http://127.0.0.1:${targetPort}/empty`
      ));
      isolatedSocket.send(JSON.stringify({ type: "activatePage", pageId: defaultPage.id }));
      await defaultLoaded;
      expect(isolatedEntryRequests).toBe(1);
      const isolatedSession = waitForMessage<{ type: string; view?: { title: string } }>(isolatedSocket, "账号之间隔离 Session", (message) => message.view?.title === "Isolated session");
      isolatedSocket.send(JSON.stringify({ type: "navigate", url: `http://127.0.0.1:${targetPort}/check` }));
      await isolatedSession;
    } finally {
      sockets.forEach((socket) => socket.close());
      await app.close();
    }
  }, 45_000);
});
