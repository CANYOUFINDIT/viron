import { fingerprintFiles } from "./build-fingerprint.mjs";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const root = resolve(import.meta.dirname, "..");
export const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
export const electronVersion = JSON.parse(await readFile(join(root, "node_modules", "electron", "package.json"), "utf8")).version;

const desktopRuntimePackageRoots = [
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
];

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
  return stage;
}
