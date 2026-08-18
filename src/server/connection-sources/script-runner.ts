import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { PRODUCT_VERSION } from "../product-info.js";

const REQUEST_LIMIT = 320 * 1024;
const RESPONSE_LIMIT = 6 * 1024 * 1024;

export interface ScriptRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function executeDockerRunner(image: string, script: string): Promise<ScriptRunnerResult> {
  const containerName = `viron-script-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "run", "--rm", "-i", "--name", containerName,
      "--read-only", "--network", "bridge", "--cpus", "1", "--memory", "256m", "--pids-limit", "128",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:size=64m,mode=1777",
      "--user", "10002:10002", image, "/bin/sh",
    ], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = "";
    let settled = false;
    const cleanup = () => {
      const remove = spawn("docker", ["rm", "-f", containerName], { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } });
      remove.unref();
    };
    const finish = (result: ScriptRunnerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = message;
      child.kill("SIGKILL");
      cleanup();
    };
    const timer = setTimeout(() => stop("脚本执行超过 60 秒限制"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 5 * 1024 * 1024) stop("脚本标准输出超过 5 MiB 上限");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动隔离脚本容器：${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => finish({
      exitCode: failure ? 124 : code ?? (signal ? 128 : 1),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: failure || Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.on("error", () => { /* Spawn failures are reported by the child error event. */ });
    child.stdin.end(script);
  });
}

export function executeSandboxedScript(socketPath: string | undefined, script: string, image = `viron-script-runner:${PRODUCT_VERSION}`): Promise<ScriptRunnerResult> {
  if (!socketPath) return executeDockerRunner(image, script);
  const payload = JSON.stringify({ script, timeoutMs: 60_000, maxOutputBytes: 5 * 1024 * 1024 });
  if (Buffer.byteLength(payload) > REQUEST_LIMIT) throw new Error("同步脚本超过 256 KiB 上限");
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, path: "/execute", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) {
          response.destroy(new Error("脚本执行器响应超过 6 MiB 上限"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ScriptRunnerResult> & { message?: string };
          if (response.statusCode !== 200) throw new Error(body.message || `脚本执行器返回 HTTP ${response.statusCode}`);
          if (!Number.isInteger(body.exitCode) || typeof body.stdout !== "string" || typeof body.stderr !== "string") throw new Error("脚本执行器返回了无效响应");
          resolve(body as ScriptRunnerResult);
        } catch (error) {
          reject(error);
        }
      });
    });
    call.setTimeout(70_000, () => call.destroy(new Error("脚本执行器连接超时")));
    call.on("error", (error) => reject(new Error(`无法连接脚本执行器：${error.message}`, { cause: error })));
    call.end(payload);
  });
}
