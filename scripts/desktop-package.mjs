import { fingerprintFiles } from "./build-fingerprint.mjs";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { listPackage } from "@electron/asar";

export const root = resolve(import.meta.dirname, "..");
export const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
export const electronVersion = JSON.parse(await readFile(join(root, "node_modules", "electron", "package.json"), "utf8")).version;

export const desktopRuntimePackageRoots = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "zod",
  "ssh2",
  "mysql2",
  "ioredis",
  "exceljs",
  "csv-parse",
  "ws",
  "@modelcontextprotocol/sdk",
  "electron-chrome-web-store",
  "yauzl",
];

const desktopRuntimeEntries = ["src/desktop/main.ts", "src/desktop/mcp-stdio.ts"];

// Electron supplies this. Every other bare import has to be inside app.asar.
const electronRuntimePackages = new Set(["electron"]);

export function buildDesktop() {
  const outputPaths = ["dist/desktop", "dist/shared", "dist/desktop-renderer", "dist/database-sync.js", "dist/database-sync.js.map", "dist/server/database-workbench/http-tunnel.js", "dist/server/database-workbench/http-tunnel.js.map"];
  const inputs = fingerprintFiles(root, ["src", "design", "package.json", "package-lock.json", "node_modules/.package-lock.json", "vite.config.ts", "tsconfig.json", "tsconfig.desktop.json", "scripts/desktop-package.mjs", "scripts/build-fingerprint.mjs", "tokens.css", ...readdirSync(root).filter((file) => file.endsWith(".html") || file.startsWith(".env"))]);
  const environment = JSON.stringify([process.version, process.platform, process.arch, Object.entries(process.env).filter(([key]) => key.startsWith("VITE_") || key === "NODE_ENV").sort()]);
  const stampPath = join(root, ".tmp", "desktop-build.json");
  try {
    const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
    if (stamp.inputs === inputs && stamp.environment === environment && outputPaths.every((path) => existsSync(join(root, path))) && stamp.outputs === fingerprintFiles(root, outputPaths)) {
      process.stdout.write("[构建缓存命中] 桌面代码与产物未变，复用编译结果。\n");
      return;
    }
  } catch { /* Missing, stale or incomplete output: rebuild it. */ }
  const started = performance.now();
  rmSync(stampPath, { force: true });
  for (const directory of ["desktop", "shared"]) {
    rmSync(join(root, "dist", directory), { recursive: true, force: true });
  }
  const result = spawnSync("npm", ["run", "build:desktop"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error("桌面 App 构建失败");
  mkdirSync(join(root, ".tmp"), { recursive: true });
  writeFileSync(stampPath, JSON.stringify({ inputs, environment, outputs: fingerprintFiles(root, outputPaths) }));
  process.stdout.write(`[耗时] 桌面代码编译: ${((performance.now() - started) / 1000).toFixed(1)}s\n`);
}

function installedPackageDirectory(name, fromDirectory = root) {
  let current = fromDirectory;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) throw new Error(`没有找到桌面运行依赖 ${name}`);
    current = parent;
  }
}

async function desktopRuntimePackageDirectories() {
  const rootNodeModules = join(root, "node_modules");
  const collected = new Map();
  const visit = async (name, fromDirectory = root) => {
    const directory = installedPackageDirectory(name, fromDirectory);
    const packagePath = relative(rootNodeModules, directory);
    if (collected.has(packagePath)) return;
    collected.set(packagePath, directory);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await visit(dependency, directory);
    }
  };
  for (const name of desktopRuntimePackageRoots) await visit(name);
  return [...collected.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function runtimePackageName(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
  if (!name || electronRuntimePackages.has(name)) return null;
  return name;
}

export function importedSpecifiers(source) {
  const executable = source
    .replace(/^\s*import\s+type\b[^;]*;?/gm, "")
    .replace(/^\s*export\s+type\b[^;]*;?/gm, "");
  const clause = String.raw`(?:[\s\w{},*]|\btype\b)*`;
  const pattern = new RegExp(String.raw`(?<![\w$-])(?:import|export)\b(?!\s+type\b)\s*(?:${clause}\bfrom\s+)?["']([^"'\n]+)["']|(?<![\w$-])import\(\s*["']([^"'\n]+)["']\s*\)`, "g");
  const specifiers = [];
  for (const match of executable.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier && !/\s/.test(specifier)) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveImportedFile(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(fromFile), specifier);
  const candidates = [];
  if (/\.[cm]?js$/.test(target)) {
    const stem = target.replace(/\.[cm]?js$/, "");
    for (const extension of [".ts", ".tsx", ".cts", ".mts", ".js", ".cjs", ".mjs"]) candidates.push(`${stem}${extension}`);
  }
  candidates.push(target, `${target}.ts`, `${target}.js`, join(target, "index.ts"), join(target, "index.js"));
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error(`无法解析桌面模块 ${specifier}（来自 ${relative(root, fromFile)}）`);
  return resolved;
}

function runtimePackagesFrom(entryFiles) {
  const packages = new Set();
  const seen = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
      const packageName = runtimePackageName(specifier);
      if (packageName) {
        packages.add(packageName);
        continue;
      }
      const imported = resolveImportedFile(file, specifier);
      if (imported) queue.push(imported);
    }
  }
  return packages;
}

export function desktopSourceRuntimePackages() {
  return runtimePackagesFrom(desktopRuntimeEntries.map((file) => join(root, file)));
}

function stagedRuntimePackages(stage) {
  return runtimePackagesFrom([
    join(stage, "dist", "desktop", "main.js"),
    join(stage, "dist", "desktop", "mcp-stdio.js"),
  ]);
}

function resolveStagedPackage(stage, fromDirectory, name) {
  let current = fromDirectory;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === stage) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function archivePackageExists(entries, fromRel, name) {
  const parts = fromRel.split("/").filter(Boolean);
  const packageParts = name.split("/");
  while (true) {
    const entry = `/${[...parts, "node_modules", ...packageParts, "package.json"].join("/")}`;
    if (entries.has(entry)) return true;
    if (parts.length === 0) return false;
    parts.pop();
  }
}

async function requiredDesktopRuntimeRequests(stage) {
  const requests = [];
  const seen = new Set();
  const missing = [];
  const queue = [...stagedRuntimePackages(stage)].map((name) => ({ name, fromRel: "dist/desktop" }));
  while (queue.length) {
    const item = queue.pop();
    const resolved = resolveStagedPackage(stage, join(stage, item.fromRel), item.name);
    if (!resolved) {
      const label = `${item.name}（${item.fromRel}）`;
      if (!missing.includes(label)) missing.push(label);
      continue;
    }
    const rel = relative(stage, resolved).split(sep).join("/");
    requests.push({ fromRel: item.fromRel, name: item.name });
    if (seen.has(rel)) continue;
    seen.add(rel);
    const manifest = JSON.parse(await readFile(join(resolved, "package.json"), "utf8"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, fromRel: rel });
  }
  if (missing.length) throw new Error(`桌面安装包缺少运行依赖：${missing.sort().join("、")}`);
  return requests;
}

export async function assertPackagedDesktopRuntime(archivePath, stage) {
  const entries = new Set(listPackage(archivePath));
  const missing = [];
  for (const request of await requiredDesktopRuntimeRequests(stage)) {
    if (!archivePackageExists(entries, request.fromRel, request.name)) missing.push(`${request.name}（${request.fromRel}）`);
  }
  if (missing.length) throw new Error(`安装包 app.asar 缺少运行依赖：${missing.join("、")}`);
}

export async function stageDesktopApplication(temporaryPrefix) {
  const stage = await mkdtemp(join(tmpdir(), temporaryPrefix));
  await mkdir(join(stage, "dist"), { recursive: true });
  await mkdir(join(stage, "node_modules"), { recursive: true });
  await cp(join(root, "dist", "desktop"), join(stage, "dist", "desktop"), { recursive: true });
  await cp(join(root, "dist", "shared"), join(stage, "dist", "shared"), { recursive: true });
  for (const file of ["database-sync.js", "database-sync.js.map"]) {
    await cp(join(root, "dist", file), join(stage, "dist", file));
  }
  await mkdir(join(stage, "dist", "server", "database-workbench"), { recursive: true });
  await cp(
    join(root, "dist", "server", "database-workbench", "http-tunnel.js"),
    join(stage, "dist", "server", "database-workbench", "http-tunnel.js"),
  );
  await cp(
    join(root, "dist", "server", "database-workbench", "http-tunnel.js.map"),
    join(stage, "dist", "server", "database-workbench", "http-tunnel.js.map"),
  );
  await cp(join(root, "dist", "desktop-renderer"), join(stage, "dist", "desktop-renderer"), { recursive: true });
  for (const [packagePath, directory] of await desktopRuntimePackageDirectories()) {
    const target = join(stage, "node_modules", packagePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(directory, target, {
      recursive: true,
      filter: (source) => source === directory || basename(source) !== "node_modules",
    });
  }

  // ssh2 treats both native helpers as optional and falls back to Node crypto.
  // Excluding host-built binaries keeps macOS cross-arch and Windows packages portable.
  await rm(join(stage, "node_modules", "ssh2", "lib", "protocol", "crypto", "build"), { recursive: true, force: true });
  await writeFile(join(stage, "package.json"), `${JSON.stringify({
    name: "viron-desktop",
    productName: "Viron",
    description: "Viron desktop operations workbench",
    author: "Viron",
    version: packageJson.version,
    private: true,
    type: "module",
    main: "dist/desktop/main.js",
    dependencies: Object.fromEntries(desktopRuntimePackageRoots.map((name) => [name, packageJson.dependencies[name]])),
  }, null, 2)}\n`);
  // A smoke launch inside this repository can still resolve a missing package
  // from the repo node_modules. The installed app only has app.asar.
  await requiredDesktopRuntimeRequests(stage);
  return stage;
}
