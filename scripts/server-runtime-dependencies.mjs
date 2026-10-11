import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Frontend assets are bundled by Vite; desktop AI providers are not server dependencies.
export const serverRuntimePackageRoots = [
  "@fastify/cookie", "@fastify/helmet", "@fastify/multipart", "@fastify/rate-limit",
  "@fastify/static", "@fastify/websocket", "@modelcontextprotocol/sdk",
  "argon2", "bcrypt-pbkdf", "better-sqlite3", "croner", "csv-parse", "dotenv",
  "exceljs", "fast-xml-parser", "fastify", "ioredis", "mysql2", "playwright-core",
  "ssh2", "yauzl", "yazl", "zod",
];

const root = resolve(import.meta.dirname, "..");
const within = (parent, path) => {
  const child = relative(parent, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
};

export function stageServerRuntimeDependencies({ projectRoot = root, outputDirectory, packageRoots = serverRuntimePackageRoots }) {
  const project = resolve(projectRoot);
  const modules = join(project, "node_modules");
  const output = resolve(outputDirectory);
  if (within(output, project) || within(modules, output)) throw new Error("运行依赖输出目录不能覆盖项目或 node_modules");
  const packages = new Set();
  const locate = (name, from) => {
    for (let directory = from; within(project, directory); directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (directory === project) break;
    }
  };
  const collect = (name, from, optional = false) => {
    const directory = locate(name, from);
    if (!directory) {
      if (optional) return;
      throw new Error(`缺少服务端运行依赖 ${name}（来自 ${relative(project, from) || "."}）`);
    }
    if (packages.has(directory)) return;
    packages.add(directory);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const optionalDependencies = manifest.optionalDependencies || {};
    for (const dependency of Object.keys(manifest.dependencies || {})) {
      collect(dependency, directory, dependency in optionalDependencies);
    }
    for (const dependency of Object.keys(optionalDependencies)) collect(dependency, directory, true);
    for (const dependency of Object.keys(manifest.peerDependencies || {})) {
      collect(dependency, directory, manifest.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  };
  for (const name of packageRoots) collect(name, project);
  // Resolve the complete graph before touching output, so missing packages fail safely.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const directory of [...packages].sort()) {
    cpSync(directory, join(output, relative(modules, directory)), {
      recursive: true,
      dereference: true,
      // Nested versions are copied separately after resolving their actual dependents.
      filter: (path) => path === directory || basename(path) !== "node_modules",
    });
  }
  return [...packages].map((directory) => relative(modules, directory)).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = stageServerRuntimeDependencies({
    projectRoot: process.argv[2] || root,
    outputDirectory: process.argv[3] || "/opt/viron/server-node_modules",
  });
  process.stdout.write(`服务端运行依赖：${packages.length} 个包\n`);
}
