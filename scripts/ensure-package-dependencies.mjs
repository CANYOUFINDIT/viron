import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { dependencyManifests } from "./dependency-manifest.mjs";

export function dependencyKey(manifest, lock, runtime) {
  return createHash("sha256").update(JSON.stringify([dependencyManifests(manifest, lock), runtime])).digest("hex");
}

export function ensurePackageDependencies({ root = resolve(import.meta.dirname, ".."), execute = spawnSync, force = false, runtime = { platform: process.platform, arch: process.arch, node: process.version, abi: process.versions.modules }, env = process.env } = {}) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const npmrc = existsSync(join(root, ".npmrc")) ? read(".npmrc") : "";
  const key = dependencyKey(manifest, lock, { ...runtime, npmrc });
  const stampPath = join(root, "node_modules", ".viron-package-dependencies.json");
  const installedLockHash = () => createHash("sha256").update(read("node_modules/.package-lock.json")).digest("hex");
  let ready = false;
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    ready = stamp.key === key && stamp.installedLock === installedLockHash()
      && Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).every((name) => existsSync(join(root, "node_modules", name, "package.json")));
  } catch { /* Missing or incomplete installation: rebuild it. */ }
  const started = performance.now();
  if (!ready || force) {
    process.stdout.write("[依赖缓存未命中] 按锁文件同步依赖（首次运行、依赖或 Node 环境变化）。\n");
    rmSync(stampPath, { force: true });
    const result = execute(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--cache", join(root, ".npm-cache"), "--prefer-offline", "--no-audit", "--no-fund", "--include=dev"], { cwd: root, stdio: "inherit", env });
    if (result.error || result.status !== 0) throw new Error(`依赖同步失败：${result.error?.message ?? result.status}`);
  }
  const electron = execute(process.execPath, ["scripts/ensure-electron.mjs"], { cwd: root, stdio: "inherit", env });
  if (electron.error || electron.status !== 0) throw new Error("Electron 不完整，请运行 node scripts/ensure-package-dependencies.mjs --force 重新同步依赖");
  writeFileSync(stampPath, `${JSON.stringify({ key, installedLock: installedLockHash() })}\n`);
  process.stdout.write(`[依赖${ready && !force ? "缓存命中，跳过 npm ci" : "同步完成"}] ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensurePackageDependencies({ force: process.argv.includes("--force") });
}
