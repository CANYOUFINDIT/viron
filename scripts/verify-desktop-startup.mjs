import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userDataDirectory = await mkdtemp(join(tmpdir(), "viron-desktop-startup-"));
const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) {
  if (name.startsWith("VIRON_DESKTOP_")) delete childEnvironment[name];
}

let child;
try {
  child = spawn(electronExecutable, [
    repositoryRoot,
    "--smoke-test",
    `--user-data-dir=${userDataDirectory}`,
  ], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 60_000);
  timeout.unref();

  const { code, signal } = await new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (exitCode, exitSignal) => resolveClose({ code: exitCode, signal: exitSignal }));
  });
  clearTimeout(timeout);

  if (timedOut) throw new Error("Desktop startup verification timed out after 60 seconds");
  if (code !== 0 || !stdout.includes("VIRON_DESKTOP_SMOKE")) {
    const details = stderr.trim() || stdout.trim() || `signal=${signal ?? "none"}`;
    throw new Error(`Desktop startup verification failed (exit ${code ?? "null"}): ${details}`);
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(userDataDirectory, { recursive: true, force: true });
}
