import { spawn } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const socketPath = process.env.SCRIPT_RUNNER_SOCKET || "/run/viron-script-runner/runner.sock";
const socketGid = Number(process.env.SCRIPT_RUNNER_SOCKET_GID || 10001);
const sandboxUid = Number(process.env.SCRIPT_SANDBOX_UID || 10002);
const sandboxGid = Number(process.env.SCRIPT_SANDBOX_GID || 10002);
const requestLimit = 320 * 1024;
let queue = Promise.resolve();
let pendingJobs = 0;

function send(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": data.length });
  response.end(data);
}

function killProcessGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Process already exited. */ }
}

function killSandboxProcesses() {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      if (uid === sandboxUid) process.kill(Number(entry), "SIGKILL");
    } catch { /* Process may have exited while /proc was scanned. */ }
  }
}

async function execute(script, timeoutMs, maxOutputBytes) {
  const directory = await mkdtemp(join(tmpdir(), "viron-script-"));
  chownSync(directory, 0, sandboxGid);
  chmodSync(directory, 0o770);
  return new Promise((resolve) => {
    const child = spawn("setpriv", [
      `--reuid=${sandboxUid}`,
      `--regid=${sandboxGid}`,
      "--clear-groups",
      "--no-new-privs",
      "/bin/sh",
    ], {
      cwd: directory,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: directory, LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      resolve(result);
    };
    const timer = setTimeout(() => {
      failure = `脚本执行超过 ${Math.round(timeoutMs / 1000)} 秒限制`;
      killProcessGroup(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        failure = "脚本标准输出超过 5 MiB 上限";
        killProcessGroup(child);
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => finish({ exitCode: 126, stdout: "", stderr: error.message }));
    child.once("close", (code, signal) => {
      killSandboxProcesses();
      finish({
        exitCode: failure ? 124 : code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: failure || Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.on("error", () => { /* Spawn failures are reported by the child error event. */ });
    child.stdin.end(script);
  });
}

mkdirSync(dirname(socketPath), { recursive: true });
try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") return send(response, 200, { status: "ok" });
  if (request.method !== "POST" || request.url !== "/execute") return send(response, 404, { message: "接口不存在" });
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > requestLimit) request.destroy(new Error("请求超过 320 KiB 上限"));
    else chunks.push(chunk);
  });
  request.on("error", (error) => send(response, 413, { message: error.message }));
  request.on("end", () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(response, 400, { message: "请求 JSON 无效" }); }
    if (typeof body.script !== "string" || !body.script.trim() || Buffer.byteLength(body.script) > 256 * 1024) return send(response, 400, { message: "脚本必须为不超过 256 KiB 的非空字符串" });
    if (pendingJobs >= 16) return send(response, 429, { message: "脚本执行队列已满，请稍后重试" });
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60_000, 1_000), 60_000);
    const maxOutputBytes = Math.min(Math.max(Number(body.maxOutputBytes) || 5 * 1024 * 1024, 1_024), 5 * 1024 * 1024);
    const job = queue.then(() => execute(body.script, timeoutMs, maxOutputBytes));
    pendingJobs += 1;
    queue = job.then(() => undefined, () => undefined);
    void job.then((result) => send(response, 200, result), (error) => send(response, 500, { message: error instanceof Error ? error.message : String(error) })).finally(() => { pendingJobs -= 1; });
  });
});
server.listen(socketPath, () => {
  chownSync(socketPath, 0, socketGid);
  chmodSync(socketPath, 0o660);
});

function close() {
  server.close(() => {
    try { unlinkSync(socketPath); } catch { /* Socket may already be gone. */ }
    process.exit(0);
  });
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
