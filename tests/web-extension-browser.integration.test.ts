import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.env.VIRON_DESKTOP_WEB_TEST !== "1")("runs a generic MV3 extension through registration, commands, scoped capture, script/port messaging, and tab creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "viron-extension-browser-"));
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), ["tests/fixtures/extension-browser-smoke.mjs"], {
        env: { ...process.env, VIRON_EXTENSION_TEST_DIR: directory, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
      });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(output || "Extension test timed out")); }, 45000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("EXTENSION_BROWSER_PASS");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 50000);
