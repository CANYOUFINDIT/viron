import { translate as tr } from "../i18n.js";
import { mainWindow } from "../window-host.js";

export async function runDesktopSshSmoke(connectionId: string): Promise<{
  opened: boolean;
  textInputEchoed: boolean;
  binaryInputEchoed: boolean;
  resized: boolean;
  agentContextRead: boolean;
  recordingCompleted: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    const connectionId = ${JSON.stringify(connectionId)};
    const output = [];
    let sessionId = "";
    let unsubscribe = null;
    const append = (value) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      for (const byte of bytes) output.push(byte);
    };
    const includes = (needle) => output.some((_, index) => needle.every((byte, offset) => output[index + offset] === byte));
    const waitForOutput = (predicate) => new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + 10000;
      const inspect = () => {
        if (predicate()) return resolveWait();
        if (Date.now() >= deadline) return rejectWait(new Error("等待本机 SSH 输出超时：" + new TextDecoder().decode(Uint8Array.from(output))));
        setTimeout(inspect, 20);
      };
      inspect();
    });
    try {
      unsubscribe = window.vironDesktop.onSshSessionEvent((event) => {
        if (event.sessionId === sessionId && event.type === "output") append(event.data);
      });
      const opened = await window.vironDesktop.openSshSession({ connectionId, cols: 100, rows: 30 });
      sessionId = opened.session.id;
      const attached = await window.vironDesktop.attachSshSession(sessionId, opened.ticket);
      const initial = atob(attached.output);
      append(Uint8Array.from(initial, (character) => character.charCodeAt(0)));
      await waitForOutput(() => new TextDecoder().decode(Uint8Array.from(output)).includes("DESKTOP-SSH-READY"));
      await window.vironDesktop.sshSessionAction(sessionId, { type: "resize", cols: 132, rows: 40 });
      await window.vironDesktop.sshSessionAction(sessionId, { type: "input", data: "desktop-smoke\\n" });
      const binary = Uint8Array.from([0, 24, 255, 15, 128]);
      await window.vironDesktop.sshSessionAction(sessionId, { type: "binary", data: binary.buffer });
      await waitForOutput(() => new TextDecoder().decode(Uint8Array.from(output)).includes("ECHO:desktop-smoke"));
      await waitForOutput(() => includes([...new TextEncoder().encode("ECHO:"), ...binary]));
      await window.vironDesktop.sshSessionAction(sessionId, { type: "input", data: "token=desktop-agent-secret\\n" });
      await waitForOutput(() => new TextDecoder().decode(Uint8Array.from(output)).includes("desktop-agent-secret"));
      const agentContext = await window.vironDesktop.readAgentSshContext(sessionId);
      await window.vironDesktop.closeSshSession(sessionId);
      const recordings = await window.vironDesktop.listSshRecordings();
      resolve({
        opened: true,
        textInputEchoed: true,
        binaryInputEchoed: true,
        resized: true,
        agentContextRead: agentContext.sessionId === sessionId
          && agentContext.output.includes("token=[REDACTED]")
          && !agentContext.output.includes("desktop-agent-secret")
          && agentContext.includedBytes <= 3072
          && !("credential" in agentContext),
        recordingCompleted: recordings.items.some((item) => item.sessionId === sessionId && item.status === "completed"),
      });
    } catch (error) {
      if (sessionId) await window.vironDesktop.closeSshSession(sessionId).catch(() => undefined);
      reject(error);
    } finally {
      unsubscribe?.();
    }
  })`);
}

export async function runDesktopLogSmoke(environmentId: string, logId: string): Promise<{
  opened: boolean;
  outputReceived: boolean;
  stopped: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    const environmentId = ${JSON.stringify(environmentId)};
    const logId = ${JSON.stringify(logId)};
    let streamId = "";
    let output = "";
    let stopped = false;
    let unsubscribe = null;
    const waitFor = (predicate, label) => new Promise((resolveWait, rejectWait) => {
      const deadline = Date.now() + 10000;
      const inspect = () => {
        if (predicate()) return resolveWait();
        if (Date.now() >= deadline) return rejectWait(new Error("等待本机日志" + label + "超时：" + output));
        setTimeout(inspect, 20);
      };
      inspect();
    });
    try {
      unsubscribe = window.vironDesktop.onLogStreamEvent((event) => {
        if (event.logId !== logId) return;
        if (event.type === "output" || event.type === "stderr") output += event.data;
        else if (event.type === "closed") stopped = true;
        else if (event.type === "error") reject(new Error(event.message));
      });
      const opened = await window.vironDesktop.openLogStream({ environmentId, logId, initialLines: 200 });
      streamId = opened.stream.id;
      await waitFor(() => output.includes("DESKTOP-LOG-READY"), "输出");
      await window.vironDesktop.closeLogStream(streamId);
      await waitFor(() => stopped, "停止");
      resolve({ opened: true, outputReceived: true, stopped: true });
    } catch (error) {
      if (streamId) await window.vironDesktop.closeLogStream(streamId).catch(() => undefined);
      reject(error);
    } finally {
      unsubscribe?.();
    }
  })`);
}

export async function runDesktopDatabaseSmoke(connectionId: string): Promise<{
  tested: boolean;
  queried: boolean;
  cancelled: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    const connectionId = ${JSON.stringify(connectionId)};
    const request = async (path, init = {}) => {
      const response = await window.vironDesktop.request({
        path,
        method: init.method,
        headers: init.body === undefined ? undefined : [["content-type", "application/json"]],
        body: init.body === undefined ? undefined : { kind: "text", value: JSON.stringify(init.body) },
      });
      const body = response.body ? JSON.parse(response.body) : undefined;
      if (response.status < 200 || response.status >= 300) throw new Error(body?.message || "本机数据库请求失败（" + response.status + "）");
      return body;
    };
    const waitForJob = async (id) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const response = await request("/api/v1/database-queries/" + id);
        if (!['pending', 'running'].includes(response.job.status)) return response.job;
        await new Promise((resolveWait) => setTimeout(resolveWait, 40));
      }
      throw new Error("等待本机数据库查询超时");
    };
    try {
      const tested = await request("/api/v1/database-connections/" + connectionId + "/test", { method: "POST" });
      const started = await request("/api/v1/database-connections/" + connectionId + "/queries", {
        method: "POST",
        body: { database: "", sql: "SELECT 'DESKTOP-DATABASE-READY' AS marker" },
      });
      const completed = await waitForJob(started.job.id);
      const marker = completed.resultSets?.[0]?.rows?.[0]?.marker;
      const cancellable = await request("/api/v1/database-connections/" + connectionId + "/queries", {
        method: "POST",
        body: { database: "", sql: "SELECT 'DESKTOP-DATABASE-CANCEL' AS marker" },
      });
      const cancelledResponse = await window.vironDesktop.request({
        path: "/api/v1/database-queries/" + cancellable.job.id,
        method: "DELETE",
      });
      const cancelled = await waitForJob(cancellable.job.id);
      resolve({
        tested: tested.ok === true && Boolean(tested.version),
        queried: completed.status === "success" && marker === "DESKTOP-DATABASE-READY",
        cancelled: cancelledResponse.status === 204 && cancelled.status === "cancelled",
      });
    } catch (error) {
      reject(error);
    }
  })`);
}

export async function runDesktopInspectionSmoke(sshConnectionId: string, databaseConnectionId: string): Promise<{
  total: number;
  available: number;
  sshAvailable: boolean;
  databaseAvailable: boolean;
  credentialsHidden: boolean;
}> {
  if (!mainWindow) throw new Error(tr("主窗口不可用"));
  return mainWindow.webContents.executeJavaScript(`new Promise(async (resolve, reject) => {
    try {
      const items = [
        { type: "ssh", id: ${JSON.stringify(sshConnectionId)} },
        { type: "database", id: ${JSON.stringify(databaseConnectionId)} },
      ];
      const response = await window.vironDesktop.request({
        path: "/api/v1/connections/inspect",
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: { kind: "text", value: JSON.stringify({ items }) },
      });
      const body = response.body ? JSON.parse(response.body) : {};
      if (response.status < 200 || response.status >= 300) throw new Error(body.message || "本机连接巡检失败（" + response.status + "）");
      resolve({
        total: body.summary.total,
        available: body.summary.available,
        sshAvailable: body.items.some((item) => item.type === "ssh" && item.status === "available"),
        databaseAvailable: body.items.some((item) => item.type === "database" && item.status === "available"),
        credentialsHidden: body.items.every((item) => !["credential", "password", "options", "sshCredential"].some((key) => key in item)),
      });
    } catch (error) {
      reject(error);
    }
  })`);
}


