import { spawn } from "node:child_process";
import { resolve } from "node:path";
import "dotenv/config";

const value = process.env.WEB_CLIENT_ENABLED?.trim().toLowerCase() || "true";
if (value !== "true" && value !== "false") {
  throw new Error('WEB_CLIENT_ENABLED must be either "true" or "false".');
}

const webEnabled = value === "true";
const executable = resolve("node_modules", ".bin", process.platform === "win32" ? "concurrently.cmd" : "concurrently");
const args = webEnabled
  ? ["-k", "-n", "api,web", "-c", "cyan,green", "npm:dev:server", "npm:dev:web"]
  : ["-k", "-n", "api", "-c", "cyan", "npm:dev:server"];
const child = spawn(executable, args, { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
